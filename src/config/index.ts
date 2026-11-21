import { readFileSync } from "node:fs";
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
    anthropic: z.object({ baseURL: z.string(), fallbacks: z.boolean() }).partial(),
  })
  .partial();

export type Settings = z.infer<typeof SettingsSchema>;

export interface Config {
  model: string;
  effort: NonNullable<Settings["effort"]>;
  permissionMode: PermissionMode;
  maxTokens?: number;
  anthropic: NonNullable<Settings["anthropic"]>;
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
      merged = { ...merged, ...s, anthropic: { ...merged.anthropic, ...s.anthropic } };
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
    anthropic: merged.anthropic ?? {},
    sources,
  };
}
