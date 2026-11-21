import { AnthropicProvider, type AnthropicOptions } from "./anthropic.js";
import { GeminiProvider, type GeminiOptions } from "./gemini.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

/** "ollama" = an installed Ollama model, picked at startup (see catalog.ts). */
export const DEFAULT_MODEL = "ollama";
export const PROVIDERS = ["anthropic", "openai", "gemini", "ollama", "lmstudio"] as const;

export interface ResolvedModel {
  provider: Provider;
  /** Model id as the provider expects it, without the `provider:` prefix. */
  model: string;
  /** Canonical "provider:model" spec. */
  spec: string;
}

export interface ProviderSettings {
  anthropic?: AnthropicOptions;
  openai?: { apiKey?: string; baseURL?: string; contextWindow?: number };
  gemini?: GeminiOptions;
  ollama?: { baseURL?: string; contextWindow?: number };
  lmstudio?: { baseURL?: string; contextWindow?: number };
}

const ALIASES: Record<string, string> = { google: "gemini", claude: "anthropic" };

/**
 * Resolve "provider:model" (or a bare model id, guessed from its name) to an
 * adapter. Providers are created per call, which is cheap; the agent keeps one.
 */
export function resolveModel(spec: string, settings: ProviderSettings = {}): ResolvedModel {
  const idx = spec.indexOf(":");
  let providerName = idx === -1 ? guessProvider(spec) : spec.slice(0, idx).toLowerCase();
  providerName = ALIASES[providerName] ?? providerName;
  const model = idx === -1 ? spec : spec.slice(idx + 1);
  if (!model) throw new Error(`Invalid model "${spec}"`);
  const canonical = `${providerName}:${model}`;

  switch (providerName) {
    case "anthropic":
      return { provider: new AnthropicProvider(settings.anthropic), model, spec: canonical };
    case "openai":
      return { provider: new OpenAIProvider({ name: "openai", ...settings.openai }), model, spec: canonical };
    case "gemini":
      return { provider: new GeminiProvider(settings.gemini), model, spec: canonical };
    case "ollama":
      return {
        provider: new OpenAIProvider({
          name: "ollama",
          compat: true,
          baseURL: settings.ollama?.baseURL ?? process.env.OLLAMA_HOST?.replace(/\/?$/, "/v1") ?? "http://localhost:11434/v1",
          contextWindow: settings.ollama?.contextWindow,
        }),
        model,
        spec: canonical,
      };
    case "lmstudio":
      return {
        provider: new OpenAIProvider({
          name: "lmstudio",
          compat: true,
          baseURL: settings.lmstudio?.baseURL ?? "http://localhost:1234/v1",
          contextWindow: settings.lmstudio?.contextWindow,
        }),
        model,
        spec: canonical,
      };
    default:
      throw new Error(`Unknown provider "${providerName}" in model "${spec}". Supported: ${PROVIDERS.join(", ")}`);
  }
}

function guessProvider(model: string): string {
  if (/^claude-/.test(model)) return "anthropic";
  if (/^gemini-/.test(model)) return "gemini";
  if (/^(gpt-|o\d)/.test(model)) return "openai";
  throw new Error(`Can't tell which provider serves "${model}"; use provider:model, e.g. ollama:${model}`);
}
