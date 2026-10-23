/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { estimateCardHeight, STREAM_CARD_FALLBACK_PX } from "@ohmail/ui";
import type { EngineMessage, FeedPartition, MessageBody, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { ReadsView } from "../app/views/ReadsView";
import { KeymapProvider } from "../app/shell/keymap";

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

const ISO = "2026-08-04T09:00:00.000Z";
const tags: TagDTO[] = [];
/** The width the stubbed layout reports for a card — a real column width, not a round number. */
const COLUMN_PX = 620;

const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const body = (): MessageBody =>
  ({
    text: "body", state: "snippet", html: null, loadedRemoteContent: false,
    unsubscribe: "no_header", unsubscribeUrl: null,
  } as unknown as MessageBody);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let restoreWidth: (() => void) | null = null;

/* The stream opens one screen of cards (`stream-window.ts`), sized by the window's height where
   nothing lays out; a screen tall enough for forty is what lets this count forty mounted cards. */
let innerHeight: PropertyDescriptor | undefined;
beforeEach(() => {
  innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 40 * 220 });
});

afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  restoreWidth?.();
  restoreWidth = null;
  document.body.innerHTML = "";
  if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
  else delete (window as unknown as { innerHeight?: number }).innerHeight;
});

/** Give the cards a width, and count every card that is asked for its own. */
function armWidth(): { reads: () => number } {
  const proto = HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  let n = 0;
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList?.contains("scast")) {
        n += 1;
        return COLUMN_PX;
      }
      return 0;
    },
  });
  restoreWidth = () => {
    if (original) Object.defineProperty(proto, "offsetWidth", original);
  };
  return { reads: () => n };
}

async function mountReads(count: number): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const fresh = Math.floor(count / 4);
  const partition: FeedPartition = {
    waterline: null,
    fresh: Array.from({ length: fresh }, (_, i) => message(i)),
    seen: Array.from({ length: count - fresh }, (_, i) => message(i + fresh)),
    newCount: 0,
  };
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>
          <ReadsView settled owed={false}
            partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
            aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
            bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}} onAction={() => {}}
          />
        </KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
  return host;
}

const cards = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>(".scast[data-sid]")];

describe("the stream measures its column once, not once per card", () => {
  it("costs the same width reads at forty cards as at twelve", async () => {
    const small = armWidth();
    const hostSmall = await mountReads(12);
    expect(cards(hostSmall).length, "the fixture must mount the cards it claims").toBe(12);
    const atTwelve = small.reads();
    restoreWidth?.();

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
    const est = Number(/(\d+)px/.exec(first.style.getPropertyValue("--sc-est"))?.[1]);
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
    const est = Number(/(\d+)px/.exec(first.style.getPropertyValue("--sc-est"))?.[1]);
    expect(est).toBe(STREAM_CARD_FALLBACK_PX);
  });
});
