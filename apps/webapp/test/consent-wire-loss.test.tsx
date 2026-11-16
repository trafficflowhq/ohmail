/** @vitest-environment jsdom */

/**
 * NO WIRE ⇒ RESTING VALUES — the door-switch half of the consent contract.
 *
 * `local-consent.ts` states the READ half: a failed `GET /consent` leaves every flag at its
 * resting value. This file pins the WIRE half: a transport that is GONE leaves nothing behind
 * either. The sequence that makes it matter is the desktop's door chooser, which is an overlay
 * OVER the mounted shell — a hosted session with folders ON can switch to the standalone door
 * without `AppShell` ever unmounting, and before this guard the hook kept the departed
 * account's answers: a folders rail (whose verbs the local table does not serve — the
 * client-route census exempts them on exactly the premise this file defends), a signatures
 * pane over no rows, a spending switch reading a row that is no longer behind the window.
 *
 * Review-caught (the 0.12.0 release loop, two rounds): the first round's ruling said the gate
 * unmounts the shell on every door switch, and the second round produced the overlay
 * counterexample. The fix moved the rule into the hook, where it holds for every host.
 */

// Before ANY app import: this file's world has no browser API base, so reachability is the
// transport prop alone — the standalone door's exact shape. A pooled worker may have run a test
// that set this; empty string is `apiConfigured() === false` either way.
process.env.NEXT_PUBLIC_API_BASE = "";

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useConsentState, type ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { ConsentStateWire } from "../app/api-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-08-27T09:00:00.000Z";

/** A hosted account whose folders master switch is ON. */
const FOLDERS_ON: ConsentStateWire = {
  seedConfirmedAt: ISO,
  screeningResetAt: null,
  dormancyDays: 60,
  screeningBaselineAt: ISO,
  autoSuggestAt: null,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  blockAutoUnsubscribeAt: null,
  foldersEnabledAt: ISO,
} as ConsentStateWire;

const hostedStub: ConsentTransport = {
  /* A hosted table mounts the folder verbs; this file is about what happens to a wire that goes
     AWAY, not about the capability, so it declares the ordinary answer. */
  foldersStorable: true,
  state: () => Promise.resolve(FOLDERS_ON),
  setAutoSuggest: () => Promise.reject(new Error("unused")),
  setDormancyDays: () => Promise.reject(new Error("unused")),
  setBlockRemoteImages: () => Promise.reject(new Error("unused")),
  setBlockTrackingPixels: () => Promise.reject(new Error("unused")),
  setBlockAutoUnsubscribe: () => Promise.reject(new Error("unused")),
  setFoldersEnabled: () => Promise.reject(new Error("unused")),
  setMailboxFoldersEnabled: () => Promise.reject(new Error("unused")),
  setMailboxSignature: () => Promise.reject(new Error("unused")),
};

/** The latest hook answer, readable from outside the tree. */
let seen: { known: boolean; foldersEnabled: boolean } | null = null;
/** EVERY render's answer, in order — frame zero after a switch is the one the review cared about. */
let frames: Array<{ known: boolean; foldersEnabled: boolean }> = [];
/** Every render's answer to "do pictures wait for a press", in the same order. */
let pictureFrames: boolean[] = [];
/** The hook's setters, reachable from the test — the in-flight-write case presses one. */
let api: ReturnType<typeof useConsentState> | null = null;

function Probe(props: { transport: ConsentTransport | "none" }) {
  const consent = useConsentState(true, null, props.transport);
  seen = { known: consent.known, foldersEnabled: consent.foldersEnabled };
  frames.push(seen);
  pictureFrames.push(consent.blockRemoteImages);
  api = consent;
  return null;
}

const flush = async () => {
  // Two macrotask turns: the fetch's promise chain, then React's follow-up commit.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  seen = null;
  frames = [];
  pictureFrames = [];
  api = null;
});

describe("useConsentState when the wire disappears (the overlay door switch)", () => {
  it("a hosted answer is dropped for RESTING the moment the transport is gone", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => { root!.render(<Probe transport={hostedStub} />); });
    await flush();
    expect(seen, "the hosted read never landed — the harness is broken").toEqual({
      known: true,
      foldersEnabled: true,
    });

    // The overlay switch: same mounted tree, the transport prop is simply no longer handed in.
    await act(async () => { root!.render(<Probe transport="none" />); });
    await flush();
    expect(seen).toEqual({ known: false, foldersEnabled: false });
  });

  it("a read still in flight from the old wire cannot resurrect the departed account", async () => {
    // The wire answers only after the switch — the race the write-epoch bump exists for.
    let release: (() => void) | null = null;
    const slow: ConsentTransport = {
      ...hostedStub,
      state: () =>
        new Promise<ConsentStateWire>((resolve) => {
          release = () => resolve(FOLDERS_ON);
        }),
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => { root!.render(<Probe transport={slow} />); });
    await flush();
    expect(seen).toEqual({ known: false, foldersEnabled: false });

    await act(async () => { root!.render(<Probe transport="none" />); });
    await flush();

    await act(async () => { release!(); });
    await flush();
    expect(seen).toEqual({ known: false, foldersEnabled: false });
  });

  it("the VERY FIRST unreachable render already presents resting values — no departed frame", async () => {
    // The reset effect runs after paint; presentation must not wait for it. Frame zero after
    // the switch — the render React commits before any effect fires — is asserted directly.
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => { root!.render(<Probe transport={hostedStub} />); });
    await flush();
    expect(seen).toEqual({ known: true, foldersEnabled: true });

    expect(pictureFrames.at(-1), "the hosted account lets pictures load: the frame below would prove nothing").toBe(false);
    frames = [];
    pictureFrames = [];
    await act(async () => { root!.render(<Probe transport="none" />); });
    expect(frames[0], "the switch's first committed frame carried the departed account").toEqual({
      known: false,
      foldersEnabled: false,
    });
    expect(pictureFrames[0], "the switch's first committed frame let pictures load by the departed account's row").toBe(true);
  });

  it("a consent WRITE resolving after the switch cannot resurrect the departed account", async () => {
    // The desktop bridge lets an in-flight request finish against a replaced engine, so a
    // hosted PATCH can land after the door switch. Its echo must not re-enter this hook —
    // neither while unreachable, nor when the hosted door is re-entered later (the stored
    // state, not just the presented one, has to refuse it).
    let release: (() => void) | null = null;
    const slowWrite: ConsentTransport = {
      ...hostedStub,
      setFoldersEnabled: () =>
        new Promise((resolve) => {
          release = () => resolve({ foldersEnabledAt: ISO });
        }),
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => { root!.render(<Probe transport={slowWrite} />); });
    await flush();

    let pressed: Promise<boolean> | null = null;
    await act(async () => { pressed = api!.setFoldersEnabled(true); });
    await act(async () => { root!.render(<Probe transport="none" />); });
    await flush();

    await act(async () => { release!(); await pressed; });
    await flush();
    expect(seen).toEqual({ known: false, foldersEnabled: false });

    // Re-enter the hosted door with a wire that never answers its read: the stale echo must
    // not be sitting in stored state waiting to be presented again.
    const silent: ConsentTransport = { ...hostedStub, state: () => new Promise(() => {}) };
    await act(async () => { root!.render(<Probe transport={silent} />); });
    await flush();
    expect(seen).toEqual({ known: false, foldersEnabled: false });
  });
});
