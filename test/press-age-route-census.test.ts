import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { apiRoutes, matchRoute, type Route } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { HttpAdapter, PRESS_AGE_KINDS } from "@ohmail/client-engine";

/**
 * THE PRESS AGE REACHES EVERY STATE VERB'S ROUTE, AND NO OTHER. A route that forgets
 * `pressAge: true` keeps the unconditional replay past a day and nothing fails; an adapter case
 * that forgets to stamp the header (a DELETE has no body path) is the same hole one layer up. The
 * set is DERIVED: the engine's `PRESS_AGE_KINDS` driven through the real HTTP adapter with a
 * recording fetch, each request matched against the route table — both directions, both tables.
 */
const ID = "11111111-1111-4111-8111-111111111111";
const TAG = "22222222-2222-4222-8222-222222222222";
const SAMPLE: Record<string, EngineMutation> = {
  move: { kind: "move", messageId: ID, folder: "ohmail/News" },
  message_delete: { kind: "message_delete", messageId: ID },
  triage_set: { kind: "triage_set", messageId: ID, state: "set_aside" },
  tag_assign: { kind: "tag_assign", messageId: ID, tagId: TAG, assigned: true },
  mark_seen: { kind: "mark_seen", messageIds: [ID], unread: false },
  feed_mark_seen: { kind: "feed_mark_seen", messageIds: [ID] } as EngineMutation,
};
const AGE = 90_061_000;

async function recorded(): Promise<Array<{ method: string; path: string; age: string | null }>> {
  const seen: Array<{ method: string; path: string; age: string | null }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? "GET", path: String(url).replace("http://h", ""), age: headers.get("x-ohmail-press-age") });
    return new Response(JSON.stringify({ id: ID, updatedAt: new Date(0).toISOString(), restoreTo: "INBOX", pending: true }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const adapter = new HttpAdapter({ baseUrl: "http://h", fetch: fetchImpl as typeof fetch });
  for (const kind of PRESS_AGE_KINDS) {
    expect(SAMPLE[kind], `${kind} is a press-age kind with no sample here — add one`).toBeDefined();
    await adapter.mutate(SAMPLE[kind]!, { idempotencyKey: `k-${kind}`, pressAgeMs: AGE });
  }
  await adapter.restoreFromTrash(ID, { idempotencyKey: "k-restore", pressAgeMs: AGE });
  return seen;
}

const flagged = (routes: readonly Route[]): string[] =>
  routes.filter((r) => r.options?.pressAge === true).map((r) => `${r.method} ${r.pattern}`).sort();

describe("the press age's route table", () => {
  it("every request a press-age verb makes carries the age, DELETE included, and lands on a flagged route", async () => {
    const seen = await recorded();
    expect(seen.map((r) => r.method)).toContain("DELETE");
    for (const r of seen) {
      expect([r.method, r.path, r.age]).toEqual([r.method, r.path, String(AGE)]);
      const m = matchRoute(apiRoutes, r.method, r.path);
      expect(m.matched && m.route.options?.pressAge, `${r.method} ${r.path} is not flagged pressAge`).toBe(true);
    }
  });

  it("the flagged set is exactly the routes those verbs reach — on the hosted table and the local one", async () => {
    const reached = [...new Set((await recorded()).map((r) => {
      const m = matchRoute(apiRoutes, r.method, r.path);
      return m.matched ? `${m.route.method} ${m.route.pattern}` : `${r.method} ${r.path}`;
    }))].sort();
    expect(flagged(apiRoutes)).toEqual(reached);
    expect(flagged(localRoutes)).toEqual(reached);
  });

  it("sends, Screener decisions and rule verbs take no age", () => {
    for (const k of ["mail_send", "screener_decide", "rule_create", "rule_update", "rule_delete", "draft_save"]) {
      expect(PRESS_AGE_KINDS.has(k), k).toBe(false);
    }
  });
});
