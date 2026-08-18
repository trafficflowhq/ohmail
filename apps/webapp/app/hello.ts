/**
 * `GET /hello` — the client half of the server's capability handshake.
 *
 * The endpoint exists so a client learns WHAT it is pointed at before any credential exists
 * (`packages/api/src/routes/hello.ts` — flavor, needsSetup, features), and this module is the
 * webapp's one reader of it. Two exports, and the split between them is the point:
 *
 *  · {@link SELF_HOST_BUILD} answers "what BUILD is this?" at COMPILE time. The flavor is a
 *    build arm (`OHMAIL_FLAVOR=selfhost` in `next.config.mjs`), inlined here as
 *    `NEXT_PUBLIC_OHMAIL_FLAVOR`, so on the managed deployment every branch guarded by it is a
 *    compiled-out constant — the managed bundle carries no self-host behaviour to reason about,
 *    and no page pays a network round-trip to learn a fact the build already settled. The web
 *    container and the server it fronts are deployed by the same compose, which is what makes
 *    the compiled answer safe: the flavor build arm exists precisely so the pair cannot
 *    disagree.
 *  · {@link serverHello} answers "what STATE is the server in?" at RUNTIME — `needsSetup` flips
 *    the moment the first account exists, so it can never be compiled in. Deliberately NOT
 *    cached, matching the endpoint's own `Cache-Control: no-store`: the callers are page mounts
 *    (the login screen's fresh-server check, the setup page's gate), each of which needs the
 *    present truth, and a memoised `needsSetup:true` would keep steering people into a setup
 *    ceremony that has already completed.
 *
 * Failure is an answer of `null`, never a throw: every caller treats "could not learn what the
 * server is" as "behave normally", because the normal surfaces (sign-in, the landing) are never
 * wrong — the same fail-closed grammar as `session-gate.ts`.
 */
import { api, apiConfigured } from "./api-client";

/** Is this bundle the self-host flavor? Compile-time; see the module header. */
export const SELF_HOST_BUILD = process.env.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost";

/** The frozen `/hello` wire shape — the fields this app acts on (the contract carries more). */
export interface ServerHello {
  product: string;
  flavor: "managed" | "selfhost" | "local";
  needsSetup: boolean;
  features: { staging: boolean; pairing: boolean };
}

/**
 * Ask the server what it is. `null` when this build has no API, when the request fails, or when
 * the answer is not the shape `/hello` promises — the caller's fallback is always "the ordinary
 * screen", so a wrong `null` costs a normal page, never a broken one.
 */
export async function serverHello(): Promise<ServerHello | null> {
  if (!apiConfigured()) return null;
  try {
    const h = await api<Partial<ServerHello>>("/hello");
    if (h?.product !== "ohmail" || typeof h.needsSetup !== "boolean") return null;
    return h as ServerHello;
  } catch {
    return null;
  }
}
