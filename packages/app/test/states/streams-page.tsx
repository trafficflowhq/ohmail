/**
 * NEWS AND RECEIPTS IN A REAL BROWSER: the place through the real frame over the fake host, its model fed what a
 * shell would hand it, thirty letters with a few paragraphs each so the stream overflows several screens. The address
 * names the place (`place=news|receipts`), the window (`device=`) and `lang`. What the place writes is kept on the
 * page for the test to read: `streamWrites` (the read rule's live writes), `streamLeaves` (the leave's commits);
 * `streamPageHide()` is the shell's page-hide, as a test fires it.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { StreamInput, StreamLeaveCommit } from "@ohmail/app-logic/streams";
import { Frame } from "../../src/frame/Frame.js";
import { routeOf } from "../../src/frame/route.js";
import { NewsAbove, newsPlace } from "../../src/news/index.js";
import { ReceiptsAbove, receiptsPlace } from "../../src/receipts/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { NO_ENGINE, fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, ROOMS, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { letter } from "../reader/support/fake-mail.js";
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import newsEn from "../../messages/news.en.json" with { type: "json" };
import newsDe from "../../messages/news.de.json" with { type: "json" };
import receiptsEn from "../../messages/receipts.en.json" with { type: "json" };
import receiptsDe from "../../messages/receipts.de.json" with { type: "json" };

const WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: { ...FRAME_WORDS.en, ...sharedEn, ...newsEn, ...receiptsEn } as Messages,
  de: { ...FRAME_WORDS.de, ...sharedDe, ...newsDe, ...receiptsDe } as Messages,
};

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const place = q.get("place") === "receipts" ? "receipts" : "news";
const device = (q.get("device") ?? "desktop") as keyof typeof ROOMS;
const room = ROOMS[device] ?? ROOMS.desktop;
const size = { width: window.innerWidth || room.width, height: window.innerHeight || room.height };

const LETTERS = Array.from({ length: 30 }, (_, i) =>
  letter(`n${i}`, {
    subject: `Issue ${i}`,
    from: { name: `Sender ${i}`, address: `sender${i}@example.org` },
    date: new Date(Date.UTC(2026, 10, 10, 9) - i * 3_600_000).toISOString(),
    unread: true,
  }),
);
const FRESH = 12;
const TEXT = (id: string): string =>
  Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1} of ${id}: what the issue says this week.`).join(
    "\n\n",
  );

type Seen = { streamWrites: string[][]; streamLeaves: StreamLeaveCommit[]; streamPageHide?: () => void };
const page = globalThis as unknown as Seen;
page.streamWrites = [];
page.streamLeaves = [];

const input: Omit<StreamInput, "place" | "openId" | "open"> = {
  settled: true,
  owed: false,
  partition: {
    fresh: LETTERS.slice(0, FRESH),
    seen: LETTERS.slice(FRESH),
    waterline: { newestSeenId: LETTERS[FRESH]!.id },
    newCount: FRESH,
  },
  markSeen: (ids) => page.streamWrites.push([...ids]),
  onLeaveSeen: (c) => page.streamLeaves.push(c),
  markUnread: () => {},
  markAllRead: () => {},
  textOf: TEXT,
  hydrate: () => {},
  stamp: (iso) => iso.slice(11, 16),
  onPageHide: (leave) => {
    page.streamPageHide = leave;
    return () => {
      if (page.streamPageHide === leave) delete page.streamPageHide;
    };
  },
};

function Seat({ address, children }: { address: FakeAddress; children: ReactNode }) {
  const fragment = useSyncExternalStore(address.subscribe, address.read);
  const route = routeOf(fragment);
  const base = place === "news" ? "#/reads" : "#/receipts";
  const full: StreamInput = {
    ...input,
    place,
    openId: route.open,
    open: (id) => address.write(id === null ? base : `${base}/m/${id}`, "push"),
  };
  return place === "news" ? (
    <NewsAbove input={full}>{children}</NewsAbove>
  ) : (
    <ReceiptsAbove input={full}>{children}</ReceiptsAbove>
  );
}

const address = fakeAddress(place === "news" ? "#/reads" : "#/receipts");
const { host } = fakeHost({
  engine: NO_ENGINE,
  service: "self",
  scope: "acct-1",
  places: place === "news" ? { news: newsPlace } : { receipts: receiptsPlace },
  window: fakeWindow({ ...room, ...size, posture: "flat", reducedMotion: true }),
  address,
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
    <Seat address={address}>
      <Frame host={host} />
    </Seat>
  </TextProvider>,
);
