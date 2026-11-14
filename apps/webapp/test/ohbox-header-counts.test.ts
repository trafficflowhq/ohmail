/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import messages from "../messages/en.json";

/**
 * THE OHBOX HEADER SAYS WHAT IT COUNTS, AND NEVER THROWS THE NOUN AWAY.
 *
 * Reported live, from a real mailbox with most of its senders
 * held at the Screener. The strip rendered:
 *
 *     N unread of M
 *     K new senders waiting          ← clipped to "K new senders wait…"
 *     Screener ›
 *
 * Two failures, one of which is not a layout bug at all:
 *
 *  1. NEITHER LINE NAMED ITS NOUN. These are different quantities — mail sitting in the
 *     Ohbox versus senders held at the door — and at the reported sizes they are close
 *     enough in magnitude that two unlabelled numbers read as one number said twice. No
 *     amount of CSS fixes that; the strings had to change.
 *  2. The one noun that WAS there got clipped, because `doorbell.css:14` puts
 *     `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` on `.db-txt`. An
 *     ellipsis always eats the END of the sentence, and the end of the sentence is where
 *     the noun lives. The tidier the truncation looked, the less the strip said.
 *
 * So the guards below assert the NOUNS and not the digits. A test that only checked for
 * the bare number would have passed against the reported screenshot.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global and why this
// file writes `h(...)` rather than JSX.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The reported mailbox's numbers. Nothing here is a round number by accident. */
const OWNER_TOTAL = 1240;
const OWNER_UNREAD = 2;
const OWNER_WAITING = 1042;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom has no matchMedia; the view asks it whether it is in the split pane. */
function setViewport(mobile: boolean): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query,
      onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

function msg(id: string, unread: boolean): Record<string, unknown> {
  return {
    id,
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: id, address: `${id}@example.com` },
    to: [], cc: [],
    date: "2026-08-04T09:00:00.000Z",
    folder: "INBOX",
    snippet: "preview",
    unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-04T09:00:00.000Z",
  };
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/**
 * Mount the real view.
 *
 * `unread`/`read` are row COUNTS rather than the reported total, because rendering that many
 * `MessageRow`s to assert a header string would be measuring jsdom. The reported
 * numbers are put through the same catalogue entries by `formatted()` below, and the
 * assertion that the view renders exactly what that entry produces is what joins the two.
 */
async function mount(opts: { unread: number; read: number; waiting: number }): Promise<void> {
  await unmount();
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");

  const newForYou = Array.from({ length: opts.unread }, (_, i) => msg(`u${i}`, true));
  const previouslySeen = Array.from({ length: opts.read }, (_, i) => msg(`r${i}`, false));
  const initials = Array.from({ length: Math.min(opts.waiting, 6) }, (_, i) => `S${i}`);

  const tree = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T09:00:00.000Z"),
    children: h(KeymapProvider as never, {
      children: h(OhboxView as never, {
        demo: false,
        // A client with the WHOLE mailbox on the device: `listOlderAvailable()` is false, so the
        // view renders no "load older mail" control and this harness is unchanged by the window.
        older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
        newForYou, previouslySeen,
        tags: [],
        now: new Date("2026-08-04T09:00:00.000Z"),
        selectedId: null,
        onSelect: () => {},
        onEnterReader: () => {},
        onMarkSeen: () => {},
        doorbellInitials: initials,
        doorbellCount: opts.waiting,
        // This file is about what the two counts SAY once they are known. `settled: false` is a
        // different subject entirely — the mirror has not been read, so there is no count to
        // name — and `pending-is-not-empty.test.tsx` owns it. Passed explicitly because the
        // `as never` below means an omission would read as `undefined`, withhold the doorbell,
        // and fail here as a null dereference rather than as a statement about counts.
        settled: true,
        owed: false,
        onDoorbell: () => {},
        onAction: () => {},
        onAddTag: () => {},
        // Present so the header's `.vhead-action` slot is exercised — the one-line guard
        // below asserts count and control share the title row.
        onMarkAllRead: () => {},
      } as never),
    } as never),
  });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(tree); });
}

/**
 * Put the reported numbers through the SAME catalogue entries the view uses, without
 * building a list that long. The probe calls `useTranslations("ohbox")` exactly as
 * `OhboxView` and `DoorbellMessage` do, so a change to either entry lands here.
 */
async function formatted(unread: number, total: number, waiting: number): Promise<{
  meta: string; doorbell: string; aria: string;
}> {
  await unmount();
  const out = { meta: "", doorbell: "", aria: "" };
  const Probe = (): React.ReactElement => {
    const t = useTranslations("ohbox");
    out.meta = t("meta", { count: unread });
    out.aria = t("doorbellAria", { count: waiting });
    return h("span", { id: "probe-doorbell" },
      t.rich("doorbell", { count: waiting, b: (chunks: React.ReactNode) => h("b", null, chunks) }) as React.ReactNode);
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T09:00:00.000Z"),
      children: h(Probe),
    }));
  });
  out.doorbell = host.querySelector("#probe-doorbell")!.textContent ?? "";
  return out;
}

const metaEl = (): HTMLElement => host!.querySelector<HTMLElement>(".vhead .meta")!;
const dbTxt = (): HTMLElement => host!.querySelector<HTMLElement>(".doorbell .db-txt")!;
const dbBtn = (): HTMLElement => host!.querySelector<HTMLElement>(".doorbell")!;

beforeEach(() => { setViewport(false); });
afterEach(async () => {
  await unmount();
  document.head.innerHTML = "";
});

describe("the two counts name what they count", () => {
  it("the mail line says UNREAD and the door line says WAITING — at a real account's numbers", async () => {
    // THE GUARD FOR THE EDITORIAL HALF, re-pinned TWICE. First for the ONE-LINE header: the
    // "of N messages" tail went, which is what lets the title, the count and "Mark all
    // read" share one line, and the rail tooltip (`rail.ohboxTitle`) kept the fuller "unread
    // of … messages" — pinned below. Now for the NOUN: this line said "{count} new" on the
    // recorded ground that the form matched the Reads header, and it stopped matching when
    // Reads began naming the waterline in full ("12 new since you were here"). This number is
    // `unreadIds.length` — the mailbox's own \Seen — so it says "unread". What wrapped the
    // header was the TAIL, not the noun, and `scripts/fit-render.mjs` measures that rather
    // than taking this comment's word for it (360 and 390, both faces, both languages).
    const f = await formatted(OWNER_UNREAD, OWNER_TOTAL, OWNER_WAITING);

    // "first-time senders" stays in `doorbellAria` — the string assistive tech actually
    // reads, because `Doorbell` puts an `aria-label` on the button.
    expect(f.aria).toContain("first-time senders");

    // …and the two counts still name DIFFERENT things, which is the invariant that survived
    // all three edits: "unread" against "waiting". Two lines using the same word would read as
    // one number said twice, which is the original report — and the same failure is now
    // refused across piles as well, since "new" belongs to the streams' waterline sentence
    // (`test/waterline-word.test.tsx`).
    expect(f.meta).toContain("unread");
    expect(f.meta).not.toContain("new");
    expect(f.meta).not.toContain("sender");
    expect(f.meta).not.toContain("waiting");
    expect(f.doorbell).toContain("waiting");
    expect(f.doorbell).not.toContain("unread");

    expect(f.meta).toBe("2 unread");
    expect(f.doorbell).toBe("1,042 waiting");

    // Both counts are GROUPED — `{count, number}` keeps the meta in the same typography as
    // the doorbell's plural `#`, the lesson that a bare ICU `{x}` is stringified raw.
    const big = await formatted(OWNER_WAITING, OWNER_TOTAL, OWNER_WAITING);
    expect(big.meta).toBe("1,042 unread");
  });

  it("the view renders those strings into the strip, not something else", async () => {
    // The join between the catalogue check above and the real component tree: the view has
    // to be reading the same entries. Point `ListPane`'s `meta` at a different key, or drop
    // `DoorbellMessage`, and this goes red.
    await mount({ unread: 2, read: 5, waiting: OWNER_WAITING });
    const f = await formatted(2, 7, OWNER_WAITING);
    await mount({ unread: 2, read: 5, waiting: OWNER_WAITING });

    expect(metaEl().textContent).toBe(f.meta);
    expect(metaEl().textContent).toBe("2 unread");
    expect(dbTxt().textContent).toBe("1,042 waiting");
  });

  it("the header is ONE line: count and action share the title row, exactly like Reads", async () => {
    // The reported defect was a three-line stack — "Ohbox" / "42 unread of N messages" /
    // "Mark all read". The fix is structural sameness with the Reads header: the SAME
    // `.vhead` row carries the title, the `.meta` count and the `.vhead-action` control, so
    // nothing is stacked. Rendering the action outside `.vhead`, or the meta as its own
    // block, goes red here.
    await mount({ unread: 2, read: 5, waiting: 3 });
    const vhead = host!.querySelector<HTMLElement>(".vhead")!;
    expect(vhead.querySelector(".meta")).not.toBeNull();
    expect(vhead.querySelector(".vhead-action")).not.toBeNull();
  });

  it("\"0 unread\" is the settled empty state — the count is withheld only before the mirror has been read", async () => {
    // The catalogue's own zero form (an empty SETTLED mailbox renders it; the pre-settle
    // withholding is `pending-is-not-empty.test.tsx`'s subject). Through the probe rather
    // than a mounted empty view: an empty Ohbox also mounts `SyncState`, which needs the
    // whole `MailStateProvider` harness and would make this a shell test, not a copy pin.
    const f = await formatted(0, 0, 0);
    expect(f.meta).toBe("0 unread");
  });

  it("the announced sentence and the visible one agree", async () => {
    // `doorbellAria` used to be "{count} new senders waiting — open the Screener" with NO
    // plural rule at all, so at one waiting sender the screen reader said "1 new senders"
    // while the screen said "1 new sender". Drop the plural back out of `doorbellAria` and
    // the singular case here goes red.
    await mount({ unread: 1, read: 1, waiting: 1 });
    expect(dbTxt().textContent).toBe("1 waiting");
    expect(dbBtn().getAttribute("aria-label")).toBe("1 first-time sender waiting — open the Screener");

    await mount({ unread: 1, read: 1, waiting: OWNER_WAITING });
    expect(dbBtn().getAttribute("aria-label")).toBe("1,042 first-time senders waiting — open the Screener");
    // THE TWO ARE NO LONGER SUBSTRINGS OF EACH OTHER, so the old `toContain` check would now
    // pass vacuously or fail for the wrong reason. What must still hold after the visible
    // sentence was shortened is that they describe the SAME fact: same grouped number, same
    // verb. A drift where the button says one count and the screen reader says another is the
    // failure this guards, and it is still expressible.
    const seen = dbTxt().textContent!;
    const heard = dbBtn().getAttribute("aria-label")!;
    expect(heard).toContain("1,042");
    expect(seen).toContain("1,042");
    expect(heard).toContain("waiting");
    expect(seen).toContain("waiting");
  });

  it("the rail's tooltip states no total the device cannot know", async () => {
    // `rail.ohboxTitle` is the `title=` attribute on the Ohbox rail item (`RailNav.tsx:142`).
    // Its "of M messages" was the MIRROR's three groups — the window's count on a large mailbox,
    // not the Ohbox's (OHBOX-RAIL-COUNT-IS-THE-WINDOW), and the store answers no Ohbox total. So
    // the tooltip says the unread number alone, as the compact header strip does.
    const rail = (messages as { rail: { ohboxTitle: string } }).rail.ohboxTitle;
    const meta = (messages as { ohbox: { meta: string } }).ohbox.meta;
    expect(rail).toBe("{unread, number} unread");
    expect(rail, "a window's total came back to the tooltip").not.toContain("total");
    expect(meta).toBe("{count, number} unread");
  });

  it("nobody waiting does not read as \"0 first-time senders waiting\"", async () => {
    // THE ZERO GUARD. `Doorbell` collapses to `height:0` at zero (`gone`) but stays in the
    // accessibility tree — it is still a focusable button with an `aria-label` — so the
    // zero branch is not decorative, it is what a screen-reader user hears. The Screener's
    // own `metaWaiting` has said `=0 {all clear}` all along; these entries now do too.
    // Delete the `=0` branch from either and this goes red with the ICU `other` form.
    await mount({ unread: 1, read: 1, waiting: 0 });

    expect(dbTxt().textContent).toBe("All clear");
    expect(dbTxt().textContent).not.toMatch(/\b0\b/);
    expect(dbBtn().getAttribute("aria-label")).toBe("All clear, nobody waiting — open the Screener");
    expect(dbBtn().getAttribute("aria-label")).not.toMatch(/\b0\b/);
  });
});

/**
 * THE CLIPPING GUARD, and the one thing it cannot check.
 *
 * jsdom does not process `import "./doorbell.css"`, so the CSS is injected by hand — but
 * from the REAL files, never from a copy pasted in here, or this measures nothing.
 *
 * **jsdom's `getComputedStyle` cascades on SOURCE ORDER and ignores specificity.** Proven
 * while writing this file: two rules, `.view-ohbox .doorbell .db-txt` (0,3,0) first and
 * `.doorbell .db-txt` (0,2,0) second, resolved to the SECOND one's `white-space:nowrap`.
 * A real engine gives `normal`. So the injection below is in cascade order — the base
 * sheet, then the override — because that is the only order in which jsdom can express the
 * right answer, and `specificity()` below covers what it therefore cannot.
 *
 * Verified separately in Chrome at 390px with `app.css` linked BEFORE `doorbell.css` — the
 * adversarial order, where only specificity can save the override: `white-space:normal`,
 * `overflow:visible`, zero clipping ancestors. `next build` as of this slice happens to
 * emit the friendly order (`app-build-manifest.json` lists the `@ohmail/ui` chunk before
 * `app.css` for `(product)/layout`), but that is a bundler detail this repo does not
 * control — `doorbell.css` is imported by the component module and `app.css` by the route
 * group's layout — so an override that needed it would be a coin flip across builds.
 */
const cssOf = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const APP_CSS = "../app/app.css";
const DOORBELL_CSS = "../../../packages/ui/src/composites/doorbell.css";

function injectCss(): void {
  const style = document.createElement("style");
  style.textContent = cssOf(DOORBELL_CSS) + "\n" + cssOf(APP_CSS);
  document.head.appendChild(style);
}

/**
 * CSS specificity as one comparable number, for the flat class selectors used here.
 * `:not()` is transparent — its argument counts, the pseudo-class itself does not.
 */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!not\b)[\w-]+/g) ?? []).length;
  const elements = (selector.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return ids * 10_000 + classes * 100 + elements;
}

/** Every rule in `css` whose selector list mentions `.db-txt`, with its declarations. */
function rulesFor(css: string, needle: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selector.includes(needle) && !selector.startsWith("@")) {
      out.push({ selector, body: m[2]! });
    }
  }
  return out;
}

/** Every clipping ancestor of the sentence, from the sentence up to the pane. */
function clippersAbove(el: HTMLElement): string[] {
  const found: string[] = [];
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.overflow === "hidden" || s.overflowX === "hidden" || s.overflowY === "hidden") {
      found.push(`${n.tagName.toLowerCase()}.${n.className}`);
    }
    // Stop at the pane. Above it `.scroller` and `.app-root` clip BY DESIGN — they are the
    // scrollers — and the sentence is not inside either of them: the doorbell sits in
    // `ListPane`'s header slot, a sibling of `.scroller`.
    if (n.classList.contains("list-col")) break;
  }
  return found;
}

describe("the sentence wraps; nothing clips it", () => {
  it("no ancestor of the doorbell sentence clips, up to the pane", async () => {
    // THE GUARD FOR THE LAYOUT HALF, against the real rendered tree and the real
    // stylesheets. Delete the `.view-ohbox .doorbell` block from `app.css` and this reports
    // `span.db-txt` and `button.doorbell` — which is the state in the reported screenshot.
    await mount({ unread: 2, read: 5, waiting: OWNER_WAITING });
    injectCss();

    expect(clippersAbove(dbTxt())).toEqual([]);
  });

  it("the sentence holds ONE line and still never truncates", async () => {
    // THE ASSERTION THAT CHANGED SHAPE WITH THE OWNER'S RULING, and the half that did not.
    //
    // An earlier change asserted `white-space: normal` because its fix was to give the sentence a row of
    // its own. That was seen and one compact line asked for instead, so `nowrap` is
    // the intended state and asserting `normal` would pin the rejected design.
    //
    // What does NOT move is the reason that change existed: an ellipsis hides the last word, and the
    // last word is the one that could not be read. So the truncation half is asserted
    // harder than before — no ellipsis, no clipping, AND `flex:none`, which is what makes it
    // structurally impossible for the sentence to be the thing that gives. Delete `flex:none`
    // and a narrow pane starts shrinking the sentence again.
    await mount({ unread: 2, read: 5, waiting: OWNER_WAITING });
    injectCss();

    const s = getComputedStyle(dbTxt());
    expect(s.whiteSpace).toBe("nowrap");
    expect(s.textOverflow).not.toBe("ellipsis");
    expect(s.overflow).toBe("visible");
    expect(s.flexGrow).toBe("0");
    expect(s.flexShrink).toBe("0");
  });

  it("the FACES are what yields under pressure, and they yield by container", async () => {
    // THE MECHANISM GUARD. Going compact only works because something else gives up its
    // width, and it has to be the avatar strip — decorative by the component's own design
    // ("a texture, not a census") — rather than the sentence.
    //
    // Asserted over the stylesheet rather than by rendering, for two reasons jsdom forces:
    // it does not implement `@container` at all, so a rendered check would silently measure
    // nothing; and the property that matters is WHICH element the query hides. A version
    // that hid `.db-txt` instead would reintroduce the defect exactly.
    const db = cssOf(DOORBELL_CSS);

    // A media query here would be the bug, not the fix: the doorbell is WIDER on a phone
    // (362px at 390px) than in the desktop split column (268-348px), so no viewport
    // breakpoint can express "is there room". That is the own measurement.
    expect(db, "the doorbell must measure ITSELF, not the viewport").toMatch(/container-type\s*:\s*inline-size/);

    const q = db.match(/@container[^{]*\{([\s\S]*?)\n\}/);
    expect(q, "no @container rule in doorbell.css — the strip can no longer yield").toBeTruthy();
    expect(q![1]).toMatch(/\.avs\s*\{[^}]*display\s*:\s*none/);
    expect(q![1], "the container query must never hide the sentence").not.toMatch(/\.db-txt/);
  });

  it("the compact composition is gone from app.css — no wrap, no second row", async () => {
    // The counter-guard for the ruling itself. the two-line layout was `flex-wrap:wrap`
    // plus `flex-basis:100%` on the sentence; leaving either behind would keep the doorbell
    // two lines tall no matter what the copy says.
    const app = cssOf(APP_CSS);
    // Anchored on the banner's own words. It used to be anchored on a tracker id, which is
    // exactly the kind of string a comment sweep removes — and `indexOf` returning -1 makes
    // `slice` hand back "" rather than throw, so the two assertions below would have passed
    // over nothing. The `toBeTruthy` on the next line is what caught that; keep it first.
    const block = app.slice(app.indexOf("ohbox doorbell: ONE compact line"), app.indexOf("screener extras"));
    expect(block, "the doorbell block is missing").toBeTruthy();
    expect(block).not.toMatch(/flex-wrap\s*:\s*wrap/);
    expect(block).not.toMatch(/flex-basis\s*:\s*100%/);
  });

  it("the collapsed doorbell still clips, so `gone` stays a collapse", async () => {
    // THE COUNTER-GUARD. The tempting shortcut is to delete `overflow:hidden` from
    // `.doorbell` outright — but that rule is what makes `.gone`'s `height:0` a collapse
    // instead of a pile of overlapping content during the transition. The override is
    // deliberately `:not(.gone)`. Widen it to plain `.doorbell` and this goes red.
    await mount({ unread: 2, read: 5, waiting: OWNER_WAITING });
    injectCss();

    const btn = dbBtn();
    expect(getComputedStyle(btn).overflow).toBe("visible");
    btn.classList.add("gone");
    expect(getComputedStyle(btn).overflow).toBe("hidden");
  });

  it("the override beats the clip on SPECIFICITY, not on stylesheet order", async () => {
    // What the jsdom tests above structurally cannot check, because jsdom's cascade is
    // source-order only (see the note above this describe). Next decides the order of
    // `app.css` and `doorbell.css` from the module graph — the layout imports one, a
    // component module deep inside `@ohmail/ui` imports the other — so an override that
    // won only on order would work or not work depending on a bundler detail. Rewrite
    // `.view-ohbox .doorbell .db-txt` down to `.doorbell .db-txt` in `app.css` and this
    // goes red even though every rendering assertion above stays green.
    const clipping = rulesFor(cssOf(DOORBELL_CSS), ".db-txt")
      .find((r) => /overflow\s*:\s*hidden/.test(r.body));
    expect(clipping, "doorbell.css no longer clips .db-txt — re-check this whole file").toBeTruthy();

    const override = rulesFor(cssOf(APP_CSS), ".db-txt")
      .find((r) => /overflow\s*:\s*visible/.test(r.body));
    expect(override, "app.css no longer un-clips .db-txt").toBeTruthy();

    expect(specificity(override!.selector)).toBeGreaterThan(specificity(clipping!.selector));
  });
});
