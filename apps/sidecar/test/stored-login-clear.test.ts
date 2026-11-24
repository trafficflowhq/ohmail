import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { readEngineAsOneText } from "../../../test/support/engine-unit.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE LOCAL DOOR'S CREDENTIAL CLEAR PROVES ITSELF — the desktop's sign-out rests on it
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `DELETE /local/stored-login` is the only way the mailbox password leaves this machine: it is
 * sealed inside the mirror's database, only the engine can reach it, and the desktop shell
 * deliberately leaves both the mirror and this install's key in place. So the shell's whole
 * sign-out — including its refusal arms, which stop and report on a non-2xx AND on an engine
 * that could not be reached — is exactly as good as this endpoint's 200. Those two arms are
 * why the throw below is enough: it reaches the shell as a bridge error rather than as a status
 * line (see the case that says so), and the shell refuses either way.
 *
 * It issued the DELETE, logged `stored_login_cleared` and answered 200 without ever asking
 * whether the row was gone, so a delete that removed nothing read identically from outside to
 * one that worked — and the shell, seeing the 2xx, stopped the engine and removed `config.json`
 * with its own refusal arm never reached.
 *
 * ── AND WHAT THIS FILE DOES NOT PROVE ─────────────────────────────────────────────────────
 *
 * These cases pin the statement ORDER inside one transaction. They cannot see a credential
 * writer that WAITS on the locked row and commits after this transaction does — that is the
 * durable `signed_out_at` stamp's half, driven in `signed-out-stamp.test.ts`. Saying so here
 * rather than letting the word "fence" imply it: a guard that claims more than it checks is the
 * thing this whole slice is about.
 *
 * ── WHY THIS IS A SOURCE CENSUS ────────────────────────────────────────────────────────────
 *
 * `forgetStoredLogin` is a closure inside `startEngine`, reachable only by standing up a whole
 * local engine on a real PGlite directory — and the property is not a value it returns but the
 * SHAPE of its critical section: one transaction, a locking read, the delete, a read-back, and
 * a throw. That is a structural fact, which is what this repository uses a census for
 * (`privacy.test.ts` and the release-minification census are the same instrument). What a
 * census cannot claim is that PGlite's `SELECT … FOR UPDATE` serializes a competing writer the
 * way Postgres does; what it does claim is that the code asks for it, and that the answer is
 * READ rather than assumed.
 */

const SRC = readEngineAsOneText();
/**
 * Comments explain the very shapes this forbids, so the negative checks read code only — and
 * through the repo's one scanner, never a pair of regexes. `engine.ts` quotes folder globs in
 * line comments, and a block-first pair reads such a quoted OPENER as real, deleting every line
 * from there to the next terminator. A negative asked about an extract that is not there passes
 * for nothing, and nothing says so.
 */
const CODE = withoutComments(SRC);

/** From a declaration to the next four-space close (the end of the runtime's attach), as before. */
function bodyOf(decl: string, name: string): string {
  const from = CODE.indexOf(decl);
  expect(from, `${name} must exist`).toBeGreaterThan(-1);
  const to = CODE.indexOf("\n    };", from);
  expect(to).toBeGreaterThan(from);
  return CODE.slice(from, to);
}
/** Where the clear's transaction lives: the purge the sign-out's forget and a refused press share. */
const body = (): string => bodyOf(
  "const purgeCredential = async (opts?: { keepCoordinates?: boolean }): Promise<boolean> => {", "purgeCredential",
);
/** The sign-out's forget itself, which writes the receipt. */
const forget = (): string => bodyOf(
  "const forgetStoredLogin = async (opts?: { keepCoordinates?: boolean }): Promise<boolean> => {", "forgetStoredLogin",
);

describe("the stored-login clear reads back inside its own transaction", () => {
  it("deletes and re-reads in ONE transaction, and throws if the row survived", () => {
    const fn = body();
    expect(fn, "the critical section must be a transaction").toMatch(/await db\.transaction\(/);
    // The order is the property — and it is the ONLY property here: see the header for the
    // interleaving this cannot see.
    /* THE SEAM'S CALL, not the builder's clause. The spelling moved when this engine learned to
       run on a second store — the device store's query builder has no `for`, so `.for("update")`
       there is `base.for is not a function` rather than a lock that quietly did nothing — and the
       PROPERTY this case is about, the order of the four steps, did not move at all. Both
       spellings are accepted so the census reads the intent rather than one release's syntax. */
    const lock = Math.max(fn.indexOf("forUpdate("), fn.indexOf('.for("update")'));
    const del = fn.indexOf("tx.delete(mailboxCredentials)");
    const back = fn.indexOf("const after = ");
    const judge = fn.indexOf("after.length > 0");
    expect(lock, "a locking read must serialize a competing credential write").toBeGreaterThan(-1);
    expect(del, "…before the delete").toBeGreaterThan(lock);
    expect(back, "…and the row is read back after it").toBeGreaterThan(del);
    expect(judge, "…and that read is what decides").toBeGreaterThan(back);
    expect(fn).toMatch(/throw new ServiceError\(\s*\n?\s*"stored_login_not_cleared"/);
    // ── AND WHAT THE SHELL ACTUALLY RECEIVES, which is not what "500" suggests ────────────
    //
    // This endpoint is a desktop-only pre-route and does NOT pass through the API's error
    // serializer, so the throw never becomes an HTTP 500 on the wire: `serveOverStdio` catches
    // it and writes a bridge error frame, and the Rust side sees `Engine::request` return `Err`.
    // That still refuses the sign-out — the local door treats an unreachable-or-errored engine
    // exactly as it treats a 5xx, deliberately, since both leave the same credential — but
    // asserting "the client receives 500" would be asserting a wire behaviour that does not
    // exist. The status is kept because it is the right code IF this is ever routed through the
    // serializer; what is claimed here is the throw, not the status line.
    expect(fn).toMatch(/"stored_login_not_cleared", 500/);
  });

  it("the delete is never issued outside that transaction", () => {
    const fn = body();
    // `db.delete(...)` — the ambient handle — would autocommit beside the read-back and defeat
    // both halves at once: nothing to fence a racing writer, and a proof about a different
    // transaction's view.
    expect(fn, "the delete must run on the transaction handle").not.toMatch(/\bdb\.delete\(mailboxCredentials\)/);
    expect(fn).toMatch(/\btx\.delete\(mailboxCredentials\)/);
  });

  it("the log line claims the read-back, so the record and the code say the same thing", () => {
    // Comments and log lines here are assertions. `stored_login_cleared` is what an operator
    // reads when somebody says they signed out and the password was still there.
    expect(SRC).toMatch(/read back as\s*\n?\s*"?\s*\+?\s*"?absent/);
    expect(forget()).toMatch(/log\("stored_login_cleared"/);
    expect(forget(), "the receipt follows the purge that proves the row gone").toMatch(/await purgeCredential\(opts\)/);
  });
});
