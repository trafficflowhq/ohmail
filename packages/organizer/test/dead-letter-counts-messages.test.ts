import { describe, expect, it } from "vitest";
import { DeadLetterLedger } from "../src/dead-letter.js";

/**
 * THE LEDGER COUNTS MESSAGES, NOT KEYS. One set-aside message reads one whatever its key says: a ref
 * with no UIDVALIDITY ("undefined:<uid>") and the row the store wrote for it ("0") are one key, and the
 * top-of-cycle read (`reconcile`) drops a key the store no longer holds — a folder renamed or moved, a
 * row resolved, a mailbox's rows deleted.
 */
const row = (folder: string, uidValidity: string, uid: number) =>
  ({ folder, uidValidity, uid, code: "mime_unparseable", attempts: 1 });
const unreadable = { code: "mime_unparseable" as const, deterministic: true };

describe("the set-aside count is a count of messages", () => {
  it("a ref with no UIDVALIDITY and its stored row are one message", () => {
    const l = new DeadLetterLedger();
    expect(l.record({ folder: "INBOX", ref: "undefined:5" }, unreadable)).toBe("skip");
    l.hydrate([row("INBOX", "0", 5)]);
    expect(l.skipped).toBe(1);
  });

  it("a folder rename moves the row and the count stays one", () => {
    const l = new DeadLetterLedger();
    l.reconcile([row("INBOX", "4400", 3)]);
    l.reconcile([row("Renamed", "4400", 3)]);
    expect(l.skipped).toBe(1);
    expect(l.has("INBOX", "4400", 3)).toBe(false);
  });

  it("a folder moved under another parent keeps the count at one", () => {
    const l = new DeadLetterLedger();
    l.reconcile([row("Projects", "4400", 3)]);
    l.reconcile([row("Archive/Projects", "4400", 3)]);
    expect(l.skipped).toBe(1);
  });

  it("rows the store no longer holds (resolved, or the mailbox's rows deleted) count zero", () => {
    const l = new DeadLetterLedger();
    l.reconcile([row("INBOX", "4400", 3), row("INBOX", "4400", 4)]);
    l.reconcile([]);
    expect(l.skipped).toBe(0);
  });

  it("CONTROL: a claimed subset hydrates without dropping the rest", () => {
    const l = new DeadLetterLedger();
    l.reconcile([row("INBOX", "4400", 3), row("INBOX", "4400", 4)]);
    l.hydrate([row("INBOX", "4400", 4)]);
    expect(l.skipped).toBe(2);
  });

  it("CONTROL: a decision still in memory and not yet terminal is kept", () => {
    const l = new DeadLetterLedger({ maxAttempts: 3 });
    expect(l.record({ folder: "INBOX", ref: "4400:9" }, { code: "unclassified", deterministic: false })).toBe("retry");
    l.reconcile([]);
    expect(l.record({ folder: "INBOX", ref: "4400:9" }, { code: "unclassified", deterministic: false })).toBe("retry");
    expect(l.record({ folder: "INBOX", ref: "4400:9" }, { code: "unclassified", deterministic: false })).toBe("skip");
  });
});
