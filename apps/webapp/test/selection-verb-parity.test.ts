import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * WHAT A SELECTION CAN DO, AGAINST WHAT ONE ROW CAN DO — every verb the single row offers is
 * either OFFERED over a selection or EXCLUDED with its reason, so a verb added to either union is
 * RED here until somebody classifies it.
 *
 * Both unions are read from their own source, and the two ways a census like this says nothing
 * are covered: a union that parses to nothing (the first case asserts both populations) and a
 * classification key nobody can reach (the last two read the map the other way).
 */

/* Both unions are declared in the behaviour's own file since the Ohbox's lift; the pane imports them. */
const DECLARED = join(__dirname, "..", "..", "..", "packages", "app-logic", "src", "press", "actions.ts");

/** The members of a string-literal union, in declaration order. */
function unionMembers(name: string): string[] {
  const src = withoutComments(readFileSync(DECLARED, "utf8"));
  const from = src.indexOf(`export type ${name} =`);
  expect(from, `${name} is not declared in packages/app-logic/src/press/actions.ts`).toBeGreaterThan(-1);
  const to = src.indexOf(";", from);
  const body = src.slice(from, to);
  return [...body.matchAll(/"([^"]+)"|`([^`]+)`/g)].map((m) => m[1] ?? m[2]!);
}

/**
 * Every `MessageAction`, and what the SELECTION does with it. A `BulkAction` member is the verb
 * the selection dispatches; `null` is an exclusion and the string beside it is why.
 *
 * The exclusions are all one shape — a verb that cannot be expressed per-message over a set —
 * which is the ruling this census is written from. Two of them say it differently: an answer
 * needs one composer per message, and a restore is dispatched from the Trash reading pane, which
 * has no selection to be over.
 */
const OVER_A_SELECTION: ReadonlyMap<string, { bulk: string | null; why: string }> = new Map([
  ["restore", { bulk: null, why: "Trash's own primary verb; the selection is the Ohbox's" }],
  ["reply", { bulk: null, why: "one composer per message — a set has no single answer" }],
  ["reply_all", { bulk: null, why: "one composer per message" }],
  ["forward", { bulk: null, why: "one composer per message" }],
  ["draft", { bulk: null, why: "opens a draft; there is one draft, not one per picked row" }],
  ["later", { bulk: "later", why: "" }],
  ["aside", { bulk: "aside", why: "" }],
  ["resurface", { bulk: "resurface", why: "" }],
  // The dated form asks WHEN with a strip per press. Over a set the bar commits the picker's
  // first dated preset at the account's own hour — the same default the single verb starts from
  // — rather than putting a question between the press and forty rows.
  ["resurface:${string}", { bulk: "resurface", why: "" }],
  ["resurface_now", { bulk: "resurface", why: "" }],
  ["resurface_done", { bulk: "done", why: "" }],
  ["unread", { bulk: "unread", why: "" }],
  ["delete", { bulk: "delete", why: "" }],
  ["move:${MoveTarget}", { bulk: "move:${MoveTarget}", why: "" }],
]);

/**
 * `BulkAction` members that answer no `MessageAction`, with their reason. `read` is the switch's
 * other direction, which a row expresses by its read state rather than by a verb name.
 */
const SELECTION_ONLY: ReadonlyMap<string, string> = new Map([
  ["read", "the read switch's other direction; a row states it, it is not a row verb"],
  ["done", "the conversation's release, answered by `resurface_done` on a single message"],
]);

describe("the selection offers the row's verbs, minus the ones a set cannot express", () => {
  it("both unions parse, and to the members they are declared with", () => {
    // A census over an empty population reports no offenders for the wrong reason.
    const rowVerbs = unionMembers("MessageAction");
    const bulkVerbs = unionMembers("BulkAction");
    expect(rowVerbs.length).toBeGreaterThan(10);
    expect(bulkVerbs.length).toBeGreaterThan(5);
    for (const v of ["reply", "delete", "move:${MoveTarget}"]) expect(rowVerbs).toContain(v);
    for (const v of ["read", "unread", "delete"]) expect(bulkVerbs).toContain(v);
  });

  it("every verb a row offers is classified, and every classified verb still exists", () => {
    const rowVerbs = unionMembers("MessageAction");
    // Forwards: a new `MessageAction` is RED here until somebody says what a selection does with
    // it — which is the whole mechanism, not a cost of it.
    expect(rowVerbs.filter((v) => !OVER_A_SELECTION.has(v))).toEqual([]);
    // …and backwards, because a map key nobody can reach covers nothing: a verb renamed out of
    // the union would otherwise leave a classification standing for a verb that is gone.
    expect([...OVER_A_SELECTION.keys()].filter((k) => !rowVerbs.includes(k))).toEqual([]);
  });

  it("every verb the selection dispatches is one the bulk union declares", () => {
    const bulkVerbs = new Set(unionMembers("BulkAction"));
    const named = [...OVER_A_SELECTION.values()]
      .map((v) => v.bulk)
      .filter((b): b is string => b !== null);
    expect([...new Set(named)].filter((b) => !bulkVerbs.has(b))).toEqual([]);
  });

  it("every bulk verb answers a row verb, or is named as the selection's own", () => {
    const bulkVerbs = unionMembers("BulkAction");
    const answered = new Set(
      [...OVER_A_SELECTION.values()].map((v) => v.bulk).filter((b): b is string => b !== null),
    );
    expect(bulkVerbs.filter((b) => !answered.has(b) && !SELECTION_ONLY.has(b))).toEqual([]);
    expect([...SELECTION_ONLY.keys()].filter((k) => !bulkVerbs.includes(k))).toEqual([]);
  });

  it("an exclusion carries a reason, and an offer does not carry one instead", () => {
    // The two halves of the map are different statements and a row that is both is a row nobody
    // has read: an excluded verb with no reason is a verb quietly dropped.
    for (const [verb, { bulk, why }] of OVER_A_SELECTION) {
      if (bulk === null) expect(why.length, `${verb} is excluded with no reason`).toBeGreaterThan(10);
      else expect(why, `${verb} is offered AND carries an exclusion reason`).toBe("");
    }
  });
});
