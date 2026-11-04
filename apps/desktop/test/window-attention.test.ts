import { describe, expect, it } from "vitest";
import {
  ATTENTION_SIGNAL_GAP_MS, WINDOW_ATTENTION_PATH, startWindowAttentionRelay,
} from "../src/window-attention.js";

/**
 * A person reading mail the window already holds makes no request, so the window reports their input
 * to the Cloud door, which starts its poll over (`apps/sidecar/test/cloud-mirror-walled.test.ts` drives
 * the two together). This is the window half: which input counts, the throttle, and on which door.
 */

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function relayOn(cloud: boolean | (() => Promise<boolean>), post?: (p: string) => Promise<unknown>) {
  const target = new EventTarget();
  const posted: string[] = [];
  let clock = 0;
  const stop = startWindowAttentionRelay({
    target,
    isCloudDoor: typeof cloud === "function" ? cloud : async () => cloud,
    post: post ?? (async (path) => { posted.push(path); }),
    now: () => clock,
  });
  return { target, posted, stop, tick: (ms: number): void => { clock += ms; } };
}

describe("a person's input, relayed to the Cloud door", () => {
  it("each kind of input is a signal: pointer, key, wheel, scroll and focus", async () => {
    for (const kind of ["pointerdown", "keydown", "wheel", "scroll", "focus"]) {
      const { target, posted } = relayOn(true);
      target.dispatchEvent(new Event(kind));
      await settle();
      expect(posted, kind).toEqual([WINDOW_ATTENTION_PATH]);
    }
  });

  it("a pointer moving over the window is not a signal", async () => {
    const { target, posted } = relayOn(true);
    target.dispatchEvent(new Event("pointermove"));
    target.dispatchEvent(new Event("mousemove"));
    await settle();
    expect(posted).toEqual([]);
  });

  it("caps the signals at one per gap, however much input arrives", async () => {
    const { target, posted, tick } = relayOn(true);
    // Two minutes of scrolling, an event every 50 ms: 2400 events.
    for (let at = 0; at < 120_000; at += 50) {
      target.dispatchEvent(new Event("wheel"));
      tick(50);
    }
    await settle();
    expect(posted.length).toBe(120_000 / ATTENTION_SIGNAL_GAP_MS);
  });

  it("input every 3.5 s signals every other time, so never more than 4 s of the person goes unreported twice", async () => {
    const { target, posted, tick } = relayOn(true);
    for (let i = 0; i < 6; i++) {
      target.dispatchEvent(new Event("pointerdown"));
      await settle();
      tick(3_500);
    }
    expect(posted).toHaveLength(3);
  });

  it("posts nothing on a local door, and a door it could not ask or a refused post is dropped", async () => {
    const local = relayOn(false);
    local.target.dispatchEvent(new Event("keydown"));
    const unreadable = relayOn(async () => { throw new Error("no shell"); });
    unreadable.target.dispatchEvent(new Event("keydown"));
    const refusing = relayOn(true, async () => { throw new Error("engine gone"); });
    refusing.target.dispatchEvent(new Event("keydown"));
    await settle();
    expect(local.posted).toEqual([]);
    expect(unreadable.posted).toEqual([]);
  });

  it("stops when disarmed", async () => {
    const { target, posted, stop } = relayOn(true);
    stop();
    target.dispatchEvent(new Event("keydown"));
    await settle();
    expect(posted).toEqual([]);
  });
});
