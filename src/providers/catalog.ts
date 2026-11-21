import { resolveModel, type ProviderSettings, type ResolvedModel } from "./registry.js";

/** Model spec meaning "an installed Ollama model, chosen automatically". */
export const AUTO_OLLAMA = "ollama";

/**
 * resolveModel plus local discovery: "ollama" alone picks an installed model,
 * and Ollama models get their real context window unless settings set one.
 */
export async function resolveModelForUse(
  spec: string,
  settings: ProviderSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedModel> {
  const isOllama = spec === AUTO_OLLAMA || spec === `${AUTO_OLLAMA}:` || spec.startsWith(`${AUTO_OLLAMA}:`);
  if (!isOllama) return resolveModel(spec, settings);

  const baseURL = ollamaBaseURL(settings, env);
  const installed = await listOllamaModels(baseURL);
  let name = spec.slice(AUTO_OLLAMA.length + 1);
  if (!name) {
    if (installed === undefined) {
      throw new Error(`Ollama isn't reachable at ${baseURL.replace(/\/v1\/?$/, "")}. Start Ollama, or pick another model with --model (e.g. anthropic:claude-opus-5-5).`);
    }
    const pick = pickDefaultOllamaModel(installed);
    if (!pick) throw new Error("Ollama has no models installed. Run `ollama pull qwen2.5-coder` first, or pick another model with --model.");
    name = pick.name;
  }
  const info = installed?.find((m) => m.name === name || m.name === `${name}:latest`);
  const contextWindow = settings.ollama?.contextWindow ?? info?.contextLength;
  return resolveModel(`${AUTO_OLLAMA}:${name}`, { ...settings, ollama: { ...settings.ollama, baseURL, ...(contextWindow ? { contextWindow } : {}) } });
}

/** One entry in the /model picker. */
export interface ModelOption {
  spec: string;
  provider: string;
  label: string;
  /** False when credentials or the local server are missing. */
  available: boolean;
  /** Short detail: size, "needs GEMINI_API_KEY", ... */
  note?: string;
}

export interface OllamaModel {
  name: string;
  parameterSize?: string;
  contextLength?: number;
  tools: boolean;
}

export function ollamaBaseURL(settings: ProviderSettings = {}, env: NodeJS.ProcessEnv = process.env): string {
  return settings.ollama?.baseURL ?? (env.OLLAMA_HOST ? env.OLLAMA_HOST.replace(/\/?$/, "/v1") : "http://localhost:11434/v1");
}

/** Installed Ollama models, or undefined when Ollama isn't reachable. */
export async function listOllamaModels(baseURL: string, timeoutMs = 1500): Promise<OllamaModel[] | undefined> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      models?: Array<{ name: string; details?: { parameter_size?: string; context_length?: number }; capabilities?: string[] }>;
    };
    return (body.models ?? []).map((m) => ({
      name: m.name,
      parameterSize: m.details?.parameter_size,
      contextLength: m.details?.context_length,
      // Older Ollama versions don't report capabilities; assume tools work.
      tools: m.capabilities ? m.capabilities.includes("tools") : true,
    }));
  } catch {
    return undefined;
  }
}

/**
 * The model to use when none is configured: an installed Ollama model,
 * preferring ones that support tools and are tuned for code.
 */
export function pickDefaultOllamaModel(models: OllamaModel[]): OllamaModel | undefined {
  const score = (m: OllamaModel) => (m.tools ? 2 : 0) + (/coder|code/i.test(m.name) ? 1 : 0);
  return [...models].sort((a, b) => score(b) - score(a))[0];
}

const CLOUD: Array<{ provider: string; env: string[]; models: Array<[string, string]> }> = [
  {
    provider: "anthropic",
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    models: [
      ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
      ["claude-haiku-5-5", "Claude Haiku 5.5"],
      ["claude-fable-5-2", "Claude Fable 5.2"],
    ],
  },
  {
    provider: "gemini",
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    models: [
      ["gemini-2.5-pro", "Gemini 2.5 Pro"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash"],
    ],
  },
  {
    provider: "openai",
    env: ["OPENAI_API_KEY"],
    models: [
      ["gpt-5", "GPT-5"],
      ["gpt-5-mini", "GPT-5 mini"],
    ],
  },
];

/** Everything the picker can offer: local models first, then cloud presets. */
export async function listModelOptions(settings: ProviderSettings = {}, env: NodeJS.ProcessEnv = process.env): Promise<ModelOption[]> {
  const options: ModelOption[] = [];
  const ollama = await listOllamaModels(ollamaBaseURL(settings, env));
  if (ollama === undefined) {
    options.push({ spec: "ollama", provider: "ollama", label: "Ollama", available: false, note: "not running (start Ollama)" });
  } else if (ollama.length === 0) {
    options.push({ spec: "ollama", provider: "ollama", label: "Ollama", available: false, note: "no models (ollama pull qwen2.5-coder)" });
  } else {
    for (const m of ollama) {
      const bits = [m.parameterSize, m.contextLength ? `${Math.round(m.contextLength / 1024)}k ctx` : undefined, m.tools ? undefined : "no tool support"];
      options.push({ spec: `ollama:${m.name}`, provider: "ollama", label: m.name, available: true, note: bits.filter(Boolean).join(" · ") });
    }
  }
  for (const group of CLOUD) {
    const hasKey = group.env.some((k) => env[k]) || (group.provider === "gemini" && settings.gemini?.vertexai === true);
    for (const [id, label] of group.models) {
      options.push({
        spec: `${group.provider}:${id}`,
        provider: group.provider,
        label,
        available: hasKey,
        ...(hasKey ? {} : { note: `needs ${group.env[0]}` }),
      });
    }
  }
  return options;
}
