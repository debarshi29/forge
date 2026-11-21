/** Desk pets: tiny animated companions that react to clicks and to what Forge is doing. */

export type Mood = "idle" | "blink" | "happy" | "love" | "dizzy" | "party" | "sleep" | "work" | "done" | "oops";

export interface Face {
  /** Left and right eye. */
  eyes: [string, string];
  mouth: string;
}

/** The face for a mood; "work" eyes dart left and right with the tick. */
export function faceFor(mood: Mood, tick = 0): Face {
  if (mood === "work") return { eyes: tick % 4 < 2 ? ["•", " "] : [" ", "•"], mouth: "." };
  return FACES[mood];
}

const FACES: Record<Mood, Face> = {
  idle: { eyes: ["o", "o"], mouth: "." },
  blink: { eyes: ["-", "-"], mouth: "." },
  happy: { eyes: ["^", "^"], mouth: "w" },
  love: { eyes: ["♥", "♥"], mouth: "w" },
  dizzy: { eyes: ["@", "@"], mouth: "~" },
  party: { eyes: ["★", "★"], mouth: "D" },
  sleep: { eyes: ["-", "-"], mouth: "_" },
  work: { eyes: ["•", "•"], mouth: "." },
  done: { eyes: ["^", "^"], mouth: "v" },
  oops: { eyes: ["x", "x"], mouth: "o" },
};

export interface PetKind {
  name: string;
  label: string;
  /** Default name for a newly adopted pet. */
  defaultName: string;
  /** Three lines of body; `frame` alternates 0/1 for wiggles. */
  draw(face: Face, frame: number): [string, string, string];
  /** Things it says when poked. */
  quips: string[];
}

export const PETS: PetKind[] = [
  {
    name: "cat",
    label: "Cat",
    defaultName: "Mochi",
    draw: ({ eyes: [l, r], mouth }, f) => [" /\\_/\\  ", `( ${l}${mouth}${r} ) `, f ? " > ^ <~ " : " > ^ < ~"],
    quips: ["purr…", "mrrp?", "*kneads keyboard*", "feed me bugs", "*knocks mug off desk*", "meow!"],
  },
  {
    name: "dog",
    label: "Dog",
    defaultName: "Biscuit",
    draw: ({ eyes: [l, r], mouth }, f) => [" /^ ^\\  ", `( ${l}${mouth}${r} )${f ? "/" : "~"}`, ' (")(")  '],
    quips: ["woof!", "good code!", "*wags furiously*", "is that a ball?", "*brings you a stick*", "best human!"],
  },
  {
    name: "octopus",
    label: "Octopus",
    defaultName: "Inky",
    draw: ({ eyes: [l, r], mouth }, f) => ["  .---.  ", ` ( ${l}${mouth}${r} ) `, f ? " /)/)(\\(\\ " : " (\\(\\)/)/ "],
    quips: ["blub", "eight arms, zero bugs", "*squirts ink*", "hug? hug.", "*juggles semicolons*"],
  },
  {
    name: "robot",
    label: "Robot",
    defaultName: "Bolt",
    draw: ({ eyes: [l, r], mouth }, f) => [f ? "  _|_   " : "  _*_   ", ` [${l} ${mouth} ${r}]`, "  /|_|\\ "],
    quips: ["beep boop", "PAT RECEIVED", "01101000 01101001", "*whirrs happily*", "recalibrating joy…"],
  },
  {
    name: "ghost",
    label: "Ghost",
    defaultName: "Boo",
    draw: ({ eyes: [l, r], mouth }, f) => ["  .--.   ", ` ( ${l}${mouth}${r} ) `, f ? "  )/\\/(  " : "  (\\/\\)  "],
    quips: ["boo!", "*floats closer*", "spooky types", "I live in /dev/null", "whooo's there?"],
  },
  {
    name: "blob",
    label: "Slime",
    defaultName: "Gloop",
    draw: ({ eyes: [l, r], mouth }, f) => (f ? ["   __    ", " (" + l + mouth + r + ")   ", "(_____)  "] : ["         ", " _(" + l + mouth + r + ")_  ", "(_______) "]),
    quips: ["blorp", "*jiggles*", "squish!", "*absorbs a bug*", "I am mostly semicolon"],
  },
];

export function findPet(name: string | undefined): PetKind | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return PETS.find((p) => p.name === n || p.label.toLowerCase() === n);
}

/** Effects drawn on the line above the pet, by mood and animation tick. */
export function effectLine(mood: Mood, tick: number, width = 12): string {
  const sprinkle = (chars: string[], density: number) =>
    Array.from({ length: width }, (_, i) => ((i * 7 + tick * 3) % density === 0 ? chars[(i + tick) % chars.length]! : " ")).join("");
  switch (mood) {
    case "love":
    case "happy":
      return sprinkle(["♥", "♡"], 5);
    case "party":
      return sprinkle(["✦", "✧", "★", "*", "•"], 2);
    case "dizzy":
      return " ".repeat(tick % 4) + ["@", "°", "*", "°"][tick % 4]! + "  ~ ";
    case "sleep":
      return " ".repeat(8 + (tick % 3)) + ["z", "Z", "z"][tick % 3]!;
    case "done":
      return "   ✓ ✓ ✓";
    case "oops":
      return "   ! ? !";
    default:
      return "";
  }
}

/** Mouse click from SGR mouse reporting, as Ink's useInput delivers it ("[<b;x;yM"). */
export function parseMouse(input: string): { button: number; x: number; y: number; press: boolean } | undefined {
  const m = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!m) return undefined;
  return { button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === "M" };
}

/** True for any mouse report, so text inputs can ignore it. */
export function isMouseInput(input: string): boolean {
  return /\[<\d+;\d+;\d+[Mm]/.test(input);
}

/** Escape codes to turn terminal mouse-click reporting on/off (button events, SGR encoding). */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
