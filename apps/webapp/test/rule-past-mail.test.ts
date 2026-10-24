/**
 * THE COUNT A RULES-PAGE CHANGE STATES — `rulePastMail` over mirror rows.
 *
 * It must count only mail the router names THIS rule for (a higher rule's mail is not claimed),
 * only mail the pass could move (organized, not set aside, not already there), and answer null
 * for a rule the mirror cannot evaluate.
 */
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, mutationEffects, type EngineMessage, type Folder, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { pileOf, rulePastMail, ruleRetarget, walkedMailboxes } from "../app/shell/rule-past-mail";

const rule = (over: Partial<RuleDTO> = {}): RuleDTO => ({
  id: "r-1", kind: "sender", match: "knock@door.test", destination: "ohmail/Screened", priority: 0,
  provenance: "promoted", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-12T10:00:00.000Z", updatedAt: "2026-09-12T10:00:00.000Z", ...over,
});

const msg = (id: string, over: Partial<EngineMessage> = {}): EngineMessage => ({
  id, from: { name: "K", address: "knock@door.test" }, to: [], cc: [], subject: "hello", snippet: "",
  date: "2026-09-12T08:00:00.000Z", folder: "ohmail/Screened", flags: [], ...over,
} as unknown as EngineMessage);

describe("rulePastMail", () => {
  const screened = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];

  it("counts the rule's five screened messages for a change to the Ohbox", () => {
    expect(rulePastMail(rule(), [rule()], screened, "INBOX")).toBe(5);
    expect(rulePastMail(rule(), [rule()], screened, null)).toBe(5);
  });

  it("leaves out mail already at the new place, set aside, or outside the organized folders", () => {
    const rows = [
      ...screened,
      msg("there", { folder: "INBOX" }),
      msg("aside", { triage: { state: "parked" } } as unknown as Partial<EngineMessage>),
      msg("own", { folder: "Clients/2026" as Folder }),
    ];
    expect(rulePastMail(rule(), [rule()], rows, "INBOX")).toBe(5);
    // Before a place is chosen the count is still the pile: mail in the Ohbox is not the rule's to move.
    expect(rulePastMail(rule(), [rule()], rows, null)).toBe(5);
  });

  it("does not claim mail a higher rule decides", () => {
    const own = rule({ id: "r-2", kind: "sender", destination: "ohmail/Receipts", subjectContains: "invoice", priority: 5 });
    const domain = rule({ id: "r-1", kind: "domain", match: "door.test" });
    const rows = [...screened, msg("inv", { subject: "invoice 7", folder: "ohmail/Receipts" })];
    expect(rulePastMail(domain, [domain, own], rows, "INBOX")).toBe(5);
  });

  it("a Change's wire is a re-filing or nothing at all, and the engine takes it as the server will", async () => {
    expect(ruleRetarget("r-1", "INBOX", true)).toEqual({ kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: false, refile: true });
    expect(ruleRetarget("r-1", "INBOX", false)).toEqual({ kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: false });
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{ type: "rule", op: "create", id: "r-1", seq: 1, updatedAt: rule().updatedAt, entity: rule() }] as SyncChange[]);
    const ctx = { now: () => new Date("2026-09-25T13:00:00.000Z"), uuid: () => "u" };
    const retroOf = (refile: boolean) => (mutationEffects(store, ruleRetarget("r-1", "INBOX", refile), ctx)[0]!.entity as RuleDTO).retro;
    expect(retroOf(true)).toEqual({ requestedAt: "2026-09-25T13:00:00.000Z", doneAt: null, from: "ohmail/Screened" });
    expect(retroOf(false)).toBeUndefined();
  });

  /* One letter placed in News by the reader's `m`, one in News by a subject rule, two kept in the
     Ohbox. The Change re-files the rule's pile: one letter, never the Ohbox's two. */
  it("counts the rule's pile, not the mail it was told to leave", () => {
    const nora = rule({ id: "r-n", match: "nora@corr.example", destination: "ohmail/News", provenance: "manual" });
    const weekly = rule({ id: "r-w", match: "nora@corr.example", destination: "ohmail/News", subjectContains: "weekly", provenance: "manual" });
    const from = { name: "Nora", address: "nora@corr.example" };
    const rows = [
      msg("n1", { from, subject: "letter one", folder: "ohmail/News", placeDecided: true } as Partial<EngineMessage>),
      msg("n2", { from, subject: "weekly digest two", folder: "ohmail/News" }),
      msg("n3", { from, subject: "letter three", folder: "INBOX" }),
      msg("n4", { from, subject: "letter four", folder: "INBOX" }),
    ];
    expect(rulePastMail(nora, [nora, weekly], rows, null)).toBe(1);
    expect(rulePastMail(nora, [nora, weekly], rows, "ohmail/Receipts")).toBe(1);
    expect(rulePastMail(nora, [nora, weekly], rows, "ohmail/News")).toBe(0);
  });

  it("a re-filing still waiting counts from where it started", () => {
    const pending = rule({ destination: "ohmail/Receipts", retro: { requestedAt: "2026-09-12T10:00:00.000Z", doneAt: null, from: "ohmail/Screened" } });
    expect(pileOf(pending)).toBe("ohmail/Screened");
    expect(pileOf(rule({ destination: "ohmail/Reads" as Folder }))).toBe("ohmail/News");
    expect(rulePastMail(pending, [pending], screened, "INBOX")).toBe(5);
    expect(rulePastMail(rule({ destination: "ohmail/Receipts" }), [rule({ destination: "ohmail/Receipts" })], screened, "INBOX")).toBe(0);
  });

  /* The sender sheet asked for past mail and its walk is still owed: a Change takes that walk to the
     new place, so the count is the walk's (a placement the person made stays), and Undo re-asks it. */
  it("a walk still owed is counted as the walk, and Undo's wire asks for it again", () => {
    const owed = rule({ destination: "ohmail/Receipts", retro: { requestedAt: "2026-09-12T10:00:00.000Z", doneAt: null, from: null } });
    const rows = [
      msg("placed", { folder: "ohmail/Receipts", placeDecided: true } as Partial<EngineMessage>),
      msg("waiting1", { folder: "INBOX" }), msg("waiting2", { folder: "INBOX" }),
    ];
    expect(rulePastMail(owed, [owed], rows, "ohmail/News")).toBe(2);
    expect(rulePastMail(owed, [owed], rows, null)).toBe(2);
    expect(ruleRetarget("r-1", "ohmail/Receipts", "walk"))
      .toEqual({ kind: "rule_update", ruleId: "r-1", destination: "ohmail/Receipts", applyRetro: true });
  });

  /* Two mailboxes, the second only read here (nobody organizes it): no walk reaches its letters, so
     neither count includes them. One held by a live install that takes the request is walked there. */
  it("counts only the mailboxes a Change's walk reaches", () => {
    const roster = { kind: "known" as const, rows: [
      { id: "mb-1", status: "connected", organizerRole: "organizer" as const },
      { id: "mb-2", status: "connected", organizerRole: "reader" as const, organizedBy: null },
      { id: "mb-3", status: "connected", organizerRole: "reader" as const, organizerAcceptsRequests: true, organizerState: "held" as const,
        organizedBy: { kind: "local", name: "Laptop", since: "2026-10-01T00:00:00.000Z" } },
      { id: "mb-4", status: "connected", organizerRole: "reader" as const, organizerAcceptsRequests: false, organizerState: "held" as const,
        organizedBy: { kind: "local", name: "Old laptop", since: "2026-10-01T00:00:00.000Z" } },
      { id: "mb-5", status: "disabled", organizerRole: "organizer" as const },
    ] };
    const walked = walkedMailboxes(roster);
    expect([...walked!].sort()).toEqual(["mb-1", "mb-3"]);
    expect(walkedMailboxes({ kind: "absent" })).toBeNull();
    expect(walkedMailboxes({ kind: "pending" })).toBeNull();

    const rows = ["mb-1", "mb-2", "mb-3", "mb-4"].flatMap((mailboxId) => [
      msg(`${mailboxId}-pile`, { mailboxId } as Partial<EngineMessage>),
      msg(`${mailboxId}-ohbox`, { mailboxId, folder: "INBOX" } as Partial<EngineMessage>),
    ]);
    expect(rulePastMail(rule(), [rule()], rows, "ohmail/Receipts", walked)).toBe(2);
    const owed = rule({ retro: { requestedAt: "2026-09-12T10:00:00.000Z", doneAt: null, from: null } });
    expect(rulePastMail(owed, [owed], rows, "ohmail/Receipts", walked)).toBe(4);
    // No roster here (the desktop, the demo): every mailbox counts, as before.
    expect(rulePastMail(rule(), [rule()], rows, "ohmail/Receipts", null)).toBe(4);
  });

  it("answers null where the mirror cannot evaluate the rule", () => {
    expect(rulePastMail(rule({ bodyContains: "invoice" }), [rule()], screened, "INBOX")).toBeNull();
    expect(rulePastMail(rule({ kind: "header", match: "list-id:x" }), [rule()], screened, "INBOX")).toBeNull();
  });
});
