import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSurface } from "../app/session-gate.js";

/**
 * A BROWSER THAT ASKED TO SIGN OUT IS FINISHED, NEVER SERVED THE APP AND NEVER RESUMED. A sign-out
 * whose server half went unconfirmed leaves `tf_owner=signed_out_pending` beside the session. The
 * gate read only the session cookies, so a live access cookie got the app (every request refused,
 * "this browser now holds another account's session") and a lapsed one got the resume splash,
 * which reloaded itself without end. Measured on ohmail.app. With the marker the gate answers the
 * splash, whose job is then to finish the sign-out at the door; it costs no probe.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API = "https://api.ohmail.app";
const TOKEN = "tf_access_token_value";

/** A `fetch` that must never be called. */
const noNetwork: typeof fetch = (() => {
  throw new Error("network request made where the design promises none");
}) as unknown as typeof fetch;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the gate and the pending sign-out", () => {
  it("a LIVE access cookie with the marker: the splash, and no probe", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("resume");
  });

  it("the stuck jar — the access cookie lapsed: the splash", async () => {
    await expect(resolveSurface({
      sessionToken: null, resumeMarker: true, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("resume");
  });

  it("a throttled token-holder with the marker: still the splash, never the app", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, throttled: true, search: "", apiOrigin: API,
      fetchImpl: noNetwork,
    })).resolves.toBe("resume");
  });

  it("an access cookie without the resume marker, with the pending marker: the splash", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: false, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("resume");
  });

  it("the marker and nothing else in the jar: the landing — there is nothing left to finish", async () => {
    await expect(resolveSurface({
      sessionToken: null, resumeMarker: false, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("marketing");
  });

  it("no API armed: the landing, as for every cookie on such a deployment", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, search: "", apiOrigin: null, fetchImpl: noNetwork,
    })).resolves.toBe("marketing");
  });

  it("the demo still wins over the marker", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, search: "demo=1", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("demo");
  });

  it("THE CONTROL — without the marker a live token is probed and served the app", async () => {
    let calls = 0;
    const live = (async () => {
      calls += 1;
      return json({ user: { userId: "u-1", accountId: "a-1" }, scope: "full" });
    }) as unknown as typeof fetch;
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: false, search: "", apiOrigin: API, fetchImpl: live,
    })).resolves.toBe("app");
    expect(calls).toBe(1);
  });

  it("the middleware reads the marker the client writes and hands it to the gate", () => {
    const mw = readFileSync(`${HERE}../middleware.ts`, "utf8");
    expect(mw, "the gate is never told about the pending sign-out")
      .toMatch(/const signOutPending = cookieFromStore\(request\.cookies, OWNER_COOKIE\) === OWNER_SIGNED_OUT;/);
    expect(mw).toMatch(/resolveSurface\(\{[\s\S]*?signOutPending,[\s\S]*?\}\)/);
  });
});
