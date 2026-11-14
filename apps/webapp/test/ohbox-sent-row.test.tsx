/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { IDBFactory } from "fake-indexeddb";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { IndexedDbMirrorStore, MemoryMirrorStore, OhmailEngine, isOwnSent, ohboxView, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/** The fixture's ids, built from their numbers. */
const tid = (n: number): string => `T${n}`;

/**
 * OWN-SENT ROWS NAME THE RECIPIENT — "Me → Nora Lindt", never the writer's own identity.
 *
 * A sent message's `from` is the reader themselves, which is the one fact on the row that
 * says nothing. These guards pin the row label for the account's own sent mail in the Ohbox
 * list (singletons and grouped conversation rows alike):
 *
 *   · an own-sent row labels "Me → <recipient display name>", and the circle carries the
 *     RECIPIENT's initial, not the writer's;
 *   · a recipient stored without a display name falls back to their address;
 *   · several recipients fold to the first plus "+N";
 *   · an own-sent row with an empty `to` (rows ingested before recipients reached the wire)
 *     keeps the ordinary sender display — never "Me →" with nothing after the arrow;
 *   · received rows are untouched;
 *   · a grouped conversation row whose newest member is own-sent carries the label — on the
 *     sender line when everything is read, and on the snippet line when unread members own
 *     the sender line.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

/** The account's own identity, the way an ingested Sent row carries it: address only. */
const OWN = { name: null, address: "mila@ohmail.test" };

interface Addr { name: string | null; address: string }
interface Row {
  id: string;
  unread: boolean;
  threadId?: string | null;
  date?: string;
  /** "Sent" makes the row own-sent (`isOwnSent` recognises the mailbox's Sent folder); default INBOX. */
  folder?: string;
  mailboxId?: string;
  from?: Addr;
  to?: Addr[];
}
function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: m.mailboxId ?? "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`,
    from: m.from ?? { name: `sender-${m.id}`, address: `${m.id}@ex.example` },
    to: m.to ?? [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: m.folder ?? "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Props { newForYou?: Row[]; previouslySeen?: Row[] }

async function render(props: Props): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const view = h(OhboxView as never, {
    owed: false,
    demo: false, settled: true,
    older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
    resurfacedRows: [],
    newForYou: (props.newForYou ?? []).map(msg),
    previouslySeen: (props.previouslySeen ?? []).map(msg),
    replyDone: null,
    tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
    selectedId: null, onSelect: () => {},
    onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
    onMarkSeen: () => {},
    bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
    doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
  } as never);
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: view } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

/** The row holding `id`: its own, or the folded conversation it is a member of. */
const rowEl = (id: string): HTMLElement =>
  (host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`)
    ?? [...host!.querySelectorAll<HTMLElement>(".row[data-ids]")].find((r) => (r.dataset.ids ?? "").split(" ").includes(id)))!;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
});

const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("own-sent rows name the recipient", () => {
  it("an own-sent row labels 'Me → <name>' with the recipient's circle, never the writer's identity", async () => {
    setViewport();
    await render({
      previouslySeen: [
        { id: "s1", unread: false, folder: "Sent", from: OWN, to: [{ name: "Nora Lindt", address: "nora@example.net" }], date: at(10) },
      ],
    });
    const row = rowEl("s1");
    expect(row.textContent).toContain("Me → Nora Lindt");
    // the writer's own identity is the fact the label replaces — it must not survive anywhere.
    expect(row.textContent).not.toContain(OWN.address);
    // the circle is the RECIPIENT's, not the writer's own "M".
    expect(row.querySelector(".av")?.textContent).toBe("N");
  });

  it("a row in the mailbox's recorded Sent folder ('Envoyés') is own-sent: 'Me → <name>'", async () => {
    setViewport();
    const row: Row = {
      id: "fr1", unread: false, folder: "Envoyés", mailboxId: "mb-fr", from: OWN,
      to: [{ name: "Nora Lindt", address: "nora@example.net" }], date: at(10),
    };
    await render({ previouslySeen: [row] });
    expect(rowEl("fr1").textContent).not.toContain("Me →");
    const engine = new OhmailEngine({ adapter: new FixturesAdapter() });
    try {
      engine.setSentFolders([{ id: "mb-fr", sentFolder: "Envoyés" }]);
      await render({ previouslySeen: [{ ...row, id: "fr2" }] });
      expect(rowEl("fr2").textContent).toContain("Me → Nora Lindt");
    } finally {
      engine.setSentFolders([]);
    }
  });

  it("a cold start paints a letter in the recorded 'Envoyés' as 'Me → <name>' before the mailbox read answers", async () => {
    setViewport();
    const row: Row = {
      id: "fr3", unread: false, folder: "Envoyés", mailboxId: "mb-fr", from: OWN,
      to: [{ name: "Nora Lindt", address: "nora@example.net" }], date: at(10),
    };
    const factory = new IDBFactory();
    const held = { sync: () => new Promise(() => {}), mutate: async () => ({ status: "applied" }), fetchBody: async () => null };
    // The last session: the letter in the mirror, and the mailbox read stated 'Envoyés'.
    const store = new IndexedDbMirrorStore({ owner: "acct_fr", factory });
    const last = new OhmailEngine({ adapter: held as never, store });
    await last.hydrate();
    await store.applyResponse({
      changes: { creates: [{ type: "message", op: "create", id: "fr3", seq: 1, updatedAt: at(10), entity: msg(row) }], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: at(10),
    } as never);
    last.setSentFolders([{ id: "mb-fr", sentFolder: "Envoyés" }]);
    await store.setMeta("probe", true); // a later write on the same store: the statement has landed
    store.close();
    last.dispose();
    // A new process knows no statement: the letter reads as received.
    const scratch = new OhmailEngine({ adapter: new FixturesAdapter() });
    scratch.setSentFolders([{ id: "mb-other", sentFolder: "Archive" }]);
    await render({ previouslySeen: [row] });
    expect(rowEl("fr3").textContent).not.toContain("Me →");

    // The start: the mirror hydrates and no mailbox read ever answers.
    const engine = new OhmailEngine({ adapter: held as never, store: new IndexedDbMirrorStore({ owner: "acct_fr", factory }) });
    let firstFrame: string[] | null = null;
    engine.subscribe(() => { firstFrame ??= ohboxView(engine.read()).previouslySeen.map((m) => m.id); });
    try {
      await engine.hydrate();
      expect(firstFrame, "the first frame left the account's own letter out of Earlier").toEqual(["fr3"]);
      await render({ previouslySeen: [{ ...row, id: "fr4" }] });
      expect(rowEl("fr4").textContent).toContain("Me → Nora Lindt");
    } finally {
      engine.setSentFolders([]);
      engine.dispose();
    }
  });

  it("a recipient with no display name falls back to their address", async () => {
    setViewport();
    await render({
      previouslySeen: [
        { id: "s2", unread: false, folder: "Sent", from: OWN, to: [{ name: null, address: "nora@example.net" }], date: at(10) },
      ],
    });
    expect(rowEl("s2").textContent).toContain("Me → nora@example.net");
  });

  it("several recipients fold to the first plus +N", async () => {
    setViewport();
    await render({
      previouslySeen: [
        {
          id: "s3", unread: false, folder: "Sent", from: OWN, date: at(10),
          to: [
            { name: "Nora Lindt", address: "nora@example.net" },
            { name: "Jon Falk", address: "jon@example.net" },
            { name: null, address: "petra@example.net" },
          ],
        },
      ],
    });
    expect(rowEl("s3").textContent).toContain("Me → Nora Lindt +2");
  });

  it("an own-sent row with an empty to[] keeps the sender display — never a dangling arrow", async () => {
    setViewport();
    await render({
      previouslySeen: [
        { id: "s4", unread: false, folder: "Sent", from: OWN, to: [], date: at(10) },
      ],
    });
    const row = rowEl("s4");
    // pre-recipient rows: the honest fallback is what the row always showed.
    expect(row.textContent).toContain(OWN.address);
    expect(row.textContent).not.toContain("Me →");
  });

  it("received rows are untouched", async () => {
    setViewport();
    await render({
      newForYou: [{ id: "r1", unread: true, to: [{ name: "Mila", address: "mila@ohmail.test" }], date: at(11) }],
      previouslySeen: [{ id: "r2", unread: false, to: [{ name: "Mila", address: "mila@ohmail.test" }], date: at(10) }],
    });
    expect(rowEl("r1").textContent).toContain("sender-r1");
    expect(rowEl("r1").textContent).not.toContain("Me →");
    expect(rowEl("r2").textContent).toContain("sender-r2");
    expect(rowEl("r2").textContent).not.toContain("Me →");
  });

  it("a grouped row whose newest member is own-sent labels 'Me → <name>' on the sender line", async () => {
    setViewport();
    await render({
      previouslySeen: [
        // the reply (newest, own-sent) and the message it answered, one conversation.
        { id: "s5", unread: false, threadId: "T", folder: "Sent", from: OWN, to: [{ name: "Nora Lindt", address: "nora@example.net" }], date: at(12) },
        { id: "p1", unread: false, threadId: "T", from: { name: "Nora Lindt", address: "nora@example.net" }, date: at(9) },
      ],
    });
    // one row for the conversation, led by the newest member (the reply).
    const row = rowEl("s5");
    expect(row.textContent).toContain("⤷ 2");
    expect(row.textContent).toContain("Me → Nora Lindt");
    expect(row.textContent).not.toContain(OWN.address);
    // the label appears exactly once — sender line, not doubled onto the snippet.
    expect(row.textContent!.split("Me →").length - 1).toBe(1);
    // recipient's circle on the conversation row too.
    expect(row.querySelector(".av")?.textContent).toBe("N");
  });

  it("a grouped row with unread members keeps the unread senders and carries the label on the snippet line", async () => {
    /* The live shape since the conversation became the unit of place (2026-09-28): a reply into a
       conversation with unread mail stands in New on that conversation's row. */
    setViewport();
    await render({
      newForYou: [
        { id: "s6", unread: false, threadId: tid(2), folder: "Sent", from: OWN, to: [{ name: "Nora Lindt", address: "nora@example.net" }], date: at(12) },
        { id: "u1", unread: true, threadId: tid(2), from: { name: "Jon Falk", address: "jon@example.net" }, date: at(9) },
      ],
    });
    // the unread voice owns the sender line, unchanged…
    const row = rowEl("u1");
    expect(row.textContent).toContain("Jon Falk");
    // …and the newest member being the account's own reply is said on the snippet line.
    expect(row.textContent).toContain("Me → Nora Lindt: snip-s6");
  });

  it("a grouped row whose newest own-sent member has no recipients keeps the ordinary sender summary", async () => {
    setViewport();
    await render({
      previouslySeen: [
        { id: "s7", unread: false, threadId: tid(3), folder: "Sent", from: OWN, to: [], date: at(12) },
        { id: "p2", unread: false, threadId: tid(3), from: { name: "Nora Lindt", address: "nora@example.net" }, date: at(9) },
      ],
    });
    const row = rowEl("s7");
    expect(row.textContent).not.toContain("Me →");
    // the fallback is what the grouped row always showed: the newest member's sender display.
    expect(row.textContent).toContain(OWN.address);
  });
});

describe("a reply saved to a Sent folder made after connecting", () => {
  afterEach(() => { vi.useRealTimers(); });
  /**
   * The shell, a real engine and a counting `GET /mailboxes`. The reply's copy lands in 'Envoyés',
   * which the last mailbox read did not name: the shell reads the mailboxes again at once (no poll
   * runs, the clock is held), and the answer makes the copy the person's own.
   */
  async function sendAndLand(folder: string) {
    vi.useFakeTimers();
    setViewport();
    globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const NORA = { name: "Nora Lindt", address: "nora@example.net" };
    const theirs = { ...msg({ id: "theirs", unread: false, threadId: "t-nora", from: NORA, to: [OWN] }), mailboxId: "mb_1" };
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{ type: "message", op: "create", id: "theirs", seq: 1, updatedAt: at(9), entity: theirs }] as SyncChange[]);
    const pending: SyncChange[] = [];
    const engine = new OhmailEngine({
      store, now: () => new Date(at(10)),
      adapter: {
        sync: async () => ({
          changes: { creates: pending.splice(0), updates: [], moves: [], deletes: [] },
          cursor: "c", hasMore: false, serverTime: at(10),
        }),
        mutate: async (m: { kind: string }) => (m.kind === "mail_send"
          ? { changes: [], seq: null, providerMessageId: "<minted@ohmail.test>" } : { changes: [], seq: null }),
        fetchBody: async () => null,
      } as never,
    });
    let reads = 0;
    let named: string | null = null;
    const probe = async () => {
      reads += 1;
      return [{ id: "mb_1", address: OWN.address, status: "connected", lastSyncAt: at(10), pendingMoves: 0, sentFolder: named }];
    };
    const { AppShell } = await import("../app/shell/AppShell.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); }); };
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: messages as never, timeZone: "UTC", now: new Date(at(10)),
        children: h(ThemeProvider, { storageKey: null as never, children: h(ToastHost as never, {
          children: h(AppShell as never, { engine, mailboxFacts: probe } as never),
        } as never) }),
      } as never));
    });
    await settle();
    await act(async () => { await engine.mutate({ kind: "mail_send", inReplyTo: "theirs", body: "Gerne." } as never); });
    await settle();
    const before = reads;
    named = folder === "Sent" ? null : folder;
    const real = {
      ...msg({ id: "real", unread: false, threadId: "t-nora", folder, from: OWN, to: [NORA], date: at(10) }),
      mailboxId: "mb_1", messageIdHeader: "minted@ohmail.test",
    } as unknown as EngineMessage;
    pending.push({ type: "message", op: "create", id: "real", seq: 2, updatedAt: at(10), entity: real } as SyncChange);
    await act(async () => { await engine.syncOnce(); });
    await settle();
    const own = isOwnSent(real);
    engine.setSentFolders([]);
    return { asked: reads - before, own };
  }

  it("the mailboxes are read again at once, and the copy in 'Envoyés' becomes the person's own", async () => {
    const r = await sendAndLand("Envoyés");
    expect(r.asked, "the mailbox list waited for the next poll").toBe(1);
    expect(r.own, "the reply still reads as someone else's").toBe(true);
  });

  it("CONTROL: a copy landing in Sent asks nothing", async () => {
    expect((await sendAndLand("Sent")).asked).toBe(0);
  });
});
