import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

interface Props {
  active: boolean;
  placeholder?: string;
  onSubmit(value: string): void;
  onChange?(value: string): void;
  /** Called on Ctrl+C with the current value (the app decides: clear or exit). */
  onCtrlC?(value: string): void;
}

/**
 * Line editor: Enter submits, a trailing "\" + Enter inserts a newline,
 * ↑/↓ walk history, ←/→ move, Ctrl+A/E home/end, Ctrl+U clears.
 */
export function Input({ active, placeholder, onSubmit, onChange, onCtrlC }: Props) {
  const [value, setValueState] = useState("");
  const [cursor, setCursor] = useState(0);
  const history = useRef<string[]>([]);
  const histIdx = useRef<number>(-1);
  const draft = useRef("");

  const setValue = (v: string, c = v.length) => {
    setValueState(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
    onChange?.(v);
  };

  useInput(
    (input, key) => {
      // The subscription is dropped in an effect after `active` flips; until
      // then, ignore keys so they can't land in a hidden input.
      if (!active) return;
      if (key.ctrl && input === "c") {
        onCtrlC?.(value);
        if (value) setValue("");
        return;
      }
      if (key.return) {
        if (value.slice(0, cursor).endsWith("\\")) {
          setValue(value.slice(0, cursor - 1) + "\n" + value.slice(cursor), cursor);
          return;
        }
        const v = value;
        if (!v.trim()) return;
        if (history.current.at(-1) !== v) history.current.push(v);
        histIdx.current = -1;
        setValue("");
        onSubmit(v);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const h = history.current;
        if (!h.length || value.includes("\n")) return;
        if (histIdx.current === -1) {
          if (key.downArrow) return;
          draft.current = value;
          histIdx.current = h.length - 1;
        } else {
          histIdx.current += key.upArrow ? -1 : 1;
        }
        if (histIdx.current < 0) histIdx.current = 0;
        if (histIdx.current >= h.length) {
          histIdx.current = -1;
          setValue(draft.current);
          return;
        }
        setValue(h[histIdx.current]!);
        return;
      }
      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1));
      if (key.ctrl && input === "a") return setCursor(0);
      if (key.ctrl && input === "e") return setCursor(value.length);
      if (key.ctrl && input === "u") return setValue("");
      if (key.backspace || key.delete) {
        // Many terminals send DEL for Backspace; treat both as backspace.
        if (cursor === 0) return;
        setValue(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (key.tab || key.escape || key.ctrl || key.meta) return;
      if (input) {
        const text = input.replace(/\r\n?/g, "\n");
        setValue(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
      }
    },
    { isActive: active },
  );

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  return (
    <Box borderStyle="round" borderColor={active ? "gray" : "blackBright"} paddingX={1}>
      <Text color="cyan">{"> "}</Text>
      {value === "" && placeholder ? (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      ) : (
        <Text>
          {before}
          {active ? <Text inverse>{at === "\n" ? " " : at}</Text> : at}
          {at === "\n" ? "\n" : ""}
          {after}
        </Text>
      )}
    </Box>
  );
}
