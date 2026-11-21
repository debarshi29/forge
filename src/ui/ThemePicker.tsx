import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { THEMES, type Theme } from "./theme.js";

interface Props {
  current: string;
  /** Called as the highlight moves, so the whole UI can preview the theme. */
  onPreview(theme: Theme): void;
  onPick(theme: Theme): void;
  onCancel(): void;
}

function Swatch({ theme }: { theme: Theme }) {
  return (
    <Text>
      {[theme.accent, theme.highlight, theme.success, theme.warning, theme.error].map((c, i) => (
        <Text key={i} color={c}>
          ██
        </Text>
      ))}
    </Text>
  );
}

/** A tiny mock transcript drawn in the highlighted theme. */
function Sample({ theme }: { theme: Theme }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
      <Text>
        <Text bold color={theme.accent}>
          {theme.icon} forge
        </Text>
        <Text dimColor> · preview</Text>
      </Text>
      <Text>
        <Text color={theme.prompt}>{"> "}</Text>fix the failing test in <Text color={theme.code}>parser.ts</Text>
      </Text>
      <Text>
        <Text color={theme.success}>● </Text>
        <Text bold>edit</Text> <Text dimColor>src/parser.ts</Text>
      </Text>
      <Text color={theme.diffDel}>{"  -  return tokens[i + 1];"}</Text>
      <Text color={theme.diffAdd}>{"  +  return tokens[i];"}</Text>
      <Text>
        <Text color={theme.accent}>{theme.spinner[frame % theme.spinner.length]} </Text>
        <Text dimColor>{theme.verbs[Math.floor(frame / 12) % theme.verbs.length]}… (esc to interrupt)</Text>
      </Text>
    </Box>
  );
}

export function ThemePicker({ current, onPreview, onPick, onCancel }: Props) {
  const [i, setI] = useState(() => Math.max(0, THEMES.findIndex((t) => t.name === current)));
  const selected = THEMES[i]!;

  useEffect(() => {
    onPreview(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setI((n) => (n + THEMES.length - 1) % THEMES.length);
    if (key.downArrow || key.tab) return setI((n) => (n + 1) % THEMES.length);
    if (key.return) onPick(selected);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={selected.accent} paddingX={1}>
      <Text bold color={selected.accent}>
        Pick a theme <Text dimColor>(↑/↓ to preview, Enter to keep, Esc to cancel)</Text>
      </Text>
      {THEMES.map((t, k) => {
        const isSel = k === i;
        return (
          <Text key={t.name} color={isSel ? t.highlight : undefined}>
            {isSel ? "❯ " : "  "}
            <Swatch theme={t} /> {t.label.padEnd(10)}
            <Text dimColor>{t.description}</Text>
            {t.name === current ? <Text color={t.success}> ✓</Text> : null}
          </Text>
        );
      })}
      <Sample theme={selected} />
    </Box>
  );
}
