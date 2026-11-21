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

Local models have small context windows; set `"ollama": {"contextWindow": 32768}` to match yours. Small local models
that write tool calls as JSON text instead of using native tool calls are handled too.

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

## Development

```sh
pnpm typecheck
pnpm test
pnpm build      # dist/cli.js
```

## License

MIT
