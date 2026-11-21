import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { effectLine, faceFor, PETS, type PetKind } from "./pets.js";
import { useTheme } from "./theme.js";

interface Props {
  current?: string;
  /** null adopts no pet (hides it). */
  onPick(kind: PetKind | null): void;
  onCancel(): void;
}

/** Every pet side by side, the highlighted one bouncing with joy. */
export function PetPicker({ current, onPick, onCancel }: Props) {
  const t = useTheme();
  const options: Array<PetKind | null> = [...PETS, null];
  const [i, setI] = useState(() => Math.max(0, PETS.findIndex((p) => p.name === current)));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.leftArrow || key.upArrow) return setI((n) => (n + options.length - 1) % options.length);
    if (key.rightArrow || key.downArrow || key.tab) return setI((n) => (n + 1) % options.length);
    if (key.return) onPick(options[i] ?? null);
  });

  const sel = options[i];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1}>
      <Text bold color={t.accent}>
        Adopt a pet <Text dimColor>(←/→ to choose, Enter to adopt, Esc to cancel)</Text>
      </Text>
      <Box marginTop={1}>
        {PETS.map((p, k) => {
          const isSel = k === i;
          const mood = isSel ? (Math.floor(tick / 4) % 2 ? "happy" : "love") : tick % 20 === k * 3 ? "blink" : "idle";
          const lines = p.draw(faceFor(mood, tick), isSel ? tick % 2 : 0);
          return (
            <Box key={p.name} flexDirection="column" marginRight={2}>
              <Text color={t.warning}>{isSel ? effectLine(mood, tick, 9) || " " : " "}</Text>
              {lines.map((l, j) => (
                <Text key={j} color={isSel ? t.accent : t.muted}>
                  {l}
                </Text>
              ))}
              <Text color={isSel ? t.highlight : t.muted} bold={isSel}>
                {(isSel ? "❯ " : "  ") + p.label}
              </Text>
            </Box>
          );
        })}
        <Box flexDirection="column" justifyContent="flex-end">
          <Text color={sel === null ? t.highlight : t.muted} bold={sel === null}>
            {(sel === null ? "❯ " : "  ") + "No pet"}
          </Text>
        </Box>
      </Box>
      <Text dimColor>
        {sel
          ? `${sel.defaultName} the ${sel.label.toLowerCase()} · rename later with /pet name <name>`
          : "Hide the pet. You can adopt one again with /pets."}
      </Text>
    </Box>
  );
}
