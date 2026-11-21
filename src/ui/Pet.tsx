import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { MouseEmitter } from "./mouseStdin.js";
import { effectLine, faceFor, type Mood, type PetKind } from "./pets.js";
import { useTheme } from "./theme.js";

/** What Forge is doing, which the pet reacts to when you're not playing with it. */
export type PetStatus = "idle" | "busy" | "done" | "error";

interface Props {
  kind: PetKind;
  name: string;
  status: PetStatus;
  /** When set, the status reverts to idle after this time (ms epoch). */
  statusUntil?: number;
  /** React to terminal mouse clicks (mouse reporting must be on). */
  clickable: boolean;
  /** Source of click events. */
  mouse?: MouseEmitter;
  /** Receives a function that pokes the pet (for /pet and Ctrl+P). */
  pokeRef?: { current?: () => void };
  /** Freeze the clock (tests, previews). */
  now?: () => number;
}

const TICK_MS = 250;
const COMBO_WINDOW_MS = 1200;
const SLEEP_AFTER_MS = 90_000;

interface Reaction {
  mood: Mood;
  until: number;
}

export function Pet({ kind, name, status: rawStatus, statusUntil, clickable, mouse, pokeRef, now = Date.now }: Props) {
  const t = useTheme();
  const [tick, setTick] = useState(0);
  const [reaction, setReaction] = useState<Reaction | undefined>();
  const [quip, setQuip] = useState<{ text: string; until: number } | undefined>();
  const [pats, setPats] = useState(0);
  const combo = useRef({ count: 0, last: 0 });
  const lastActive = useRef(now());

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (rawStatus !== "idle") lastActive.current = now();
  }, [rawStatus, now]);

  const poke = () => {
    const at = now();
    const c = combo.current;
    c.count = at - c.last < COMBO_WINDOW_MS ? c.count + 1 : 1;
    c.last = at;
    lastActive.current = at;
    setPats((p) => p + 1);
    if (c.count >= 10) {
      setReaction({ mood: "party", until: at + 2500 });
      setQuip({ text: c.count === 10 ? "PARTY!!!" : "MORE!!", until: at + 2500 });
    } else if (c.count >= 5) {
      setReaction({ mood: "dizzy", until: at + 1800 });
      setQuip({ text: "wheeee!", until: at + 1800 });
    } else {
      setReaction({ mood: c.count % 2 ? "happy" : "love", until: at + 1200 });
      setQuip({ text: kind.quips[Math.floor(Math.random() * kind.quips.length)]!, until: at + 1800 });
    }
  };
  if (pokeRef) pokeRef.current = poke;

  // Clicks arrive from the stdin mouse filter (Ink itself drops mouse reports).
  const pokeLatest = useRef(poke);
  pokeLatest.current = poke;
  useEffect(() => {
    if (!clickable || !mouse) return;
    const onClick = () => pokeLatest.current();
    mouse.on("click", onClick);
    return () => {
      mouse.off("click", onClick);
    };
  }, [clickable, mouse]);

  const at = now();
  const status = statusUntil !== undefined && at > statusUntil ? "idle" : rawStatus;
  const idleFor = at - lastActive.current;
  let mood: Mood;
  if (reaction && reaction.until > at) mood = reaction.mood;
  else if (status === "busy") mood = "work";
  else if (status === "done") mood = "done";
  else if (status === "error") mood = "oops";
  else if (idleFor > SLEEP_AFTER_MS) mood = "sleep";
  else mood = tick % 16 === 0 ? "blink" : "idle";

  // Wiggle faster when excited.
  const frame = mood === "party" || mood === "dizzy" ? tick % 2 : Math.floor(tick / 3) % 2;
  const body = kind.draw(faceFor(mood, tick), frame);
  const effect = effectLine(mood, tick);
  const bubble =
    quip && quip.until > at
      ? quip.text
      : mood === "sleep"
        ? "zzz…"
        : mood === "work"
          ? "…"
          : mood === "done"
            ? "yay!"
            : mood === "oops"
              ? "uh oh"
              : undefined;
  const partyColors = [t.accent, t.highlight, t.success, t.warning];
  const bodyColor = mood === "party" ? partyColors[tick % partyColors.length] : t.accent;

  return (
    <Box marginTop={1}>
      <Box flexDirection="column">
        <Text color={mood === "party" ? partyColors[(tick + 1) % partyColors.length] : t.warning}>{effect || " "}</Text>
        {body.map((line, i) => (
          <Text key={i} color={bodyColor}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={1} justifyContent="center">
        <Text>
          <Text bold color={t.accent}>
            {name}
          </Text>
          {pats ? <Text color={t.error}> ♥ {pats}</Text> : null}
        </Text>
        {bubble ? <Text color={t.highlight}>‹ {bubble} ›</Text> : null}
        {!pats && mood === "idle" ? <Text dimColor>{clickable ? "(click me! or Ctrl+P)" : "(Ctrl+P to pet)"}</Text> : null}
      </Box>
    </Box>
  );
}
