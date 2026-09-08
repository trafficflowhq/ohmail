import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { mailSchema } from "@trafficflow/db/mail";
import { carryDialect } from "@trafficflow/db/dialect";

/**
 * THE DATABASE-HANDLE REGISTRY — an interface, so a deployment can add its own member.
 *
 * Every service takes its handle as {@link Db}, and what a `Db` may be differs by deployment. A
 * local install migrates the mail journal alone and hands the query builder `mailSchema` — the
 * mail tables, no identity ceremony, no ledger, no operator surface. A hosted deployment has more
 * tables and more kinds of handle: a pooled per-request connection in production, an in-process
 * one in its tests.
 *
 * This file names ONLY the local member, and that is the point of it being an interface rather
 * than a union. The hosted members are declared in a private module beside this one, which
 * AUGMENTS `DbRegistry` with them; a program that includes that module sees the full set, and a
 * program built without it sees exactly the truth about itself. A union would have had to name
 * every member here — which means naming the hosted schema. That reference is type-only and
 * therefore erased from the emitted JavaScript, and it is still a private module named in source
 * that a public checkout could not resolve. The previous comment here argued the erasure made it
 * safe; erasure answers the bundling question and says nothing about the source.
 *
 * The alternative considered and rejected was widening the hosted members to an anonymous record
 * type. That publishes a claim weaker than the truth, and its assignability rests on internals of
 * the query builder that nobody here has proven — with 29 call sites and two applications in
 * which to find out. Augmentation fails in the loud direction instead: a program missing the
 * private module gets "property does not exist" at compile time, never a wrong answer at run time.
 *
 * ── WHY ONE TYPE COVERS EVERY SERVICE RATHER THAN EACH BEING GENERIC ──────────────────────
 *
 * The schema type parameter drives the query builder's RELATIONAL API (`db.query.<table>`), which
 * nothing in this repository uses: every service goes through `db.select().from(table)`, where the
 * table object carries its own type. So the parameter describes what a handle COULD offer, not
 * what any caller asks of it, and one type suffices for all of them.
 */
export interface DbRegistry {
  /** The mail journal alone — what a local install migrates, and all it can offer. */
  mail: PgliteDatabase<typeof mailSchema>;
}

/** The database handle services run against: whichever members this program's registry declares. */
export type Db = DbRegistry[keyof DbRegistry];

/**
 * Per-request seam handed to every service method. `accountId`/`userId` are
 * derived from the session or bearer token by the handler — NEVER from the
 * request body. `now` is an injectable clock for deterministic tests.
 */
export interface ServiceContext {
  db: Db;
  accountId: string;
  userId: string | null;
  now: () => Date;
  requestId: string;
  /** Present on session-scoped requests: the caller's own session id,
   *  used for step-up window checks and "current device" marking. */
  sessionId?: string | null;
  /**
   * **WHOSE CREDENTIAL DID THIS REQUEST ACTUALLY RESOLVE?** Called by the auth seams that mint or
   * rotate a session (`establish`, `mintRotation`) with the account the presented credential
   * belongs to, and ONLY on their success paths.
   *
   * It exists because the sign-in and token routes answer for an account that the request's own
   * session does not name — a browser with no session at all refreshes a token, and the response
   * belongs to that token's account. The API layer wires this to the response's account header so
   * the header can name the body's subject rather than the ambient session; see `ACCOUNT_HEADER`
   * in `packages/api/src/app.ts`.
   *
   * Optional and ignored by every other caller: the worker, the sidecar and the test harnesses
   * construct a context without it, and a service that never mints a session never calls it.
   */
  noteCredentialAccount?: (accountId: string) => void;
  /** Client network metadata, threaded for auth audit and lockout. */
  ip?: string;
  userAgent?: string;
  /**
   * The request's raw `Origin` header, threaded for multi-origin WebAuthn.
   * A ceremony is admitted only from an allow-listed origin and is then bound to
   * it; ABSENT (native clients, which send no `Origin`) means "the deployment's
   * default origin". Never trusted for identity — only for origin binding.
   */
  origin?: string;
}

/**
 * **RUN `fn` IN A TRANSACTION, AND RELEASE ITS CREDENTIAL REPORT ONLY ON COMMIT.**
 *
 * The single implementation, and it is single on purpose. There were two — one on
 * `SessionLifecycle`, one private to `pairing.ts` — and only the first was taught to buffer
 * {@link ServiceContext.noteCredentialAccount}. Paired-device redemption therefore went on
 * reporting before its transaction committed, so a mint that rolled back still labelled the
 * response with the account it had failed to create. Two copies of a rule is one copy of the rule
 * and one copy of the bug.
 *
 * The buffering itself: the `txCtx` handed to `fn` reports into a local slot, and the slot is
 * forwarded to the real context only after `transaction()` resolves. A rollback, a throw, or a
 * swallowed commit failure discards it, and the response then names nobody — which is what the
 * account header's contract claims. Nesting composes: an inner commit forwards into the outer's
 * slot, and an outer rollback discards that too.
 *
 * Reporting made OUTSIDE any transaction is unaffected and goes straight through.
 */
export async function runInTransaction<T>(
  ctx: ServiceContext, fn: (txCtx: ServiceContext) => Promise<T>,
): Promise<T> {
  let pending: string | null = null;
  const tx = ctx.db as unknown as { transaction: <R>(f: (t: unknown) => Promise<R>) => Promise<R> };
  const result = await tx.transaction(async (handle) => fn({
    ...ctx,
    db: carryDialect(ctx.db, handle as object) as unknown as ServiceContext["db"],
    noteCredentialAccount: (accountId: string) => { pending = accountId; },
  }));
  if (pending !== null) ctx.noteCredentialAccount?.(pending);
  return result;
}
