# Forge

A from-scratch terminal coding agent in the spirit of Claude Code and Codex CLI: a streaming REPL where an LLM reads, edits, and runs code in your project through tools, gated by permissions.

- **Provider-agnostic:** Anthropic Claude (first-class), Google Gemini, OpenAI, and Ollama / OpenAI-compatible local models.
- **Built in TypeScript** on Node 22+.
- **Features:** Ink TUI, permission modes and plan mode, hooks, sessions and resume, context compaction, task lists, subagents (parallel and background, custom types), and help for small local models (tool-call repair, repo map, checks after edits, `/bench`). Planned: MCP client.

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

Or set it per model from inside Forge: `/context 32k` runs the current Ollama model with a 32k context, saves that for
the model, and tells you whether it still fits on the GPU (`/context default` goes back). Forge does this with a
variant model such as `qwen2.5-coder:3b-ctx32k` that shares the original's weights, so it costs no disk space; variants
are hidden from `/model`. `/context auto` picks the largest size that fits in free GPU memory (estimated from the model's
layers and your `OLLAMA_KV_CACHE_TYPE`, then checked by loading it and stepping down if part of it spills onto the CPU).
`"ollama": {"contextWindow": …}` only changes what Forge assumes, not what Ollama runs.

### Small local models

Forge works around the mistakes small models make, so a 3B–8B model on your own GPU gets real work done:

- **Malformed tool calls are repaired.** Calls written as JSON text are turned into real calls, invented tool names
  (`read_file`, `run_command`) are mapped to the real tools, and when the arguments don't fit the tool, Forge asks the
  model again with its output constrained to the tool's JSON schema (Ollama/LM Studio structured output), so the
  retry is valid by construction. Turn the retry off with `"repairToolCalls": false`.
- **Edits that almost match still apply.** `old_string` written with different whitespace (one line instead of three)
  or with `read`'s line-number prefixes is matched anyway, and the result says so.
- **Wrong paths get suggestions:** "File not found: server.js. Files with similar names: src/server/app.js".
- **Errors after edits come back.** After `write`/`edit`, Forge checks the changed files (the project's `tsc`, `node
  --check`, `python -m py_compile`, JSON) and tells the model about new problems. Use your own checker with
  `"diagnostics": {"command": "npx eslint {files}"}`, or turn it off with `"diagnostics": false`.
- **`repo_map`** lists every source file with the functions and classes it defines, so the model can find its way
  around without reading everything.
- **Stalls and loops.** A reply that announces a step and stops ("Now let's update main.js:") gets a nudge to carry on;
  a reply stuck repeating itself is cut off; a `write` to a file read in the same reply (before the model has seen it)
  is refused.
- **Lower temperature.** Local models run at temperature 0.2 unless you set `"ollama": {"temperature": …}`.
- **A fast model for side work.** `"models": {"fast": "ollama:qwen2.5-coder:1.5b"}` writes compaction summaries with a
  smaller model.

**`/bench`** (or `forge --bench [models…]` in a terminal) scores models on five small tasks (create a file, fix a bug,
find a fact, run a command, rename across two files), each in a throwaway folder, and prints a table with passes,
time and output speed. With no arguments it runs every installed Ollama model that supports tools. Set
`FORGE_BENCH_TRACE=1` to see what a model did on the tasks it failed.

### Context and tasks

- **Compaction.** When the conversation reaches 80% of the context window, Forge summarizes the older turns and keeps
  recent ones as they are, so long sessions keep going. `/compact [focus]` does it now, optionally steering the summary
  ("/compact the failing auth tests"). Turn it off with `"autoCompact": false`, or move the trigger with
  `"compactThreshold": 0.7`.
- **`/context`** shows what fills the window: system prompt, memory files, tool definitions, messages and tool results.
- **Tasks.** For multi-step work Forge keeps a task list (the `todo_write` tool), shown live above the prompt. Ctrl+T
  hides or shows it; `/todos` prints it. The list survives compaction and `--resume`.

### Subagents

Forge can hand a self-contained job to a subagent with the `task` tool. The subagent starts with a fresh context, does
the work with its own tools, and only its final report comes back, so broad searches don't fill the main
conversation. Several task calls in one reply run in parallel, and each shows its latest step under its card.

| Type | Tools | For |
|---|---|---|
| `explore` | read-only | finding where things are and how they work |
| `plan` | read-only | a step-by-step implementation plan |
| `general` | all (still permission-checked) | multi-step work: edits, commands |

With `run_in_background: true` the model carries on while the subagent works. When it finishes you see a notice, and
Forge passes its report to the model (if Forge is idle, it starts a turn to do that). `/agents` lists the types and
the background agents, and `/agents stop <id>` stops one. In `-p` mode, Forge waits for background agents before
exiting.

Add your own types as Markdown files in `~/.forge/agents/` or `<project>/.forge/agents/` (a project file overrides a
user file or built-in with the same name):

```markdown
---
name: reviewer
description: Reviews a diff for bugs and missing tests
tools: read, grep, glob, bash
model: fast
---
You review code changes. Run git diff, read what changed, and report bugs, risky changes and missing tests as a list.
```

`tools` is a list of tool names, `readonly`, or `all`; `model` is `inherit` (the default), `fast` (the
`models.fast` model), or a `provider:model` spec. A subagent never gets `task` itself, and in plan mode its edits
are refused like the main agent's.

### Sessions

Every conversation is saved as append-only JSONL under `~/.forge/sessions/<project>-<hash>/`.

```sh
forge --continue          # pick up the most recent session in this project
forge --resume            # choose from a list (or /resume inside the TUI)
forge --resume <id>       # by id or unique id prefix
forge --no-session        # don't save this one
```

`/cost` shows tokens and estimated cost (Anthropic list prices, including cache reads and writes).

### Checkpoints, rewind and branches

Every prompt you send is a checkpoint. Before `write` or `edit` changes a file, Forge keeps its old contents (once per
prompt; subagents' edits included), so you can go back:

- **Esc Esc** (or `/rewind`) opens a list of your prompts. Pick one, then restore the code and the conversation, only
  the conversation, or only the code, to how they were before that prompt. Files created since are removed.
  `/rewind <n> [both|chat|code]` does it directly.
- If a file changed outside Forge after Forge last wrote it, rewinding stops and lists it; add `--force` to overwrite.
  Changes made by shell commands (`bash`) aren't tracked or undone.
- **`/reset [--hard] [--to n]`**: drop the conversation back to prompt n (default: the start); `--hard` also restores
  the files.
- **`/fork`** copies the conversation into a new session and continues there; the original stays as it was.
  `/fork --worktree` creates a git worktree next to the repository on a new `forge/fork-…` branch with a copy of the
  conversation, and prints the command to continue there.
- **`/branch <n>`** forks, then goes back to before prompt n, so you can try it a different way. **`/branches`**
  shows the tree of forks; `/resume <id>` switches between them.
- **Saving permissions.** Permission prompts offer "Yes, and always allow `bash(npm test:*)` in this project", which
  adds the rule to `<project>/.forge/settings.json`.

### Goals, loops and budgets

- **`/goal <objective> [--check "<cmd>"] [--max-rounds N]`** keeps Forge working across turns. With a check (`/goal
  make the tests pass --check "npm test"`), Forge runs the command after every turn and gives the model the failing
  output until it exits 0. Without a check, the model keeps going until it says it has verified the goal. Default 8
  rounds; Esc stops it. Headless: `forge -p "make the tests pass" --check "npm test"` (exit code 0 if the goal is met).
- **`/loop <interval> <prompt>`** runs a prompt now and then every interval (`30s`, `10m`, `2h`), skipping a beat if
  Forge is busy. `/loop` lists loops; `/loop stop [id]` ends them.
- **Background commands.** The model can run `bash` with `run_in_background` (a long test run, a build) and carry on;
  the output arrives when the command exits, like a background agent's report. `/agents` lists running jobs.
- **Budgets.** `"budget": {"costUSD": 2, "tokens": 500000, "requestsPerPrompt": 40}` (or `/budget cost 2`,
  `/budget requests 40`, `/budget off`) stops the session or the current prompt when a limit is reached. Goals stop
  with it.

### Usage, stats and the status line

- **`/usage`** adds up every saved session: this session, today, the last 7 days, this month and all time, then this
  month by model and a 14-day sparkline. `/usage project` counts only this project. Local models show as `$0 (local)`.
- **`/stats`** shows sessions per day, prompts and active days, model requests per prompt, the tools and files used
  most, and a weekday × hour heatmap of when you work.
- **Status line.** `"statusLine": {"command": "…"}` runs a shell command after every turn and whenever the mode or model
  changes, and shows the first two lines of its output under the prompt. It gets the state as JSON on stdin:
  `session_id`, `cwd`, `model`, `permission_mode`, `context` (`tokens`, `window`, `percent`), `cost_usd` and `tokens`
  (`input`, `output`). For example, the git branch and context use:

```json
{ "statusLine": { "command": "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const b=require('child_process').execSync('git branch --show-current').toString().trim();console.log('⎇ '+b+' · ctx '+j.context.percent+'%')})\"" } }
```

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
