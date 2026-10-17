import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ── EVERY WRITER OF `alert_state`, COUNTED ───────────────────────────────────────────────
 *
 * The invariant is one sentence: **no pass may write, delete or claim over a row that a newer
 * pass has stamped.** It was first implemented as a `setWhere` on the observation upsert, which
 * is one of four places this file touches the table — and the other three each turned into a
 * defect a review had to find:
 *
 *   · the resolution DELETE was unconditional, so an older pass erased a newer observation and
 *     the notification beside it, and the next pass re-paged the same condition;
 *   · the CLAIM read the newer `last_seen_at` under its own lock and ignored it, so an older
 *     pass delivered its stale text while the newer pass, seeing the lease, stayed silent;
 *   · the SETTLE is fenced on the LEASE instead, deliberately — see below.
 *
 * A guard that counts the writers is the only kind that survives the next one being added. This
 * is a source census, like the taintable-column census in the admin suite: if the number moves,
 * somebody has to come here and say which writer appeared and what fences it.
 */
const RAW = readFileSync(
  fileURLToPath(new URL("../src/alerts.ts", import.meta.url)),
  "utf8",
);

/**
 * THE CENSUS READS CODE, NOT PROSE, and the first version of it did neither reliably.
 *
 * Slicing a statement to its next `;` broke immediately: this file's comments are long and one
 * of them contains a semicolon, so the observation upsert's slice ended mid-sentence and its
 * fence looked absent. Stripping comments first fixes that AND closes a hole worth naming — a
 * fence mentioned in a comment must never satisfy a guard that a fence exists.
 */
const SRC = RAW
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

/** Every `.insert(alertState)` / `.update(alertState)` / `.delete(alertState)` in the file. */
function writeSites(): { op: string; at: number }[] {
  const out: { op: string; at: number }[] = [];
  const re = /\.(insert|update|delete)\(alertState\)/g;
  for (let m = re.exec(SRC); m !== null; m = re.exec(SRC)) out.push({ op: m[1]!, at: m.index });
  return out;
}

/** The text of one write statement — up to its terminating `;`. */
const statementAt = (at: number): string => SRC.slice(at, SRC.indexOf(";", at) + 1);

describe("the alert-row fence covers every writer of the table", () => {
  it("there are exactly NINE writers — a tenth has to be reviewed, not merged", () => {
    const sites = writeSites();
    expect(
      sites.map((s) => s.op).sort(),
      "insert (observe), update (claim), update (settle), update (resolve), update (claim a " +
      "resolution notice), update (settle it), and the mail policy's three: insert (make a " +
      "policy row, ON CONFLICT DO NOTHING), update (lease it), update (settle it). There is no " +
      "DELETE: the row a prune deleted is the one the observation write's insert branch fences " +
      "against. A new writer means a new way to write this row backwards — fence it and add it here.",
    ).toEqual(["insert", "insert", "update", "update", "update", "update", "update", "update", "update"]);
  });

  it("FOUR carry the stamp fence — observe, claim, resolve, claim a resolution notice", () => {
    const fenced = writeSites().filter((s) => statementAt(s.at).includes("notWrittenByANewerPass"));
    expect(fenced.map((s) => s.op).sort()).toEqual(["insert", "update", "update", "update"]);
  });

  it("the THREE SETTLES are fenced on the LEASE, which is a different question", () => {
    // Not an exemption anybody may widen. The settle records what THIS pass did — it delivered —
    // and the lease is exactly "am I still the pass that owns this delivery". Fencing it on the
    // stamp was tried and reverted: the other arm observes the same live condition during
    // delivery and advances the stamp correctly, the settle would be refused, `notified_at` would
    // stay null, and the next pass would page for what was just paged. The third is the mail
    // policy row's settle, on the same argument.
    const unfenced = writeSites()
      .filter((s) => !statementAt(s.at).includes("notWrittenByANewerPass"));
    const settles = unfenced.filter((s) => statementAt(s.at).includes("claimedUntil, leaseUntil"));
    expect(settles).toHaveLength(3);
  });

  it("the policy row's other two writers are keyed on alert_key and its lease, never on the stamp", () => {
    // A policy row is born resolved at the epoch and no observation ever touches it, so the
    // stamp fence has nothing to say about it. Its insert must not move an existing window (DO
    // NOTHING on the key), and its lease is taken under the row lock only over an expired one.
    const unfenced = writeSites()
      .filter((s) => !statementAt(s.at).includes("notWrittenByANewerPass"))
      .filter((s) => !statementAt(s.at).includes("claimedUntil, leaseUntil"));
    expect(unfenced.map((s) => s.op).sort()).toEqual(["insert", "update"]);
    const insert = statementAt(unfenced.find((s) => s.op === "insert")!.at);
    expect(insert).toContain("onConflictDoNothing({ target: alertState.alertKey })");
    expect(insert).toContain("kind: MAIL_POLICY_ROW_KIND");
    expect(insert).toContain("resolvedAt: EPOCH");
    const lease = statementAt(unfenced.find((s) => s.op === "update")!.at);
    expect(lease).toContain("eq(alertState.kind, MAIL_POLICY_ROW_KIND)");
    expect(lease).toContain("lte(alertState.claimedUntil, now)");
  });

  it("last_seen_at is written by the OBSERVATION alone — it IS the last confirmation", () => {
    // Every close decision reads it as "when an evaluation last confirmed this row" and the
    // console publishes it as `lastConfirmedAt`. A second writer would make that a lie.
    const writers = writeSites().filter((s) => /\blastSeenAt\s*:/.test(statementAt(s.at)));
    expect(writers.map((s) => s.op)).toEqual(["insert"]);
  });

  it("and NOTHING deletes from this table — the fence's ground is unconditional", () => {
    // Two bounds on tombstone growth were tried and both reintroduced the resurrection: a count
    // deletes the oldest row, which is the one a stalled pass needs, and an age horizon rested
    // on a claim lease that is acquired AFTER the observation write and therefore bounds nothing.
    // Growth is bounded instead by distinct keys, because `alert_key` is the primary key.
    expect(writeSites().map((s) => s.op)).not.toContain("delete");
  });
});

/**
 * THREE FILES CARRIED THE SAME STALE SENTENCE, and they were corrected one review apart: the
 * schema header and the grant list first, the hardening SQL only after a later round found it.
 * That is this lane's own rule stated as a defect — fix the path you are looking at AND the one
 * beside it — so the claim is now checked in every file that makes it.
 */
const CONTRACTS: readonly [string, string][] = [
  ["../src/schema-cloud.ts", "the schema header"],
  ["../src/staff-grants.ts", "the grant list"],
  ["../../../scripts/harden-staff-role.sql", "the hardening script"],
];

describe("no file still says resolution deletes the row", () => {
  for (const [rel, what] of CONTRACTS) {
    it(`${what} describes an UPDATE, not a DELETE`, () => {
      const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      for (const claim of [
        "resolves an alert by deleting",
        "row is DELETED when the condition clears",
        "deleting its row",
      ]) {
        expect(text, `${what} still claims: "${claim}"`).not.toContain(claim);
      }
    });
  }

  it("and the hardening script names the prune as DELETE's user", () => {
    // The positive half: without it the cases above are satisfied by deleting the explanation,
    // which would leave an operator with no failure model for a verb the role still holds.
    const text = readFileSync(
      fileURLToPath(new URL("../../../scripts/harden-staff-role.sql", import.meta.url)), "utf8");
    expect(text).toContain("RESOLUTION MARKS, IT DOES NOT DELETE");
  });
});

/**
 * AND THE CENSUS REACHES THE OTHER PACKAGE, because "one accessor" is a claim about the whole
 * program and was being checked in one file. `packages/services` had an unused `alertState`
 * import — harmless in itself, and exactly the shape of a file about to grow its own select of
 * the table, in a place nothing was watching.
 */
const SERVICES = readFileSync(
  fileURLToPath(new URL("../../services/src/admin-service.ts", import.meta.url)),
  "utf8",
);

describe("the blind role can no longer delete from this table", () => {
  // THE VERB IS THE FENCE'S LAST EXPOSURE. Nothing in this bundle deletes from `alert_state` —
  // resolution marks and the prune is gone — but a granted capability nobody uses is one an OLD
  // BUNDLE can use: cloud 0030 explicitly permits a pre-0030 driver to keep running through a
  // rolling deploy, and that driver's resolution path is a DELETE over this same role. It would
  // remove the row a delayed new-build observation fences on, which then takes the unfenced
  // INSERT branch and pages a resolved incident.
  const GRANTS = readFileSync(
    fileURLToPath(new URL("../src/staff-grants.ts", import.meta.url)), "utf8");
  const HARDEN = readFileSync(
    fileURLToPath(new URL("../../../scripts/harden-staff-role.sql", import.meta.url)), "utf8");

  it("STAFF_TABLE_GRANTS gives alert_state no table-wide verb", () => {
    const block = GRANTS.slice(GRANTS.indexOf("STAFF_TABLE_GRANTS"));
    const entry = block.slice(0, block.indexOf("STAFF_SCHEMA_GRANTS"));
    expect(entry).not.toMatch(/"public\.alert_state":\s*\[[^\]]*DELETE/);
  });

  it("and the hardening script does not grant it", () => {
    expect(HARDEN).not.toContain("GRANT DELETE ON public.alert_state");
  });

  it("but the script still REVOKES everything first — the absence must be enforced, not implied", () => {
    // The positive half. Removing the grant line while removing the revoke would leave whatever
    // the role happened to hold already, which is exactly the state this file exists to refuse.
    expect(HARDEN).toContain("REVOKE ALL ON public.alert_state FROM ohmail_admin;");
  });
});

describe("no other package reaches the table directly", () => {
  it("admin-service neither reads nor writes alert_state", () => {
    expect(SERVICES, "it goes through listOpenAlerts").not.toContain(".from(alertState)");
    for (const op of ["insert", "update", "delete"]) {
      expect(SERVICES).not.toContain(`.${op}(alertState)`);
    }
  });

  it("and does not even import the table — an unused import is a select waiting to happen", () => {
    expect(SERVICES).not.toMatch(/^\s*alertState,$/m);
  });
});

describe("every reader of open alerts goes through one accessor", () => {
  it("no select of alert_state exists outside its four accessors", () => {
    // The tombstone gave every reader a shared way to be wrong: a select that forgets
    // `resolved_at IS NULL` renders fixed history as live incidents, which is worse than the
    // resurrection the column was added to prevent. Four accessors, each with its predicate
    // asserted below, are the only selects, and this census keeps a fifth from appearing quietly.
    // The fourth reads the other side on purpose: each key's latest episode, once resolved.
    const selects: number[] = [];
    const re = /\.from\(alertState\)/g;
    for (let m = re.exec(SRC); m !== null; m = re.exec(SRC)) selects.push(m.index);
    expect(selects, "exactly four `.from(alertState)` in the file").toHaveLength(4);
    const inside = (name: string, at: number): boolean => {
      const start = SRC.indexOf(`export function ${name}`);
      return start >= 0 && at > start && at < SRC.indexOf("\n}", start);
    };
    for (const at of selects) {
      expect(["selectOpenAlerts", "selectMailPolicyRow", "selectDigestRows", "selectLatestResolvedAlerts"]
        .some((n) => inside(n, at)), "every select is inside an accessor").toBe(true);
    }
  });

  it("the accessor applies resolved_at IS NULL", () => {
    const accessor = SRC.slice(
      SRC.indexOf("export function selectOpenAlerts"),
      SRC.indexOf("\n}", SRC.indexOf("export function selectOpenAlerts")),
    );
    expect(accessor).toContain("isNull(alertState.resolvedAt)");
  });

  const body = (name: string): string => SRC.slice(
    SRC.indexOf(`export function ${name}`), SRC.indexOf("\n}", SRC.indexOf(`export function ${name}`)));

  it("the policy-row accessor reads one key AND the policy kind — never an alert's row", () => {
    expect(body("selectMailPolicyRow")).toContain(
      "and(eq(alertState.alertKey, key), eq(alertState.kind, MAIL_POLICY_ROW_KIND))");
  });

  it("the digest accessor reads incidents only, inside its window", () => {
    const text = body("selectDigestRows");
    expect(text).toContain(`eq(alertState.cls, "incident")`);
    expect(text).toContain("${touched} > ${since.toISOString()}::timestamptz");
  });

  it("the latest-resolved accessor reads resolved rows inside its window, never a policy row", () => {
    const text = body("selectLatestResolvedAlerts");
    expect(text).toContain("isNotNull(alertState.resolvedAt)");
    expect(text).toContain("ne(alertState.kind, MAIL_POLICY_ROW_KIND)");
    expect(text).toContain("gte(alertState.resolvedAt, from)");
    expect(text).toContain("lt(alertState.resolvedAt, to)");
  });
});
