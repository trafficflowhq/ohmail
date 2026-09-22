import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { mailSchema } from "@trafficflow/db/mail";
import { carryDialect, type LockMode } from "@trafficflow/db/dialect";
import { claimIdempotencyKey, fencedAccountWrite, type LedgerTx, type Tx } from "@trafficflow/db";
import { asServiceRefusal } from "./erasure-fence.js";
import { IdempotencyRaceLost } from "./errors.js";

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
 * THE ONE DIALECT BRIDGE (review 020, BACKEND L4). Services are written against the pg builder
 * types while the handle behind `Db` may be PGlite, hosted Postgres or the phone's sqlite-proxy;
 * `carryDialect` keeps the runtime honest and these two carry the type assertion — once, here,
 * instead of 118 hand-spelled `as unknown as` casts. The census
 * (`dialect-bridge-census.test.ts`) pins the raw cast count outside this file at zero, so a new
 * dialect crossing is a call to a named function, never a fresh assertion.
 */
export function bridgeTx(handle: Db | Tx | LedgerTx): Tx {
  return handle as unknown as Tx;
}

/** The other direction: a transaction handle asked the query surface `Db` types. */
export function bridgeDb(handle: Db | Tx | LedgerTx): Db {
  return handle as unknown as Db;
}

/** The caller's `Idempotency-Key` and the hash of the request it was presented with. */
export interface IdempotencyClaim {
  key: string;
  requestHash: string;
}

/**
 * CLAIM THE KEY INSIDE THE MUTATION'S OWN TRANSACTION, or roll the mutation back.
 *
 * One reader for what was six copies. The order is the whole of it: the stored response commits
 * with the effect, so a crash between them is impossible and a retry replays instead of running
 * the mutation twice. A LOST claim means a concurrent same-key request committed first —
 * throwing rolls THIS transaction back in full, and `withIdempotency` answers with the winner's
 * stored response. `response` must be the body the route will return, materialized inside `tx`,
 * or the replay and the first answer disagree.
 */
export async function claimOrLose(
  tx: LedgerTx,
  ctx: { accountId: string; now: () => Date },
  claim: IdempotencyClaim | null | undefined,
  response: { status: number; json: unknown; seq?: number | null },
): Promise<void> {
  if (!claim) return;
  const claimed = await claimIdempotencyKey(tx, {
    accountId: ctx.accountId,
    key: claim.key,
    requestHash: claim.requestHash,
    responseStatus: response.status,
    responseJson: response.json,
    seq: response.seq ?? null,
    now: ctx.now(),
  });
  if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, claim.key);
}

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
  /**
   * WHICH RUN OF A LOSSY STORE THIS REQUEST IS BEING ANSWERED FROM — the desktop's local PGlite
   * mints one at every launch that could have lost committed rows (`apps/sidecar/src/db.ts`), and
   * `/sync` stamps it into every cursor and checks it on every read.
   *
   * ABSENT means a store that cannot lose a committed row — the hosted Postgres, the phone's
   * SQLite — which is a different answer from a generation that happens to be its first: only the
   * second admits a cursor issued before the field existed. See `SyncService.decodeCursor`.
   */
  storeGeneration?: number | null;
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

/**
 * THE ONE DOOR for a request-scoped write against a table Art. 17 erasure empties: a request valid
 * when it started can otherwise commit after the sweep and recreate erased state. This IS
 * `fencedAccountWrite` — the db package's seam — with the HTTP error shape put on at the edge; it
 * is not a second fence, and there is no other. `mailboxId` fences the MAILBOX too, for a write
 * that belongs to one; `lock` raises the strength for a body that will take `accounts FOR UPDATE`
 * later; `db` names the handle for a caller that holds one directly. The census reddens a door
 * that is neither fenced, fenced by construction, nor allow-listed.
 */
export async function withAccountTx<T>(
  ctx: ServiceContext, fn: (tx: LedgerTx) => Promise<T>,
  opts: {
    readonly lock?: LockMode;
    readonly db?: ServiceContext["db"];
    readonly mailboxId?: string;
  } = {},
): Promise<T> {
  const db = opts.db ?? ctx.db;
  try {
    return await fencedAccountWrite(
      bridgeTx(db),
      { accountId: ctx.accountId, mailboxId: opts.mailboxId, lock: opts.lock },
      async (tx) => fn(tx as unknown as LedgerTx),
    );
  } catch (err) {
    throw asServiceRefusal(err);
  }
}

