/**
 * News and Receipts in a real browser over the registered mail ground and an in-memory mailbox.
 * The page exposes the engine's live read mutations and its anchored leave commits.
 */
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { waterlineIdOf } from "../../../../test/support/engine-fixtures.js";
import { useStreamModel } from "@ohmail/app-logic/streams";
import { Frame } from "../../src/frame/Frame.js";
import { MailGround, mailPlaces, mailReader } from "../../src/mail/index.js";
import { letterBody } from "../../src/reader/body/index.js";
import type { PaneProps } from "../../src/frame/contract.js";
import { StreamReading } from "../../src/stream/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { fakeMail, letter } from "../reader/support/fake-mail.js";
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import newsEn from "../../messages/news.en.json" with { type: "json" };
import newsDe from "../../messages/news.de.json" with { type: "json" };
import receiptsEn from "../../messages/receipts.en.json" with { type: "json" };
import receiptsDe from "../../messages/receipts.de.json" with { type: "json" };
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import readerDe from "../../messages/reader.de.json" with { type: "json" };

const WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: { ...FRAME_WORDS.en, ...sharedEn, ...newsEn, ...receiptsEn, ...readerEn } as Messages,
  de: { ...FRAME_WORDS.de, ...sharedDe, ...newsDe, ...receiptsDe, ...readerDe } as Messages,
};

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const place = q.get("place") === "receipts" ? "receipts" : "news";
const device = (q.get("device") ?? "desktop") as keyof typeof ROOMS;
const room = ROOMS[device] ?? ROOMS.desktop;
const size = { width: window.innerWidth || room.width, height: window.innerHeight || room.height };

const short = q.get("body") === "short";
const folder = place === "news" ? "ohmail/News" : "ohmail/Receipts";
const sender = "editor@example.org";
const fresh = 12;
const letters = Array.from({ length: 30 }, (_, index) => {
  const id = `n${index}`;
  const date = new Date(Date.UTC(2026, 10, 10, 9) - index * 3_600_000).toISOString();
  return letter(id, {
    subject: `Issue ${index}`,
    from: { name: `Sender ${index}`, address: sender },
    date,
    arrivedAt: date,
    folder,
    unread: true,
    body: short
      ? "Thank you for reading."
      : Array.from(
          { length: 5 },
          (_, i) => `Paragraph ${i + 1} of ${id}: what the issue says this week.`,
        ).join("\n\n"),
  });
});
const mail = fakeMail(
  letters,
  [],
  {},
  {
    [`view_meta:${waterlineIdOf(place === "news" ? "reads" : "receipts")}`]: {
      newestSeenId: letters[fresh]!.id,
    },
    "rule:stream": {
      id: "stream",
      kind: "sender",
      match: sender,
      destination: folder,
      priority: 0,
      provenance: "manual",
      enabled: true,
      stats: { hits: 0, lastHitAt: null, demotions: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  },
);
let earned: () => string[] = () => [];
const rests: string[] = [];
const displayed: string[] = [];
function ObservedReading(props: PaneProps) {
  const { read } = useStreamModel();
  useLayoutEffect(() => {
    earned = () => letters.filter((letter) => read.rule.read(letter.id)).map((letter) => letter.id);
    const rest = read.rule.rest;
    const previewDwell = read.rule.previewDwell;
    read.rule.rest = (...args) => {
      const ids = rest(...args);
      rests.push(...ids);
      return ids;
    };
    read.rule.previewDwell = (look) => {
      const ids = previewDwell(look);
      displayed.push(...ids);
      return ids;
    };
    return () => {
      earned = () => [];
      read.rule.rest = rest;
      read.rule.previewDwell = previewDwell;
    };
  }, [read.rule]);
  return <StreamReading {...props} />;
}

Object.defineProperties(globalThis, {
  streamReadEvidence: { get: () => earned() },
  streamRestReads: { get: () => rests },
  streamDisplayedReads: { get: () => displayed },
  streamWrites: {
    get: () =>
      mail.mutations.flatMap((mutation) => {
        if (mutation.kind === "feed_mark_seen" && !mutation.upToId) return [mutation.messageIds];
        if (mutation.kind === "mark_seen" && !mutation.unread) return [mutation.messageIds];
        return [];
      }),
  },
  streamLeaves: {
    get: () => mail.mutations.filter((mutation) => mutation.kind === "feed_mark_seen" && mutation.upToId),
  },
  streamPageHide: {
    value: () => window.dispatchEvent(new Event("pagehide")),
  },
});

const places = mailPlaces();
const news = places.news;
const observedPlaces =
  typeof news === "object" && news.panes.kind === "columns"
    ? { ...places, news: { ...news, panes: { ...news.panes, Reading: ObservedReading } } }
    : places;
const address = fakeAddress(place === "news" ? "#/reads" : "#/receipts");
const { host } = fakeHost({
  engine: mail.engine,
  service: "self",
  scope: "acct-1",
  above: MailGround,
  places: observedPlaces,
  ...(short ? { reader: mailReader({ body: letterBody, look: "none" }) } : {}),
  window: fakeWindow({ ...room, ...size, posture: "flat", reducedMotion: true }),
  address,
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
    <Frame host={host} />
  </TextProvider>,
);
