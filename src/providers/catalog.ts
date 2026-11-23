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
): Promise<ResolvedModel & { warning?: string }> {
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
  // A context length chosen with /context runs through a variant model that has it built in.
  const base = baseModelName(name);
  const info = installed?.find((m) => m.name === base || m.name === `${base}:latest`);
  const wanted = settings.ollama?.contextLengths?.[base];
  let variantWarning: string | undefined;
  if (wanted && installed !== undefined) {
    try {
      name = await ensureContextVariant(baseURL, base, wanted);
    } catch (err) {
      variantWarning = `Couldn't apply the ${Math.round(wanted / 1024)}k context to ${base} (${err instanceof Error ? err.message : String(err)}); using Ollama's default.`;
      name = base;
    }
  }
  // What the server actually runs with, which is often far below the model's maximum.
  const runtime = installed === undefined ? undefined : await ollamaRuntimeContext(baseURL, name, env);
  const fromServer = runtime ? Math.min(runtime.tokens, info?.contextLength ?? Infinity) : info?.contextLength;
  const contextWindow = settings.ollama?.contextWindow ?? fromServer;
  const resolved = resolveModel(`${AUTO_OLLAMA}:${name}`, { ...settings, ollama: { ...settings.ollama, baseURL, ...(contextWindow ? { contextWindow } : {}) } });
  let warning: string | undefined = variantWarning;
  if (!warning && !settings.ollama?.contextWindow && runtime && runtime.tokens < MIN_USEFUL_CONTEXT && (info?.contextLength ?? Infinity) > runtime.tokens) {
    const k = Math.round(runtime.tokens / 1024);
    warning =
      `Ollama runs ${name} with only a ${k}k-token context${runtime.source === "default" ? " (Ollama's default)" : ""}, and Forge's instructions and tools alone take about 4k, so the model will lose track of the conversation. ` +
      `Give it more room with /context 16k (just this model), or for every model: ${process.platform === "win32" ? "setx OLLAMA_CONTEXT_LENGTH 16384" : "export OLLAMA_CONTEXT_LENGTH=16384"}, then restart Ollama (and Forge).`;
  }
  return { ...resolved, ...(warning ? { warning } : {}) };
}

/** Ollama's context length when nothing configures it. */
export const OLLAMA_DEFAULT_CONTEXT = 4096;
/** Below this, Forge's system prompt and tools leave too little room to work. */
export const MIN_USEFUL_CONTEXT = 16_384;

/**
 * The context length the Ollama server uses for a model: the loaded model's
 * (from /api/ps), else OLLAMA_CONTEXT_LENGTH, else Ollama's default.
 */
export async function ollamaRuntimeContext(
  baseURL: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 1500,
): Promise<{ tokens: number; source: "loaded" | "model" | "env" | "default" }> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name: string; model?: string; context_length?: number }> };
      const m = body.models?.find((x) => x.name === name || x.model === name || x.name === `${name}:latest`);
      if (m?.context_length) return { tokens: m.context_length, source: "loaded" };
    }
  } catch {
    // fall through
  }
  const own = await ollamaModelNumCtx(baseURL, name, timeoutMs);
  if (own) return { tokens: own, source: "model" };
  const fromEnv = Number.parseInt(env.OLLAMA_CONTEXT_LENGTH ?? "", 10);
  if (fromEnv > 0) return { tokens: fromEnv, source: "env" };
  return { tokens: OLLAMA_DEFAULT_CONTEXT, source: "default" };
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
export function pickDefaultOllamaModel(all: OllamaModel[]): OllamaModel | undefined {
  const models = all.filter((m) => !isContextVariant(m.name));
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

/** Suffix of the variants Forge creates to pin a context length: "qwen2.5-coder:3b-ctx32k". */
const VARIANT_RE = /-ctx(\d+)k$/;

export function isContextVariant(name: string): boolean {
  return VARIANT_RE.test(name);
}

/** "qwen2.5-coder:3b-ctx32k" → "qwen2.5-coder:3b". */
export function baseModelName(name: string): string {
  return name.replace(VARIANT_RE, "");
}

export function contextVariantName(base: string, tokens: number): string {
  return `${base.includes(":") ? base : `${base}:latest`}-ctx${Math.round(tokens / 1024)}k`;
}

/** A model's own num_ctx parameter (from its Modelfile), if it has one. */
export async function ollamaModelNumCtx(baseURL: string, name: string, timeoutMs = 1500): Promise<number | undefined> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { parameters?: string };
    const m = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(body.parameters ?? "");
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make sure a variant of `base` with num_ctx = tokens exists, creating it if
 * needed. It shares the base model's weights, so it costs no disk space.
 */
export async function ensureContextVariant(baseURL: string, base: string, tokens: number): Promise<string> {
  const name = contextVariantName(base, tokens);
  if ((await ollamaModelNumCtx(baseURL, name)) === tokens) return name;
  const root = baseURL.replace(/\/v1\/?$/, "");
  const res = await fetch(`${root}/api/create`, {
    method: "POST",
    body: JSON.stringify({ model: name, from: base, parameters: { num_ctx: tokens }, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Ollama refused to create ${name}: ${(await res.text()).slice(0, 200)}`);
  return name;
}

/**
 * Load a model now and report how it runs: its context, and how much of it
 * fits in GPU memory (anything less than 100% runs partly on the CPU).
 */
export async function loadOllamaModel(baseURL: string, name: string): Promise<{ context?: number; gpuPercent?: number }> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  const res = await fetch(`${root}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model: name, prompt: "", keep_alive: "10m", stream: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama couldn't load ${name}: ${(await res.text()).slice(0, 200)}`);
  const ps = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(5000) });
  const body = (await ps.json()) as { models?: Array<{ name: string; size?: number; size_vram?: number; context_length?: number }> };
  const m = body.models?.find((x) => x.name === name);
  if (!m) return {};
  return {
    ...(m.context_length ? { context: m.context_length } : {}),
    ...(m.size ? { gpuPercent: Math.round(((m.size_vram ?? 0) / m.size) * 100) } : {}),
  };
}

/** Everything the picker can offer: local models first, then cloud presets. */
export async function listModelOptions(settings: ProviderSettings = {}, env: NodeJS.ProcessEnv = process.env): Promise<ModelOption[]> {
  const options: ModelOption[] = [];
  const ollama = await listOllamaModels(ollamaBaseURL(settings, env));
  if (ollama === undefined) {
    options.push({ spec: "ollama", provider: "ollama", label: "Ollama", available: false, note: "not running (start Ollama)" });
  } else if (ollama.length === 0) {
    options.push({ spec: "ollama", provider: "ollama", label: "Ollama", available: false, note: "no models (ollama pull qwen2.5-coder)" });
  } else {
    for (const m of ollama.filter((x) => !isContextVariant(x.name))) {
      const set = settings.ollama?.contextLengths?.[m.name];
      const ctx = set ? `${Math.round(set / 1024)}k ctx (set)` : m.contextLength ? `up to ${Math.round(m.contextLength / 1024)}k ctx` : undefined;
      const bits = [m.parameterSize, ctx, m.tools ? undefined : "no tool support"];
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
