# Forge

A from-scratch terminal coding agent in the spirit of Claude Code and Codex CLI: a streaming REPL where an LLM reads, edits, and runs code in your project through tools, gated by permissions.

- **Provider-agnostic:** Anthropic Claude (first-class), Google Gemini, OpenAI, and Ollama / OpenAI-compatible local models.
- **Built in TypeScript** on Node 22+.
- **Planned features:** rich Ink TUI, permission modes and plan mode, hooks, sessions and resume, context compaction, subagents, MCP client.

> Status: early development. See [PLAN.md](PLAN.md) for the architecture and milestones.

## Development

```sh
pnpm install
pnpm dev -p "your prompt"   # headless mode
pnpm test
```

## License

MIT
