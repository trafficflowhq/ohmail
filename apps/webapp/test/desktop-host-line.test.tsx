/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { HostConnectionLine } from "../app/shell/HostConnectionLine";
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

describe("the line the rail shows when the other computer is not answering", () => {
  it("says the fact, the age, and where to go — in that order", () => {
    const { el, root } = render(<HostConnectionLine connection={STALE} />);
    const line = el.querySelector(".rail-host");
    expect(line, "no `.rail-host` rendered").toBeTruthy();
    expect(line!.textContent).toContain("Can't reach kestrel.");
    expect(line!.textContent).toContain("Last answered 3 days ago.");
    /* THE CLAUSE THAT MAY NOT BE CUT. The age says how old the copy is and the link says where to
       go, but this is the only thing on screen telling somebody why their next press will be
       refused. If the line ever has to be shorter, the middle clause goes and this stays. */
    expect(line!.textContent).toContain("nothing can be changed until that computer is back");
    expect(line!.querySelector("a")?.getAttribute("href")).toBe("#/settings/desktop");
    act(() => root.unmount());
  });

  /**
   * THE CENSUS. Not "does it have the right classes" but "does it have any of the WRONG ones" —
   * the transient vocabulary, in full, anywhere in the subtree or on its root.
   */
  it("wears none of the transient vocabulary — no tone, no spinner, no track", () => {
    const { el, root } = render(<HostConnectionLine connection={STALE} />);
    const line = el.querySelector(".rail-host")!;
    for (const tone of ["busy", "warn", "stopped"]) {
      expect(line.classList.contains(tone), `\`.rail-host\` carries the \`${tone}\` tone`).toBe(false);
    }
    for (const sel of [".rs-track", ".mbx-spin", ".spin", ".glyph", ".rail-sync"]) {
      expect(
        line.querySelector(sel) === null && el.querySelector(`.rail-host ${sel}`) === null,
        `the standing line renders \`${sel}\`, which is a transient's chrome`,
      ).toBe(true);
    }
    /* The mark is present and STATIC — a line with no mark at all would fail the collapsed-rail
       arrangement, where the mark is the entire affordance. */
    const mark = line.querySelector(".rh-mark");
    expect(mark, "no mark — the collapsed rail would show nothing at all").toBeTruthy();
    expect(mark!.getAttribute("title"), "the mark carries the whole sentence for the collapsed rail")
      .toContain("Can't reach kestrel.");
    expect(mark!.getAttribute("title")).toContain("nothing can be changed");
    act(() => root.unmount());
  });

  /**
   * NO RETRY CONTROL. The mirror already asks every twenty seconds; a button that does what is
   * already happening is a claim about agency nobody has, and pressing it and seeing nothing
   * change is worse than not being offered it.
   */
  it("offers no control that would do what is already happening", () => {
    const { el, root } = render(<HostConnectionLine connection={STALE} />);
    expect(el.querySelectorAll("button")).toHaveLength(0);
    /* Exactly one link, and it goes to Settings rather than anywhere that retries. */
    expect(el.querySelectorAll(".rail-host a")).toHaveLength(1);
    act(() => root.unmount());
  });

  it("the shell form says the same sentence in one line", () => {
    const { el, root } = render(<HostConnectionLine connection={STALE} variant="shell" />);
    const strip = el.querySelector(".host-strip");
    expect(strip, "no `.host-strip` rendered").toBeTruthy();
    expect(strip!.textContent).toContain("Can't reach kestrel.");
    expect(strip!.textContent).toContain("nothing can be changed until that computer is back");
    /* Same census: the narrow form must not borrow the sync bar's chrome either. */
    expect(strip!.classList.contains("busy")).toBe(false);
    expect(strip!.querySelector(".rs-track")).toBeNull();
    expect(el.querySelectorAll("button")).toHaveLength(0);
    act(() => root.unmount());
  });

  /* A LIVE REGION, because a person who is reading mail when the other machine goes away has no
     reason to be looking at the rail — and polite rather than assertive, because the mail on
     screen is still readable and interrupting is not warranted. */
  it("announces itself, politely", () => {
    const { el, root } = render(<HostConnectionLine connection={STALE} />);
    const line = el.querySelector(".rail-host")!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("aria-live")).toBe("polite");
    act(() => root.unmount());
  });
});

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
