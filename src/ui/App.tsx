import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../agent/loop.js";
import { matchCommands, parseCommand, switchTo, type CommandContext } from "../commands/index.js";
import type { ModelOption } from "../providers/catalog.js";
import { ModelPicker } from "./ModelPicker.js";
import type { AskAnswer, AskFn, PermissionMode, PermissionRequest } from "../permissions/index.js";
import { formatCost } from "../agent/cost.js";
import type { MemoryFile } from "../agent/memory.js";
import { listSessions, resumeInto, Session, type SessionInfo } from "../agent/session.js";
import { formatElapsed, formatTokens } from "./format.js";
import { messagesToItems } from "./history.js";
import { SessionPicker } from "./SessionPicker.js";
import { Input } from "./Input.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { ItemView, ToolCard, type Item } from "./Transcript.js";

/** Lets the Permissions object (created before render) ask through the UI. */
export interface AskBridge {
  ask?: AskFn;
}

interface Props {
  agent: Agent;
  root: string;
  bridge: AskBridge;
  allowBypass: boolean;
  initialPrompt?: string;
  /** Open the session picker on start (`forge --resume` without an id). */
  pickSession?: boolean;
  /** Transcript of a session resumed from the command line. */
  initialItems?: ItemInput[];
  /** Memory files in effect, for /memory. */
  memory?: MemoryFile[];
  env?: NodeJS.ProcessEnv;
  /** Switch provider/model (wired by the CLI, which knows the settings). */
  switchModel?(spec: string): Promise<void>;
  /** Models for the /model picker (wired by the CLI). */
  listModels?(): Promise<ModelOption[]>;
}

type ItemInput = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan"];
const MODE_LABEL: Record<PermissionMode, string> = {
  default: "ask before edits & commands",
  acceptEdits: "auto-accept edits",
  plan: "plan mode (read-only)",
  bypass: "bypass permissions",
};

export function App({ agent, root, bridge, allowBypass, initialPrompt, pickSession, initialItems, memory = [], env = process.env, switchModel, listModels }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const nextId = useRef(1);
  const [items, setItems] = useState<Item[]>(() => [
    { id: 0, kind: "banner", model: agent.modelSpec, root },
    ...(initialItems ?? []).map((it) => ({ ...it, id: nextId.current++ }) as Item),
  ]);
  const [sessions, setSessions] = useState<SessionInfo[] | undefined>(() => (pickSession ? listSessions(root, env) : undefined));
  const [pickingModel, setPickingModel] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[] | undefined>();
  const [staticKey, setStaticKey] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [running, setRunning] = useState<Array<{ id: string; name: string; summary: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<{ req: PermissionRequest; resolve(a: AskAnswer): void } | undefined>();
  const [mode, setModeState] = useState<PermissionMode>(agent.permissions.mode);
  const [inputValue, setInputValue] = useState("");
  const [, setUsageTick] = useState(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastCtrlC = useRef(0);

  // Buffers mirrored in refs so flushes inside the event loop see current text.
  const textBuf = useRef("");
  const thinkBuf = useRef("");
  const summaries = useRef(new Map<string, string>());

  const push = useCallback((item: ItemInput) => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ } as Item]);
  }, []);

  const flush = useCallback(() => {
    if (thinkBuf.current.trim()) push({ kind: "thinking", text: thinkBuf.current });
    if (textBuf.current.trim()) push({ kind: "assistant", text: textBuf.current });
    thinkBuf.current = "";
    textBuf.current = "";
    setLiveText("");
    setLiveThinking("");
  }, [push]);

  const setMode = useCallback(
    (m: PermissionMode) => {
      agent.permissions.mode = m;
      setModeState(m);
    },
    [agent],
  );

  useEffect(() => {
    bridge.ask = (req) => new Promise<AskAnswer>((resolve) => setPending({ req, resolve }));
    return () => {
      bridge.ask = undefined;
    };
  }, [bridge]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [busy]);

  const runTurn = useCallback(
    async (prompt: string) => {
      const ac = new AbortController();
      abortRef.current = ac;
      setBusy(true);
      setStartedAt(Date.now());
      setNow(Date.now());
      try {
        for await (const ev of agent.send(prompt, ac.signal)) {
          switch (ev.type) {
            case "thinking_delta":
              thinkBuf.current += ev.text;
              setLiveThinking(thinkBuf.current);
              break;
            case "text_delta":
              textBuf.current += ev.text;
              setLiveText(textBuf.current);
              break;
            case "assistant_message":
              flush();
              setUsageTick((n) => n + 1);
              break;
            case "tool_start":
              flush();
              summaries.current.set(ev.id, ev.summary);
              setRunning((r) => [...r, { id: ev.id, name: ev.name, summary: ev.summary }]);
              break;
            case "tool_end":
              setRunning((r) => r.filter((x) => x.id !== ev.id));
              push({ kind: "tool", name: ev.name, summary: summaries.current.get(ev.id) ?? "", result: ev.result });
              summaries.current.delete(ev.id);
              break;
            case "retry":
              push({ kind: "info", text: `Stream interrupted (${ev.reason}); retrying…`, tone: "warn" });
              break;
            case "done":
              flush();
              if (ev.stop === "aborted") push({ kind: "info", text: "Interrupted.", tone: "warn" });
              else if (ev.stop === "refusal") push({ kind: "info", text: `The model declined to continue${ev.detail ? `: ${ev.detail}` : "."}`, tone: "warn" });
              else if (ev.stop === "max_tokens") push({ kind: "info", text: "Response cut off at max_tokens.", tone: "warn" });
              break;
          }
        }
      } catch (err) {
        flush();
        push({ kind: "info", text: `Error: ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
      } finally {
        abortRef.current = undefined;
        setRunning([]);
        setBusy(false);
        setUsageTick((n) => n + 1);
      }
    },
    [agent, flush, push],
  );

  const resetTranscript = (extra: ItemInput[] = []) => {
    // Static output can't be erased; clear the screen and start a new Static.
    stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setItems([
      { id: nextId.current++, kind: "banner", model: agent.modelSpec, root },
      ...extra.map((it) => ({ ...it, id: nextId.current++ }) as Item),
    ]);
    setStaticKey((k) => k + 1);
  };

  const resume = (info: SessionInfo) => {
    setSessions(undefined);
    try {
      const loaded = resumeInto(agent, root, info, env);
      resetTranscript([
        ...messagesToItems(loaded.messages, agent.tools),
        { kind: "info", text: `Resumed session ${info.id} (${loaded.messages.length} messages).` },
      ]);
      setUsageTick((n) => n + 1);
    } catch (err) {
      push({ kind: "info", text: `Could not resume: ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
    }
  };

  const commandCtx: CommandContext = {
    agent,
    allowBypass,
    memory,
    switchModel: switchModel
      ? async (spec: string) => {
          await switchModel(spec);
          setUsageTick((n) => n + 1);
        }
      : undefined,
    openModelPicker: listModels
      ? () => {
          setModelOptions(undefined);
          setPickingModel(true);
          void listModels().then(setModelOptions, (err: unknown) => {
            setPickingModel(false);
            push({ kind: "info", text: `Could not list models: ${String(err)}`, tone: "error" });
          });
        }
      : undefined,
    print: (text, tone) => push({ kind: "info", text, tone }),
    clearTranscript: () => resetTranscript(),
    startNewSession: () => {
      if (agent.recorder) agent.setRecorder(new Session(root, agent.modelSpec, { env }));
    },
    openResume: () => setSessions(listSessions(root, env)),
    setMode,
    exit: () => exit(),
  };

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      const cmd = parseCommand(text);
      if (cmd) {
        push({ kind: "user", text });
        if (!cmd.command) return push({ kind: "info", text: `Unknown command /${cmd.name}. Try /help.`, tone: "error" });
        void Promise.resolve(cmd.command.run(cmd.args, commandCtx)).catch((err: unknown) =>
          push({ kind: "info", text: String(err), tone: "error" }),
        );
        return;
      }
      if (busy) return;
      push({ kind: "user", text });
      void runTurn(text);
    },
    // commandCtx is rebuilt each render; that's fine for these callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, push, runTurn],
  );

  useEffect(() => {
    if (initialPrompt) submit(initialPrompt);
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const interrupt = useCallback(() => {
    if (pending) {
      pending.resolve({ kind: "no", reason: "interrupted by the user" });
      setPending(undefined);
    }
    abortRef.current?.abort();
  }, [pending]);

  // Global keys: interrupt, mode cycling.
  useInput((input, key) => {
    if (key.tab && key.shift) {
      const cycle = allowBypass ? [...MODE_CYCLE, "bypass" as const] : MODE_CYCLE;
      setMode(cycle[(cycle.indexOf(mode) + 1) % cycle.length]!);
      return;
    }
    if (busy && (key.escape || (key.ctrl && input === "c"))) interrupt();
  });

  const onCtrlC = (value: string) => {
    if (busy || value) return;
    const t = Date.now();
    if (t - lastCtrlC.current < 1500) exit();
    else push({ kind: "info", text: "Press Ctrl+C again to exit." });
    lastCtrlC.current = t;
  };

  const ctxPct = agent.lastInputTokens ? Math.round((agent.lastInputTokens / agent.contextWindow) * 100) : 0;
  const suggestions = inputValue.startsWith("/") && !inputValue.includes(" ") ? matchCommands(inputValue) : [];

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
        {(item) => <ItemView key={item.id} item={item} />}
      </Static>

      {liveThinking && !liveText && (
        <Box marginTop={1}>
          <Text dimColor italic>
            ∴ {liveThinking.trim().split("\n").slice(-4).join("\n")}
          </Text>
        </Box>
      )}
      {liveText && (
        <Box marginTop={1}>
          <Text>{liveText}</Text>
        </Box>
      )}
      {running.map((r) => (
        <ToolCard key={r.id} name={r.name} summary={r.summary} running />
      ))}

      {busy && !pending && (
        <Box marginTop={1}>
          <Text color="magenta">{SPINNER[Math.floor(now / 120) % SPINNER.length]} </Text>
          <Text dimColor>
            {running.length ? `Running ${running.map((r) => r.name).join(", ")}` : liveText ? "Writing" : "Thinking"}… (
            {formatElapsed(now - startedAt)} · esc to interrupt)
          </Text>
        </Box>
      )}

      {pickingModel && !busy && (
        <ModelPicker
          options={modelOptions}
          current={agent.modelSpec}
          onCancel={() => setPickingModel(false)}
          onPick={(o) => {
            setPickingModel(false);
            if (o.spec !== agent.modelSpec) void switchTo(o.spec, commandCtx);
          }}
        />
      )}

      {sessions && !busy && (
        <SessionPicker sessions={sessions} onPick={resume} onCancel={() => setSessions(undefined)} />
      )}

      {pending && (
        <PermissionDialog
          request={pending.req}
          onAnswer={(a) => {
            pending.resolve(a);
            setPending(undefined);
          }}
        />
      )}

      <Box marginTop={1} flexDirection="column">
        <Input
          active={!pending && !((sessions || pickingModel) && !busy)}
          placeholder={busy ? "Working… (type /help, or Esc to interrupt)" : "Ask Forge to do something"}
          onSubmit={submit}
          onChange={setInputValue}
          onCtrlC={onCtrlC}
        />
        {suggestions.map((c) => (
          <Text key={c.name} dimColor>
            {"  "}/{c.name}
            {c.args ? ` ${c.args}` : ""} <Text color="gray">— {c.description}</Text>
          </Text>
        ))}
        <Box justifyContent="space-between" paddingX={1}>
          <Text color={mode === "default" ? "gray" : mode === "plan" ? "cyan" : mode === "bypass" ? "red" : "yellow"}>
            {mode === "default" ? "" : "⏵⏵ "}
            {MODE_LABEL[mode]} <Text dimColor>(shift+tab)</Text>
          </Text>
          <Text dimColor>
            {agent.modelSpec} · ctx {ctxPct}% · {formatTokens(agent.usage.inputTokens)}↑ {formatTokens(agent.usage.outputTokens)}↓ ·{" "}
            {formatCost(agent.costUSD)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
