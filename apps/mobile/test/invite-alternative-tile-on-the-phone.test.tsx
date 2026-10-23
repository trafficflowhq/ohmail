/** @vitest-environment jsdom */
/**
 * ON THE PHONE TOO, AN INVITATION'S CALENDAR ALTERNATIVE IS ITS BODY, NEVER A FILE CHIP (the 0.29.0
 * release probe; tester rounds on 0.28.0 saw two "invite.ics" chips on a Google invitation and one on
 * an Exchange one). The reader, each conversation member and the Screener's held mail draw their chips
 * from the same files field, so the field lists the file once and the card still reads the
 * alternative. An alternative that is the only calendar part (Exchange) stays a chip, so a fetch
 * that failed still leaves something to retry or save. Served through the real parse: each list is `normalizeMime(eml).attachments`.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { normalizeMime } from "../../../packages/core/src/mime.js";
import { EXCHANGE_ICAL, GOOGLE, PLAIN_ICS_FILE, type InviteShape } from "../../../packages/core/test/fixtures/invite-shapes";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
}));

const { liveActions, liveFiles, liveMessage } = await import("../src/state/live");

const NOW = new Date("2026-10-22T09:00:00.000Z");
const view = { now: NOW, zone: "UTC" };
const SHAPES = [GOOGLE, EXCHANGE_ICAL, PLAIN_ICS_FILE];

interface Served { id: string; filename: string | null; contentType: string; sizeBytes: number; inline: boolean; contentId: string | null; bytes: string }
const parsed = new Map<string, Served[]>();

beforeAll(async () => {
  for (const shape of SHAPES) {
    const msg = await normalizeMime(shape.eml);
    parsed.set(shape.name, msg.attachments.map((a, i) => {
      const bytes = shape.parts[i]!.bytes;
      expect(createHash("sha256").update(Buffer.from(bytes, "latin1")).digest("hex")).toBe(a.contentSha256);
      return { id: `${shape.name}-${i}`, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, inline: a.inline, contentId: a.contentId, bytes };
    }));
  }
});

const idOf = (shape: InviteShape) => `m-${shape.name}`;
const row = (shape: InviteShape, hour: number): EngineMessage => ({
  id: idOf(shape), accountId: "acct-1", mailboxId: "mb-1", threadId: `th-${shape.name}`, messageIdHeader: null,
  subject: shape.name, from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [], cc: [], date: `2026-10-22T0${hour}:00:00.000Z`, folder: "INBOX", snippet: shape.text,
  unread: false, hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null,
  labels: [], remoteContent: "none", updatedAt: "2026-10-22T08:00:00.000Z",
} as unknown as EngineMessage);

async function world(refused: ReadonlySet<string> = new Set()) {
  const fetched: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...SHAPES.map((s, i): SyncChange => ({ type: "message", op: "create", id: idOf(s), seq: ++seq, updatedAt: NOW.toISOString(), entity: row(s, i + 5) })),
    { type: "rule", op: "create", id: "r-ada", seq: ++seq, updatedAt: NOW.toISOString(), entity: {
      id: "r-ada", kind: "sender", match: "ada@example.test", destination: "INBOX", enabled: true, createdAt: NOW.toISOString() } },
  ] as SyncChange[]);
  const shapeOf = (id: string) => SHAPES.find((s) => idOf(s) === id)!;
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => ({ text: shapeOf(id).text, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    listAttachments: async (id: string) => parsed.get(shapeOf(id).name)!.map(({ bytes: _bytes, ...p }) => ({ ...p, messageId: id })),
    fetchAttachment: async (id: string) => {
      fetched.push(id);
      if (refused.has(id)) throw new Error("attachment_part_mismatch");
      return new Response([...parsed.values()].flat().find((p) => p.id === id)!.bytes, {
        headers: { "content-type": "application/octet-stream" },
      }).blob();
    },
  } as never;
  const engine = new OhmailEngine({ store, now: () => NOW, adapter });
  return { engine, fetched };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const actionsOver = (engine: OhmailEngine) =>
  liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" } as never);

describe("the phone's file chips leave an invitation's calendar alternative out", () => {
  it("Google (alternative + invite.ics): one event, one invite.ics chip, and it opens", async () => {
    const { engine, fetched } = await world();
    const actions = actionsOver(engine);
    await actions.openMessage(idOf(GOOGLE));
    await settle();
    const m = liveMessage(engine, idOf(GOOGLE), view as never)!;
    expect(m.events?.length, "the card").toBe(1);
    expect(m.attachments?.map((a) => a.filename), "invite.ics listed twice").toEqual(["invite.ics"]);
    const file = parsed.get(GOOGLE.name)!.find((p) => p.filename === "invite.ics")!;
    expect(m.attachments?.[0]?.id).toBe(file.id);
    fetched.length = 0;
    const got = await actions.openAttachmentBytes(idOf(GOOGLE), file.id);
    expect(got.state, "the chip did not open").toBe("ready");
    expect(liveFiles(engine, idOf(GOOGLE))?.map((a) => a.filename), "a held row's chips").toEqual(["invite.ics"]);
  });

  it("Google, the alternative refused: one event, and the file is the one chip", async () => {
    const alt = parsed.get(GOOGLE.name)!.find((p) => p.filename === null)!;
    const { engine } = await world(new Set([alt.id]));
    await actionsOver(engine).openMessage(idOf(GOOGLE));
    await settle();
    const m = liveMessage(engine, idOf(GOOGLE), view as never)!;
    expect(m.events?.length, "the card").toBe(1);
    expect(m.attachments?.map((a) => [a.filename, a.state]), "the refused alternative is a chip").toEqual([["invite.ics", "ready"]]);
  });

  it("Exchange (the alternative only): the event and its one chip", async () => {
    const { engine } = await world();
    await actionsOver(engine).openMessage(idOf(EXCHANGE_ICAL));
    await settle();
    const m = liveMessage(engine, idOf(EXCHANGE_ICAL), view as never)!;
    expect(m.events?.length, "the card").toBe(1);
    expect(m.attachments?.map((a) => a.filename), "the only copy of the event left the chips").toEqual(["invite.ics"]);
    expect(liveFiles(engine, idOf(EXCHANGE_ICAL))?.map((a) => a.filename)).toEqual(["invite.ics"]);
  });

  it("Exchange, its bytes refused: no event, and the failed chip stays to retry", async () => {
    const alt = parsed.get(EXCHANGE_ICAL.name)![0]!;
    const { engine } = await world(new Set([alt.id]));
    await actionsOver(engine).openMessage(idOf(EXCHANGE_ICAL));
    await settle();
    const m = liveMessage(engine, idOf(EXCHANGE_ICAL), view as never)!;
    expect(m.events ?? [], "an event from refused bytes").toEqual([]);
    expect(m.attachments?.map((a) => [a.filename, a.state]), "the invitation shows nothing at all").toEqual([["invite.ics", "failed"]]);
  });

  it("a plain .ics attachment, no invitation: one chip (control)", async () => {
    const { engine } = await world();
    await actionsOver(engine).openMessage(idOf(PLAIN_ICS_FILE));
    await settle();
    const m = liveMessage(engine, idOf(PLAIN_ICS_FILE), view as never)!;
    expect(m.attachments?.map((a) => a.filename)).toEqual(["holidays.ics"]);
  });
});
