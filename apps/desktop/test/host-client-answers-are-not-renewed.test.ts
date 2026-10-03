import { describe, expect, it } from "vitest";
import { BearerManager, REFRESH_STORAGE_KEY } from "../src/host-client/bearer.js";

/**
 * A CREDENTIAL ROUTE'S 401 IS AN ANSWER — the paired browser's transport. A wrong confirmation
 * code is refused 401, which is also what a lapsed access token gets, so a renewal there would send
 * the same code twice: two attempts against the sign-in throttle and a rotated pairing per wrong code.
 * The first 401 comes back as the door said it; an ordinary stale token still renews and replays
 * once. The routes are held to the server by `factor-routes-never-refresh.test.ts`.
 */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const WRONG_CODE = { error: { code: "unauthorized", message: "two-factor verification failed" } };

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

/** The door: a factor route refuses every code, `/messages` refuses only the lapsed token. */
function door() {
  const sent: Array<{ path: string; auth: string | undefined }> = [];
  const firsts: Response[] = [];
  let renewals = 0;
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as { headers?: Record<string, string> };
    if (url === "/auth/refresh") {
      renewals += 1;
      return json(200, { tokens: { accessToken: "access-2", refreshToken: "refresh-2" } });
    }
    sent.push({ path: url, auth: i.headers?.authorization });
    if (url.startsWith("/messages")) {
      return i.headers?.authorization === "Bearer access-2" ? json(200, { messages: [] }) : json(401, { error: { code: "unauthorized" } });
    }
    const refused = json(401, WRONG_CODE);
    firsts.push(refused);
    return refused;
  };
  const bearer = new BearerManager({ storage: memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" }), fetchImpl });
  return { bearer, sent, firsts, renewals: () => renewals };
}

describe("the paired browser hands a credential route's 401 back as it came", () => {
  it("a wrong step-up code is posted once, nothing renews, and the caller reads the door's 401", async () => {
    const d = door();
    const res = await d.bearer.fetch("/auth/step-up/totp", { method: "POST", body: JSON.stringify({ code: "000000" }) });
    expect(d.sent.map((s) => s.path), "the code went out twice").toEqual(["/auth/step-up/totp"]);
    expect(d.renewals(), "a wrong code rotated the pairing").toBe(0);
    expect(res, "the 401 the caller reads is not the one the door sent").toBe(d.firsts[0]);
    expect(await res.json()).toEqual(WRONG_CODE);
    expect(d.bearer.paired(), "an answer ended the pairing").toBe(true);
  });

  it("the same for a spent pairing code, with a query string, and asked by its full address", async () => {
    for (const url of ["/pair/redeem", "/auth/2fa/totp/activate?lang=de", "http://door.test/auth/step-up/totp"]) {
      const d = door();
      const res = await d.bearer.fetch(url, { method: "POST" });
      expect([res.status, d.sent.length, d.renewals()], url).toEqual([401, 1, 0]);
    }
  });

  it("POSITIVE: a stale access token on /messages still renews once and replays once", async () => {
    const d = door();
    const res = await d.bearer.fetch("/messages?limit=50", { method: "GET" });
    expect(res.status).toBe(200);
    expect(d.renewals()).toBe(1);
    expect(d.sent).toEqual([
      { path: "/messages?limit=50", auth: undefined },
      { path: "/messages?limit=50", auth: "Bearer access-2" },
    ]);
  });
});
