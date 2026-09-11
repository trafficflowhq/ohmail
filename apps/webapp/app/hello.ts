/**
 * `GET /hello` — the client half of the server's capability handshake; this module is the webapp's one reader of it.
 * Two exports, and the split is the point: {@link SELF_HOST_BUILD} answers "what BUILD is this?" at COMPILE time
 * (`OHMAIL_FLAVOR=selfhost`, inlined as `NEXT_PUBLIC_OHMAIL_FLAVOR`) — the managed bundle carries no self-host
 * behaviour and no page pays a round trip for a fact the build settled; the web container and its server are deployed
 * by one compose, which is what makes the compiled answer safe.
 */

/**
 * {@link serverHello} answers "what STATE is the server in?" at RUNTIME — `needsSetup` flips when the first account
 * exists, so it can never be compiled in, and it is deliberately NOT cached (matching the endpoint's `no-store`): a
 * memoised `needsSetup:true` would keep steering people into a completed setup ceremony. Failure is `null`, never a
 * throw: "could not learn what the server is" behaves normally, the fail-closed grammar of `session-gate.ts`.
 */
import { api, apiConfigured, setAccountHeaderCapability } from "./api-client";

/** Is this bundle the self-host flavor? Compile-time; see the module header. */
export const SELF_HOST_BUILD = process.env.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost";

/**
 * How long {@link serverHello} waits before answering `null`. The browser's `fetch` has NO
 * application timeout of its own, so without this a server that ACCEPTS the connection and
 * never answers — a wedged API process behind a live proxy — parks the setup page on
 * "checking" forever, with its retry unreachable. Generous against a cold container, small
 * against a person deciding the page is broken; the middleware's own probe budget is tighter
 * because a slow answer there merely serves the landing.
 */
export const HELLO_TIMEOUT_MS = 5_000;

/** The frozen `/hello` wire shape — the fields this app acts on (the contract carries more). */
export interface ServerHello {
  product: string;
  // `desktop-host` joined the union when the Devices pane started branching on the flavor
  // (collapse-and-bulk-revoke is a hosted/self-host arm only; on a desktop host the
  // device-less non-current session is the HOST's own launch session and the bulk route is
  // deliberately unmounted). The value itself has been on the wire since Phase 3.
  flavor: "managed" | "selfhost" | "local" | "desktop-host";
  needsSetup: boolean;
  /**
   * `ai` is the OPERATOR's key, not the account's switch: the server answers
   * `anthropicApiKey !== null`, so on a self-host deployment it is the difference between "the
   * operator has set a key and suggestions run" and "rules do all the filing". The first-run
   * flow's provider step reads it to pick which sentence is true; without it the step would guess,
   * and both guesses are a claim about somebody else's server. The key has always been on the wire
   * (`routes/hello.ts` freezes the set as `{ sse, staging, ai, pairing }`); this interface simply
   * did not name it, because until now nothing in the browser asked.
   */
  /**
   * `accountHeader` is the one feature word this client acts on for SAFETY rather than for a
   * surface: it says the server names the account each answer was produced for
   * (`X-Ohmail-Account`), which is what lets `api()` refuse an answer that names nobody. Optional
   * on the type because a server that predates it simply does not send it, and that absence is
   * the negotiation working rather than a parse failure.
   */
  features: { staging: boolean; ai: boolean; pairing: boolean; accountHeader?: boolean };
}

/**
 * Ask the server what it is. `null` when this build has no API, when the request fails, or when
 * the answer is not the shape `/hello` promises — the caller's fallback is always "the ordinary
 * screen", so a wrong `null` costs a normal page, never a broken one.
 */
export async function serverHello(opts: { signal?: AbortSignal } = {}): Promise<ServerHello | null> {
  if (!apiConfigured()) return null;
  /*
   * TWO REASONS TO STOP, ONE SIGNAL. The deadline above is this module's own and applies to every
   * caller. `opts.signal` is the CALLER's — the sign-in page aborts this the moment a password is
   * submitted, so an answer cannot navigate out from under a ceremony that has already started.
   *
   * Composed by hand rather than with `AbortSignal.any`, which is newer than the browsers this
   * bundle targets: a `serverHello` that throws `AbortSignal.any is not a function` would be
   * caught below and reported as `null`, i.e. as "could not learn what the server is" — a real
   * failure wearing the shape of a normal answer, on old browsers only.
   */
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HELLO_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (opts.signal?.aborted) ctl.abort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const h = await api<Partial<ServerHello>>("/hello", { signal: ctl.signal });
    if (h?.product !== "ohmail" || typeof h.needsSetup !== "boolean") return null;
    /*
     * THE ONE PLACE THE ACCOUNT-HEADER REQUIREMENT IS NEGOTIATED, and it is here rather than in
     * `api-client.ts` because this is where the server's own word arrives. Set only on an answer
     * that PARSED: a failed or malformed `/hello` returns `null` above and leaves the client's
     * previous state alone, so a network blip cannot switch the requirement off for the session.
     *
     * A server that answers `/hello` without the word is saying no, which is different from not
     * having answered — `false`, not `null`. That difference is what the disclosure hangs on.
     */
    setAccountHeaderCapability(h.features?.accountHeader === true);
    return h as ServerHello;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
