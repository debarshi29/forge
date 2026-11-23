import { z } from "zod";
import type { ImageBlock, TextBlock } from "../providers/types.js";
import { defineTool, type Tool, type ToolResult } from "../tools/types.js";
import { McpClient, type McpCallResult, type McpServerConfig, type McpTool } from "./client.js";

export type { McpServerConfig } from "./client.js";

export interface ServerStatus {
  name: string;
  state: "connecting" | "connected" | "failed";
  error?: string;
  tools: string[];
  /** "stdio: npx -y x" or the URL. */
  target: string;
}

/** Tool names are mcp__<server>__<tool>, limited to characters every provider accepts. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** Turn an MCP result into tool output: text and images, with resources inlined as text. */
export function toToolResult(r: McpCallResult): ToolResult {
  const parts: Array<TextBlock | ImageBlock> = [];
  for (const c of r.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") parts.push({ type: "text", text: c.text });
    else if (c.type === "image" && typeof c.data === "string") parts.push({ type: "image", mediaType: String(c.mimeType ?? "image/png"), data: c.data });
    else if (c.type === "resource" && c.resource && typeof c.resource === "object") {
      const res = c.resource as { uri?: string; text?: string };
      parts.push({ type: "text", text: res.text ?? `[resource ${res.uri ?? ""}]` });
    } else parts.push({ type: "text", text: `[${c.type} content]` });
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push({ type: "text", text: JSON.stringify(r.structuredContent, null, 2) });
  const onlyText = parts.every((p) => p.type === "text");
  return {
    content: onlyText ? parts.map((p) => (p as TextBlock).text).join("\n") || "(no output)" : parts,
    ...(r.isError ? { isError: true } : {}),
  };
}

function makeTool(server: string, client: McpClient, t: McpTool): Tool {
  return defineTool({
    name: mcpToolName(server, t.name),
    description: `${t.description?.trim() || t.annotations?.title || t.name} (from the ${server} MCP server)`,
    // The server validates its own input; Forge passes the JSON schema through as-is.
    schema: z.unknown(),
    jsonSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
    readOnly: t.annotations?.readOnlyHint === true,
    summarize: (i) => {
      const s = JSON.stringify(i ?? {});
      return s.length > 160 ? `${s.slice(0, 159)}…` : s;
    },
    async run(input) {
      return toToolResult(await client.callTool(t.name, input));
    },
  });
}

/**
 * Starts the configured MCP servers in parallel and adds their tools to a
 * tool list as they connect (so a slow server doesn't hold up start-up).
 */
export class McpManager {
  readonly status: ServerStatus[] = [];
  private clients: McpClient[] = [];

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly root: string,
  ) {
    for (const [name, cfg] of Object.entries(servers)) {
      this.status.push({ name, state: "connecting", tools: [], target: cfg.url ?? `stdio: ${[cfg.command, ...(cfg.args ?? [])].join(" ")}` });
    }
  }

  get count(): number {
    return this.status.length;
  }

  /** Connect everything; push tools into `tools`. Resolves when every server has connected or failed. */
  async start(tools: Tool[], onChange?: (s: ServerStatus) => void): Promise<void> {
    await Promise.all(
      Object.entries(this.servers).map(async ([name, cfg]) => {
        const st = this.status.find((s) => s.name === name)!;
        try {
          const client = await McpClient.connect(cfg, this.root);
          this.clients.push(client);
          const list = await client.listTools();
          const made = list.map((t) => makeTool(name, client, t));
          // Replace any tools from an earlier connection of the same server.
          const prefix = mcpToolName(name, "");
          for (let i = tools.length - 1; i >= 0; i--) if (tools[i]!.name.startsWith(prefix)) tools.splice(i, 1);
          tools.push(...made);
          st.state = "connected";
          st.tools = made.map((t) => t.name);
        } catch (err) {
          st.state = "failed";
          st.error = err instanceof Error ? err.message : String(err);
        }
        onChange?.(st);
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
  }

  describe(): string {
    if (!this.status.length) return 'No MCP servers configured. Add them under "mcpServers" in settings.';
    return this.status
      .map((s) => {
        const head = `  ${s.state === "connected" ? "●" : s.state === "failed" ? "✘" : "…"} ${s.name}  ${s.target}`;
        if (s.state === "failed") return `${head}\n      ${s.error}`;
        if (s.state === "connecting") return `${head}\n      connecting…`;
        return `${head}\n      ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}: ${s.tools.map((t) => t.replace(mcpToolName(s.name, ""), "")).join(", ") || "(none)"}`;
      })
      .join("\n");
  }
}
