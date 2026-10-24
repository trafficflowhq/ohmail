/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import { BOOT_SKELETON_GRACE_MS } from "../app/shell/BootSkeleton";
import { RAIL_TRACK } from "../app/shell/column-store";
import { LOADING_GRACE_MS } from "../app/shell/loading-grace";
import {
  ISO,
  answerSyncWith,
  installShellEnv,
  mailbox,
  mountShell,
  page,
  teardownShellEnv,
  textOf,
  tick,
} from "./fixtures/live-walk-shell";

/**
 * ═══ THE SILHOUETTE IS GEOMETRY. IT MAY NEVER BECOME CONTENT. ═════════════════════════════
 *
 * A cold mirror — a browser tab whose first `/sync` page has not landed — used to be a spinner
 * and one muted line in the middle of an otherwise blank column. The replacement is the app's
 * own geometry drawn in tinted bars: a list of rows with nothing in them. That is a statement
 * about the SHAPE of the screen that is coming, and it is the only kind of statement this
 * surface is allowed to make.
 *
 * ── WHY THIS FILE IS MOSTLY `not.toContain` ─────────────────────────────────────────────
 *
 * `OhboxView`'s own header has said for a long time that "a placeholder row, an invented count
 * or a skeleton shaped like mail would answer this defect by creating the one this product
 * treats as unforgivable" — and it is right about every one of those. The line this file draws
 * is between a silhouette with no CONTENT in it and a mock-up of somebody's mail: the first
 * carries zero text nodes and is `aria-hidden`, so there is nothing in it to be mistaken for a
 * message, a sender or a count. The moment a name or a number appears inside it, it stops being
 * geometry and becomes exactly the fabrication that rule is about.
 *
 * So the structural assertion — the skeleton's `textContent` is the empty string — is not a
 * detail of the current markup. It is the rule, expressed as the only thing that can enforce it.
 *
 * ── AND IT MUST NOT FLASH ───────────────────────────────────────────────────────────────
 *
 * A wait of the length a wait is supposed to be gets nothing: `loading-grace.ts`'s argument, at
 * its own shorter constant. Both sides are asserted, because a fix that simply rendered the
 * bars would trade a blank column for a strobe on every fast connection.
 */

const OHBOX = messages.ohbox as unknown as Record<string, string>;

/** A `/sync` that never answers — the cold mirror, held open for as long as the test wants. */
function holdSync(): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/sync")) return new Promise<Response>(() => {});
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const skeleton = (el: HTMLElement): HTMLElement | null => el.querySelector(".boot-sk");

describe("the cold-mirror silhouette in the shared shell", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("draws nothing while the wait is an ordinary one", async () => {
    holdSync();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);

    expect(skeleton(el), "the bars flashed on a connection fast enough not to need them")
      .toBeNull();
    // Just short of the grace, and still nothing: the boundary is the assertion, not the
    // first paint.
    await tick(BOOT_SKELETON_GRACE_MS - 50);
    expect(skeleton(el), "the bars arrived before the grace had elapsed").toBeNull();
  });

  it("draws the list geometry once the wait outlasts the grace", async () => {
    holdSync();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(BOOT_SKELETON_GRACE_MS + 50);

    const sk = skeleton(el);
    expect(sk, "the mirror was unread for longer than the grace and the column stayed blank")
      .not.toBeNull();
    const rows = sk!.querySelectorAll(".boot-sk-row");
    expect(rows.length, "a silhouette with no rows in it").toBeGreaterThan(0);

    /* THE ROWS ARE `.row`'S OWN ANATOMY, NOT GENERIC TEXT LINES (owner report 2026-08-26):
       the 30px lead circle every Ohbox row draws, the sender line with its far-right time
       stub, the subject line, the preview line. A regression to two anonymous bars per row
       goes red here. */
    for (const row of rows) {
      expect(row.querySelector(".boot-sk-av"), "a mail row without its lead circle").not.toBeNull();
      expect(row.querySelector(".boot-sk-who"), "no sender line").not.toBeNull();
      expect(row.querySelector(".boot-sk-time"), "no time stub").not.toBeNull();
      expect(row.querySelector(".boot-sk-subj"), "no subject line").not.toBeNull();
      expect(row.querySelector(".boot-sk-line"), "no preview line").not.toBeNull();
    }
  });

  it("says nothing inside itself — no sender, no subject, no count", async () => {
    holdSync();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(BOOT_SKELETON_GRACE_MS * 8);
    const sk = skeleton(el)!;

    /**
     * THE RULE, AS THE ONLY THING THAT CAN ENFORCE IT. A skeleton row carrying a name, or a
     * count invented to fill a slot, is the failure this product treats as unforgivable — it
     * renders as if it were the user's own mail. Zero text nodes is what makes that impossible
     * rather than merely absent today.
     *
     * MUTATION WATCH: put any string inside `BootSkeleton` — a fixture sender, a "…", a single
     * space — and this goes red.
     */
    expect(sk.textContent, "the silhouette started saying things").toBe("");
    // …and it is not in the accessibility tree either, so nothing announces a shape.
    expect(sk.getAttribute("aria-hidden")).toBe("true");
    // The real list is still empty. The bars are not rows and must never be counted as any.
    expect(el.querySelectorAll(".row").length, "rendered rows for mail it had not read").toBe(0);
    expect(textOf(el)).not.toContain("messages so far");
    expect(textOf(el)).not.toMatch(/\d+\s+new\b/);
  });

  it("keeps the honest sentence — the bars accompany it, they do not replace it", async () => {
    holdSync();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(LOADING_GRACE_MS + 50);

    expect(skeleton(el), "the geometry never arrived").not.toBeNull();
    expect(textOf(el), "the silhouette swallowed the one sentence that says what is happening")
      .toContain(OHBOX.loading);
  });

  it("is gone the moment the drain lands", async () => {
    answerSyncWith(() => page(3));
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(BOOT_SKELETON_GRACE_MS * 8);

    expect(el.querySelectorAll(".row").length, "the drain landed and no mail was rendered")
      .toBeGreaterThan(0);
    expect(skeleton(el), "the silhouette outlived the mail it was standing in for").toBeNull();
  });

  it("a genuinely empty mailbox settles into its empty state, not into bars", async () => {
    // The harness's own `/sync` — immediate, empty, `hasMore: false`. A real account with no
    // mail in it, whose honest answer is the settled sentence and no geometry at all.
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(BOOT_SKELETON_GRACE_MS * 8);

    expect(textOf(el), "an empty mailbox was left behind a silhouette").toContain(OHBOX.emptyPlain);
    expect(skeleton(el)).toBeNull();
  });
});

/**
 * ── THE MOTION, ASSERTED AT THE STYLESHEET ──────────────────────────────────────────────
 *
 * jsdom lays nothing out and runs no animation, so the reduced-motion promise is asserted where
 * it is made, read with `readFileSync` because this repo's `grep` skips a whole file on one NUL byte.
 */
const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the silhouette is the live shell's geometry, asserted at the stylesheet", () => {
  const css = bare("apps/webapp/app/app.css");

  it("the window variant is the deck's three columns — rail, --split list, reading pane", () => {
    const win = /(?:^|[};])\s*\.boot-sk-window\s*\{([^{}]*)\}/m.exec(css);
    expect(win, "no `.boot-sk-window` rule in app.css").not.toBeNull();
    // `.deck`'s rail + `--split`'s list/reader, with the same gaps — the real window.
    //
    // The rail's 224 and the list's minmax(320px,400px) are now the FALL-THROUGHS of the two
    // properties the columns hang on (`shell/column-store.ts`), not literals, and that is the
    // point rather than an incidental rewrite: those columns are draggable, so a silhouette
    // pinned at 224/400 in front of a shell about to stand at 304/560 is exactly the visible
    // re-layout this whole geometry exists to prevent. The defaults are still asserted, inside
    // the `var()`, so a build that changed them without changing the skeleton is still red.
    // The rail's track is the one string `column-store.ts` exports — its ceiling follows the
    // window — so the silhouette is asserted against that constant rather than a retyped clamp.
    const railTrack = RAIL_TRACK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
    expect(win![1]).toMatch(
      new RegExp(`grid-template-columns:\\s*${railTrack}\\s+var\\(--split-user-sk,\\s*minmax\\(320px,\\s*400px\\)\\s+1fr\\)`),
    );
    expect(RAIL_TRACK).toContain("clamp(200px, var(--rail-w, 224px),");
    expect(win![1]).toMatch(/gap:\s*0\s+var\(--gap-tile\)/);
  });

  it("a row is `.row` verbatim — 12×14 padding, radius 16, a 30px lead circle", () => {
    const row = /(?:^|[};])\s*\.boot-sk-row\s*\{([^{}]*)\}/m.exec(css);
    expect(row).not.toBeNull();
    expect(row![1]).toMatch(/padding:\s*12px\s+14px/);
    expect(row![1]).toMatch(/border-radius:\s*calc\(var\(--r-card\) \* 16 \/ 14\)/);
    const av = /(?:^|[};])\s*\.boot-sk-av\s*\{([^{}]*)\}/m.exec(css);
    expect(av).not.toBeNull();
    expect(av![1]).toMatch(/width:\s*30px/);
    expect(av![1]).toMatch(/height:\s*30px/);
    expect(av![1]).toMatch(/border-radius:\s*var\(--r-avatar\)/);
  });

  it("below 1024px the rail disappears and below 700px the reading pane does — the width ladder's bands", () => {
    // DESIGN-FOLD-WIDTHS §0: the rail is a drawer below 1024 (no rail silhouette), and the split
    // is one column below 700 (no reader silhouette); between the two the skeleton keeps its
    // reader panel, because the live shell seats two panes there.
    const drawer = css.split(/@media\s*\(max-width:\s*1023\.98px\)/).slice(1);
    const railGone = drawer.some((b) =>
      /\.boot-sk-rail[^{},]*\{[^{}]*display:\s*none/.test(b.split("@media")[0]));
    expect(railGone, "the drawer band would show a rail it does not have").toBe(true);
    const phone = css.split(/@media\s*\(max-width:\s*699\.98px\)/).slice(1);
    const readerGone = phone.some((b) =>
      /\.boot-sk-reader[^{},]*\{[^{}]*display:\s*none/.test(b.split("@media")[0]));
    expect(readerGone, "the phone band would show a reading pane it does not have").toBe(true);
    expect(drawer.some((b) => /\.boot-sk-reader[^{},]*\{[^{}]*display:\s*none/.test(b.split("@media")[0])),
      "the reader silhouette is hidden in the drawer band — the two-pane band has a reader").toBe(false);
    // …and the narrow shell's TOPBAR shape appears there (review round): the live narrow layout
    // is a topbar over the deck, and a silhouette without one ends with the real topbar
    // arriving and every row shifting down.
    const topbarShown = drawer.some((b) =>
      /\.boot-sk-topbar[^{},]*\{[^{}]*display:\s*flex/.test(b.split("@media")[0]));
    expect(topbarShown, "no narrow topbar silhouette").toBe(true);
    expect(/\.boot-sk-topbar\s*\{\s*display:\s*none/.test(css), "the topbar shape must hide wide").toBe(true);
  });

  it("the base bar is declared BEFORE its modifiers — source order is the cascade", () => {
    // Every shaped bar carries `.boot-sk-bar` plus a modifier at equal specificity, so a base
    // rule declared after them flattens the wordmark, the title and the time stub to 9px/tint2
    // (review round — measured, not hypothetical).
    const base = css.search(/(?:^|[};])\s*\.boot-sk-bar\s*\{/m);
    const firstModifier = css.search(/\.boot-sk-(mark|h1|meta|label|time|who|subj|line)\s*\{/);
    expect(base).toBeGreaterThan(-1);
    expect(firstModifier).toBeGreaterThan(-1);
    expect(base, "the base .boot-sk-bar rule must come first or the modifiers lose the tie")
      .toBeLessThan(firstModifier);
  });

  it("the window variant leaves width to the gate's insets", () => {
    // `width:100%` beside `inset:16px` makes CSS drop the far inset and run 16px past the
    // window (review round). The window variant declares width:auto and wins the source-order
    // tie against the base's width:100%.
    const win = /(?:^|[};])\s*\.boot-sk-window\s*\{([^{}]*)\}/m.exec(css)!;
    expect(win[1]).toMatch(/width:\s*auto/);
    const base = css.search(/(?:^|[};])\s*\.boot-sk\s*\{/m);
    const win2 = css.search(/(?:^|[};])\s*\.boot-sk-window\s*\{/m);
    expect(base, "the window rule must FOLLOW the base .boot-sk rule to win the width tie")
      .toBeLessThan(win2);
  });
});

describe("the silhouette's motion is a preference, not a fact", () => {
  const css = bare("apps/webapp/app/app.css");

  it("the bars carry a pulse at rest", () => {
    const bar = /(?:^|[};])\s*\.boot-sk-bar\s*\{([^{}]*)\}/m.exec(css);
    expect(bar, "no `.boot-sk-bar` rule in app.css").not.toBeNull();
    expect(bar![1], "the bars have no motion to suppress — the case below proves nothing")
      .toMatch(/animation:/);
  });

  it("and `prefers-reduced-motion: reduce` takes it away", () => {
    /* The whole `@media (prefers-reduced-motion: reduce)` blocks, and one of them has to name
       the bars. Matched as "the media query, then this selector before the next @media" so a
       rule that merely sits somewhere after one cannot pass for a rule inside it. */
    const blocks = css.split(/@media\s*\(prefers-reduced-motion:\s*reduce\)/).slice(1);
    expect(blocks.length, "app.css makes no reduced-motion promise at all").toBeGreaterThan(0);
    const honoured = blocks.some((b) => {
      const upToNextQuery = b.split("@media")[0];
      return /\.boot-sk-bar[^{}]*\{[^{}]*animation:\s*none/.test(upToNextQuery);
    });
    expect(honoured, "the silhouette pulses at somebody who asked for no motion").toBe(true);
  });
});
