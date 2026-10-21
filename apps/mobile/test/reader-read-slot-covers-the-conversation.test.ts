import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, ohboxRows, type EngineAdapter, type EngineMessage, type EngineMutation, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { liveActions, liveMessage, type WorldView } from "../src/state/live";
import { conversationUnreadIds } from "../src/ui/read-slot";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE PHONE READER'S MARK AS READ IS THE CONVERSATION'S, through a real engine:
 * a thread a1 + a2, both unread, opened at a2. The open glances a2 alone; the slot's set is then
 * [a1], its press is ONE deliberate mark_seen over [a1] with an Undo, and the set empties so the
 * slot offers Mark unread, which is a2 alone. The compact bar, the rail and the ⋯ sheet read the one
 * set, and the rail re-publishes on its key (read in source — no RN renderer runs here). Mutations:
 * the set back to `m.unread` alone, the press back to `[m.id]`, the rail's key dropped — each red.
 */

const AT = Date.UTC(2026, 8, 20, 8, 0, 0);
const LENA = { name: "Lena", address: "lena@example.test" };
const view: WorldView = { now: new Date(AT + 3_600_000), zone: "UTC" };
function msg(id: string, atMs: number, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
    from: LENA, to: [{ name: "Me", address: "me@example.test" }], cc: [], date: new Date(atMs).toISOString(), arrivedAt: new Date(atMs).toISOString(),
    folder: "INBOX", snippet: `the words of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(atMs).toISOString(), ...over,
  } as EngineMessage;
}
const create = (type: string, id: string, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq: 1, updatedAt: new Date(AT).toISOString(), entity } as SyncChange);
const consent = (): SyncChange => create("rule", "rule_lena", {
  id: "rule_lena", kind: "sender", match: LENA.address, destination: "INBOX", priority: 0, provenance: "seeded-from-sent",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
});

async function phone(first: SyncChange[]) {
  let seq = 1000;
  const pages: SyncChange[][] = [[consent(), ...first].map((c) => ({ ...c, seq: seq++ }))];
  const sent: EngineMutation[] = [];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: new Date(AT).toISOString(),
    }),
    mutate: async (m: EngineMutation) => { sent.push(m); return { ok: true as const, changes: [] }; },
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: { mode: "full" } });
  await engine.start();
  const undos: number[] = [];
  const actions = liveActions({
    engine, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC",
    toast: (_m, o) => { if (o?.undo) undos.push(1); },
  });
  return { engine, actions, sent, undos };
}
const reads = (sent: EngineMutation[]) =>
  sent.filter((m): m is Extract<EngineMutation, { kind: "mark_seen" }> => m.kind === "mark_seen")
    .map((m) => ({ ids: m.messageIds, unread: m.unread, ...(m.via ? { via: m.via } : {}) }));
const rowUnread = (engine: OhmailEngine): boolean =>
  Object.values(ohboxRows(engine.read())).flat().find((r) => r.members.some((m) => m.threadId === "T"))!
    .members.some((m) => m.unread);

describe("the phone reader's read slot covers the conversation", () => {
  it("open a2 → glance [a2]; the set is [a1]; the press writes [a1] with an Undo; then Mark unread is a2 alone", async () => {
    const p = await phone([create("message", "a1", msg("a1", AT)), create("message", "a2", msg("a2", AT + 60_000))]);
    await p.actions.openMessage("a2");
    expect(reads(p.sent), "the open glances the opened message only").toEqual([{ ids: ["a2"], unread: false, via: "glance" }]);
    const open = liveMessage(p.engine, "a2", view)!;
    const set = conversationUnreadIds(open);
    expect(set, "the slot's face is Mark as read, over the rest of the conversation").toEqual(["a1"]);
    expect(rowUnread(p.engine), "the row is still bold").toBe(true);

    expect(await p.actions.markSeen(set[0]!, false, set)).toBe(true);
    expect(reads(p.sent).slice(1), "ONE deliberate write over [a1]").toEqual([{ ids: ["a1"], unread: false }]);
    expect(p.undos.length, "the press offers its Undo").toBe(1);
    expect(conversationUnreadIds(liveMessage(p.engine, "a2", view)!), "nothing left: the face is Mark unread").toEqual([]);
    expect(rowUnread(p.engine), "the folded row is no longer bold").toBe(false);

    expect(await p.actions.markSeen("a2", true)).toBe(true);
    expect(reads(p.sent).slice(2), "Mark unread is the one message").toEqual([{ ids: ["a2"], unread: true }]);
    expect(rowUnread(p.engine)).toBe(true);
  });

  it("a resurfaced unread sibling is outside the set: the press never spends its pin", async () => {
    const RES = { messageId: "a1", state: "resurfaced", bubbleUpAt: null, setAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString() } as unknown as EngineMessage["triage"];
    const p = await phone([create("message", "a1", msg("a1", AT, { triage: RES })), create("message", "b1", msg("b1", AT + 30_000)), create("message", "a2", msg("a2", AT + 60_000))]);
    await p.actions.openMessage("a2");
    const open = liveMessage(p.engine, "a2", view)!;
    expect(open.earlier.find((h) => h.id === "a1")?.resurfaced, "the premise: the member carries its pin").toBe(true);
    const set = conversationUnreadIds(open);
    expect(set).toEqual(["b1"]);
    await p.actions.markSeen(set[0]!, false, set);
    expect(reads(p.sent).slice(1)).toEqual([{ ids: ["b1"], unread: false }]);
    expect(p.engine.read().get<EngineMessage>("message", "a1")?.triage?.state, "the pin stands").toBe("resurfaced");
  });

  it("an unread open message leads its own set; a read thread's set is empty", () => {
    const earlier = [{ id: "b1", seen: false }, { id: "b2", seen: true }] as never;
    expect(conversationUnreadIds({ id: "b3", unread: true, earlier })).toEqual(["b3", "b1"]);
    expect(conversationUnreadIds({ id: "b3", unread: false, earlier: [{ id: "b1", seen: true }] as never })).toEqual([]);
  });

  it("the compact bar, the rail and the sheet read the one set, and the rail re-publishes on its key", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MessageActions.tsx", import.meta.url)), "utf8"));
    expect(src).toContain("const unreadIds = conversationUnreadIds(m);");
    expect(src, "the compact bar's and the rail's face").toContain("unreadIds.length > 0\n        ? { icon: \"check\" as IconName, label: Copy.actionMarkRead, press: () => a.markSeen(unreadIds[0]!, false, unreadIds, m.id), a11y: Copy.actionMarkReadCount(unreadIds.length) }");
    expect(src, "the compact bar's accessible name carries the count").toContain('a11yLabel: "a11y" in readFace ? readFace.a11y : undefined');
    expect(src, "the rail entry is the face").toContain('return { id, icon: readFace.icon, label: readFace.label, onPress: readFace.press };');
    expect(src, "the sheet switches on the same set").toContain("unreadIds.length > 0 ? (\n          <SheetRow icon=\"check\" label={Copy.actionMarkRead} onPress={() => { close(); a.markSeen(unreadIds[0]!, false, unreadIds, m.id); }} />");
    const deps = /publishReaderRail\(null\);[\s\S]*?\}, \[([^\]]*)\]\);/.exec(src)?.[1] ?? "";
    expect(deps.split(",").map((d) => d.trim()), "the rail effect's dependencies carry the face key").toContain("unreadKey");
  });
});
