#!/usr/bin/env node
/**
 * claude-code-bridge v1.0 — OpenAI-compatible API proxy for Claude Code CLI
 *
 * Architecture:
 *   OpenClaw  ──(OpenAI API)──►  claude-code-bridge (port 18792)  ──►  claude -p --output-format stream-json
 *
 * This proxy server lets OpenClaw call Claude Code CLI's AI models
 * through an OpenAI-compatible API endpoint.
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
import { writeFileSync, unlinkSync, mkdtempSync, createReadStream, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Configuration ───────────────────────────────────────────────
const CONFIG = {
    port: parseInt(process.env.BRIDGE_PORT || "18792"),
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
};

// Supported models that this bridge can serve
const SUPPORTED_MODELS = [
    { id: "sonnet", name: "Claude Sonnet" },
    { id: "opus", name: "Claude Opus" },
];

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

function messagesToPrompt(messages) {
    const parts = [];

    for (const msg of messages) {
        const content = getContent(msg);
        if (!content) continue;

        switch (msg.role) {
            case "system":
                parts.push(`[System Instructions]\n${content}\n[End System Instructions]`);
                break;
            case "user":
                parts.push(`[User]\n${content}`);
                break;
            case "assistant":
                parts.push(`[Assistant]\n${content}`);
                break;
            case "tool":
                parts.push(`[Tool Result (${msg.tool_call_id || "unknown"})]\n${content}`);
                break;
            default:
                parts.push(content);
        }
    }

    const defaultSystem = "You are a helpful AI assistant. IMPORTANT: When you use tools, you MUST use the tool output to generate a complete, helpful response to the user. Do not stop after just stating your intent to use a tool.";
    let hasSystem = false;
    for (const msg of messages) {
        if (msg.role === "system") hasSystem = true;
    }
    if (!hasSystem) {
        parts.unshift(`[System Instructions]\n${defaultSystem}\n[End System Instructions]`);
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

function runClaudeCode(prompt, requestModel, stream, res) {
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

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
    if (stream) {
        args.push("--output-format", "stream-json");
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
        `[${new Date().toISOString()}] → Request ${requestId.slice(-8)}: model=${claudeModel} stream=${stream} prompt=${prompt.length} chars (${useStdinPipe ? "stdin-pipe" : "arg"}) permission=${CONFIG.permissionMode}`
    );

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
        stderrOutput += chunk.toString();
    });

    const startTime = Date.now();

    if (stream) {
        // ── Streaming mode: parse Claude Code stream-json events ──
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });

        let buffer = "";
        let chunkIndex = 0;
        let totalContent = "";

        // Send initial SSE role chunk
        const roleChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        proc.stdout.on("data", (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue;

                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }

                // Claude Code stream-json events:
                // {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
                // {"type":"result","subtype":"success","result":"...","cost_usd":...}
                if (event.type === "assistant" && event.message) {
                    const contentParts = event.message.content || [];
                    for (const part of contentParts) {
                        if (part.type === "text" && part.text) {
                            totalContent += part.text;
                            chunkIndex++;
                            const sseChunk = {
                                id: requestId,
                                object: "chat.completion.chunk",
                                created,
                                model: modelName,
                                choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
                            };
                            res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                        }
                    }
                }
                // Content block delta (partial text streaming)
                else if (event.type === "content_block_delta" || event.type === "content_block_start") {
                    const text = event.delta?.text || event.content_block?.text || "";
                    if (text) {
                        totalContent += text;
                        chunkIndex++;
                        const sseChunk = {
                            id: requestId,
                            object: "chat.completion.chunk",
                            created,
                            model: modelName,
                            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                        };
                        res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                    }
                }
                else if (event.type === "result") {
                    // If the result has text we haven't seen, add it
                    const resultText = event.result || "";
                    if (resultText && !totalContent) {
                        totalContent = resultText;
                        const sseChunk = {
                            id: requestId,
                            object: "chat.completion.chunk",
                            created,
                            model: modelName,
                            choices: [{ index: 0, delta: { content: resultText }, finish_reason: null }],
                        };
                        res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                    }

                    const usage = {
                        prompt_tokens: event.input_tokens || estimateTokens(prompt),
                        completion_tokens: event.output_tokens || estimateTokens(totalContent),
                        total_tokens: (event.input_tokens || estimateTokens(prompt)) + (event.output_tokens || estimateTokens(totalContent)),
                    };

                    const finalChunk = {
                        id: requestId,
                        object: "chat.completion.chunk",
                        created,
                        model: modelName,
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                        usage,
                    };
                    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                }
                else if (event.type === "error") {
                    console.error(`  [claude-error] ${event.message || JSON.stringify(event)}`);
                }
            }
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (tempFile) cleanupTempFile(tempFile);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (code !== 0 && !totalContent) {
                const classified = classifyError(null, stderrOutput);
                const errorChunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelName,
                    choices: [{ index: 0, delta: { content: `\n\n[Error: ${classified.message}]` }, finish_reason: "stop" }],
                };
                res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            }

            res.write("data: [DONE]\n\n");
            res.end();

            console.log(
                `[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (stream, ${totalContent.length} chars)`
            );
        });
    } else {
        // ── Non-streaming mode: collect full JSON response ──
        let stdout = "";

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (tempFile) cleanupTempFile(tempFile);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (code !== 0) {
                const classified = classifyError(null, stderrOutput);
                console.error(
                    `[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: exit code ${code} → ${classified.type}`
                );
                sendError(res, classified.status, classified.message, classified.type);
                return;
            }

            // Parse Claude Code JSON output
            let claudeResponse;
            try {
                const jsonStart = stdout.indexOf("{");
                const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
                claudeResponse = JSON.parse(jsonStr);
            } catch {
                // If JSON parsing fails, treat stdout as plain text
                claudeResponse = { result: stdout.trim() };
            }

            const responseText = claudeResponse.result || "";

            const usage = {
                prompt_tokens: claudeResponse.input_tokens || estimateTokens(prompt),
                completion_tokens: claudeResponse.output_tokens || estimateTokens(responseText),
                total_tokens: (claudeResponse.input_tokens || estimateTokens(prompt)) + (claudeResponse.output_tokens || estimateTokens(responseText)),
            };

            const response = {
                id: requestId,
                object: "chat.completion",
                created,
                model: modelName,
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: responseText },
                        finish_reason: "stop",
                    },
                ],
                usage,
            };

            console.log(
                `[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (non-stream, ${responseText.length} chars, usage=${JSON.stringify(usage)})`
            );

            res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            });
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
                version: "1.0.0",
                model: CONFIG.claudeModel,
                permissionMode: CONFIG.permissionMode,
            })
        );
        return;
    }

    // ── GET /v1/models ──
    if (url.pathname === "/v1/models" && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        });
        const now = Math.floor(Date.now() / 1000);
        res.end(
            JSON.stringify({
                object: "list",
                data: SUPPORTED_MODELS.map((m) => ({
                    id: m.id,
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

        if (!messages.length) {
            sendError(res, 400, "No messages provided", "invalid_request");
            return;
        }

        const prompt = messagesToPrompt(messages);
        if (!prompt.trim()) {
            sendError(res, 400, "Empty prompt after processing messages", "invalid_request");
            return;
        }

        runClaudeCode(prompt, data.model, stream, res);
        return;
    }

    sendError(res, 404, `Unknown endpoint: ${req.method} ${url.pathname}`, "not_found");
});

// ─── Start ───────────────────────────────────────────────────────

server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`
┌──────────────────────────────────────────────────────────┐
│              claude-code-bridge v1.0.0                    │
│    OpenAI-compatible API  →  Claude Code CLI             │
├──────────────────────────────────────────────────────────┤
│  Endpoint:   http://${CONFIG.host}:${CONFIG.port}/v1/chat/completions  │
│  Model:      ${CONFIG.claudeModel.padEnd(43)}│
│  Permission: ${CONFIG.permissionMode.padEnd(43)}│
│  WorkingDir: ${CONFIG.workingDir.slice(-43).padEnd(43)}│
│  Timeout:    ${(CONFIG.timeoutMs / 1000 + "s").padEnd(43)}│
│  MaxArgLen:  ${(CONFIG.maxArgLen + " chars").padEnd(43)}│
├──────────────────────────────────────────────────────────┤
│  OpenClaw config:                                        │
│    baseUrl: http://${CONFIG.host}:${CONFIG.port}/v1${" ".repeat(20)}│
│    apiKey:  claude-code-bridge-local                     │
│    api:     openai-completions                           │
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
