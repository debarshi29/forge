# Forge — a from-scratch coding agent CLI (TypeScript, provider-agnostic, full-featured)

## Context
Goal: build a terminal coding agent in the spirit of Claude Code / Codex CLI — a streaming REPL where an LLM reads, edits, and runs code in the user's project through tools, gated by permissions. Choices made: **TypeScript on Node**, **provider-agnostic** (Anthropic first-class, plus Google Gemini, OpenAI, and Ollama/OpenAI-compatible adapters), **full-featured** v1 (rich TUI, MCP, subagents, compaction, hooks, plan mode). We build it in milestones so a working agent exists after Milestone 1 and every later milestone layers on without rewrites.

## Stack
- Node 22+, TypeScript (strict), ESM, `pnpm`, `tsup` build, `vitest` tests, `tsx` for dev.
- `@anthropic-ai/sdk` (Anthropic adapter), `@google/genai` (Gemini adapter), `openai` (OpenAI + Ollama/LM Studio via `baseURL`).
- `zod` (v4, native `z.toJSONSchema`) — one schema per tool drives both the provider JSON schema and runtime input validation.
- `ink` + `react` (TUI), `commander` (CLI flags), `execa` (shell), `fast-glob`, `@vscode/ripgrep` (bundled rg binary for grep), `diff` (edit previews), `@modelcontextprotocol/sdk` (MCP client).
- Windows matters (dev box is Win11): shell tool picks `bash` (Git Bash) if found, else PowerShell; all paths via `node:path`.

## Architecture (core is UI-agnostic; the TUI and a headless `-p` mode both consume an event stream)

```
src/
  cli.ts                 # commander entry: `forge`, `forge -p "<prompt>"`, --model, --resume, --plan
  config/                # load ~/.forge/settings.json + .forge/settings.json (merge), env, CLI flags
  providers/
    types.ts             # Provider interface + neutral types (below)
    anthropic.ts         # Messages API streaming adapter
    openai.ts            # Chat Completions/Responses adapter; also Ollama via baseURL
    gemini.ts            # Google Gemini adapter (@google/genai)
    registry.ts          # "anthropic:claude-opus-5-5", "gemini:gemini-2.5-pro", "openai:gpt-…", "ollama:qwen…" → adapter
  agent/
    loop.ts              # the agent loop (async generator of AgentEvents)
    session.ts           # message history, usage/cost tally, JSONL persistence, resume
    systemPrompt.ts      # base prompt + env info + AGENTS.md/FORGE.md + tool guidance
    compaction.ts        # token tracking + summarize-and-replace
    subagent.ts          # spawn a child loop with restricted tools, return final text
  tools/
    types.ts             # Tool<I>: name, description, zod schema, readOnly flag, run(input, ctx)
    registry.ts
    read.ts write.ts edit.ts glob.ts grep.ts bash.ts ls.ts
    todo.ts webFetch.ts task.ts(subagent) exitPlanMode.ts
  permissions/           # modes (default/acceptEdits/plan/bypass), allow/deny rules, prompt bridge
  hooks/                 # PreToolUse/PostToolUse/UserPromptSubmit/Stop shell hooks from settings
  mcp/                   # connect stdio/http MCP servers, wrap their tools as Tool objects
  ui/                    # Ink app: transcript, streaming markdown, tool cards, diff view, permission dialog, input box, slash commands
  commands/              # /help /clear /compact /model /resume /cost /plan /mcp
```

### Neutral provider layer (the key to provider-agnosticism)
- Internal types: `Message { role: user|assistant; content: Block[] }`, `Block = text | tool_use{id,name,input} | tool_result{tool_use_id, content, is_error} | thinking{opaque provider payload}`; `ToolSpec { name, description, jsonSchema }`.
- `Provider.stream(req) → AsyncIterable<StreamEvent>` with events `text_delta`, `thinking_delta`, `tool_use_start/delta/end`, `message_end{stop: end_turn|tool_use|max_tokens|refusal|pause, usage}`.
- **Anthropic adapter**: `client.messages.stream({...}).finalMessage()` + `on("text")`; default model `claude-opus-5-5`, `thinking: {type:"adaptive", display:"summarized"}`, `output_config.effort` configurable (default `high`; Opus 5.5 defaults to medium so set explicitly), `max_tokens: 64000`, `eager_input_streaming: true` on tools, prompt caching via top-level `cache_control: {type:"ephemeral"}`, refusal fallbacks (`betas:["server-side-fallback-2026-07-01"], fallbacks:"default"`). Keep assistant `content` (incl. thinking blocks) verbatim in history — never edit past turns (preserved-thinking rule). No `temperature`, no forced `tool_choice` (400 on current models), no prefill.
- **Gemini adapter** (`providers/gemini.ts`, `@google/genai` SDK, `GEMINI_API_KEY`; Vertex optional via the same SDK): `ai.models.generateContentStream({model, contents, config:{systemInstruction, tools:[{functionDeclarations}], thinkingConfig}})`. Map blocks ↔ `parts` (`text`, `functionCall{name,args}`, `functionResponse{name,response}`); roles `user`/`model`. Gemini function calls may lack ids → synthesize ids and keep an id→name map for `functionResponse`. Preserve `thoughtSignature` parts verbatim in the opaque thinking payload so multi-turn tool use keeps reasoning. Sanitize JSON schemas (Gemini rejects some keywords such as `additionalProperties`/`$schema`) in the adapter. Model ids like `gemini:gemini-2.5-pro`.
- **OpenAI adapter**: map blocks ↔ `tool_calls`/`role:"tool"`; accumulate streamed `function.arguments`. Ollama = same adapter with `baseURL: http://localhost:11434/v1`. Capability flags per provider (thinking, caching, parallel tools, context window) so the loop degrades gracefully.

### Agent loop (`agent/loop.ts`)
```
while true:
  run UserPromptSubmit hooks (first iter); maybe compact if tokens > threshold
  stream provider response → emit text/thinking/tool events to UI
  if stop == max_tokens and a tool_use is open → error/retry, never run truncated input
  if stop in (end_turn, refusal) or no tool_use → run Stop hook, break
  append assistant message verbatim
  for each tool_use (parallel for readOnly tools, sequential for mutating):
     validate input with zod → is_error result on failure
     permission check (rules → mode → ask UI) → is_error "denied by user" on no
     PreToolUse hook (may block/modify) → run with AbortSignal → PostToolUse hook
     truncate huge outputs (e.g. 30k chars, note truncation)
  append ALL tool_results in ONE user message; loop
```
Esc/Ctrl+C aborts via AbortController: cancels stream + running tool, appends synthetic `is_error` results so history stays valid.

### Tools (all with zod schemas; paths resolved & confined to project root unless permitted)
- `read` (line numbers, offset/limit, images as base64 blocks), `write` (requires prior read for existing files), `edit` (exact `old_string`→`new_string`, must be unique unless `replace_all`; tracks file mtime to reject stale edits), `glob`, `grep` (ripgrep), `ls`, `bash` (timeout, background mode, cwd persistence, output cap), `todo_write` (task list rendered in UI), `web_fetch`, `task` (subagent), `exit_plan_mode`.
- Tool descriptions are the main prompt-engineering surface — write them carefully (when to use, pitfalls).

### Permissions
- Read-only tools auto-allowed. Mutating tools: rules like `bash(git status:*)`, `edit(src/**)` in settings `allow`/`deny`; otherwise ask via UI dialog with "yes / yes, always for this session / no (tell the model why)".
- Modes: `default`, `acceptEdits`, `plan` (only read-only tools + `exit_plan_mode`, which shows the plan and asks to switch modes), `bypass` (flag-only, with warning). Shift+Tab cycles modes.
- Bash safety: deny-list obvious destructive patterns by default; prefix-match rules on parsed command.

### Context management
- Track `usage.input_tokens` per turn; at ~80% of the model's window, run compaction: ask the model (cheap model optional) to summarize the conversation, start a new history = summary + recent turns + re-read file list. `/compact` triggers manually. (Optionally use Anthropic server-side compaction `compact-2026-01-12` when on Anthropic.)
- Project memory: load `AGENTS.md`/`FORGE.md` from cwd up to repo root and `~/.forge/`.

### Sessions
- Append-only JSONL per session in `~/.forge/sessions/<project-hash>/<id>.jsonl` (messages + metadata). `--resume`/`/resume` picker; `--continue` for latest.

### Subagents
- `task` tool spawns a child `loop` with fresh history, a focused system prompt, a tool subset (e.g. read-only "explore"), and returns only the final text. Child events show as a collapsed card in the UI.

### MCP
- `mcpServers` in settings (stdio `command/args/env` or `url`). On start, connect, `listTools`, wrap each as `mcp__<server>__<tool>` Tool (permission: ask by default). `/mcp` shows status.

### Hooks
- Settings `hooks: { PreToolUse: [{matcher:"bash", command:"..."}], ... }`. Run command with JSON event on stdin; exit code 2 = block with stderr fed back to the model; stdout JSON may modify input.

### TUI (Ink)
- Static transcript (`<Static>`) + live region: streaming markdown, spinner with elapsed time/tokens, tool call cards (name, args summary, collapsed output), colored diffs for edit/write, permission dialog, multiline input with history, `@file` autocomplete, slash-command menu, status line (model, mode, context %, cost).
- Headless `-p` mode prints final text (or `--output json` event stream) — useful for scripting and for tests.

## Milestones
Done (merged to `main`):
1. ✅ **Core loop (headless)**: scaffold, config, Anthropic adapter, read/write/edit/glob/grep/bash, loop, `-p` mode, basic y/n readline permissions. → usable agent.
2. ✅ **Ink TUI**: streaming render, tool cards, diffs, permission dialog, slash commands, abort.
3. ✅ **Sessions + memory files + cost tracking** (`/resume`, `/cost`, AGENTS.md).
4. ✅ **Provider-agnostic**: neutral types hardened, Gemini + OpenAI + Ollama adapters, `/model` switching (mid-session switch drops other-provider thinking payloads only when sending, never from stored history). Extras: Ollama default + model picker, navigable slash menu, `/themes`, `/pets`.
5. ✅ **Permissions v2 + plan mode + hooks**: allow/ask/deny rules, destructive-command guard, `exit_plan_mode`, PreToolUse/PostToolUse/UserPromptSubmit/Stop hooks, consented reads outside the project.

Next:
6. **Context management + task tracking**
   - Auto-compaction at ~80% of the context window: summarize older turns (cheap model optional), keep recent turns verbatim, keep tool_use/tool_result pairs intact, record a `compact` event in the session. `/compact [focus]` on demand.
   - `/context`: what fills the window (system prompt, tool schemas, memory files, messages, tool results) as a bar with percentages.
   - `todo_write` tool (pending / in_progress / completed, one in progress at a time) and a live task panel above the prompt; todos survive compaction and resume.
7. **Small-model boost**
   - Constrained tool calls: Ollama `format` (JSON schema) so local models emit valid calls.
   - Model routing: settings `models: { main, fast }`; the fast model handles compaction, subagents and commit messages.
   - Repo map: a compact symbol index (files → functions/classes) injected or available as a tool, sized to the context window.
   - Diagnostics after edits: run the project's typechecker/linter on changed files and feed errors back with the tool result.
   - Auto context sizing for Ollama from free VRAM; `/bench` scores installed models on fixed tasks (speed + success).
8. **Subagents**
   - `task` tool spawning a child loop with fresh history, a focused prompt and a tool subset; returns only the final text; collapsed progress card.
   - Built-in types `explore` (read-only), `plan`, `general`; custom agents in `.forge/agents/*.md` (frontmatter: name, description, tools, model).
   - Parallel subagents; background agents that notify when done.
9. **Usage and stats**
   - `/usage`: tokens and cost per session / day / month / model, from the session logs.
   - `/stats`: sessions per day, tool and file frequency, turns per task, activity heatmap.
   - Custom status line: a settings command whose stdout renders under the prompt.
10. **Goals and autonomy**
    - `/goal <objective> [--check "<cmd>"]`: keep working across turns until the check passes (or the model judges it done), within turn/cost budgets, with visible progress.
    - `/loop <interval> <prompt>`; background bash (`run_in_background`, output on completion); session budgets.
11. **Checkpoints, forks and branches**
    - Snapshot files before each prompt; `/rewind` restores code, conversation, or both (warns on files edited outside Forge).
    - `/fork` (copy the session and continue separately; `--worktree` for an isolated git worktree), `/branch` (edit an earlier message and continue, Esc Esc picker), `/branches`, `/reset [--hard | --to <point>]`.
    - Optional git-ref checkpoints; "always allow" can be saved to settings.
12. **Git and GitHub workflows**: `/commit` (message from the diff), `/pr`, `/review [pr]`, `/security-review`, watch CI after push and fix failures.
13. **Extensibility**: MCP client (`mcpServers`, stdio/HTTP, `mcp__server__tool`, `/mcp`), `web_fetch`, `web_search` (where a provider offers it), custom slash commands (`.forge/commands/*.md`), skills, `/init` (write a starter AGENTS.md), plugins bundling commands/agents/hooks/MCP.
14. **Code intelligence, documents and artifacts**
   - LSP tools (definition, references, rename, diagnostics), test-runner detection and run→read→fix loops.
   - Reading office documents: `read` extracts text from `.docx` (paragraphs, headings, tables), `.xlsx` (sheets as tables), `.pptx` (slide text and notes) and `.pdf`, instead of refusing them as binary. `.doc`/`.xls`/`.ppt` go through LibreOffice (`soffice --convert-to`) when it is installed.
   - Editing `.docx` while keeping its formatting: a `docx_edit` tool that replaces text inside `word/document.xml`, matching across the formatting runs Word splits sentences into; later, inserting or deleting paragraphs.
   - Artifact generation: tools to create `.docx`, `.xlsx`, `.pptx` and `.pdf` files, plus standalone HTML pages (reports, diagrams, charts), from content the model writes as Markdown/JSON. Generated files are checked by reading them back, and a `/open <file>` command opens one in its default app.
15. **Memory and learning**: auto-memory of preferences and corrections (editable files, recalled by relevance), `/remember <note>`.
16. **Safety**: sandboxed bash (no network / project-only), secret redaction in tool output, audit log, per-session cost/token caps.
17. **Input and UX**: `@file` autocomplete, image paste, output styles, Ctrl+O expand tool output, Ctrl+R prompt search, vim mode, syntax highlighting, per-hunk edit approval, desktop notifications, keybindings file, session tabs, `/config`, `/doctor`, `/export`.
18. **Integrations**: JS/TS SDK with a JSON event stream, VS Code extension (diffs, selection as context), GitHub Action, agent teams (planner / coder / reviewer).
19. **Fun**: pets that earn XP and evolve, achievements, `/theme from <image>`.
20. **Packaging and docs**: clean `npm i -g`, Windows shell edge cases, full docs, the end-to-end smoke test below.

## Verification
- `vitest` unit tests per tool against temp dirs (edit uniqueness, path confinement, stale-file rejection, bash timeout/abort), permission rule matching, OpenAI↔neutral and Gemini↔neutral message mapping (incl. synthesized call ids, thoughtSignature round-trip, schema sanitizing), compaction shape.
- A `FakeProvider` that replays scripted StreamEvents → deterministic end-to-end loop tests (tool call → result → final answer, parallel calls, abort mid-tool, max_tokens truncation).
- Manual smoke per milestone: `pnpm dev -p "create hello.ts that prints hi, then run it"` in a scratch dir; then interactive TUI: ask it to fix a seeded failing test in a sample repo; resume the session; switch to a `gemini:` and an `ollama:` model and repeat the fix-the-test task; run in plan mode and confirm no writes happen; add a filesystem MCP server and call one of its tools.
- Requires `ANTHROPIC_API_KEY` (or `ant auth login`) and optionally `GEMINI_API_KEY`, `OPENAI_API_KEY`, or a running Ollama for live tests.
