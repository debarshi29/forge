import { Box, Text, useInput } from "ink";
import { useTheme } from "./theme.js";
import { useState } from "react";
import type { ModelOption } from "../providers/catalog.js";

interface Props {
  /** undefined while the list is loading. */
  options: ModelOption[] | undefined;
  current: string;
  onPick(option: ModelOption): void;
  onCancel(): void;
}

const PROVIDER_LABEL: Record<string, string> = {
  ollama: "Local · Ollama",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai: "OpenAI",
};

export function ModelPicker({ options, current, onPick, onCancel }: Props) {
  const t = useTheme();
  const list = options ?? [];
  const [i, setI] = useState(() => Math.max(0, list.findIndex((o) => o.spec === current)));
  const [initialised, setInitialised] = useState(options !== undefined);
  // Once the list arrives, start the cursor on the current model.
  if (!initialised && options) {
    setInitialised(true);
    setI(Math.max(0, options.findIndex((o) => o.spec === current)));
  }

  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (!list.length) return;
    if (key.upArrow) return setI((n) => (n + list.length - 1) % list.length);
    if (key.downArrow || key.tab) return setI((n) => (n + 1) % list.length);
    if (key.return && list[i]) onPick(list[i]);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.highlight} paddingX={1}>
      <Text bold color={t.highlight}>
        Select a model <Text dimColor>(↑/↓, Enter to switch, Esc to cancel · or type /model provider:model)</Text>
      </Text>
      {!options && <Text dimColor>Looking for models…</Text>}
      {list.map((o, k) => {
        const header = k === 0 || list[k - 1]!.provider !== o.provider;
        const selected = k === i;
        return (
          <Box key={o.spec + k} flexDirection="column">
            {header && (
              <Text bold dimColor>
                {PROVIDER_LABEL[o.provider] ?? o.provider}
              </Text>
            )}
            <Text color={selected ? t.highlight : o.available ? undefined : t.muted}>
              {selected ? "❯ " : "  "}
              {o.label}
              {o.spec === current ? <Text color={t.success}> ✓ current</Text> : null}
              {o.note ? <Text dimColor> · {o.note}</Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
