# Forge

A from-scratch terminal coding agent in the spirit of Claude Code and Codex CLI: a streaming REPL where an LLM reads, edits, and runs code in your project through tools, gated by permissions.

- **Provider-agnostic:** Anthropic Claude (first-class), Google Gemini, OpenAI, and Ollama / OpenAI-compatible local models.
- **Built in TypeScript** on Node 22+.
- **Planned features:** rich Ink TUI, permission modes and plan mode, hooks, sessions and resume, context compaction, subagents, MCP client.

> Status: early development. See [PLAN.md](PLAN.md) for the architecture and milestones.

## Usage

Needs Node 22+ and Anthropic credentials (`ANTHROPIC_API_KEY`, or `ant auth login`).

```sh
pnpm install
pnpm dev                                   # interactive (line REPL for now)
pnpm dev -p "create hello.ts that prints hi, then run it"
pnpm dev -p "..." --output json            # one JSON event per line
pnpm dev -p "..." --permission-mode acceptEdits
```

Options: `--model provider:model` (default `anthropic:claude-opus-5-5`), `--effort low|medium|high|xhigh|max`,
`--permission-mode default|acceptEdits|plan|bypass`, `--cwd <dir>`.

Settings are merged from `~/.forge/settings.json`, then `<project>/.forge/settings.json`, then `FORGE_MODEL`, then flags:

```json
{ "model": "anthropic:claude-opus-5-5", "effort": "high", "permissionMode": "default" }
```

## Development

```sh
pnpm typecheck
pnpm test
pnpm build      # dist/cli.js
```

## License

MIT
