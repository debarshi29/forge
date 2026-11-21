import { Box, Text } from "ink";
import type { ToolResult } from "../tools/types.js";
import { preview, renderDiff, renderMarkdown } from "./format.js";
import { useTheme } from "./theme.js";

export type Item =
  | { id: number; kind: "banner"; model: string; root: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "tool"; name: string; summary: string; result: ToolResult }
  | { id: number; kind: "info"; text: string; tone?: "info" | "warn" | "error" };

export function ItemView({ item }: { item: Item }) {
  const t = useTheme();
  switch (item.kind) {
    case "banner":
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1}>
          <Text>
            <Text bold color={t.accent}>
              {t.icon} forge
            </Text>{" "}
            <Text dimColor>· {item.model}</Text>
          </Text>
          <Text dimColor>{item.root}</Text>
          <Text dimColor>/help for commands · /themes to restyle · Shift+Tab to change permission mode · Esc to interrupt</Text>
        </Box>
      );
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={t.prompt}>{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text>{renderMarkdown(item.text, t)}</Text>
        </Box>
      );
    case "thinking":
      return (
        <Box marginTop={1}>
          <Text dimColor italic>
            ∴ {preview(item.text.trim(), 6, 200)}
          </Text>
        </Box>
      );
    case "tool":
      return <ToolCard name={item.name} summary={item.summary} result={item.result} />;
    case "info":
      return (
        <Box marginTop={1}>
          <Text color={item.tone === "error" ? t.error : item.tone === "warn" ? t.warning : t.muted}>{item.text}</Text>
        </Box>
      );
  }
}

export function ToolCard({ name, summary, result, running }: { name: string; summary: string; result?: ToolResult; running?: boolean }) {
  const t = useTheme();
  const text = result ? (typeof result.content === "string" ? result.content : "[image]") : "";
  const dot = running ? t.warning : result?.isError ? t.error : t.success;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={dot}>● </Text>
        <Text bold>{name}</Text> <Text dimColor>{summary.split("\n")[0]}</Text>
      </Text>
      {result && (
        <Box paddingLeft={2}>
          {result.display && !result.isError ? (
            <Text>{renderDiff(result.display, 20, t)}</Text>
          ) : (
            <Text color={result.isError ? t.error : undefined} dimColor={!result.isError}>
              ⎿ {preview(text, result.isError ? 6 : 3)}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
