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
 *     features: { sse, staging, ai, pairing } }
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
