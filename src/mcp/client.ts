import { execa } from "execa";

/** One entry of settings "mcpServers": a local command (stdio) or a URL (Streamable HTTP). */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Seconds to wait for each request (default 60; connecting gets 30). */
  timeout?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: string; [k: string]: unknown };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** JSON-RPC over a transport; subclasses deliver messages to `receive`. */
abstract class Rpc {
  private nextId = 1;
  protected pending = new Map<number, Pending>();
  constructor(protected readonly timeoutMs: number) {}

  protected abstract write(message: object): Promise<void>;
  abstract close(): Promise<void>;

  request<T>(method: string, params?: object, timeoutMs = this.timeoutMs): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }).catch((err: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  notify(method: string, params?: object): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /** Handle one incoming message: a response, or a server request we answer minimally. */
  protected receive(msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string; code?: number } }): void {
    if (msg.method !== undefined) {
      // Server → client requests: answer pings; decline anything else we don't support.
      if (msg.id !== undefined) {
        const reply = msg.method === "ping" ? { result: {} } : { error: { code: -32601, message: `Forge doesn't support ${msg.method}` } };
        void this.write({ jsonrpc: "2.0", id: msg.id, ...reply }).catch(() => {});
      }
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? `error ${msg.error.code}`));
    else p.resolve(msg.result);
  }

  protected failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

function spawnServer(cfg: McpServerConfig, root: string) {
  return execa(cfg.command!, cfg.args ?? [], {
    cwd: cfg.cwd ?? root,
    env: cfg.env ?? {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    buffer: false,
    reject: false,
    windowsHide: true,
  });
}

/** A server started as a child process, speaking newline-delimited JSON on stdin/stdout. */
class StdioRpc extends Rpc {
  private child: ReturnType<typeof spawnServer>;
  private buf = "";
  stderr = "";
  exited = false;

  constructor(cfg: McpServerConfig, root: string, timeoutMs: number) {
    super(timeoutMs);
    this.child = spawnServer(cfg, root);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          // Not JSON (a log line on stdout): ignore it.
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    void this.child.then((r) => {
      this.exited = true;
      const why = r.failed && r.code === "ENOENT" ? `command not found: ${cfg.command}` : `exited (code ${r.exitCode ?? r.signal})`;
      this.failAll(new Error(`the server ${why}${this.stderr ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`));
    });
  }

  protected async write(message: object): Promise<void> {
    if (this.exited) throw new Error("the server isn't running");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Streamable HTTP: POST each message; the reply is JSON or a server-sent event stream. */
class HttpRpc extends Rpc {
  private session: string | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    timeoutMs: number,
  ) {
    super(timeoutMs);
  }

  protected async write(message: object): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...this.headers,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? " (unauthorized: check the server's headers in settings)" : ""}: ${(await res.text()).slice(0, 200)}`);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      const text = await res.text();
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) this.deliver(data);
      }
    } else {
      const text = await res.text();
      if (text.trim()) this.deliver(text);
    }
  }

  private deliver(data: string): void {
    try {
      const parsed: unknown = JSON.parse(data);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.receive(m as never);
    } catch {
      // ignore malformed events
    }
  }

  async close(): Promise<void> {
    if (!this.session) return;
    await fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.session, ...this.headers }, signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
}

/** A connected MCP server. */
export class McpClient {
  private constructor(
    private readonly rpc: Rpc,
    readonly serverInfo: { name?: string; version?: string },
    readonly instructions: string | undefined,
  ) {}

  static async connect(cfg: McpServerConfig, root: string): Promise<McpClient> {
    const timeoutMs = (cfg.timeout ?? 60) * 1000;
    let rpc: Rpc;
    if (cfg.url) rpc = new HttpRpc(cfg.url, cfg.headers ?? {}, timeoutMs);
    else if (cfg.command) rpc = new StdioRpc(cfg, root, timeoutMs);
    else throw new Error('needs "command" (a local server) or "url" (a remote one)');
    try {
      const init = await rpc.request<{ serverInfo?: { name?: string; version?: string }; instructions?: string }>(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "forge", version: "0.1.0" } },
        Math.min(timeoutMs, 30_000),
      );
      await rpc.notify("notifications/initialized");
      return new McpClient(rpc, init.serverInfo ?? {}, init.instructions);
    } catch (err) {
      await rpc.close().catch(() => {});
      throw err;
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.rpc.request<{ tools: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name: string, args: unknown): Promise<McpCallResult> {
    return this.rpc.request<McpCallResult>("tools/call", { name, arguments: args ?? {} });
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}
