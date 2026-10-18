import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, unsubscribeRoutesGroup, type ApiDeps } from "@trafficflow/api";
import { messages, folderState, learningSignals, rules, unsubscribeRecords } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { NO_TRUSTED_AUTHSERV_IDS } from "@trafficflow/core/mail";
import type { OneClickPost, ServiceContext } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedBody, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * `POST /messages/:id/unsubscribe` over HTTP.
 *
 * **No sender is contacted.** `makeDeps` injects a recording {@link OneClickPost} that opens no
 * socket; a test that wants to prove nothing was sent injects one that throws.
 */

const ONE_CLICK_HEADERS = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};

function spyPost(status = 200): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status }; } };
}

const FORBIDDEN: OneClickPost = {
  async post(url: string) { throw new Error(`nothing should have been sent, but got ${url}`); },
};

/** A message the user has screened out, carrying a real one-click header. */
async function seedScreenedOut(
  db: Awaited<ReturnType<typeof makeDeps>>["db"],
  accountId: string,
  headers: Record<string, unknown> = ONE_CLICK_HEADERS,
): Promise<string> {
  const { id } = await seedMessage(db, { accountId, folder: "ohmail/Screened", fromAddress: "news@sender.example" });
  await seedBody(db, { messageId: id, headers });
  return id;
}

describe("the route table", () => {
  it("mounts one unsubscribe PRESS, a POST that opens a connection — and no route takes a url", () => {
    expect(unsubscribeRoutesGroup.map((r) => `${r.method} ${r.pattern}`))
      .toEqual(["POST /messages/:id/unsubscribe"]);
    // `connection` and not `work`: this process opens a socket to a sender-chosen host, and that
    // is the class an audit of outbound connections looks at.
    expect(unsubscribeRoutesGroup[0]!.cost).toBe("connection");
    // Not idempotent-marked: the effect lives at a third party, where a replayed stored response
    // would be a promise we cannot keep.
    expect(unsubscribeRoutesGroup[0]!.options?.idempotent).toBeUndefined();
    expect(unsubscribeRoutesGroup[0]!.options?.public).toBeUndefined();
    // There is NO route that takes a url, and that is the property — the count was only ever
    // how it was spelled. The press takes a message id in the path; the scheduler's DRAIN takes
    // no input at all: no body, no query, no path parameter, the shared secret is the whole
    // request. Neither can be pointed at a host a caller chose.
    const named = apiRoutes.filter((r) => r.pattern.includes("unsubscribe"))
      .map((r) => `${r.method} ${r.pattern}`).sort();
    expect(named).toEqual(["GET /internal/unsubscribe/drain", "POST /messages/:id/unsubscribe"]);
  });
});

describe("POST /messages/:id/unsubscribe", () => {
  it("posts one-click for a screened-out sender and answers with what happened", async () => {
    const post = spyPost();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: post });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId);

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(post.calls).toEqual(["https://sender.example/u?t=abc"]);
    expect(await res.json()).toMatchObject({
      messageId: id, posted: true, status: 200, refusal: null,
      header: "one_click", authVerdict: "unavailable",
    });
  });

  it("a link the SSRF gate refuses answers in the person's words — never the gate's `u …`", async () => {
    // GUARD-STRING-STILL-REACHES-THE-OTHER-FETCH-ROUTES: the press used to answer
    // "u is not a permitted url: host resolves to a non-public address" — the gate's own wording,
    // naming a parameter this route does not have (the URL is the sender's header). Driven
    // through the REAL gate by an injected resolver, the img rig's arrangement, so a reworded
    // core reason reddens here instead of leaking through.
    const { db, deps } = await makeDeps(FIXED_NOW, {}, {
      oneClickPost: FORBIDDEN,
      resolver: { async resolve() { return ["169.254.169.254"]; } },
    });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId);

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("validation_failed");
    expect(error.message).toBe(
      "The unsubscribe address this sender provided points inside a private network, so it was not contacted.",
    );
    expect(error.message).not.toContain("not a permitted url");
    expect(error.message).not.toMatch(/^u /);
  });

  it("an unresolvable link says the server could not be found — and a non-gate error passes through", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, {
      oneClickPost: FORBIDDEN,
      resolver: { async resolve() { return []; } },
    });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId);

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.message).toBe(
      "The unsubscribe address this sender provided points at a server that could not be found. Nothing was sent.",
    );
    // The positive control lives above: the ordinary press posts and answers 200 through the
    // same wrapped handler, so the mapping demonstrably admits what it should.
  });

  it("the URL is read from the STORED headers — the request body names nothing", async () => {
    const post = spyPost();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: post });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId, {
      "list-unsubscribe": ["<https://only-this-host.example/leave>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    });

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, {
      bearer: s.token, body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
    }), deps);
    expect(res.status).toBe(200);
    expect(post.calls).toEqual(["https://only-this-host.example/leave"]);
  });

  it("a mailto:-only sender is a 409 and NOTHING is sent", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: FORBIDDEN });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId, {
      "list-unsubscribe": ["<mailto:leave@sender.example>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    });

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error?.code).toBe("unsubscribe_mailto_only");
  });

  it("a trusted dkim=fail is a 409, nothing is sent, and the verdict lands on the row", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, {
      oneClickPost: FORBIDDEN, trustedAuthservIds: new Set(["mx.provider.example"]),
    });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId, {
      ...ONE_CLICK_HEADERS,
      "authentication-results": ["mx.provider.example; dkim=fail header.d=sender.example"],
    });

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error?.code).toBe("unsubscribe_author_failed_authentication");

    const [row] = await db.select({ v: messages.authVerdict }).from(messages).where(eq(messages.id, id));
    expect(row!.v).toBe("fail");
  });

  it("a message still waiting in the Screener is a 409 — the user has not decided", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: FORBIDDEN });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "ohmail/Screener" });
    await seedBody(db, { messageId: id, headers: ONE_CLICK_HEADERS });

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error?.code).toBe("unsubscribe_not_actionable");
    // …and the folder is untouched: a refusal moves nothing.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("ohmail/Screener");
  });

  it("no session → 401, before any service runs", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: FORBIDDEN });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId);

    const res = await H(req("POST", `/messages/${id}/unsubscribe`), deps);
    expect(res.status).toBe(401);
  });

  it("another account's message → 404", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: FORBIDDEN });
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const id = await seedScreenedOut(db, other.accountId);

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(res.status).toBe(404);
  });

  it("a deployment with no UnsubscribeService answers 503, not 500", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: FORBIDDEN });
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedScreenedOut(db, s.accountId);
    const { unsubscribe: _omitted, ...services } = deps.services!;

    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), { ...deps, services });
    expect(res.status).toBe(503);
    expect((await res.json()).error?.code).toBe("unsubscribe_unconfigured");
  });
});

/**
 * THE AUTOMATIC ARM WANTS A SENDER THE MAILBOX'S PROVIDER CONFIRMED. At a host with no known
 * authserv-id every verdict is `unavailable`, so nothing tells a forged `From` from the list's own:
 * the drain asks nobody and claims nothing, and the person's own press on the same letter still
 * posts. The control is a Gmail-held mailbox whose provider confirmed the sender.
 */
describe("the automatic arm and a sender nobody confirmed", () => {
  const SECRET = "s".repeat(32);
  const drain = (): Request => new Request("http://api.test/internal/unsubscribe/drain", {
    method: "GET", headers: { authorization: `Bearer ${SECRET}` },
  });
  const CONFIRMED = {
    ...ONE_CLICK_HEADERS,
    "authentication-results": ["mx.google.com; spf=pass; dkim=pass header.d=sender.example; dmarc=pass"],
  };

  /** A screened-out letter whose sender a PERSON screened out, the automatic arm's only licence. */
  async function screenedOutByAPerson(
    db: Awaited<ReturnType<typeof makeDeps>>["db"], deps: ApiDeps, headers: Record<string, unknown>,
  ) {
    const s = await seedSession(db, { now: deps.now() });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const { id } = await seedMessage(db, {
      accountId: s.accountId, mailboxId, fromAddress: "news@sender.example", folder: "ohmail/Screened",
    });
    await seedBody(db, { messageId: id, headers });
    await db.insert(rules).values({ accountId: s.accountId, kind: "sender", match: "news@sender.example",
      destination: "ohmail/Screened", provenance: "promoted", personDecidedAt: deps.now() });
    await db.insert(learningSignals).values({ accountId: s.accountId, triggeringActionId: `screener:${crypto.randomUUID()}`,
      kind: "screener", senderAddress: "news@sender.example", destination: "ohmail/Screened", label: "positive" });
    const ctx: ServiceContext = { db, accountId: s.accountId, userId: null, now: deps.now, requestId: "t" };
    return { s, id, ctx };
  }
  const recordsOf = (db: Awaited<ReturnType<typeof makeDeps>>["db"], id: string) =>
    db.select().from(unsubscribeRecords).where(eq(unsubscribeRecords.messageId, id));

  it("no trusted provider: the drain asks nothing and claims nothing; the person's press then posts", async () => {
    const post = spyPost();
    const { db, deps } = await makeDeps(undefined, {}, { oneClickPost: post, trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS });
    const { s, id, ctx } = await screenedOutByAPerson(db, deps, ONE_CLICK_HEADERS);

    const drained = await H(drain(), { ...deps, alerts: { secret: SECRET, cronSecret: SECRET, sinks: [] } });
    expect(drained.status).toBe(200);
    expect(await drained.json()).toMatchObject({ claimed: 1, delivered: 0, skipped: 1, failed: 0 });
    expect(post.calls).toEqual([]);
    expect(await recordsOf(db, id)).toHaveLength(0);

    // The refusal by name, from the arm the drain runs (a private body: the pass never throws).
    const arm = deps.services!.unsubscribe as unknown as {
      run(c: ServiceContext, messageId: string, mode: "automatic"): Promise<unknown>;
    };
    await expect(arm.run(ctx, id, "automatic"))
      .rejects.toMatchObject({ code: "unsubscribe_sender_identity_unverified", httpStatus: 409 });
    expect(post.calls).toEqual([]);
    expect(await recordsOf(db, id)).toHaveLength(0);

    // A person looking at the letter is not the pass: the button posts.
    const pressed = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toMatchObject({ posted: true, refusal: null, authVerdict: "unavailable" });
    expect(post.calls).toEqual(["https://sender.example/u?t=abc"]);
  });

  it("CONTROL: a Gmail-held mailbox whose provider confirmed the sender is unsubscribed by the drain", async () => {
    const post = spyPost();
    const { db, deps } = await makeDeps(undefined, {}, { oneClickPost: post, trustedAuthservIds: new Set(["mx.google.com"]) });
    const { id } = await screenedOutByAPerson(db, deps, CONFIRMED);

    const drained = await H(drain(), { ...deps, alerts: { secret: SECRET, cronSecret: SECRET, sinks: [] } });
    expect(await drained.json()).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(post.calls).toEqual(["https://sender.example/u?t=abc"]);
    const records = await recordsOf(db, id);
    expect(records.map((r) => r.state)).toEqual(["sent"]);
  });
});
