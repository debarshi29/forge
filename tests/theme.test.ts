import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveUserSettings } from "../src/config/index.js";
import { renderDiff, renderMarkdown } from "../src/ui/format.js";
import { fg, findTheme, THEMES } from "../src/ui/theme.js";
import { tempDir } from "./helpers.js";

const HEX = /^#[0-9a-f]{6}$/i;

describe("themes", () => {
  it("are complete and uniquely named", () => {
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
    for (const t of THEMES) {
      for (const k of ["accent", "highlight", "border", "prompt", "muted", "success", "warning", "error", "code", "diffAdd", "diffDel"] as const) {
        expect(t[k], `${t.name}.${k}`).toMatch(HEX);
      }
      expect(t.spinner.length).toBeGreaterThan(1);
      expect(t.verbs.length).toBeGreaterThan(0);
    }
    expect(findTheme("OCEAN")?.name).toBe("ocean");
    expect(findTheme("nope")).toBeUndefined();
  });

  it("colour markdown code and diffs with the theme", () => {
    const ocean = findTheme("ocean")!;
    expect(fg("#ff0080", "x")).toBe("\x1b[38;2;255;0;128mx\x1b[39m");
    expect(renderMarkdown("use `npm`", ocean)).toContain(fg(ocean.code, "npm"));
    expect(renderDiff("@@ -1 +1 @@\n-old\n+new\n", 30, ocean)).toContain(fg(ocean.diffAdd, "+new"));
    // Without a palette, the basic ANSI colours are used as before.
    expect(renderMarkdown("use `npm`")).toContain("\x1b[36mnpm\x1b[39m");
  });

  it("persists the chosen theme next to other user settings", async () => {
    const home = await tempDir();
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ model: "anthropic:claude-opus-5-5" }));
    saveUserSettings({ theme: "synthwave" }, { FORGE_HOME: home });
    const saved = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"));
    expect(saved).toEqual({ model: "anthropic:claude-opus-5-5", theme: "synthwave" });
    expect(loadConfig(home, {}, { FORGE_HOME: home }).theme).toBe("synthwave");

    const fresh = await tempDir();
    saveUserSettings({ theme: "candy" }, { FORGE_HOME: path.join(fresh, "nested") });
    expect(loadConfig(fresh, {}, { FORGE_HOME: path.join(fresh, "nested") }).theme).toBe("candy");
  });
});
