import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { mailSchema } from "@trafficflow/db/mail";
import { carryDialect } from "@trafficflow/db/dialect";

/**
 * The database-handle registry — an interface, so a deployment can add its own member. A local
 * install migrates the mail journal alone and hands the builder `mailSchema`; a hosted deployment
 * has more tables and handle kinds. This file names ONLY the local member: the hosted members
 * AUGMENT `DbRegistry` from a private module, so a program built without it sees exactly the
 * truth about itself. A union would name the hosted schema here — erased, but still a private
 * module named in source a public checkout cannot resolve. One type covers every service because
 * nothing uses the relational API: every service goes through `db.select().from(table)`, where
 * the table carries its own type.
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
   * Whose credential did this request actually resolve? Called by the auth seams that mint or
   * rotate a session (`establish`, `mintRotation`) with the account the presented credential
   * belongs to, ONLY on their success paths. It exists because the sign-in and token routes
   * answer for an account the request's own session does not name — a browser with no session
   * refreshes a token, and the response belongs to that token's account. The API layer wires this
   * to the response's account header so the header names the body's subject rather than the
   * ambient session (`ACCOUNT_HEADER`, `packages/api/src/app.ts`). Optional and ignored by every
   * other caller.
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
 * Run `fn` in a transaction, and release its credential report only on COMMIT. The single
 * implementation, on purpose: there were two — one on `SessionLifecycle`, one private to
 * `pairing.ts` — and only the first buffered {@link ServiceContext.noteCredentialAccount}, so a
 * paired-device mint that rolled back still labelled the response with the account it had failed
 * to create. Two copies of a rule is one copy of the rule and one copy of the bug. The buffering:
 * the `txCtx` handed to `fn` reports into a local slot, forwarded only after `transaction()`
 * resolves; a rollback, a throw, or a swallowed commit failure discards it, and the response
 * names nobody. Nesting composes; reporting outside any transaction goes straight through.
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
