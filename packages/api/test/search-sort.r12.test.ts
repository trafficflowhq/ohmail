import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { SEARCH_SORTS } from "@trafficflow/services/mail";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedBody, seedSearchDocuments, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * the HTTP half: `GET /search?sort=` is VALIDATED, and the value it accepts reaches
 * the service rather than being parsed and dropped.
 *
 * The service's own ordering is proven in `packages/services/test/search-sort.r12.test.ts` over
 * a corpus large enough for the relevance window to truncate. What is proven HERE is the seam,
 * because a route can pass every ordering test it has by ignoring the parameter entirely — the
 * results still come back, still sorted by SOMETHING, and the only symptom is that the control
 * on screen does nothing.
 */
describe("GET /search?sort=", () => {
  /** Three messages, one query, three different dates — enough for an order to be visible. */
  const corpus = async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    const mk = async (subject: string, date: Date, fromAddress: string): Promise<string> => {
      const m = await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb, folder: "INBOX", subject, fromAddress, date,
      });
      await seedBody(db, { messageId: m.id, text: "the heron stood in the shallows" });
      return m.id;
    };
    const old = await mk("heron one", new Date("2026-07-01T09:00:00Z"), "zoe@late.example");
    const mid = await mk("heron two", new Date("2026-07-10T09:00:00Z"), "anna@early.example");
    const recent = await mk("heron three", new Date("2026-07-20T09:00:00Z"), "mike@mid.example");
    await seedSearchDocuments(db, s.accountId);
    return { deps, token: s.token, old, mid, recent };
  };

  const ids = async (res: Response): Promise<string[]> =>
    ((await res.json()) as { items: Array<{ id: string }> }).items.map((m) => m.id);

  it("an UNKNOWN sort is 400 — never coerced to relevance", async () => {
    const { deps, token } = await corpus();

    // The value a client is most likely to invent, and the one a stale build would send.
    const res = await H(req("GET", "/search?q=heron&sort=newest", { bearer: token }), deps);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_failed");
    // The message NAMES the accepted set, so a caller can fix it without reading our source.
    for (const s of SEARCH_SORTS) expect(body.error.message).toContain(s);

    // Case matters, and an empty `sort=` is a value the caller supplied rather than an absence.
    expect((await H(req("GET", "/search?q=heron&sort=DATE_DESC", { bearer: token }), deps)).status).toBe(400);
    expect((await H(req("GET", "/search?q=heron&sort=", { bearer: token }), deps)).status).toBe(400);
    // And the shape somebody would try if they thought this was interpolated into SQL.
    expect((await H(req("GET", "/search?q=heron&sort=m.date+desc", { bearer: token }), deps)).status).toBe(400);
  });

  it("every declared sort is accepted", async () => {
    const { deps, token } = await corpus();
    for (const sort of SEARCH_SORTS) {
      const res = await H(req("GET", `/search?q=heron&sort=${sort}`, { bearer: token }), deps);
      expect(res.status, sort).toBe(200);
    }
  });

  it("the param REACHES the service — date_desc and date_asc are mirror images", async () => {
    const { deps, token, old, mid, recent } = await corpus();

    // THE GUARD against a route that parses `sort` and then forgets it: a forgotten param makes
    // these two arrays identical, and both assertions below fail at once.
    const desc = await ids(await H(req("GET", "/search?q=heron&sort=date_desc", { bearer: token }), deps));
    const asc = await ids(await H(req("GET", "/search?q=heron&sort=date_asc", { bearer: token }), deps));

    expect(desc).toEqual([recent, mid, old]);
    expect(asc).toEqual([old, mid, recent]);
  });

  it("sender order comes back alphabetical by address", async () => {
    const { deps, token, old, mid, recent } = await corpus();
    const bySender = await ids(await H(req("GET", "/search?q=heron&sort=sender", { bearer: token }), deps));
    // anna@ · mike@ · zoe@.
    //
    // THIS IS NOT A SEAM GUARD, and it is worth saying so where somebody will read it: on this
    // three-row corpus the RRF ranking happens to produce the same order, so a route that
    // validated `sort` and then dropped it passes this assertion unchanged (measured — it stayed
    // green through the mutation that removed the forwarding). The date pair above is what
    // watches the seam. This one is here for the sender key itself.
    expect(bySender).toEqual([mid, recent, old]);
  });

  it("an ABSENT sort is unchanged behaviour — the same answer as sort=relevance", async () => {
    const { deps, token } = await corpus();

    // The endpoint's whole prior contract. Every existing caller takes this branch, so it is the
    // one that must not have moved.
    const absent = await H(req("GET", "/search?q=heron", { bearer: token }), deps);
    const explicit = await H(req("GET", "/search?q=heron&sort=relevance", { bearer: token }), deps);
    expect(absent.status).toBe(200);
    // Byte-identical but for `ms`, the server time each answer reports about itself.
    const same = async (r: Response) => JSON.stringify({ ...(JSON.parse(await r.clone().text()) as object), ms: 0 });
    expect(await same(absent)).toBe(await same(explicit));
  });

  it("validation happens BEFORE the query — a bad sort on a blank q is still 400", async () => {
    const { deps, token } = await corpus();
    // A blank `q` short-circuits to an empty result inside the service. If the check sat after
    // that, a malformed request would get a cheerful 200 with an empty list — the failure mode
    // where a broken client looks like an empty mailbox.
    const res = await H(req("GET", "/search?q=&sort=newest", { bearer: token }), deps);
    expect(res.status).toBe(400);
  });

  it("still requires a session — a sort does not open the door", async () => {
    const { deps } = await corpus();
    const res = await H(req("GET", "/search?q=heron&sort=date_desc"), deps);
    expect(res.status).toBe(401);
  });
});

/**
 * ═══ THE TWO VOCABULARIES ARE ONE VOCABULARY ═══════════════════════════════════════════════
 *
 * `SEARCH_SORTS` is declared twice in this repository, and it has to be. The server's copy is in
 * `packages/services/src/search-service.ts`; the client's is `SERVER_SEARCH_SORTS` in
 * `packages/client-engine/src/engine.ts`, which is the STANDALONE GPL desktop payload and may not
 * import a hosted service — the same reason `owner-cookie.ts` repeats a cookie name rather than
 * importing the API's constant.
 *
 * Two lists that must agree and cannot be made to share code get a test that reads both files.
 * The failure it prevents is one-sided and quiet: add a sixth order to the server and the client
 * never offers it (harmless, merely absent), but add it to the CLIENT and every user who picks it
 * gets a 400 from a route that has never heard of it.
 *
 * Textual on purpose — importing the client package here would put an engine dependency in the
 * API's test graph, and the point is to catch a drift in the SOURCE, not in whatever a build
 * happens to resolve.
 */
const ENGINE_SRC = fileURLToPath(
  new URL("../../client-engine/src/engine.ts", import.meta.url),
);

describe("the client's sort vocabulary matches the server's", () => {
  it("SERVER_SEARCH_SORTS is exactly SEARCH_SORTS, in the same order", () => {
    // `/usr/bin/grep -a` exists for a reason in this repo: a stray NUL makes tooling skip a file
    // silently. `readFileSync` has no such behaviour — it either returns the bytes or throws.
    const src = readFileSync(ENGINE_SRC, "utf8");
    const decl = /export const SERVER_SEARCH_SORTS = \[([^\]]*)\] as const;/.exec(src);
    expect(decl, "SERVER_SEARCH_SORTS declaration not found in engine.ts").not.toBeNull();

    const clientSide = decl![1]!
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);

    // Order matters as well as membership: it is the order the control renders its options in,
    // and the first entry is the default at every layer.
    expect(clientSide).toEqual([...SEARCH_SORTS]);
  });
});
