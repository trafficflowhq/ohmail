/**
 * THE STEP-UP DIALOG IN A REAL BROWSER, over a door the case answers by hand. `window.harness` holds each verify until
 * the case lands it, and counts what the place heard. A press on Cancel, Esc or the scrim closes the dialog, as a
 * place does; `?passkey=1` gives the account a passkey this browser can run.
 */
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createFeed } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { DoorStage } from "../../src/doors/stage/index.js";
import { StepUpDialog, type StepUpDoor, type StepUpVerified } from "../../src/doors/step-up/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };

interface Harness {
  readonly heard: { verified: number; cancelled: number; discarded: number; sent: number };
  /** Verifies sent and not answered yet. */
  held(): number;
  /** Answer the oldest verify still held. */
  land(answer: StepUpVerified): void;
  /** Whether the keys are inside the dialog, and on what. */
  keys(): { inside: boolean; on: string };
}

declare global {
  interface Window {
    harness: Harness;
  }
}

const passkey = new URLSearchParams(location.search).get("passkey") === "1";
const waiting: ((answer: StepUpVerified) => void)[] = [];
const heard = { verified: 0, cancelled: 0, discarded: 0, sent: 0 };
const door: StepUpDoor = {
  factors: () => Promise.resolve({ ok: true, factors: { passkey, code: true, recovery: true } }),
  verify: () => {
    heard.sent += 1;
    return new Promise<StepUpVerified>((resolve) => waiting.push(resolve));
  },
};

/** The place: the dialog mounted while it is open, closed by the place's own answers. */
function Place(): ReactNode {
  const [open, setOpen] = useState(true);
  if (!open) return <p>closed</p>;
  return (
    <StepUpDialog
      door={door}
      onVerified={() => {
        heard.verified += 1;
        setOpen(false);
      }}
      onCancel={() => {
        heard.cancelled += 1;
        setOpen(false);
      }}
      onDiscarded={() => {
        heard.discarded += 1;
      }}
    />
  );
}

window.harness = {
  heard,
  held: () => waiting.length,
  land: (answer) => waiting.shift()?.(answer),
  keys: () => {
    const at = document.activeElement;
    return {
      inside: !!at?.closest('[role="dialog"]'),
      on: at ? `${at.tagName.toLowerCase()} ${(at.textContent ?? "").trim().slice(0, 30)}` : "nothing",
    };
  },
};

const root = document.documentElement;
const device = () => ({
  window: createFeed({
    width: innerWidth,
    height: innerHeight,
    pointer: "fine",
    posture: "flat",
    reducedMotion: true,
  } as never),
  appearance: createFeed({ face: "paper", scheme: "light" } as never),
  root: {
    read: (name: string) => root.getAttribute(name),
    write: (name: string, value: string | null) =>
      value === null ? root.removeAttribute(name) : root.setAttribute(name, value),
  },
});
createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={en as never} timeZone="UTC">
    <DoorStage device={device}>
      <Place />
    </DoorStage>
  </TextProvider>,
);
