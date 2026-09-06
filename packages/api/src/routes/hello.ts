import { API_VERSION } from "../version.js";
import type { HelloConfig } from "../deps.js";
import type { Route } from "../router.js";

/**
 * `GET /hello` — server identity + capability negotiation, in EVERY composition.
 *
 * A client that can be pointed at more than one kind of server — the hosted service, an
 * operator's own standalone install, a desktop engine on this machine — needs one endpoint that
 * says what it has been pointed at, BEFORE any credential exists. Without it, the only way to
 * learn what a server is would be to probe routes that exist on one composition and not another,
 * which turns every composition difference into a client-side guess. This endpoint is the
 * negotiation that makes not-mounting a surface safe: a route absent from one composition is
 * announced absent here, rather than discovered absent by a 404 mid-ceremony.
 *
 * `public + anonymous + raw`, exactly as `GET /health`: a caller has no credential yet (that is
 * the point), `anonymous` keeps a stray ambient cookie from costing a session query or a failure
 * path outside this handler, and `raw` means there is NO error envelope above this — so the
 * handler never throws; every branch answers a constructed Response.
 *
 * **The body is served from the injected {@link HelloConfig} and from nothing else.** Each
 * composition root states its own truth, the same way `/health`'s `dbProvider` and `billing`
 * markers arrive. There is deliberately no fallback that sniffs the environment: a capability
 * answer must be a statement the host made, and a host that injects no descriptor gets a 503
 * naming the omission instead of a guessed `flavor` a server picker would then trust.
 *
 * **The wire shape is FROZEN.** Exactly these keys, exactly this nesting:
 *
 *   { product: "ohmail",
 *     flavor: "managed" | "selfhost" | "local" | "desktop-host",
 *     apiVersion: string,
 *     needsSetup: boolean,
 *     auth:     { password, totp, webauthn, publicSignup },
 *     features: { sse, staging, ai, pairing, accountHeader } }
 *
 * Clients switch on it, so a key may be ADDED only as a deliberate contract change alongside the
 * contract test that pins this set — never dropped, never renamed. `product` is a constant so a
 * probe can tell this endpoint apart from any other service that happens to answer `/hello`.
 *
 * **`needsSetup` may be a capability** (a standalone server's honest answer is "are there zero
 * users", a database fact), and a capability can fail. On failure the route answers 503 — never
 * a guessed boolean, in either direction: `false` on a fresh box hides the setup ceremony
 * forever, `true` on an established box advertises a first-account ceremony that must not exist.
 *
 * **`features.accountHeader` — and it is a CONSTANT, not an injected one.** Every other member of
 * `features` is a host's choice, arriving through {@link HelloConfig}. This one is a fact about the
 * BUILD: `createApp.handle` sets `X-Ohmail-Account` on every response that resolved an account, in
 * every composition compiled from this table, so a host has nothing to decide and must not be given
 * the chance to say otherwise. An injected flag could be set `false` by a server that sends the
 * header, or `true` by one that does not, and a negotiated capability a host can lie about is worse
 * than no negotiation at all.
 *
 * What makes it useful is its ABSENCE. A server built before the header existed does not carry this
 * key, so a client reads `features.accountHeader !== true` and does not require the header from it.
 * That is the whole negotiation: a webapp pointed at an operator's older self-hosted install must
 * not refuse every authenticated read because a header that server has never heard of is missing.
 * A client must therefore treat the header as REQUIRED only against a server that advertises it,
 * and the absence rule — a missing header on an authenticated read is a refusal — applies only
 * there. Against a server that does NOT advertise it, a missing header says nothing at all and the
 * client falls back to whatever it did before the header existed.
 *
 * The header's own meaning, for completeness and because the design note this used to cite is not
 * part of the published repository: when present it names the account the response's contents
 * belong to — the credential's account on the sign-in and token routes, the session's account
 * elsewhere — and when absent on a server that advertises it, the response has no account subject
 * and a client holding per-account state must treat it as a refusal.
 *
 * Always `Cache-Control: no-store`: `needsSetup` flips the moment the first account is created,
 * and a cached capability answer is a lie about the present.
 */
export const helloRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/hello",
    cost: "unauthenticated",
    options: { public: true, raw: true, anonymous: true },
    handler: async (_req, deps) => {
      const hello = deps.hello;
      if (!hello) {
        return helloResponse(503, {
          error: "hello_unconfigured",
          detail: "this host injected no hello descriptor, so it cannot state what it is",
        });
      }
      let needsSetup: boolean;
      if (typeof hello.needsSetup === "function") {
        try {
          needsSetup = await hello.needsSetup();
        } catch {
          // The capability failed (on a standalone server: the database did not answer). A
          // capability endpoint that cannot compute its answer says so; it never guesses.
          return helloResponse(503, {
            error: "hello_unavailable",
            detail: "this host could not determine its setup state",
          });
        }
      } else {
        needsSetup = hello.needsSetup;
      }
      return helloResponse(200, {
        product: "ohmail",
        flavor: hello.flavor,
        apiVersion: hello.apiVersion ?? API_VERSION,
        needsSetup,
        auth: {
          password: hello.auth.password,
          totp: hello.auth.totp,
          webauthn: hello.auth.webauthn,
          publicSignup: hello.auth.publicSignup,
        },
        features: {
          sse: hello.features.sse,
          staging: hello.features.staging,
          ai: hello.features.ai,
          pairing: hello.features.pairing,
          // Not `hello.features.accountHeader` — see the header. This composition sets the
          // account header because `createApp.handle` does, and that is not the host's to choose.
          accountHeader: true,
        },
      });
    },
  },
];

/** Same discipline as `/health`'s responder: JSON, and never cached. */
function helloResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
