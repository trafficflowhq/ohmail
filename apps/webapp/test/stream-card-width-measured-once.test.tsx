/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCardHeight, STREAM_CARD_FALLBACK_PX } from "@ohmail/ui";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";

/**
 * ═══ ONE WIDTH FOR THE COLUMN, READ ONCE ═════════════════════════════════════════════════════
 *
 * A stream card reserves its own height while its contents are skipped (`content-visibility`), and
 * the reserve is a function of the column's width. Every card used to read its OWN `offsetWidth` in
 * a layout effect and then write the property — a geometry read after the previous card's style
 * write, which is a whole-document layout per card. Measured in Chrome over a very large
 * mirror, traced: a switch into Reads ran 180 forced layouts, 170 ms of its 235 ms, three lines
 * each firing exactly once per mounted card.
 *
 * The width is one number for the column, so the stream measures it once and hands it down. The
 * property under test is that the reads do not scale with the mounted cards: twelve cards and
 * forty cost the same number of width reads. Give the card back its own `offsetWidth` read and
 * this goes red on the count, not on the estimate — the estimate is the same estimate, which is
 * the second case.
 */

const COLUMN_PX = 620;

let restoreWidth: (() => void) | undefined;
beforeEach(() => vi.stubGlobal("innerHeight", 40 * 220));
afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = undefined;
  vi.unstubAllGlobals();
});

function armWidth() {
  let n = 0;
  const proto = HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "offsetWidth")!;
  Object.defineProperty(proto, "offsetWidth", {
    ...original,
    get(this: HTMLElement) {
      if (!this.closest("[data-reading-scroll]")) return original.get!.call(this);
      n += 1;
      return COLUMN_PX;
    },
  });
  restoreWidth = () => { Object.defineProperty(proto, "offsetWidth", original); };
  return { reads: () => n, restore: restoreWidth };
}

async function mountReads(count: number): Promise<HTMLElement> {
  const letters = Array.from({ length: count }, (_, i) => issue(`m${i}`, 40 - i, {
    subject: `subject of m${i}`, snippet: "body", body: undefined, unread: false,
  }));
  mountStreamFrame({ at: "#/reads", letters });
  return screen.getByRole("region", { name: "News stream" });
}

const cards = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>("[data-stream-window-item]")];

describe("the stream measures its column once, not once per card", () => {
  it("costs the same width reads at forty cards as at twelve", async () => {
    const small = armWidth();
    const hostSmall = await mountReads(12);
    expect(cards(hostSmall).length, "the fixture must mount the cards it claims").toBe(12);
    const atTwelve = small.reads();
    cleanup();
    small.restore();

    const big = armWidth();
    const hostBig = await mountReads(40);
    expect(cards(hostBig).length).toBe(40);
    const atForty = big.reads();

    expect(atTwelve, "the column is measured at all").toBeGreaterThan(0);
    expect(atForty, "a mounted card may not be asked for its own width").toBe(atTwelve);
  });

  it("reserves every card the height the measured column gives it, not the unmeasured fallback", async () => {
    armWidth();
    const host = await mountReads(12);
    const first = cards(host)[0]!;
    const est = Number(/(\d+)px/.exec(first.style.containIntrinsicBlockSize)?.[1]);
    /* The same function the card calls, with the props this fixture gives it: a snippet body is
       PENDING, so the card lays out clamped and keeps its pill; no recipients block; the jsdom
       window is 1024 wide, so no touch sizing. */
    expect(est).toBe(
      estimateCardHeight({
        width: COLUMN_PX,
        subject: "subject of m0",
        preview: "body",
        recipients: false,
        pill: true,
        touch: false,
        clamped: true,
      }),
    );
    expect(est, "a measured column must not read as the unmeasured card's fallback")
      .not.toBe(STREAM_CARD_FALLBACK_PX);
  });

  it("reserves the documented fallback where nothing can be measured", async () => {
    // No width stub: jsdom answers 0 for every element, which is the case the fallback is for.
    const host = await mountReads(6);
    const first = cards(host)[0]!;
    const est = Number(/(\d+)px/.exec(first.style.containIntrinsicBlockSize)?.[1]);
    expect(est).toBe(STREAM_CARD_FALLBACK_PX);
  });
});
