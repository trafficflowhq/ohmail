/**
 * The sync client, absent — from the interface preview, and only from there.
 *
 * `@ohmail/client-engine`'s barrel re-exports `HttpAdapter`, the `/sync`
 * protocol client. This directory builds TWO artifacts from one source, and
 * they need opposite things from that class:
 *
 *  · the INTERFACE PREVIEW runs on fixture mail. It has no account, no server
 *    and no engine to speak to, so `vite.config.ts` aliases the real module to
 *    this file. The emitted bundle then contains no request builder, no CSRF
 *    header, no idempotency key and no cursor protocol — grep it and there is
 *    nothing to find — and if an edit makes the shell reach for the class
 *    anyway, this throws on construction instead of quietly opening a socket.
 *  · the ENGINE-BEARING build IS a mail client. It runs the real `HttpAdapter`
 *    against the mail engine on this machine, over the bridge in
 *    `src/bridge-fetch.ts` rather than over a socket, so the alias is left out
 *    of that build — `vite.config.ts`, `LOCAL_ENGINE ? [] : [alias]`.
 *
 * ── ONE PATH NOW, NOT TWO ──────────────────────────────────────────────────
 *
 * This file used to be published twice: here, and written over the top of
 * `packages/client-engine/src/adapters/http-adapter.ts`, on the reasoning that
 * the only artifact aliased that module away at bundle time, so the repository
 * never needed the real one. The reasoning was sound while it was true, and it
 * stopped being true the moment a second artifact began constructing the class.
 * It then stopped being harmless: a released engine-bearing build resolved the
 * name to this stub, whose constructor throws, inside a React render — a blank
 * window as soon as a mailbox served.
 *
 * The real adapter is published at its own path now. This file is the preview's
 * alias target and nothing else.
 *
 * The general rule, since it cost something to learn: writing a stub over a
 * module's path is sound only while nothing in the SHIPPED ARTIFACT constructs
 * the thing being stood in for. That is a question about the artifact, and its
 * answer changes silently on the day a second artifact is added — a
 * substitution that has gone wrong compiles, packages and installs exactly like
 * one that has not.
 *
 * ── WHY IT STILL IMPORTS NOTHING ───────────────────────────────────────────
 *
 * The two-path arrangement is what made a relative import wrong: it would have
 * had to resolve correctly from two different directories. That arrangement is
 * gone and the constraint stays, because keeping it costs nothing and dropping
 * it is a one-way door — an import added here would break nothing at all until
 * somebody restored the substitution, and would then break somewhere other than
 * where it was written. So the types below are declared rather than imported.
 *
 * What that costs in safety is worth stating exactly, rather than reassuringly:
 * nothing checks this file against `EngineAdapter` any more. `tsc` reads no Vite
 * aliases, so it resolves the real module wherever the shell mentions the type,
 * and the preview's bundler cares about exported NAMES rather than shapes. The
 * method set is therefore compared against the interface's own declaration in
 * `packages/client-engine/src/adapters/adapter.ts` by `test/desktop-shell.test.ts`,
 * which is a check that runs, rather than by a claim in this comment.
 */

export type FetchLike = (url: string, init?: unknown) => Promise<unknown>;

/**
 * The server's own message-list vocabulary, and the table that joins it to the client's.
 *
 * BOTH ARE RE-EXPORTED BY THE PACKAGE BARREL, which is the only reason they are here. The barrel
 * says `export { HttpAdapter, SERVER_VIEW_OF, … } from "./adapters/http-adapter.js"`, and in the
 * PREVIEW build that specifier is aliased to this file — so the two VALUE exports it names have
 * to exist here, or the barrel binds nothing. The three type re-exports beside them are erased
 * before the bundler sees them; `ServerMessageView` is declared here for this file's own
 * annotation below, since nothing may be imported.
 *
 * `tsc` never checks this, in any checkout: it reads no Vite aliases and resolves the real
 * module. So the barrel's re-export list is compared against this file's exports by
 * `test/desktop-shell.test.ts` rather than left to be noticed at build time — the drift it
 * catches once broke every platform's build at the same moment, on a green local tree.
 *
 * `Record<string, …>` and NOT `Record<OhmailView, …>`: this file imports nothing, deliberately
 * (see the header), so the client's view union is not nameable here. The exhaustiveness that
 * type buys is a property of the real table; nothing in this build reads this one, because
 * there is no server to translate a view for.
 */
export type ServerMessageView =
  | "imbox" | "feed" | "paper_trail" | "screened" | "quarantine"
  | "new_for_you" | "previously_seen";

export const SERVER_VIEW_OF: Record<string, ServerMessageView | null> = {
  ohbox: "imbox",
  reads: "feed",
  receipts: "paper_trail",
  screened: "screened",
  spam: "quarantine",
  screener: null,
};

/**
 * HOW LONG A BODY FETCH MAY STAY IN THE AIR — a number this artifact never reads.
 *
 * It is here for exactly the reason `SERVER_VIEW_OF` is: the package barrel re-exports it BY NAME
 * from the module this file stands in for, so in the preview build the barrel has to find it here
 * or it binds nothing and the bundle does not build. It did not build: the constant was added to
 * the real adapter and re-exported, this file did not follow, and the preview bundle failed with
 * `"BODY_FETCH_TIMEOUT_MS" is not exported`. Nothing local said so — the type checker resolves the
 * real module, and no test in this repository runs the bundler.
 *
 * The VALUE is deliberately not a promise about anything. Nothing in the preview waits on a body:
 * it runs on fixture mail whose rows carry their text already, so the reader short-circuits before
 * an adapter is consulted, and the constructor above throws anyway. What matters is that the name
 * exists; the number beside it is the real module's, so a reader comparing the two files is not
 * left wondering which is authoritative.
 */
export const BODY_FETCH_TIMEOUT_MS = 12_000;

export interface HttpAdapterOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  getCookie?: (name: string) => string | null;
  csrfCookieName?: string;
  headers?: () => Record<string, string>;
}

const REFUSAL =
  "ohmail Desktop is standalone: there is no Cloud sync client in this build. " +
  "The HTTP adapter is aliased away at bundle time (apps/desktop/vite.config.ts).";

export class HttpAdapter {
  /** Present because the real adapter has it; never advances. */
  lastSyncSeq: number | null = null;

  constructor(_options: HttpAdapterOptions = {}) {
    throw new Error(REFUSAL);
  }

  eventsUrl(): string {
    throw new Error(REFUSAL);
  }

  async sync(_params: unknown): Promise<never> {
    throw new Error(REFUSAL);
  }

  async mutate(_mutation: unknown, _opts: unknown): Promise<never> {
    throw new Error(REFUSAL);
  }

  /**
   * `GET /messages/:id/body` — the third method the real adapter has, and
   * therefore the third this declares.
   *
   * Nothing compiles this class against `EngineAdapter`: `tsc` resolves the real module, and
   * the preview's bundler binds names rather than shapes. So the method set is not held in
   * place by a type — it is held by `test/desktop-shell.test.ts`, which reads the required
   * methods out of `packages/client-engine/src/adapters/adapter.ts` and fails if one is
   * missing here. That test exists because the method set was once load-bearing in a way
   * nothing in this checkout could observe, and the cost of keeping it complete is a line.
   *
   * The preview never reaches it: it runs on `FixturesAdapter`, whose rows carry `body`
   * already, so `hydrateBody` short-circuits before any adapter is consulted — and the
   * constructor above throws, so no instance exists to call this on in the first place.
   * Refusing rather than answering `null` keeps this file's one rule: in the artifact that
   * aliases to it, a sync call is a bug and not a degraded feature.
   */
  async fetchBody(_messageId: unknown): Promise<never> {
    throw new Error(REFUSAL);
  }
}
