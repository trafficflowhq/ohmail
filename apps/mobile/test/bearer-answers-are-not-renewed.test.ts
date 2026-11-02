/**
 * A CREDENTIAL ROUTE'S 401 IS AN ANSWER — the phone's transport. The server names a wrong code
 * `credential_refused`, and that is read before anything renews. A server older than the code
 * answers it `unauthorized`, which is also what a lapsed access token gets: there the route list
 * stops the second send (the OLD-SERVER BELT control below). A press on such a route holding no
 * access token, or one whose stated window ran out, renews FIRST and goes out once. An ordinary
 * stale token still renews and replays once. Held to the server by `test/factor-routes-never-refresh.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BearerManagerRN, type RefreshVault } from "../src/net/bearer";

const ORIGIN = "http://host.example:8028";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const WRONG_CODE = { error: { code: "credential_refused", message: "two-factor verification failed" } };
/** The same refusal from a server older than `credential_refused`. */
const OLD_WIRE = { error: { code: "unauthorized", message: "two-factor verification failed" } };

const vault: RefreshVault = {
  save: async () => "landed",
  clear: async () => "landed",
  armAttempt: async () => "landed",
  oweSignOut: async () => false,
};

/** The door: a factor route refuses every code with `refusal`, `/messages` refuses only the lapsed token. */
function door(refusal: typeof WRONG_CODE, accessToken: string | null = "access-1") {
  const sent: Array<{ path: string; auth: string | undefined }> = [];
  const firsts: Response[] = [];
  let renewals = 0;
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as { headers?: Record<string, string> };
    const path = url.slice(ORIGIN.length);
    if (path === "/auth/refresh") {
      renewals += 1;
      return json(200, { tokens: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900 } });
    }
    sent.push({ path, auth: i.headers?.authorization });
    if (path.startsWith("/messages")) {
      return i.headers?.authorization === "Bearer access-2" ? json(200, { messages: [] }) : json(401, { error: { code: "unauthorized" } });
    }
    const refused = json(401, refusal);
    firsts.push(refused);
    return refused;
  };
  const phone = new BearerManagerRN({ origin: ORIGIN, accessToken, refreshToken: "refresh-1", vault, fetchImpl });
  return { phone, sent, firsts, renewals: () => renewals };
}

afterEach(() => { vi.useRealTimers(); });

describe("the phone hands a credential route's 401 back as it came", () => {
  it("a wrong step-up code is posted once, nothing renews, and the caller reads the server's 401", async () => {
    const d = door(WRONG_CODE);
    const res = await d.phone.fetch(`${ORIGIN}/auth/step-up/totp`, { method: "POST", body: JSON.stringify({ code: "000000" }) });
    expect(d.sent.map((s) => s.path), "the code went out twice").toEqual(["/auth/step-up/totp"]);
    expect(d.renewals(), "a wrong code rotated the session").toBe(0);
    expect(res, "the 401 the caller reads is not the one the server sent").toBe(d.firsts[0]);
    expect(await res.json()).toEqual(WRONG_CODE);
    expect(d.phone.paired(), "an answer ended the pairing").toBe(true);
  });

  it("THE CODE IS READ FIRST: credential_refused on a route no list names is posted once and handed back", async () => {
    const d = door(WRONG_CODE);
    const res = await d.phone.fetch(`${ORIGIN}/auth/confirm-by-code`, { method: "POST" });
    expect([res.status, d.sent.length, d.renewals()]).toEqual([401, 1, 0]);
    expect(res).toBe(d.firsts[0]);
  });

  it("OLD-SERVER BELT CONTROL: an `unauthorized` wrong code is stopped by the list, under the `/api` mount and with a query string", async () => {
    for (const path of ["/api/auth/step-up/totp", "/auth/2fa/totp/activate?lang=de", "/pair/redeem"]) {
      const d = door(OLD_WIRE);
      const res = await d.phone.fetch(`${ORIGIN}${path}`, { method: "POST" });
      expect([res.status, d.sent.length, d.renewals()], path).toEqual([401, 1, 0]);
    }
    // The list, not the code, stopped those: the same wire on a route it does not name renews.
    const d = door(OLD_WIRE);
    await d.phone.fetch(`${ORIGIN}/auth/confirm-by-code`, { method: "POST" });
    expect(d.renewals()).toBe(1);
  });

  it("a press on a listed route holding no access token renews FIRST and goes out once, under the renewed token", async () => {
    const d = door(OLD_WIRE, null);
    await d.phone.fetch(`${ORIGIN}/auth/step-up/totp`, { method: "POST" });
    expect(d.renewals()).toBe(1);
    expect(d.sent).toEqual([{ path: "/auth/step-up/totp", auth: "Bearer access-2" }]);
  });

  it("a STATED window that ran out renews first; inside it, nothing renews", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.parse("2026-10-05T10:00:00.000Z");
    for (const [after, renewals, auth] of [[16 * 60_000, 1, "Bearer access-2"], [60_000, 0, "Bearer access-1"]] as const) {
      vi.setSystemTime(T);
      const d = door(OLD_WIRE);
      await d.phone.adopt({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 });
      vi.setSystemTime(T + after);
      await d.phone.fetch(`${ORIGIN}/auth/step-up/totp`, { method: "POST" });
      expect([d.renewals(), d.sent], `${after / 60_000} min after the window opened`)
        .toEqual([renewals, [{ path: "/auth/step-up/totp", auth }]]);
    }
  });

  it("POSITIVE: a stale access token on /messages still renews once and replays once", async () => {
    const d = door(WRONG_CODE);
    const res = await d.phone.fetch(`${ORIGIN}/messages?limit=50`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(d.renewals()).toBe(1);
    expect(d.sent).toEqual([
      { path: "/messages?limit=50", auth: "Bearer access-1" },
      { path: "/messages?limit=50", auth: "Bearer access-2" },
    ]);
  });
});
