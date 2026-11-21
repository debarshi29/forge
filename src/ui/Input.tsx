import { Box, Text, useInput } from "ink";
import { useTheme } from "./theme.js";
import { useRef, useState } from "react";

/** An entry in the completion menu (slash commands). */
export interface Suggestion {
  name: string;
  args?: string;
  description: string;
}

interface Props {
  active: boolean;
  placeholder?: string;
  onSubmit(value: string): void;
  onChange?(value: string): void;
  /** Called on Ctrl+C with the current value (the app decides: clear or exit). */
  onCtrlC?(value: string): void;
  /** Menu entries for the current value; shown below the box when non-empty. */
  suggest?(value: string): Suggestion[];
}

/** Menu rows shown at once; the list scrolls to keep the selection visible. */
export const MENU_ROWS = 6;

/**
 * Line editor: Enter submits, a trailing "\" + Enter inserts a newline,
 * ↑/↓ walk history, ←/→ move, Ctrl+A/E home/end, Ctrl+U clears.
 * While the suggestion menu is open, ↑/↓ move through it, Enter runs the
 * highlighted entry, Tab completes it, and Esc closes the menu.
 */
export function Input({ active, placeholder, onSubmit, onChange, onCtrlC, suggest }: Props) {
  const t = useTheme();
  const [value, setValueState] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const history = useRef<string[]>([]);
  const histIdx = useRef<number>(-1);
  const draft = useRef("");

  const menu = !dismissed && suggest ? suggest(value) : [];
  const sel = Math.min(selected, Math.max(0, menu.length - 1));

  const setValue = (v: string, c = v.length) => {
    if (v !== value) {
      setSelected(0);
      setDismissed(false);
    }
    setValueState(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
    onChange?.(v);
  };

  const submit = (v: string) => {
    if (!v.trim()) return;
    if (history.current.at(-1) !== v) history.current.push(v);
    histIdx.current = -1;
    setValue("");
    onSubmit(v);
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
      if (menu.length) {
        if (key.upArrow) return setSelected((sel + menu.length - 1) % menu.length);
        if (key.downArrow) return setSelected((sel + 1) % menu.length);
        if (key.escape) return setDismissed(true);
        if (key.tab) {
          const s = menu[sel]!;
          const done = `/${s.name}${s.args ? " " : ""}`;
          return setValue(done);
        }
        if (key.return) return submit(`/${menu[sel]!.name}`);
      }
      if (key.return) {
        if (value.slice(0, cursor).endsWith("\\")) {
          setValue(value.slice(0, cursor - 1) + "\n" + value.slice(cursor), cursor);
          return;
        }
        submit(value);
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
  const start = Math.max(0, Math.min(sel - Math.floor(MENU_ROWS / 2), menu.length - MENU_ROWS));
  const visible = menu.slice(start, start + MENU_ROWS);
  const nameWidth = Math.max(...menu.map((m) => m.name.length + (m.args ? m.args.length + 1 : 0)), 0) + 2;
  return (
    <Box flexDirection="column">
    <Box borderStyle="round" borderColor={active ? t.border : "blackBright"} paddingX={1}>
      <Text color={t.prompt}>{"> "}</Text>
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
      {active && menu.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
          {visible.map((s, k) => {
            const isSel = start + k === sel;
            return (
              <Text key={s.name} color={isSel ? t.highlight : undefined} dimColor={!isSel}>
                {isSel ? "❯ " : "  "}
                {`/${s.name}${s.args ? ` ${s.args}` : ""}`.padEnd(nameWidth + 1)}
                {s.description}
              </Text>
            );
          })}
          {start + MENU_ROWS < menu.length && <Text dimColor>  ↓ {menu.length - start - MENU_ROWS} more</Text>}
        </Box>
      )}
    </Box>
  );
}
