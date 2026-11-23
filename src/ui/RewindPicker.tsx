import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Checkpoint } from "../agent/checkpoints.js";
import { useTheme } from "./theme.js";

interface Props {
  checkpoints: Checkpoint[];
  onPick(n: number, what: "both" | "chat" | "code"): void;
  onCancel(): void;
}

const PAGE = 8;
const ACTIONS = [
  { what: "both", label: "Restore code and conversation" },
  { what: "chat", label: "Restore conversation only (keep the files)" },
  { what: "code", label: "Restore code only (keep the conversation)" },
] as const;

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Pick a prompt to go back to (newest first), then what to restore. */
export function RewindPicker({ checkpoints, onPick, onCancel }: Props) {
  const t = useTheme();
  const items = [...checkpoints].reverse();
  const [i, setI] = useState(0);
  const [chosen, setChosen] = useState<Checkpoint | undefined>();
  const [a, setA] = useState(0);
  useInput((input, key) => {
    if (key.escape) return chosen ? setChosen(undefined) : onCancel();
    if (chosen) {
      if (key.upArrow) return setA((n) => Math.max(0, n - 1));
      if (key.downArrow) return setA((n) => Math.min(ACTIONS.length - 1, n + 1));
      const digit = Number(input);
      if (digit >= 1 && digit <= ACTIONS.length) return onPick(chosen.n, ACTIONS[digit - 1]!.what);
      if (key.return) return onPick(chosen.n, ACTIONS[a]!.what);
      return;
    }
    if (key.upArrow) return setI((n) => Math.max(0, n - 1));
    if (key.downArrow) return setI((n) => Math.min(items.length - 1, n + 1));
    if (key.return && items[i]) setChosen(items[i]);
  });
  if (chosen) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.highlight} paddingX={1}>
        <Text bold color={t.highlight}>
          Rewind to before: <Text color={undefined}>{chosen.prompt.split("\n")[0]!.slice(0, 60)}</Text>
        </Text>
        {chosen.files.size === 0 && checkpoints.every((c) => c.n < chosen.n || c.files.size === 0) && <Text dimColor>Forge hasn't changed any files since then.</Text>}
        {ACTIONS.map((x, k) => (
          <Text key={x.what} color={k === a ? t.highlight : undefined}>
            {k === a ? "❯ " : "  "}
            {k + 1}. {x.label}
          </Text>
        ))}
        <Text dimColor>Changes made by shell commands aren't undone. Esc to go back.</Text>
      </Box>
    );
  }
  const start = Math.max(0, Math.min(i - Math.floor(PAGE / 2), items.length - PAGE));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.highlight} paddingX={1}>
      <Text bold color={t.highlight}>
        Rewind <Text dimColor>(↑/↓, Enter, Esc to cancel)</Text>
      </Text>
      {items.length === 0 && <Text dimColor>No checkpoints yet: each prompt you send makes one.</Text>}
      {items.slice(start, start + PAGE).map((c, k) => {
        const selected = start + k === i;
        return (
          <Text key={c.n} color={selected ? t.highlight : undefined}>
            {selected ? "❯ " : "  "}
            {String(c.n).padStart(3)}. {c.prompt.split("\n")[0]!.slice(0, 56).padEnd(56)}{" "}
            <Text dimColor>
              {ago(c.at).padStart(7)}
              {c.files.size ? ` · ${c.files.size} file${c.files.size === 1 ? "" : "s"}` : ""}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
