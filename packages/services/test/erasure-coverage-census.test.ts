import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withoutComments, span } from "../../../scripts/lib/source-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * THE ERASURE COVERAGE CENSUS — what an erasure REACHES, derived rather than remembered.
 *
 * Both sweeps enumerate their tables by hand and nothing made those lists provably complete:
 * `threads` and `thread_notes` were missed for a release, so the thread door answered with a
 * subject, participants and the person's own notes for a mailbox the product said held nothing.
 * THE RULE: every table carrying account or mailbox content is in the sweep's own list or on a
 * WRITTEN survivors list, and one added without either is red here by name. Three questions,
 * because there are three walks and they have already disagreed.
 */

const read = (f: string): string => readFileSync(path.join(ROOT, f), "utf8");

const SCHEMA_MAIL = "packages/db/src/schema-mail.ts";
const SCHEMA_DEVICE = "packages/db/src/schema-mail-sqlite.ts";
const ACCOUNT_SWEEP = "packages/services/src/account-deletion-service.ts";
const MAILBOX_SWEEP = "packages/db/src/mailbox-erasure.ts";
const DEVICE_WALK = "apps/sidecar/src/local-mirror.ts";

function hits(src: string, re: string): Array<[number, RegExpExecArray]> {
  const out: Array<[number, RegExpExecArray]> = [];
  const r = new RegExp(re, "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(src)) !== null) out.push([m.index, m]);
  return out;
}

/** What a table's rows hang off, read from its own column declarations. */
export interface TableScope {
  readonly account: boolean;
  readonly mailbox: boolean;
  /** A row of ONE message — which belongs to one mailbox, so the mailbox sweep owes it too. */
  readonly message: boolean;
  /**
   * A row of ONE THREAD, which is where the defect this census is about actually lived.
   *
   * MEASURED, not foreseen: with the domain at account/mailbox/message alone, cutting
   * `tx.delete(threadNotes)` out of the mailbox sweep left the coverage case GREEN — `thread_notes`
   * is keyed by `thread_id` and nothing else, so the census would have passed over exactly the
   * pair whose omission made the thread door answer for an erased mailbox. A thread's messages
   * live in mailboxes, so a thread-keyed row is a mailbox's content one hop further out.
   */
  readonly thread: boolean;
}

/**
 * Every table in a schema file with what it is keyed by.
 *
 * The COLUMN and not the foreign key: a census that asked about declared FKs would miss a column
 * somebody added without one, and the question here is what the row is ABOUT, not what the
 * database will refuse.
 */
export function scopesIn(src: string, kind: "pgTable" | "sqliteTable"): Map<string, TableScope> {
  const clean = withoutComments(src);
  const out = new Map<string, TableScope>();
  for (const [at, m] of hits(clean, String.raw`export const ([A-Za-z_$][\w$]*)\s*=\s*${kind}\(`)) {
    const [from, to] = span(clean, at + m[0].length - 1);
    const body = clean.slice(from, to);
    out.set(m[1]!, {
      account: /\baccountId\s*:/.test(body),
      mailbox: /\bmailboxId\s*:/.test(body),
      message: /\bmessageId\s*:/.test(body),
      thread: /\bthreadId\s*:/.test(body),
    });
  }
  return out;
}

/**
 * The tables a walk writes, by the handle it writes on. `delete` AND `update`: the response cache
 * is REPLACED rather than removed (an absent idempotency row means "run the mutation again"), and
 * a census that counted deletes alone would read that as an uncovered table and be refuted by a
 * reason nobody needed to write.
 */
export function sweptIn(src: string, handle: string): Set<string> {
  const clean = withoutComments(src);
  return new Set(
    hits(clean, String.raw`\b${handle}\.(?:delete|update)\(\s*([A-Za-z_$][\w$]*)\s*\)`)
      .map(([, m]) => m[1]!),
  );
}

/**
 * ── THE SURVIVORS ────────────────────────────────────────────────────────────────────────────
 *
 * A row an erasure KEEPS, with the reason. A written ruling and never a suppression: the case at
 * the end refuses an entry that no longer names a table, so a reason cannot outlive its schema.
 */
const ACCOUNT_SURVIVORS: Record<string, string> = {
  accounts:
    "the pseudonymous billing subject — Art. 17 keeps it, stamped `erased_at`, and that stamp is "
    + "what the erasure fence reads. The whole reason a fence exists: nothing structural refuses "
    + "a writer that arrives late, because the parent it hangs off is still there",
};

const MAILBOX_SURVIVORS: Record<string, string> = {
  mailboxes:
    "the tombstone — how a removal is REMEMBERED. The row stays, `status = 'disabled'` and "
    + "`erased_at` stamped in the sweep's own transaction, so the id keeps meaning something to "
    + "every FK and to the fence's mailbox arm. Deleting it would make a late write a foreign-key "
    + "failure at best and a re-created mailbox at worst",
};

const MAIL = scopesIn(read(SCHEMA_MAIL), "pgTable");
const DEVICE = scopesIn(read(SCHEMA_DEVICE), "sqliteTable");
const ACCOUNT_SWEPT = sweptIn(read(ACCOUNT_SWEEP), "tx");
const MAILBOX_SWEPT = sweptIn(read(MAILBOX_SWEEP), "tx");
const DEVICE_SWEPT = sweptIn(read(DEVICE_WALK), "db");

/**
 * THE ACCOUNT-SCOPED TABLE SET, exported because the database-level refusal
 * needs exactly this list and the two must not disagree: a trigger
 * on a table this census does not know about, or a table here with no trigger, is the same
 * divergence in the other direction. Read it, never re-derive it.
 */
export function accountScopedTables(): string[] {
  return [...MAIL].filter(([, s]) => s.account || s.mailbox || s.message).map(([k]) => k).sort();
}

/** The tables one MAILBOX owns — the mailbox sweep's domain, and the trigger's mailbox arm. */
export function mailboxScopedTables(): string[] {
  return [...MAIL].filter(([, s]) => s.mailbox || s.message).map(([k]) => k).sort();
}

/** The uncovered tables of one question, the derivation both real cases and the control share. */
function uncovered(
  tables: Map<string, TableScope>,
  inDomain: (s: TableScope) => boolean,
  swept: ReadonlySet<string>,
  survivors: Record<string, string>,
): string[] {
  return [...tables]
    .filter(([k, s]) => inDomain(s) && !swept.has(k) && survivors[k] === undefined)
    .map(([k]) => k)
    .sort();
}

describe("the erasure coverage census", () => {
  it("looked — the schema, both sweeps and the device walk are all non-empty", () => {
    // A census that stopped matching reads exactly like a complete erasure. Floors, not equalities:
    // the numbers move with the schema and a floor that moves with it says nothing.
    expect(MAIL.size, "the mail schema stopped parsing").toBeGreaterThanOrEqual(40);
    expect(DEVICE.size, "the device schema stopped parsing").toBeGreaterThanOrEqual(40);
    expect(ACCOUNT_SWEPT.size, "the account sweep stopped parsing").toBeGreaterThanOrEqual(50);
    expect(MAILBOX_SWEPT.size, "the mailbox sweep stopped parsing").toBeGreaterThanOrEqual(20);
    expect(DEVICE_SWEPT.size, "the device walk stopped parsing").toBeGreaterThanOrEqual(10);
    // …and the domain is the thing the two arms below are about.
    expect(accountScopedTables().length).toBeGreaterThanOrEqual(40);
    expect(mailboxScopedTables().length).toBeGreaterThanOrEqual(20);
  });

  it("the ACCOUNT sweep reaches every table an account's rows live in", () => {
    expect(
      uncovered(MAIL, (s) => s.account || s.mailbox || s.message || s.thread, ACCOUNT_SWEPT, ACCOUNT_SURVIVORS),
      "a table carrying account content that `deleteAccount` never writes. Add it to the sweep "
        + "(child before parent), or to ACCOUNT_SURVIVORS in this file with the reason erasure "
        + "keeps it.",
    ).toEqual([]);
  });

  it("the MAILBOX sweep reaches every table one mailbox's rows live in", () => {
    /**
     * The half that was missed. A mailbox-keyed table is obvious; a MESSAGE-keyed one is the way
     * the gap opened — those rows belong to the mailbox through their message, and `threads` and
     * `thread_notes` sat outside both spellings until somebody read the thread door's answer for
     * an erased mailbox.
     */
    expect(
      uncovered(MAIL, (s) => s.mailbox || s.message || s.thread, MAILBOX_SWEPT, MAILBOX_SURVIVORS),
      "a table carrying one mailbox's content that `sweepMailboxData` never writes. Add it to "
        + "the sweep, or to MAILBOX_SURVIVORS in this file with the reason a mailbox erasure "
        + "leaves it.",
    ).toEqual([]);
  });

  it("the device's own removal walk is the mailbox sweep, table for table", () => {
    /**
     * `cloud-mirror.ts` states this as a fact about the program — "one spelling of what a
     * mailbox's mail is" — and a claim about other code is the shape this repository checks
     * rather than trusts. A table the device store does not HAVE is not a difference: the walk
     * cannot delete what the schema never declared.
     */
    const missing = [...MAILBOX_SWEPT]
      .filter((t) => DEVICE.has(t) && !DEVICE_SWEPT.has(t) && MAILBOX_SURVIVORS[t] === undefined)
      .sort();
    expect(
      missing,
      "a table the mailbox sweep empties and the device's `deleteMailboxRows` leaves behind, on a "
        + "store that has it. Add it to the walk.",
    ).toEqual([]);
  });

  it("carries no survivors entry for a table that no longer exists", () => {
    // A reason that outlives its table reads as a ruling somebody made about today's schema.
    for (const [name, list] of [["ACCOUNT_SURVIVORS", ACCOUNT_SURVIVORS], ["MAILBOX_SURVIVORS", MAILBOX_SURVIVORS]] as const) {
      expect(Object.keys(list).filter((t) => !MAIL.has(t)), `${name} names a table the schema lost`)
        .toEqual([]);
      expect(Object.entries(list).filter(([, why]) => why.trim().length < 20).map(([k]) => k),
        `${name} carries a placeholder reason`).toEqual([]);
    }
  });

  it("refuses a PLANTED table nobody decided — the census's own positive control", () => {
    /**
     * Every case above says what the repository looks like today, and all three are currently
     * satisfied — which is exactly the state in which a census that had stopped looking would
     * also pass. So the derivation is driven with a table it has never seen: one column, no
     * sweep, no survivors entry. Then the two ways out are driven too — the sweep takes it, or a
     * survivors entry rules on it — because a refusal with no admission is a rule that says
     * "everything".
     */
    const planted = `
      export const inventedRows = pgTable("invented_rows", {
        id: uuid("id").primaryKey(),
        accountId: uuid("account_id").notNull().references(() => accounts.id),
        mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
      });
    `;
    const tables = scopesIn(planted, "pgTable");
    expect([...tables.keys()]).toEqual(["inventedRows"]);

    const noSweep = new Set<string>();
    expect(uncovered(tables, (s) => s.account || s.mailbox || s.message || s.thread, noSweep, {}))
      .toEqual(["inventedRows"]);
    expect(uncovered(tables, (s) => s.mailbox || s.message || s.thread, noSweep, {}))
      .toEqual(["inventedRows"]);

    // (i) the sweep takes it — read out of a planted sweep, the same way the real one is read.
    const sweptHere = sweptIn(`await tx.delete(inventedRows).where(eq(x, y));`, "tx");
    expect([...sweptHere]).toEqual(["inventedRows"]);
    expect(uncovered(tables, (s) => s.mailbox || s.message || s.thread, sweptHere, {})).toEqual([]);

    // (ii) or somebody writes down why it stays.
    expect(uncovered(tables, (s) => s.mailbox || s.message || s.thread, noSweep,
      { inventedRows: "a fixture for this control, and nothing else" })).toEqual([]);

    // …and a table keyed by NEITHER is outside the domain rather than admitted by silence: the
    // census must be able to say what it did not cover.
    const outside = scopesIn(`
      export const serverFacts = pgTable("server_facts", { id: uuid("id").primaryKey() });
    `, "pgTable");
    expect(uncovered(outside, (s) => s.account || s.mailbox || s.message || s.thread, noSweep, {})).toEqual([]);
  });
});

/**
 * ── WHAT A MAILBOX REMOVAL WRITES: EXCLUSIVE OR SHARED ────────────────────────
 *
 * A table keyed by the mailbox, or by one of its messages, holds that mailbox's rows alone.
 * Every OTHER table either walk writes is SHARED — a row there can be another mailbox's — and is
 * ruled here with what keeps a surviving mailbox's row and the case that measures it on each
 * door. An account's own tables (rules, tags, contacts) are written by neither walk; one written
 * by either is red here by name, and so is a ruling whose case does not exist.
 */
const HOSTED_CASE = ["packages/services/test/erasure-refills-the-window.test.ts", "keeps what the other mailbox still holds"] as const;
const DEVICE_CASE = ["apps/sidecar/test/removal-keeps-the-other-mailbox.test.ts", "keeps what the other mailbox still holds"] as const;

interface SharedWrite { keeps: string; hosted: readonly [string, string]; device: readonly [string, string] }
const SHARED_WRITES: Record<string, SharedWrite> = {
  threads: {
    keeps: "a conversation goes only when no other mailbox's message is in it", hosted: HOSTED_CASE,
    device: ["apps/sidecar/test/standalone-consent-and-removal.test.ts", "A SHARED CONVERSATION STAYS"],
  },
  threadNotes: { keeps: "notes go with a conversation only the removed mailbox is in", hosted: HOSTED_CASE, device: DEVICE_CASE },
  drafts: {
    keeps: "a reply drafted in another mailbox keeps its words and loses only its anchor",
    hosted: HOSTED_CASE, device: DEVICE_CASE,
  },
  outboundSends: {
    keeps: "only the sends of the removed mailbox's drafts or of its own content claims go",
    hosted: HOSTED_CASE, device: DEVICE_CASE,
  },
  mailboxes: {
    keeps: "the removed mailbox's own row becomes its tombstone; no other mailbox's row is written",
    hosted: HOSTED_CASE, device: DEVICE_CASE,
  },
  auditLog: {
    keeps: "every row stays; only the hashes naming the removed mailbox's settings or signature come off its own rows, another mailbox's keep theirs",
    hosted: HOSTED_CASE, device: DEVICE_CASE,
  },
};

/** The tables `swept` writes that are neither keyed to the mailbox nor ruled shared. */
function unruled(swept: ReadonlySet<string>, tables: Map<string, TableScope>, shared: Record<string, SharedWrite>): string[] {
  return [...swept].filter((t) => {
    const s = tables.get(t);
    return !(s !== undefined && (s.mailbox || s.message)) && shared[t] === undefined;
  }).sort();
}

/** A ruling whose case is not in its file — a rule nothing measures. */
function unmeasured(shared: Record<string, SharedWrite>): string[] {
  const out: string[] = [];
  for (const [t, w] of Object.entries(shared)) {
    for (const [file, title] of [w.hosted, w.device]) {
      const src = existsSync(path.join(ROOT, file)) ? read(file) : "";
      if (!src.includes(`it("${title}`)) out.push(`${t}: ${file} has no case "${title}"`);
    }
  }
  return out;
}

describe("what a mailbox removal writes, each table exclusive or shared", () => {
  it("every table either walk writes is the mailbox's own, or ruled shared", () => {
    expect(unruled(MAILBOX_SWEPT, MAIL, SHARED_WRITES), "the hosted sweep writes a table no mailbox owns").toEqual([]);
    expect(unruled(DEVICE_SWEPT, MAIL, SHARED_WRITES), "the device walk writes a table no mailbox owns").toEqual([]);
  });

  it("every shared ruling is written by a walk and measured on both doors", () => {
    const written = new Set([...MAILBOX_SWEPT, ...DEVICE_SWEPT]);
    expect(Object.keys(SHARED_WRITES).filter((t) => !written.has(t)), "a ruling outlived its write").toEqual([]);
    expect(unmeasured(SHARED_WRITES)).toEqual([]);
  });

  it("refuses an account table written, and a ruling nothing measures — the positive control", () => {
    const planted = new Set([...DEVICE_SWEPT, "rules"]);
    expect(unruled(planted, MAIL, SHARED_WRITES)).toEqual(["rules"]);
    expect(unmeasured({ rules: { keeps: "planted", hosted: HOSTED_CASE, device: ["apps/sidecar/test/removal-keeps-the-other-mailbox.test.ts", "no such case"] } }))
      .toEqual(['rules: apps/sidecar/test/removal-keeps-the-other-mailbox.test.ts has no case "no such case"']);
  });
});
