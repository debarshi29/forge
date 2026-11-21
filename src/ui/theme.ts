import { createContext, useContext } from "react";

/** Colours are hex strings (Ink renders them as true colour, or the nearest the terminal supports). */
export interface Theme {
  name: string;
  label: string;
  description: string;
  /** Main brand colour: banner, spinner, headings. */
  accent: string;
  /** Selection and interactive highlights. */
  highlight: string;
  /** Borders of the input box and dialogs. */
  border: string;
  /** The "> " in front of user messages and the prompt. */
  prompt: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  /** Inline and fenced code in Markdown. */
  code: string;
  diffAdd: string;
  diffDel: string;
  /** Spinner frames, cycled while the model works. */
  spinner: string[];
  /** Verbs shown while thinking ("Forging…"). */
  verbs: string[];
  /** Glyph shown before the product name in the banner. */
  icon: string;
}

export const THEMES: Theme[] = [
  {
    name: "forge",
    label: "Forge",
    description: "Molten magenta and steel — the default",
    accent: "#d946ef",
    highlight: "#22d3ee",
    border: "#6b7280",
    prompt: "#22d3ee",
    muted: "#9ca3af",
    success: "#22c55e",
    warning: "#eab308",
    error: "#ef4444",
    code: "#22d3ee",
    diffAdd: "#22c55e",
    diffDel: "#ef4444",
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    verbs: ["Forging", "Hammering", "Tempering", "Smelting", "Annealing", "Quenching"],
    icon: "⚒",
  },
  {
    name: "ember",
    label: "Ember",
    description: "Glowing coals: orange, amber and red",
    accent: "#f97316",
    highlight: "#fbbf24",
    border: "#78350f",
    prompt: "#fb923c",
    muted: "#a8a29e",
    success: "#84cc16",
    warning: "#fbbf24",
    error: "#dc2626",
    code: "#fdba74",
    diffAdd: "#84cc16",
    diffDel: "#f43f5e",
    spinner: ["·", "•", "●", "•"],
    verbs: ["Stoking", "Kindling", "Blazing", "Smouldering", "Igniting"],
    icon: "🔥",
  },
  {
    name: "ocean",
    label: "Ocean",
    description: "Deep blues and sea-glass teal",
    accent: "#3b82f6",
    highlight: "#2dd4bf",
    border: "#1e3a8a",
    prompt: "#38bdf8",
    muted: "#94a3b8",
    success: "#2dd4bf",
    warning: "#facc15",
    error: "#fb7185",
    code: "#7dd3fc",
    diffAdd: "#2dd4bf",
    diffDel: "#fb7185",
    spinner: ["◜", "◠", "◝", "◞", "◡", "◟"],
    verbs: ["Diving", "Surfing", "Drifting", "Sounding the depths", "Charting"],
    icon: "🌊",
  },
  {
    name: "forest",
    label: "Forest",
    description: "Moss, pine and sunlight through leaves",
    accent: "#16a34a",
    highlight: "#a3e635",
    border: "#14532d",
    prompt: "#4ade80",
    muted: "#a8a29e",
    success: "#4ade80",
    warning: "#facc15",
    error: "#f87171",
    code: "#bef264",
    diffAdd: "#4ade80",
    diffDel: "#f87171",
    spinner: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
    verbs: ["Growing", "Branching", "Foraging", "Taking root", "Photosynthesising"],
    icon: "🌲",
  },
  {
    name: "synthwave",
    label: "Synthwave",
    description: "Hot pink and neon cyan, straight out of 1986",
    accent: "#ff2bd6",
    highlight: "#00f0ff",
    border: "#7c3aed",
    prompt: "#ff2bd6",
    muted: "#a78bfa",
    success: "#00ffa3",
    warning: "#ffe14d",
    error: "#ff4d6d",
    code: "#00f0ff",
    diffAdd: "#00ffa3",
    diffDel: "#ff4d6d",
    spinner: ["▖", "▘", "▝", "▗"],
    verbs: ["Synthesizing", "Overdriving", "Rendering the grid", "Cruising", "Arpeggiating"],
    icon: "🌆",
  },
  {
    name: "candy",
    label: "Candy",
    description: "Soft pastels, extra sparkle",
    accent: "#f472b6",
    highlight: "#a78bfa",
    border: "#f9a8d4",
    prompt: "#c084fc",
    muted: "#c4b5fd",
    success: "#86efac",
    warning: "#fde68a",
    error: "#fda4af",
    code: "#93c5fd",
    diffAdd: "#86efac",
    diffDel: "#fda4af",
    spinner: ["✶", "✸", "✹", "✺", "✹", "✷"],
    verbs: ["Sprinkling", "Sparkling", "Whisking", "Frosting", "Sugar-coating"],
    icon: "🍬",
  },
  {
    name: "matrix",
    label: "Matrix",
    description: "Green phosphor on black",
    accent: "#22c55e",
    highlight: "#86efac",
    border: "#166534",
    prompt: "#22c55e",
    muted: "#4d7c0f",
    success: "#86efac",
    warning: "#bef264",
    error: "#f87171",
    code: "#4ade80",
    diffAdd: "#86efac",
    diffDel: "#f87171",
    spinner: ["ｱ", "ｲ", "ｳ", "ｴ", "ｵ", "ｶ", "ｷ", "ｸ"],
    verbs: ["Decoding", "Following the white rabbit", "Bending the spoon", "Compiling reality"],
    icon: "▣",
  },
  {
    name: "mono",
    label: "Mono",
    description: "Quiet greyscale, for focus",
    accent: "#e5e7eb",
    highlight: "#ffffff",
    border: "#4b5563",
    prompt: "#d1d5db",
    muted: "#9ca3af",
    success: "#d1d5db",
    warning: "#e5e7eb",
    error: "#f3f4f6",
    code: "#e5e7eb",
    diffAdd: "#d1d5db",
    diffDel: "#6b7280",
    spinner: ["|", "/", "-", "\\"],
    verbs: ["Thinking", "Working", "Considering"],
    icon: "◆",
  },
];

export const DEFAULT_THEME = THEMES[0]!;

export function findTheme(name: string | undefined): Theme | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return THEMES.find((t) => t.name === n);
}

/** ANSI true-colour foreground for a hex colour (for text built as strings). */
export function fg(hex: string, s: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return s;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16));
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export const ThemeContext = createContext<Theme>(DEFAULT_THEME);
export const useTheme = (): Theme => useContext(ThemeContext);
