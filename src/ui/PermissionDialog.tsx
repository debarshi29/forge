import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { AskAnswer, PermissionRequest } from "../permissions/index.js";
import { preview } from "./format.js";

interface Props {
  request: PermissionRequest;
  onAnswer(answer: AskAnswer): void;
}

const OPTIONS = ["Yes", "Yes, and don't ask again this session", "No, and tell Forge what to do instead"] as const;

function details(req: PermissionRequest): string {
  const i = (req.input ?? {}) as Record<string, unknown>;
  if (req.tool === "bash") return String(i.command ?? "");
  if (req.tool === "write") return `${i.path}\n${preview(String(i.content ?? ""), 8)}`;
  if (req.tool === "edit") {
    const minus = String(i.old_string ?? "").split("\n").map((l) => `- ${l}`).join("\n");
    const plus = String(i.new_string ?? "").split("\n").map((l) => `+ ${l}`).join("\n");
    return `${i.path}\n${preview(minus, 6)}\n${preview(plus, 6)}`;
  }
  return preview(JSON.stringify(req.input, null, 2), 10);
}

export function PermissionDialog({ request, onAnswer }: Props) {
  const [selected, setSelected] = useState(0);
  const [reason, setReason] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (reason !== undefined) {
      if (key.return) return onAnswer({ kind: "no", ...(reason.trim() ? { reason: reason.trim() } : {}) });
      if (key.escape) return setReason(undefined);
      if (key.backspace || key.delete) return setReason(reason.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setReason(reason + input);
      return;
    }
    if (key.upArrow) return setSelected((s) => (s + OPTIONS.length - 1) % OPTIONS.length);
    if (key.downArrow || key.tab) return setSelected((s) => (s + 1) % OPTIONS.length);
    if (key.escape) return onAnswer({ kind: "no" });
    const choice = key.return ? selected : ["1", "2", "3"].indexOf(input);
    if (choice === 0) onAnswer({ kind: "yes" });
    else if (choice === 1) onAnswer({ kind: "always" });
    else if (choice === 2) setReason("");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Allow {request.tool}?
      </Text>
      <Box marginY={1} paddingLeft={2}>
        <Text>{details(request)}</Text>
      </Box>
      {OPTIONS.map((o, i) => (
        <Text key={o} color={i === selected ? "cyan" : undefined}>
          {i === selected ? "❯ " : "  "}
          {i + 1}. {o}
        </Text>
      ))}
      {reason !== undefined && (
        <Box marginTop={1}>
          <Text>
            Reason (Enter to send, Esc to go back): {reason}
            <Text inverse> </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
