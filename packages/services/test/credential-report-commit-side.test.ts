import { describe, it, expect } from "vitest";
import { bindDb } from "@trafficflow/db";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestDb } from "@trafficflow/db/testing";
import { SessionLifecycle, makeTestAuthDeps, type ServiceContext } from "@trafficflow/services";

/**
 * ═══ THE ACCOUNT REPORT IS COMMIT-SIDE ════════════════════════════════════════════════════════
 *
 * `ServiceContext.noteCredentialAccount` labels the response with the account a credential
 * resolved to, and the seams that call it (`establish`, `mintRotation`, `establishEnrollment`)
 * run inside transactions. Reporting straight through was a mutation of REQUEST state made before
 * the transaction that justified it had committed.
 *
 * That is not theoretical. The lost-rotation recovery arm wraps `mintRotation` in a transaction
 * and converts a failure to `null`, then answers an error — so a rolled-back mint left the
 * response carrying `X-Ohmail-Account` for a session that had just been rolled back. The header's
 * own comment claimed the opposite, which made the comment the false thing rather than the code.
 *
 * `inTransaction` now buffers a report made inside it and forwards it only after `transaction()`
 * resolves. This file tests that boundary DIRECTLY rather than through a route, because the
 * alternative is forcing a Postgres commit to fail — which no fixture here can do reliably, and a
 * test that cannot make the bad thing happen is not evidence. A throw inside the transaction body
 * IS the rollback, and it is the shape the recovery arm actually produces.
 */

/** The seam under test is `protected`; this exposes it without changing it. */
class Probe extends SessionLifecycle {
  async run<T>(ctx: ServiceContext, fn: (txCtx: ServiceContext) => Promise<T>): Promise<T> {
    return this.inTransaction(ctx, fn);
  }
}

describe("a report made inside a transaction is forwarded only on commit", () => {
  async function ctxWithSink(): Promise<{ ctx: ServiceContext; seen: string[]; probe: Probe }> {
    const db = await makeTestDb();
    const seen: string[] = [];
    // No account: the report's door runs before sign-in, bound to nothing.
    const ctx = {
      db: bindDb(db, { account: null }), accountId: "", userId: null, now: () => new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req-1",
      noteCredentialAccount: (id: string) => { seen.push(id); },
    } as unknown as ServiceContext;
    return { ctx, seen, probe: new Probe(makeTestAuthDeps()) };
  }

  it("COMMIT — the report reaches the request", async () => {
    const { ctx, seen, probe } = await ctxWithSink();
    const out = await probe.run(ctx, async (txCtx) => {
      txCtx.noteCredentialAccount?.("account-committed");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(seen, "a committed mint names its account").toEqual(["account-committed"]);
  });

  it("ROLLBACK — the report is discarded, and the response names nobody", async () => {
    const { ctx, seen, probe } = await ctxWithSink();
    // Reports, then throws: the transaction rolls back and the mint never happened.
    const verdict = await probe.run(ctx, async (txCtx) => {
      txCtx.noteCredentialAccount?.("account-rolled-back");
      throw new Error("commit failed");
    }).then(() => "resolved").catch(() => "rejected");

    // A one-word verdict rather than the rejection value: a `.rejects` assertion on something
    // holding a live PGlite handle pretty-prints a WASM heap and kills the worker.
    expect(verdict).toBe("rejected");
    expect(
      seen,
      "a rolled-back mint must name nobody — this is the claim the header's comment makes",
    ).toEqual([]);
  });

  it("NESTING — an inner commit does not escape an outer rollback", async () => {
    const { ctx, seen, probe } = await ctxWithSink();
    const verdict = await probe.run(ctx, async (outer) => {
      await probe.run(outer, async (inner) => {
        inner.noteCredentialAccount?.("account-inner");
        return "inner-ok";
      });
      throw new Error("outer commit failed");
    }).then(() => "resolved").catch(() => "rejected");

    expect(verdict).toBe("rejected");
    expect(
      seen,
      "the inner report forwards into the OUTER buffer, which the outer rollback discards",
    ).toEqual([]);
  });
});

/**
 * ═══ AND THE BUFFER MUST NOT BE BYPASSED AT THE CALL SITE ═════════════════════════════════════
 *
 * The buffering above is correct and was, for one commit, unreachable on the path it exists for.
 * `inTransaction` replaces `noteCredentialAccount` on the `txCtx` it hands the callback — so a
 * report only reaches the buffer if the code inside reports through THAT context. The recovery arm
 * called `this.mintRotation(ctx, tx, …)`: the transaction's `tx` for the writes, and the OUTER
 * `ctx` for the reporting. Every write rolled back; the report went straight through.
 *
 * The tests above passed the whole time, because they drive `inTransaction` with a callback that
 * uses its `txCtx`. They proved the mechanism and never touched the call site — which is the shape
 * this repository keeps paying for: a guard that is green because it is asking a different
 * question from the one that matters.
 *
 * So this is a SOURCE assertion, and it is about pairing rather than about behaviour: inside a
 * transaction, the context you report through must be the same one whose `db` you are writing to.
 * A behavioural test cannot reach it — staging the lost-rotation recovery arm needs a commit to
 * fail mid-sequence — and a mismatch is visible in one line of text.
 */
describe("a transactional mint reports through the transaction's own context", () => {
  it("no call site pairs the outer ctx with a transaction handle", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/auth/session-lifecycle.ts", import.meta.url)), "utf8",
    );

    // Anti-vacuity: the call must still exist, or this passes on a renamed function.
    const calls = src.match(/this\.mintRotation\(/g)?.length ?? 0;
    expect(calls, "mintRotation is gone — re-decide this assertion").toBeGreaterThanOrEqual(5);

    // EVERY call is classified, and an UNRECOGNISED pairing fails. Matching only the two literal
    // spellings `ctx` and `tx` checked the names rather than the relationship, so renaming either
    // variable would have made this census silently cover nothing. Now the allowed pairs are named
    // and anything else — a renamed context, a new handle, a third convention — is a failure that
    // has to be looked at rather than a gap that passes.
    const pairings = [...src.matchAll(/this\.mintRotation\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)/g)]
      .map((m) => `${m[1]},${m[2]}`);
    // EVERY call must PARSE, not merely five of them. Counting only the parsed ones let an
    // unparseable call — a line break after the paren, a spread, a comment between the arguments —
    // slip past classification entirely, which is the same hole as a window that is too narrow.
    const raw = src.match(/this\.mintRotation\(/g)?.length ?? 0;
    expect(pairings.length, "no call sites parsed — the matcher is broken").toBeGreaterThanOrEqual(5);
    expect(
      pairings.length,
      `${raw} \`mintRotation(\` call(s) exist but only ${pairings.length} parsed into a ` +
        "(context, handle) pair. An unparsed call is an unclassified one — widen the matcher " +
        "rather than letting it through.",
    ).toBe(raw);

    // `ctx` outside a transaction writes through the plain handle; `txCtx` inside one writes
    // through that transaction's handle. Those are the only two coherent pairings.
    const ALLOWED = new Set(["ctx,db", "txCtx,tx"]);
    const wrong = pairings.filter((c) => !ALLOWED.has(c));
    expect(
      wrong,
      "each `mintRotation` call must report through the context whose handle it writes to: " +
        "`(ctx, db)` outside a transaction, `(txCtx, tx)` inside one. `(ctx, tx)` reports through " +
        "the UNBUFFERED outer context while writing inside the transaction, so a rolled-back mint " +
        "still names its account; `(txCtx, db)` buffers a report nothing will forward. Any other " +
        "pairing is unclassified and must be judged, not assumed.",
    ).toEqual([]);
  });
});

/**
 * ═══ ONE BUFFERED WRAPPER, NOT TWO ════════════════════════════════════════════════════════════
 *
 * There were two transaction wrappers in this package — one on `SessionLifecycle`, one private to
 * `pairing.ts` — and only the first was taught to buffer. Paired-device redemption therefore
 * reported its account before its transaction committed, so a mint that rolled back still labelled
 * the response with an account it had failed to create. Two copies of a rule is one copy of the
 * rule and one copy of the bug.
 *
 * `runInTransaction` in `context.ts` is now the only implementation and both callers delegate to
 * it. This census keeps it that way: a third hand-rolled `.transaction(...)` that builds a derived
 * context is how the next unbuffered reporter arrives, and it would be invisible to every
 * behavioural test in this file.
 */
describe("the buffered transaction wrapper is singular", () => {
  it("no module hand-rolls a context-deriving transaction of its own", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const walk = (rel: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(new URL(rel, pathToFileURL(dir)), { withFileTypes: true })) {
        if (e.isDirectory()) out.push(...walk(`${rel}${e.name}/`));
        else if (e.name.endsWith(".ts")) out.push(`${rel}${e.name}`);
      }
      return out;
    };
    const files = walk("");
    expect(files.length, "the walker found nothing — it is broken").toBeGreaterThan(20);

    // ── WHAT IS COUNTED, AND WHY IT IS NOT A PROXIMITY MATCH ────────────────────────────────
    //
    // This looked for `.transaction(async (…) => …` followed by `...ctx` WITHIN 200 CHARACTERS,
    // and a 200-character window is a guess about how people write code. It missed
    // `mailbox-service.ts`, whose derived context sits far inside its
    // transaction — so the census asserted "no module hand-rolls one" while one existed. A window
    // that has to be wide enough is a window that will be too narrow again.
    //
    // The shape that matters is the DERIVATION itself: a context spread with the `db` swapped.
    // Wherever it appears, that object can be handed to something that reports, and if the
    // handle is a transaction's the report escapes the commit. So every derivation is found,
    // regardless of distance, and each must be either the shared implementation or explicitly
    // justified as unable to report. A new one is red until somebody writes down why.
    const DERIVES = /\.\.\.ctx\s*,\s*db:/;
    const MARKER = "NO-CREDENTIAL-REPORT";
    const derivations: string[] = [];
    const unjustified: string[] = [];
    for (const rel of files) {
      if (rel === "context.ts") continue;              // the one implementation
      const text = readFileSync(new URL(rel, pathToFileURL(dir)), "utf8");
      if (!DERIVES.test(text)) continue;
      derivations.push(rel);
      if (!text.includes(MARKER)) unjustified.push(rel);
    }

    // Anti-vacuity: the matcher must still find the one known derivation, or a rename has made
    // this census blind and it would pass by seeing nothing.
    expect(
      derivations,
      "the derivation matcher found nothing outside context.ts — it has gone blind",
    ).toContain("mailbox-service.ts");

    expect(
      unjustified,
      "this module derives a ServiceContext with a swapped `db` and does not say why that context " +
        `cannot report a credential account. Either use \`runInTransaction\`, or mark the site ` +
        `\`${MARKER}\` with the reason it can never reach \`noteCredentialAccount\`.`,
    ).toEqual([]);

    // Anti-vacuity: the one real implementation must still be there and still buffer.
    const shared = readFileSync(new URL("context.ts", pathToFileURL(dir)), "utf8");
    expect(shared).toContain("export async function runInTransaction");
    expect(shared, "the shared wrapper must actually buffer").toContain("pending = accountId");
  });
});
