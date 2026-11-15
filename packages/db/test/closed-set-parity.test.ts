import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig as pgConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig, SQLiteSyncDialect, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import { SQLiteTable as SQLiteTableClass } from "drizzle-orm/sqlite-core";
import { MAIL_MIGRATIONS_DIR, SQLITE_MIGRATIONS_DIR } from "@ohmail/db-mail";
import * as pgSchema from "../src/schema-mail.js";
import * as sqliteSchema from "../src/schema-mail-sqlite.js";
import { CLOSED_SETS, closedSetValue, organizerKindColumn, ClosedSetViolation } from "../src/closed-sets.js";
import { GROWING_LIST_SHAPE, hasGrowingListShape, shapeCheck } from "../src/closed-set-shape.js";

/**
 * A CHECK ON A DEVICE IS A TABLE REBUILD, SO THIS DECIDES WHICH ONES MAY BE THERE.
 *
 * SQLite has no `ALTER … DROP CONSTRAINT` — a CHECK is part of the table definition. The server
 * widens a closed set by DROP CONSTRAINT then ADD, and it has done so eight times; the day 0.18
 * ships the device store, the baseline freezes and every further widening of a set carried there
 * becomes a fifty-column rebuild for one word.
 *
 * The rule, and what this file is: a set that GROWS (measured — its member list was added in more
 * than one migration) carries NO member list in any store and is refused at the write door
 * instead; since mail 0202 the server holds it to a SHAPE and the device carries no CHECK for it.
 * An IMMUTABLE set (added once, closed by an invariant) keeps its CHECK on both twins. This
 * replaces the argument the `.noop` files used to carry, which was "the journal has never
 * shipped" — true until 0.18 and then never again.
 *
 * Every classification below is asserted against the pg journal's own history rather than typed.
 */

/** A constraint's name wherever a CHECK is spelled, with line comments stripped first. */
function checkNames(sql: string): string[] {
  const code = sql.split("\n").map((l) => (l.trimStart().startsWith("--") ? "" : l)).join("\n");
  const flat = code.replace(/\s+/g, " ");
  return [...flat.matchAll(/CONSTRAINT "([a-z0-9_]+)" CHECK/g)].map((m) => m[1] as string);
}

/** Which migrations ADD each CHECK. More than one ⇒ it was dropped and added back: a widening. */
function addedIn(dir: string): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const name of new Set(checkNames(readFileSync(join(dir, file), "utf8")))) {
      const seen = by.get(name) ?? [];
      seen.push(file);
      by.set(name, seen);
    }
  }
  return by;
}

const PG_HISTORY = addedIn(MAIL_MIGRATIONS_DIR);
const DEVICE_HISTORY = addedIn(SQLITE_MIGRATIONS_DIR);

/** The CHECK names each twin's query builder declares, and the body it renders for one. */
function declaredChecks(tables: [string, PgTable | SQLiteTable][], arm: "pg" | "sqlite") {
  const out = new Map<string, string>();
  for (const [, table] of tables) {
    const config = arm === "pg"
      ? pgConfig(table as PgTable)
      : sqliteConfig(table as SQLiteTable);
    for (const ck of config.checks) {
      const rendered = arm === "pg"
        ? new PgDialect().sqlToQuery(ck.value).sql
        : new SQLiteSyncDialect().sqlToQuery(ck.value).sql;
      out.set(ck.name, rendered.replace(/"[a-z_]+"\./g, "").replace(/["`]/g, "").replace(/\s+/g, " ").trim());
    }
  }
  return out;
}

const PG_CHECKS = declaredChecks(
  Object.entries(pgSchema).filter(([, v]) => is(v, PgTableClass)) as [string, PgTable][], "pg");
const SQLITE_CHECKS = declaredChecks(
  Object.entries(sqliteSchema).filter(([, v]) => is(v, SQLiteTableClass)) as [string, SQLiteTable][], "sqlite");

/**
 * The members a rendered `… in ('a', 'b')` body admits. `null` for a body that is not an
 * enumeration at all — a numeric bound or a shape — which is how a CHECK that closes no set is
 * told apart from one that does, rather than by its name ending in `_closed`.
 */
function membersOf(body: string): string[] | null {
  const m = /\bin \(([^)]*)\)/.exec(body);
  if (m === null) return null;
  const inner = (m[1] as string).trim();
  if (inner === "") return null;
  const parts = [...inner.matchAll(/'([^']*)'/g)].map((p) => p[1] as string);
  return parts.length === 0 ? null : parts;
}

/** What every registry entry says about itself, as one comparable row. */
const REGISTERED = new Map(CLOSED_SETS.map((s) => [s.constraint, s]));

describe("closed sets, and which of them a device store may enforce", () => {
  it("reads a pg journal that really carries CHECK constraints, and a device journal", () => {
    // The census half: every assertion below is a comparison against these two maps, and two
    // empty maps would satisfy all of them.
    expect(PG_HISTORY.size, "the shared journal is expected to carry CHECK constraints")
      .toBeGreaterThanOrEqual(30);
    expect([...PG_HISTORY.values()].filter((f) => f.length > 1).length,
      "the server is expected to have widened sets by DROP-then-ADD").toBeGreaterThanOrEqual(5);
    expect(PG_CHECKS.size, "the server twin declares CHECKs").toBeGreaterThanOrEqual(8);
    expect(SQLITE_CHECKS.size, "the device twin declares CHECKs").toBeGreaterThanOrEqual(2);
  });

  it("registers every closed set the SERVER TWIN declares, and invents none", () => {
    // A CHECK that closes an enumeration is a decision about the device store. One that bounds a
    // number or fixes a shape is not, and saying so is what keeps the registry from being a list
    // of names somebody kept in step by hand.
    const enumerated = [...PG_CHECKS].filter(([, body]) => membersOf(body) !== null).map(([n]) => n);
    expect(enumerated.length).toBeGreaterThanOrEqual(5);
    const unregistered = enumerated.filter((n) => !REGISTERED.has(n));
    expect(unregistered, "closed sets on the server twin with no entry in CLOSED_SETS").toEqual([]);

    for (const set of CLOSED_SETS) {
      expect(PG_CHECKS.has(set.constraint), `${set.constraint} is registered and the server twin does not declare it`).toBe(true);
      expect(PG_HISTORY.has(set.constraint), `${set.constraint} is registered and no migration creates it`).toBe(true);
    }
  });

  it("classifies each set by the JOURNAL'S OWN HISTORY, not by what the table says", () => {
    // WIDENABLE is a measurement: added in more than one migration means dropped and added back.
    // An entry classified the other way round is the whole failure this file exists to prevent,
    // so the class is derived here and compared with the one recorded.
    for (const set of CLOSED_SETS) {
      // A list that GROWS is measured on the member list it was: added in more than one migration
      // means dropped and added back. Its shape is added once, by the entry that drops the list.
      const added = PG_HISTORY.get(set.was ?? set.constraint) as string[];
      const measured = added.length > 1 ? "shape" : "immutable";
      expect(set.kind, `${set.constraint} is recorded as ${set.kind} and the journal adds `
        + `${set.was ?? set.constraint} in ${added.join(", ")}`).toBe(measured);
      expect(set.was === undefined, `${set.constraint}: only a shape names the list it replaced`).toBe(set.kind !== "shape");
      if (set.kind === "shape") {
        expect(PG_HISTORY.get(set.constraint), `${set.constraint} is added once, by mail 0202`).toEqual(["0202_retired.sql"]);
      }
      expect(set.why.length, `${set.constraint} carries no reason`).toBeGreaterThan(40);
    }
    // And both classes are actually represented, or every case above is vacuous for one of them.
    expect(CLOSED_SETS.some((s) => s.kind === "shape")).toBe(true);
    expect(CLOSED_SETS.some((s) => s.kind === "immutable")).toBe(true);
  });

  it("keeps a set that GROWS off the device store — twin, baseline and every step", () => {
    const growing = CLOSED_SETS.filter((s) => s.kind === "shape");
    expect(growing.map((s) => s.constraint).sort()).toEqual([
      "mailboxes_disabled_reason_shape",
      "mailboxes_organized_by_kind_shape",
      "mailboxes_sync_blocked_reason_shape",
    ]);
    for (const set of growing) {
      for (const name of [set.constraint, set.was as string]) {
        expect(SQLITE_CHECKS.has(name),
          `${name}: a growing set and the device twin declares a CHECK for it — SQLite cannot `
          + "drop one, so this freezes a fifty-column rebuild into the first shipped baseline").toBe(false);
        expect(DEVICE_HISTORY.has(name), `${name}: a growing set and the device journal creates a CHECK for it`).toBe(false);
      }
    }
  });

  it("holds a set that grows to ONE shape on the server, which every member has and no mail server's value does", () => {
    for (const set of CLOSED_SETS.filter((s) => s.kind === "shape")) {
      expect(set.shape, set.constraint).toBe(GROWING_LIST_SHAPE);
      // The twin's CHECK is the shape, spelled as the entry spells it; the member list is gone from it.
      const want = shapeCheck(set.column).replace(/"/g, "").replace(/\s+/g, " ").trim();
      expect(PG_CHECKS.get(set.constraint), `${set.constraint}: the server twin's CHECK`).toBe(want);
      expect(PG_CHECKS.has(set.was as string), `${set.was} is still declared`).toBe(false);
      expect(membersOf(PG_CHECKS.get(set.constraint) as string), `${set.constraint} still spells members`).toBeNull();
      // Every member fits, or the server would refuse what the write door admits.
      for (const member of set.members) expect(hasGrowingListShape(member), `${set.constraint}: ${member}`).toBe(true);
    }
    // What the shape refuses is what a mail server could choose: an address, a sentence, a capital.
    for (const foreign of ["a@b.test", "Mailbox full", "over quota", "", "ünïcode", "x".repeat(49), "1st", ":lead"]) {
      expect(hasGrowingListShape(foreign), JSON.stringify(foreign)).toBe(false);
    }
    // And a word nobody has added yet fits: a new member alters no table.
    expect(hasGrowingListShape("a_reason_of_next_year")).toBe(true);
    expect(hasGrowingListShape("organized_elsewhere:watch")).toBe(true);
  });

  it("keeps an IMMUTABLE set on BOTH twins, spelled the same way", () => {
    const immutable = CLOSED_SETS.filter((s) => s.kind === "immutable");
    expect(immutable.map((s) => s.constraint).sort()).toEqual([
      // `junk_rescues_status_closed` (mail 0117) — the junk rescue's desired state, whose
      // two members are "outstanding" and "the server refused it"; a landed rescue deletes its row.
      "junk_rescues_status_closed",
      "mailboxes_organizer_role_closed", "mailboxes_organizer_state_closed",
      "mailboxes_takeover_intent_closed",
      // `message_search_source_closed` (mail 0125) — where a search document's words came from.
      "message_search_source_closed",
      // `messages_sender_check_by_closed` (mail 0149) — which writer gave the identity fact.
      "messages_sender_check_by_closed",
      // `messages_sender_check_closed` (mail 0148) — the identity fact about one message.
      "messages_sender_check_closed",
      // `routing_decisions_act_refusal_closed` — why the act on suggestions refused.
      "routing_decisions_act_refusal_closed",
    ]);
    for (const set of immutable) {
      expect(SQLITE_CHECKS.get(set.constraint),
        `${set.constraint} is immutable and the device twin dropped it`).toBeDefined();
      expect(SQLITE_CHECKS.get(set.constraint), `${set.constraint} drifted between the twins`)
        .toBe(PG_CHECKS.get(set.constraint));
      expect(DEVICE_HISTORY.get(set.constraint),
        `${set.constraint} is on the twin and no device migration creates it`).toBeDefined();
    }
  });

  it("has ONE source of truth for the members: the validator, the registry and the pg CHECK", () => {
    // THE THREE-HOMES TRAP. The members live in one constant; the validator narrows to it; the
    // server's CHECK spells them out. A member added to the constant and not to the CHECK is a
    // value the server refuses and this store accepts, which is the drift a device cannot repair.
    for (const set of CLOSED_SETS) {
      // A growing set's members stand in no CHECK (the case above holds its shape); an immutable
      // set's CHECK spells them out.
      if (set.kind === "immutable") {
        const declared = membersOf(PG_CHECKS.get(set.constraint) as string);
        expect(declared, `${set.constraint} does not render as an enumeration`).not.toBeNull();
        expect([...(declared as string[])].sort(), `${set.constraint}: the server twin's CHECK`)
          .toEqual([...set.members].sort());
      }

      // READ FROM THE VALIDATOR, behaviourally — a predicate that admits every member and refuses
      // a foreign string is the same set, however it is written.
      for (const member of set.members) {
        expect(set.isMember(member), `${set.constraint}: the validator refuses its own member ${member}`).toBe(true);
      }
      for (const foreign of ["phone", "", "organized_elsewhere:phone", "CAPTAIN"]) {
        if ((set.members as readonly string[]).includes(foreign)) continue;
        expect(set.isMember(foreign), `${set.constraint}: the validator admits ${JSON.stringify(foreign)}`).toBe(false);
      }
      expect(set.isMember(null)).toBe(false);
    }
  });

  it("refuses a foreign value at the write door, which is where a growing set's members are enforced", () => {
    for (const set of CLOSED_SETS.filter((s) => s.kind === "shape")) {
      // A word of the right shape that is no member: the server's CHECK would take it, the door does not.
      expect(() => closedSetValue(set.constraint, "a_reason_of_next_year"), set.constraint).toThrow(ClosedSetViolation);
      expect(() => closedSetValue(set.constraint, "not-a-member"), set.constraint)
        .toThrow(ClosedSetViolation);
      for (const member of set.members) {
        expect(closedSetValue(set.constraint, member), `${set.constraint} refuses its own member`)
          .toBe(member);
      }
      // NULL is the "nothing to say" every one of these columns holds, and it is not a violation.
      expect(set.nullable).toBe(true);
      expect(closedSetValue(set.constraint, null)).toBeNull();
    }
    // And a name nobody registered is a bug rather than a pass.
    expect(() => closedSetValue("mailboxes_no_such_constraint", "x")).toThrow(/not a closed set/);
  });

  it("coerces the kind at its derived write sites instead of storing the word it was handed", () => {
    // The two sites that cut the kind out of a stand-down reason: `organized_elsewhere:phone` is
    // the shape that used to reach the column, refused by the server's CHECK and — once the device
    // stops carrying one — stored on a phone. `phone` is the word that is NOT the kind.
    expect(organizerKindColumn("organized_elsewhere:phone".split(":")[1])).toBe("unknown");
    expect(organizerKindColumn(undefined)).toBe("unknown");
    expect(organizerKindColumn("mobile")).toBe("mobile");
    expect(organizerKindColumn("cloud")).toBe("cloud");
  });

  it("registers any closed set the DEVICE twin declares, so a new CHECK cannot arrive unclassified", () => {
    for (const [name, body] of SQLITE_CHECKS) {
      if (membersOf(body) === null) continue;   // a bound or a shape, not a set
      const set = REGISTERED.get(name);
      expect(set, `${name} closes a set on the device store and CLOSED_SETS does not know it`).toBeDefined();
      expect((set as { kind: string }).kind, `${name} is on the device store and is a set that grows`)
        .toBe("immutable");
    }
  });
});
