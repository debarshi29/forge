import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/index.js";
import { DEFAULT_MODEL } from "../providers/registry.js";

const SettingsSchema = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    permissionMode: z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]),
    maxTokens: z.number().int().positive(),
    theme: z.string(),
    pet: z.string(),
    petName: z.string(),
    /** Pet reacts to mouse clicks. Off by default: it disables normal drag-to-select. */
    petMouse: z.boolean(),
    anthropic: z.object({ baseURL: z.string(), fallbacks: z.boolean() }).partial(),
    openai: z.object({ baseURL: z.string(), contextWindow: z.number().int().positive() }).partial(),
    gemini: z.object({ vertexai: z.boolean(), project: z.string(), location: z.string() }).partial(),
    ollama: z.object({ baseURL: z.string(), contextWindow: z.number().int().positive() }).partial(),
    lmstudio: z.object({ baseURL: z.string(), contextWindow: z.number().int().positive() }).partial(),
  })
  .partial();

const PROVIDER_KEYS = ["anthropic", "openai", "gemini", "ollama", "lmstudio"] as const;

export type Settings = z.infer<typeof SettingsSchema>;

export interface Config {
  model: string;
  effort: NonNullable<Settings["effort"]>;
  permissionMode: PermissionMode;
  maxTokens?: number;
  theme?: string;
  pet?: string;
  petName?: string;
  petMouse?: boolean;
  anthropic: NonNullable<Settings["anthropic"]>;
  openai: NonNullable<Settings["openai"]>;
  gemini: NonNullable<Settings["gemini"]>;
  ollama: NonNullable<Settings["ollama"]>;
  lmstudio: NonNullable<Settings["lmstudio"]>;
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
    theme: merged.theme,
    pet: merged.pet,
    petName: merged.petName,
    petMouse: merged.petMouse,
    anthropic: merged.anthropic ?? {},
    openai: merged.openai ?? {},
    gemini: merged.gemini ?? {},
    ollama: merged.ollama ?? {},
    lmstudio: merged.lmstudio ?? {},
    sources,
  };
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
