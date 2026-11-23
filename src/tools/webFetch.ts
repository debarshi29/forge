import { z } from "zod";
import { defineTool, ToolError } from "./types.js";

const DEFAULT_MAX = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text from HTML: headings, paragraphs, list items and links kept; scripts, styles and markup dropped. */
export function htmlToText(html: string, base?: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, "\n");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
      const text = t.replace(/<[^>]+>/g, "").trim();
      if (!text) return "";
      let url = href;
      try {
        url = base ? new URL(href, base).toString() : href;
      } catch {
        // keep as written
      }
      return /^(javascript|mailto):/i.test(url) ? text : `[${text}](${url})`;
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|pre|blockquote|h[1-6])>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  s = decode(s)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title && !s.startsWith(`# ${title}`) ? `# ${decode(title)}\n\n${s}` : s;
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  description: `Fetch a web page or API URL and return its content as text (HTML is converted to readable text with links kept).
- Use it for documentation, issues, release notes or an API's JSON. It can't log in, run JavaScript, or see pages behind authentication.
- Only http and https; long pages are cut (max_chars).`,
  schema: z.object({
    url: z.string().describe("The URL to fetch"),
    max_chars: z.number().int().min(500).max(200_000).optional().describe(`Characters to return (default ${DEFAULT_MAX})`),
  }),
  // Network access: asks first (allow with a rule like web_fetch(https://docs.python.org/*)).
  readOnly: false,
  summarize: (i) => i.url,
  async run(input, ctx) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new ToolError(`Not a valid URL: ${input.url}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError("Only http and https URLs can be fetched.");
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "user-agent": "forge (terminal coding agent)", accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      throw new ToolError(`Couldn't fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const type = res.headers.get("content-type") ?? "";
    const max = input.max_chars ?? DEFAULT_MAX;
    let body: string;
    if (/html|xml/.test(type)) body = htmlToText(await res.text(), res.url);
    else if (/json/.test(type)) {
      const raw = await res.text();
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        body = raw;
      }
    } else if (/^text\//.test(type) || !type) body = await res.text();
    else {
      const size = (await res.arrayBuffer()).byteLength;
      body = `(binary content: ${type}, ${size} bytes; not shown)`;
    }
    const cut = body.length > max ? `${body.slice(0, max)}\n\n[… ${body.length - max} more characters; fetch again with a larger max_chars to see them]` : body;
    const head = `${res.status} ${res.statusText} · ${res.url}${res.url !== url.toString() ? ` (redirected from ${url})` : ""}`;
    return { content: `${head}\n\n${cut}`, ...(res.ok ? {} : { isError: true }) };
  },
});
