import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface MouseEvent {
  button: number;
  x: number;
  y: number;
  press: boolean;
}

/** Emits "click" (left-button presses) and "mouse" (every report). */
export type MouseEmitter = EventEmitter<{ click: [MouseEvent]; mouse: [MouseEvent] }>;

type TtyLike = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  ref?(): unknown;
  unref?(): unknown;
};

// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Ink drops terminal mouse reports before they reach useInput, so we filter
 * them out of stdin ourselves: clicks become events, everything else is
 * passed through to Ink unchanged.
 */
export function filterMouse(src: TtyLike): { stdin: NodeJS.ReadStream; mouse: MouseEmitter; dispose(): void } {
  const mouse: MouseEmitter = new EventEmitter();
  const out = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode(mode: boolean): unknown;
    ref(): unknown;
    unref(): unknown;
  };
  out.isTTY = src.isTTY;
  out.setRawMode = (mode: boolean) => {
    src.setRawMode?.(mode);
    return out;
  };
  out.ref = () => {
    src.ref?.();
    return out;
  };
  out.unref = () => {
    src.unref?.();
    return out;
  };

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const rest = text.replace(SGR_MOUSE, (_m, b: string, x: string, y: string, kind: string) => {
      const ev = { button: Number(b), x: Number(x), y: Number(y), press: kind === "M" };
      mouse.emit("mouse", ev);
      if (ev.press && ev.button === 0) mouse.emit("click", ev);
      return "";
    });
    if (rest) out.write(rest);
  };
  src.on("data", onData);

  return {
    stdin: out as unknown as NodeJS.ReadStream,
    mouse,
    dispose() {
      src.off("data", onData);
      (src as { pause?(): void }).pause?.();
      out.end();
    },
  };
}
