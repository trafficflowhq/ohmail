/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import { BOOT_SKELETON_GRACE_MS } from "../app/shell/BootSkeleton";
import { layoutPlan } from "@ohmail/app/frame";
import { LOADING_GRACE_MS } from "@ohmail/app-logic/session/loading-grace";
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

/** The Ohbox's loading and empty sentences, as its list says them (the catalogue's `ohbox.empty`: the kit's Empty
 *  draws the closing dot itself). */
const OHBOX = { loading: messages.ohbox.empty.loading, emptyPlain: messages.ohbox.empty.nothing };
/** A row of the Ohbox's list: an option of its listbox, standing for its letters. */
const ROWS = ":is(.row, [role=option])[data-id]";

/** A `/sync` that never answers — the cold mirror, held open for as long as the test wants. */
function holdSync(): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/sync")) return new Promise<Response>(() => {});
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const skeleton = (el: HTMLElement): HTMLElement | null => el.querySelector(".oh-rowsshape");

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
    expect(sk!.closest(".fr-list .oh-sheet"), "the kit’s row shapes do not stand on the mail sheet").not.toBeNull();
    const rows = sk!.querySelectorAll(".oh-rowsshape-row");
    expect(rows.length, "a silhouette with no rows in it").toBeGreaterThan(0);

    /* The kit keeps the sender, time, subject and phone preview slots beside the avatar. */
    for (const row of rows) {
      expect(row.querySelector(".oh-rowsshape-face"), "a mail row without its lead circle").not.toBeNull();
      expect(row.querySelector(".oh-shapebar[data-as=who]"), "no sender line").not.toBeNull();
      expect(row.querySelector(".oh-shapebar[data-as=time]"), "no time stub").not.toBeNull();
      expect(row.querySelector(".oh-rowsshape-row > .oh-shapebar:not([data-as])"), "no subject line").not.toBeNull();
      expect(row.querySelector(".oh-shapebar[data-as=more]"), "no preview line").not.toBeNull();
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
    expect(el.querySelectorAll(ROWS).length, "rendered rows for mail it had not read").toBe(0);
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

    expect(el.querySelectorAll(ROWS).length, "the drain landed and no mail was rendered")
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

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("the silhouette is the live shell's geometry, asserted at the stylesheet", () => {
  it("the window variant is the deck's three columns — rail, --split list, reading pane", () => {
    const css = read("packages/app/src/frame/placement.css");
    expect(css).toMatch(/\.fr-columns\s*\{[^}]*grid-template-columns: var\(--fr-rail\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.fr-main\s*\{[^}]*grid-template-columns: var\(--fr-listw\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.fr-main\s*\{[^}]*grid-template-columns: var\(--split-user/);
  });

  it("a row is `.row` verbatim — 12×14 padding, radius 16, a 30px lead circle", () => {
    const css = read("packages/ui/src/base/Pages/rows-shape.css");
    expect(css).toMatch(/\.oh-rowsshape-row\s*\{[^}]*grid-template-columns: var\(--gutter\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.oh-rowsshape-row\s*\{[^}]*height: var\(--row\);[^}]*padding: var\(--oh-rowsshape-row-pad\)/);
    expect(css).toMatch(/\.oh-rowsshape-face\s*\{[^}]*width: var\(--av\);[^}]*height: var\(--av\);[^}]*border-radius: var\(--av-r\)/);
  });

  it("below 1024px the rail disappears and below 700px the reading pane does — the width ladder's bands", () => {
    const plan = (width: number, zero = false) =>
      layoutPlan({ width, height: 900, pointer: "fine", posture: "flat", reducedMotion: false }, zero ? "zero" : undefined);
    expect(plan(1440)).toMatchObject({ rail: "words", columns: 2 });
    expect(plan(760)).toMatchObject({ rail: "icons", columns: 2 });
    expect(plan(699)).toMatchObject({ rail: "dock", columns: 1 });
    expect(plan(900, true)).toMatchObject({ rail: "icons", columns: 2, ribbon: "split" });
    expect(plan(600, true)).toMatchObject({ rail: "icons", columns: 1, ribbon: "push" });
  });

  it("the base bar is declared BEFORE its modifiers — source order is the cascade", () => {
    const css = read("packages/ui/src/base/Pages/shape-bar.css");
    const base = css.indexOf(".oh-shapebar {");
    const firstRole = css.indexOf(".oh-shapebar[data-as=");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(firstRole).toBeGreaterThan(base);
  });

  it("the window variant leaves width to the gate's insets", () => {
    const css = read("packages/app/src/frame/placement.css");
    expect(css).toMatch(/\.fr-columns\s*\{[^}]*padding: var\(--edge\)/);
    const tracks = /\.fr-columns\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(tracks).not.toMatch(/(?:^|;)\s*width:/);
  });
});

describe("the silhouette's motion is a preference, not a fact", () => {
  it("the bars carry a pulse at rest", () => {
    const css = read("packages/ui/src/base/Pages/rows-shape.css");
    const motion = read("packages/tokens/src/design/motion.css");
    expect(css).toMatch(/animation: oh-shape-breathe var\(--d-pull\)/);
    expect(motion).toMatch(/--d-pull:\s*calc\(640ms \* var\(--m-time\)\)/);
  });

  it("and `prefers-reduced-motion: reduce` takes it away", () => {
    const motion = read("packages/tokens/src/design/motion.css");
    expect(motion).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?--d-pull:\s*0ms/);
  });
});
