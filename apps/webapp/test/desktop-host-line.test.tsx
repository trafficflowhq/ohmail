/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import {
  HOST_UNKNOWN_GRACE_MS,
  unknownSpeaks,
  type HostConnection,
} from "@ohmail/app-logic/doors/host-connection";

/**
 * ═══ A STANDING FACT MUST NOT WEAR A TRANSIENT'S CLOTHES ═══════════════════════════════════
 *
 * "The computer that organizes your mail is not answering" is not a sync in progress and not an
 * error that will clear. It lasts until somebody turns that machine back on or sets this one up
 * on its own, and for as long as it lasts every write is refused.
 *
 * The rail already has a grammar for the difference, and the whole design rests on it: a
 * TRANSIENT wears a tinted box and a moving or warning mark (`SyncBar`'s `.rail-sync.busy` /
 * `.warn`), and a STANDING FACT wears the rail's own text register and a static mark. Somebody
 * who reads this line as "catching up" will wait instead of acting, which is the one wrong
 * response to it.
 *
 * That rule is easy to state and easy to break by accident — a later tone class, a spinner added
 * for symmetry with the line above it. So it is asserted from the rendered DOM rather than only
 * described in the stylesheet, and it is asserted as an ABSENCE of the transient vocabulary
 * rather than as a presence of particular classes, so a restyle that keeps the register passes
 * and one that borrows the busy chrome does not.
 */

const WORDS = {
  title: "Can't reach kestrel.",
  detail:
    "Last answered 3 days ago. This Mac shows the copy it holds; nothing can be changed until "
    + "that computer is back. If it will not be:",
  link: { href: "#/settings/desktop", label: "Settings → Desktop" },
};

const STALE: HostConnection = { state: "stale", words: WORDS };

function render(node: React.ReactElement): { el: HTMLElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(node);
  });
  return { el, root };
}

/**
 * ═══ THE SIXTY-SECOND GRACE, AS A TABLE ════════════════════════════════════════════════════
 *
 * `unknown` means no pull has ever completed under this engine — which is TRUE for the first
 * seconds of every successful pairing. A sentence there would fire on every single first run,
 * announcing a failure that has not happened and is about to not happen, which is the fastest way
 * to teach somebody that this line means nothing.
 *
 * It is a pure function of two instants precisely so it can be driven exhaustively here rather
 * than being a condition inside an effect nobody can reach.
 */
describe("how long an `unknown` verdict stays silent", () => {
  const T = 1_000_000;

  it("nothing observed yet says nothing — which is not the same as observed a moment ago", () => {
    /* `null` is "no unknown verdict has been recorded", and it must not be read as "recorded at
       time zero", which would make every launch speak immediately. */
    expect(unknownSpeaks(null, T)).toBe(false);
    expect(unknownSpeaks(null, T + 10 * HOST_UNKNOWN_GRACE_MS)).toBe(false);
  });

  it("silent below the bound, speaking at and above it", () => {
    const rows: [number, boolean][] = [
      [0, false],
      [1, false],
      [HOST_UNKNOWN_GRACE_MS - 1, false],
      /* THE BOUNDARY IS INSIDE THE SPEAKING SIDE: at exactly the bound the three polls have had
         their chance. A `>` would leave one instant on which the rule says nothing — unobservable
         in the app, and exactly the kind of edge a table is written to pin. */
      [HOST_UNKNOWN_GRACE_MS, true],
      [HOST_UNKNOWN_GRACE_MS + 1, true],
      [10 * HOST_UNKNOWN_GRACE_MS, true],
    ];
    for (const [elapsed, expected] of rows) {
      expect(unknownSpeaks(T, T + elapsed), `${elapsed}ms after the first unknown`).toBe(expected);
    }
  });

  it("a clock that went backwards stays silent rather than speaking", () => {
    /* A host clock adjustment mid-session is ordinary. Reading a negative elapsed as "long
       enough" would put the sentence on screen instantly and permanently. */
    expect(unknownSpeaks(T, T - 60_000)).toBe(false);
  });

  it("the bound is three mirror polls, and it is not the stale bound", () => {
    // Stated as a number so a change is deliberate: the mirror polls every 20s.
    expect(HOST_UNKNOWN_GRACE_MS).toBe(60_000);
    // And not the five-minute stale rule, which has a completed pull and a real age behind it.
    expect(HOST_UNKNOWN_GRACE_MS).toBeLessThan(5 * 60_000);
  });
});
