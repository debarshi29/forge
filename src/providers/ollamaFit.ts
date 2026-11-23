import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Context sizes /context auto chooses between. */
export const CONTEXT_STEPS = [8192, 12_288, 16_384, 24_576, 32_768, 49_152, 65_536, 98_304, 131_072, 196_608, 262_144];

/** Room for the runtime, CUDA context and compute buffers on top of weights and KV cache. */
const OVERHEAD_BYTES = 700 * 1024 ** 2;

export interface ModelShape {
  /** Bytes of weights (the model file's size). */
  weights: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  /** The model's maximum context. */
  maxContext?: number;
}

export interface GpuMemory {
  total: number;
  free: number;
}

/** Bytes per KV-cache element for Ollama's OLLAMA_KV_CACHE_TYPE (quantized types need flash attention). */
export function kvBytesPerElement(env: NodeJS.ProcessEnv = process.env): number {
  const flash = /^(1|true|yes|on)$/i.test(env.OLLAMA_FLASH_ATTENTION ?? "");
  const type = (env.OLLAMA_KV_CACHE_TYPE ?? "f16").toLowerCase();
  if (!flash) return 2;
  if (type === "q8_0") return 34 / 32;
  if (type === "q4_0") return 18 / 32;
  return 2;
}

/** KV cache bytes for one token of context. */
export function kvBytesPerToken(shape: ModelShape, env: NodeJS.ProcessEnv = process.env): number {
  return 2 * shape.layers * shape.kvHeads * shape.headDim * kvBytesPerElement(env);
}

/** Estimated GPU memory to run the model with `tokens` of context. */
export function estimateVram(shape: ModelShape, tokens: number, env: NodeJS.ProcessEnv = process.env): number {
  return shape.weights + kvBytesPerToken(shape, env) * tokens + OVERHEAD_BYTES;
}

/** The largest step that fits in `available` bytes (at least the smallest step). */
export function largestFit(shape: ModelShape, available: number, env: NodeJS.ProcessEnv = process.env): number {
  const steps = CONTEXT_STEPS.filter((s) => !shape.maxContext || s <= shape.maxContext);
  let best = steps[0] ?? CONTEXT_STEPS[0]!;
  for (const s of steps) if (estimateVram(shape, s, env) <= available) best = s;
  return best;
}

/** The next smaller step, if any. */
export function stepDown(tokens: number): number | undefined {
  return [...CONTEXT_STEPS].reverse().find((s) => s < tokens);
}

/** Total and free memory of the first NVIDIA GPU, via nvidia-smi. Undefined elsewhere. */
export async function nvidiaMemory(): Promise<GpuMemory | undefined> {
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"], { timeout: 5000, windowsHide: true });
    const [total, free] = stdout.split("\n")[0]!.split(",").map((x) => Number(x.trim()) * 1024 ** 2);
    return total && free !== undefined && Number.isFinite(free) ? { total, free } : undefined;
  } catch {
    return undefined;
  }
}

/** Shape of an installed model, from /api/show and /api/tags. */
export async function ollamaModelShape(baseURL: string, name: string): Promise<ModelShape | undefined> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const [show, tags] = await Promise.all([
      fetch(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
    ]);
    const info = (show as { model_info?: Record<string, unknown> }).model_info ?? {};
    const arch = String(info["general.architecture"] ?? "");
    const num = (k: string) => {
      const v = info[`${arch}.${k}`];
      return typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? Math.max(...(v as number[])) : undefined;
    };
    const layers = num("block_count");
    const heads = num("attention.head_count");
    const kvHeads = num("attention.head_count_kv") ?? heads;
    const headDim = num("attention.key_length") ?? (num("embedding_length") && heads ? num("embedding_length")! / heads : undefined);
    const weights = (tags as { models?: Array<{ name: string; size?: number }> }).models?.find((m) => m.name === name || m.name === `${name}:latest`)?.size;
    if (!layers || !kvHeads || !headDim || !weights) return undefined;
    const maxContext = num("context_length");
    return { weights, layers, kvHeads, headDim, ...(maxContext ? { maxContext } : {}) };
  } catch {
    return undefined;
  }
}

/** GPU memory Ollama's loaded models hold (it frees them to load another). */
export async function ollamaLoadedVram(baseURL: string): Promise<number> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const body = (await (await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: Array<{ size_vram?: number }> };
    return (body.models ?? []).reduce((n, m) => n + (m.size_vram ?? 0), 0);
  } catch {
    return 0;
  }
}

export interface AutoContextPlan {
  tokens: number;
  /** How the size was chosen, for the report. */
  basis: string;
}

/**
 * First guess for /context auto: the largest context whose estimated
 * footprint fits in free GPU memory (plus what Ollama already holds). Without
 * GPU information it starts at 32k and lets the load test step it down.
 */
export async function planAutoContext(baseURL: string, base: string, env: NodeJS.ProcessEnv = process.env): Promise<AutoContextPlan> {
  const [shape, gpu, held] = await Promise.all([ollamaModelShape(baseURL, base), nvidiaMemory(), ollamaLoadedVram(baseURL)]);
  const cap = (t: number) => (shape?.maxContext ? Math.min(t, shape.maxContext) : t);
  if (!shape || !gpu) return { tokens: cap(32_768), basis: gpu ? "no model details; trying 32k" : "no GPU details; trying 32k" };
  const available = gpu.free + held;
  const tokens = largestFit(shape, available, env);
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  return {
    tokens,
    basis: `${gb(available)} GB of GPU memory free; the model needs ~${gb(shape.weights)} GB plus ~${gb(kvBytesPerToken(shape, env) * tokens)} GB of cache at ${Math.round(tokens / 1024)}k`,
  };
}
