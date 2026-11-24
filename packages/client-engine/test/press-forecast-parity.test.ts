import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  pressForecast,
  type ConsentOptions,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * A FORECAST THAT WRITES NOTHING IS THE LIST. With the rule already in place and no past mail
 * asked for, the forecast places each of the subject's rows exactly as the surface's partition
 * does under the same options — the unknown cutline (`rulesOnly`), the folders lens, and the
 * account's own addresses each change a row here, so an option the forecast dropped would show.
 */
const NOW = new Date("2026-09-25T13:00:00.000Z");
const DOMAIN = "company.example";
let seq = 0;

function mail(id: string, address: string, o: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Weekly notes", from: { name: null, address }, to: [], cc: [],
    date: "2026-09-24T12:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T12:00:00.000Z", ...o,
  } as EngineMessage;
}

const wide: RuleDTO = {
  id: "dom", kind: "domain", match: DOMAIN, destination: "ohmail/News", priority: 0, provenance: "manual",
  enabled: true, subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z",
} as RuleDTO;

async function mirror() {
  const store = new MemoryMirrorStore();
  await store.load();
  const rows = [
    mail("colleague", `ann@${DOMAIN}`),
    // At the gate since ARCH-R902: a ruled INBOX row stays in the INBOX with or without the own
    // address, so only a held row still tells that option apart (own mail presents in the INBOX).
    mail("mine", `me@${DOMAIN}`, { folder: "ohmail/Screener" }),
    mail("filed", `ann@${DOMAIN}`, { folder: "Projects" as Folder, date: "2025-01-10T12:00:00.000Z" }),
  ];
  await store.applyChanges([
    ...rows.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    { type: "rule", op: "create", id: wide.id, seq: ++seq, updatedAt: wide.updatedAt, entity: wide },
    { type: "folder", op: "create", id: "f1", seq: ++seq, updatedAt: wide.updatedAt, entity: { id: "f1", mailboxId: "mb", name: "Projects" } },
  ] as SyncChange[]);
  return { store, rows };
}

describe("a zero-write forecast places the subject's rows as the list does", () => {
  const cases: Array<[string, ConsentOptions]> = [
    ["the cutline unknown", { now: NOW, rulesOnly: true }],
    ["the folders lens on", { now: NOW, foldersEnabled: true }],
    ["the account's own address", { now: NOW, ownAddresses: [`me@${DOMAIN}`] }],
    ["the defaults", { now: NOW }],
  ];
  for (const [name, options] of cases) {
    it(name, async () => {
      const { store, rows } = await mirror();
      const f = pressForecast({
        reader: store, options, subject: store.list<EngineMessage>("message"), scope: "domain", match: DOMAIN,
        wanted: "ohmail/News", makeRule: true, applyRetro: false, now: NOW,
      });
      expect(f.keep.writes, "the press was meant to write nothing").toEqual([]);
      const list = consentPartition(store, options).placeOf;
      expect(f.keep.places).toEqual(new Map(rows.map((m) => [m.id, list.get(m.id) ?? null])));
    });
  }

  it("the three options each move a row here (the fixture can tell a dropped option)", async () => {
    const { store } = await mirror();
    const base = consentPartition(store, { now: NOW }).placeOf;
    for (const [, options] of cases.slice(0, 3)) {
      const moved = consentPartition(store, options).placeOf;
      expect([...moved].some(([id, p]) => base.get(id) !== p), JSON.stringify(Object.keys(options))).toBe(true);
    }
  });
});
