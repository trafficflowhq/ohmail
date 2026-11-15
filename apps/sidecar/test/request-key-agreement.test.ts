import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { deriveRequestKey } from "@trafficflow/core/adapters/organizer-lease";
import { readSource } from "../../worker/test/_start-function.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE THREE DOORS MUST DERIVE THE SAME KEY, AND NOTHING TOLD THEM WHEN THEY DID NOT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A decision travelling between two installs is signed with a key neither of them is sent: each
 * derives it from the mailbox credential it already holds. That works exactly as long as all three
 * doors derive from the SAME secret, and there is no key-agreement check anywhere in the product —
 * a mismatch does not error, because HKDF over the wrong password is still a perfectly good key.
 *
 * **What it produces instead is the worst available failure.** Every record refuses as
 * `unauthenticated` — the same answer a forgery gets — so a person sees decisions time out
 * reporting that nobody took them while both installs are live and correct, and the log names an
 * attack. There is no signal anywhere that says "these two installs disagree about the key".
 *
 * So the agreement is asserted here instead, from ONE fixture, against the exact shapes the three
 * call sites pass.
 *
 * ── THE RULE, AND THE BUG IT REPLACES ───────────────────────────────────────────────────────
 *
 * DERIVE FROM THE CREDENTIAL YOU OPENED THIS MAILBOX WITH.
 *
 * The hosted worker held that by construction (`deriveRequestKey({ auth: creds.imap.auth, address:
 * mb.address })` — the per-mailbox credential it decrypted) and so did the single-mailbox cron (the
 * env credential it dials with). The sidecar did NOT: it derived from `config.imap.auth`, the
 * SEED's configured credential, for every mailbox it attached — while dialling #2..N from their own
 * stored credentials. So a local install with a second mailbox signed with one password and opened
 * the mailbox with another.
 */

const ADDRESS = "person@mailbox.example";
/** What the seed is configured with — and what the sidecar used to derive from, for everything. */
const SEED_PASSWORD = "the-seed-mailboxs-password";
/** What mailbox #2 is actually dialled with, out of its own stored credential row. */
const SECOND_PASSWORD = "a-completely-different-password";

describe("the request key agrees across the doors that share a mailbox", () => {
  /**
   * THE CASE THE BUG WAS. Two doors, one mailbox, one credential — the hosted side deriving from
   * the mailbox's own decrypted credential and the local side from what it dialled with.
   */
  it("the hosted and local derivations match when both use the mailbox's own credential", () => {
    const hosted = deriveRequestKey({
      auth: { user: ADDRESS, pass: SECOND_PASSWORD }, address: ADDRESS,
    });
    const local = deriveRequestKey({
      auth: { user: ADDRESS, pass: SECOND_PASSWORD }, address: ADDRESS,
    });
    expect(hosted).not.toBeNull();
    expect(local).toBe(hosted);
  });

  /**
   * AND THE DIVERGENCE IS SILENT, WHICH IS WHY THE RULE IS NEEDED. Deriving from a DIFFERENT
   * password does not fail — it produces a different, perfectly well-formed key. Nothing downstream
   * can tell that apart from a forgery.
   */
  it("deriving from the WRONG password yields a valid key that simply disagrees", () => {
    const dialled = deriveRequestKey({
      auth: { user: ADDRESS, pass: SECOND_PASSWORD }, address: ADDRESS,
    });
    const fromSeed = deriveRequestKey({
      auth: { user: ADDRESS, pass: SEED_PASSWORD }, address: ADDRESS,
    });

    expect(fromSeed).not.toBeNull();
    expect(fromSeed).toHaveLength(43);
    // No error, no null — just a different answer, indistinguishable downstream from an attack.
    expect(fromSeed).not.toBe(dialled);
  });

  /** The SALT is the mailbox address, so one credential across two mailboxes is two keys. */
  it("the address is the salt — the same password on two mailboxes derives two keys", () => {
    const a = deriveRequestKey({ auth: { user: ADDRESS, pass: SEED_PASSWORD }, address: ADDRESS });
    const b = deriveRequestKey({
      auth: { user: ADDRESS, pass: SEED_PASSWORD }, address: "other@mailbox.example",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBe(a);
  });

  /** An address differing only in case must not split the key — every door lower-cases the salt. */
  it("the salt is case-insensitive, so two doors spelling the address differently still agree", () => {
    const lower = deriveRequestKey({ auth: { user: ADDRESS, pass: SEED_PASSWORD }, address: ADDRESS });
    const upper = deriveRequestKey({
      auth: { user: ADDRESS, pass: SEED_PASSWORD }, address: ADDRESS.toUpperCase(),
    });
    expect(lower).toBe(upper);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  AND THE WIRING IS PINNED, BECAUSE THE VALUES AGREEING PROVES NOTHING ABOUT THE CALL SITES
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Every assertion above is about `deriveRequestKey` and would have passed while the bug was
   * live — the bug was never in the function, it was in WHICH credential the sidecar handed it.
   * There is no seam to inject at (the derivation happens inside `attachLocal`, beside a socket),
   * so the call site is asserted as source: the sidecar must derive from the auth it built the
   * adapter from, and must NOT derive from the process-wide config.
   *
   * MUTATION WATCHED RED: point the derivation back at `config.imap.auth` and this names the file.
   */
  it("the sidecar derives from the credential it dialled with, never from the process config", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/engine.ts", import.meta.url)),
      "utf8",
    );
    const calls = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => line.includes("deriveRequestKey("));

    expect(calls, "the sidecar derives the request key in exactly one place").toHaveLength(1);
    expect(
      calls[0],
      "the sidecar must derive from the auth it opened THIS mailbox with — `config.imap.auth` is "
      + "the seed's credential and is wrong for every other mailbox it attaches",
    ).toContain("auth: imapConfig.auth");
    /* NO BLANKET "config.imap.auth must not appear" — that assertion was written first and it is
     * FALSE. The seed's address, the seed's environment password and both reconnect paths all read
     * it legitimately; only the DERIVATION may not. The two assertions above say exactly that and
     * nothing more: one derivation site, and it takes the dialled auth. A guard that forbids a
     * correct use in order to catch an incorrect one is a guard the next person who needs the
     * correct use deletes. */
  });

  /** The hosted door's own call site, pinned for the same reason and against the same rule. */
  it("the worker derives from the per-mailbox credential it decrypted", () => {
    const src = readSource(
      fileURLToPath(new URL("../../worker/src/index.ts", import.meta.url)),
    );
    expect(src).toContain("deriveRequestKey({ auth: creds.imap.auth, address: mb.address })");
  });
});
