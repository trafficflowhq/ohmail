import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, consentIndex, consentPartition, decidedDestination, mailboxProfiles,
  presentationReader, rulesAsRun, rulesInPlay, rulesList, rulesShown, screenerSegments, senderKey,
  type EngineMessage, type Folder, type MailboxProfileEntity, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { placedRule } from "../src/consent-cutline.js";

/**
 * THE PARTITION JUDGES EACH MAILBOX BY ITS OWN ORGANIZER. A mailbox this install only reads is
 * presented by the organizer's document (`mailbox_profile`); every other mailbox by the local rule
 * entities. One sender, two mailboxes, two answers: the organizer let B in on the read mailbox,
 * and the local rules screen B out on the one this install organizes.
 */

const NOW = new Date("2026-09-26T08:00:00.000Z");
const RECENT = "2026-09-25T09:00:00.000Z";
const READ = "mb-read";
const OWN = "mb-own";
const B = "b@sender.test";
let seq = 0;

function msg(id: string, mailboxId: string, from: string, folder: Folder = "INBOX"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId, threadId: null, messageIdHeader: null, subject: `s ${id}`,
    from: { name: null, address: from }, to: [], cc: [], date: RECENT, folder, snippet: "",
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: RECENT,
  };
}

function rule(id: string, match: string, destination: Folder): RuleDTO {
  return {
    id, kind: "sender", match, destination, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: RECENT, updatedAt: RECENT,
  } as RuleDTO;
}

function profile(mailboxId: string, rules: RuleDTO[]): MailboxProfileEntity {
  return { mailboxId, rules, asOf: RECENT, from: { kind: "local", name: "Host", since: null }, updatedAt: RECENT };
}

async function mirror(changes: Array<{ type: string; id: string; entity: unknown }>): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(changes.map((c) => ({ ...c, op: "create", seq: ++seq, updatedAt: RECENT })) as SyncChange[]);
  return store;
}

const m = (x: EngineMessage) => ({ type: "message", id: x.id, entity: x });
const r = (x: RuleDTO) => ({ type: "rule", id: x.id, entity: x });
const p = (x: MailboxProfileEntity) => ({ type: "mailbox_profile", id: x.mailboxId, entity: x });

describe("one sender, two mailboxes, two organizers", () => {
  const onRead = msg("r1", READ, B);
  const onOwn = msg("o1", OWN, B);
  const letIn = rule(`profile:${READ}:0`, B, "INBOX");
  const screenedOut = rule("local-1", B, "ohmail/Screened");

  it("the read mailbox follows its document, the organized one the local rules", async () => {
    const store = await mirror([m(onRead), m(onOwn), r(screenedOut), p(profile(READ, [letIn]))]);
    const part = consentPartition(store, { now: NOW });
    expect(part.placeOf.get("r1"), "the organizer let B in on the read mailbox").toBe("INBOX");
    expect(part.placeOf.get("o1"), "this install screened B out on its own mailbox").toBe("ohmail/Screened");

    const index = consentIndex(rulesList(store), mailboxProfiles(store));
    expect(decidedDestination(index, B, READ)).toBe("INBOX");
    expect(decidedDestination(index, B, OWN)).toBe("ohmail/Screened");
    // No mailbox named: the account's own rules — what a press planner writes against.
    expect(decidedDestination(index, B)).toBe("ohmail/Screened");
    expect(placedRule(index, onRead, null)?.id).toBe(letIn.id);
  });

  it("a read mailbox with no document is judged by the local rules, as before", async () => {
    const store = await mirror([m(onRead), r(screenedOut)]);
    expect(consentPartition(store, { now: NOW }).placeOf.get("r1")).toBe("ohmail/Screened");
  });

  it("an entity with no rule list is no document", async () => {
    const store = await mirror([m(onRead), r(screenedOut), { type: "mailbox_profile", id: READ, entity: { mailboxId: READ } }]);
    expect(mailboxProfiles(store)).toHaveLength(0);
    expect(consentPartition(store, { now: NOW }).placeOf.get("r1")).toBe("ohmail/Screened");
  });

  it("the let-in sender is not waiting in the reader's Screener; a stranger is", async () => {
    const stranger = msg("r2", READ, "stranger@nobody.test");
    const store = await mirror([m(onRead), m(stranger), p(profile(READ, [letIn]))]);
    const part = consentPartition(store, { now: NOW });
    const waiting = screenerSegments(presentationReader(store, part), NOW).waiting
      .map((row) => senderKey(row.from.address));
    expect(waiting).toEqual(["stranger@nobody.test"]);
  });

  it("a destination spelled the pre-0.22 way decides the pile it names today", async () => {
    // INVERTED by ARCH-R902: a rule that moved nothing leaves r1 where the mailbox has it, so the
    // old spelling is read where it still decides — the sender's pile.
    const store = await mirror([m(onRead), p(profile(READ, [rule(`profile:${READ}:0`, B, "ohmail/Reads" as Folder)]))]);
    expect(consentPartition(store, { now: NOW }).placeOf.get("r1")).toBe("INBOX");
    expect(decidedDestination(consentIndex(rulesList(store), mailboxProfiles(store)), B, READ)).toBe("ohmail/News");
  });

  it("the sender sheet names the organizer's rule for a row of the read mailbox it filed", async () => {
    // Kept over a FILED letter since ARCH-R902: the wire carries the folder the organizer's rule
    // moved it to. The unfiled twin is placed by no rule, and the sheet names none.
    const sheet = async (row: EngineMessage): Promise<string[]> => {
      const store = await mirror([m(row), p(profile(READ, [rule(`profile:${READ}:0`, B, "ohmail/Receipts")]))]);
      const placeOf = consentPartition(store, { now: NOW }).placeOf;
      const inPlay = rulesInPlay({ reader: store, placeOf, subject: [row], scope: "sender", match: B });
      return inPlay.lines.flatMap((l) => l.rules.map((x) => x.id));
    };
    expect(await sheet(msg("r1", READ, B, "ohmail/Receipts"))).toEqual([`profile:${READ}:0`]);
    expect(await sheet(onRead)).toEqual([]);
  });
});

describe("a reader-only install's rules, from the organizer's copy", () => {
  const OTHER = "mb-read-2";
  const staleLocal = rule("local-1", B, "ohmail/News");
  const theirs = (mb: string, at: number) => rule(`profile:${mb}:${at}`, B, "ohmail/Receipts");
  const filed = msg("r1", READ, B, "ohmail/Receipts");
  const shown = (store: MemoryMirrorStore, readerOnly = true) =>
    rulesShown(store, { readerOnly, queued: [], applied: [], now: NOW });

  it("the sheet beside a stale local twin names only the organizer's rule", async () => {
    const store = await mirror([m(filed), r(staleLocal), p(profile(READ, [theirs(READ, 0)]))]);
    const placeOf = consentPartition(store, { now: NOW }).placeOf;
    const inPlay = rulesInPlay({ reader: store, placeOf, subject: [filed], scope: "sender", match: B });
    expect(inPlay.lines.flatMap((l) => l.rules.map((x) => `${x.id}->${x.destination}`))).toEqual([`profile:${READ}:0->ohmail/Receipts`]);
  });

  it("two copies saying the same give one row, carrying the local twin's id and the organizer's place", async () => {
    const store = await mirror([r(staleLocal), p(profile(READ, [theirs(READ, 0)])), p(profile(OTHER, [theirs(OTHER, 3)]))]);
    const s = shown(store);
    expect(s.source).toBe("published");
    expect(s.rules.map((x) => `${x.id}->${x.destination}`)).toEqual(["local-1->ohmail/Receipts"]);
    expect(s.doorless.size).toBe(0);
    expect(s.holder).toBe("Host");
  });

  it("copies that differ under one key stay twins; a rule only the organizer has is doorless", async () => {
    const elsewhere = rule(`profile:${OTHER}:0`, B, "INBOX");
    const onlyThere = rule(`profile:${READ}:1`, "c@sender.test", "ohmail/News");
    const store = await mirror([p(profile(READ, [theirs(READ, 0), onlyThere])), p(profile(OTHER, [elsewhere]))]);
    const s = shown(store);
    expect(s.rules.filter((x) => x.match === B).map((x) => x.destination).sort()).toEqual(["INBOX", "ohmail/Receipts"]);
    expect(new Set(s.rules.map((x) => x.id)).size, "two rows share an id").toBe(s.rules.length);
    expect(s.rules.every((x) => s.doorless.has(x.id))).toBe(true);
  });

  it("CONTROLS: an organizer, and a reader with no copy, list rulesAsRun", async () => {
    const withCopy = await mirror([r(staleLocal), p(profile(READ, [theirs(READ, 0)]))]);
    expect(shown(withCopy, false)).toEqual({ source: "local", rules: rulesAsRun(withCopy, []), doorless: new Set(), holder: null });
    const noCopy = await mirror([r(staleLocal)]);
    expect(shown(noCopy).rules).toEqual(rulesAsRun(noCopy, []));
    expect(shown(noCopy).source).toBe("local");
  });
});
