/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";
import { COMPACT_LABELS } from "../app/shell/bar-density";
import { act, caseLive, endCase, tracked } from "./_case-fence";

/**
 * THE MESSAGE ACTION BAR.
 *
 * A report, from reading their own mail: *"it breaks a line and doesn't show shortcuts and my
 * feedback already given, allow mark read / unread in it intelligently"* — the SECOND time
 * this surface has been reported, which is the actual severity.
 *
 * Three of the four defects are layout and are asserted in a real browser, where layout
 * exists; jsdom has none and a test that claimed otherwise would be theatre. What is
 * asserted HERE is everything the browser cannot watch fail:
 *
 *   · the STRUCTURE that makes wrapping unreachable rather than merely unlikely,
 *   · that every keycap is READ FROM THE REGISTRY and none is typed at the call site
 *     (the defect that put a lone `s` in the label row), and
 *   · that the read switch PRESSES `u` instead of dispatching its own `mark_seen` — which
 *     is what keeps `OhboxView`'s dwell pin in force. See `ohbox-read-state.test.ts`,
 *     *"`u` is not undone by a dwell that is already ticking"*: a button with its own
 *     mutation would be reverted by that timer two seconds later, which is that guard's
 *     defect reintroduced through a door it does not watch.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");

/**
 * Every chord the bar renders a `<Key>` for, in the order the row shows them.
 *
 * `u` AND `shift+i` are both here and only ONE is ever on the row: the read control is one slot
 * holding whichever direction the message's state makes available — `u` on a read message,
 * `⇧I` on an unread one. `msg()` defaults to READ, so the cap assertions below see `u`.
 *
 * `t` IS THE TAG VERB'S KEY AND IT IS NOT A NEW BINDING. It has been live in `OhboxView` since
 * tagging shipped and the `?` sheet has always listed it; what changed is that the bar now
 * advertises it, from the same registry every other cap here is read from.
 */
const BAR_CHORDS = ["r", "a", "e", "b", "t", "s", "u", "shift+i"] as const;

function msg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: "Glaze order #2214",
    from: { name: "Giulia", address: "giulia@example.invalid" },
    to: [],
    cc: [],
    date: "2026-08-04T09:00:00.000Z",
    folder: "INBOX",
    snippet: "preview",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-04T09:00:00.000Z",
    ...over,
  };
}

/**
 * A MESSAGE WITH AN AUDIENCE — the override that turns `msg()` into the bar's WIDEST shape.
 *
 * Two listed recipients and no `ownAddresses` on the chrome (the demo/Desktop condition) is what
 * `replyAllRecipients` admits, so the row grows a Reply-all group. It lives at module scope
 * because two describes need the same shape: the Reply-all cases below, and the density cases
 * that have to walk BOTH shapes — the missing-verbs defect appeared on a bar WITHOUT this group
 * and not on one with it, so a suite that only ever mounts one shape cannot see it.
 */
const AUDIENCE = {
  to: [
    { name: null, address: "me@example.test" },
    { name: "Piet", address: "piet@atelier.example" },
  ],
} as const;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/**
 * Re-render the SAME mount with a different message.
 *
 * Kept because the obvious version of the "a half-open panel must not carry over" test was
 * TAUTOLOGICAL: it called `mountBar` twice, and a fresh mount starts with no panel open
 * whatever the effect does — the mutation that deletes the effect came back GREEN. Changing
 * the prop in place is the only thing that exercises it, because that is what the shell
 * does when the cursor moves.
 */
let rerender: ((message: Record<string, unknown>) => Promise<void>) | null = null;
/**
 * The folders foundation flag the NEXT render's chrome will carry — a mutable cell rather than
 * a mount option alone, so the stale-confirm guard can flip it under an OPEN strip and
 * re-render in place. `undefined` is the field omitted, the provider-less default.
 */
let currentFolders: boolean | undefined;
/**
 * THE MIRROR ANSWER, mutable for the same reason `currentFolders` is: the strip's OWN gate can
 * only be watched by flipping the fact UNDER an open strip and re-rendering, because a fresh
 * mount starts panel-free whatever the gate does. Since "Use folders" stopped being a term this
 * is the only operand left, so it is the one that has to be flippable.
 */
let currentMirror: boolean | undefined;
/** The VERB READER's answer — Delete's gate since a History or Search row is deleted in place. */
let currentVerb: boolean | undefined;
/** What the pane asked the SHELL to do — the `onAction` seam. */
let actions: string[] = [];
/** Message ids the pane asked to TAG — the `onAddTag` seam, for the Tag verb (R7-2). */
let tagged: string[] = [];
/**
 * The ANCHOR each of those asks carried, in the same order.
 *
 * The picker is a `position: fixed` popover placed from a measured rectangle, so the anchor IS
 * the placement — hand it the wrong element and the picker opens somewhere the press was not.
 * The row's own button anchors on itself; the menu's duplicate anchors on More, which is the
 * control that is still on screen when the menu closes.
 */
let tagAnchors: (HTMLElement | null)[] = [];
/** Which registry bindings were RUN, and with what. The read switch's only honest witness. */
let ran: string[] = [];
/**
 * The RENDER GENERATION each run saw.
 *
 * A binding's `run` is a closure over its component's current state — `OhboxView`'s
 * `toggleUnread` reads `m.unread` that way, which is how it knows which direction to flip.
 * Nothing about the binding's SHAPE changes when that state does, so nothing bumps the
 * registry's memo. This records which generation actually ran, which is the only way to see
 * a stale handler being invoked.
 */
let ranGen: number[] = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/**
 * Mount the pane with a real `KeymapProvider` and a declared set of chords.
 *
 * `bound` is the mutation point for every hint assertion: the bar must show a key when it
 * is bound and show nothing when it is not, because that is the difference between reading
 * the registry and printing a string somebody typed.
 */
type MountOpts = { disabled?: readonly string[]; foldersEnabled?: boolean; mirrorHolds?: boolean; verbHolds?: boolean };

/** The modules a mount imports, in one place so the warm-up loads exactly these. */
async function barModules() {
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const { KeymapProvider, useKeyBindings } = await import("../app/shell/keymap.js");
  return { MessagePane, MessageChromeProvider, KeymapProvider, useKeyBindings };
}

/** Counted by the case fence, so a mount that outlives its case cannot write into the next. */
function mountBar(open: Record<string, unknown>, bound: readonly string[] = BAR_CHORDS, opts: MountOpts = {}): Promise<void> {
  caseLive();
  return tracked(mountBarNow(open, bound, opts));
}

async function mountBarNow(open: Record<string, unknown>, bound: readonly string[], opts: MountOpts): Promise<void> {
  await unmount();
  currentFolders = opts.foldersEnabled;
  currentMirror = opts.mirrorHolds;
  currentVerb = opts.verbHolds;
  const { MessagePane, MessageChromeProvider, KeymapProvider, useKeyBindings } = await barModules();
  caseLive();

  /**
   * A view layer that declares exactly the chords this case is about.
   *
   * It holds STATE and every `run` closes over it, which is what `OhboxView` does — and it
   * re-renders itself on each run WITHOUT changing any binding's shape, so the registry
   * never re-registers. That is the exact condition under which a memoised handler goes
   * stale, and the only condition in which the read switch's bug was visible.
   */
  function Declare(): null {
    const [gen, setGen] = React.useState(0);
    (useKeyBindings as (b: unknown[]) => void)(
      bound.map((chord) => ({
        chord,
        group: "message",
        label: `runs ${chord}`,
        disabled: opts.disabled?.includes(chord) ?? false,
        run: () => { ran.push(chord); ranGen.push(gen); setGen((g) => g + 1); },
      })),
    );
    return null;
  }

  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);

  const tree = (message: Record<string, unknown>) =>
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider as never, {
          children: [
            h(Declare, { key: "d" }),
            h(MessageChromeProvider as never, {
              key: "c",
              value: {
                // The folders foundation flag — the gate on the Delete verb (§16.3/§16.7).
                // Omitted by default, exactly like a provider-less mount: the flag-off reader.
                // Read from the mutable cell AT RENDER TIME so a test can flip it in place and
                // re-render — the only way to watch the strip's OWN gate, because a fresh
                // mount starts panel-free whatever that conditional does.
                ...(currentFolders !== undefined ? { foldersEnabled: currentFolders } : {}),
                ...(currentMirror !== undefined ? { mirrorHolds: () => currentMirror } : {}),
                ...(currentVerb !== undefined ? { verbHolds: () => currentVerb } : {}),
                replyTo: null,
                replyBody: "",
                onReplyBody: () => {},
                closeReply: () => {},
                sendReply: () => {},
                replySendState: () => ({ phase: "idle" }),
                openSenderMenu: () => { actions.push("screen"); },
                conversationOf: () => [],
                bodyOf: (m: Record<string, unknown>) => ({ text: m.snippet as string, state: "snippet" }),
                hydrateBody: () => {},
              },
              children: h(MessagePane as never, {
                message,
                tags: [],
                now: NOW,
                onAction: (a: string) => { actions.push(a); },
                onAddTag: (id: string, anchor: HTMLElement | null) => {
                  tagged.push(id);
                  tagAnchors.push(anchor);
                },
              } as never),
            } as never),
          ],
        } as never),
      });

  rerender = async (message: Record<string, unknown>) => {
    await act(async () => { root!.render(tree(message)); });
  };
  await rerender(open);
}

const bar = (): HTMLElement => host!.querySelector<HTMLElement>(".abar")!;
const buttons = (): HTMLButtonElement[] => [...host!.querySelectorAll<HTMLButtonElement>(".abar button")];
/** A bar button whose visible text starts with `label`. */
function btn(label: string): HTMLButtonElement {
  const found = buttons().find((b) => (b.textContent ?? "").trim().startsWith(label));
  if (!found) throw new Error(`no bar button labelled "${label}" — have: ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
}
async function click(label: string): Promise<void> {
  const b = btn(label);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
/** The More disclosure is icon-only, so it is reached by role rather than by label. */
async function openMore(): Promise<void> {
  const more = host!.querySelector<HTMLButtonElement>(".abar-more")!;
  await act(async () => { more.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
/** The keycaps the bar is showing, in DOM order. */
const caps = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>(".abar kbd")].map((k) => k.textContent ?? "");

/* ── the disclosure menu ───────────────────────────────────────────────────────────────── */

const moreBtn = (): HTMLButtonElement => host!.querySelector<HTMLButtonElement>(".abar-more")!;
const menu = (): HTMLElement | null => host!.querySelector<HTMLElement>('[role="menu"]');
const menuItems = (): HTMLButtonElement[] =>
  [...host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const item = (id: string): HTMLButtonElement =>
  host!.querySelector<HTMLButtonElement>(`[role="menuitem"][data-item="${id}"]`)!;
async function pressIn(el: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
async function clickItem(id: string): Promise<void> {
  const b = item(id);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function clickOutside(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

/** The cold view tree, loaded once, so the first case stays on 5 s: 18-32 s in 20 runs under CPUQuota=10%. */
const WARM_BUDGET_MS = 60_000;
beforeAll(async () => { await barModules(); }, WARM_BUDGET_MS);

beforeEach(() => {
  actions = [];
  tagged = [];
  tagAnchors = [];
  ran = [];
  ranGen = [];
  /* The resurface presets mint 09:00 IN THE READER'S ZONE, so the instants asserted below depend
     on which zone that is. Pinned to UTC to match the `timeZone` this file already hands the intl
     provider, and so that the assertions stay about the CHOOSER rather than about the machine
     running the suite. The zone behaviour itself is `reader-zone.test.ts`. */
  setActiveFormatZone("UTC");
});

afterEach(async () => {
  await endCase();
  await unmount();
  setActiveFormatZone(null);
  vi.useRealTimers();
});

/* ══ 0. WHAT THE MEASUREMENT WATCHES ════════════════════════════════════════════════════ */

describe("the density measurement watches the widths it actually reads", () => {
  const realRO = globalThis.ResizeObserver;
  let observed: Element[] = [];

  beforeEach(() => {
    observed = [];
    class RO {
      constructor(private cb: () => void) {}
      observe(t: Element) { observed.push(t); }
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  });
  afterEach(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
  });

  /**
   * THE WIDTHS THIS HOOK READS ARE THE CHILDREN'S, so the children are what it has to watch.
   *
   * Found by review, and it was the most serious finding on this branch. The observer watched the
   * hidden measure row's own box and the container — neither of which need resize when the
   * measured content changes. The copy is `position: absolute` with `overflow: hidden` inside the
   * pill, so in a constrained column its box can stay put while a child grows; and React REUSES
   * that row across message swaps.
   *
   * The sequence that failed: at the 1024px German Triage width, move from a resurfaced message
   * (read slot "Erledigt") to an ordinary read one (slot "Als ungelesen markieren"). The floor
   * grows by the difference between two labels. If neither observed box resized, the previous
   * non-`compact` admission survived, the floor overflowed the pill, and More was pushed past the
   * column — the exact overflow the compact floor exists to prevent, through the one door the
   * observer was not watching. A locale switch, a face switch and a late webfont all trip the
   * same gap.
   *
   * jsdom has no layout, so what is asserted is the thing a stub can witness and the thing that
   * was actually wrong: WHICH elements are observed. The pixels are the browser sweep's.
   */
  it("observes the measure row's GROUPS, not only its box and its container", async () => {
    await mountBar(msg());
    const row = host!.querySelector<HTMLElement>(".abar-measure");
    expect(row, "no measure row rendered — with a ResizeObserver present it must be").not.toBeNull();
    expect(observed, "the measure row's own box is not watched").toContain(row);
    expect(observed, "the pill's container is not watched")
      .toContain(host!.querySelector(".msg-actions"));
    const groups = [...row!.children].filter((c) => c.classList.contains("abar-g"));
    expect(groups.length, "the measure row rendered no groups to watch").toBeGreaterThan(2);
    for (const g of groups) {
      expect(
        observed,
        `the measure row's ${g.className} is not watched — its width can change while neither ` +
          "the row's box nor the container's does, and the admission would go stale",
      ).toContain(g);
    }
  });

  it("re-watches when a group is ADDED between renders — the set is not fixed at mount", async () => {
    /**
     * Round two of the outside review found the first fix incomplete, and it was right.
     *
     * `measureRef` fires on mount and unmount. But the children set is NOT fixed for the life of
     * the row: `canReplyAll` and `canForward` add and remove a direct child, and React REUSES the
     * measure row when they do — so the ref callback never runs and the new group was never
     * observed. Switching in place from a 1:1 message to one with an audience inserted a
     * Reply-all group that nothing watched; neither the row's own box nor the container's had to
     * resize; the previous `data-admit` survived. That admits a LATER group while the newly
     * inserted EARLIER one stays folded, which breaks the greedy prefix the admission rests on —
     * a worse state than the stale floor the first fix was for.
     */
    await mountBar(msg());
    const before = [...host!.querySelectorAll(".abar-measure .abar-g")];
    expect(before.some((g) => g.classList.contains("abar-rall")), "the 1:1 bar has no Reply all")
      .toBe(false);
    // The same mount, a different message — this is what the shell does when the cursor moves.
    await rerender!(msg(AUDIENCE));
    const rall = host!.querySelector(".abar-measure .abar-rall");
    expect(rall, "the reply-all group did not appear in the measure copy").not.toBeNull();
    expect(
      observed,
      "a group that appeared AFTER mount is not watched — its width can change while neither " +
        "the row's box nor the container's does, and the admission would keep a set computed " +
        "for a bar that no longer exists",
    ).toContain(rall);
  });

  it("stops watching a group that has GONE — a detached child must not drive the measurement", async () => {
    /**
     * The other half of the same defect: a group React removed was never unobserved, so a
     * detached child went on driving measurements for a row it had left.
     *
     * What closes it is the re-sync itself — the unobserve happens the moment the group goes.
     * The explicit watched set in the row's TEARDOWN path is belt-and-braces by comparison, and
     * `bar-density.ts` says so where it is written: with the re-sync in place the two ways of
     * listing the children agree, and mutating that line does not turn this red. This case
     * pins the behaviour that matters, which is that the removal is noticed at all.
     */
    const unobserved: Element[] = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe(t: Element) { observed.push(t); }
      unobserve(t: Element) { unobserved.push(t); }
      disconnect() {}
    };
    await mountBar(msg(AUDIENCE));
    const rall = host!.querySelector(".abar-measure .abar-rall");
    expect(rall, "the audience bar has no Reply-all group to lose").not.toBeNull();
    await rerender!(msg());
    expect(host!.querySelector(".abar-measure .abar-rall"), "the group did not go").toBeNull();
    expect(unobserved, "a group that left the row is still being watched").toContain(rall);
  });

  it("the read slot is among the watched groups — it is the one whose label swaps", async () => {
    // The failing sequence turned on the read switch's label changing between messages, so the
    // group carrying it is named rather than left to the general sweep above.
    await mountBar(msg());
    const readGroup = host!.querySelector(".abar-measure .abar-read-g");
    expect(readGroup, "the measure row has no read group").not.toBeNull();
    expect(observed, "the group whose label swaps between messages is not watched")
      .toContain(readGroup);
  });
});

/* ══ 1. THE SHAPE THAT MAKES WRAPPING UNREACHABLE ═══════════════════════════════════════ */

describe("the bar is one object, and its groups are atomic", () => {
  it("hands `.msg-actions` exactly ONE child, so the shared flex-wrap cannot fire", async () => {
    // `.msg-actions` is `display:flex;flex-wrap:wrap` in `packages/ui`, which this slice may
    // not edit — and it is what broke the row mid-group. With one child that fills the line,
    // that wrap has nothing to wrap. Render the buttons as siblings again (the shipped
    // shape) and this goes to 7.
    await mountBar(msg());
    const slot = host!.querySelector<HTMLElement>(".msg-actions")!;
    expect(slot.children).toHaveLength(1);
    expect(slot.firstElementChild!.className).toBe("abar");
  });

  it("puts every verb inside a group — no button is a loose child of the row", async () => {
    // The row is `nowrap` and groups are `flex:none`, so the ONLY thing that can be dropped
    // at a narrow width is a whole group. A button parented directly by `.abar-row` would be
    // outside that rule and is the shape "breaks mid-group" comes from.
    await mountBar(msg());
    const row = host!.querySelector<HTMLElement>(".abar-row")!;
    for (const child of [...row.children]) {
      expect(child.className).toContain("abar-g");
    }
    expect([...row.querySelectorAll(":scope > button")]).toHaveLength(0);
  });

  it("keeps the three horizons in ONE control, not three siblings", async () => {
    // The report and the task list both say these are the same idea at three
    // horizons. Split them back into separate groups and this drops to 1.
    await mountBar(msg());
    const defer = host!.querySelector<HTMLElement>(".abar-defer");
    expect(defer, "the three horizons are not inside one control").not.toBeNull();
    expect(defer!.querySelectorAll("button")).toHaveLength(3);
    expect(defer!.getAttribute("role")).toBe("group");
    expect(defer!.getAttribute("aria-label")).toBeTruthy();
  });
});

/* ══ 2. EVERY KEYCAP COMES FROM THE REGISTRY ════════════════════════════════════════════ */

describe("the bar shows the keys, and reads them from the keymap", () => {
  it("shows a cap for every bound verb — seven, where the bar used to show one", async () => {
    // THE ORIGINAL DEFECT. Before this slice the bar carried exactly one hint, `kbdHint="s"`,
    // typed at the call site: seven verbs with live shortcuts showed nothing and the eighth
    // showed a bare `s`, which is the stray character in the report.
    //
    // SEVEN AND NOT EIGHT, because read-state is TWO bound keys and ONE button: the control
    // shows the key for the direction it is about to take, so exactly one of `u`/`⇧I` is on
    // the bar at a time. `msg()` defaults to READ, so it is offering "Mark unread" (`u`).
    //
    // `t` joined this list when the Tag verb moved into the pill (R7-2). It sits between the
    // three horizons and filing, which is where the button stands.
    await mountBar(msg());
    expect(caps()).toEqual(["r", "a", "e", "b", "t", "s", "u"]);
  });

  it("shows NO cap for a verb whose key is not bound here", async () => {
    // The mutation that matters: make `Key` print its `chord` prop instead of looking the
    // binding up, and this goes red with `b`, `t` and `s` present. A bar that can advertise a
    // dead key is the (i) panel's hand-typed sentence again, which an earlier change removed.
    await mountBar(msg(), ["r", "a", "e", "u"]);
    expect(caps()).toEqual(["r", "a", "e", "u"]);
    expect((btn("Resurface").textContent ?? "")).toBe("Resurface");
    expect((btn("Tag").textContent ?? "")).toBe("Tag");
  });

  it("shows no caps at all with no registry behind it, rather than guessing", async () => {
    // `MessagePane` renders in the desktop shell and in panes mounted with no provider.
    // `useBinding` must answer "no hint", never a remembered one.
    await mountBar(msg(), []);
    expect(caps()).toEqual([]);
  });
});

/* ══ 3. MARK READ / UNREAD, "INTELLIGENTLY" ═════════════════════════════════════════════ */

describe("the read control says what pressing it will DO", () => {
  /**
   * ── THIS REPLACED A `role="switch"`, ON THE OWNER'S CALL, AND IT IS THE STRONGER SHAPE ──
   *
   * The bar used to render a switch labelled "Read" with `aria-checked`, putting the ACTION in
   * the `title` where only a hover finds it. A switch is right for a setting; read-state is a
   * thing you DO to a message, and a control whose visible word is the state leaves the reader
   * to work out which way pressing it goes. The label is the verb now — and it is the same
   * sentence the keyboard's own two verbs use, so the bar and the `?` sheet read alike.
   *
   * The old assertions are not weakened, they are re-pointed: what they protected was "the
   * control must not mislabel itself the moment it has been pressed", and a label that states
   * the direction cannot.
   */
  it("a READ message offers Mark unread", async () => {
    await mountBar(msg({ unread: false }));
    const btn = host!.querySelector<HTMLElement>(".abar-read")!;
    expect(btn.textContent).toContain("Mark unread");
    expect(btn.textContent).not.toContain("Mark read");
  });

  /**
   * ── THE SLOT IS NEVER EMPTY, AND THIS REVERSES AN EARLIER RULING ────────────────────────
   *
   * This case used to assert the opposite — `.abar-read` absent on an unread message — on the
   * argument that opening a message reads it, so a "Mark read" arm acts on a state the message is
   * about to be in anyway. Reported from real use, and the argument does not survive it: reading
   * is committed on the way OUT (`OhboxView`'s departure commit), so an unread message can sit
   * open in front of a reader indefinitely — and a message just put back to unread with `u` is
   * exactly that. The bar then showed nothing where a verb had been, which reads as a control
   * that vanished rather than a state with no verb.
   *
   * The old assertion is not weakened, it is REPLACED by its counterpart: one control, in one
   * slot, whichever direction the state makes available. Both arms are asserted, so neither can
   * quietly become two controls or none.
   */
  it("an UNREAD message offers Mark as read, in the SAME slot", async () => {
    await mountBar(msg({ unread: true }));
    const controls = host!.querySelectorAll(".abar-read");
    expect(controls).toHaveLength(1);
    expect(controls[0]!.textContent).toContain("Mark read");
    expect(controls[0]!.textContent).not.toContain("Mark unread");
    // Same slot: the read group is where it was, and it holds exactly this one verb plus More.
    const group = host!.querySelector<HTMLElement>(".abar-read-g")!;
    expect(group.contains(controls[0]!)).toBe(true);
  });

  it("never both directions at once — the slot is a slot, not a pair", async () => {
    await mountBar(msg({ unread: false }));
    expect(host!.querySelectorAll(".abar-read")).toHaveLength(1);
    expect((bar().textContent ?? "")).not.toContain("Mark read");
    await rerender!(msg({ unread: true }));
    expect(host!.querySelectorAll(".abar-read")).toHaveLength(1);
    expect((bar().textContent ?? "")).toContain("Mark read");
  });

  it("the dot previews the OUTCOME — filled for unread, hollow for read", async () => {
    // The dot is the same mark the list row wears. On "Mark unread" it is what the row will gain;
    // on "Mark as read" it is what the row will lose, so it renders hollow. Drop `abar-dot-off`
    // and both buttons claim the press leaves a dot behind.
    await mountBar(msg({ unread: false }));
    expect(host!.querySelector(".abar-read .abar-dot")!.classList.contains("abar-dot-off")).toBe(false);
    await rerender!(msg({ unread: true }));
    expect(host!.querySelector(".abar-read .abar-dot")!.classList.contains("abar-dot-off")).toBe(true);
  });

  it("is not a switch, and states its verb in the label rather than a title", async () => {
    // The direction must be legible without hovering. Put the word back in a `title` and
    // leave the label static, and this is what says no.
    await mountBar(msg({ unread: false }));
    const btn = host!.querySelector<HTMLElement>(".abar-read")!;
    expect(btn.getAttribute("role")).toBeNull();
    expect(btn.getAttribute("aria-checked")).toBeNull();
  });

  it("shows the `u` keycap on the read control, from the registry", async () => {
    // The one direction the control offers is Mark unread, whose key is `u`, read from the live
    // registry (a chord that moves takes the hint with it). A hand-typed keycap here would be
    // the stray `s` the original bar carried, in a different button.
    await mountBar(msg({ unread: false }));
    expect(host!.querySelector(".abar-read kbd")!.textContent).toBe("u");
  });

  it("shows the `⇧I` keycap on the Mark-as-read arm, from the same registry", async () => {
    /**
     * THE OTHER DIRECTION'S KEY, AND WHY IT IS NOT A SHIFTED `u` OR A TOGGLED ONE.
     *
     * The keyboard here is two directions — `u` unread, `⇧I` read (`OhboxView`'s binding table
     * argues it out; `⇧U` is already the bulk verb). The button presses the direction that exists
     * rather than asking `u` to become a toggle, which is also why the `?` sheet needs no new row
     * to document this control: it is generated from the same registry.
     *
     * `chordKeys` renders the modifier, so a hand-typed "I" here would go red as well.
     */
    await mountBar(msg({ unread: true }));
    expect(host!.querySelector(".abar-read kbd")!.textContent).toBe("⇧ i");
  });

  it("shows NO cap on the Mark-as-read arm where `⇧I` is not bound", async () => {
    // Same rule as every other verb: the bar cannot advertise a key that does nothing here.
    await mountBar(msg({ unread: true }), ["r", "a", "e", "s", "u"]);
    expect(host!.querySelector(".abar-read")!.textContent).toBe("Mark read");
  });
});

describe("the read control presses the KEY — it does not dispatch its own mark_seen", () => {
  it("runs the registry's `u` binding, so OhboxView's dwell pin still applies", async () => {
    /**
     * THE LOAD-BEARING GUARD, UNCHANGED IN SUBSTANCE.
     *
     * `OhboxView.markUnread` sets `pinnedUnread`, and the 2 s dwell checks that ref WHEN ITS
     * TIMER FIRES. A button that called `markSeen` itself could not set the pin, so a click
     * inside the dwell window would be reverted two seconds later by the heuristic — exactly
     * the failure `ohbox-read-state.test.ts` pins for the key, arriving through a door that
     * test does not watch.
     *
     * Mutation: replace the body of `markUnread` with `onAction("unread")` and this goes red
     * on BOTH arms — `ran` stays empty and `actions` gains "unread".
     */
    await mountBar(msg({ unread: false }));
    await click("Mark unread");
    expect(ran).toEqual(["u"]);
    expect(actions).toEqual([]);
  });

  it("presses the CURRENT handler each time, not the one the registry last memoised", async () => {
    /**
     * THE BUG THIS SEAM SHIPPED AND A BROWSER CAUGHT.
     *
     * The control was `useBinding("u")?.run()`. `Registry.bindings` is memoised on `version`,
     * which bumps only when a layer's SHAPE changes — and `u`'s shape is identical from one
     * render to the next. So the array kept the closure from the last shape change, and the
     * SECOND press re-ran the FIRST press's handler: on the live demo two presses marked the
     * message read twice, while two presses of the KEY at the same cadence behaved, because the
     * dispatcher walks `ordered()` at keypress time.
     *
     * Both presses seeing generation 0 is that defect. Restore `useBinding(...)!.run(...)` in
     * `markUnread` and this goes red with `[0, 0]`.
     */
    await mountBar(msg({ unread: false }));
    await click("Mark unread");
    await click("Mark unread");
    expect(ran).toEqual(["u", "u"]);
    expect(ranGen, "the second press ran a handler from a previous render").toEqual([0, 1]);
  });

  it("falls back to the shell only where the key is not bound at all", async () => {
    // The desktop shell and a provider-less mount have no keymap. The verb must still work
    // there — it simply cannot set a pin that does not exist in that surface either.
    await mountBar(msg({ unread: false }), []);
    await click("Mark unread");
    expect(actions).toEqual(["unread"]);
  });

  it("does not press a DISABLED binding, it uses the fallback", async () => {
    // A disabled binding is one the dispatcher would skip; pressing its `run` anyway would
    // make the button do what the key refuses to do.
    await mountBar(msg({ unread: false }), BAR_CHORDS, { disabled: ["u"] });
    await click("Mark unread");
    expect(ran).toEqual([]);
    expect(actions).toEqual(["unread"]);
  });

  it("Mark as read runs the registry's `⇧I` binding — the READ direction, never `u`", async () => {
    /**
     * THE HALF THAT WOULD SILENTLY DO THE OPPOSITE.
     *
     * Both directions live in one slot, so a button wired to the wrong chord is a control that
     * marks a message unread when its own label says "Mark as read" — and nothing about the
     * rendering would show it. `ran` names the chord that actually ran, which is the only witness.
     *
     * Mutation: point `markRead` at `press("u")` and this goes red with `["u"]`.
     */
    await mountBar(msg({ unread: true }));
    await click("Mark read");
    expect(ran).toEqual(["shift+i"]);
    expect(actions).toEqual([]);
  });

  it("Mark as read falls back to the shell where `⇧I` is not bound", async () => {
    // The desktop shell and a provider-less mount. `unread` is the shell's deliberate FLIP, so it
    // is the right fallback for both directions — see `MessageAction`.
    await mountBar(msg({ unread: true }), []);
    await click("Mark read");
    expect(ran).toEqual([]);
    expect(actions).toEqual(["unread"]);
  });

  it("Mark as read does not press a DISABLED `⇧I` either", async () => {
    await mountBar(msg({ unread: true }), BAR_CHORDS, { disabled: ["shift+i"] });
    await click("Mark read");
    expect(ran).toEqual([]);
    expect(actions).toEqual(["unread"]);
  });
});

/* ══ 4. NOTHING WAS LOST IN THE REGROUPING ══════════════════════════════════════════════ */

describe("every verb the flat row had is still reachable", () => {
  it("dispatches reply, two horizons and screening from the row; resurface via its chooser", async () => {
    await mountBar(msg());
    await click("Reply");
    await click("Later");
    await click("Park");
    // Resurface no longer fires on the row — it asks "when?" first, and a preset feeds a
    // concrete instant. `Tomorrow` from NOW (2026-08-04) is 2026-08-05 at 09:00 in the reader's
    // zone, which this file pins to UTC (see `beforeEach`).
    await click("Resurface");
    await click("Tomorrow");
    await click("Screening");
    expect(actions).toEqual([
      "reply", "later", "aside", "resurface:2026-08-05T09:00:00.000Z", "screen",
    ]);
  });

  it("still reaches Move, and Move still carries its destination", async () => {
    await mountBar(msg());
    await click("Move");
    // The bar is REPLACED by the destination row — it does not grow.
    expect(host!.querySelector(".abar-row")).toBeNull();
    await click("→ News");
    expect(actions).toEqual(["move:reads"]);
  });

  it("keeps Draft reply — in More, where the AI verb belongs while no model is connected", async () => {
    // It was `variant="primary"` and it was the button that wrapped onto line two. Demoted
    // rather than deleted; delete it and this goes red.
    await mountBar(msg());
    await openMore();
    await click("Draft reply");
    expect(actions).toEqual(["draft"]);
  });

  it("offers a way back out of both panels", async () => {
    await mountBar(msg());
    await click("Move");
    await click("Cancel");
    expect(host!.querySelector(".abar-row")).not.toBeNull();
    expect(actions).toEqual([]);
  });
});

/* ══ 6. RESURFACE ASKS "WHEN?" ══════════════════════════════════════════════════════════ */

describe("the resurface horizon chooser", () => {
  it("REPLACES the row rather than growing it, and offers Now plus three horizons", async () => {
    await mountBar(msg());
    await click("Resurface");
    // Same discipline as Move: the panel takes the bar's place.
    expect(host!.querySelector(".abar-row")).toBeNull();
    expect(host!.querySelector(".abar-panel")).not.toBeNull();
    const labels = buttons().map((b) => (b.textContent ?? "").trim());
    expect(labels).toContain("Now");
    expect(labels).toContain("Tomorrow");
    expect(labels).toContain("Next week");
    // Now comes FIRST — it is the only answer that costs nothing to change your mind about.
    expect(labels.indexOf("Now")).toBeLessThan(labels.indexOf("Tomorrow"));
    /* "Pick a date" opens the product's own picker, so it is a BUTTON that owns a dialog — not a
       label wrapping the operating system's calendar, which drew itself in its own look, opened
       downward from a control at the foot of the reading column, and ran off the bottom of the
       display. The floor it opens at is asserted below, where the dialog is on screen. */
    const trigger = host!.querySelector<HTMLButtonElement>(".abar-date-trigger");
    expect(trigger, "the panel offers no way to pick a date").not.toBeNull();
    expect(trigger!.tagName, "a label is not a control — the trigger has to be operable").toBe("BUTTON");
    expect(trigger!.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger!.getAttribute("aria-expanded"), "the trigger does not report its dialog").toBe("false");
    expect(host!.querySelector(".dp"), "the picker stands open before anyone asked").toBeNull();
  });

  it("a preset dispatches a CONCRETE instant and closes the panel", async () => {
    await mountBar(msg());
    await click("Resurface");
    await click("Next week");
    // Next Monday after Tuesday 2026-08-04 is 2026-08-10, at 09:00 where the reader is (UTC
    // here) — the wall clock every preset mints, so the label reads it back the same.
    expect(actions).toEqual(["resurface:2026-08-10T09:00:00.000Z"]);
    // …and the bar is back, so a second horizon is not dispatched by accident.
    expect(host!.querySelector(".abar-row")).not.toBeNull();
  });

  /**
   * "NOW" DISPATCHES A STATE, NOT A DATE — and the assertion is written as an inequality on
   * purpose.
   *
   * The tempting implementation is `resurface:<a moment ago>`, which would satisfy any check that
   * merely asked "did something get dispatched". It must not be that: a `bubbled_up` row with a
   * past `bubbleUpAt` pins nothing until a bubble-up pass runs, and a standalone desktop install
   * runs none — so "Now" would mean "in a minute, or never". So the test refuses the whole
   * `resurface:` prefix rather than one particular timestamp.
   */
  it("Now dispatches the direct transition — never a `resurface:` date", async () => {
    await mountBar(msg());
    await click("Resurface");
    await click("Now");
    expect(actions).toEqual(["resurface_now"]);
    expect(actions.every((a) => !a.startsWith("resurface:")), "Now was spelled as a date").toBe(true);
    // …and the bar is back, like every other answer in this panel.
    expect(host!.querySelector(".abar-row")).not.toBeNull();
  });

  /* ── THE PICKER IS OURS ────────────────────────────────────────────────────────────────────
     `NOW` is Tuesday 2026-08-04 and this file pins the reader's zone to UTC, so "tomorrow" is
     the 5th and every day through the 4th is out of reach. */
  const picker = (): HTMLElement | null => host!.querySelector<HTMLElement>(".dp");
  const dayCell = (key: string): HTMLButtonElement | null =>
    host!.querySelector<HTMLButtonElement>(`.dp [data-day="${key}"]`);
  const trigger = (): HTMLButtonElement => host!.querySelector<HTMLButtonElement>(".abar-date-trigger")!;
  /** Open the resurface panel, then the picker inside it. */
  async function openPicker(): Promise<void> {
    await click("Resurface");
    const t = trigger();
    await act(async () => { t.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  }

  it("the trigger opens a month grid, floored at tomorrow", async () => {
    await mountBar(msg());
    await openPicker();
    const dp = picker();
    expect(dp, "pressing Pick a date opened nothing").not.toBeNull();
    expect(dp!.getAttribute("role")).toBe("dialog");
    expect(dp!.getAttribute("aria-label"), "the dialog has no name").toBe("Pick a date");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    /* THE FLOOR, asserted in both directions: every day through today is unreachable, and
       tomorrow is the first that is not. A picker that merely STARTS on tomorrow while leaving
       yesterday pickable is the defect the native input's `min` used to prevent. */
    for (const key of ["2026-08-01", "2026-08-03", "2026-08-04"]) {
      const cell = dayCell(key);
      expect(cell, `${key} is missing from the grid`).not.toBeNull();
      expect(cell!.getAttribute("aria-disabled"), `${key} is pickable — a horizon in the past`).toBe("true");
    }
    expect(dayCell("2026-08-05"), "tomorrow is not in the grid").not.toBeNull();
    expect(dayCell("2026-08-05")!.getAttribute("aria-disabled"), "tomorrow is not pickable").toBeNull();
    // The cursor lands on the first PICKABLE day, never on a disabled cell.
    expect((document.activeElement as HTMLElement).dataset.day, "focus did not enter the grid")
      .toBe("2026-08-05");
  });

  it("picking a calendar day dispatches that day at 09:00 in the reader's zone", async () => {
    await mountBar(msg());
    await openPicker();
    const cell = dayCell("2026-08-20")!;
    await act(async () => { cell.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(actions).toEqual(["resurface:2026-08-20T09:00:00.000Z"]);
    // …and the whole chooser is gone, like every other answer in it, so a second horizon
    // cannot be dispatched by a stray press.
    expect(picker(), "the picker outlived its answer").toBeNull();
    expect(host!.querySelector(".abar-row")).not.toBeNull();
  });

  it("a day before the floor dispatches NOTHING, and the picker stays open", async () => {
    await mountBar(msg());
    await openPicker();
    const past = dayCell("2026-08-04")!;
    await act(async () => { past.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(actions, "a past day was accepted").toEqual([]);
    expect(picker(), "the picker closed on a day it refused — the press looked like it worked")
      .not.toBeNull();
  });

  it("the grid roves with the arrows, and Enter picks the day the cursor is on", async () => {
    await mountBar(msg());
    await openPicker();
    // one day right, then one week down: the 5th → the 6th → the 13th.
    await pressIn(document.activeElement as HTMLElement, "ArrowRight");
    await pressIn(document.activeElement as HTMLElement, "ArrowDown");
    expect((document.activeElement as HTMLElement).dataset.day).toBe("2026-08-13");
    await pressIn(document.activeElement as HTMLElement, "Enter");
    expect(actions).toEqual(["resurface:2026-08-13T09:00:00.000Z"]);
  });

  it("Escape closes the PICKER and returns focus to the capsule — the panel stays", async () => {
    await mountBar(msg());
    await openPicker();
    expect(picker()).not.toBeNull();
    await pressIn(picker()!, "Escape");
    expect(picker(), "Escape left the picker open").toBeNull();
    expect(document.activeElement, "focus was dropped on the floor").toBe(trigger());
    /* Escape dismissed the picker, not the chooser: the panel's own exit is Cancel, and a single
       press that closed both would take a reader two steps back for one. */
    expect(host!.querySelector(".abar-panel"), "Escape took the panel with it").not.toBeNull();
    expect(actions).toEqual([]);
  });

  it("an outside press dismisses the picker, and a message swap closes it", async () => {
    await mountBar(msg());
    await openPicker();
    await clickOutside();
    expect(picker(), "an outside press left the picker standing").toBeNull();
    /* The press dismissed the PICKER only — the chooser is still open, which is why the trigger
       is pressed directly here rather than walking in from the row again. */
    expect(host!.querySelector(".abar-panel"), "the outside press took the panel too").not.toBeNull();
    const t = trigger();
    await act(async () => { t.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(picker()).not.toBeNull();
    // …and a cursor move closes it rather than leaving it over a different message's horizon.
    await rerender!(msg({ id: "m2" }));
    expect(picker(), "the picker survived a message swap").toBeNull();
  });

  it("Cancel dispatches nothing and restores the row", async () => {
    await mountBar(msg());
    await click("Resurface");
    await click("Cancel");
    expect(actions).toEqual([]);
    expect(host!.querySelector(".abar-row")).not.toBeNull();
  });
});

/* ══ 5. THE PANEL AND THE ROW ARE NOT TWO COPIES ════════════════════════════════════════ */

describe("More holds the verbs the row dropped", () => {
  it("carries one tagged twin per foldable verb, and none for the menu-only two", async () => {
    /* The same measurement that puts a verb on the row hides it here, from the other side, so a
       verb is in one place or the other and never in both. jsdom applies no measurement, so what
       is asserted is the HOOK the CSS needs — the widths are checked in a browser.

       ONE TWIN PER VERB, and it used to be one per GROUP: `mm-defer` stood on all three horizons
       and `mm-file` on both filing verbs, so the menu could only ever hide or show a group whole.
       A count of 3 and 2 here was the same atomicity from the menu's side. */
    await mountBar(msg());
    await openMore();
    const { BAR_VERB_ORDER } = await import("../app/shell/bar-density.js");
    for (const { verb } of BAR_VERB_ORDER) {
      if (verb === "rall") continue;                  // absent on a 1:1 bar, asserted elsewhere
      expect(
        menuItems().filter((b) => b.className.includes(`mm-${verb}`)),
        `${verb}: the menu does not carry exactly one switchable twin`,
      ).toHaveLength(1);
    }
    // Draft reply has no row position at all, so it carries no verb class and no measurement can
    // switch it off. Tag it by accident and the AI verb disappears on a wide bar.
    expect(item("draft").className).toBe("mm-item");
  });

  it("MIRRORS THE ROW'S ORDER — Tag stands between the horizons and filing in both halves", async () => {
    // "The same verbs, in the same order they stand in the row" is the menu's one composition
    // rule, and it is what makes a folded verb findable: a reader who has seen Tag between
    // Resurface and Screening on a wide bar looks for it there on a narrow one. Move the item to
    // the end of `menuItems` (where it used to sit, beside Draft) and this goes red.
    await mountBar(msg());
    await openMore();
    const ids = menuItems().map((b) => b.dataset.item);
    expect(ids.indexOf("tag")).toBe(ids.indexOf("resurface") + 1);
    expect(ids.indexOf("tag")).toBe(ids.indexOf("screen") - 1);
  });

  it("carries the Tag verb as a LADDER DUPLICATE, and choosing it opens the picker", async () => {
    /**
     * IT USED TO BE MENU-ONLY, AND THAT IS THE DEFECT THIS SLICE REMOVES.
     *
     * The verb had no row position at all — it carried no group class, exactly like Draft reply,
     * because the only always-visible entry point to tagging was the dashed `+ Tag` chip under
     * the title. The chip is gone (see below), so the menu row is now the FOLDED half of a verb
     * that stands in the row above its tier: it must carry `mm-tag`, or the density queries
     * cannot switch it off and a wide bar offers Tag twice.
     *
     * Mutation: drop `group: "tag"` from the menu item and this goes red on the class assertion
     * while everything else here stays green — which is the whole point of asserting the hook.
     */
    await mountBar(msg());
    await openMore();
    expect(item("tag"), "the Tag verb is missing from the pill menu").not.toBeNull();
    expect(item("tag").className, "the menu's Tag row is not switchable by the ladder")
      .toContain("mm-tag");
    await clickItem("tag");
    expect(menu(), "choosing the verb closes the menu").toBeNull();
    expect(tagged, "the tag picker was not opened for this message").toEqual(["m1"]);
    // Anchored on More, which is the control still on screen once the menu has closed.
    expect(tagAnchors[0], "the menu's Tag row anchored the picker somewhere else").toBe(moreBtn());
  });

  it("IS A MENU, ANCHORED TO ITS BUTTON — not a second row where the first one was", async () => {
    // What More used to do: replace `.abar-row` with `.abar-panel` in the same place. Nothing
    // on screen connected the press to the swap, and the verbs still standing in the row went
    // away with it. Restore the `panel === "more"` branch in `MessagePane.tsx` and this goes
    // red at the first line — the row would be gone.
    await mountBar(msg());
    await openMore();
    expect(host!.querySelector(".abar-row"), "the row it belongs to is still there").not.toBeNull();
    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute("aria-orientation")).toBe("vertical");
    expect(menuItems().length).toBeGreaterThan(0);
    // It is inside the bar, which is the container the density queries ask about — a menu
    // rendered anywhere else could not be switched by them.
    expect(bar().contains(menu()!)).toBe(true);
  });

  it("aria-expanded REPORTS THE MENU — it was the literal `false` and it lied both ways", async () => {
    // With `aria-haspopup` beside it, a hardcoded `false` announced "there is a popup and it is
    // closed" while the disclosure was open. Hardcode it again and this goes red.
    await mountBar(msg());
    expect(moreBtn().getAttribute("aria-haspopup")).toBe("menu");
    expect(moreBtn().getAttribute("aria-expanded")).toBe("false");
    await openMore();
    expect(moreBtn().getAttribute("aria-expanded")).toBe("true");
    await openMore();
    expect(moreBtn().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens with the keyboard IN it, and ArrowDown/Up rove", async () => {
    await mountBar(msg());
    await openMore();
    const ids = menuItems().map((b) => b.dataset.item);
    expect(document.activeElement).toBe(item(ids[0]!));
    await pressIn(menu()!, "ArrowDown");
    expect(document.activeElement).toBe(item(ids[1]!));
    await pressIn(menu()!, "ArrowUp");
    expect(document.activeElement).toBe(item(ids[0]!));
    // …and it wraps, so the list has no dead ends.
    await pressIn(menu()!, "ArrowUp");
    expect(document.activeElement).toBe(item(ids[ids.length - 1]!));
    await pressIn(menu()!, "Home");
    expect(document.activeElement).toBe(item(ids[0]!));
    await pressIn(menu()!, "End");
    expect(document.activeElement).toBe(item(ids[ids.length - 1]!));
  });

  it("Escape closes it and RETURNS FOCUS to the button that opened it", async () => {
    // A menu that closes and drops focus to the document leaves a keyboard user at the top of
    // the page, nowhere near the control they were operating.
    await mountBar(msg());
    await openMore();
    await pressIn(menu()!, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(moreBtn());
  });

  it("an outside press dismisses it", async () => {
    await mountBar(msg());
    await openMore();
    await clickOutside();
    expect(menu()).toBeNull();
  });

  it("a verb closes the menu and dispatches", async () => {
    await mountBar(msg());
    await openMore();
    await clickItem("later");
    expect(menu()).toBeNull();
    expect(actions).toEqual(["later"]);
  });

  it("the two verbs that ask a QUESTION close the menu and open their panel", async () => {
    // Resurface needs a when and Move needs a where, so they keep the sub-row ceremony they
    // already had. Nesting a submenu in a disclosure would be a menu with two menus in it.
    await mountBar(msg());
    await openMore();
    await clickItem("resurface");
    expect(menu()).toBeNull();
    expect(actions, "opening the chooser is not itself an action").toEqual([]);
    expect(host!.querySelector(".abar-panel")).not.toBeNull();
    await click("Tomorrow");
    expect(actions).toEqual(["resurface:2026-08-05T09:00:00.000Z"]);

    await openMore();
    await clickItem("move");
    expect(menu()).toBeNull();
    expect(host!.querySelector(".abar-row")).toBeNull();
    await click("→ News");
    expect(actions).toEqual(["resurface:2026-08-05T09:00:00.000Z", "move:reads"]);
  });

  it("closes when the CURSOR moves to another message", async () => {
    // The same rule the half-open panel has: a menu left standing over the next message's verbs
    // would act on mail nobody opened. Re-rendered in place, not remounted — a fresh mount has
    // no menu open whatever the effect does, which is how this guard passes without guarding.
    await mountBar(msg());
    await openMore();
    expect(menu()).not.toBeNull();
    await rerender!(msg({ id: "m2" }));
    expect(menu(), "a menu carried onto the next message").toBeNull();
  });

  it("A KEY THE MENU HANDLES REACHES NOTHING ELSE — and `stopPropagation` was not enough", async () => {
    /**
     * MEASURED ON THE DEPLOYED BUILD, not reasoned about: Escape while the menu was open
     * dismissed the menu AND closed the reader sheet underneath it. The keyboard registry
     * listens on `document`; so does React, because the App Router hydrates the whole document.
     * Two bubble-phase listeners on the SAME node run in registration order, and
     * `stopPropagation` only stops the event reaching the next NODE — the registry's listener,
     * already attached to that same node, runs one line later regardless.
     *
     * **THIS HARNESS CANNOT REPRODUCE THE DEFECT, AND SAYING SO IS THE POINT.** It mounts React
     * into a `<div>`, so React's listener is on that div and a plain `stopPropagation` genuinely
     * does stop `document` here. An outcome assertion would therefore be green either way. What
     * is watched instead is the CALL — `stopImmediatePropagation` on the native event — which is
     * the only thing that differs between the broken and the fixed build.
     */
    await mountBar(msg());

    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
      if (!host!.querySelector('[role="menu"]')) await openMore();
      const target = host!.querySelector<HTMLElement>('[role="menuitem"]')!;
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      let immediate = 0;
      e.stopImmediatePropagation = () => { immediate++; };
      await act(async () => { target.dispatchEvent(e); });
      expect(immediate, `${key} did not claim the event away from the document listener`).toBe(1);
    }

    // …and Escape, last in that list, really did close the menu — so the claim is made by the
    // handler that acts, not by a branch that swallows the key and does nothing.
    expect(host!.querySelector('[role="menu"]')).toBeNull();
  });

  it("does NOT hold a Cancel — a menu you can dismiss anywhere needs no exit button", async () => {
    // The panel needed one because it had taken the bar's place and nothing else could bring it
    // back. Escape, an outside press and the button itself all close this, so a Cancel row would
    // be a seventh item that does nothing the other three do not.
    await mountBar(msg());
    await openMore();
    expect(menuItems().map((b) => (b.textContent ?? "").trim())).not.toContain("Cancel");
  });

  it("closes a half-open panel when the CURSOR moves to another message", async () => {
    /**
     * A destination row left standing over the NEXT message would file the wrong mail.
     *
     * This re-renders in place rather than remounting, and that is the whole test: the
     * first version called `mountBar` twice and came back GREEN when the effect was
     * deleted, because a fresh mount has no panel open whatever the effect does. Recorded
     * rather than quietly corrected — a guard nobody has watched fail is not evidence.
     */
    await mountBar(msg());
    await click("Move");
    expect(host!.querySelector(".abar-row")).toBeNull();
    await rerender!(msg({ id: "m2" }));
    expect(host!.querySelector(".abar-row"), "a half-open Move row carried onto the next message").not.toBeNull();
  });
});

/* ══ REPLY ALL — OFFERED EXACTLY WHEN "ALL" IS MORE PEOPLE THAN "REPLY" ═════════════════ */

describe("Reply all appears only on a message with an audience", () => {
  /**
   * The predicate is `replyAllRecipients` (`compose-from.test.ts` owns its arithmetic); what is
   * asserted HERE is the wiring — that the bar consults it at all, on both of its surfaces (the
   * row and the More menu), and that the control dispatches its own action rather than Reply's.
   * This harness supplies no `ownAddresses` on the chrome, which is the demo/Desktop condition:
   * two listed recipients offer the verb, one withholds it.
   */
  const MULTI = {
    to: [
      { name: null, address: "me@example.test" },
      { name: "Piet", address: "piet@atelier.example" },
    ],
  };
  const rallInRow = () =>
    buttons().find((b) => (b.textContent ?? "").trim().startsWith("Reply all")) ?? null;

  it("a multi-recipient message stands Reply all in the row, and it dispatches reply_all", async () => {
    await mountBar(msg(MULTI), [...BAR_CHORDS, "shift+r"]);
    await click("Reply all");
    expect(actions, "the verb must widen the audience, not repeat Reply").toEqual(["reply_all"]);
  });

  it("a 1:1 message renders NO Reply all — not in the row, not in the menu", async () => {
    await mountBar(msg({ to: [{ name: null, address: "me@example.test" }] }));
    expect(rallInRow(), "a Reply all on a 1:1 message is noise").toBeNull();
    await openMore();
    expect(menuItems().some((b) => b.dataset.item === "reply_all")).toBe(false);
  });

  it("shows its keycap FROM THE REGISTRY — ⇧ r when bound, nothing when not", async () => {
    await mountBar(msg(MULTI), [...BAR_CHORDS, "shift+r"]);
    expect(rallInRow()!.querySelector("kbd")?.textContent).toBe("⇧ r");
    await mountBar(msg(MULTI)); // same message, chord unbound — no invented hint
    expect(rallInRow()!.querySelector("kbd")).toBeNull();
  });

  it("the More menu carries the ladder's duplicate (mm-rall), first, mirroring the row", async () => {
    // Same rule as defer/file: the container queries switch the item off exactly where the row
    // button stands, so the verb is in one place or the other and never both. jsdom applies no
    // container query; what is asserted is the hook the CSS needs.
    await mountBar(msg(MULTI));
    await openMore();
    const first = menuItems()[0]!;
    expect(first.dataset.item).toBe("reply_all");
    expect(first.className).toContain("mm-rall");
    await clickItem("reply_all");
    expect(menu()).toBeNull();
    expect(actions).toEqual(["reply_all"]);
  });

  it("keeps the plain Reply button first, so every older Reply selector still finds Reply", async () => {
    // `inline-reply.test.ts` matches the label without its keycap and notes it "still refuses
    // 'Reply all'"; this pins the row order that keeps `startsWith("Reply")` finders honest.
    await mountBar(msg(MULTI), [...BAR_CHORDS, "shift+r"]);
    const labels = buttons().map((b) => (b.textContent ?? "").trim());
    const reply = labels.findIndex((l) => l.startsWith("Reply") && !l.startsWith("Reply all"));
    const rall = labels.findIndex((l) => l.startsWith("Reply all"));
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(rall).toBeGreaterThan(reply);
  });

  it("DECLARES ITS SHAPE — `data-rall` on the pill, from the same predicate as the group", async () => {
    /**
     * `data-rall` says "this bar carries a Reply-all group". No stylesheet reads it any more —
     * the measurement needs no predicate, which is why the per-chain breakpoints it used to
     * select are gone — and it is kept because it is what makes the SHAPE assertable from
     * outside the component: the density cases walk both shapes with it, and the rendered width
     * sweep uses it to pair a bar with the group set it should be standing.
     *
     * It has to come from the SAME `canReplyAll` that renders the group, or it describes a row
     * that is not on screen — and every assertion built on it would then be about a bar that
     * does not exist.
     */
    await mountBar(msg(MULTI));
    const pill = document.querySelector(".abar");
    expect(pill, "no pill rendered").not.toBeNull();
    expect(
      pill!.hasAttribute("data-rall"),
      "the bar stands Reply all in the row but the ladder cannot see it",
    ).toBe(true);
    await mountBar(msg({ to: [{ name: null, address: "me@example.test" }] }));
    expect(
      document.querySelector(".abar")!.hasAttribute("data-rall"),
      "a 1:1 bar claims the Reply-all chain — defer and Tag would fold for a group that is absent",
    ).toBe(false);
  });
});

/* ══ FORWARD IS A VERB OF THE PILL ══════════════════════════════════════════════════════════
 *
 * Reported from real use: *"fwd message / Forward in general should be within our main pill-shaped
 * UI besides Reply etc."* Before this the ONLY mouse door was a message panel's ⋯ menu
 * (`MessageCard.MessageHeader`, dispatching `chrome.forward`) — a disclosure a reader has to
 * already know about, on a verb every message has.
 *
 * The panel menu is deliberately KEPT rather than moved: it is how a SIBLING on an open thread is
 * forwarded without first making it the focused message, which is the whole reason those per-panel
 * menus exist. What this asserts is the bar's half — the row group, its keycap, its ladder
 * duplicate behind More, and the one message class that gets neither.
 */
describe("Forward stands in the pill", () => {
  const fwdInRow = () =>
    buttons().find((b) => (b.textContent ?? "").trim().startsWith("Forward")) ?? null;
  /** Two listed recipients, so the Reply-all group renders and the row order can be read whole. */
  const MULTI_TO = {
    to: [
      { name: null, address: "me@example.test" },
      { name: "Piet", address: "piet@atelier.example" },
    ],
  };

  it("stands in the row and dispatches `forward` — not `reply`, not a navigation", async () => {
    await mountBar(msg());
    expect(fwdInRow(), "Forward has no row position — the ⋯ menu is its only door again").not.toBeNull();
    await click("Forward");
    expect(actions).toEqual(["forward"]);
  });

  it("stands SECOND, between the reply verbs and the horizons", async () => {
    // The row order the ladder mirrors and the More menu repeats. Read against Reply and "Later"
    // rather than by index, so an unrelated group appearing does not move this assertion.
    await mountBar(msg(MULTI_TO), [...BAR_CHORDS, "shift+r", "shift+f"]);
    const labels = buttons().map((b) => (b.textContent ?? "").trim());
    const at = (p: string) => labels.findIndex((l) => l.startsWith(p));
    expect(at("Reply")).toBeGreaterThanOrEqual(0);
    expect(at("Forward")).toBeGreaterThan(at("Reply all"));
    expect(at("Later")).toBeGreaterThan(at("Forward"));
  });

  it("wears the keycap FROM THE REGISTRY — ⇧ f when bound, nothing when not", async () => {
    // The keycap-always law, and the reason it is a law: a hand-typed hint cannot go stale when a
    // chord moves, and an UNBOUND chord must advertise nothing rather than a key that does nothing.
    await mountBar(msg(), [...BAR_CHORDS, "shift+f"]);
    expect(fwdInRow()!.querySelector("kbd")?.textContent).toBe("⇧ f");
    await mountBar(msg()); // same message, chord unbound
    expect(fwdInRow()!.querySelector("kbd")).toBeNull();
  });

  it("both answer verbs carry an icon face and keep their names — the title arrives with the face", async () => {
    await mountBar(msg(MULTI_TO));
    const reply = host!.querySelector<HTMLButtonElement>(".abar-row:not(.abar-measure) .abar-reply");
    expect(reply, "Reply carries no icon-face hook").not.toBeNull();
    expect(reply!.getAttribute("aria-label")).toBe("Reply");
    expect(reply!.querySelector(".abar-ico"), "Reply has no icon face").not.toBeNull();
    expect(fwdInRow()!.getAttribute("aria-label")).toBe("Forward");
    expect(fwdInRow()!.querySelector(".abar-ico"), "Forward has no icon face").not.toBeNull();
    expect(fwdInRow()!.getAttribute("title"), "a title at full words says the word twice").toBeNull();
  });

  it("Forward is FLOOR: in the row at every width, and no twin behind More (DESIGN-026 §2.1)", async () => {
    // A verb is in the row or in the menu, never both — and Forward is now always in the row, so
    // its menu row went with its admission pair. `.abar-v` is the measurement's "admissible" mark:
    // without it the group is counted in the floor and never folds.
    await mountBar(msg(MULTI_TO));
    expect(fwdInRow(), "Forward is not in the row").not.toBeNull();
    expect(fwdInRow()!.closest(".abar-g")!.classList.contains("abar-v"),
      "Forward is still marked admissible — it would fold into More").toBe(false);
    await openMore();
    expect(menuItems().some((b) => b.dataset.item === "forward"),
      "Forward has a More row as well as its capsule").toBe(false);
    expect(menu()!.querySelector(".mm-fwd")).toBeNull();
  });

  it("an OFF-MIRROR message still offers Forward — the press fetches its body first", async () => {
    // FORWARD IS ALWAYS OFFERED (owner, 2026-09-25). A row the mirror does not hold (an archive hit,
    // an older Folder row) keeps the verb in the row; the shell's `openForward` fetches
    // the body through the reader's door and then opens the dock (`forwardPress().fetch`).
    await mountBar(msg(), [...BAR_CHORDS, "shift+f"], { mirrorHolds: false });
    expect(fwdInRow(), "an off-mirror message lost its Forward").not.toBeNull();
    await act(async () => { fwdInRow()!.click(); });
    expect(actions).toEqual(["forward"]);
    await openMore();
    expect(menuItems().some((b) => b.dataset.item === "forward"), "Forward is in the row AND the menu").toBe(false);
  });

  it("a `no_forward` message still offers Forward — in the row; the press asks", async () => {
    // The reported defect: a tax document flagged `otp` showed only Reply. The verb stays; the
    // shell's `openForward` opens the dock on the one-sentence ask (`forwardPress().ask`), and the
    // server admits the forward only with `forwardConfirmed`.
    const locked = msg({
      sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: false },
    });
    await mountBar(locked, [...BAR_CHORDS, "shift+f"]);
    expect(fwdInRow(), "a no_forward message lost its Forward").not.toBeNull();
    await act(async () => { fwdInRow()!.click(); });
    expect(actions).toEqual(["forward"]);
    await openMore();
    expect(menuItems().some((b) => b.dataset.item === "forward"), "Forward is in the row AND the menu").toBe(false);
  });
});

/* ══ TAG IS A VERB OF THE PILL — THE UNDER-TITLE `+` IS GONE ═══════════════════════════
 *
 * Reported for the SECOND time: *"Tag + is still under the title and not in the Pill shape (I gave
 * this feedback before). Added Tags should stay where they are, but the + Tag element should go
 * into the Pill UI."* Two halves, and both have to be asserted or the report comes back a third
 * time: the pill gains the ENTRY POINT, and the dashed `+ Tag` chip that used to sit beside the
 * subject is removed rather than left standing as a second door to the same picker.
 *
 * The ASSIGNED chips are deliberately untouched — they stay in the `(i)` disclosure under the
 * title, which is what "Added Tags should stay where they are" says. `viewer-tags-and-stamp`
 * owns that half.
 */
describe("the Tag verb stands in the pill", () => {
  const tagInRow = (): HTMLButtonElement | null =>
    host!.querySelector<HTMLButtonElement>(".abar-tag .abar-b");

  it("renders in the ROW, inside its own density group — not only behind More", async () => {
    // THE REPORT, AS A SELECTOR. Delete the row button and this is what says no; leave it as a
    // loose child of `.abar-row` and the "every verb is in a group" guard above says no.
    await mountBar(msg());
    const button = tagInRow();
    expect(button, "the pill carries no Tag verb — that is the reported defect, verbatim").not.toBeNull();
    expect((button!.textContent ?? "").trim()).toBe("Tagt");
    expect(button!.closest(".abar-row"), "the Tag verb is not in the resting row").not.toBeNull();
  });

  it("opens the EXISTING picker for this message, anchored on ITSELF", async () => {
    /**
     * The verb reuses `onAddTag` — the same seam the `t` key and the bulk bar call, which is the
     * seam `AppShell.openTagPicker` answers by placing `TagPicker`. Nothing here rebuilds a
     * picker, and the anchor is the button that was pressed, so the popover opens over the pill
     * rather than under a control somewhere else in the message.
     *
     * Mutation: point the button at `onAction("draft")`, or hand it `null` for an anchor, and
     * this goes red on the second and third assertions respectively.
     */
    await mountBar(msg());
    await act(async () => {
      tagInRow()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(tagged).toEqual(["m1"]);
    expect(actions, "tagging is not one of the bar's dispatched actions").toEqual([]);
    expect(tagAnchors[0], "the picker was not anchored on the button that opened it")
      .toBe(tagInRow());
  });

  it("shows the `t` cap FROM THE REGISTRY — and none where `t` is not bound", async () => {
    // `t` is `OhboxView`'s tag binding and it predates this button; the bar reads it rather than
    // printing a hint somebody typed, so a chord that moves takes the cap with it. The stream
    // surfaces bind no `t` at all and must advertise none.
    await mountBar(msg());
    expect(tagInRow()!.querySelector("kbd")?.textContent).toBe("t");
    await mountBar(msg(), ["r", "a", "e", "b", "s", "u"]);
    expect(tagInRow()!.querySelector("kbd"), "the bar invented a keycap for an unbound chord")
      .toBeNull();
  });

  it("is ABSENT on a surface that cannot tag, rather than a verb that opens nothing", async () => {
    // `MessageActionBar` is the Reads/Receipts bar and passes no `onTag`. The row must lose the
    // button, exactly as the menu already loses its row — a control that opens nothing is worse
    // than no control.
    const { MessageActionBar } = await import("../app/shell/MessagePane.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: NOW,
          children: h(MessageChromeProvider as never, {
            value: { openSenderMenu: () => {} },
            children: h(MessageActionBar as never, {
              message: msg(), now: NOW, onAction: () => {},
            } as never),
          } as never),
        } as never),
      );
    });
    expect(host!.querySelector(".abar-tag"), "a stream bar offered a tag verb it cannot run")
      .toBeNull();
    expect(host!.querySelector('[role="menuitem"][data-item="tag"]')).toBeNull();
  });

  it("THE UNDER-TITLE `+ Tag` CHIP IS GONE — one entry point, not two", async () => {
    /**
     * The point of the feedback. `Chip variant="add"` rendered a `.addtag` button in
     * `.tag-chrome`, beside the subject, and it opened the same picker this button does. Restore
     * it and this goes red — a second door to one picker is what was reported.
     */
    await mountBar(msg({ labels: ["work"] }));
    expect(host!.querySelector(".addtag"), "the dashed + Tag chip is back under the title")
      .toBeNull();
    expect(host!.querySelector(".tag-chrome .addtag")).toBeNull();
  });
});

/* ══ 7. THE BAR IS A FLOATING PILL, AND IT IS THE WIDTH OF THE MAIL ═════════════════════
 *
 * Both are LAYOUT, and jsdom has none — a rendered assertion here would be theatre. What can be
 * asserted without a layout engine is that the declarations exist and that the halves agree with
 * each other, which is where these regress: someone tidies a `position` or re-hardcodes a
 * `68ch`, every rendered test stays green, and the defect is only visible on screen. The pixel
 * behaviour is checked in a browser at 1440, 1000 and 390.
 *
 * ── THE RULE-EXTRACTION REGEXES ARE ANCHORED, AND THAT IS NOT COSMETIC ──────────────────
 *
 * They used to be unanchored — `/\.msg-actions\{[^}]*\}/` — which is fine while a class appears
 * in exactly one selector and silently wrong the moment it appears in two. `message.css` now
 * carries `.read-col .msg-actions{margin-top:auto}` ABOVE the base rule, and the unanchored form
 * matched that instead: five assertions read a one-declaration rule and failed with messages
 * about `position:sticky` being absent from a stylesheet that declares it. A `^…/m` anchor picks
 * the rule whose selector STARTS the line, which is the base rule in every case here.
 */
describe("the floating bar and the shared measure, as declared", () => {
  const css = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const message = (): string => css("../../../packages/ui/src/composites/message.css");
  const reader = (): string => css("../../../packages/ui/src/composites/reader.css");
  const abar = (): string => css("../app/shell/action-bar.css");
  /** The rule whose selector begins a line — the base rule, never a scoped override above it. */
  const ruleFor = (src: string, selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${esc}\\s*\\{[^}]*\\}`, "m").exec(src)?.[0] ?? "";
  };

  it("STICKY, NOT FIXED — one rule that is correct in the column and in the overlay", async () => {
    // `fixed` pins to the viewport, which is the wrong box in both surfaces: across the message
    // list in the split layout, and outside the floating card in the reader. Swap it and every
    // rendered test stays green.
    const rule = ruleFor(message(), ".msg-actions");
    expect(rule).toContain("position:sticky");
    expect(rule).not.toContain("position:fixed");
  });

  it("THE RESTING POSITION IS THE PINNED POSITION — the named defect, as geometry", async () => {
    /**
     * THE BUG THIS REPLACES, stated so the numbers cannot drift apart again. A sticky box only
     * leaves its flow position once the scroll reaches it, so on a message too short to scroll
     * the bar sits wherever it lies — and it lay 180px up the panel, because `.read-col` padded
     * 132px underneath and `.msg` another 48px. A row of verbs stranded mid-panel.
     *
     * Four declarations have to agree for "pinned" and "at rest" to be the same 12px, and each
     * one alone looks arbitrary — which is exactly why they are asserted together.
     *
     * Mutation: put `padding-bottom:132px` back on `.read-col`, or drop `min-height:100%`, and
     * this goes red while every rendered test in this file stays green.
     */
    const src = message();
    expect(ruleFor(src, ".read-col"), "bottom padding pushes the resting position up the panel")
      .toContain("padding-bottom:0");
    const fill = ruleFor(src, ".read-col > .msg");
    expect(fill, "a short message must still be as tall as the scrollport").toContain("min-height:100%");
    expect(fill, "without a column flex box there is no slack for the bar to take")
      .toContain("flex-direction:column");
    expect(ruleFor(src, ".read-col .msg-actions")).toContain("margin-top:auto");
    // The two 12px values that make the resting gap equal the pinned gap.
    expect(ruleFor(src, ".msg-actions")).toContain("bottom:12px");
    expect(ruleFor(src, ".msg")).toMatch(/padding:26px 34px 12px/);
  });

  it("THE PAPER IS THE PILL — the strip painted the page, the pill paints itself", async () => {
    /**
     * The bar had to be opaque while mail scrolled under a full-width strip, so each surface
     * named its own `--msg-paper` and the bar impersonated it. That made a false floor across
     * the message: the text stopped at a line that was not the end of anything. The skin is on
     * the pill now — its own ground, its own lift — so the positioner paints nothing and the
     * variable is gone from both files rather than left behind unread.
     */
    const positioner = ruleFor(message(), ".msg-actions");
    expect(positioner, "the positioner is painting again — that is the false floor")
      .not.toMatch(/background|box-shadow/);
    const pill = ruleFor(abar(), ".msg-actions > .abar");
    expect(pill).toContain("background: var(--float)");
    expect(pill).toContain("box-shadow: var(--lift-3)");
    expect(pill).toContain("border-radius:var(--r-pill)");
    // Nothing anywhere still declares or reads the token.
    expect(message(), "--msg-paper outlived the strip it existed for").not.toContain("--msg-paper");
    expect(reader(), "--msg-paper outlived the strip it existed for").not.toContain("--msg-paper");
  });

  it("THE REPLY EDITOR STANDS IT DOWN — and takes the pill's skin off with it", async () => {
    // A capsule floating over an open editor is a second control surface competing with the
    // Send row the user is reaching for. Both halves: the box unsticks, the skin comes off.
    const box = ruleFor(message(), ".msg:has(.reply) .msg-actions");
    expect(box, "no rule stands the bar down while a reply is open").not.toBe("");
    expect(box).toContain("position:static");
    const skin = ruleFor(message(), ".msg:has(.reply) .msg-actions > .abar");
    expect(skin, "the pill still floats over the editor").not.toBe("");
    expect(skin).toContain("background:none");
    expect(skin).toContain("box-shadow:none");
    expect(skin).toContain("width:100%");
  });

  it("ONE MEASURE, READ BY THE BODY AND BY THE BAR", async () => {
    // Written twice as `68ch` it would resolve twice, against two different font sizes — the
    // bug it looks like it is preventing. The token is a px measurement for that reason.
    expect(ruleFor(message(), ".msg")).toMatch(/--msg-measure:\s*\d+(\.\d+)?px/);
    expect(ruleFor(message(), ".msg-body")).toContain("max-width:var(--msg-measure)");
    expect(ruleFor(message(), ".msg-actions")).toContain("max-width:var(--msg-measure)");
    expect(message(), "a raw `68ch` is back, and it will resolve differently in each place")
      .not.toContain("68ch");
  });

  it("THE CONTAINER IS THE ANCESTOR, AND THE PILL IS AS WIDE AS ITS VERBS", async () => {
    /**
     * Two rules that only work together, and one that has now been written twice in opposite
     * directions — so the reason is here rather than the answer.
     *
     * `container-type: inline-size` forbids content-based sizing, so the container cannot also be
     * the box that sizes to its contents. It is therefore the ANCESTOR (`.msg-actions`), and the
     * pill switches containment OFF — otherwise it stays the nearer container and the selection
     * bar's queries below would resolve against the wrong box. That half has not moved.
     *
     * THE PILL'S OWN BOX, IN TWO PARTS — the WIDTH and the ANCHOR, and they have different
     * histories.
     *
     * WIDTH. It was `fit-content`; it became `width: 100%` for the report *"the action pill should
     * use its available width"*; and a full-width capsule with `.abar-read-g { margin-left: auto }`
     * put every pixel a folded group gave up into ONE hollow between the last verb standing and the
     * read switch — reported from real use as a pill that is wide and empty with its middle verbs
     * gone, and measured across `fit-render.mjs`'s sweep at up to 232px. "Use the available width"
     * is a question about the ADMISSION, and the admission never read the pill: `bar-density.ts`
     * measures `.msg-actions`, which is full width whatever the capsule does. So `fit-content`
     * stands, and that is the half of the report that was really about the box.
     *
     * ANCHOR. This assertion has now been written in BOTH directions and the reason is here rather
     * than the answer. It read *"the pill is centred again, which is what left slack on both
     * sides"* and required NO `margin-inline` — a `fit-content` block with no auto margin sits at
     * the left of the measure, where the body text starts. Reported from real use afterwards:
     * *"the pill ui element is not always centered … when collapsing the pill ui with the reply
     * actions etc moves to the left"*, and the measurement is unambiguous — over 120 readings the
     * left slack was 0.00px in every one, the right slack ran to 241.9px, and the centre offset was
     * the right slack halved to within 0.000px everywhere, up to 121.0px. The shift was the anchor,
     * not a side effect. The left-edge argument is recorded as superseded in `action-bar.css`'s own
     * header; the rule is `margin-inline: auto` and the pill's centre is the measure's centre.
     *
     * Mutations that must go red HERE: put `width: 100%` back on the pill; drop `margin-inline:
     * auto`; drop `min-width: 0`; drop `container-type: normal`; move the container onto `.abar`.
     * The anchor one is no longer held only here: `fit-render.mjs`'s "the pill is centred" reading
     * measures it in a real browser at every width, over both mounts — which is what the old note
     * said could not be done, on the reasoning that a centred pill that hugs has no hollow inside
     * itself. True, and beside the point: the reading is the pill's centre against its ROW's
     * centre, not a hollow. This test holds the declaration; that one holds the pixels.
     *
     * THE PIXELS ARE NOT HELD HERE. A stylesheet cannot say whether a hollow is on screen —
     * `fit-render.mjs`'s "the pill hugs its verbs" reading does that in a real browser at every
     * width, in both locales, on both faces. This holds the declarations that reading depends on.
     */
    const src = abar();
    expect(ruleFor(src, ".msg-actions"), "nothing declares the container the measurement reads")
      .toContain("container: abar / inline-size");
    const pill = ruleFor(src, ".msg-actions > .abar");
    expect(pill, "the pill is still a container, and it is the nearer one")
      .toContain("container-type: normal");
    /* DECLARATION-ANCHORED, and that is load-bearing rather than fussy: the previous version of
       this test asked `pill.toContain("width: 100%")`, and once `max-width: 100%` was in the same
       rule that assertion passed on the substring of a DIFFERENT declaration. So each is matched
       as its own declaration, from the start of a line. */
    const decl = (name: string) => new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(pill)?.[1].trim() ?? null;
    expect(decl("width"), "the pill fills its row again — that is the hollow, restored").toBe("fit-content");
    expect(decl("margin-inline"), "the pill is anchored at the left again — a fold then moves its centre by half the room it gave up")
      .toBe("auto");
    /* AND `min-width: 0` BESIDE IT, WHICH THIS TEST IS THE ONLY GUARD FOR.
     *
     * The pill is a flex item, so `min-width: auto` makes its floor the row's min-content — and the
     * row is `nowrap` with `flex: none` children, so that floor is the UNFOLDED row. With
     * `fit-content` and no `min-width`, a column too narrow for the compact floor lays the pill out
     * at 173.8px inside a 120px box: outside its container and outside the message. Measured in a
     * real browser (German, paper) at a message measure of 292 / 200 / 150 / 120px; with
     * `min-width: 0` every reading is byte-for-byte what `width: 100%` produced before this change.
     *
     * `fit-render.mjs` cannot see it — its narrowest viewport is a full-width reader sheet whose
     * pill still has ~338px, so the sweep never reaches the state and reads a removal as clean.
     * That is exactly why the declaration is asserted here.
     */
    expect(decl("min-width"), "the pill can lay itself out past the message in the column that is too narrow")
      .toBe("0");
    /* One clamp, not two: `max-width: 100%` was measured to fix the same case from the other side,
       and keeping both leaves a reader unable to tell which one is doing the work. */
    expect(decl("max-width"), "a second clamp for the same case — one of the two is now unwatchable")
      .toBeNull();
    // …and the selection bar's path keeps the container on the bar itself. `@container abar`
    // binds to the nearest named ancestor, so this is what keeps `.pick-bar` unchanged.
    expect(ruleFor(src, ".abar"), "the selection bar lost the container its own rungs read")
      .toContain("container-type: inline-size");
    /* THE FULL-WIDTH ROWS THAT KEEP `margin-left: auto` MEANINGFUL. With a pill that hugs, the
       read group's auto margin has no slack to take — so a reader could take it for dead and
       delete it. It is not: every mount that keeps the bare `.abar`'s own `width: 100%` is a
       full-width row where it still does the separating, and so is the reply-editor stand-down.

       This used to name the selection strip (`.pick-bar > .abar`, `flex: 1 1 100%`) as one of the
       two. There is no such rule any more: a selection's verbs are `.msg-actions > .abar` at the
       foot of the list, the same pill, and they hug like it. The assertion below is repointed
       rather than deleted, and the refusal beside it is what stops the retired strip coming back
       under a rule this test would then pass on. */
    expect(ruleFor(src, ".abar-read-g"), "the read switch stopped standing apart from the verbs")
      .toContain("margin-left: auto");
    expect(ruleFor(src, ".abar"), "the bar's own mounts stopped being full-width rows")
      .toContain("width: 100%");
    /* THE RETIREMENT, ASSERTED FROM THE OTHER SIDE. A guard whose every case checks that something
       is present cannot see something coming back. */
    expect(src, "a `.pick-bar` rule is back — the selection has two shapes again")
      .not.toMatch(/^\s*\.pick-bar[\s.>{]/m);
    expect(ruleFor(message(), ".msg:has(.reply) .msg-actions > .abar"),
      "the reply-editor stand-down stopped being a full-width row")
      .toContain("width:100%");
    /* AND THE STAND-DOWN'S OWN `margin: 0`, WHICH IS WHAT KEEPS THE CENTRING OUT OF IT rather
       than a selector carved around it. Four classes against this rule's two, so it wins wherever
       either block moves to; without it a stand-down row would MATCH the two-class rule above and
       take its `margin-inline: auto`, which on a `width: 100%` box is harmless — until somebody
       narrows the box again. Both twins
       are asserted, because a fix that touches one branch of a pair is half-applied. */
    for (const sel of [".msg:has(.reply) .msg-actions > .abar", ".conv:has(.reply) .msg-actions > .abar"]) {
      expect(ruleFor(message(), sel), `${sel} stopped declaring its own margin — the pill's centring reaches the stand-down`)
        .toContain("margin:0");
    }
    // A wrapped Resurface / Move panel is not a pill — 99px on two lines is a blob — and it is
    // the one shape that still fills the row, so it needs its own width beside the hugging one.
    expect(src).toContain(".msg-actions > .abar:has(> .abar-panel)");
    expect(ruleFor(src, ".msg-actions > .abar:has(> .abar-panel)"), "a panel stopped filling the row")
      .toContain("width: 100%");
  });

  it("THE EXHALE FADES THE CONTROLS, NEVER THE SURFACE THEY ARE PRINTED ON", async () => {
    /**
     * This rule has been narrowed twice by the same argument, and the second time is this
     * slice's: it sat on `.abar` because `.abar` was transparent and `.msg-actions` was the
     * paper. `.abar` IS the paper now, so a pill narrower than the paper is the two-texts defect the first
     * narrowing removed, reintroduced by a selector that stopped meaning what it meant.
     */
    const src = reader();
    expect(src, "the fade is back on the pill — that is the two-texts defect")
      .not.toContain(".msg-actions > .abar{opacity");
    expect(src).toContain(".reader .msg-actions .abar-row");
    expect(src).toContain(".reader .msg-actions .abar-panel");
    // And the touch restore follows it, or it restores an element that no longer fades.
    const touch = /@media \(hover: none\) \{[\s\S]*?\n\}/.exec(abar())?.[0] ?? "";
    expect(touch).toContain(".abar-row");
    expect(touch).toContain(".abar-panel");
  });

  it("AT PHONE WIDTH THE SHEET'S BAR ENDS THE LETTER, IN FLOW AND AT FULL STRENGTH", () => {
    /* Measured from `next start` at 390x640 (WebKit): pinned, the pill stopped at 508-564 over a
       body running to 586, its verbs at 0.35 with no pointer to bring them back. */
    const block = /@media \(max-width: 699\.98px\)\{[\s\S]*?\n\}/.exec(reader())?.[0] ?? "";
    expect(block, "the phone block of reader.css was not found").toContain(".reader-close{");
    expect(block, "the bar is pinned over the letter at phone width").toContain(".reader .msg-actions{position:static}");
    expect(block, "the verbs stay faded at phone width").toMatch(
      /\.reader \.msg-actions \.abar-row,\s*\.reader \.msg-actions \.abar-panel\{opacity:1\}/);
  });

  /**
   * ── THE ONE LAW, READ FROM THE STYLESHEET AND THEN FROM THE CASCADE ───────────────────────
   *
   * A verb is in the row or behind More — never both, never neither — at every width, in either
   * locale, on either face, and on a bar with or without a Reply-all group.
   *
   * This used to be decided TWICE: by static container-query rungs derived from label widths in
   * one reference font, and by the runtime measurement (`bar-density.ts`). The two disagreed, and
   * the rung's rule outranked the measurement's on the MENU half, so a group the measurement had
   * folded was hidden in the row by one mechanism and hidden in the menu by the other — Later,
   * Park and Resurface reachable from nowhere at all. Reported from real use in those terms.
   *
   * The rungs are gone for a message bar. What replaces those tests is the same law asserted the
   * two ways it can now be broken: the stylesheet growing a SECOND rule that touches either half,
   * and the cascade producing the wrong answer for some admission set.
   */
  it("the answer verbs' icon faces, as declared: word hidden, icon shown, 44px kept", async () => {
    const src = abar();
    for (const [tok, v] of [["compact-fwd", "fwd"], ["compact-reply", "reply"]] as const) {
      expect(src).toContain(`.msg-actions .abar[data-admit~="${tok}"] .abar-row .abar-${v} .abar-${v}-lab { display: none; }`);
      expect(src).toContain(`.msg-actions .abar[data-admit~="${tok}"] .abar-row .abar-${v} .abar-ico { display: inline-block; }`);
    }
    expect(src, "the measure copy must read the words, never the icons").toContain(".abar-measure .abar-ico { display: none !important; }");
    const phone = /@media \(pointer: coarse\), \(max-width: 640px\)\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    expect(phone).toContain(".abar-reply,.abar-fwd .abar-b{min-width:44px}");
    expect(phone, "a lone icon sits at the left edge of its 44px target")
      .toContain(".abar-more,.abar-read,.abar-reply,.abar-fwd .abar-b{justify-content:center}");
  });

  it("under 640px the two controls a thumb hunts for are 44 wide: More and the dot-only read switch", () => {
    // DESIGN-026 §2.1: the chevron capsule was ~28px and the compact read switch ~23px wide.
    // The floor rides a coarse pointer at every width too: at 821px the reading pane's 29px Reply and
    // Restore capsules sat beside History, pressed by a thumb.
    const phone = /@media \(pointer: coarse\), \(max-width: 640px\)\{([\s\S]*?)\n\}/.exec(abar())?.[1] ?? "";
    expect(phone, "no touch-floor block (coarse pointer or under 640px) in action-bar.css").toContain(".abar-b{min-height:44px}");
    expect(phone).toContain(".abar-more{min-width:44px}");
    expect(phone).toContain(".abar-read{min-width:44px}");
  });

  it("ONE MECHANISM: exactly one rule pair per verb, and nothing else touches either half", async () => {
    const src = abar();
    const { BAR_VERB_ORDER, BAR_SEGMENTS } = await import("../app/shell/bar-density.js");
    const verbs = BAR_VERB_ORDER.map((v) => v.verb);
    // Not vacuous: the module really does name the seven verbs this file asserts over. Forward is
    // FLOOR (DESIGN-026 §2.1), so no rule may fold it: no floor entry, no admission pair.
    expect(verbs).toEqual(["rall", "later", "aside", "resurface", "tag", "screen", "move"]);
    expect(src, "Forward is admissible again — it would fold into More").not.toContain('data-admit~="fwd"');
    expect(src, "Forward has a menu twin rule").not.toContain(".mm-fwd");
    /* The two segment WRAPPERS are not admissible themselves — each follows its first member —
       so they carry a `display` rule under that member's predicate and are checked as such. */
    const segs = BAR_SEGMENTS.map((x) => x.seg);
    expect(segs).toEqual(["defer", "file"]);

    /**
     * (a) THE FLOOR IS THE BASE RULE. Every verb's ROW half starts hidden — and both segment
     * wrappers with them — so a bar that has not been measured yet (a server render, a
     * hydration pass, any client without a `ResizeObserver`) is Reply, the read switch and
     * More, with everything else behind More. A verb missing from this list would stand in the
     * row at EVERY width, including the ones where it does not fit.
     *
     * DERIVED FROM THE MODULE'S OWN LISTS rather than matched as one literal block: the old
     * pin was a regex naming five selectors in one order, which had to be retyped every time
     * the list changed and said nothing about a verb the module had added.
     */
    const floor = /\n((?:\.[a-z-]+,\n)+\.[a-z-]+) \{ display: none; \}/.exec(src);
    expect(floor, "the floor rule is not in the stylesheet at all").not.toBeNull();
    expect(
      floor![1]!.split(",\n").map((x) => x.trim()).sort(),
      "a verb or a segment wrapper missing from the floor stands in the row at EVERY width",
    ).toEqual([...verbs, ...segs].map((x) => `.abar-${x}`).sort());

    /**
     * (b) ONE PAIR PER VERB, BOTH HALVES UNDER THE SAME PREDICATE. The pair being written
     * together is the whole point: the defect was a row half and a menu half switched by
     * different predicates, which is what made "neither" reachable.
     */
    for (const g of verbs) {
      const rowRule = new RegExp(
        `\\.msg-actions \\.abar\\[data-admit~="${g}"\\] \\.abar-row \\.abar-${g} \\{ display: flex; \\}`, "g",
      );
      const menuRule = new RegExp(
        `\\.msg-actions \\.abar\\[data-admit~="${g}"\\] \\.mmenu \\.mm-${g} \\{ display: none; \\}`, "g",
      );
      expect((src.match(rowRule) ?? []).length, `${g}: the row half is not admitted exactly once`).toBe(1);
      expect((src.match(menuRule) ?? []).length, `${g}: the menu half is not hidden exactly once`).toBe(1);
    }

    /**
     * AND EACH SEGMENT WRAPPER STANDS ON ITS FIRST MEMBER'S PREDICATE, exactly once. Without
     * it the wrapper would sit at `display: flex` with every member folded, paying the row's
     * gap for an empty box — which the pill's hug reading refuses. With the WRONG member it
     * would appear while its first verb was still folded, or stay hidden while that verb stood.
     */
    for (const { seg, first } of BAR_SEGMENTS) {
      const wrap = new RegExp(
        `\\.msg-actions \\.abar\\[data-admit~="${first}"\\] \\.abar-row \\.abar-${seg} \\{ display: flex; \\}`, "g",
      );
      expect((src.match(wrap) ?? []).length, `${seg}: the wrapper does not follow ${first} exactly once`).toBe(1);
    }

    /**
     * (c) AND NOTHING ELSE SETS `display` ON EITHER HALF OF A MESSAGE BAR. This is the guard the
     * deleted rungs would trip: re-introduce any of them and a second `display` rule lands on an
     * `.abar-<g>` or an `.mm-<g>`, which is exactly how the two mechanisms came to disagree.
     *
     * The selection bar is a different surface with a different label set, its own query
     * container and its own two rungs, so `.pick-bar`-scoped rules are allowed by name — and
     * `.abar-panel .abar-p-*` is that bar's own More ROW, not a message's menu.
     */
    /**
     * EVERY STYLESHEET THE BAR IS RENDERED UNDER, not just its own. `action-bar.css` is where
     * these rules belong, but nothing stops a `display` rule on an `.abar-<g>` being written in
     * the app's own sheet or in the shared package — and a sweep that reads one file would call
     * that clean. The point of this case is "there is no second mechanism anywhere", so the
     * search has to be everywhere the bar's classes can be styled from.
     */
    const sheets = [
      src,
      css("../app/app.css"),
      css("../../../packages/ui/src/composites/message.css"),
      css("../../../packages/ui/src/composites/reader.css"),
    ];
    const displayRules = sheets.flatMap((sheet) =>
      [...sheet.matchAll(/([^{}]+)\{[^{}]*display\s*:[^;}]*[;}]/g)]
        .map((m) => m[1]!.trim().replace(/\s+/g, " ")));
    const BASE = [...verbs, ...segs].map((x) => `.abar-${x}`).join(", ");
    /* A segment wrapper's own predicate is its FIRST MEMBER's token, not its own name — so the
       admitted-under check reads the mapping rather than assuming the selector names itself. */
    const predicateFor = (name: string): string =>
      BAR_SEGMENTS.find((x) => x.seg === name)?.first ?? name;
    for (const g of [...verbs, ...segs]) {
      for (const sel of displayRules) {
        if (!sel.includes(`.abar-${g}`) && !sel.includes(`.mm-${g}`)) continue;
        if (sel === BASE) continue;                       // the floor, asserted in (a)
        expect(
          sel.includes(`[data-admit~="${predicateFor(g)}"]`),
          `"${sel}" sets display on a ${g} half without the admission predicate — ` +
            "a second mechanism deciding one question is how a verb ended up in neither place",
        ).toBe(true);
      }
    }

    /**
     * (d) The floor's ONE concession — and it may only take WORDS, never a control.
     *
     * There are two rules here now, not one, and the reason is a second MOUNT rather than a
     * second mechanism: the selection's verbs wear this same pill in the list column's foot,
     * and its floor carries the count capsule's word beside the read switch's. `bar-density.ts`
     * drops the widest ONE of the labels present, so a given pill still yields its words
     * exactly once; what changed is which label that can be.
     *
     * Pinned against `COMPACT_LABELS` — the hook's own list — so the stylesheet and the
     * measurement cannot come apart: a label the hook would measure with no rule to hide it
     * would fold nothing and leave the row overflowing, and a rule with no hook entry would
     * hide a word the floor never accounted for. One rule per entry, and NOTHING ELSE under
     * the compact predicate.
     */
    const compact = displayRules.filter((s) => s.includes('[data-admit~="compact"]'));
    const expected = COMPACT_LABELS.map(
      (l) => `.msg-actions .abar[data-admit~="compact"] .abar-row ${l.label}`,
    );
    expect(
      [...compact].sort(),
      "the compact floor hides something other than exactly the measured labels",
    ).toEqual([...expected].sort());
  });

  /**
   * THE SAME LAW THROUGH THE REAL CASCADE, over the SHIPPED markup.
   *
   * The block above reads the stylesheet as text. This one applies it: jsdom resolves attribute
   * selectors and descendant combinators, which is all the admission block uses, so
   * `getComputedStyle().display` here is the answer a browser gives. What it cannot do is
   * LAYOUT — so the widths at which each set actually occurs are measured in a browser
   * (`bar-density.test.ts` owns which set is produced; the rendered width sweep owns the
   * pixels). What is pinned here is that for EVERY set, every verb lands in exactly one place.
   *
   * BOTH BAR SHAPES, because the defect was shape-dependent: the verbs went missing on a message
   * WITHOUT a Reply-all group and stood correctly on one with it, which is why it read as
   * intermittent rather than as a rule.
   */
  it("EVERY VERB IN EXACTLY ONE PLACE — every admission set, both bar shapes", async () => {
    const { BAR_VERB_ORDER } = await import("../app/shell/bar-density.js");
    const ALL = BAR_VERB_ORDER.map((v) => v.verb);
    const style = document.createElement("style");
    style.textContent = abar();
    document.head.appendChild(style);
    try {
      for (const shape of ["solo", "rall"] as const) {
        await mountBar(shape === "rall" ? msg(AUDIENCE) : msg());
        await openMore();
        const pill = host!.querySelector<HTMLElement>(".abar")!;
        const present = ALL.filter(
          (g) => host!.querySelector(`.abar-row .abar-${g}`) !== null,
        );
        // The shape is the thing being varied, so it is asserted rather than assumed.
        expect(present.includes("rall"), `${shape}: wrong shape mounted`).toBe(shape === "rall");
        expect(present.length, `${shape}: the row lost a verb`).toBeGreaterThanOrEqual(6);
        /**
         * ROW ORDER IS FOLD ORDER, and it is the markup that has to carry it: admission is a
         * greedy PREFIX over this list, so if the DOM order and `BAR_VERB_ORDER` ever disagree
         * the prefix would seat a verb that is not the leftmost one and the row would show a
         * later verb with an earlier one folded.
         *
         * Read off `.abar-v` — the mark for "admitted or folded on its own" — which since the
         * granularity change is a group for a verb that stands alone and a BUTTON for each
         * member of a segment. Reading `.abar-g` alone saw a segment as one element and could
         * not have noticed its members being reordered inside it.
         */
        const domOrder = [...host!.querySelectorAll<HTMLElement>(".abar-row .abar-v")]
          .map((el) => present.find((g) => el.classList.contains(`abar-${g}`)))
          .filter((g): g is (typeof present)[number] => g !== undefined);
        expect(domOrder, `${shape}: the row's DOM order is not the admission order`).toEqual(present);

        const shown = (sel: string): string => {
          const el = host!.querySelector<HTMLElement>(sel);
          return el === null ? "absent" : getComputedStyle(el).display;
        };
        /** Every set the greedy prefix can produce, plus the unmeasured floor and the compact one. */
        const sets: Array<string | null> = [null];
        for (let n = 0; n <= present.length; n += 1) sets.push(present.slice(0, n).join(" "));
        for (let n = 0; n <= present.length; n += 1) {
          sets.push([...present.slice(0, n), "compact"].join(" ").trim());
        }
        for (const admit of sets) {
          if (admit === null) pill.removeAttribute("data-admit");
          else pill.setAttribute("data-admit", admit);
          const named = admit === null ? [] : admit.split(" ").filter((x) => x !== "compact");
          const where = `${shape} data-admit=${admit === null ? "(absent)" : `"${admit}"`}`;
          for (const g of present) {
            const row = shown(`.abar-row .abar-${g}`);
            const menu = shown(`.mmenu .mm-${g}`);
            expect(row, `${where}: the row half of ${g} is missing from the markup`).not.toBe("absent");
            expect(menu, `${where}: the menu half of ${g} is missing from the markup`).not.toBe("absent");
            const inRow = row !== "none";
            const inMenu = menu !== "none";
            // The law, stated as the two ways it breaks — and "neither" is the one that shipped.
            expect(inRow && inMenu, `${where}: ${g} stands in BOTH the row and the menu`).toBe(false);
            expect(inRow || inMenu, `${where}: ${g} is in NEITHER the row nor the menu`).toBe(true);
            // …and which side it is on is the predicate's answer, not an accident.
            expect(inRow, `${where}: ${g} is on the wrong side of the admission`)
              .toBe(named.includes(g));
          }
          /* A verb this message does not render is offered in NEITHER place — Reply all on a
             1:1 bar is absent from the row AND from the menu, not merely hidden in one. */
          for (const g of ALL.filter((x) => !present.includes(x))) {
            expect(shown(`.abar-row .abar-${g}`), `${where}: ${g} is not on this bar but the row has it`)
              .toBe("absent");
            expect(shown(`.mmenu .mm-${g}`), `${where}: ${g} is not on this bar but the menu offers it`)
              .toBe("absent");
          }
          /* FORWARD IS FLOOR: in the row under every set, and never behind More. */
          expect(shown(".abar-row .abar-fwd"), `${where}: Forward is not standing in the row`)
            .not.toMatch(/^(none|absent)$/);
          expect(shown(".mmenu .mm-fwd"), `${where}: Forward has a menu twin`).toBe("absent");
          /* THE COMPACT FLOOR takes the read switch's WORDS and nothing else: the dot and the
             keycap stay, and the button keeps a name (asserted in the read-switch cases above). */
          const lab = host!.querySelector<HTMLElement>(".abar-row .abar-read .abar-read-lab");
          expect(lab, `${where}: the read switch has no label span to give up`).not.toBeNull();
          expect(
            getComputedStyle(lab!).display === "none",
            `${where}: the read switch's words disagree with the compact token`,
          ).toBe(admit !== null && admit.split(" ").includes("compact"));
        }
      }
    } finally {
      style.remove();
    }
  });

  /**
   * `data-admit` NEVER NAMES A VERB THIS BAR DOES NOT RENDER.
   *
   * The attribute is the measurement's answer, and the measurement reads the hidden copy of the
   * row — so the two are the same list by construction. Asserted anyway, because it is the one
   * way the rendered cascade above could be given a set that is meaningless: a `rall` token on a
   * 1:1 bar would admit a verb that is not there, and the pill would carry a gap where the
   * measurement thought a verb stood.
   */
  it("the measurement's answer only ever names verbs the row actually has", async () => {
    const { BAR_VERB_ORDER, admitVerbs } = await import("../app/shell/bar-density.js");
    for (const shape of ["solo", "rall"] as const) {
      await mountBar(shape === "rall" ? msg(AUDIENCE) : msg());
      const present = BAR_VERB_ORDER.filter(
        (v) => host!.querySelector(`.abar-row .abar-${v.verb}`) !== null,
      );
      /* jsdom has no `ResizeObserver`, so the shipped bar carries no attribute at all here —
         which is itself the contract (an unmeasured bar is its floor). The generator is
         therefore exercised directly, over the groups THIS shape renders, and every set it can
         produce is checked against the markup. */
      expect(host!.querySelector(".abar")!.hasAttribute("data-admit"),
        "an unmeasured bar published an admission").toBe(false);
      const names = present.map((v) => v.verb);
      for (let avail = 0; avail <= 1200; avail += 37) {
        const admitted = admitVerbs(
          avail, 200, present.map((v) => ({ name: v.verb, width: 90, seg: v.seg ?? null })), 6,
        );
        for (const g of admitted) {
          expect(names, `${shape} at ${avail}px: the admission names ${g}, which this bar has not got`)
            .toContain(g);
        }
        // A prefix, always — the property `bar-density.test.ts` owns over random rows.
        expect(admitted, `${shape} at ${avail}px: the admission is not a prefix of the row`)
          .toEqual(names.slice(0, admitted.length));
      }
    }
  });

  it("THE LOCALE LANDS ON THE SAME COMMIT AS THE LABELS THE ROW MEASURES", async () => {
    /**
     * `:root[lang]` is a LAYOUT INPUT, not just an accessibility one, and it stayed one when the
     * static per-locale breakpoints went away — because what the bar measures is the RENDERED
     * WIDTH of real labels, and `lang` is what selects the font and the shaping those labels are
     * drawn with. So the attribute has to be written during the render that also swaps the
     * catalogue. In a passive effect it lands one commit LATER, and the frame in between measures
     * German words under the English `lang` — an admission computed against widths that are
     * about to change. On the desktop, which has no server render to make the first paint agree,
     * that frame is every German launch rather than only a switch.
     *
     * Asserted as the absence of the deferral rather than by racing a paint: jsdom has no
     * layout, and `act()` flushes effects before any assertion could observe the gap. Move
     * either write back into a `useEffect` and this goes red.
     */
    for (const rel of ["../app/(product)/LocaleShell.tsx", "../../desktop/src/DesktopLocale.tsx"]) {
      const src = css(rel);
      expect(src, `${rel} no longer stamps <html lang>`).toContain("documentElement.lang");
      const effects = [...src.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}/g)].map((m) => m[1]);
      for (const body of effects) {
        expect(
          body,
          `${rel} defers <html lang> to an effect — the rungs would read a stale locale for a frame`,
        ).not.toContain("documentElement.lang");
      }
      // …and it is guarded, so an unrelated re-render does not touch the DOM every pass.
      expect(src, `${rel} writes <html lang> unguarded on every render`).toMatch(/lastLang/);
    }
  });

  it("THE MENU DROPS UP, and is anchored to the bar it belongs to", async () => {
    const rule = /\.mmenu \{[^}]*\}/.exec(abar())?.[0] ?? "";
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("bottom: calc(100% + 8px)");
    expect(rule).toContain("right: 0");
    // The anchor is stated rather than inherited from `container-type`'s containment, so
    // removing the container query cannot silently move the menu into the page.
    expect(/^\.abar \{[^}]*\}/m.exec(abar())?.[0]).toContain("position: relative");
  });

  it("THE REPLY DOCK IS STICKY IN THE SPLIT COLUMN, AND IT DOES NOT SCROLL", async () => {
    /**
     * jsdom has no layout, so what is asserted is the declaration the behaviour rests on: at
     * split width and with room, the reply dock sticks to the bottom of `.read-col`, so a deep
     * thread scrolls behind it and the panel stays on screen. Drop `position: sticky` and the
     * editor can open below the fold again — the compose-dialog defect this replaces.
     *
     * RE-SPECCED with the fixed-chrome reply panel (the named consumer is
     * `reply-panel.test.tsx`): the dock used to carry `max-height: 45vh; overflow-y: auto` and
     * scrolled the WHOLE panel — toolbar, attachment strip and Send/Cancel all left the screen
     * the moment the panel outgrew the strip, two attachments being enough. The panel bounds
     * its own height against the viewport now and scrolls only its editor body, so a dock that
     * scrolls or caps height is that defect returning — asserted as ABSENCE here.
     */
    const src = reader();
    const dock = /\.read-col \.reply-dock \{[^}]*\}/.exec(src)?.[0] ?? "";
    expect(dock, "no sticky rule for the reply dock").toContain("position: sticky");
    expect(dock).toContain("bottom: 0");
    expect(dock, "the dock scrolls the whole panel again — chrome can leave the screen")
      .not.toContain("overflow");
    expect(dock, "the dock caps the panel again — the viewport bound belongs to `.reply`")
      .not.toContain("max-height");
    // …and it is guarded by width AND height, so it is the split column with room — never the
    // reader overlay (which uses the scroll-into-view fallback) and never a viewport too short.
    expect(src, "the dock is not guarded to the split column with room")
      .toContain("(min-width: 1024px) and (min-height: 640px)");
  });
});

/* ══ TRI-F12 — THE BAR SAYS WHERE THE MESSAGE STANDS ════════════════════════════════════
 *
 * The list rows carry a state badge now (`OhboxView.stateNoteOf`), and the FOOTER — the very
 * control that put the message in its pile — still rendered all three horizons identically.
 * So `a` on something already queued was pressed in good faith, and the button that would
 * un-park a message looked exactly like the one that parks it. The three horizon buttons are
 * TOGGLES (the verb that filed a message takes it out again — see `AppShell`'s later/aside
 * arms), so the state is reported the way a toggle reports it: `aria-pressed`, styled by
 * `action-bar.css` from the same attribute, one source for the screen reader and the eye.
 */
describe("the horizon buttons report the message's current pile (TRI-F12)", () => {
  const filed = (state: string, over: Record<string, unknown> = {}) =>
    msg({
      triage: {
        messageId: "m1",
        state,
        bubbleUpAt: null,
        setAt: "2026-08-04T10:00:00.000Z",
        updatedAt: "2026-08-04T10:00:00.000Z",
        ...over,
      },
    });
  const pressedOf = (label: string): string | null => btn(label).getAttribute("aria-pressed");

  it("a QUEUED message presses Later — and only Later", async () => {
    await mountBar(filed("reply_later"));
    expect(pressedOf("Later")).toBe("true");
    expect(pressedOf("Park")).toBe("false");
    expect(pressedOf("Resurface")).toBe("false");
  });

  it("a PARKED message presses Park — the drag-park's own receipt", async () => {
    await mountBar(filed("set_aside"));
    expect(pressedOf("Park")).toBe("true");
    expect(pressedOf("Later")).toBe("false");
    expect(pressedOf("Resurface")).toBe("false");
  });

  it("a SCHEDULED message presses Resurface", async () => {
    await mountBar(filed("bubbled_up", { bubbleUpAt: "2026-08-10T09:00:00.000Z" }));
    expect(pressedOf("Resurface")).toBe("true");
    expect(pressedOf("Later")).toBe("false");
    expect(pressedOf("Park")).toBe("false");
  });

  it("no triage state presses NOTHING — three honest toggles, all up", async () => {
    // `aria-pressed="false"` and not an absent attribute: these are toggle buttons in both
    // states, and an attribute that appears only when true is a control that changes ROLE
    // with the message.
    await mountBar(msg());
    expect(pressedOf("Later")).toBe("false");
    expect(pressedOf("Park")).toBe("false");
    expect(pressedOf("Resurface")).toBe("false");
  });

  it("the resurface PIN is not a pile — a resurfaced message presses nothing", async () => {
    // `resurfaced` pins the row at the top of the Ohbox; it sits in no bottom pile
    // (`triagePiles` ignores it by construction), so no horizon may claim it.
    await mountBar(filed("resurfaced"));
    expect(pressedOf("Later")).toBe("false");
    expect(pressedOf("Park")).toBe("false");
    expect(pressedOf("Resurface")).toBe("false");
  });

  it("the press moves with the CURSOR — the next message does not inherit it", async () => {
    // Re-rendered in place, not remounted — the same discipline every carry-over guard in
    // this file keeps, because a fresh mount is pressed-free whatever the derivation does.
    await mountBar(filed("set_aside"));
    expect(pressedOf("Park")).toBe("true");
    await rerender!(msg({ id: "m2" }));
    expect(pressedOf("Park")).toBe("false");
  });

  it("…and drops when the message is UNFILED under the open reader", async () => {
    // The other direction of the same edge: the drain (or the toggle itself) clears the
    // state on the message in place, and the button must come up without a remount.
    await mountBar(filed("reply_later"));
    expect(pressedOf("Later")).toBe("true");
    await rerender!(msg());
    expect(pressedOf("Later")).toBe("false");
  });
});

/* ══ THE DELETE VERB — mirror-gated, menu-only, confirm-only (FOLDERS-SPEC.md §16.3/§16.7) ═══
   It was FLAG-gated too, on the "Use folders" foundation, and the first two cases below are the
   inversions of that: the flag is not a term any more. Delete files the message to the mail
   server's own \Trash, a system folder every account already has, so the USER-folders switch was
   never a fact about whether the verb can run — and the same verb over a SELECTION never read it,
   which made one account able to delete a picked pile and not the row under its cursor. */

describe("the Delete verb", () => {
  it("INVERTED (was: absent with the flag off) — it is PRESENT with no flag on the chrome", async () => {
    /* Default mount: no `foldersEnabled` on the chrome at all, which is a provider-less surface
       and a folders-off account alike. This case used to assert the verb was ABSENT here and
       that the reader was byte-identical to the pre-verb one; the gate is the mirror now, and an
       absent mirror probe ADMITS (`!== false`, the reading `forwardAdmitted` has always used), so
       what it asserts is the opposite. The row still has no Delete slot — that is unchanged and
       is about a stray click, not about the flag. */
    await mountBar(msg());
    expect(buttons().map((b) => (b.textContent ?? "").trim())).not.toContain("Delete");
    await openMore();
    expect(buttons().map((b) => (b.textContent ?? "").trim())).toContain("Delete");
    await click("Delete");
    expect(actions, "the entry row dispatched — the ask must come first").toEqual([]);
    const panel = host!.querySelector<HTMLElement>(".abar-panel.abar-delete");
    expect(panel, "the confirm strip is not drawn without the folders flag").not.toBeNull();
    await click("Delete");
    expect(actions).toEqual(["delete"]);
  });

  it("with the flag on it lives in More, opens the CONFIRM, and only the confirm dispatches", async () => {
    await mountBar(msg(), BAR_CHORDS, { foldersEnabled: true });
    // Not on the row — a destructive verb does not get a slot a stray click can land on.
    expect(buttons().map((b) => (b.textContent ?? "").trim())).not.toContain("Delete");
    await openMore();
    await click("Delete");
    // The entry row dispatched NOTHING — the ask replaces the bar first (the mobile reader's
    // ceremony: there is no un-delete on the wire, so the question comes before the act).
    expect(actions).toEqual([]);
    expect(host!.querySelector(".abar-row")).toBeNull();
    const panel = host!.querySelector<HTMLElement>(".abar-panel.abar-delete");
    expect(panel, "the confirm strip").not.toBeNull();
    expect(panel!.textContent).toContain("Delete this message?");
    // The honest sentence renders IN the strip: what physically happens, whose Trash it is.
    expect(panel!.textContent).toContain("Trash folder on your own mail server");
    await click("Delete");
    expect(actions).toEqual(["delete"]);
    // …and the bar is back, so a second press cannot double-dispatch.
    expect(host!.querySelector(".abar-row")).not.toBeNull();
  });

  it("a row NEITHER the mirror nor a page holds gets no Delete — and a History or Search row does", async () => {
    // Both halves gate on `chrome.verbHolds`: the mirror, or the History or Search page the
    // reader opened the row from. `message_delete` acts on either through the one door.
    await mountBar(msg(), BAR_CHORDS, { foldersEnabled: true, verbHolds: false });
    await openMore();
    expect(buttons().map((b) => (b.textContent ?? "").trim())).not.toContain("Delete");
    expect(actions).toEqual([]);
    // THE STORE ROW: not in the mirror, held by its page — offered, and it dispatches.
    await mountBar(msg(), BAR_CHORDS, { foldersEnabled: true, mirrorHolds: false, verbHolds: true });
    await openMore();
    await click("Delete");
    await click("Delete");
    expect(actions).toEqual(["delete"]);
  });

  it("the confirm takes FOCUS on its safe answer and describes the consequence", async () => {
    // The More item that opened the strip unmounts with the menu, so without an explicit move
    // a keyboard user's focus fell to the document; and an alertdialog without
    // `aria-describedby` never reliably announces the sentence that says what Delete does.
    await mountBar(msg(), BAR_CHORDS, { foldersEnabled: true });
    await openMore();
    await click("Delete");
    const dialog = host!.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const note = host!.querySelector<HTMLElement>(".abar-note")!;
    expect(dialog.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.id).not.toBe("");
    // Node identity, not text containment: `document.body.textContent` contains "Cancel" too,
    // and an assertion that matched the body would pass with no focus moved at all.
    const cancel = buttons().find((b) => (b.textContent ?? "").trim() === "Cancel")!;
    expect(document.activeElement).toBe(cancel);
  });

  it("Cancel dispatches nothing and restores the bar", async () => {
    await mountBar(msg(), BAR_CHORDS, { foldersEnabled: true });
    await openMore();
    await click("Delete");
    await click("Cancel");
    expect(actions).toEqual([]);
    expect(host!.querySelector(".abar-row")).not.toBeNull();
  });

  it("INVERTED (was: the flag going off closes the strip) — an open confirm SURVIVES it", async () => {
    /* This case used to be the flag half of the pair: the flag flipped off under an open strip
       and the strip had to vanish, so a stale confirm could not dispatch. The flag is not a gate
       any more, so the correct outcome is the opposite one — the question stands, because
       nothing about it has changed. Kept rather than deleted because it is the assertion that
       would catch the term being re-added at the strip: with the term back, the strip vanishes
       here. */
    await mountBar(msg(), BAR_CHORDS, { foldersEnabled: true, mirrorHolds: true });
    await openMore();
    await click("Delete");
    expect(host!.querySelector(".abar-panel.abar-delete")).not.toBeNull();
    // The flag flips off under the open strip (Settings in another tab, a rolled-back drain).
    currentFolders = false;
    await rerender!(msg());
    expect(
      host!.querySelector(".abar-panel.abar-delete"),
      "the folders flag closed the delete confirm — it is not a gate on this verb",
    ).not.toBeNull();
    // The ceremony is intact: the strip's own button is still the one dispatch site.
    expect(actions).toEqual([]);
    await click("Delete");
    expect(actions).toEqual(["delete"]);
  });

  it("a STALE open confirm cannot dispatch after the MIRROR drops the row — the second gate", async () => {
    /* The strip's own conditional, independent of the menu item's: the mobile reader holds the
       same pair (a review finding on that side), and the parity test pins both. The mirror is
       the only operand left, and it is flipped IN PLACE and re-rendered — a fresh mount starts
       panel-free whatever the gate does, so only this shape can watch it (the harness's own
       carry-over lesson).

       THIS IS WHERE THE WITHDRAW EFFECT IS WATCHED, and it is here rather than at the shell
       because the two operands are independent only here: dropping a row from a real mirror also
       moves the cursor, and the shell clears the bar's panel on a cursor move — so a shell-level
       version of this case would go green with the effect deleted. */
    await mountBar(msg(), BAR_CHORDS, { foldersEnabled: true, verbHolds: true });
    await openMore();
    await click("Delete");
    expect(host!.querySelector(".abar-panel.abar-delete")).not.toBeNull();
    // The row leaves the mirror under the open strip (a drain, a rollback, a folder move).
    currentVerb = false;
    await rerender!(msg());
    expect(host!.querySelector(".abar-panel.abar-delete")).toBeNull();
    expect(buttons().map((b) => (b.textContent ?? "").trim())).not.toContain("Delete");
    // …and the resting bar is back — the strip fell through, it did not leave a hole.
    expect(host!.querySelector(".abar-row")).not.toBeNull();
    expect(actions).toEqual([]);

    /* THE QUESTION IS WITHDRAWN, NOT REMEMBERED. The gate coming back must not re-draw a
       confirmation nobody just asked for — that is the only reading that cannot delete mail
       behind the reader's back, and it is the observable half of the effect above: were the
       panel state merely undrawn, the strip would reappear on this re-render. */
    currentVerb = true;
    await rerender!(msg());
    expect(
      host!.querySelector(".abar-panel.abar-delete"),
      "the confirm came back on its own — the state was remembered, not withdrawn",
    ).toBeNull();
    expect(actions).toEqual([]);
  });
});

/* ══ THE READ SWITCH'S OWN PAIR (DESIGN-FOLD-WIDTHS §7) ═══════════════════════════════
 *
 * Under 400px of room the switch leaves the row for the menu whole (`bar-density.ts`,
 * `foldReadSwitch`), so a phone's bar is Reply · Forward · [Later] · ⌄ and no button on it is a
 * dot with no word. The stylesheet half is the same pair shape every verb keeps, inverted in
 * polarity: the row half is the default and the menu half hidden at rest. Mutation: drop either
 * `read-folded` rule and the pair is "both" or "neither" at 360px. */
describe("the read switch folds into More as one pair", () => {
  // By the repo root, as the geometry tests read their sheets: this file's `import.meta.url` is
  // not a file URL under the jsdom environment the shell arms above run in.
  const sheet = (): string =>
    readFileSync(resolvePath(process.cwd(), "apps/webapp/app/shell/action-bar.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("the menu twin is hidden at rest and the pair swaps on `read-folded`", () => {
    expect(sheet()).toMatch(/\.mm-read \{ display: none; \}/);
    expect(sheet()).toContain('.msg-actions .abar[data-admit~="read-folded"] .abar-row .abar-read { display: none; }');
    expect(sheet()).toContain('.msg-actions .abar[data-admit~="read-folded"] .mmenu .mm-read { display: flex; }');
  });
  it("the measure row FORCES the switch visible, so the fold never zeroes the width that decides it", () => {
    /* Measured the hour the fold shipped: without this rule the `read-folded` pair hid the switch
       in the measure copy as well, the next measurement read it at 0 and withdrew the fold, and
       the bar oscillated on every phone — a press on More landed on the switch's label mid-swap.
       Mutation: delete the rule — red here, and the overlay's More no longer opens its menu. */
    expect(sheet()).toContain(".abar-measure .abar-read { display: flex !important; }");
  });
});
