/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { createDeleteUndo, UNDO_MS } from "@ohmail/app-logic/press/delete-undo";
import { readerMoveRefusal, rosterStateOf } from "@ohmail/app-logic/mail-state/mail-state";
import { chordMatches, groupedBindings, type KeyBinding } from "../app/shell/keymap";
import { isModalOpen } from "@ohmail/app-logic/session/modal-gate";
/* The source censuses below anchor on the DECLARED NAME. The rule, and what a hook spelling
   costs, are written out in the helper; `anchor-census.test.ts` refuses the hook spelling
   across every test source under this directory. */
import { shellFramePaths, shellSliceOf, sliceOfDeclaration } from "./source-anchor.js";

/**
 * ═══ THE SELECTION'S VERBS ARE THE MESSAGE PILL ═══════════════════════════════════════════
 *
 * 0.15.0 item 11. The Ohbox already had a selection — `x`, ⇧-click ranges, ⇧U, Escape, tinted
 * and railed rows — and a BAR that was a third control shape: an accent-soft wash strip in the
 * list head, with the message pill's verbs, its own English-only container rungs, and a row
 * that overflowed its own box in German. This file holds what replaced it.
 *
 * ── WHAT EACH DESCRIBE IS FOR, AND THE MUTATION THAT MAKES IT RED ───────────────────────────
 *
 *   · "the shape" — the pill IS `.msg-actions > .abar`, in the list column's foot, in place of
 *     the hints strip. Mutation: mount it anywhere else, or bring `.pick-bar` back → red.
 *   · "the count capsule" — one control that states the number and clears the selection.
 *     Mutation: split it into a count and a separate Clear → the `aria-label` case goes red.
 *   · "no reply verbs" — Reply, Reply all and Forward never appear over a set, at one OR at
 *     seven. Mutation: add Reply to the pill's row → red at both counts.
 *   · "the keys" — the extend chords, and the letters acting on the selection. Mutation:
 *     implement ⇧↑ as a shrink → red; drop the `!e.repeat` guard on ⌫ → red.
 *   · "a reader" — Move over a selection is refused AT THE PRESS, once, with nothing on the
 *     wire, and the pick survives. Mutation: delete the `readerMoveRefusal` call in
 *     `onBulkAction` → red, with three `move`s on the wire. The verdict is the SHIPPED
 *     `screenerMode` → `readerMoveRefusal` path over a real roster row; nothing is stubbed.
 *   · "the window over a set" — one window, one toast, one Undo for N ids. Mutation: key the
 *     open map by message id again → red (N toasts, N Undos).
 *   · "the stylesheets" — the retirement and the two rules the pill depends on, read as text.
 *   · "the ? sheet" — the selection's labels are listed while a selection exists and NOT
 *     without one. Mutation: declare the verb bindings unconditionally → red.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

/** The shell's frames as one text — the spine's declarations live in `shell-dispatch.ts` now. */
const shellFramesText = (): string =>
  shellFramePaths(process.cwd()).map((at) => readFileSync(at, "utf8")).join("\n");

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The demo shell, cursor on the first row — `shell-screening-bulk.test.ts`'s own harness. */
async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  await key("j");
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const click = async (el: Element | null | undefined, init: MouseEventInit = {}): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
};

const rows = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")];
const pickedRows = (): HTMLElement[] => rows().filter((r) => r.classList.contains("picked"));
const pill = (): HTMLElement | null => host!.querySelector(".view-ohbox .list-foot .msg-actions > .abar");
const barButtons = (): HTMLButtonElement[] =>
  [...host!.querySelectorAll<HTMLButtonElement>(".view-ohbox .list-foot button")];
const labelOf = (b: Element): string => (b.textContent ?? "").trim();
const countCapsule = (): HTMLButtonElement | null =>
  host!.querySelector(".view-ohbox .list-foot .abar-count");
const pickCount = (): string | null =>
  host!.querySelector('.view-ohbox .list-foot .abar-count [role="status"]')?.textContent ?? null;
/**
 * The toasts that are SAYING something.
 *
 * `ToastHost` keeps a `.toast` element mounted at rest with no text in it, so a bare
 * `querySelectorAll(".toast").length` is 1 before anything has happened — which reads as "a
 * toast is up" and makes a "nothing was raised" assertion pass on a press that raised nothing
 * AND on one that raised something. Filtering on the text is what makes the count mean what
 * the assertions below say it means.
 */
const toasts = (): string[] =>
  [...document.querySelectorAll(".toast")]
    .map((t) => (t.textContent ?? "").trim())
    .filter((t) => t.length > 0);

/**
 * A PHONE VIEWPORT — `matchMedia` answering yes to the shell's width questions, which is what
 * `readColumnHidden()` reads. Called after mount, because the shell asks at click time.
 */
function setPhone(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: query.includes("max-width"), media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

/** One pointer event on a row, with the fields the gesture actually reads. */
const pointer = async (
  el: Element,
  type: string,
  init: { pointerType?: string; clientX?: number; clientY?: number } = {},
): Promise<void> => {
  await act(async () => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 10, clientY: init.clientY ?? 10 });
    Object.defineProperty(e, "pointerType", { value: init.pointerType ?? "touch" });
    el.dispatchEvent(e);
  });
};

/**
 * A COMPLETE TOUCH GESTURE, because the halves are not interchangeable.
 *
 * `hold` is pointerdown → 450ms → pointerup → click, and that last click is the hold's OWN and
 * must be swallowed: without it the reader would open over the selection that has just
 * appeared. `tap` is pointerdown → pointerup → click. Firing a bare `click` for a tap is what
 * these tests did first, and it was correctly eaten by the swallow — the gesture had never
 * started, so nothing cleared the flag the hold had set. A test that skips half a gesture is
 * testing a sequence the device cannot produce.
 */
const hold = async (row: Element): Promise<void> => {
  await pointer(row, "pointerdown", { pointerType: "touch" });
  await act(async () => { vi.advanceTimersByTime(500); });
  await pointer(row, "pointerup", { pointerType: "touch" });
  await click(row);
};
const tap = async (row: Element): Promise<void> => {
  await pointer(row, "pointerdown", { pointerType: "touch" });
  await pointer(row, "pointerup", { pointerType: "touch" });
  await click(row);
};

/** Pick `n` rows from the cursor with the keys that make a pick. */
const pick = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await key("x");
    if (i < n - 1) await key("j");
  }
};

beforeEach(() => {
  window.location.hash = "";
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  sent = [];
  // Every verb the demo adapter is asked to perform, with the real one still running under it
  // — see `shell-screening-bulk.test.ts` for why the arguments must all be forwarded.
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ══ the shape ═══════════════════════════════════════════════════════════════════════════ */

describe("the selection's bar IS the message pill, at the foot of the column", () => {
  it("mounts as `.list-foot > .msg-actions > .abar` — and the retired strip is nowhere", async () => {
    await mountShell();
    await pick(2);

    expect(pill(), "the selection did not mount the message pill").toBeTruthy();
    // The exact nesting, because it is what makes every rule in `action-bar.css` apply: the
    // pill dress, the admission pairs and the compact floor are all written `.msg-actions …`.
    const actions = pill()!.parentElement!;
    expect(actions.className).toBe("msg-actions");
    expect(actions.parentElement!.className).toBe("list-foot");
    // The strip is retired, in the markup as well as in the stylesheets.
    expect(host!.querySelector(".pick-bar"), "the retired selection strip is back").toBeNull();
  });

  it("TAKES the hints strip's place rather than standing beside it", async () => {
    await mountShell();
    // With nothing picked the column is the column it always was.
    expect(host!.querySelector(".view-ohbox .list-hints")).toBeTruthy();
    expect(host!.querySelector(".view-ohbox .list-foot")).toBeNull();

    await pick(2);
    // …and with a selection there is exactly ONE line under the scroller, not two.
    expect(host!.querySelector(".view-ohbox .list-hints"), "the hints strip and the pill stacked").toBeNull();
    expect(host!.querySelectorAll(".view-ohbox .list-foot")).toHaveLength(1);

    await key("Escape");
    expect(host!.querySelector(".view-ohbox .list-foot")).toBeNull();
    expect(host!.querySelector(".view-ohbox .list-hints"), "the hints strip did not come back").toBeTruthy();
  });

  it("stands IN FLOW under the scroller — never inside it, never sticky", async () => {
    // The toast band argument (`ListPane.foot`): a bar stuck inside the scroller sits where a
    // toast raised by its own verb lands. Both halves are asserted — outside the scroller in
    // the markup, and no rule in either stylesheet makes it or its pill sticky.
    await mountShell();
    await pick(2);
    const foot = host!.querySelector(".view-ohbox .list-foot")!;
    expect(foot.closest(".scroller")).toBeNull();
    expect(host!.querySelector(".view-ohbox .list-col")!.contains(foot)).toBe(true);
  });

  it("the row is count · defer · tag · file · read+More, in that order", async () => {
    await mountShell();
    await pick(2);
    /* ROW ORDER IS FOLD ORDER (`bar-density.ts`'s first law), so the order is not decoration:
       admission is a greedy PREFIX over these groups as they stand in the DOM. A later verb
       standing while an earlier one is folded is the defect that law exists to prevent. */
    const groups = [...pill()!.querySelectorAll(":scope > .abar-row > .abar-g")];
    const shape = groups.map((g) =>
      g.classList.contains("abar-count") || g.querySelector(".abar-count") ? "count"
        : g.classList.contains("abar-defer") ? "defer"
        : g.classList.contains("abar-tag") ? "tag"
        : g.classList.contains("abar-file") ? "file"
        : g.classList.contains("abar-read-g") ? "read"
        : "?",
    );
    expect(shape).toEqual(["count", "defer", "tag", "file", "read"]);
    // More lives at the end of the read group, where a message's does.
    expect(groups[4]!.querySelector(".abar-more"), "More is not at the end of the row").toBeTruthy();
  });

  it("the read pair is two DIRECTIONS with the pill's own dots, never a switch", async () => {
    await mountShell();
    await pick(2);
    const seg = pill()!.querySelector(".abar-read-g .abar-seg")!;
    expect(seg.getAttribute("role")).toBe("group");
    expect(seg.getAttribute("aria-label")).toBe(en.ohbox.groupRead);
    const both = [...seg.querySelectorAll("button")];
    expect(both).toHaveLength(2);
    expect(labelOf(both[0]!).startsWith(en.ohbox.actionRead)).toBe(true);
    expect(labelOf(both[1]!).startsWith(en.ohbox.pickedMarkUnseen)).toBe(true);
    /* THE DOT PREVIEWS THE OUTCOME, which is the whole of why there are two buttons and not a
       toggle: hollow on Read (the row will have no dot), filled on Unread (it will). Swap them
       and the bar previews the opposite of what it does. */
    expect(both[0]!.querySelector(".abar-dot.abar-dot-off"), "Read does not preview a read row").toBeTruthy();
    expect(both[1]!.querySelector(".abar-dot")).toBeTruthy();
    expect(both[1]!.querySelector(".abar-dot-off"), "Unread previews a read row").toBeNull();
    // `role="switch"` reports a CURRENT state, and a selection's is mixed.
    expect(seg.querySelector('[role="switch"]')).toBeNull();
  });
});

/* ══ the count capsule ═══════════════════════════════════════════════════════════════════ */

describe("the count is the leading capsule, and it is the way out", () => {
  it("states the number, names the act, and CLEARS when pressed", async () => {
    await mountShell();
    await pick(3);
    expect(pickCount()).toBe("3");

    const capsule = countCapsule()!;
    /* ONE CONTROL, NOT TWO. A separate Clear verb would be a second exit for one act — and in
       German "Auswahl aufheben" is 110px for something the count itself can say. So the
       button's NAME has to carry both halves: how many, and what pressing it does. */
    const label = capsule.getAttribute("aria-label") ?? "";
    expect(label, "the capsule does not say how many are selected").toContain("3");
    expect(label.toLowerCase(), "the capsule does not say that it clears").toContain("clear the selection");
    // The number is a live region, so a change in the count is ANNOUNCED and not merely present.
    expect(capsule.querySelector('[role="status"]')?.textContent).toBe("3");

    await click(capsule);
    expect(pickedRows(), "pressing the count did not clear the selection").toHaveLength(0);
    expect(host!.querySelector(".view-ohbox .list-foot")).toBeNull();
  });

  it("the word is a span of its own, so the compact floor can fold it and keep the number", async () => {
    /* `bar-density.ts` drops the widest label the floor is carrying, and on this pill that is
       the count's WORD — "× 7 selected" becomes "× 7". The number and the word therefore cannot
       be one text node, and the word must wear the class the stylesheet hides. Render them
       joined and German at 1440 overflows the column instead of folding. */
    await mountShell();
    await pick(2);
    const capsule = countCapsule()!;
    expect(capsule.querySelector(".abar-count-word")?.textContent).toBe(en.ohbox.pickedWord);
    expect(capsule.querySelector('[role="status"]')?.textContent).toBe("2");
    expect(de.ohbox.pickedWord, "the German word is the English one").not.toBe(en.ohbox.pickedWord);
  });
});

/* ══ what never appears over a set ═══════════════════════════════════════════════════════ */

describe("a set has no reply verbs — at one, and at seven", () => {
  for (const n of [1, 7]) {
    it(`${n} selected: no Reply, no Reply all, no Forward, and no accent capsule`, async () => {
      await mountShell();
      await pick(n);
      expect(pickCount()).toBe(String(n));
      const labels = barButtons().map(labelOf).join(" · ");
      /* THERE IS NO SUCH ACT OVER A SET — and a pick of ONE is still a pick, which is the case
         this loop exists for: switching to the single-message vocabulary at count 1 would be
         the app changing its mind about what you selected. */
      expect(labels, "Reply appeared on the selection pill").not.toContain("Reply");
      expect(labels, "Forward appeared on the selection pill").not.toContain("Forward");
      // The leading slot holds the count, so nothing here wears the one primary capsule.
      expect(pill()!.querySelector(".abar-row .abar-b.primary")).toBeNull();
    });
  }

  it("Delete is in the MENU with no group — never a row button", async () => {
    await mountShell();
    await pick(2);
    // A destructive verb over a set does not belong where a stray click can land, so it carries
    // no density group and no admission rule can surface it in the row.
    await click(pill()!.querySelector(".abar-more"));
    const items = [...pill()!.querySelectorAll<HTMLElement>(".mm-item")];
    const del = items.find((i) => labelOf(i).startsWith(en.ohbox.actionDelete));
    expect(del, "Delete is not in the More menu").toBeTruthy();
    expect(del!.className, "Delete carries a density group and could be admitted to the row")
      .toBe("mm-item");
  });
});

/* ══ the keys ════════════════════════════════════════════════════════════════════════════ */

describe("the selection's keys", () => {
  it("⇧↓ from an unpicked cursor picks the cursor's row AND the one it lands on", async () => {
    await mountShell();
    expect(pickedRows()).toHaveLength(0);
    await key("ArrowDown", { shiftKey: true });
    /* WITH NO ANCHOR THE CURSOR'S OWN ROW BECOMES ONE. Anything else leaves the origin row
       unpicked and the selection does not match the movement the gesture made. */
    expect(pickedRows(), "⇧↓ did not span the pair it moved over").toHaveLength(2);
  });

  it("⇧↑ after ⇧↓ ADDS — a range never removes what it walks back over", async () => {
    await mountShell();
    await key("ArrowDown", { shiftKey: true });
    const grown = pickedRows().length;
    expect(grown).toBe(2);
    await key("ArrowUp", { shiftKey: true });
    /* SHRINK-ON-REVERSE IS THE REJECTED DESIGN. It needs a live range with a direction beside
       the set, and it would remove rows picked by other means — ⌘-click four, then ⇧↓ ⇧↑, and
       two are gone. Implement the shrink and this goes red. */
    expect(pickedRows().length, "⇧↑ removed rows instead of adding").toBeGreaterThanOrEqual(grown);
  });

  it("the verb letters act on the SELECTION while there is one", async () => {
    await mountShell();
    await pick(3);
    const ids = pickedRows().map((r) => r.dataset.id!);
    expect(ids).toHaveLength(3);

    sent = [];
    await key("e"); // Park
    const triage = sent.filter((m) => m.kind === "triage_set") as Array<{ messageId: string; state: string }>;
    expect(triage.map((m) => m.messageId).sort(), "`e` did not park the selection").toEqual([...ids].sort());
    expect(triage.every((m) => m.state === "set_aside")).toBe(true);
    // ONE dispatch per message, and none twice.
    expect(new Set(triage.map((m) => m.messageId)).size).toBe(triage.length);
    // The verb ran, so the pick is spent.
    expect(pickedRows()).toHaveLength(0);
  });

  it("`d` ASKS first, and Escape closes the ask before it clears the selection", async () => {
    await mountShell();
    await pick(3);
    sent = [];
    await key("d");

    const ask = host!.querySelector<HTMLElement>(".view-ohbox .list-foot .abar-panel.abar-delete");
    expect(ask, "`d` did not open the ask").toBeTruthy();
    expect(ask!.getAttribute("role")).toBe("alertdialog");
    // The count is stated in the question — the last place it is said before the rows go.
    expect(ask!.textContent, "the ask does not count the selection").toContain("3");
    expect(ask!.textContent).toContain(en.ohbox.deleteNote);
    expect(sent, "the ask dispatched something").toEqual([]);

    /* ESCAPE CANCELS THE OPEN SUB-ROW BEFORE IT CLEARS. It matters most here: an Escape that
       blew past a destructive question to clear the set would leave the person with neither. */
    await key("Escape");
    expect(host!.querySelector(".abar-panel.abar-delete"), "Escape blew past the ask").toBeNull();
    expect(pickedRows(), "Escape cleared the selection as well as the ask").toHaveLength(3);
    await key("Escape");
    expect(pickedRows()).toHaveLength(0);
  });

  it("⌫ opens the window DIRECTLY — one toast for the set, and nothing on the wire yet", async () => {
    vi.useFakeTimers();
    await mountShell();
    await pick(3);
    const ids = pickedRows().map((r) => r.dataset.id!);
    sent = [];

    await key("Backspace");
    // No ask: a keycap that deletes on a single press is item 10's own distinction, and the
    // toast's Undo is the protection.
    expect(host!.querySelector(".abar-panel.abar-delete")).toBeNull();
    /* ONE window and ONE toast for the whole press — not three. The toast counts the set, out
       of the plural catalogue. */
    const up = toasts();
    expect(up, "a press over three raised more than one toast").toHaveLength(1);
    expect(up[0], "the toast does not count the set").toContain("3");
    expect(sent, "a delete reached the wire inside the window").toEqual([]);
    // The rows left every pile on the press.
    expect(rows().filter((r) => ids.includes(r.dataset.id!))).toHaveLength(0);

    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    const deletes = sent.filter((m) => m.kind === "message_delete") as Array<{ messageId: string }>;
    expect(deletes.map((m) => m.messageId).sort(), "the window closed on the wrong set")
      .toEqual([...ids].sort());
  });

  it("a REPEATED ⌫ opens nothing — the guard is on the event, so the repeat itself is refused", async () => {
    /**
     * WHAT THIS ASSERTS, AND WHY IT IS NOT THE OBVIOUS SHAPE. The obvious test — press ⌫, then
     * press it twice more with `repeat` — passes with the guard DELETED, because the first
     * press clears the pick and the binding is then absent. It was written that way first and
     * watched pass under the mutation, which is exactly the blind guard CLAUDE.md warns about.
     *
     * The guard's real contract is on the EVENT: a keydown carrying `repeat` is not a press.
     * So the repeat is dispatched FIRST, over a live selection, where the binding is present
     * and enabled and the only thing standing between it and the window is `when`. Delete
     * `when: (e) => !e.repeat` from the two delete chords and this goes red with a window open
     * over the set. The ordinary press after it proves the fixture could have fired.
     */
    vi.useFakeTimers();
    await mountShell();
    await pick(2);
    const ids = pickedRows().map((r) => r.dataset.id!);
    sent = [];

    await key("Backspace", { repeat: true } as KeyboardEventInit);
    expect(toasts(), "a key repeat opened a delete window").toHaveLength(0);
    expect(pickedRows(), "a key repeat spent the selection").toHaveLength(2);
    expect(rows().filter((r) => ids.includes(r.dataset.id!)), "a key repeat hid the rows")
      .toHaveLength(2);

    // …and the same key, pressed rather than repeated, does open one.
    await key("Backspace");
    expect(toasts(), "the fixture could not fire at all").toHaveLength(1);
  });
});

/* ══ a reader ════════════════════════════════════════════════════════════════════════════ */

describe("a reader is refused AT THE PRESS, once, with the selection kept", () => {
  /**
   * THE REAL PATH, NOT A MOCKED VERDICT. `screenerMode` derives the role from a roster row
   * shaped like the one the API returns, and `readerMoveRefusal` chooses the sentence out of
   * the shipped catalogue. Both are the functions `AppShell.onBulkAction` calls.
   */
  const HERE = {
    id: "mb-here", status: "connected", disabledReason: null, organizerRole: "organizer" as const,
    organizedBy: null, organizeConsentedAt: "2026-09-02T09:00:00.000Z",
  };
  const THERE = {
    id: "mb-there", status: "connected", disabledReason: null, organizerRole: "reader" as const,
    organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T09:00:00.000Z" },
    organizeConsentedAt: "2026-09-02T09:00:00.000Z",
  };
  const say = {
    named: (name: string) => en.screener.readerMoveRefused.replace("{name}", name),
    unknown: () => en.screener.readerMoveRefusedUnknown,
    nobody: () => en.screener.readerMoveRefusedNobody,
  };

  it("NO PROBE (desktop, demo) PERMITS — the wire stays the authority where no roster exists", () => {
    expect(rosterStateOf(false, null).kind).toBe("absent");
    expect(readerMoveRefusal(rosterStateOf(false, null), ["mb-here"], say)).toBeNull();
    expect(readerMoveRefusal(rosterStateOf(false, null), ["anything", ""], say)).toBeNull();
  });

  it("A PENDING probe REFUSES — the answer is coming and the verb is destructive", () => {
    expect(rosterStateOf(true, null).kind).toBe("pending");
    expect(readerMoveRefusal(rosterStateOf(true, null), ["mb-here"], say))
      .toBe(en.screener.readerMoveRefusedUnknown);
  });

  it("A KNOWN roster answers PER MAILBOX: organizer permits, reader refuses by name", () => {
    const known = rosterStateOf(true, [HERE, THERE] as never);
    expect(readerMoveRefusal(known, ["mb-here"], say)).toBeNull();
    expect(readerMoveRefusal(known, ["mb-there"], say)).toBe(say.named("ohmail Cloud"));
  });

  it("a MIXED selection refuses on the reader mailbox — the whole press, not the refusable part", () => {
    const known = rosterStateOf(true, [HERE, THERE] as never);
    expect(readerMoveRefusal(known, ["mb-here", "mb-there"], say)).toBe(say.named("ohmail Cloud"));
  });

  it("an UNKNOWN id in a known roster refuses, and so does an empty set", () => {
    const known = rosterStateOf(true, [HERE] as never);
    expect(readerMoveRefusal(known, ["mb-nope"], say)).toBe(en.screener.readerMoveRefusedUnknown);
    expect(readerMoveRefusal(known, [], say)).toBe(en.screener.readerMoveRefusedUnknown);
  });

  it("`AppShell.onBulkAction` refuses move and screen BEFORE dispatching, and keeps the pick", () => {
    /**
     * READ AS SOURCE, because the arms are inline in a shell thousands of lines long and the wiring is the
     * claim: the refusal has to be resolved and RETURNED before the dispatch loop, so nothing
     * reaches the wire and the caller learns the verb did not run. The behavioural half — the
     * pick surviving a `false` — is `OhboxView.runBulk`, asserted below.
     *
     * Delete is not in this list on purpose: its refusal is the delete window's own
     * (`delete-undo.ts#refusal`, resolved at the press), and a second spelling of one verdict
     * is what `readerMoveRefusal` exists to prevent.
     */
    /* THE FRAME THAT DECLARES THEM, from the manifest: both verbs left `AppShell.tsx` for
       `shell-verbs.ts` at ARCH-022, and `shellSliceOf` refuses zero hits and two — an arm read
       off a frame where the name means a different declaration is the defect, not a pass. */
    const bulk = shellSliceOf("onBulkAction");
    const moveArm = bulk.slice(0, bulk.indexOf('const view = action.slice("move:".length)'));
    expect(moveArm, "the bulk move arm no longer asks for the refusal before it dispatches")
      .toMatch(/readerMoveRefusal\(\s*rosterRef\.current/);
    expect(moveArm).toMatch(/if \(refused !== null\) \{\s*toast\(refused\);\s*return false;/);

    const screen = shellSliceOf("onBulkScreen");
    const beforePlan = screen.slice(0, screen.indexOf("const plan = planBulkScreening"));
    expect(beforePlan, "bulk screening no longer refuses a reader before it plans")
      .toMatch(/readerMoveRefusal\(\s*rosterRef\.current/);
    expect(beforePlan).toMatch(/return false;/);
  });

  it("the SINGLE-message move refuses at the press too — the other half of the same rule", () => {
    /**
     * the single half, closed in the same slice as the bulk one because it is the same defect
     * and the same fix. The arm used to dispatch and let the SERVER refuse: the row left the
     * list, the request was declined, the engine rolled the overlay back, and the message
     * reappeared a beat later with no sentence saying why.
     *
     * Read as source for the reason the bulk arms are: these arms are inline in a very long
     * shell, and the claim is the ORDER — the refusal is resolved and the arm BREAKS before the
     * dispatch, so nothing reaches the wire. Delete the gate and the dispatch below it becomes
     * reachable for a reader, which is exactly the state this closes.
     *
     * The dispatch the arm makes is `moveToPlace`, and it used to be a bare `engine.mutate` here.
     * The ORDER claim is untouched by that; what the anchor has to follow is the call that reaches
     * the wire, so the second half below reads `moveToPlace`'s own declaration and refuses one that
     * dispatches nothing — an anchor naming a call that no longer writes would pass on air.
     *
     * The behavioural half of the verdict — that `readerMoveRefusal` says no for a reader and
     * yes for an organizer, out of the shipped catalogue over a real roster row — is asserted
     * above and is the same function this arm calls.
     */
    const single = shellSliceOf("onMessageAction");
    const arm = single.slice(single.indexOf('const view = action.slice("move:".length)'));
    const gate = arm.indexOf("readerMoveRefusal(");
    const wire = arm.indexOf("moveToPlace(m, view)");
    expect(gate, "the single-message move arm no longer asks for the refusal").toBeGreaterThan(-1);
    expect(wire).toBeGreaterThan(-1);
    // ORDER IS THE CLAIM: the gate stands before the wire, and it breaks rather than falling through.
    expect(gate, "the refusal is asked AFTER the move is dispatched").toBeLessThan(wire);
    expect(arm.slice(gate, wire)).toMatch(/if \(refusedMove !== null\) \{\s*toast\(refusedMove\);\s*break;\s*\}/);
    // The same two sentences as every other caller — a second spelling is the drift the helper ends.
    expect(arm.slice(gate, wire)).toMatch(/refusalCopy/);
    /* AND THE CALL PAST THE GATE REALLY WRITES. Without this the anchor above could name a
       function that does nothing and the order claim would be about nothing. */
    expect(
      shellSliceOf("moveToPlace"),
      "the call past the refusal dispatches nothing — the order claim is over air",
    ).toContain("dispatchScreeningChange(");
    /* WHAT THIS CASE MEANS, CHOSEN RATHER THAN INHERITED: **the declaration names the key.**
       `sliceOfDeclaration` returns `refusalCopy`'s own declaration and nothing after it — 199
       bytes over 8 lines — so the claim is that the memo both arms read resolves its sentence out
       of the catalogue under that key.
       It replaces `slice(shell.indexOf("const refusalCopy = " + hook)).slice(0, 400)`: a window
       that ran some 200 bytes past the declaration into whatever happened to follow it. Both
       windows contain the key, so the ASSERTION is unchanged — what changed is that the window is
       now the declaration, a bound the code defines, instead of a byte count nobody chose.
       The stale anchor was also the last hook spelling in this file, and it would have failed the
       way the three above it did: `indexOf` returning -1 and `slice(-1)` handing back the file's
       final newline, which fails this positive `toMatch` with the sentence for "the shell stopped
       using `refusalCopy`" rather than for a stale anchor. */
    /* THE MEMO LEFT THIS FILE with the dispatch spine (`shell-dispatch.ts`), so the anchor asks
       the MANIFEST which frame declares it rather than this one — `shellFrameOf` throws on zero
       hits and on two, which is what keeps a re-home from landing on a same-named declaration
       somewhere else. The re-typing count is asked over both frames for the same reason. */
    expect(
      shellSliceOf("refusalCopy"),
      "the refusal memo no longer resolves the catalogue key — both move arms toast something else",
    ).toMatch(/screener\.readerMoveRefused/);
    expect(
      (shellFramesText().match(/t\("screener\.readerMoveRefused"/g) ?? []).length,
      "a caller re-typed the refusal sentence instead of using refusalCopy",
    ).toBe(1);
  });

  it("the source census REFUSES an anchor that finds nothing", () => {
    /**
     * THE CONTROL for `sliceOfDeclaration`, and for the defect it makes unrepresentable: the
     * two cases above located their arm by the hook it was declared with, a codemod renamed
     * that hook, and an empty slice made every `toContain` over it pass on nothing. A name the
     * shell does not declare has to throw, not hand back something to assert nothing against.
     */
    const shell = readFileSync("apps/webapp/app/shell/AppShell.tsx", "utf8");
    expect(() => sliceOfDeclaration(shell, "noSuchName")).toThrow("anchor not found: noSuchName");
    /* The positive half — the names these cases DO use resolve to a slice with the arm in it. */
    expect(shellSliceOf("onBulkAction")).toContain("readerMoveRefusal(");
    expect(shellSliceOf("onMessageAction")).toContain("moveToPlace(m, view)");
    expect(shellSliceOf("moveToPlace")).toContain("dispatchScreeningChange(");
    /* `refusalCopy`'s own positive arm. Its case above was the last site in this file located by
       a hook spelling; a refusal arm alone would prove the helper says no to a name that is not
       there, and nothing about it saying yes to this one. */
    expect(shellSliceOf("refusalCopy")).toContain("screener.readerMoveRefused");
  });

  it("`runBulk` KEEPS the selection when the verb reports it was refused", () => {
    // The other half of the contract, and the reason `BulkVerbs.run` returns a boolean at all:
    // a set thrown away by a press that did nothing has to be rebuilt before the person can try
    // the verb that would have worked.
    const view = readFileSync("apps/webapp/app/views/OhboxView.tsx", "utf8");
    expect(view).toMatch(/if \(bulk\.run\(action, pickedIds\)\) clearPicked\(\);/);
    expect(view, "runBulk clears unconditionally again").not.toMatch(
      /bulk\.run\(action, pickedIds\);\s*\n\s*clearPicked\(\);/,
    );
  });
});

/* ══ the window over a set ═══════════════════════════════════════════════════════════════ */

describe("the delete window holds a whole press, not a message", () => {
  interface Sent { kind: string; messageId: string }

  function queueOver(opts: { refuse?: boolean; rollback?: number } = {}) {
    const sentHere: Sent[] = [];
    const said: string[] = [];
    let actions: Array<() => void> = [];
    let n = 0;
    const queue = createDeleteUndo({
      mutate: async (messageId) => {
        sentHere.push({ kind: "message_delete", messageId });
        return { status: n++ < (opts.rollback ?? 0) ? "rolled_back" : "confirmed" };
      },
      toast: (msg, o) => { said.push(msg); if (o?.onAction) actions.push(o.onAction); },
      copy: {
        deleted: en.ohbox.toastDeleted, undo: en.screener.toastUndo,
        undone: en.ohbox.deleteUndone, failed: en.ohbox.deleteFailed,
        noUndo: en.session.noUndoHere,
        deletedMany: (count: number) => `${count} moved`,
        undoneMany: (count: number) => `${count} undone`,
        failedMany: (count: number) => `${count} failed`,
      },
      onHeld: () => {},
      refusal: () => (opts.refuse ? "refused" : null),
    });
    return { queue, sent: sentHere, said, pressUndo: () => { const a = actions; actions = []; a.forEach((f) => f()); } };
  }

  it("three ids are ONE window, ONE toast and ONE Undo", async () => {
    vi.useFakeTimers();
    const { queue, sent: out, said } = queueOver();
    queue.remove([{ id: "a" }, { id: "b" }, { id: "c" }]);
    /* KEYED BY PRESS, NOT BY MESSAGE. Keyed by message this is three timers, three toasts
       stacked over each other and three Undos for one decision. */
    expect(said, "a press over three said it three times").toHaveLength(1);
    expect(said[0]).toBe("3 moved");
    expect([...queue.held()].sort()).toEqual(["a", "b", "c"]);
    expect(out, "something reached the wire inside the window").toEqual([]);

    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(out.map((m) => m.messageId).sort()).toEqual(["a", "b", "c"]);
    expect(out.every((m) => m.kind === "message_delete")).toBe(true);
    expect([...queue.held()]).toEqual([]);
  });

  it("Undo forgets ALL of them, and says how many", async () => {
    vi.useFakeTimers();
    const { queue, sent: out, said, pressUndo } = queueOver();
    queue.remove([{ id: "a" }, { id: "b" }, { id: "c" }]);
    pressUndo();
    expect(said[1]).toBe("3 undone");
    expect([...queue.held()]).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 4); });
    expect(out, "the timer was ignored rather than disarmed").toEqual([]);
  });

  it("a PARTIAL failure counts the refusals — once, not per row", async () => {
    vi.useFakeTimers();
    const { queue, said } = queueOver({ rollback: 2 });
    queue.remove([{ id: "a" }, { id: "b" }, { id: "c" }]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    /* THE NUMBER THAT MATTERS IS HOW MANY CAME BACK. Said per row this is "that delete could
       not be saved" twice, which tells the reader nothing about the state of the pile. */
    expect(said.filter((s) => s.endsWith("failed"))).toEqual(["2 failed"]);
  });

  it("an id already inside an open window is not pressed again", async () => {
    vi.useFakeTimers();
    const { queue, sent: out, said } = queueOver();
    queue.remove([{ id: "a" }, { id: "b" }]);
    queue.remove([{ id: "b" }, { id: "c" }]);
    expect(said).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    // `b` is deleted ONCE — two windows holding it would dispatch it twice when both closed.
    expect(out.map((m) => m.messageId).sort()).toEqual(["a", "b", "c"]);
  });

  it("a READER is refused before anything is held", () => {
    const { queue, sent: out, said } = queueOver({ refuse: true });
    queue.remove([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(said).toEqual(["refused"]);
    expect(out).toEqual([]);
    expect([...queue.held()], "rows were hidden behind a refusal").toEqual([]);
  });

  it("the four plural sentences exist in both catalogues and are not each other", () => {
    for (const k of ["bulkDeleteAsk", "toastDeletedMany", "deleteUndoneMany", "deleteFailedMany"] as const) {
      expect(en.ohbox[k], `en.ohbox.${k}`).toBeTruthy();
      expect(de.ohbox[k], `de.ohbox.${k}`).toBeTruthy();
      expect(de.ohbox[k], `de.ohbox.${k} is the English one`).not.toBe(en.ohbox[k]);
      // ICU plurals, so one message and seven read correctly in both languages.
      expect(en.ohbox[k]).toContain("plural");
      expect(de.ohbox[k]).toContain("plural");
    }
    // item 10's singular keys are NOT touched — the confirm strip and the mobile reader pin them.
    expect(en.ohbox.toastDeleted).toBe("Moved to Trash.");
  });
});

/* ══ the stylesheets ═════════════════════════════════════════════════════════════════════ */

describe("what the stylesheets say", () => {
  const actionBar = readFileSync("apps/webapp/app/shell/action-bar.css", "utf8");
  const appCss = readFileSync("apps/webapp/app/app.css", "utf8");
  const listPane = readFileSync("packages/ui/src/composites/list-pane.css", "utf8");

  /* A retired class is censused by SELECTOR, never by raw text. A comment that names the old
     class as history is legitimate stylesheet writing — `action-bar.css` keeps two, explaining
     which rungs went and why — and a census over the raw text measures those comments instead
     of the rules: it goes red for prose, and the only way to answer it is to reword prose, which
     is not a fix. So blank the comments, then ask whether the token still stands where a rule
     would put it. Blanked and not deleted, so every offset and line number in what is left is
     still the file's own. */
  const withoutComments = (css: string) =>
    css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));

  /* The token in SELECTOR position: the whole class name — not the head of a longer, live one
     (`.pick-bar-hint`) — followed by a declaration block, another compound of the same selector,
     a combinator (`>` `+` `~`, or whitespace before the next simple selector), a pseudo, an
     attribute filter, or the next item of a selector list. */
  const hasSelector = (css: string, className: string) =>
    new RegExp(
      `\\.${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])\\s*(?:[{,>+~:.#[)]|[A-Za-z])`,
    ).test(css);

  const CENSUS =
    "the retired strip has no selector left in either stylesheet; comments naming it as history are allowed";

  it("the retired strip has no rule left in either stylesheet", () => {
    expect(hasSelector(withoutComments(actionBar), "pick-bar"), CENSUS).toBe(false);
    expect(hasSelector(withoutComments(appCss), "pick-bar"), CENSUS).toBe(false);
    // …and its two container rungs went with it: those were the last static widths in the file.
    expect(withoutComments(actionBar)).not.toMatch(/@container abar \(min-width: (456|601)px\)/);
  });

  it("the census reads a comment naming the retired class as history as clean", () => {
    const fixture = [
      "/* WHAT USED TO STAND HERE: `.pick-bar > .abar` at `flex: 1 1 100%`, retired — a",
      " * selection's verbs wear the message pill now. `.pick-bar`, below, is gone with it. */",
      ".msg-actions > .abar { flex: 0 1 auto }",
    ].join("\n");
    expect(
      hasSelector(withoutComments(fixture), "pick-bar"),
      "a comment naming the old class was counted as a rule",
    ).toBe(false);
  });

  it("the census refuses the retired class the moment it is a selector again", () => {
    for (const fixture of [
      ".pick-bar { display: flex }",
      ".pick-bar > .abar { flex: 1 1 100% }",
      ".list-foot .pick-bar,\n.list-foot .abar { gap: 6px }",
    ]) {
      expect(hasSelector(withoutComments(fixture), "pick-bar"), fixture).toBe(true);
    }
  });

  it("a live class that merely starts with the retired name is not the retired class", () => {
    expect(
      hasSelector(withoutComments(".pick-bar-hint { color: var(--muted) }"), "pick-bar"),
      "the census matched a longer class name",
    ).toBe(false);
  });

  it("the picked ROW treatment is untouched — tint plus rail, and it is not the cursor's", () => {
    expect(appCss).toMatch(/\.view-ohbox \.row\.picked \{[^}]*--accent-soft/);
    expect(appCss).toMatch(/\.view-ohbox \.row\.picked \{[^}]*inset 2px 0 0 var\(--accent\)/);
  });

  it("the foot is in flow and carries the safe area under 640", () => {
    const foot = listPane.slice(listPane.indexOf(".list-foot{"));
    expect(foot).toMatch(/\.list-foot\{[^}]*flex:none/);
    // NOT sticky and NOT positioned — the toast-band argument depends on it.
    expect(foot.slice(0, foot.indexOf("}"))).not.toContain("position:");
    expect(listPane).toMatch(
      /@media \(max-width:640px\)\{\s*\.list-foot\{padding-bottom:calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\)\}/,
    );
    // Nothing anywhere makes the foot or the pill inside it sticky.
    expect(actionBar).not.toMatch(/\.list-foot[^{]*\{[^}]*position:\s*sticky/);
  });

  it("keycaps are hidden where there is no keyboard AND where there is no room", () => {
    /* The gap `touch-keys.css` left: it hides the top bar's ⌘K, the reader hint and the
       decision capsules' caps, and never `.abar kbd` — so ⇧U, esc, r and ⇧f drew on phones.
       BOTH arms are pinned. The width arm is not decoration: a 390px-wide desktop window is a
       FINE pointer, so the coarse arm alone leaves the caps drawn there, and `fit-render`
       measured the German selection row 9px past its box on paper and 15px on ohmarchy with
       the compact floor already spent. Drop either arm and that overflow comes back. */
    expect(actionBar).toMatch(
      /@media \(pointer: coarse\), \(max-width: 640px\) \{\s*\.abar kbd \{ display: none; \}/,
    );
  });

  it("the count capsule outranks `.abar-solo`, or it renders white", () => {
    /* TWO CLASSES, DELIBERATELY. The capsule also wears `.abar-solo`, whose
       `background: var(--panel)` sits LOWER in the file at equal specificity — a single-class
       rule loses the cascade and the one accent object in the row goes white at rest and on
       hover. Drop a class from either selector and this goes red. */
    expect(actionBar).toMatch(/\.abar-b\.abar-count \{[^}]*var\(--accent-soft\)/);
    expect(actionBar).toMatch(/\.abar-b\.abar-count:hover \{[^}]*var\(--accent-soft\)/);
    const soloAt = actionBar.indexOf(".abar-solo {");
    const countAt = actionBar.indexOf(".abar-b.abar-count {");
    expect(soloAt, "fixture: `.abar-solo` is not in this file any more").toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(-1);
    // The pin only matters while `.abar-solo` is declared later; say so, so a reorder is loud.
    expect(soloAt, "`.abar-solo` moved above the capsule — re-read the specificity note")
      .toBeGreaterThan(countAt);
  });

  it("the compact floor hides the count's word and nothing structural", () => {
    expect(actionBar).toMatch(
      /\.msg-actions \.abar\[data-admit~="compact"\] \.abar-row \.abar-count \.abar-count-word \{\s*display: none;/,
    );
  });

  it("…and the MEASURE row is immune to it, or the pill oscillates", () => {
    /**
     * MEASURED THE HARD WAY. The compact rule is written `.abar-row .abar-count
     * .abar-count-word`, and the measure row IS an `.abar-row` — so folding the word hid it in
     * the COPY as well. The next measurement then read a base 69px narrower than the row it was
     * deciding for (331 against 356 of room), concluded compact was unnecessary, put the word
     * back, overflowed, and folded again: the pill cycled, and `fit-render` caught it mid-cycle
     * as a German row 33px past its box at 1440 and 90px at 390.
     *
     * A fold must never zero the width that decides the fold. The read switch's label has
     * carried this `!important` since the density hook shipped and its comment says why; the
     * count's word needs the same, and deleting this line brings the oscillation straight back.
     */
    expect(actionBar).toMatch(/\.abar-measure \.abar-count-word \{ display: inline !important; \}/);
    expect(actionBar).toMatch(/\.abar-measure \.abar-read-lab \{ display: inline !important; \}/);
  });
});

/* ══ the ? sheet ═════════════════════════════════════════════════════════════════════════ */

describe("the shortcut sheet teaches the state the reader is actually in", () => {
  const view = readFileSync("apps/webapp/app/views/OhboxView.tsx", "utf8");

  it("every selection label in the catalogue is declared by the view", () => {
    // The sheet is generated from the registry, so a label with no binding cannot appear and a
    // binding with no label cannot be documented. This pins the pairing.
    for (const k of [
      "keySelLater", "keySelPark", "keySelResurface", "keySelTag", "keySelScreen",
      "keySelMove", "keySelUnread", "keySelDeleteAsk", "keySelDelete",
      "keyExtendDown", "keyExtendUp",
    ] as const) {
      expect(view, `${k} is in the catalogue with no binding`).toContain(`t("${k}")`);
      expect(en.ohbox[k], `en.ohbox.${k}`).toBeTruthy();
      expect(de.ohbox[k], `de.ohbox.${k}`).toBeTruthy();
      expect(de.ohbox[k], `de.ohbox.${k} is the English one`).not.toBe(en.ohbox[k]);
    }
  });

  it("the verb chords are DECLARED ONLY WITH A SELECTION — the sheet must not teach the wrong one", () => {
    /**
     * NOT `disabled`, ABSENT. `groupedBindings` keeps ONE row per chord and prefers an enabled
     * declaration; the view's layer is walked before the shell's, so a disabled selection
     * binding sitting ahead of a disabled message binding WON the row. Measured before this
     * gate: with nothing picked and no cursor, `a` read "Queue the selection for the Reply
     * Run". Make the spread unconditional and the sheet teaches the selection's verbs to
     * somebody who has selected nothing.
     */
    expect(view).toMatch(/\.\.\.\(picked\.size > 0\s*\n?\s*\?\s*\(\[/);
    // The four extend chords are OUTSIDE that spread: they are how a selection starts, so a
    // key that creates the state cannot be gated on the state.
    const spreadAt = view.indexOf("...(picked.size > 0");
    expect(view.indexOf('chord: "shift+ArrowDown"'), "the extend chords were gated on a selection")
      .toBeLessThan(spreadAt);
    expect(view.indexOf('chord: "shift+ArrowUp"')).toBeLessThan(spreadAt);
  });

  it("one row per chord — so ⌫ is never listed twice", () => {
    /**
     * THE CORRECTION. The ruling's risk list expected TWO ⌫ rows in the sheet while a selection
     * stands — the shell's "Move it to Trash" beside the view's "Move the selection to Trash" —
     * on the premise that the sheet folds by LABEL. It folds by CHORD (`groupedBindings`), so
     * there is exactly one row for ⌫ at any moment and it carries the label of whichever
     * binding would actually fire. There is nothing to disambiguate; what has to be true is
     * that the surviving row is the LIVE one, which is what this asserts.
     */
    const shellRow: KeyBinding = {
      chord: "Backspace", group: "message", label: en.ohbox.keySelDelete, run: () => {},
    };
    const viewRow: KeyBinding = {
      chord: "Backspace", group: "message", label: "Move it to Trash", disabled: true, run: () => {},
    };
    const rowsFor = (bindings: KeyBinding[]): KeyBinding[] =>
      groupedBindings(bindings).flatMap((g) => g.items).filter((b) => b.chord === "Backspace");

    // A disabled declaration never shadows an enabled one below it…
    expect(rowsFor([viewRow, shellRow])).toHaveLength(1);
    expect(rowsFor([viewRow, shellRow])[0]!.label).toBe(en.ohbox.keySelDelete);
    // …and two enabled ones still collapse to the FIRST, which is the one the dispatcher runs.
    expect(rowsFor([{ ...viewRow, disabled: false }, shellRow])).toHaveLength(1);
    expect(rowsFor([{ ...viewRow, disabled: false }, shellRow])[0]!.label).toBe("Move it to Trash");
  });
});

/* ══ the phone's way in ══════════════════════════════════════════════════════════════════ */

describe("a long press starts a selection on a phone", () => {
  /**
   * WITHOUT THIS THE PILL NEVER MOUNTS ON A PHONE — `x` needs a keyboard and ⇧-click needs a
   * modifier, so every verb the selection bar offers was desktop-only. That is why this lands
   * as its own commit: the bar itself is width-agnostic and ships with the desktop path, and
   * if this gesture had slipped, a phone would simply never have seen the bar rather than
   * seeing a dead one.
   */
  it("450ms of touch on a row picks it and mounts the pill", async () => {
    vi.useFakeTimers();
    await mountShell();
    setPhone();
    const row = rows()[1]!;
    await pointer(row, "pointerdown", { pointerType: "touch" });
    expect(pickedRows(), "the hold picked before its timer ran").toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(pickedRows(), "a 450ms touch hold did not pick the row").toHaveLength(1);
    // …and the click closing the hold's own press does NOT then open the reader.
    await pointer(row, "pointerup", { pointerType: "touch" });
    await click(row);
    expect(pickedRows(), "the hold's own click was read as a tap").toHaveLength(1);
    expect(host!.querySelector(".view-ohbox .list-foot .msg-actions > .abar")).toBeTruthy();
  });

  it("a MOUSE hold does nothing — the desktop has `x` and ⌘-click", async () => {
    /* Drop the `pointerType` guard and this goes red: a click somebody takes their time over
       would start selecting rows on a machine that never asked for the gesture. */
    vi.useFakeTimers();
    await mountShell();
    setPhone();
    await pointer(rows()[1]!, "pointerdown", { pointerType: "mouse" });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(pickedRows()).toHaveLength(0);
    expect(host!.querySelector(".view-ohbox .list-foot")).toBeNull();
  });

  it("a finger that MOVES is scrolling, not selecting", async () => {
    vi.useFakeTimers();
    await mountShell();
    setPhone();
    const row = rows()[1]!;
    await pointer(row, "pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 });
    // Past `DRAG_SLOP_PX` — a selection appearing mid-scroll is the worst kind of surprise.
    await pointer(row, "pointermove", { pointerType: "touch", clientX: 10, clientY: 40 });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(pickedRows()).toHaveLength(0);
  });

  it("a press that ENDS before the timer is a tap", async () => {
    vi.useFakeTimers();
    await mountShell();
    setPhone();
    const row = rows()[1]!;
    await pointer(row, "pointerdown", { pointerType: "touch" });
    await act(async () => { vi.advanceTimersByTime(200); });
    await pointer(row, "pointerup", { pointerType: "touch" });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(pickedRows(), "a short tap started a selection").toHaveLength(0);
  });

  it("while a selection stands, a tap TOGGLES a row instead of opening it", async () => {
    vi.useFakeTimers();
    await mountShell();
    setPhone();
    await hold(rows()[1]!);
    expect(pickedRows()).toHaveLength(1);

    /* THE LIST-SELECTION CONTRACT. Without it the only way to build a set on a phone is one
       long press per row, and the first tap after entering the mode leaves it — opening the
       reader over the selection that has just appeared. */
    const before = host!.querySelectorAll(".reader, .sheet").length;
    await tap(rows()[2]!);
    expect(pickedRows(), "the tap did not add the second row").toHaveLength(2);
    expect(host!.querySelectorAll(".reader, .sheet").length, "the tap opened the reader").toBe(before);

    // …and a tap on a picked row takes it back out.
    await tap(rows()[2]!);
    expect(pickedRows()).toHaveLength(1);
  });

  it("the count capsule is the way OUT of the mode", async () => {
    vi.useFakeTimers();
    await mountShell();
    setPhone();
    await hold(rows()[1]!);
    await click(countCapsule());
    expect(pickedRows()).toHaveLength(0);
    expect(host!.querySelector(".view-ohbox .list-foot")).toBeNull();
  });

  it("the row suppresses the platform's own hold menu", () => {
    /* iOS Safari raises the callout over a held button at about the moment the selection
       appears under it. The row is a `<button>`, so there is no text selection to suppress
       and this is the only half that bites. */
    const rowCss = readFileSync("packages/ui/src/composites/row.css", "utf8");
    expect(rowCss).toMatch(/\.row\{[^}]*-webkit-touch-callout:\s*none/);
  });

  it("the gesture is declared beside the drag's, and neither can arm on the other's pointer", () => {
    const view = readFileSync("apps/webapp/app/views/OhboxView.tsx", "utf8");
    const drag = readFileSync("apps/webapp/app/shell/drag-file.ts", "utf8");
    // Both handlers run on the same capture, and each returns early for the other's pointer.
    expect(view).toMatch(/onPointerDownCapture=\{\(e\) => \{ drag\.onPointerDown\(e\); onHoldPointerDown\(e\); \}\}/);
    expect(view).toMatch(/if \(e\.pointerType !== "touch"\) return;/);
    expect(drag, "drag-to-file stopped excluding touch — the two gestures would both arm")
      .toMatch(/if \(e\.pointerType === "touch"\) return;/);
  });
});

/* ══ a shifted press is a different gesture ══════════════════════════════════════════════ */

describe("⇧⌫ is not ⌫", () => {
  /**
   * MEASURED, NOT SUPPOSED. `chordMatches` held only LETTERS to the no-shift rule, on the
   * (correct) argument that `?` is typed with Shift. `Backspace` is not a letter, so a bare
   * `Backspace` binding matched ⇧⌫ — and over a selection that ran the ordinary delete and
   * spent the pick. ⇧⌫ is "delete permanently" on Windows and a line-kill in several editors;
   * somebody pressing it is not asking for this app's undoable delete.
   */
  it("the predicate: a shifted NAMED key does not match its bare chord", () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    for (const k of ["Backspace", "Delete", "Enter", "Escape", "ArrowDown", "ArrowUp"]) {
      expect(chordMatches(k, ev({ key: k, shiftKey: true })), `shifted ${k} matched bare ${k}`).toBe(false);
      // …and the unshifted press still does, or the fix has taken the key away entirely.
      expect(chordMatches(k, ev({ key: k })), `plain ${k} stopped matching`).toBe(true);
    }
  });

  it("…and a chord that ASKS for shift is unaffected", () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(chordMatches("shift+ArrowDown", ev({ key: "ArrowDown", shiftKey: true }))).toBe(true);
    expect(chordMatches("shift+u", ev({ key: "U", shiftKey: true }))).toBe(true);
  });

  it("…and PUNCTUATION typed with Shift still works — `?` opens the sheet on every layout", () => {
    /* The half the original rule got right, and the reason it may not simply become "no shift
       ever": `?` IS Shift+/ on most layouts. Widen the refusal to all non-letters and the
       shortcut sheet becomes unopenable. */
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(chordMatches("?", ev({ key: "?", shiftKey: true }))).toBe(true);
  });

  it("through the shell: ⇧⌫ over a selection does nothing and the pick survives", async () => {
    vi.useFakeTimers();
    await mountShell();
    await pick(2);
    const ids = pickedRows().map((r) => r.dataset.id!);
    sent = [];

    await key("Backspace", { shiftKey: true });
    expect(toasts(), "⇧⌫ opened a delete window").toHaveLength(0);
    expect(pickedRows(), "⇧⌫ spent the selection").toHaveLength(2);
    expect(rows().filter((r) => ids.includes(r.dataset.id!)), "⇧⌫ hid the rows").toHaveLength(2);
    expect(sent, "⇧⌫ reached the wire").toEqual([]);

    // The fixture could have fired: the same key unshifted does open the window.
    await key("Backspace");
    expect(toasts(), "the fixture could not fire at all").toHaveLength(1);
  });

  it("through the shell: ⇧⌦ likewise", async () => {
    vi.useFakeTimers();
    await mountShell();
    await pick(2);
    await key("Delete", { shiftKey: true });
    expect(toasts()).toHaveLength(0);
    expect(pickedRows()).toHaveLength(2);
  });
});

/* ══ nothing may stand over the deck ═════════════════════════════════════════════════════ */

describe("the selection's delete keys are gated on the DOM, not on a list", () => {
  /**
   * MEASURED BEFORE THE GATE EXISTED: three rows picked, the `?` sheet OPEN, one press of ⌫ —
   * and all three were filed with a toast up, through a sheet the person was reading. The
   * shell's own delete keys had a gate; the selection's chords were not on that list and could
   * not have been, because the list enumerated the overlays the SHELL owns and the message More
   * menu's open state lives below it.
   *
   * The gate asks the DOM (`modal-gate.ts#isModalOpen`) and is a binding's `when` rather than a
   * `disabled`: `disabled` is computed while React renders, and a menu opens without the shell
   * re-rendering at all.
   */
  it("with the ? sheet open over a selection, ⌫ does nothing and the pick survives", async () => {
    vi.useFakeTimers();
    await mountShell();
    await pick(3);
    const ids = pickedRows().map((r) => r.dataset.id!);
    sent = [];

    await key("?", { shiftKey: true });
    expect(document.querySelector(".ks"), "fixture: the sheet did not open").toBeTruthy();

    await key("Backspace");
    expect(toasts(), "⌫ opened a delete window through an open sheet").toHaveLength(0);
    expect(pickedRows(), "⌫ spent the selection through an open sheet").toHaveLength(3);
    expect(rows().filter((r) => ids.includes(r.dataset.id!)), "the rows were hidden").toHaveLength(3);
    expect(sent, "a delete reached the wire through an open sheet").toEqual([]);
  });

  it("…and once the sheet closes the same key works — the gate is a gate, not a removal", async () => {
    /* The half that makes the case above mean something: a `when` that answered false always
       would satisfy it and would have taken the verb away entirely. */
    vi.useFakeTimers();
    await mountShell();
    await pick(3);
    await key("?", { shiftKey: true });
    await key("Escape");
    expect(document.querySelector(".ks"), "fixture: the sheet did not close").toBeNull();
    expect(pickedRows(), "Escape cleared the selection instead of the sheet").toHaveLength(3);

    await key("Backspace");
    expect(toasts(), "the verb did not come back when the sheet closed").toHaveLength(1);
  });

  it("the predicate, over the cases THIS lane depends on", () => {
    /**
     * `isModalOpen` is ITEM-10's, and what is asserted here is only what the selection's chords
     * rely on: an empty deck permits, an open menu or popover over the deck gates, and the
     * READING SHEET does not — the sheet is the reading surface, and a delete pressed on the
     * message being read is the verb somebody meant.
     *
     * DELIBERATELY NOT ASSERTED: a dialog NESTED inside the sheet. That case is ITEM-10's
     * contract and it currently contradicts itself — the file's header says "a real dialog
     * nested inside the sheet still gates", and `el.closest(READING_SURFACE)` skips exactly
     * those, so it does not. Reported to them rather than pinned here: writing `toBe(false)`
     * for it would make this file a second guard holding the defect in place.
     */
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      expect(isModalOpen(document), "an empty deck gated").toBe(false);
      host.innerHTML = '<div class="reader" role="dialog" aria-modal="true">reading</div>';
      expect(isModalOpen(document), "the reading sheet was treated as a question").toBe(false);
      host.innerHTML = '<div role="menu">More</div>';
      expect(isModalOpen(document), "an open menu did not gate").toBe(true);
      host.innerHTML = '<div class="senderm" role="dialog">screening</div>';
      expect(isModalOpen(document), "a sender popover over the deck did not gate").toBe(true);
      host.innerHTML = '<div role="dialog" hidden></div>';
      expect(isModalOpen(document), "a hidden dialog gated").toBe(false);
    } finally {
      host.remove();
    }
  });
});
