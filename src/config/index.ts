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
      })
      .partial(),
    lmstudio: z.object({ baseURL: z.string(), contextWindow: z.number().int().positive() }).partial(),
    /** Permission rules like "bash(git status:*)" or "edit(src/**)". */
    permissions: z.object({ allow: RuleList, deny: RuleList, ask: RuleList }).partial(),
    /** Shell commands run around tool calls, prompts and stops. */
    hooks: HooksSchema,
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
      for (const k of PROVIDER_KEYS) next[k] = { ...merged[k], ...s[k] } as never;
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
      merged = next;
    }
  }
  const fromEnv: Settings = env.FORGE_MODEL ? { model: env.FORGE_MODEL } : {};
  const defined = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)) as Settings;
  merged = { ...merged, ...fromEnv, ...defined };
  return {
    model: merged.model ?? DEFAULT_MODEL,
    effort: merged.effort ?? "high",
    permissionMode: merged.permissionMode ?? "default",
    maxTokens: merged.maxTokens,
    autoCompact: merged.autoCompact ?? true,
    compactThreshold: merged.compactThreshold ?? 0.8,
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
