import { afterEach, describe, expect, it, vi } from "vitest";
import { BearerManager, REFRESH_STORAGE_KEY } from "../src/host-client/bearer.js";

/**
 * A CREDENTIAL ROUTE'S 401 IS AN ANSWER — the paired browser's transport. The door names a wrong code
 * `credential_refused`, read before anything renews; a door older than the code answers it
 * `unauthorized`, which is also what a lapsed access token gets, and there the route list stops the
 * second send (the OLD-SERVER BELT control below). A press on such a route after a reload (no access
 * token held) or past the stated window renews FIRST and goes out once. An ordinary stale token still
 * renews and replays once. The routes are held to the server by `factor-routes-never-refresh.test.ts`.
 */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const WRONG_CODE = { error: { code: "credential_refused", message: "two-factor verification failed" } };
/** The same refusal from a door older than `credential_refused`. */
const OLD_WIRE = { error: { code: "unauthorized", message: "two-factor verification failed" } };

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  } as Storage;
}

/**
 * The door: a factor route refuses every code with `refusal`, `/messages` refuses only the lapsed
 * token. `warm` adopts a pair inside its stated window, as a page that rotated does; cold is a reload.
 */
function door(refusal: typeof WRONG_CODE, window: "warm" | "cold") {
  const sent: Array<{ path: string; auth: string | undefined }> = [];
  const firsts: Response[] = [];
  let renewals = 0;
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as { headers?: Record<string, string> };
    if (url === "/auth/refresh") {
      renewals += 1;
      return json(200, { tokens: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900 } });
    }
    sent.push({ path: url, auth: i.headers?.authorization });
    if (url.startsWith("/messages")) {
      return i.headers?.authorization === "Bearer access-2" ? json(200, { messages: [] }) : json(401, { error: { code: "unauthorized" } });
    }
    const refused = json(401, refusal);
    firsts.push(refused);
    return refused;
  };
  const bearer = new BearerManager({ storage: memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" }), fetchImpl });
  if (window === "warm") bearer.adopt({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 });
  return { bearer, sent, firsts, renewals: () => renewals };
}

afterEach(() => { vi.useRealTimers(); });

describe("the paired browser hands a credential route's 401 back as it came", () => {
  it("a wrong step-up code is posted once, nothing renews, and the caller reads the door's 401", async () => {
    const d = door(WRONG_CODE, "warm");
    const res = await d.bearer.fetch("/auth/step-up/totp", { method: "POST", body: JSON.stringify({ code: "000000" }) });
    expect(d.sent.map((s) => s.path), "the code went out twice").toEqual(["/auth/step-up/totp"]);
    expect(d.renewals(), "a wrong code rotated the pairing").toBe(0);
    expect(res, "the 401 the caller reads is not the one the door sent").toBe(d.firsts[0]);
    expect(await res.json()).toEqual(WRONG_CODE);
    expect(d.bearer.paired(), "an answer ended the pairing").toBe(true);
  });

  it("THE CODE IS READ FIRST: credential_refused on a route no list names is posted once and handed back", async () => {
    const d = door(WRONG_CODE, "warm");
    const res = await d.bearer.fetch("/auth/confirm-by-code", { method: "POST" });
    expect([res.status, d.sent.length, d.renewals()]).toEqual([401, 1, 0]);
    expect(res).toBe(d.firsts[0]);
  });

  it("OLD-SERVER BELT CONTROL: an `unauthorized` wrong code is stopped by the list, for a spent pairing code, with a query string, by full address", async () => {
    for (const url of ["/pair/redeem", "/auth/2fa/totp/activate?lang=de", "http://door.test/auth/step-up/totp"]) {
      const d = door(OLD_WIRE, "warm");
      const res = await d.bearer.fetch(url, { method: "POST" });
      expect([res.status, d.sent.length, d.renewals()], url).toEqual([401, 1, 0]);
    }
    // The list, not the code, stopped those: the same wire on a route it does not name renews.
    const d = door(OLD_WIRE, "warm");
    await d.bearer.fetch("/auth/confirm-by-code", { method: "POST" });
    expect(d.renewals()).toBe(1);
  });

  it("after a reload (no access token held) a press on a listed route renews FIRST and goes out once, under the renewed token", async () => {
    const d = door(OLD_WIRE, "cold");
    await d.bearer.fetch("/auth/step-up/totp", { method: "POST" });
    expect(d.renewals()).toBe(1);
    expect(d.sent).toEqual([{ path: "/auth/step-up/totp", auth: "Bearer access-2" }]);
  });

  it("a STATED window that ran out renews first; inside it, nothing renews", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.parse("2026-10-05T10:00:00.000Z");
    for (const [after, renewals, auth] of [[16 * 60_000, 1, "Bearer access-2"], [60_000, 0, "Bearer access-1"]] as const) {
      vi.setSystemTime(T);
      const d = door(OLD_WIRE, "warm");
      vi.setSystemTime(T + after);
      await d.bearer.fetch("/auth/step-up/totp", { method: "POST" });
      expect([d.renewals(), d.sent], `${after / 60_000} min after the window opened`)
        .toEqual([renewals, [{ path: "/auth/step-up/totp", auth }]]);
    }
  });

  it("POSITIVE: a stale access token on /messages still renews once and replays once", async () => {
    const d = door(WRONG_CODE, "cold");
    const res = await d.bearer.fetch("/messages?limit=50", { method: "GET" });
    expect(res.status).toBe(200);
    expect(d.renewals()).toBe(1);
    expect(d.sent).toEqual([
      { path: "/messages?limit=50", auth: undefined },
      { path: "/messages?limit=50", auth: "Bearer access-2" },
    ]);
  });
});
