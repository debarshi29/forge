import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SessionInfo } from "../agent/session.js";

interface Props {
  sessions: SessionInfo[];
  onPick(session: SessionInfo): void;
  onCancel(): void;
}

function ago(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const PAGE = 10;

export function SessionPicker({ sessions, onPick, onCancel }: Props) {
  const [i, setI] = useState(0);
  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setI((n) => Math.max(0, n - 1));
    if (key.downArrow) return setI((n) => Math.min(sessions.length - 1, n + 1));
    if (key.return && sessions[i]) onPick(sessions[i]);
  });
  const start = Math.max(0, Math.min(i - Math.floor(PAGE / 2), sessions.length - PAGE));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Resume a conversation <Text dimColor>(↑/↓, Enter, Esc to cancel)</Text>
      </Text>
      {sessions.length === 0 && <Text dimColor>No saved sessions for this project yet.</Text>}
      {sessions.slice(start, start + PAGE).map((s, k) => {
        const selected = start + k === i;
        return (
          <Text key={s.id} color={selected ? "cyan" : undefined}>
            {selected ? "❯ " : "  "}
            {s.title.padEnd(60).slice(0, 60)} <Text dimColor>{ago(s.updated).padStart(8)} · {s.messages} msgs</Text>
          </Text>
        );
      })}
    </Box>
  );
}
