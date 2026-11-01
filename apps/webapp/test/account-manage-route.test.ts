import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/account/manage` — mint a fresh account-page link and leave for it, or send the person through
 * `/login?next=manage`. Driven through the ROUTE HANDLER the build serves, with the API stubbed at
 * `fetch`, so the cookie read, the Bearer, the language and the redirect are all the door's own.
 */

process.env.TF_API_ORIGIN = "https://api.ohmail.app";
const TOKEN = "A".repeat(43);
const PLANE = "https://plane.ohmail.app/manage?token=t1";

type Seen = { url: string; method: string; auth: string | null; body: string | null };
let seen: Seen[] = [];
let answer: () => Response | Promise<Response> = () => json({ url: PLANE }, 200);

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  seen = [];
  answer = () => json({ url: PLANE }, 200);
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input), method: init?.method ?? "GET", auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return answer();
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

async function route() {
  return import("../app/(product)/account/manage/route.js");
}

const get = (headers: Record<string, string> = {}, method = "GET"): Request =>
  new Request("https://ohmail.app/account/manage", { method, headers });

describe("no session: the sign-in continues here", () => {
  it("GET without a cookie is 307 to /login?next=manage and asks nobody", async () => {
    const { GET } = await route();
    const res = await GET(get());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login?next=manage");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(seen).toEqual([]);
  });

  it("HEAD answers the same without a cookie — the deploy's curl reads this", async () => {
    const { HEAD } = await route();
    const res = HEAD(get({}, "HEAD"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login?next=manage");
  });

  it("a token the API refuses (401) goes to the sign-in, which renews it when it can", async () => {
    answer = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    const { GET } = await route();
    const res = await GET(get({ cookie: `tf_session=${TOKEN}` }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login?next=manage");
    expect(seen).toHaveLength(1);
  });
});

describe("a session: the mint is asked once, and its answer is where the person goes", () => {
  it("POSTs the manage link as a Bearer with the page's language, and 302s to the answer", async () => {
    const { GET } = await route();
    const res = await GET(get({ cookie: `ohmail.locale=de; tf_session=${TOKEN}` }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PLANE);
    expect(seen).toEqual([{
      url: "https://api.ohmail.app/account/manage-link", method: "POST",
      auth: `Bearer ${TOKEN}`, body: JSON.stringify({ lang: "de" }),
    }]);
  });

  it("no language cookie names no language", async () => {
    const { GET } = await route();
    await GET(get({ cookie: `tf_session=${TOKEN}` }));
    expect(seen[0]!.body).toBe("{}");
  });

  it("HEAD and a prefetch never mint", async () => {
    const { GET, HEAD } = await route();
    expect(HEAD(get({ cookie: `tf_session=${TOKEN}` }, "HEAD")).status).toBe(204);
    expect((await GET(get({ cookie: `tf_session=${TOKEN}`, "sec-purpose": "prefetch" }))).status).toBe(204);
    expect((await GET(get({ cookie: `tf_session=${TOKEN}`, purpose: "prefetch" }))).status).toBe(204);
    expect(seen).toEqual([]);
  });

  it("a mint that fails in any other way sends the person back to the app", async () => {
    const { GET } = await route();
    for (const make of [
      () => json({ error: { code: "internal", message: "x" } }, 500),
      () => json({ error: { code: "email_unverified", message: "x" } }, 403),
      () => json({ error: { code: "no_manage_surface", message: "x" } }, 404),
      () => new Response("not json", { status: 200 }),
      () => { throw new Error("network down"); },
    ]) {
      answer = make;
      const res = await GET(get({ cookie: `tf_session=${TOKEN}` }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  });
});

describe("a sign-out the server has not confirmed: the jar's session is nobody's to use here", () => {
  const PENDING = `tf_owner=signed_out_pending; tf_session=${TOKEN}`;

  it("GET is 307 to /login?next=manage and asks nobody, whatever token the jar still holds", async () => {
    const { GET } = await route();
    const res = await GET(get({ cookie: PENDING }));
    expect(res.status, "the previous person's account page was minted").toBe(307);
    expect(res.headers.get("location")).toBe("/login?next=manage");
    expect(seen).toEqual([]);
  });

  it("HEAD and a prefetch answer the same 307", async () => {
    const { GET, HEAD } = await route();
    const head = HEAD(get({ cookie: PENDING }, "HEAD"));
    const pre = await GET(get({ cookie: PENDING, "sec-purpose": "prefetch" }));
    for (const res of [head, pre]) expect([res.status, res.headers.get("location")]).toEqual([307, "/login?next=manage"]);
  });

  it("control: a marker naming an account still mints", async () => {
    const { GET } = await route();
    const res = await GET(get({ cookie: `tf_owner=acct-1; tf_session=${TOKEN}` }));
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
  });
});

describe("never an open redirect", () => {
  it("leaves only for https on ohmail.app or a subdomain of it", async () => {
    const { mayLeaveFor } = await import("../app/manage-handoff.js");
    for (const ok of [PLANE, "https://ohmail.app/x", "https://a.b.ohmail.app/"]) {
      expect(mayLeaveFor(ok), ok).toBe(true);
    }
    const USER = "u", PASS = "p";
    for (const bad of [
      "https://evil.example/manage", "http://plane.ohmail.app/manage", "https://evilohmail.app/",
      "https://ohmail.app.evil.example/", `https://${USER}:${PASS}@plane.ohmail.app/`, "javascript:alert(1)",
      "/relative", "", 7, null,
    ]) {
      expect(mayLeaveFor(bad), String(bad)).toBe(false);
    }
  });

  it("a mint that answers a foreign host sends the person to the app, not there", async () => {
    answer = () => json({ url: "https://evil.example/manage?token=t" }, 200);
    const { GET } = await route();
    const res = await GET(get({ cookie: `tf_session=${TOKEN}` }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });
});
