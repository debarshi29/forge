import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listModelOptions, pickDefaultOllamaModel, resolveModelForUse } from "../src/providers/catalog.js";

let server: http.Server;
let baseURL: string;
let tags: unknown = { models: [] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(tags));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const installed = {
  models: [
    { name: "llama3.2:1b", details: { parameter_size: "1.2B", context_length: 131072 }, capabilities: ["completion", "tools"] },
    { name: "qwen2.5-coder:3b", details: { parameter_size: "3.1B", context_length: 32768 }, capabilities: ["completion", "tools"] },
    { name: "codegemma:2b", details: { parameter_size: "2B" }, capabilities: ["completion"] },
  ],
};

describe("default Ollama model", () => {
  it("prefers tool-capable coding models", () => {
    expect(
      pickDefaultOllamaModel([
        { name: "codegemma:2b", tools: false },
        { name: "llama3.2:1b", tools: true },
        { name: "qwen2.5-coder:3b", tools: true },
      ])?.name,
    ).toBe("qwen2.5-coder:3b");
    expect(pickDefaultOllamaModel([])).toBeUndefined();
  });

  it('resolves "ollama" to an installed model with its real context window', async () => {
    tags = installed;
    const r = await resolveModelForUse("ollama", { ollama: { baseURL } });
    expect(r.spec).toBe("ollama:qwen2.5-coder:3b");
    expect(r.provider.capabilities(r.model).contextWindow).toBe(32768);

    const explicit = await resolveModelForUse("ollama:llama3.2:1b", { ollama: { baseURL } });
    expect(explicit.provider.capabilities(explicit.model).contextWindow).toBe(131072);

    const override = await resolveModelForUse("ollama", { ollama: { baseURL, contextWindow: 8000 } });
    expect(override.provider.capabilities(override.model).contextWindow).toBe(8000);
  });

  it("explains what to do when Ollama is missing or empty", async () => {
    tags = { models: [] };
    await expect(resolveModelForUse("ollama", { ollama: { baseURL } })).rejects.toThrow(/ollama pull/);
    await expect(resolveModelForUse("ollama", { ollama: { baseURL: "http://127.0.0.1:9/v1" } })).rejects.toThrow(/isn't reachable/);
    // Cloud specs don't touch Ollama at all.
    expect((await resolveModelForUse("anthropic:claude-opus-5-5")).spec).toBe("anthropic:claude-opus-5-5");
  });
});

describe("model picker options", () => {
  it("lists installed local models, then cloud models marked by key availability", async () => {
    tags = installed;
    const opts = await listModelOptions({ ollama: { baseURL } }, { ANTHROPIC_API_KEY: "x" });
    expect(opts.filter((o) => o.provider === "ollama").map((o) => [o.spec, o.available])).toEqual([
      ["ollama:llama3.2:1b", true],
      ["ollama:qwen2.5-coder:3b", true],
      ["ollama:codegemma:2b", true],
    ]);
    expect(opts.find((o) => o.spec === "ollama:qwen2.5-coder:3b")?.note).toBe("3.1B · 32k ctx");
    expect(opts.find((o) => o.spec === "ollama:codegemma:2b")?.note).toContain("no tool support");
    expect(opts.find((o) => o.spec === "anthropic:claude-opus-5-5")).toMatchObject({ available: true });
    expect(opts.find((o) => o.spec === "gemini:gemini-2.5-pro")).toMatchObject({ available: false, note: "needs GEMINI_API_KEY" });
  });

  it("shows Ollama as unavailable when it isn't running", async () => {
    const opts = await listModelOptions({ ollama: { baseURL: "http://127.0.0.1:9/v1" } }, {});
    expect(opts[0]).toMatchObject({ provider: "ollama", available: false });
  });
});
