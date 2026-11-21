import { describe, expect, it } from "vitest";
import { parseCommand, matchCommands } from "../src/commands/index.js";
import { formatElapsed, formatTokens, preview, renderDiff, renderMarkdown } from "../src/ui/format.js";

const strip = (s: string) => s.replace(/\x1b\[\d+m/g, "");

describe("renderMarkdown", () => {
  it("renders headings, bullets, code and inline marks", () => {
    const out = renderMarkdown("# Title\n- one **bold**\n```ts\nconst x = 1;\n```\nuse `npm` *now*");
    expect(strip(out)).toBe("Title\n• one bold\n  const x = 1;\nuse npm now");
    expect(out).toContain("\x1b[1mbold\x1b[22m");
    expect(out).toContain("\x1b[36mnpm\x1b[39m");
  });

  it("does not treat list markers or arithmetic as italics", () => {
    expect(strip(renderMarkdown("a * b * c"))).toBe("a * b * c");
  });
});

describe("renderDiff", () => {
  it("drops headers and colours lines", () => {
    const patch = "Index: a\n===\n--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n";
    const out = renderDiff(patch);
    expect(strip(out)).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(out).toContain("\x1b[32m+new");
  });
});

describe("helpers", () => {
  it("previews and formats", () => {
    expect(preview("a\nb\nc\nd\ne", 2)).toBe("a\nb\n… 3 more lines");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatElapsed(75_000)).toBe("1m 15s");
  });
});

describe("slash commands", () => {
  it("parses and matches", () => {
    expect(parseCommand("/mode plan")).toMatchObject({ name: "mode", args: "plan" });
    expect(parseCommand("/quit")?.command?.name).toBe("exit");
    expect(parseCommand("/nope")?.command).toBeUndefined();
    expect(parseCommand("hello")).toBeUndefined();
    expect(matchCommands("/c").map((c) => c.name)).toEqual(["clear", "cost"]);
  });
});
