import { AnthropicProvider, type AnthropicOptions } from "./anthropic.js";
import type { Provider } from "./types.js";

export const DEFAULT_MODEL = "anthropic:claude-opus-5-5";

export interface ResolvedModel {
  provider: Provider;
  /** Model id as the provider expects it, without the `provider:` prefix. */
  model: string;
}

export interface ProviderSettings {
  anthropic?: AnthropicOptions;
}

/**
 * Resolve "provider:model" (or a bare Claude model id) to an adapter.
 * More providers are registered in Milestone 4.
 */
export function resolveModel(spec: string, settings: ProviderSettings = {}): ResolvedModel {
  const idx = spec.indexOf(":");
  const providerName = idx === -1 ? "anthropic" : spec.slice(0, idx);
  const model = idx === -1 ? spec : spec.slice(idx + 1);
  if (!model) throw new Error(`Invalid model "${spec}"`);

  switch (providerName) {
    case "anthropic":
      return { provider: new AnthropicProvider(settings.anthropic), model };
    default:
      throw new Error(`Unknown provider "${providerName}" in model "${spec}". Supported: anthropic`);
  }
}
