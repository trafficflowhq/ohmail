import { parse, protocol, type PGlite, type QueryOptions, type Results, type Transaction } from "@electric-sql/pglite";
import { currentStoreLane } from "./store-lanes.js";

/**
 * THE INGEST'S STATEMENTS KEEP THEIR PLANS.
 *
 * PGlite sends every `query` as an UNNAMED statement, so Postgres plans it at every execution, and
 * planning sizes the table and each of its indexes: an `lseek(SEEK_END)` apiece, which the store's
 * filesystem answers with an `fstat` — 95 of the ~107 an imported message cost on Linux. Here a
 * parameterised statement the ingest lane issues is prepared once under a NAME, and Postgres' own
 * plan cache decides per statement whether a generic plan is as cheap as a custom one. No size is
 * cached: every plan still reads the relation's real length when it is made.
 */

/**
 * A plan made at one size never serves the store at another for long: a statement is prepared anew
 * after this many executions, so its next plans read the tables as they are. The store runs no
 * autovacuum, and an ANALYZE is the only other thing that invalidates a cached plan.
 */
export const PLAN_REUSE_EXECUTIONS = 256;

/** Names held at once; the least recently used is closed first. Bounds the backend's plan memory. */
export const PLAN_NAMES_MAX = 64;

/**
 * Statements whose GENERIC plan loses an index their custom plan uses, read by EXPLAIN over synthetic
 * stores from a few thousand to seventy thousand messages: they stay unnamed and planned per execution. All
 * three run once a cycle or once a pass, so the planner's cost there is noise. Keyed by the text
 * with its whitespace folded to single spaces ({@link foldStatement}).
 */
export const CUSTOM_PLAN_STATEMENTS: ReadonlySet<string> = new Set([
  // The drain's orphan scan: the generic plan walks the primary key in place of the mailbox index (at every size).
  `select "id" from "messages" where ("messages"."mailbox_id" = $1 and "messages"."account_id" = $2 and "messages"."deleted_at" is null and "messages"."native_locator" is not null and not exists (select 1 from "message_instances" where "message_instances"."message_id" = "messages"."id") and not exists (select 1 from "folder_state" where "folder_state"."message_id" = "messages"."id" and "folder_state"."reconcile_status" = 'reconciled' and "folder_state"."desired_folder" <> "folder_state"."observed_folder")) order by "messages"."id" asc limit $3`,
  // The flag reconcile's due query: the generic plan loses the (mailbox, dedup) index (a small store).
  `select "flag_state"."message_id", "flag_state"."desired_seen", "flag_state"."observed_seen", "flag_state"."last_set_by", "messages"."native_locator", "flag_state"."attempts" from "flag_state" inner join "messages" on "messages"."id" = "flag_state"."message_id" where ("messages"."mailbox_id" = $1 and "flag_state"."reconcile_status" = $2 and ("flag_state"."next_attempt_at" is null or "flag_state"."next_attempt_at" <= $3)) order by "flag_state"."updated_at" asc, "flag_state"."message_id" asc limit $4`,
  // The seen-state walk of one mailbox: the generic plan loses the (id, account) index (a small store, analysed).
  `select "message_instances"."folder", "message_instances"."uid", "message_instances"."uidvalidity", "messages"."message_id_header", "flag_state"."observed_seen", "messages"."unread" from "message_instances" inner join "messages" on "messages"."id" = "message_instances"."message_id" left join "flag_state" on "flag_state"."message_id" = "message_instances"."message_id" where "message_instances"."mailbox_id" = $1`,
]);

/** A statement's text with every run of whitespace folded to one space, ends trimmed. */
export const foldStatement = (text: string): string => text.replace(/\s+/g, " ").trim();

type Query = (text: string, params?: unknown[], options?: QueryOptions) => Promise<Results<unknown>>;
type BackendMessage = Awaited<ReturnType<PGlite["execProtocol"]>>["messages"][number];
interface Prepared { name: string; types: number[]; uses: number }

/**
 * The named statements of one client. `routes` is the decision; everything else follows PGlite's own
 * `query` step for step: the transaction mutex at the top level, the query mutex always, values
 * serialised by the parameter types Postgres described, a sync after a statement outside a
 * transaction, and the first result set parsed by PGlite's parser.
 */
export class IngestPlans {
  readonly #client: PGlite;
  readonly #held = new Map<string, Prepared>(); // insertion order is recency
  #seq = 0;

  constructor(client: PGlite) { this.#client = client; }

  /** Only the ingest lane's parameterised statements, never a COPY with a blob, never a refused text. */
  routes(text: string, params: unknown[] | undefined, options: QueryOptions | undefined): boolean {
    if (currentStoreLane() !== "ingest" || !params?.length || options?.blob) return false;
    return this.#held.has(text) || !CUSTOM_PLAN_STATEMENTS.has(foldStatement(text));
  }

  async run(text: string, params: unknown[], options: QueryOptions | undefined): Promise<Results<unknown>> {
    const c = this.#client;
    return c.runExclusive(async () => {
      const opts = { ...options, syncToFs: false };
      let p = this.#held.get(text);
      if (p && p.uses >= PLAN_REUSE_EXECUTIONS) p = await this.#close(text, p, opts);
      if (!p) p = await this.#prepare(text, options, opts);
      else { this.#held.delete(text); this.#held.set(text, p); }
      p.uses += 1;
      const values = params.map((v, i) => {
        if (v === null || v === undefined) return null;
        const serialize = options?.serializers?.[p.types[i]!] ?? c.serializers[p.types[i]!];
        return serialize ? serialize(v) : String(v);
      });
      const s = protocol.serialize;
      const messages = await this.#synced(opts, [s.bind({ statement: p.name, values }), s.describe({ type: "P" }), s.execute({})]);
      if (!c.isInTransaction()) await c.syncToFs();
      return parse.parseResults(messages, c.parsers, options)[0]!;
    });
  }

  /**
   * One message a round trip and the Sync in a `finally`, exactly as PGlite's own `query` sends
   * them: after an error PGlite stops reading the buffer it was handed, so a Sync batched behind
   * the failing message is never read and the session would ignore everything until one arrives.
   */
  async #synced(opts: object, parts: Uint8Array[]): Promise<BackendMessage[]> {
    const out: BackendMessage[] = [];
    try {
      for (const m of parts) out.push(...(await this.#client.execProtocol(m, opts)).messages);
    } finally {
      await this.#client.execProtocol(protocol.serialize.sync(), opts);
    }
    return out;
  }

  async #prepare(text: string, options: QueryOptions | undefined, opts: object): Promise<Prepared> {
    while (this.#held.size >= PLAN_NAMES_MAX) {
      const [oldest, q] = this.#held.entries().next().value!;
      await this.#close(oldest, q, opts);
    }
    const s = protocol.serialize, name = `ohmail_ingest_${++this.#seq}`;
    const messages = await this.#synced(opts, [s.parse({ name, text, types: options?.paramTypes }), s.describe({ type: "S", name })]);
    const p: Prepared = { name, types: parse.parseDescribeStatementResults(messages), uses: 0 };
    this.#held.set(text, p);
    return p;
  }

  async #close(text: string, p: Prepared, opts: object): Promise<undefined> {
    this.#held.delete(text);
    await this.#synced(opts, [protocol.serialize.close({ type: "S", name: p.name })]);
    return undefined;
  }
}

/**
 * Route `client`'s statements through {@link IngestPlans}, in place — the top-level `query` and the
 * `query` of every transaction it opens — so drizzle, the lanes and the relaxed commits keep the one
 * object they were handed. Installed first, so the scheduler still admits the whole statement.
 */
export function keepIngestPlans(client: PGlite): IngestPlans {
  const plans = new IngestPlans(client);
  const query = client.query.bind(client) as Query;
  const transaction = client.transaction.bind(client);
  const define = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  define(client, "query", async function planned(text: string, params?: unknown[], options?: QueryOptions) {
    if (!plans.routes(text, params, options)) return query(text, params, options);
    await client._checkReady();
    return client._runExclusiveTransaction(() => plans.run(text, params!, options));
  });
  define(client, "transaction", function planned<T>(cb: (tx: Transaction) => Promise<T>): Promise<T> {
    return transaction((tx) => {
      const txQuery = tx.query.bind(tx) as Query;
      define(tx, "query", async (text: string, params?: unknown[], options?: QueryOptions) => {
        if (!plans.routes(text, params, options)) return txQuery(text, params, options);
        if (tx.closed) throw new Error("Transaction is closed");
        return plans.run(text, params!, options);
      });
      return cb(tx);
    });
  });
  return plans;
}
