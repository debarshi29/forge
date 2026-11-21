import { Box, Text, useInput } from "ink";
import { useTheme } from "./theme.js";
import { isMouseInput } from "./pets.js";
import { useState } from "react";
import type { AskAnswer, PermissionRequest } from "../permissions/index.js";
import { preview, renderMarkdown } from "./format.js";

interface Props {
  request: PermissionRequest;
  onAnswer(answer: AskAnswer): void;
}

interface Option {
  label: string;
  /** undefined = "no": type a reason first. */
  answer?: AskAnswer;
}

function optionsFor(req: PermissionRequest): Option[] {
  if (req.kind === "plan") {
    return [
      { label: "Yes, and auto-accept edits", answer: { kind: "always" } },
      { label: "Yes, and ask before each edit", answer: { kind: "yes" } },
      { label: "No, keep planning (tell Forge what to change)" },
    ];
  }
  return [
    { label: "Yes", answer: { kind: "yes" } },
    ...(req.allowAlways === false ? [] : [{ label: req.alwaysLabel ?? "Yes, and don't ask again this session", answer: { kind: "always" } } as Option]),
    { label: "No, and tell Forge what to do instead" },
  ];
}

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
  const t = useTheme();
  const [selected, setSelected] = useState(0);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const options = optionsFor(request);
  const plan = request.kind === "plan";

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    if (o.answer) onAnswer(o.answer);
    else setReason("");
  };

  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (reason !== undefined) {
      if (key.return) return onAnswer({ kind: "no", ...(reason.trim() ? { reason: reason.trim() } : {}) });
      if (key.escape) return setReason(undefined);
      if (key.backspace || key.delete) return setReason(reason.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setReason(reason + input);
      return;
    }
    if (key.upArrow) return setSelected((s) => (s + options.length - 1) % options.length);
    if (key.downArrow || key.tab) return setSelected((s) => (s + 1) % options.length);
    if (key.escape) return onAnswer({ kind: "no" });
    if (key.return) return choose(selected);
    const n = Number.parseInt(input, 10);
    if (n >= 1 && n <= options.length) choose(n - 1);
  });

  const border = request.warning && !plan ? t.error : plan ? t.highlight : t.warning;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
      <Text bold color={border}>
        {plan ? "Ready to code? Here is Forge's plan:" : `Allow ${request.tool}?`}
      </Text>
      {request.warning ? (
        <Text color={t.error} bold>
          ⚠ {request.warning}
        </Text>
      ) : null}
      <Box marginY={1} paddingLeft={2}>
        <Text>{plan ? renderMarkdown(request.summary, t) : details(request)}</Text>
      </Box>
      {options.map((o, i) => (
        <Text key={o.label} color={i === selected ? t.highlight : undefined}>
          {i === selected ? "❯ " : "  "}
          {i + 1}. {o.label}
        </Text>
      ))}
      {reason !== undefined && (
        <Box marginTop={1}>
          <Text>
            {plan ? "What should change" : "Reason"} (Enter to send, Esc to go back): {reason}
            <Text inverse> </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
