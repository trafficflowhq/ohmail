import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  presentationReader,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * A SCREENING PRESS INTO THE OHBOX OVER A SUBJECT SPLIT TO NEWS. The
 * address carries an older bare rule into the Ohbox, a newer subject-narrowed rule into News (in
 * either spelling) and a bare domain rule into the Ohbox. Mail the term does not name is presented
 * in the Ohbox; only the named subject is presented in News.
 */

const NOW = new Date("2026-09-25T13:10:00.000Z");
const ADDR = "info@shop.example";
const TERM = "[Weekly-Digest]";
let seq = 0;

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination" | "createdAt">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, updatedAt: o.createdAt,
    subjectContains: null, bodyContains: null, ...o,
  };
}

function message(id: string, subject: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: ADDR }, to: [], cc: [],
    date: "2026-09-25T13:30:37.000Z", arrivedAt: "2026-09-25T12:57:27.601Z", folder: "INBOX", snippet: "",
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-25T12:57:27.601Z",
  } as EngineMessage;
}

function ownerRules(news: Folder): RuleDTO[] {
  return [
    rule({ id: "7f7f3487-bare", destination: "INBOX", provenance: "seeded-from-sent", createdAt: "2026-08-05T08:39:13.420Z", updatedAt: "2026-09-25T13:02:29.568Z" }),
    rule({ id: "72e945cb-split", destination: news, subjectContains: TERM, createdAt: "2026-08-12T17:24:24.081Z" }),
    rule({ id: "86e76017-domain", kind: "domain", match: "shop.example", destination: "INBOX", createdAt: "2026-08-10T10:00:00.000Z" }),
  ];
}

async function presented(rules: RuleDTO[], messages: EngineMessage[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  const p = consentPartition(store, { now: NOW, ownAddresses: ["owner@home.example"] });
  const view = presentationReader(store, p);
  return (id: string) => view.get<EngineMessage>("message", id)?.folder;
}

const OTHER = message("m-other", "Order fulfilled");
const MATCH = message("m-match", `${TERM} weekly report`);

describe("the reported shape: a bare Ohbox rule beside a newer subject rule into News", () => {
  it.each(["ohmail/Reads", "ohmail/News"] as Folder[])("spelled %s: an unfiled match stays in the Ohbox beside the other mail", async (news) => {
    for (const input of [ownerRules(news), [...ownerRules(news)].reverse()]) {
      const at = await presented(input, [OTHER, MATCH]);
      expect(at(OTHER.id)).toBe("INBOX");
      // INVERTED by ARCH-R902: the router files the match at arrival and that is
      // its folder on the wire; this unfiled row stays in the INBOX (`split-rule-placement`'s router).
      expect(at(MATCH.id)).toBe("INBOX");
    }
  });
});
