import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/index.js";
import { DEFAULT_MODEL } from "../providers/registry.js";
import { HOOK_EVENTS, type HooksConfig } from "../hooks/index.js";
import { parseRule } from "../permissions/rules.js";

const RuleList = z.array(
  z.string().superRefine((r, ctx) => {
    try {
      parseRule(r);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
    }
  }),
);

const HookSpecSchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeout: z.number().positive().optional(),
});

const HooksSchema = z.object(Object.fromEntries(HOOK_EVENTS.map((e) => [e, z.array(HookSpecSchema)])) as Record<
  (typeof HOOK_EVENTS)[number],
  z.ZodArray<typeof HookSpecSchema>
>).partial();

const SettingsSchema = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    permissionMode: z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]),
    maxTokens: z.number().int().positive(),
    /** Summarize older turns near the context limit (default true). */
    autoCompact: z.boolean(),
    /** Fraction of the context window that triggers auto-compaction (default 0.8). */
    compactThreshold: z.number().min(0.3).max(0.95),
    /** Model roles: "main" (same as "model") and "fast" (summaries and other side work). */
    models: z.object({ main: z.string(), fast: z.string() }).partial(),
    /** Check files after edits: false to turn off, or a command to run instead of the built-in checks. */
    diagnostics: z.union([z.boolean(), z.object({ command: z.string().min(1), timeout: z.number().positive() }).partial()]),
    /** Re-ask local models for malformed tool arguments with schema-constrained output (default true). */
    repairToolCalls: z.boolean(),
    /** Session limits: cost (USD), tokens, and model requests per prompt. */
    budget: z.object({ costUSD: z.number().positive(), tokens: z.number().int().positive(), requestsPerPrompt: z.number().int().positive() }).partial(),
    /** A command whose stdout is shown under the prompt; it gets the session state as JSON on stdin. */
    statusLine: z.object({ command: z.string().min(1), timeout: z.number().positive().optional() }),
    theme: z.string(),
    pet: z.string(),
    petName: z.string(),
    /** Pet reacts to mouse clicks. Off by default: it disables normal drag-to-select. */
    petMouse: z.boolean(),
    anthropic: z.object({ baseURL: z.string(), fallbacks: z.boolean() }).partial(),
    openai: z.object({ baseURL: z.string(), contextWindow: z.number().int().positive() }).partial(),
    gemini: z.object({ vertexai: z.boolean(), project: z.string(), location: z.string() }).partial(),
    ollama: z
      .object({
        baseURL: z.string(),
        contextWindow: z.number().int().positive(),
        /** Per model: the context length to run it with (set by /context <size>). */
        contextLengths: z.record(z.string(), z.number().int().min(2048).max(1_048_576)),
        /** Sampling temperature for local models (Forge's default is 0.2). */
        temperature: z.number().min(0).max(2),
      })
      .partial(),
    lmstudio: z.object({ baseURL: z.string(), contextWindow: z.number().int().positive(), temperature: z.number().min(0).max(2) }).partial(),
    /** Permission rules like "bash(git status:*)" or "edit(src/**)". */
    permissions: z.object({ allow: RuleList, deny: RuleList, ask: RuleList }).partial(),
    /** Shell commands run around tool calls, prompts and stops. */
    hooks: HooksSchema,
    /** MCP servers: name → { command, args, env } or { url, headers }. */
    mcpServers: z.record(
      z.string().regex(/^[A-Za-z0-9_-]+$/, "use letters, digits, _ and - in server names"),
      z
        .object({
          command: z.string().min(1),
          args: z.array(z.string()),
          env: z.record(z.string(), z.string()),
          cwd: z.string(),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()),
          timeout: z.number().positive(),
        })
        .partial()
        .refine((s) => Boolean(s.command) !== Boolean(s.url), 'give either "command" or "url"'),
    ),
  })
  .partial();

const PROVIDER_KEYS = ["anthropic", "openai", "gemini", "ollama", "lmstudio"] as const;

export type Settings = z.infer<typeof SettingsSchema>;

export interface Config {
  model: string;
  effort: NonNullable<Settings["effort"]>;
  permissionMode: PermissionMode;
  maxTokens?: number;
  autoCompact: boolean;
  compactThreshold: number;
  /** Model for side work (summaries); undefined = the main model. */
  fastModel?: string;
  diagnostics: false | { command?: string; timeout?: number };
  repairToolCalls: boolean;
  statusLine?: { command: string; timeout?: number };
  budget?: { costUSD?: number; tokens?: number; requestsPerPrompt?: number };
  theme?: string;
  pet?: string;
  petName?: string;
  petMouse?: boolean;
  anthropic: NonNullable<Settings["anthropic"]>;
  openai: NonNullable<Settings["openai"]>;
  gemini: NonNullable<Settings["gemini"]>;
  ollama: NonNullable<Settings["ollama"]>;
  lmstudio: NonNullable<Settings["lmstudio"]>;
  /** Rules from every settings file, concatenated. */
  permissions: { allow: string[]; deny: string[]; ask: string[] };
  /** Hooks from every settings file, concatenated per event. */
  hooks: HooksConfig;
  /** MCP servers from every settings file (a project entry replaces a user one with the same name). */
  mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeout?: number }>;
  /** Files that were loaded, lowest precedence first. */
  sources: string[];
}

export function forgeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FORGE_HOME ?? path.join(os.homedir(), ".forge");
}

function loadFile(file: string): Settings | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
  }
  const parsed = SettingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * Precedence, lowest to highest: defaults < ~/.forge/settings.json <
 * <project>/.forge/settings.json < env (FORGE_MODEL) < CLI flags.
 */
export function loadConfig(root: string, flags: Settings = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const files = [path.join(forgeHome(env), "settings.json"), path.join(root, ".forge", "settings.json")];
  const sources: string[] = [];
  let merged: Settings = {};
  for (const f of files) {
    const s = loadFile(f);
    if (s) {
      sources.push(f);
      const next: Settings = { ...merged, ...s };
      // Provider sections merge key by key rather than replacing each other.
      for (const k of [...PROVIDER_KEYS, "models"] as const) next[k] = { ...merged[k], ...s[k] } as never;
      // Rules and hooks add up: a project can't silently drop the user's deny rules.
      next.permissions = {
        allow: [...(merged.permissions?.allow ?? []), ...(s.permissions?.allow ?? [])],
        deny: [...(merged.permissions?.deny ?? []), ...(s.permissions?.deny ?? [])],
        ask: [...(merged.permissions?.ask ?? []), ...(s.permissions?.ask ?? [])],
      };
      const hooks: HooksConfig = {};
      for (const e of HOOK_EVENTS) {
        const list = [...(merged.hooks?.[e] ?? []), ...(s.hooks?.[e] ?? [])];
        if (list.length) hooks[e] = list;
      }
      next.hooks = hooks;
      next.mcpServers = { ...merged.mcpServers, ...s.mcpServers };
      merged = next;
    }
  }
  const fromEnv: Settings = env.FORGE_MODEL ? { model: env.FORGE_MODEL } : {};
  const defined = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)) as Settings;
  merged = { ...merged, ...fromEnv, ...defined };
  return {
    model: defined.model ?? fromEnv.model ?? merged.models?.main ?? merged.model ?? DEFAULT_MODEL,
    effort: merged.effort ?? "high",
    permissionMode: merged.permissionMode ?? "default",
    maxTokens: merged.maxTokens,
    autoCompact: merged.autoCompact ?? true,
    compactThreshold: merged.compactThreshold ?? 0.8,
    ...(merged.models?.fast ? { fastModel: merged.models.fast } : {}),
    diagnostics: merged.diagnostics === false ? false : typeof merged.diagnostics === "object" ? merged.diagnostics : {},
    repairToolCalls: merged.repairToolCalls ?? true,
    ...(merged.statusLine ? { statusLine: merged.statusLine } : {}),
    ...(merged.budget && Object.keys(merged.budget).length ? { budget: merged.budget } : {}),
    theme: merged.theme,
    pet: merged.pet,
    petName: merged.petName,
    petMouse: merged.petMouse,
    anthropic: merged.anthropic ?? {},
    openai: merged.openai ?? {},
    gemini: merged.gemini ?? {},
    ollama: merged.ollama ?? {},
    lmstudio: merged.lmstudio ?? {},
    permissions: {
      allow: merged.permissions?.allow ?? [],
      deny: merged.permissions?.deny ?? [],
      ask: merged.permissions?.ask ?? [],
    },
    hooks: merged.hooks ?? {},
    mcpServers: merged.mcpServers ?? {},
    sources,
  };
}

/** Read-modify-write ~/.forge/settings.json (for nested changes). */
export function updateUserSettings(fn: (current: Record<string, unknown>) => Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  const file = path.join(forgeHome(env), "settings.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // missing or unreadable: start fresh
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fn(current), null, 2) + "\n");
}

/** Add an allow rule to <project>/.forge/settings.json (kept unique). */
export function addProjectAllowRule(root: string, rule: string): void {
  const file = path.join(root, ".forge", "settings.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // missing or unreadable: start fresh
  }
  const permissions = { ...((current.permissions as Record<string, unknown> | undefined) ?? {}) };
  const allow = [...((permissions.allow as string[] | undefined) ?? [])];
  if (!allow.includes(rule)) allow.push(rule);
  permissions.allow = allow;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...current, permissions }, null, 2) + "\n");
}

/** Save the context length for one Ollama model (undefined removes it). */
export function saveOllamaContextLength(model: string, tokens: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
  updateUserSettings((cur) => {
    const ollama = { ...((cur.ollama as Record<string, unknown> | undefined) ?? {}) };
    const lengths = { ...((ollama.contextLengths as Record<string, number> | undefined) ?? {}) };
    if (tokens === undefined) delete lengths[model];
    else lengths[model] = tokens;
    if (Object.keys(lengths).length) ollama.contextLengths = lengths;
    else delete ollama.contextLengths;
    return { ...cur, ollama };
  }, env);
}

/**
 * Merge keys into ~/.forge/settings.json, keeping everything else in it.
 * Used for choices made in the UI, like /theme.
 */
export function saveUserSettings(patch: Settings, env: NodeJS.ProcessEnv = process.env): void {
  const file = path.join(forgeHome(env), "settings.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // missing or unreadable: start fresh
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
}
