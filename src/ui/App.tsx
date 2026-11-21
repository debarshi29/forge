import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../agent/loop.js";
import { matchCommands, parseCommand, switchTo, type CommandContext } from "../commands/index.js";
import type { ModelOption } from "../providers/catalog.js";
import { ModelPicker } from "./ModelPicker.js";
import { ThemePicker } from "./ThemePicker.js";
import { Pet, type PetStatus } from "./Pet.js";
import { PetPicker } from "./PetPicker.js";
import type { MouseEmitter } from "./mouseStdin.js";
import { findPet, isMouseInput, MOUSE_OFF, MOUSE_ON } from "./pets.js";

/** Pet choice as saved in settings. kind "none" means no pet. */
export interface PetSettings {
  kind: string;
  name?: string;
  clicks: boolean;
}
import { DEFAULT_THEME, findTheme, ThemeContext, type Theme } from "./theme.js";
import type { AskAnswer, AskFn, PermissionMode, PermissionRequest } from "../permissions/index.js";
import { formatCost } from "../agent/cost.js";
import type { MemoryFile } from "../agent/memory.js";
import { listSessions, resumeInto, Session, type SessionInfo } from "../agent/session.js";
import { formatElapsed, formatTokens } from "./format.js";
import { messagesToItems } from "./history.js";
import { SessionPicker } from "./SessionPicker.js";
import { Input, type Suggestion } from "./Input.js";
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
  /** Theme to start with. */
  initialTheme?: Theme;
  /** Persist a theme choice (wired by the CLI). */
  saveTheme?(name: string): void;
  /** Saved pet settings to start with. */
  initialPet?: PetSettings;
  /** Persist pet settings (wired by the CLI). */
  savePet?(pet: PetSettings): void;
  /** Mouse click events from the filtered stdin (see mouseStdin.ts). */
  mouse?: MouseEmitter;
}

type ItemInput = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan"];
const MODE_LABEL: Record<PermissionMode, string> = {
  default: "ask before edits & commands",
  acceptEdits: "auto-accept edits",
  plan: "plan mode (read-only)",
  bypass: "bypass permissions",
};

export function App({ agent, root, bridge, allowBypass, initialPrompt, pickSession, initialItems, memory = [], env = process.env, switchModel, listModels, initialTheme = DEFAULT_THEME, saveTheme, initialPet, savePet, mouse }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const nextId = useRef(1);
  const [items, setItems] = useState<Item[]>(() => [
    { id: 0, kind: "banner", model: agent.modelSpec, root },
    ...(initialItems ?? []).map((it) => ({ ...it, id: nextId.current++ }) as Item),
  ]);
  const [sessions, setSessions] = useState<SessionInfo[] | undefined>(() => (pickSession ? listSessions(root, env) : undefined));
  const [pickingModel, setPickingModel] = useState(false);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [previewTheme, setPreviewTheme] = useState<Theme | undefined>();
  const [pickingTheme, setPickingTheme] = useState(false);
  const [pet, setPetState] = useState<PetSettings>(() => initialPet ?? { kind: "none", clicks: false });
  const [pickingPet, setPickingPet] = useState(false);
  const [petFlash, setPetFlash] = useState<{ status: PetStatus; until: number } | undefined>();
  const pokeRef = useRef<() => void>(undefined);
  const petKind = findPet(pet.kind);
  const [verb, setVerb] = useState(initialTheme.verbs[0]!);
  const t = previewTheme ?? theme;
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
      setVerb(t.verbs[Math.floor(Math.random() * t.verbs.length)]!);
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
              // The final message is authoritative: adapters may strip text
              // (e.g. tool calls a local model wrote as JSON) after streaming.
              textBuf.current = ev.message.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
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
              flashPet(ev.stop === "end_turn" ? "done" : ev.stop === "aborted" ? "idle" : "error");
              if (ev.stop === "aborted") push({ kind: "info", text: "Interrupted.", tone: "warn" });
              else if (ev.stop === "refusal") push({ kind: "info", text: `The model declined to continue${ev.detail ? `: ${ev.detail}` : "."}`, tone: "warn" });
              else if (ev.stop === "max_tokens") push({ kind: "info", text: "Response cut off at max_tokens.", tone: "warn" });
              break;
          }
        }
      } catch (err) {
        flush();
        flashPet("error");
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
    openThemePicker: () => setPickingTheme(true),
    openPetPicker: () => setPickingPet(true),
    pet: petKind ? { kind: petKind.label, name: pet.name ?? petKind.defaultName, clicks: pet.clicks } : undefined,
    updatePet: (patch) => updatePet(patch),
    pokePet: () => pokeRef.current?.(),
    setTheme: (name) => {
      const next = findTheme(name);
      if (!next) return false;
      applyTheme(next);
      return true;
    },
    themeName: theme.name,
    print: (text, tone) => push({ kind: "info", text, tone }),
    clearTranscript: () => resetTranscript(),
    startNewSession: () => {
      if (agent.recorder) agent.setRecorder(new Session(root, agent.modelSpec, { env }));
    },
    openResume: () => setSessions(listSessions(root, env)),
    setMode,
    exit: () => exit(),
  };
  // submit is memoised, so it reads the context through a ref; otherwise
  // commands would see state from an earlier render (e.g. "no pet yet").
  const commandCtxRef = useRef(commandCtx);
  commandCtxRef.current = commandCtx;

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      const cmd = parseCommand(text);
      if (cmd) {
        push({ kind: "user", text });
        if (!cmd.command) return push({ kind: "info", text: `Unknown command /${cmd.name}. Try /help.`, tone: "error" });
        void Promise.resolve(cmd.command.run(cmd.args, commandCtxRef.current)).catch((err: unknown) =>
          push({ kind: "info", text: String(err), tone: "error" }),
        );
        return;
      }
      if (busy) return;
      push({ kind: "user", text });
      void runTurn(text);
    },
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

  // Global keys: interrupt, mode cycling, petting.
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.ctrl && input === "p") {
      pokeRef.current?.();
      return;
    }
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

  /** Keep a theme: persist it and redraw the transcript in its colours. */
  function applyTheme(next: Theme) {
    setPreviewTheme(undefined);
    setThemeState(next);
    saveTheme?.(next.name);
    stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setStaticKey((k) => k + 1);
  }

  function flashPet(status: PetStatus) {
    setPetFlash(status === "idle" ? undefined : { status, until: Date.now() + 4000 });
  }

  function updatePet(patch: Partial<PetSettings>) {
    setPetState((prev) => {
      const next = { ...prev, ...patch };
      savePet?.(next);
      return next;
    });
  }

  // Terminal mouse reporting, only while a clickable pet is on screen.
  const mouseOn = Boolean(petKind && pet.clicks);
  useEffect(() => {
    if (!mouseOn) return;
    stdout.write(MOUSE_ON);
    return () => {
      stdout.write(MOUSE_OFF);
    };
  }, [mouseOn, stdout]);

  const petStatus: PetStatus = busy ? "busy" : (petFlash?.status ?? "idle");

  const ctxPct = agent.lastInputTokens ? Math.round((agent.lastInputTokens / agent.contextWindow) * 100) : 0;

  return (
    <ThemeContext.Provider value={t}>
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
        {(item) => <ItemView key={item.id} item={item} />}
      </Static>

      {petKind && (
        <Pet kind={petKind} name={pet.name ?? petKind.defaultName} status={petStatus} statusUntil={busy ? undefined : petFlash?.until} clickable={mouseOn} mouse={mouse} pokeRef={pokeRef} />
      )}

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
          <Text color={t.accent}>{t.spinner[Math.floor(now / 120) % t.spinner.length]} </Text>
          <Text dimColor>
            {running.length ? `Running ${running.map((r) => r.name).join(", ")}` : liveText ? "Writing" : verb}… (
            {formatElapsed(now - startedAt)} · esc to interrupt)
          </Text>
        </Box>
      )}

      {pickingPet && !busy && (
        <PetPicker
          current={pet.kind}
          onCancel={() => setPickingPet(false)}
          onPick={(kind) => {
            setPickingPet(false);
            if (!kind) {
              updatePet({ kind: "none" });
              push({ kind: "info", text: "Pet hidden. /pets to adopt one again." });
              return;
            }
            const name = kind.name === pet.kind ? (pet.name ?? kind.defaultName) : kind.defaultName;
            updatePet({ kind: kind.name, name });
            push({ kind: "info", text: `You adopted ${name} the ${kind.label.toLowerCase()}! Press Ctrl+P to pet it, or /pet clicks on to pet it with the mouse.` });
          }}
        />
      )}

      {pickingTheme && !busy && (
        <ThemePicker
          current={theme.name}
          onPreview={setPreviewTheme}
          onCancel={() => {
            setPickingTheme(false);
            setPreviewTheme(undefined);
          }}
          onPick={(next) => {
            setPickingTheme(false);
            applyTheme(next);
            push({ kind: "info", text: `${next.icon} Theme set to ${next.label}.` });
          }}
        />
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
          active={!pending && !((sessions || pickingModel || pickingTheme || pickingPet) && !busy)}
          placeholder={busy ? "Working… (type /help, or Esc to interrupt)" : "Ask Forge to do something"}
          onSubmit={submit}
          onCtrlC={onCtrlC}
          suggest={slashSuggestions}
        />
        <Box justifyContent="space-between" paddingX={1}>
          <Text color={mode === "default" ? t.muted : mode === "plan" ? t.highlight : mode === "bypass" ? t.error : t.warning}>
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
    </ThemeContext.Provider>
  );
}

/** Slash-menu entries while typing a command name (before any space). */
function slashSuggestions(value: string): Suggestion[] {
  return value.startsWith("/") && !/\s/.test(value) ? matchCommands(value) : [];
}

