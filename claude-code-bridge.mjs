#!/usr/bin/env node
/**
 * claude-code-bridge v1.2 — OpenAI-compatible API proxy for Claude Code CLI
 *
 * Architecture:
 *   Any OpenAI-compatible client  ──(OpenAI API)──►  claude-code-bridge (port 18793)  ──►  claude -p --output-format stream-json
 *
 * This proxy server provides an OpenAI-compatible API format,
 * letting any OpenAI-compatible client call Claude Code CLI.
 *
 * v1.2 improvements:
 *   - Tool Bridge Mode: supports OpenAI tool_calls when request contains tools[]
 *     Injects <tool_calling_protocol> into prompt, parses <tool_call> blocks from
 *     response, returns proper OpenAI tool_calls format with finish_reason: "tool_calls"
 *   - Multi-turn tool conversations: correctly serializes tool/assistant messages
 *
 * v1.1 improvements:
 *   - Daily log rotation: logs/claude-code-bridge.YYYYMMDD.log
 *   - Verbose logging: full request/response bodies and claude-cli I/O
 *   - BRIDGE_VERBOSE env var (default true) controls verbose output
 *
 * Key features:
 *   - Uses Claude Code's print mode (-p) for non-interactive usage
 *   - Uses --output-format stream-json for structured JSONL events
 *   - Uses --output-format json for non-streaming responses
 *   - Claude Code manages its own auth (claude.ai subscription / API key)
 *   - Uses --dangerously-skip-permissions for auto-approve mode
 *   - Supports dynamic model switching via request body
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, writeFileSync, unlinkSync, mkdtempSync, createReadStream, rmdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Daily log setup ─────────────────────────────────────────────
const LOG_DIR = join(SCRIPT_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });

function todayStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

let _logDay = todayStamp();
let _logStream = createWriteStream(join(LOG_DIR, `claude-code-bridge.${_logDay}.log`), { flags: "a" });

function getLogStream() {
    const today = todayStamp();
    if (today !== _logDay) {
        _logStream.end();
        _logDay = today;
        _logStream = createWriteStream(join(LOG_DIR, `claude-code-bridge.${_logDay}.log`), { flags: "a" });
    }
    return _logStream;
}

// Override console to write to log file AND stdout
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn = console.warn.bind(console);

function writeToLog(prefix, args) {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    getLogStream().write(`${prefix}${msg}\n`);
}

console.log = (...args) => { writeToLog("", args); _origLog(...args); };
console.error = (...args) => { writeToLog("[ERROR] ", args); _origError(...args); };
console.warn = (...args) => { writeToLog("[WARN] ", args); _origWarn(...args); };

/**
 * Verbose log — always writes to the log file.
 * Also prints to stdout only when BRIDGE_VERBOSE is enabled.
 */
function verboseLog(tag, content) {
    const line = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    const entry = `[VERBOSE:${tag}]\n${line}\n[/VERBOSE:${tag}]\n`;
    getLogStream().write(entry);
    if (CONFIG.verbose) {
        _origLog(entry);
    }
}

// ─── Configuration ───────────────────────────────────────────────
const CONFIG = {
    port: parseInt(process.env.BRIDGE_PORT || "18793"),
    host: process.env.BRIDGE_HOST || "127.0.0.1",
    claudeModel: process.env.CLAUDE_MODEL || "sonnet",
    claudeBin: process.env.CLAUDE_BIN || "claude",
    // Permission mode: 'default', 'plan', 'bypassPermissions'
    // 'bypassPermissions' = skip all permission checks (default for bridge mode)
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions",
    timeoutMs: parseInt(process.env.BRIDGE_TIMEOUT_MS || "300000"), // 5 minutes
    maxArgLen: parseInt(process.env.BRIDGE_MAX_ARG_LEN || "32768"),
    charsPerToken: parseFloat(process.env.BRIDGE_CHARS_PER_TOKEN || "3.0"),
    workingDir: process.env.CLAUDE_WORKING_DIR || process.env.HOME,
    // Verbose logging: log full request/response bodies and claude-cli I/O
    // Set BRIDGE_VERBOSE=false to disable (defaults to true)
    verbose: process.env.BRIDGE_VERBOSE !== "false",
};

// Hardcoded fallback: known Claude Code model aliases and full IDs
const KNOWN_MODELS = [
    "sonnet",
    "opus",
    "haiku",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
];

// Cache for available models (populated on first /v1/models request)
let _cachedModels = null;

/**
 * Fetch available models.
 * - If ANTHROPIC_API_KEY is set → calls Anthropic /v1/models API for live list.
 * - Otherwise → returns KNOWN_MODELS (hardcoded aliases + full IDs).
 * Result is cached after the first successful fetch.
 */
async function fetchAvailableModels() {
    if (_cachedModels) return _cachedModels;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
        try {
            const res = await fetch("https://api.anthropic.com/v1/models", {
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
            });
            if (res.ok) {
                const data = await res.json();
                const ids = (data.data || []).map((m) => m.id).filter(Boolean);
                if (ids.length) {
                    _cachedModels = ids;
                    console.log(`[claude-code-bridge] Fetched ${ids.length} models from Anthropic API`);
                    return _cachedModels;
                }
            } else {
                console.warn(`[claude-code-bridge] Anthropic /v1/models returned ${res.status}, falling back to known list`);
            }
        } catch (err) {
            console.warn(`[claude-code-bridge] Anthropic /v1/models fetch failed: ${err.message}, falling back to known list`);
        }
    }

    _cachedModels = KNOWN_MODELS;
    console.log(`[claude-code-bridge] Using built-in model list (${_cachedModels.length} models). Set ANTHROPIC_API_KEY for live list.`);
    return _cachedModels;
}

// ─── Tool Bridge Mode ─────────────────────────────────────────────

const TOOL_CALL_REGEX = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const TOOL_CALL_FENCED_REGEX = /```(?:xml|json)?\s*\n?<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>\s*\n?```/g;

function toolsToPromptSection(tools) {
    if (!tools || !tools.length) return "";

    const toolDefs = tools.map((t) => {
        const fn = t.function || t;
        const params = fn.parameters ? JSON.stringify(fn.parameters, null, 2) : "{}";
        return `### ${fn.name}\nDescription: ${fn.description || "(no description)"}\nParameters:\n${params}`;
    }).join("\n\n");

    return `<tool_calling_protocol>
You have access to the following tools. When you want to call a tool, output a <tool_call> block in this EXACT format:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

Rules:
- Output ONE <tool_call> block when invoking a tool
- JSON inside must be valid and match the tool's parameter schema
- After the <tool_call> block stop — do not add more text
- If no tool is needed, respond normally without any <tool_call> block

Available tools:
${toolDefs}
</tool_calling_protocol>`;
}

function parseToolCalls(text) {
    const calls = [];
    const seen = new Set();

    for (const regex of [TOOL_CALL_FENCED_REGEX, TOOL_CALL_REGEX]) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const jsonStr = match[1].trim();
            if (seen.has(jsonStr)) continue;
            seen.add(jsonStr);
            try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.name) {
                    calls.push({
                        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                        type: "function",
                        function: {
                            name: parsed.name,
                            arguments: JSON.stringify(parsed.arguments ?? parsed.params ?? {}),
                        },
                    });
                }
            } catch {
                // skip malformed JSON
            }
        }
    }

    return calls;
}

// ─── Helpers ─────────────────────────────────────────────────────

function getContent(msg) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    }
    return String(msg.content ?? "");
}

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CONFIG.charsPerToken);
}

function messagesToPrompt(messages, tools) {
    const parts = [];

    // Inject tool protocol first so it sets context before system instructions
    const toolSection = toolsToPromptSection(tools);
    if (toolSection) parts.push(toolSection);

    let hasSystem = messages.some((m) => m.role === "system");
    if (!hasSystem) {
        const defaultSystem = tools?.length
            ? "You are a helpful AI assistant with access to tools. Use them when needed, following the tool_calling_protocol above."
            : "You are a helpful AI assistant.";
        parts.push(`[System Instructions]\n${defaultSystem}\n[End System Instructions]`);
    }

    for (const msg of messages) {
        switch (msg.role) {
            case "system": {
                const content = getContent(msg);
                if (content) parts.push(`[System Instructions]\n${content}\n[End System Instructions]`);
                break;
            }
            case "user": {
                const content = getContent(msg);
                if (content) parts.push(`[User]\n${content}`);
                break;
            }
            case "assistant": {
                // Replay assistant tool_calls as <tool_call> blocks for multi-turn
                if (msg.tool_calls?.length) {
                    const blocks = msg.tool_calls.map((tc) => {
                        const args = typeof tc.function?.arguments === "string"
                            ? tc.function.arguments
                            : JSON.stringify(tc.function?.arguments || {});
                        return `<tool_call>\n{"name": "${tc.function?.name}", "arguments": ${args}}\n</tool_call>`;
                    }).join("\n");
                    parts.push(`[Assistant]\n${blocks}`);
                } else {
                    const content = getContent(msg);
                    if (content) parts.push(`[Assistant]\n${content}`);
                }
                break;
            }
            case "tool": {
                const content = getContent(msg);
                const label = msg.name || msg.tool_call_id || "unknown";
                if (content) parts.push(`[Tool Result: ${label}]\n${content}`);
                break;
            }
            default: {
                const content = getContent(msg);
                if (content) parts.push(content);
            }
        }
    }

    return parts.join("\n\n");
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
    });
}

function sendError(res, status, message, type = "server_error") {
    if (res.headersSent) return;
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(
        JSON.stringify({
            error: { message, type, code: status },
        })
    );
}

function writeTempPrompt(prompt) {
    const dir = mkdtempSync(join(tmpdir(), "claude-code-bridge-"));
    const file = join(dir, "prompt.txt");
    writeFileSync(file, prompt, "utf8");
    return file;
}

function cleanupTempFile(filePath) {
    try {
        unlinkSync(filePath);
        const dir = filePath.replace(/\/[^/]+$/, "");
        rmdirSync(dir);
    } catch { }
}

function classifyError(err, stderr) {
    const msg = (err?.message || "") + " " + (stderr || "");

    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("overloaded")) {
        return { status: 429, message: "Claude API rate limit or overloaded. Please try again later.", type: "rate_limit" };
    }
    if (msg.includes("auth") || msg.includes("credential") || msg.includes("login") || msg.includes("token")) {
        return { status: 401, message: "Claude Code authentication error. Run 'claude auth login' to set up auth.", type: "auth_error" };
    }
    if (msg.includes("context") || msg.includes("token limit") || msg.includes("too long")) {
        return { status: 400, message: "Context window exceeded", type: "context_overflow" };
    }
    if (msg.includes("ENOENT") || msg.includes("not found")) {
        return { status: 500, message: `Claude Code binary not found at: ${CONFIG.claudeBin}. Install: npm install -g @anthropic-ai/claude-code`, type: "binary_not_found" };
    }
    if (msg.includes("timeout") || msg.includes("SIGTERM")) {
        return { status: 504, message: "Request timed out", type: "timeout" };
    }

    return { status: 500, message: msg.trim() || "Unknown Claude Code error", type: "server_error" };
}

// ─── Core: Run Claude Code CLI ──────────────────────────────────

function runClaudeCode(prompt, requestModel, stream, res, tools) {
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const toolBridgeMode = tools?.length > 0;

    // Support dynamic model switching
    let claudeModel = CONFIG.claudeModel;
    if (requestModel) {
        const bare = requestModel.replace(/^(?:bridge-claude-code|claude)\//, "");
        if (bare) claudeModel = bare;
    }
    const modelName = `claude/${claudeModel}`;

    const useStdinPipe = prompt.length > CONFIG.maxArgLen;

    // Build Claude Code command arguments
    const args = ["-p"]; // print mode (non-interactive)

    // Model
    args.push("--model", claudeModel);

    // Output format
    // Claude Code requires --verbose when using --print with --output-format=stream-json
    if (stream) {
        args.push("--output-format", "stream-json");
        args.push("--verbose");
    } else {
        args.push("--output-format", "json");
    }

    // Permission mode
    if (CONFIG.permissionMode === "bypassPermissions") {
        args.push("--dangerously-skip-permissions");
    } else if (CONFIG.permissionMode === "plan") {
        args.push("--permission-mode", "plan");
    } else if (CONFIG.permissionMode) {
        args.push("--permission-mode", CONFIG.permissionMode);
    }

    // Don't persist sessions (each request is independent)
    args.push("--no-session-persistence");

    // Prompt (via argument or stdin)
    let tempFile = null;
    if (!useStdinPipe) {
        args.push(prompt);
    }

    console.log(
        `[${new Date().toISOString()}] → Request ${requestId.slice(-8)}: model=${claudeModel} stream=${stream} tools=${tools?.length || 0} prompt=${prompt.length} chars (${useStdinPipe ? "stdin-pipe" : "arg"}) permission=${CONFIG.permissionMode}`
    );

    verboseLog(`${requestId.slice(-8)}:CLAUDE_CMD`,
        `${CONFIG.claudeBin} ${args.map(a => a.includes(" ") ? `'${a}'` : a).join(" ")}`
        + (useStdinPipe ? `\n[prompt via stdin pipe]` : "")
    );
    verboseLog(`${requestId.slice(-8)}:PROMPT`, prompt);

    const proc = spawn(CONFIG.claudeBin, args, {
        cwd: CONFIG.workingDir,
        env: {
            ...process.env,
            CI: "true",
            TERM: "dumb",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

    // If using stdin pipe, feed the prompt
    if (useStdinPipe) {
        tempFile = writeTempPrompt(prompt);
        const fileStream = createReadStream(tempFile);
        fileStream.pipe(proc.stdin);
        fileStream.on("end", () => {
            proc.stdin.end();
            cleanupTempFile(tempFile);
            tempFile = null;
        });
    } else {
        proc.stdin.end();
    }

    // Timeout
    const timer = setTimeout(() => {
        console.error(`[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: timeout after ${CONFIG.timeoutMs / 1000}s`);
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, CONFIG.timeoutMs);

    let stderrOutput = "";
    proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrOutput += text;
        verboseLog(`${requestId.slice(-8)}:CLAUDE_STDERR`, text.trimEnd());
    });

    const startTime = Date.now();

    if (stream) {
        // ── Streaming mode ──
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });

        // Send initial SSE role chunk (always, even in tool bridge mode)
        res.write(`data: ${JSON.stringify({
            id: requestId, object: "chat.completion.chunk", created, model: modelName,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })}\n\n`);

        let lineBuffer = "";
        let totalContent = "";      // streamed text (non-tool-bridge)
        let toolBridgeBuffer = "";  // collected text (tool bridge mode — don't stream yet)
        let usageFromResult = null;

        function collectText(text) {
            if (toolBridgeMode) {
                toolBridgeBuffer += text;
            } else {
                totalContent += text;
                res.write(`data: ${JSON.stringify({
                    id: requestId, object: "chat.completion.chunk", created, model: modelName,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                })}\n\n`);
            }
        }

        proc.stdout.on("data", (data) => {
            lineBuffer += data.toString();
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue;
                verboseLog(`${requestId.slice(-8)}:CLAUDE_STDOUT`, line);

                let event;
                try { event = JSON.parse(line); } catch { continue; }

                if (event.type === "assistant" && event.message) {
                    for (const part of (event.message.content || [])) {
                        if (part.type === "text" && part.text) collectText(part.text);
                    }
                } else if (event.type === "content_block_delta" || event.type === "content_block_start") {
                    const text = event.delta?.text || event.content_block?.text || "";
                    if (text) collectText(text);
                } else if (event.type === "result") {
                    if (event.result && !totalContent && !toolBridgeBuffer) collectText(event.result);
                    usageFromResult = {
                        prompt_tokens: event.input_tokens || estimateTokens(prompt),
                        completion_tokens: event.output_tokens || estimateTokens(toolBridgeBuffer || totalContent),
                        total_tokens: (event.input_tokens || estimateTokens(prompt)) + (event.output_tokens || estimateTokens(toolBridgeBuffer || totalContent)),
                    };
                } else if (event.type === "error") {
                    console.error(`  [claude-error] ${event.message || JSON.stringify(event)}`);
                }
            }
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (tempFile) cleanupTempFile(tempFile);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            const usage = usageFromResult || {
                prompt_tokens: estimateTokens(prompt),
                completion_tokens: estimateTokens(toolBridgeBuffer || totalContent),
                total_tokens: estimateTokens(prompt) + estimateTokens(toolBridgeBuffer || totalContent),
            };

            if (code !== 0 && !totalContent && !toolBridgeBuffer) {
                const classified = classifyError(null, stderrOutput);
                res.write(`data: ${JSON.stringify({
                    id: requestId, object: "chat.completion.chunk", created, model: modelName,
                    choices: [{ index: 0, delta: { content: `\n\n[Error: ${classified.message}]` }, finish_reason: "stop" }],
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }

            if (toolBridgeMode) {
                const parsedCalls = parseToolCalls(toolBridgeBuffer);
                if (parsedCalls.length > 0) {
                    // Emit tool_calls chunk
                    res.write(`data: ${JSON.stringify({
                        id: requestId, object: "chat.completion.chunk", created, model: modelName,
                        choices: [{ index: 0, delta: { tool_calls: parsedCalls }, finish_reason: null }],
                    })}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        id: requestId, object: "chat.completion.chunk", created, model: modelName,
                        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                        usage,
                    })}\n\n`);
                    verboseLog(`${requestId.slice(-8)}:RESPONSE_STREAM`,
                        `[tool_calls] ${parsedCalls.map((c) => c.function.name).join(",")} | usage=${JSON.stringify(usage)}`);
                    console.log(`[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (stream, tool_calls=${parsedCalls.map((c) => c.function.name).join(",")})`);
                } else {
                    // No tool calls found — emit buffered text as normal content
                    if (toolBridgeBuffer) {
                        res.write(`data: ${JSON.stringify({
                            id: requestId, object: "chat.completion.chunk", created, model: modelName,
                            choices: [{ index: 0, delta: { content: toolBridgeBuffer }, finish_reason: null }],
                        })}\n\n`);
                    }
                    res.write(`data: ${JSON.stringify({
                        id: requestId, object: "chat.completion.chunk", created, model: modelName,
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                        usage,
                    })}\n\n`);
                    verboseLog(`${requestId.slice(-8)}:RESPONSE_STREAM`, `[stop] code=${code} | chars=${toolBridgeBuffer.length}`);
                    console.log(`[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (stream, tool-bridge no-match, ${toolBridgeBuffer.length} chars)`);
                }
            } else {
                res.write(`data: ${JSON.stringify({
                    id: requestId, object: "chat.completion.chunk", created, model: modelName,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage,
                })}\n\n`);
                verboseLog(`${requestId.slice(-8)}:RESPONSE_STREAM`, `[stop] code=${code} | chars=${totalContent.length}`);
                console.log(`[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (stream, ${totalContent.length} chars)`);
            }

            res.write("data: [DONE]\n\n");
            res.end();
        });
    } else {
        // ── Non-streaming mode ──
        let stdout = "";
        proc.stdout.on("data", (data) => { stdout += data.toString(); });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (tempFile) cleanupTempFile(tempFile);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (code !== 0) {
                const classified = classifyError(null, stderrOutput);
                console.error(`[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: exit code ${code} → ${classified.type}`);
                sendError(res, classified.status, classified.message, classified.type);
                return;
            }

            // Parse Claude Code JSON output
            let claudeResponse;
            try {
                const jsonStart = stdout.indexOf("{");
                claudeResponse = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
            } catch {
                claudeResponse = { result: stdout.trim() };
            }

            const responseText = claudeResponse.result || "";
            const usage = {
                prompt_tokens: claudeResponse.input_tokens || estimateTokens(prompt),
                completion_tokens: claudeResponse.output_tokens || estimateTokens(responseText),
                total_tokens: (claudeResponse.input_tokens || estimateTokens(prompt)) + (claudeResponse.output_tokens || estimateTokens(responseText)),
            };

            // Tool Bridge Mode: check response for <tool_call> blocks
            if (toolBridgeMode) {
                const parsedCalls = parseToolCalls(responseText);
                if (parsedCalls.length > 0) {
                    const response = {
                        id: requestId, object: "chat.completion", created, model: modelName,
                        choices: [{
                            index: 0,
                            message: { role: "assistant", content: null, tool_calls: parsedCalls },
                            finish_reason: "tool_calls",
                        }],
                        usage,
                    };
                    console.log(`[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (non-stream, tool_calls=${parsedCalls.map((c) => c.function.name).join(",")})`);
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    verboseLog(`${requestId.slice(-8)}:RESPONSE_BODY`, response);
                    res.end(JSON.stringify(response));
                    return;
                }
            }

            const response = {
                id: requestId, object: "chat.completion", created, model: modelName,
                choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
                usage,
            };
            console.log(`[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (non-stream, ${responseText.length} chars, usage=${JSON.stringify(usage)})`);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            verboseLog(`${requestId.slice(-8)}:RESPONSE_BODY`, response);
            res.end(JSON.stringify(response));
        });
    }

    proc.on("error", (err) => {
        clearTimeout(timer);
        if (tempFile) cleanupTempFile(tempFile);

        const classified = classifyError(err, stderrOutput);
        console.error(
            `[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: spawn error: ${err.message} → ${classified.type}`
        );
        sendError(res, classified.status, classified.message, classified.type);
    });
}

// ─── HTTP Server ─────────────────────────────────────────────────

const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${CONFIG.host}:${CONFIG.port}`);

    // ── Health check ──
    if ((url.pathname === "/health" || url.pathname === "/") && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(
            JSON.stringify({
                status: "ok",
                service: "claude-code-bridge",
                version: "1.2.0",
                model: CONFIG.claudeModel,
                permissionMode: CONFIG.permissionMode,
            })
        );
        return;
    }

    // ── GET /v1/models ──
    if (url.pathname === "/v1/models" && req.method === "GET") {
        const models = await fetchAvailableModels();
        const now = Math.floor(Date.now() / 1000);
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(
            JSON.stringify({
                object: "list",
                data: models.map((id) => ({
                    id,
                    object: "model",
                    created: now,
                    owned_by: "anthropic",
                })),
            })
        );
        return;
    }

    // ── POST /v1/chat/completions ──
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body;
        try {
            body = await readBody(req);
        } catch (err) {
            sendError(res, 400, "Failed to read request body");
            return;
        }

        let data;
        try {
            data = JSON.parse(body);
        } catch {
            sendError(res, 400, "Invalid JSON in request body", "invalid_request");
            return;
        }

        const messages = data.messages || [];
        const stream = data.stream === true;
        const tools = data.tools || [];

        verboseLog("REQUEST_PARAMS", {
            model: data.model,
            stream,
            temperature: data.temperature,
            max_tokens: data.max_tokens,
            tools_count: tools.length,
            messages_count: messages.length,
            messages,
            ...(tools.length ? { tools } : {}),
        });

        if (!messages.length) {
            sendError(res, 400, "No messages provided", "invalid_request");
            return;
        }

        const prompt = messagesToPrompt(messages, tools);
        if (!prompt.trim()) {
            sendError(res, 400, "Empty prompt after processing messages", "invalid_request");
            return;
        }

        runClaudeCode(prompt, data.model, stream, res, tools);
        return;
    }

    sendError(res, 404, `Unknown endpoint: ${req.method} ${url.pathname}`, "not_found");
});

// ─── Start ───────────────────────────────────────────────────────

server.listen(CONFIG.port, CONFIG.host, () => {
    const logPath = join(LOG_DIR, `claude-code-bridge.${todayStamp()}.log`);
    const authLabel = process.env.ANTHROPIC_API_KEY
        ? "ANTHROPIC_API_KEY (live model list enabled)"
        : "claude.ai OAuth (set ANTHROPIC_API_KEY for live models)";
    console.log(`
┌──────────────────────────────────────────────────────────┐
│              claude-code-bridge v1.2.0                    │
│    OpenAI-compatible API  →  Claude Code CLI             │
├──────────────────────────────────────────────────────────┤
│  Endpoint:   http://${CONFIG.host}:${CONFIG.port}/v1/chat/completions  │
│  Model:      ${CONFIG.claudeModel.padEnd(43)}│
│  Permission: ${CONFIG.permissionMode.padEnd(43)}│
│  Auth:       ${authLabel.slice(0, 43).padEnd(43)}│
│  WorkingDir: ${CONFIG.workingDir.slice(-43).padEnd(43)}│
│  Timeout:    ${(CONFIG.timeoutMs / 1000 + "s").padEnd(43)}│
│  Log:        ${logPath.slice(-43).padEnd(43)}│
│  Verbose:    ${(CONFIG.verbose ? "on (BRIDGE_VERBOSE=false to disable)" : "off").padEnd(43)}│
└──────────────────────────────────────────────────────────┘
  `);
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`✗ Port ${CONFIG.port} is already in use. Set BRIDGE_PORT to use a different port.`);
    } else {
        console.error(`✗ Server error: ${err.message}`);
    }
    process.exit(1);
});

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        console.log(`\n[claude-code-bridge] Received ${signal}, shutting down...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000);
    });
}
