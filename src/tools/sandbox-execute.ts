import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import { createLogger } from "../logger";

const log = createLogger("tool:sandbox");

const MAX_OUTPUT_BYTES = 50 * 1024;

type Language = "python" | "bash" | "javascript";

function buildCommand(language: Language, filename: string): string {
  switch (language) {
    case "python":
      return `python3 /tmp/${filename}`;
    case "javascript":
      return `node /tmp/${filename}`;
    case "bash":
      return `bash /tmp/${filename}`;
  }
}

function fileExtension(language: Language): string {
  switch (language) {
    case "python":
      return "py";
    case "javascript":
      return "js";
    case "bash":
      return "sh";
  }
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  const omitted = text.length - MAX_OUTPUT_BYTES;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n\n[... ${omitted} bytes omitted ...]`;
}

interface SandboxEvent {
  readonly type: string;
  readonly text?: string;
  readonly error?: {
    readonly ename: string;
    readonly evalue: string;
    readonly traceback: readonly string[];
  };
}

async function createSandbox(
  baseUrl: string,
  image: string,
  timeoutSec: number,
): Promise<string> {
  const res = await fetch(`${baseUrl}/sandboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: { uri: image },
      timeout: Math.max(timeoutSec, 60),
      resourceLimits: { cpu: "500m", memory: "512Mi" },
      entrypoint: ["tail", "-f", "/dev/null"],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create sandbox: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

async function waitForReady(
  baseUrl: string,
  sandboxId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/sandboxes/${sandboxId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        status?: { state?: string };
      };
      if (data.status?.state === "Running") return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Sandbox did not reach Running state within 30s");
}

async function executeInSandbox(
  baseUrl: string,
  sandboxId: string,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; errorInfo: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `${baseUrl}/sandboxes/${sandboxId}/proxy/44772/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Command execution failed: ${res.status} ${body}`);
    }

    let stdout = "";
    let stderr = "";
    let errorInfo = "";

    // Stream response line-by-line; stop on execution_complete/error
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as SandboxEvent;
          if (event.type === "stdout" && event.text) {
            stdout += (stdout ? "\n" : "") + event.text;
          } else if (event.type === "stderr" && event.text) {
            stderr += (stderr ? "\n" : "") + event.text;
          } else if (event.type === "error" && event.error) {
            errorInfo = `${event.error.ename}: ${event.error.evalue}\n${event.error.traceback.join("\n")}`;
            break outer;
          } else if (event.type === "execution_complete") {
            break outer;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }

    reader.cancel();
    return { stdout, stderr, errorInfo };
  } finally {
    clearTimeout(timer);
  }
}

async function deleteSandbox(baseUrl: string, sandboxId: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/sandboxes/${sandboxId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn("Failed to delete sandbox", { err, sandboxId });
  }
}

export function createSandboxExecuteTool(config: ToolsConfig): ToolDefinition {
  return {
    name: "sandbox_execute",
    description:
      "Execute code in an isolated Docker container. Supports Python, JavaScript, and Bash. Safe for running untrusted or experimental code.",
    categories: ["code"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The code to execute",
        },
        language: {
          type: "string",
          enum: ["python", "bash", "javascript"],
          description: "Programming language of the code",
        },
        timeout: {
          type: "number",
          description: "Execution timeout in milliseconds (optional)",
        },
      },
      required: ["code", "language"],
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      if (!config.sandbox.enabled) {
        return {
          output: "Error: sandbox execution is disabled. Enable it via config.tools.sandbox.enabled.",
          isError: true,
        };
      }

      const code = String(input.code ?? "");
      const language = String(input.language ?? "") as Language;
      const rawTimeout =
        typeof input.timeout === "number" ? input.timeout : config.sandbox.defaultTimeout;
      const timeout = Math.min(rawTimeout, config.sandbox.maxTimeout);

      if (!code.trim()) {
        return { output: "Error: empty code", isError: true };
      }

      const { baseUrl, image } = config.sandbox;
      const timeoutSec = Math.ceil(timeout / 1000);
      const ext = fileExtension(language);
      const filename = `code_${Date.now()}.${ext}`;
      const command = buildCommand(language, filename);

      log.debug("Creating sandbox", { language, timeout });

      let sandboxId: string | null = null;
      try {
        sandboxId = await createSandbox(baseUrl, image, timeoutSec);
        log.debug("Sandbox created, waiting for ready", { sandboxId });

        await waitForReady(baseUrl, sandboxId);

        // Write code to a temp file, then execute it
        const writeCommand = `printf '%s' ${JSON.stringify(code)} > /tmp/${filename}`;
        await executeInSandbox(baseUrl, sandboxId, writeCommand, 15_000);

        const { stdout, stderr, errorInfo } = await executeInSandbox(
          baseUrl,
          sandboxId,
          command,
          timeout,
        );

        const parts: string[] = [];
        if (stdout.trim()) parts.push(truncateOutput(stdout.trim()));
        if (stderr.trim()) parts.push(`stderr:\n${truncateOutput(stderr.trim())}`);
        if (errorInfo) parts.push(`error:\n${errorInfo}`);
        if (parts.length === 0) parts.push("(no output)");

        const isError = !!errorInfo;
        log.debug("Sandbox execution complete", { sandboxId, isError });

        return { output: parts.join("\n\n"), isError };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("sandbox_execute failed", { err, sandboxId });
        return { output: `Error: ${msg}`, isError: true };
      } finally {
        if (sandboxId) {
          await deleteSandbox(baseUrl, sandboxId);
        }
      }
    },
  };
}
