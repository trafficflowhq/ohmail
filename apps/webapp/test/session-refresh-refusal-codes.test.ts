import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_REFUSAL_CODES } from "@ohmail/client-engine";
import { lastRefreshReport, resumeSession } from "../app/session-refresh.js";
import { markSessionAlive, sessionIsDead } from "@ohmail/app-logic/session/session-truth";

/**
 * The browser's cookie refresh ends a session only on the refresh door's own refusal: a 401 whose
 * envelope names one of `SESSION_REFUSAL_CODES`, the phone's and the paired browser's reading
 * (`isSessionRefusal`). A 401 carrying another code in our envelope's shape is a platform or a
 * proxy answering; the session stays and the refresh reads as unavailable.
 */

const g = globalThis as unknown as { fetch: typeof globalThis.fetch };
let prior: typeof globalThis.fetch;
const answer = (status: number, body: unknown) => {
  g.fetch = (async () => new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;
};

beforeEach(() => { prior = g.fetch; markSessionAlive(); });
afterEach(() => { g.fetch = prior; markSessionAlive(); });

describe("the web refresh reads a refusal the way every other client does", () => {
  it.each([...SESSION_REFUSAL_CODES])("a 401 naming %s signs the browser out", async (code) => {
    answer(401, { error: { code, message: "refused" } });
    expect(await resumeSession()).toBe("refused");
    expect(lastRefreshReport()).toMatchObject({ outcome: "revoked", status: 401, code });
    expect(sessionIsDead()).toBe(true);
  });

  it.each(["deployment_protected", "rate_limited", "csrf_failed"])(
    "a 401 naming %s, not a refusal, keeps the session and is recorded as unavailable",
    async (code) => {
      answer(401, { error: { code, message: "not the refresh door" } });
      expect(await resumeSession()).toBe("unavailable");
      expect(lastRefreshReport()).toMatchObject({ outcome: "unavailable", status: 401, code });
      expect(sessionIsDead()).toBe(false);
    },
  );

  it("an uncoded 401 keeps the session, as before (control)", async () => {
    answer(401, { message: "Unauthorized" });
    expect(await resumeSession()).toBe("unavailable");
    expect(lastRefreshReport()).toMatchObject({ outcome: "unavailable", status: 401, code: null });
    expect(sessionIsDead()).toBe(false);
  });

  it("a 204 mints (control)", async () => {
    answer(204, undefined);
    expect(await resumeSession()).toBe("resumed");
    expect(lastRefreshReport()).toMatchObject({ outcome: "minted" });
  });
});
