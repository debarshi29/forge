import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { filterMouse } from "../src/ui/mouseStdin.js";
import { effectLine, faceFor, findPet, isMouseInput, parseMouse, PETS, type Mood } from "../src/ui/pets.js";

const MOODS: Mood[] = ["idle", "blink", "happy", "love", "dizzy", "party", "sleep", "work", "done", "oops"];

describe("pets", () => {
  it("draw three lines in every mood and frame", () => {
    for (const p of PETS) {
      for (const mood of MOODS) {
        for (const frame of [0, 1]) {
          const lines = p.draw(faceFor(mood, frame), frame);
          expect(lines, `${p.name}/${mood}`).toHaveLength(3);
          for (const l of lines) expect(l.length).toBeLessThanOrEqual(12);
        }
      }
      expect(p.quips.length).toBeGreaterThan(2);
    }
    expect(new Set(PETS.map((p) => p.name)).size).toBe(PETS.length);
  });

  it("find pets by name or label", () => {
    expect(findPet("CAT")?.name).toBe("cat");
    expect(findPet("slime")?.name).toBe("blob");
    expect(findPet("none")).toBeUndefined();
  });

  it("parse SGR mouse reports", () => {
    expect(parseMouse("[<0;12;5M")).toEqual({ button: 0, x: 12, y: 5, press: true });
    expect(parseMouse("[<0;12;5m")).toMatchObject({ press: false });
    expect(parseMouse("[<64;1;1M")).toMatchObject({ button: 64 }); // wheel
    expect(parseMouse("hello")).toBeUndefined();
    expect(isMouseInput("[<0;3;4M")).toBe(true);
    expect(isMouseInput("[3~")).toBe(false);
  });

  it("filter clicks out of stdin and pass everything else through", async () => {
    const src = new PassThrough();
    const { stdin, mouse, dispose } = filterMouse(src);
    const clicks: unknown[] = [];
    const all: unknown[] = [];
    mouse.on("click", (e) => clicks.push(e));
    mouse.on("mouse", (e) => all.push(e));
    const got: string[] = [];
    stdin.on("data", (d: Buffer) => got.push(d.toString()));

    src.write("hi\x1b[<0;10;5Mthere");
    src.write("\x1b[<0;10;5m"); // release
    src.write("\x1b[<64;1;1M"); // wheel
    src.write("\x1b[A"); // up arrow, not a mouse report
    await new Promise((r) => setTimeout(r, 20));
    expect(got.join("")).toBe("hithere\x1b[A");
    expect(clicks).toEqual([{ button: 0, x: 10, y: 5, press: true }]);
    expect(all).toHaveLength(3);
    dispose();
  });

  it("animate effects", () => {
    expect(effectLine("idle", 0)).toBe("");
    expect(effectLine("party", 1)).toMatch(/[✦✧★*•]/);
    expect(effectLine("sleep", 1)).toContain("Z");
    expect(effectLine("happy", 3)).not.toBe(effectLine("happy", 4));
  });
});
