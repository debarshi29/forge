# Forge

A from-scratch terminal coding agent in the spirit of Claude Code and Codex CLI: a streaming REPL where an LLM reads, edits, and runs code in your project through tools, gated by permissions.

- **Provider-agnostic:** Anthropic Claude (first-class), Google Gemini, OpenAI, and Ollama / OpenAI-compatible local models.
- **Built in TypeScript** on Node 22+.
- **Planned features:** rich Ink TUI, permission modes and plan mode, hooks, sessions and resume, context compaction, subagents, MCP client.

> Status: early development. See [PLAN.md](PLAN.md) for the architecture and milestones.

## Install

```sh
pnpm install
pnpm build
npm link        # puts `forge` on your PATH (npm's global bin), pointing at this checkout
forge --version
```

After pulling changes, run `pnpm build` again; the link always uses the latest `dist/`. Remove it with `npm unlink -g forge`.

## Usage

Needs Node 22+ and credentials for your provider (for Claude: `ANTHROPIC_API_KEY`, or `ant auth login`).

```sh
pnpm install
pnpm dev                                   # interactive TUI (/help for commands)
pnpm dev -p "create hello.ts that prints hi, then run it"
pnpm dev -p "..." --output json            # one JSON event per line
pnpm dev -p "..." --permission-mode acceptEdits
```

Options: `--model provider:model` (default: an installed Ollama model), `--effort low|medium|high|xhigh|max`,
`--permission-mode default|acceptEdits|plan|bypass`, `--cwd <dir>`.

Settings are merged from `~/.forge/settings.json`, then `<project>/.forge/settings.json`, then `FORGE_MODEL`, then flags:

```json
{ "model": "anthropic:claude-opus-5-5", "effort": "high", "permissionMode": "default" }
```

### Providers and models

By default Forge uses a model from your local Ollama, preferring tool-capable coding models (e.g. `qwen2.5-coder`).
Pick another with `--model provider:model`, or inside the TUI type `/model` (or `/models`) to choose from a list of your
installed Ollama models and the Claude, Gemini and OpenAI models. `/model provider:model` switches directly. Set a
permanent default with `"model"` in `~/.forge/settings.json`.
The conversation carries over: each provider replays its own turns verbatim and skips other providers' reasoning.

| Provider | Example | Credentials / setup |
| --- | --- | --- |
| Ollama (default) | `ollama` (auto-pick), `ollama:qwen2.5-coder:3b` | a running Ollama (`OLLAMA_HOST` or `"ollama": {"baseURL": "…"}`) |
| Anthropic | `anthropic:claude-opus-5-5`, `anthropic:claude-sonnet-5-5` | `ANTHROPIC_API_KEY` or `ant auth login` |
| Google Gemini | `gemini:gemini-2.5-pro` | `GEMINI_API_KEY`, or `"gemini": {"vertexai": true, "project": "…", "location": "…"}` |
| OpenAI | `openai:gpt-5` | `OPENAI_API_KEY`; `"openai": {"baseURL": "…"}` for other compatible endpoints |
| LM Studio | `lmstudio:<model>` | LM Studio's server on `localhost:1234` |

Ollama runs models with a 4k-token context unless told otherwise, which is too small for an agent (Forge's
instructions and tool definitions alone take about 4k). Forge reads the real figure from Ollama and warns when it is
below 16k. Raise it with `OLLAMA_CONTEXT_LENGTH` and restart Ollama:

```sh
setx OLLAMA_CONTEXT_LENGTH 16384            # Windows
export OLLAMA_CONTEXT_LENGTH=16384          # macOS / Linux (e.g. in your shell profile)
```

`"ollama": {"contextWindow": …}` only changes what Forge assumes, not what Ollama runs. Small local models that write
tool calls as JSON text instead of using native tool calls are handled too.

### Context and tasks

- **Compaction.** When the conversation reaches 80% of the context window, Forge summarizes the older turns and keeps
  recent ones as they are, so long sessions keep going. `/compact [focus]` does it now, optionally steering the summary
  ("/compact the failing auth tests"). Turn it off with `"autoCompact": false`, or move the trigger with
  `"compactThreshold": 0.7`.
- **`/context`** shows what fills the window: system prompt, memory files, tool definitions, messages and tool results.
- **Tasks.** For multi-step work Forge keeps a task list (the `todo_write` tool), shown live above the prompt. Ctrl+T
  hides or shows it; `/todos` prints it. The list survives compaction and `--resume`.

### Sessions

Every conversation is saved as append-only JSONL under `~/.forge/sessions/<project>-<hash>/`.

```sh
forge --continue          # pick up the most recent session in this project
forge --resume            # choose from a list (or /resume inside the TUI)
forge --resume <id>       # by id or unique id prefix
forge --no-session        # don't save this one
```

`/cost` shows tokens and estimated cost (Anthropic list prices, including cache reads and writes).

### Memory files

Standing instructions are read from `AGENTS.md` and `FORGE.md`: first `~/.forge/`, then every directory from the repo root
down to the working directory (more specific files come later and win). `/memory` lists what is loaded.

### Permissions

Read-only tools run freely; edits and commands ask first. Shift+Tab cycles the mode:

| Mode | What runs without asking |
|---|---|
| `default` | read-only tools |
| `acceptEdits` | read-only tools, plus `write` and `edit` |
| `plan` | read-only tools only; Forge investigates, then shows you a plan to approve (approving switches to `default` or `acceptEdits`) |
| `bypass` | everything (start-up flag only: `--permission-mode bypass`) |

Rules in `~/.forge/settings.json` or `<project>/.forge/settings.json` (both files' rules apply) fine-tune that:

```json
{
  "permissions": {
    "allow": ["bash(npm test:*)", "bash(git status)", "edit(src/**)"],
    "ask": ["edit(package.json)"],
    "deny": ["read(.env)", "bash(git push:*)", "write(.git/**)"]
  }
}
```

- `bash(cmd)` is an exact command, `bash(cmd:*)` that command with any arguments, and `*` a wildcard. For
  compound commands (`a && b | c`), deny matches if any part does, and allow only if every part does and there
  is no `$(…)` or `>` redirection.
- File tools take a glob relative to the project root; a pattern without `/` matches the file name anywhere.
- Deny beats ask, and ask beats allow. Deny rules apply in every mode, including bypass.
- Destructive commands (`rm -rf /`, `git push --force`, `git reset --hard`, `curl … | sh`, `sudo`, …) always ask
  with a warning, whatever the rules or mode, and can't be "always allowed". Non-interactive runs refuse them.

`/permissions` shows what is in effect.

### Hooks

Hooks are shell commands Forge runs at points in the loop. Each gets the event as JSON on stdin:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "node .forge/guard.mjs" }],
    "PostToolUse": [{ "matcher": "write|edit", "command": "npx prettier --write \"$(node -p 'JSON.parse(require(\"fs\").readFileSync(0)).tool_input.path')\"" }],
    "UserPromptSubmit": [{ "command": "git branch --show-current" }],
    "Stop": [{ "command": "npm test --silent >/dev/null 2>&1 || { echo 'tests fail' >&2; exit 2; }" }]
  }
}
```

| Event | Fields | Exit code 2 (stderr is the message) |
|---|---|---|
| `PreToolUse` | `tool_name`, `tool_input` | blocks the call; the model sees why |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` | feedback is appended to the tool result |
| `UserPromptSubmit` | `prompt` | the prompt is not sent; stdout (on exit 0) is added as context |
| `Stop` | `stop_hook_active` | the model keeps working (up to 3 times per prompt) |

Every event also has `hook_event_name`, `cwd` and `permission_mode`. `matcher` is a regex on the tool name. Other
non-zero exits are reported but don't block. On exit 0, stdout may be JSON: `{"decision": "block", "reason": "…"}`,
`{"updatedInput": {…}}` (PreToolUse: replaces the tool input, which is then validated and permission-checked), or
`{"additionalContext": "…"}`. Hooks run in the project directory with `FORGE_PROJECT_DIR` set, and time out after
`timeout` seconds (default 60).

## Development

```sh
pnpm typecheck
pnpm test
pnpm build      # dist/cli.js
```

## License

MIT
