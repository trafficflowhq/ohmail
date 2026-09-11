import { API_VERSION } from "../version.js";
import type { HelloConfig } from "../deps.js";
import type { Route } from "../router.js";

/**
 * `GET /hello` — server identity + capability negotiation, before any credential exists: it makes
 * not-mounting a surface safe — an absent route is announced here, not discovered by a 404
 * mid-ceremony. `public + anonymous + raw` as `GET /health`; the handler never throws. The body
 * is the injected {@link HelloConfig} and nothing else — a host that injects nothing gets a 503,
 * never a guessed `flavor`. The wire shape is frozen (a contract test pins the keys); a failed
 * `needsSetup` capability is a 503, never a guessed boolean. `features.accountHeader` is a
 * constant — a fact about the build — and its absence on older servers IS the negotiation. Always
 * `no-store`.
 */
export const helloRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/hello",
    relay: true,
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
