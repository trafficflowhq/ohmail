/** The registered mail frame and its shared stream seats over a known mailbox. */
import { render } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { EngineContext } from "@ohmail/app-logic/engine";
import type { SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame } from "../../src/frame/commands.js";
import type { PlaceEntry } from "../../src/frame/contract.js";
import { MailGround, mailPlaces, mailReader } from "../../src/mail/index.js";
import { readerEntry } from "../../src/reader/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import writeEn from "../../messages/write.en.json" with { type: "json" };
import newsEn from "../../messages/news.en.json" with { type: "json" };
import receiptsEn from "../../messages/receipts.en.json" with { type: "json" };
import { bodyDouble, fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";

const MESSAGES = { ...WORDS.en, ...writeEn, ...newsEn, ...receiptsEn } as Messages;

function rule(id: string, match: string, destination: string) {
  return {
    [`rule:${id}`]: {
      id,
      kind: "sender",
      match,
      destination,
      priority: 0,
      provenance: "manual",
      enabled: true,
      stats: { hits: 0, lastHitAt: null, demotions: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
const RULES = {
  ...rule("r-news", "editor@weekly.example", "ohmail/News"),
  ...rule("r-receipts", "orders@shop.example", "ohmail/Receipts"),
  ...rule("r-ben", "ben@kiln.example", "INBOX"),
};

/** Nine in the morning, UTC, on the 2026-11 day `d`. */
const day = (d: number): string => new Date(Date.UTC(2026, 10, d, 9)).toISOString();
export const issue = (id: string, d: number, over: Partial<EngineMessage> = {}) =>
  letter(id, {
    subject: `Issue ${d}`,
    folder: "ohmail/News",
    from: { name: "The Weekly", address: "editor@weekly.example" },
    date: day(d),
    arrivedAt: day(d),
    ...over,
  });
export const receipt = (id: string, d: number, over: Partial<EngineMessage> = {}) =>
  letter(id, {
    subject: `Order ${d}`,
    folder: "ohmail/Receipts",
    from: { name: "Shop", address: "orders@shop.example" },
    date: day(d),
    arrivedAt: day(d),
    ...over,
  });
const NEWS = [issue("n0", 10, { unread: false }), issue("n1", 11), issue("n2", 12), issue("n3", 13)];
/** Four receipts, newest first: r3, r2, r1, r0. */
const RECEIPTS = [receipt("r0", 10), receipt("r1", 11), receipt("r2", 12), receipt("r3", 13)];
export function hitAt(to: PlaceEntry["id"], open: string): PlaceEntry {
  function Hit() {
    const { commands } = useFrame();
    return (
      <button type="button" onClick={() => commands.go({ place: to, open } as never, { entered: true })}>
        Open the hit
      </button>
    );
  }
  return { id: "search", body: "search", rail: null, panes: { kind: "wide", Wide: Hit } };
}

export function mountStreamFrame(o: {
  at: string;
  mailboxes?: Parameters<typeof fakeHost>[0]["mailboxes"];
  letters?: readonly EngineMessage[];
  hit?: PlaceEntry;
  withReply?: boolean;
  /** The sync loop's state, as a shell's engine provider above the frame says it; absent, the host's settled one. */
  sync?: SyncStatus;
  rows?: Readonly<Record<string, unknown>>;
}) {
  const mail = fakeMail(o.letters ?? [...NEWS, ...RECEIPTS], [], {}, { ...RULES, ...o.rows });
  const address = fakeAddress(o.at);
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: { ...mailPlaces(), ...(o.hit ? { search: o.hit } : {}) },
    above: MailGround,
    reader: o.withReply ? mailReader({ body: bodyDouble().body, look: "none" }) : readerEntry({
      body: bodyDouble().body,
      files: "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
      reply: "none",
      invitation: "none",
    }),
    ...(o.mailboxes ? { mailboxes: o.mailboxes } : {}),
    window: fakeWindow("desktop"),
    address,
  });
  const forAccount = (scope: string | null) => (
    <TextProvider locale="en" messages={MESSAGES} timeZone="Europe/Zurich">
      <Frame host={{ ...host, session: { ...host.session, scope } }} />
    </TextProvider>
  );
  const frame = forAccount(host.session.scope);
  const over = (sync: SyncStatus) => (
    <EngineContext.Provider value={{ engine: mail.engine, demo: false, serverDemo: false, sync }}>
      {frame}
    </EngineContext.Provider>
  );
  const page = render(o.sync ? over(o.sync) : frame);
  return {
    mail,
    address,
    again: (sync: SyncStatus) => page.rerender(over(sync)),
    switchAccount: (scope: string) => page.rerender(forAccount(scope)),
  };
}
