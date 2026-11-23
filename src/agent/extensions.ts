import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { forgeHome } from "../config/index.js";
import type { HooksConfig } from "../hooks/index.js";
import type { McpServerConfig } from "../mcp/client.js";
import { defineTool, ToolError, type Tool } from "../tools/types.js";

/** "---\nkey: value\n---\nbody" → meta and body; text without frontmatter is all body. */
export function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2]!.trim() };
}

// ---------- plugins ----------

export interface Plugin {
  name: string;
  description?: string;
  dir: string;
  hooks: HooksConfig;
  mcpServers: Record<string, McpServerConfig>;
}

const PluginManifest = z
  .object({
    name: z.string(),
    description: z.string(),
    hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), command: z.string(), timeout: z.number().optional() }))),
    mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .partial();

/**
 * Plugins are folders in ~/.forge/plugins/ or <project>/.forge/plugins/ that
 * bundle commands/, agents/, skills/ and a plugin.json with hooks and MCP
 * servers. Hook commands run in the plugin's folder via ${PLUGIN_DIR}.
 */
export function loadPlugins(root: string, env: NodeJS.ProcessEnv = process.env): { plugins: Plugin[]; errors: string[] } {
  const plugins: Plugin[] = [];
  const errors: string[] = [];
  for (const base of [path.join(forgeHome(env), "plugins"), path.join(root, ".forge", "plugins")]) {
    for (const name of listDirs(base)) {
      const dir = path.join(base, name);
      const manifest = path.join(dir, "plugin.json");
      let data: z.infer<typeof PluginManifest> = {};
      if (existsSync(manifest)) {
        try {
          const parsed = PluginManifest.safeParse(JSON.parse(readFileSync(manifest, "utf8")));
          if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
          data = parsed.data;
        } catch (err) {
          errors.push(`${manifest}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      const sub = (s: string) => s.replace(/\$\{PLUGIN_DIR\}/g, dir);
      const hooks: HooksConfig = {};
      for (const [event, list] of Object.entries(data.hooks ?? {})) {
        (hooks as Record<string, unknown[]>)[event] = list.map((h) => ({ ...h, command: sub(h.command) }));
      }
      const mcpServers: Record<string, McpServerConfig> = {};
      for (const [server, cfg] of Object.entries(data.mcpServers ?? {})) {
        const c = cfg as McpServerConfig;
        mcpServers[server] = { ...c, ...(c.command ? { command: sub(c.command) } : {}), ...(c.args ? { args: c.args.map(sub) } : {}), cwd: c.cwd ? sub(c.cwd) : dir };
      }
      plugins.push({ name: data.name ?? name, ...(data.description ? { description: data.description } : {}), dir, hooks, mcpServers });
    }
  }
  return { plugins, errors };
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((d) => statSync(path.join(dir, d)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

/** Where commands/agents/skills live: user, project, then each plugin. */
export function extensionDirs(root: string, kind: "commands" | "agents" | "skills", plugins: Plugin[], env: NodeJS.ProcessEnv = process.env): string[] {
  return [path.join(forgeHome(env), kind), path.join(root, ".forge", kind), ...plugins.map((p) => path.join(p.dir, kind))];
}

// ---------- custom slash commands ----------

export interface CustomCommand {
  name: string;
  description: string;
  args?: string;
  template: string;
  source: string;
}

/** commands/<name>.md → /name; a later directory overrides an earlier one. */
export function loadCustomCommands(dirs: string[]): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const name = f.replace(/\.md$/, "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) continue;
      const file = path.join(dir, f);
      const { meta, body } = splitFrontmatter(readFileSync(file, "utf8"));
      const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? name;
      byName.set(name, {
        name,
        description: meta.description ?? (firstLine.length > 70 ? `${firstLine.slice(0, 69)}…` : firstLine),
        ...(meta["argument-hint"] || meta.args ? { args: meta["argument-hint"] ?? meta.args } : {}),
        template: body,
        source: file,
      });
    }
  }
  return [...byName.values()];
}

/** Fill $ARGUMENTS (all of it) and $1…$9 (words); with no placeholder, arguments are appended. */
export function expandTemplate(template: string, args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (!/\$ARGUMENTS|\$[1-9]/.test(template)) return args.trim() ? `${template}\n\n${args.trim()}` : template;
  return template.replace(/\$ARGUMENTS/g, args.trim()).replace(/\$([1-9])/g, (_m, n: string) => words[Number(n) - 1] ?? "");
}

// ---------- skills ----------

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
}

/** skills/<name>/SKILL.md with frontmatter name and description. */
export function loadSkills(dirs: string[]): { skills: Skill[]; errors: string[] } {
  const byName = new Map<string, Skill>();
  const errors: string[] = [];
  for (const dir of dirs) {
    for (const d of listDirs(dir)) {
      const file = path.join(dir, d, "SKILL.md");
      if (!existsSync(file)) continue;
      const { meta } = splitFrontmatter(readFileSync(file, "utf8"));
      if (!meta.description) {
        errors.push(`${file}: missing description in the frontmatter`);
        continue;
      }
      const name = meta.name ?? d;
      byName.set(name, { name, description: meta.description, dir: path.join(dir, d), file });
    }
  }
  return { skills: [...byName.values()], errors };
}

/** For the system prompt: which skills exist and when to load them. */
export function skillsSection(skills: Skill[]): string {
  if (!skills.length) return "";
  return `\n\n# Skills\nThese packaged instructions are available. When a task matches one, call the skill tool with its name first and follow what it says.\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
}

export function makeSkillTool(skills: Skill[]): Tool {
  return defineTool({
    name: "skill",
    description: `Load a skill: packaged instructions (and sometimes scripts or reference files) for a kind of task. Available: ${skills.map((s) => s.name).join(", ")}. The system prompt says what each is for.`,
    schema: z.object({ name: z.string().describe("The skill's name") }),
    readOnly: true,
    summarize: (i) => i.name,
    async run(input) {
      const s = skills.find((x) => x.name === input.name);
      if (!s) throw new ToolError(`No skill "${input.name}". Available: ${skills.map((x) => x.name).join(", ")}`);
      const { body } = splitFrontmatter(readFileSync(s.file, "utf8"));
      const others = listFiles(s.dir).filter((f) => f !== "SKILL.md");
      const files = others.length ? `\n\nFiles in this skill (paths relative to ${s.dir}; read them when the instructions say to):\n${others.map((f) => `- ${f}`).join("\n")}` : "";
      return { content: `# Skill: ${s.name}\n\n${body}${files}` };
    },
  });
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries.sort()) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${e}/`));
    else out.push(`${prefix}${e}`);
    if (out.length > 50) break;
  }
  return out;
}
