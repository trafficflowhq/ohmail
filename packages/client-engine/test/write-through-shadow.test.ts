/**
 * EVERY CONFIRMED VERB IS SHADOWED — tags, rules and folders beside the message verbs (`shadow.ts`).
 *
 * The Cloud-paired desktop's door answers `/sync` from a copy that can lag the server that took
 * the write; its proxy answers a covered write with no seq (the reconcile drain holds it) and an
 * uncovered one after a bounded wait. Each case drives a verb whose answer carries no echo against
 * a door that has not pulled it: the row keeps the confirmed state until the copy agrees.
 */
import type {
  EngineMessage,
  EngineMutation,
  FolderEntity,
  RuleEntity as RuleDTO,
  TagEntity as TagDTO,
} from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  decodeSeqCursor,
  encodeSeqCursor,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { SHADOW_DRAIN_BOUND, SHADOWED_ROWS } from "../src/shadow.js";

const NOW = new Date("2026-09-23T14:00:00.000Z");
const at = (n: number): string => new Date(NOW.getTime() + n * 1000).toISOString();

const tag = (id: string, name: string, hue = "moss"): TagDTO => ({ id, name, hue, createdAt: at(0), updatedAt: at(0) });
const rule = (id: string, destination: string): RuleDTO => ({
  id, kind: "sender", match: "a@example.test", destination, priority: 0, provenance: "manual", enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: at(0), updatedAt: at(0),
} as RuleDTO);
const folder = (id: string, name: string, op?: FolderEntity["op"]): FolderEntity => ({
  id, name, mailboxId: "mb", mailbox: "me@example.test", updatedAt: at(0), ...(op ? { op } : {}),
});
const message = (id: string, labels: string[]): EngineMessage => ({
  id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: "s",
  from: { name: null, address: "b@example.test" }, to: [], cc: [], date: at(0), folder: "INBOX", snippet: "",
  unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels, remoteContent: "none", updatedAt: at(0),
});

/**
 * THE SERVER AND ITS DOOR, for any entity type: `log` is what the server committed, `visible` how
 * far the door's copy has pulled. `mutate` applies the verb server-side and answers with no echo,
 * the covered proxy's shape, so the reconcile drain is the only way the change can reach the mirror.
 */
class LaggingDoor implements EngineAdapter {
  log: SyncChange[] = [];
  seq = 0;
  visible = 0;
  ignoreWrites = false;
  rows = new Map<string, unknown>();

  constructor() {
    this.put("tag", "t1", tag("t1", "Work"));
    this.put("rule", "r1", rule("r1", "ohmail/News"));
    this.put("folder", "f1", folder("f1", "Projects"));
    this.put("message", "m1", message("m1", ["t1"]));
    this.catchUp();
  }
  put(type: string, id: string, entity: unknown | null): void {
    this.seq += 1;
    const had = this.rows.has(`${type}:${id}`);
    if (entity === null) this.rows.delete(`${type}:${id}`); else this.rows.set(`${type}:${id}`, entity);
    this.log.push({ type, id, seq: this.seq, updatedAt: at(this.seq), op: entity === null ? "delete" : had ? "update" : "create",
      ...(entity === null ? {} : { entity }) } as SyncChange);
  }
  get<T>(type: string, id: string): T { return this.rows.get(`${type}:${id}`) as T; }
  catchUp(): void { this.visible = this.seq; }
  async sync(p: { since: string }): Promise<SyncResponse> {
    const since = decodeSeqCursor(p.since) ?? 0;
    const rows = this.log.filter((c) => c.seq > since && c.seq <= this.visible);
    const top = rows.length ? rows[rows.length - 1]!.seq : since;
    return {
      changes: {
        creates: rows.filter((c) => c.op === "create"), updates: rows.filter((c) => c.op === "update"),
        moves: rows.filter((c) => c.op === "move"), deletes: rows.filter((c) => c.op === "delete"),
      },
      cursor: encodeSeqCursor(top), hasMore: false, serverTime: NOW.toISOString(),
    };
  }
  async mutate(m: EngineMutation): Promise<{ changes: SyncChange[]; seq: number | null }> {
    if (!this.ignoreWrites) {
      if (m.kind === "tag_rename") this.put("tag", m.tagId, { ...this.get<TagDTO>("tag", m.tagId), name: m.name });
      if (m.kind === "tag_recolor") this.put("tag", m.tagId, { ...this.get<TagDTO>("tag", m.tagId), hue: m.hue });
      if (m.kind === "tag_delete") {
        this.put("message", "m1", { ...this.get<EngineMessage>("message", "m1"), labels: [] });
        this.put("tag", m.tagId, null);
      }
      if (m.kind === "rule_update") this.put("rule", m.ruleId, { ...this.get<RuleDTO>("rule", m.ruleId), destination: m.destination });
      if (m.kind === "rule_delete") this.put("rule", m.ruleId, null);
      if (m.kind === "folder_rename") this.put("folder", m.folderId, { ...this.get<FolderEntity>("folder", m.folderId), op: { kind: "rename", to: m.name } });
      if (m.kind === "folder_delete") this.put("folder", m.folderId, { ...this.get<FolderEntity>("folder", m.folderId), op: { kind: "delete" } });
    }
    return { changes: [], seq: null };
  }
  async withdrawSend() { return { outcome: "unsupported" as const }; }
  async fetchBody(): Promise<null> { return null; }
}

const engineOver = (door: EngineAdapter) => new OhmailEngine({ adapter: door, now: () => NOW });
type Read = (e: OhmailEngine) => string;
const tagRead: Read = (e) => { const t = e.read().get<TagDTO>("tag", "t1"); return t ? `${t.name}|${t.hue}` : "absent"; };
const ruleRead: Read = (e) => e.read().get<RuleDTO>("rule", "r1")?.destination ?? "absent";
const folderRead: Read = (e) => {
  const f = e.read().get<FolderEntity>("folder", "f1");
  return f ? (f.op?.kind === "delete" ? "deleting" : f.op?.kind === "rename" ? `→${f.op.to}` : f.name) : "absent";
};
const labelsRead: Read = (e) => (e.read().get<EngineMessage>("message", "m1")?.labels ?? []).join(",");

const CASES: Array<{ verb: EngineMutation; read: Read; old: string; want: string; after?: (d: LaggingDoor) => void; settled: string }> = [
  { verb: { kind: "tag_rename", tagId: "t1", name: "Clients" }, read: tagRead, old: "Work|moss", want: "Clients|moss", settled: "Clients|moss" },
  { verb: { kind: "tag_recolor", tagId: "t1", hue: "ochre" }, read: tagRead, old: "Work|moss", want: "Work|ochre", settled: "Work|ochre" },
  { verb: { kind: "tag_delete", tagId: "t1" }, read: tagRead, old: "Work|moss", want: "absent", settled: "absent" },
  { verb: { kind: "rule_update", ruleId: "r1", destination: "ohmail/Receipts" }, read: ruleRead, old: "ohmail/News", want: "ohmail/Receipts", settled: "ohmail/Receipts" },
  { verb: { kind: "rule_delete", ruleId: "r1" }, read: ruleRead, old: "ohmail/News", want: "absent", settled: "absent" },
  { verb: { kind: "folder_rename", folderId: "f1", name: "Archive 2026" }, read: folderRead, old: "Projects", want: "→Archive 2026",
    after: (d) => d.put("folder", "f1", folder("f1", "Archive 2026")), settled: "Archive 2026" },
  { verb: { kind: "folder_delete", folderId: "f1" }, read: folderRead, old: "Projects", want: "deleting",
    after: (d) => d.put("folder", "f1", null), settled: "absent" },
];

describe("a confirmed tag, rule or folder verb is not undone on screen by a copy that predates it", () => {
  for (const c of CASES) {
    it(`${c.verb.kind}: the confirmed state holds until the door's copy agrees`, async () => {
      const door = new LaggingDoor();
      const engine = engineOver(door);
      await engine.start();
      expect(c.read(engine)).toBe(c.old);
      const result = await engine.mutate(c.verb);
      expect(result.status).toBe("confirmed");
      // The reconcile drain read a copy without the write; the row must not revert.
      expect(c.read(engine)).toBe(c.want);
      await engine.syncOnce();
      expect(c.read(engine), "a later drain from the same lagging copy").toBe(c.want);
      door.catchUp();
      await engine.syncOnce();
      expect(c.read(engine)).toBe(c.want);
      // The worker settles the pending command: the mirror is shown, not the mask.
      c.after?.(door);
      door.catchUp();
      await engine.syncOnce();
      expect(c.read(engine)).toBe(c.settled);
    });
  }

  it("tag_delete also keeps the label off the message that carried it", async () => {
    const door = new LaggingDoor();
    const engine = engineOver(door);
    await engine.start();
    expect(labelsRead(engine)).toBe("t1");
    await engine.mutate({ kind: "tag_delete", tagId: "t1" });
    await engine.syncOnce();
    expect(labelsRead(engine)).toBe("");
  });

  it(`a tag verb the copy never agrees with stops masking after ${SHADOW_DRAIN_BOUND} drains`, async () => {
    const door = new LaggingDoor();
    door.ignoreWrites = true;
    const engine = engineOver(door);
    await engine.start();
    await engine.mutate({ kind: "tag_rename", tagId: "t1", name: "Clients" });
    for (let i = 1; i < SHADOW_DRAIN_BOUND; i++) {
      await engine.syncOnce();
      expect(tagRead(engine), `drain ${i}`).toBe("Clients|moss");
    }
    await engine.syncOnce();
    expect(tagRead(engine), "the mirror is the truth after the bound").toBe("Work|moss");
  });

  it("every verb that edits or removes a held row names the rows it shadows", () => {
    const edits = ["tag_rename", "tag_recolor", "tag_delete", "rule_update", "rule_delete",
      "folder_rename", "folder_delete", "folder_op_dismiss"] as const;
    for (const k of edits) expect(SHADOWED_ROWS[k].length, k).toBeGreaterThan(0);
  });
});
