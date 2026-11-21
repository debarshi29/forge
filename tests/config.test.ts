import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { tempDir } from "./helpers.js";

describe("config", () => {
  it("merges user < project < env < flags", async () => {
    const home = await tempDir();
    const root = await tempDir();
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ model: "a", effort: "low", permissionMode: "acceptEdits" }));
    await fs.mkdir(path.join(root, ".forge"));
    await fs.writeFile(path.join(root, ".forge", "settings.json"), JSON.stringify({ model: "b", effort: "max" }));

    const env = { FORGE_HOME: home };
    expect(loadConfig(root, {}, env)).toMatchObject({ model: "b", effort: "max", permissionMode: "acceptEdits" });
    expect(loadConfig(root, {}, { ...env, FORGE_MODEL: "c" }).model).toBe("c");
    expect(loadConfig(root, { model: "d", effort: undefined }, { ...env, FORGE_MODEL: "c" })).toMatchObject({ model: "d", effort: "max" });
  });

  it("adds up permission rules and hooks from user and project settings", async () => {
    const home = await tempDir();
    const root = await tempDir();
    await fs.writeFile(
      path.join(home, "settings.json"),
      JSON.stringify({ permissions: { deny: ["read(.env)"] }, hooks: { Stop: [{ command: "a" }] } }),
    );
    await fs.mkdir(path.join(root, ".forge"));
    await fs.writeFile(
      path.join(root, ".forge", "settings.json"),
      JSON.stringify({ permissions: { allow: ["bash(npm test:*)"], deny: ["write(.git/**)"] }, hooks: { Stop: [{ command: "b" }], PreToolUse: [{ matcher: "bash", command: "c" }] } }),
    );
    const c = loadConfig(root, {}, { FORGE_HOME: home });
    expect(c.permissions).toEqual({ allow: ["bash(npm test:*)"], deny: ["read(.env)", "write(.git/**)"], ask: [] });
    expect(c.hooks.Stop?.map((h) => h.command)).toEqual(["a", "b"]);
    expect(c.hooks.PreToolUse).toEqual([{ matcher: "bash", command: "c" }]);
  });

  it("rejects malformed permission rules", async () => {
    const home = await tempDir();
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ permissions: { allow: ["bash(git"] } }));
    expect(() => loadConfig(home, {}, { FORGE_HOME: home })).toThrow(/permissions\.allow\.0: Invalid permission rule/);
  });

  it("reports invalid settings", async () => {
    const home = await tempDir();
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ effort: "huge" }));
    expect(() => loadConfig(home, {}, { FORGE_HOME: home })).toThrow(/effort/);
  });

  it("defaults to an automatically chosen Ollama model", async () => {
    const home = await tempDir();
    expect(loadConfig(home, {}, { FORGE_HOME: home }).model).toBe("ollama");
  });
});
