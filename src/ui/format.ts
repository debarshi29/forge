/** Pure text formatting for the TUI (no Ink/React here, so it is easy to test). */

const ESC = "\x1b[";
export const ansi = {
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  italic: (s: string) => `${ESC}3m${s}${ESC}23m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
  green: (s: string) => `${ESC}32m${s}${ESC}39m`,
  red: (s: string) => `${ESC}31m${s}${ESC}39m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
  magenta: (s: string) => `${ESC}35m${s}${ESC}39m`,
};

function inline(line: string): string {
  return line
    .replace(/`([^`]+)`/g, (_m, c: string) => ansi.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_m, c: string) => ansi.bold(c))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, (_m, pre: string, c: string) => pre + ansi.italic(c))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, label: string, url: string) => `${label} ${ansi.dim(`(${url})`)}`);
}

/**
 * A small Markdown-to-ANSI renderer covering what models actually emit:
 * headings, lists, quotes, fenced code, inline code, bold, italic, links.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    const fence = /^\s*```/.test(line);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(ansi.cyan(`  ${line}`));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(ansi.bold(inline(heading[2]!)));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2]!)}`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out.push(ansi.dim(`│ ${inline(line.replace(/^\s*>\s?/, ""))}`));
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(ansi.dim("─".repeat(40)));
      continue;
    }
    out.push(inline(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** Colour a unified diff, dropping the file headers, capped at maxLines. */
export function renderDiff(patch: string, maxLines = 30): string {
  const lines = patch
    .split("\n")
    .filter((l) => !/^(Index:|={3,}|---|\+\+\+|\\ No newline)/.test(l))
    .filter((l, i, all) => !(i === all.length - 1 && l === ""));
  const shown = lines.slice(0, maxLines).map((l) => {
    if (l.startsWith("@@")) return ansi.dim(l);
    if (l.startsWith("+")) return ansi.green(l);
    if (l.startsWith("-")) return ansi.red(l);
    return ansi.dim(l);
  });
  if (lines.length > maxLines) shown.push(ansi.dim(`… ${lines.length - maxLines} more lines`));
  return shown.join("\n");
}

/** First few lines of a tool result, for collapsed tool cards. */
export function preview(text: string, maxLines = 4, maxWidth = 160): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, maxLines).map((l) => (l.length > maxWidth ? `${l.slice(0, maxWidth)}…` : l));
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines`);
  return shown.join("\n");
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
