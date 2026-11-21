import { Box, Text } from "ink";
import type { Todo } from "../tools/todo.js";
import { useTheme } from "./theme.js";

const MAX_ROWS = 8;

/** The live task list (todo_write), shown above the prompt. */
export function TaskPanel({ todos, spin }: { todos: Todo[]; spin: number }) {
  const t = useTheme();
  if (!todos.length) return null;
  const done = todos.filter((x) => x.status === "completed").length;
  // Keep the task in progress visible when the list is long.
  const active = Math.max(0, todos.findIndex((x) => x.status === "in_progress"));
  const start = todos.length > MAX_ROWS ? Math.min(Math.max(0, active - 2), todos.length - MAX_ROWS) : 0;
  const shown = todos.slice(start, start + MAX_ROWS);
  const frames = ["◐", "◓", "◑", "◒"];
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text>
        <Text bold color={t.accent}>
          Tasks
        </Text>
        <Text dimColor>
          {" "}
          {done}/{todos.length} done · ctrl+t to hide
        </Text>
      </Text>
      {start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
      {shown.map((x, i) =>
        x.status === "completed" ? (
          <Text key={start + i} dimColor strikethrough>
            {"  ✔ "}
            {x.content}
          </Text>
        ) : x.status === "in_progress" ? (
          <Text key={start + i} color={t.highlight} bold>
            {"  "}
            {frames[spin % frames.length]} {x.activeForm ?? x.content}
          </Text>
        ) : (
          <Text key={start + i}>
            {"  ☐ "}
            {x.content}
          </Text>
        ),
      )}
      {start + MAX_ROWS < todos.length ? <Text dimColor>  ↓ {todos.length - start - MAX_ROWS} more</Text> : null}
    </Box>
  );
}
