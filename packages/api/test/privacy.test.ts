import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes, privacyRoutesGroup, type ApiDeps } from "@trafficflow/api";
import { accountSettings, messages, trackerEvents } from "@trafficflow/db";
import { DbAcquireTimeoutError, DbConnectionCapError } from "@trafficflow/db/cloud";
import { PROXY_URL_MAX_CHARS, ServiceError } from "@trafficflow/services/mail";
import {
  makeDeps, seedSession, seedMessage, seedBody, req, FIXED_NOW,
} from "./helpers.js";
import { PNG_2X3 } from "../../core/test/fixtures/images.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * ── `GET /img` IS MOUNTED AGAIN, AND THE CONSUMER IS NAMED ────────────────────────
 *
 * This block used to assert the opposite, and the assertion was right for as long as
 * its stated reason held: the endpoint had **zero consumers**, so it could only ever
 * be reached by an attacker, and deleting the route deleted the whole attack surface
 * rather than narrowing it.
 *
 * THE NEW CONSUMER, named rather than implied — this is not a weakened assertion, it
 * is the same one re-decided against a fact that changed:
 *
 *   `apps/webapp/app/shell/remote-images.ts`   builds `/img?mid=…&u=…`
 *   `apps/webapp/app/shell/MessagePane.tsx`    hands it to `MessageBody` as `imageProxy`
 *   `apps/webapp/app/components/MessageBody.tsx` rewrites every consented `<img src>`
 *                                              and CSS `url()` through it
 *   `apps/webapp/test/remote-images.test.tsx`  asserts the RENDERED frame does it
 *
 * The reading path now blocks a pixel by default and offers one consented way to load
 * a picture — which is the sentence `MessageBody.tsx:96-101` said was waiting on a
 * route, and the reason the route exists at all.
 *
 * WHAT MUST STAY TRUE is therefore no longer "it is absent". It is the two gates
 * below: the SSRF refusal in front of the fetch (proven in depth, with a real socket
 * count, in `packages/services/test/privacy-service.test.ts`) and the response
 * hardening in `routes/privacy.ts`, which that service test cannot see because it
 * never builds a `Response`.
 */
describe("GET /img is mounted, and answers only as a bounded image", () => {
  it("is one route, `connection`-cost, and raw", () => {
    const img = apiRoutes.filter((r) => r.pattern === "/img");
    expect(img).toHaveLength(1);
    expect(privacyRoutesGroup.map((r) => `${r.method} ${r.pattern}`)).toContain("GET /img");
    // it opens a socket to a host the sender named. An unverified account must not
    // reach it, and `cost` is the only thing that decides that.
    expect(img[0]!.cost).toBe("connection");
    expect(img[0]!.options?.raw).toBe(true);
    // …and NOT public: `mid` is an authorisation, and it is only one if a session is
    // resolved before the handler runs.
    expect(img[0]!.options?.public ?? false).toBe(false);
    expect(img[0]!.options?.anonymous ?? false).toBe(false);
  });

  it("serves the bytes under nosniff + a no-op CSP, and never names a file", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    // The reader has pressed "Show images": `proxyImage` refuses an unconsented message 403
    // before it opens a socket, so every 200 below is a test of the CONSENTED path.
    await seedBody(db, { messageId: id, html: "<img src='https://x/p.png'>", loadedRemoteContent: true });

    const u = "https://images.acme-cdn.com/hero.png";
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    // THE THREE THAT MAKE SENDER-CHOSEN BYTES INERT ON THE SESSION ORIGIN. Each is a
    // separate mutation in `routes/privacy.ts` and each reds this line on its own.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    // `inline` with NO filename: the sender does not get to name a file on the reader's
    // disk, and this is a subresource rather than a download.
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("content-disposition")).not.toMatch(/filename/i);
    // Never a shared cache: one account's image under a url another could ask for.
    expect(res.headers.get("cache-control")).toMatch(/(^|,\s*)private\b/);
  });

  /**
   * A SERVED IMAGE IS KEPT A DAY, IN THE READER'S OWN CACHE; A REFUSAL IS NOT KEPT. Re-opening an
   * image-heavy message after five minutes cost one function run and one fetch per image — the
   * proxy was the API's largest CPU consumer. `private` stays: never a shared cache. A refusal
   * (consent, type, ownership) carries no lifetime, so a later "Show images" is never answered
   * by a cached 403.
   */
  it("a served image is cached privately for a day, and a refusal is not cached at all", async () => {
    const answering = (contentType: string) => ({
      remote: { async fetch() { return { status: 200, contentType, body: PNG_2X3 }; } },
    });
    const u = encodeURIComponent("https://images.acme-cdn.com/hero.png");
    const seeded = async (d: Awaited<ReturnType<typeof makeDeps>>) => {
      const s = await seedSession(d.db, { now: FIXED_NOW });
      const other = await seedSession(d.db, { now: FIXED_NOW, token: "other-cache-tok" });
      const { id } = await seedMessage(d.db, { accountId: s.accountId, folder: "INBOX" });
      await seedBody(d.db, { messageId: id, html: "<img>", loadedRemoteContent: true });
      return { own: s.token, other: other.token, id };
    };

    const png = await makeDeps(FIXED_NOW, {}, answering("image/png"));
    const a = await seeded(png);
    const served = await H(req("GET", `/img?mid=${a.id}&u=${u}`, { bearer: a.own }), png.deps);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control"), "a served image's lifetime").toBe("private, max-age=86400");
    // …keyed on the session (IMG-CACHE-KEPT-WHERE-CLEAR-SITE-DATA-IS-IGNORED): a browser that
    // ignores the purge after a sign-out, or never sent it, keeps a picture only until the cookie rotates.
    expect(served.headers.get("vary"), "a served image does not vary on the session").toBe("Cookie");
    const refusedOwner = await H(req("GET", `/img?mid=${a.id}&u=${u}`, { bearer: a.other }), png.deps);

    const svg = await makeDeps(FIXED_NOW, {}, answering("image/svg+xml"));
    const b = await seeded(svg);
    const refusedType = await H(req("GET", `/img?mid=${b.id}&u=${u}`, { bearer: b.own }), svg.deps);

    for (const [name, res, status] of [["ownership", refusedOwner, 404], ["type", refusedType, 415]] as const) {
      expect(res.status, name).toBe(status);
      expect(res.headers.get("cache-control"), `the ${name} refusal carries a lifetime`).toBeNull();
      expect(res.headers.get("vary"), `the ${name} refusal was keyed as if it were kept`).toBeNull();
    }
  });

  /**
   * ── IT MUST NEVER ANSWER 3xx, AND THAT IS A CSP FACT RATHER THAN AN HTTP PREFERENCE ─
   *
   * The message frame's `img-src` names this route's own PATH — `data: <origin>/api/img`
   * — instead of `'self'`, which is what stops a url the sanitizer let through from
   * being an authenticated GET at any path on the session origin
   * (`apps/webapp/app/components/MessageBody.tsx`, `proxyImgSource`).
   *
   * **A path in a CSP source expression is not matched across a redirect.** Measured in
   * Chromium rather than read: with `img-src http://host/redir`, a `302` from `/redir`
   * to `/api/REDIRECTED-TARGET` was followed and fetched, while every non-matching path
   * requested directly was refused. That is deliberate in the spec — path matching on a
   * redirect would leak cross-origin path information — and it means the ONE url the
   * frame may name is also the one place the narrowing could be walked around: a 3xx
   * here would let a sender's `u=` steer a second request to any path of ours, with the
   * session cookie on it, and the policy would not object.
   *
   * The route cannot do that today — every answer is `imageResponse`'s 200 or an
   * `errorResponse` 4xx/5xx — so this is a guard on a property that already holds,
   * pinned where the next editor will trip over it rather than left as a fact about
   * today's control flow. `Location` is asserted absent too: a 200 carrying one is not a
   * redirect to a browser, but it is exactly the half-change that precedes becoming one.
   *
   * Mutation: return `new Response(null, { status: 302, headers: { Location: target } })`
   * from the handler's success path. Real failure text:
   *   AssertionError: /img answered a redirect from the served arm, which walks around
   *   the frame's img-src path: expected 302 to be false
   */
  it("never answers a redirect, because a path in img-src is not matched across one", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });

    // Both arms of the route: the one that serves bytes, and one that refuses. Neither
    // may be a 3xx, and a refusal is the arm an editor is likeliest to "helpfully" turn
    // into a redirect to a placeholder image.
    const served = await H(
      req("GET", `/img?mid=${id}&u=${encodeURIComponent("https://images.acme-cdn.com/hero.png")}`,
        { bearer: s.token }), deps,
    );
    const refused = await H(
      req("GET", `/img?mid=${id}&u=${encodeURIComponent("http://127.0.0.1/admin")}`,
        { bearer: s.token }), deps,
    );
    // 3xx SPECIFICALLY, not "below 300" — the refused arm is a 4xx by design, and an
    // assertion that reddened on its correct refusal would be weakened away next week.
    for (const [what, res] of [["the served arm", served], ["the refused arm", refused]] as const) {
      expect(res.status >= 300 && res.status < 400,
        `/img answered a redirect from ${what}, which walks around the frame's img-src path: ` +
        `expected ${res.status} to be false`).toBe(false);
      expect(res.headers.get("location"), `/img set a Location from ${what}`).toBeNull();
    }
    // The two arms really are different, so this is not two readings of one path.
    expect(served.status).toBe(200);
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  /**
   * THE ONE THAT IS NOT A FORMAT PREFERENCE.
   *
   * SVG is a document: `<script>`, `<foreignObject>` and external references, executed
   * in THIS origin by anyone who navigates to the url. Served from the host that holds
   * `tf_session`, a relayed `image/svg+xml` is stored XSS reachable through a link, and
   * the SSRF gate cannot object because the url it approved was perfectly public.
   *
   * Mutation: add `"image/svg+xml"` to `PROXIED_IMAGE_TYPES`. Real failure text:
   *   AssertionError: an SVG was relayed from the session origin: expected 200 to be 415
   */
  it("refuses image/svg+xml rather than relaying it", async () => {
    // A picture's bytes under the SVG label, so the LABEL is what refuses: an SVG's own bytes are
    // refused earlier, as bytes no family admits (`img-sizes-every-family.test.ts`).
    const { db, deps } = await makeDeps(FIXED_NOW, {}, {
      remote: { async fetch() { return { status: 200, contentType: "image/svg+xml", body: PNG_2X3 }; } },
    });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });

    const u = "https://images.acme-cdn.com/logo.svg";
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);
    expect(res.status, "an SVG was relayed from the session origin").toBe(415);
  });

  /**
   * AND NO `application/octet-stream` FALLBACK. `proxyImage` returns exactly that when
   * the upstream declared nothing — so a fallback here would serve an UNLABELLED body
   * under the one type a browser is most willing to sniff, which is the allow-list
   * defeating itself.
   */
  it("refuses an undeclared body rather than falling back to octet-stream", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, {
      remote: { async fetch() { return { status: 200, contentType: null, body: PNG_2X3 }; } },
    });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });

    const u = "https://images.acme-cdn.com/mystery";
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);
    expect(res.status).toBe(415);
  });

  /**
   * AUTHORIZATION IS A SERVER FACT, ASSERTED AT THE ROUTE — two grants, either sufficient.
   *
   * The renderer's modes are not a boundary — a second client, a replayed url, or a bug in the
   * sanitizer's beacon branch all arrive here directly. The refused case is an account that
   * OPTED OUT of automatic loading (mail 0048's column, stamped) whose reader has not pressed
   * "Show images"; the served case is the product default, where the ACCOUNT's auto mode is the
   * grant and no per-message press exists at all.
   *
   * Mutation: delete the gate's throw in `privacy-service.ts`. Real failure:
   *   AssertionError: an unconsented image was proxied: expected 200 to be 403
   */
  it("refuses 403 for an opted-out account without a press", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await db.insert(accountSettings).values({ accountId: s.accountId, blockRemoteImagesAt: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: false });

    const u = "https://images.acme-cdn.com/hero.png";
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);
    expect(res.status, "an unconsented image was proxied").toBe(403);
    expect((await res.json()).error.code).toBe("remote_content_not_loaded");
    expect(await db.select().from(trackerEvents)).toHaveLength(0);
  });

  /**
   * THE PRODUCT DEFAULT IS SERVED. No settings row, no press: the account's auto mode (an
   * absent row IS the default) is the grant, or the shipped "pictures load when you open it"
   * answers 403 at its own proxy — which is exactly what it did until this gate learnt the
   * account column, and no client-side wiring could have fixed it.
   *
   * Mutation: revert the gate to `if (body?.loaded !== true) throw`. Real failure:
   *   AssertionError: the product default was refused at the proxy: expected 403 to be 200
   */
  it("serves 200 under the account default (auto) without a press", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: false });

    const u = "https://images.acme-cdn.com/hero.png";
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);
    expect(res.status, "the product default was refused at the proxy").toBe(200);
  });

  /** `mid` is the authorisation. Another account's message id fetches nothing. */
  it("a cross-account mid is a 404 and opens no socket", async () => {
    let fetched = 0;
    const { db, deps } = await makeDeps(FIXED_NOW, {}, {
      remote: {
        async fetch() {
          fetched += 1;
          return { status: 200, contentType: "image/gif", body: new Uint8Array(0) };
        },
      },
    });
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const { id } = await seedMessage(db, { accountId: other.accountId, folder: "INBOX" });

    const u = "https://images.acme-cdn.com/hero.png";
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);
    expect(res.status).toBe(404);
    expect(fetched, "ownership must be settled before a socket is opened").toBe(0);
    expect(await db.select().from(trackerEvents)).toHaveLength(0);
  });

  /**
   * THE SSRF REFUSAL, AT THE ROUTE. Proven in depth against a real listener and a real
   * socket count in `packages/services/test/privacy-service.test.ts`; asserted here so
   * that mounting the route cannot accidentally route AROUND the gate — a handler that
   * called `deps.remote.fetch` directly would pass every service test in the repo.
   */
  it("the metadata address is refused through the mounted route", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });

    const u = "http://169.254.169.254/latest/meta-data/";
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);
    expect(res.status).toBe(400);
    expect(await db.select().from(trackerEvents)).toHaveLength(0);
  });
});

/**
 * ── EVERY REFUSAL IS ATTRIBUTABLE, AND NONE OF THEM NAMES THE SENDER'S URL ────────────────
 *
 * `GET /img` is `raw`, so it builds its own error envelope and RETURNS rather than throwing —
 * which meant it never reached `withErrorEnvelope`'s `request_failed` line. A production census
 * of this route's errors found `logs[]` empty on every single row: the status was in the
 * platform's record and the reason was nowhere, so "why is this picture missing" had no answer.
 *
 * The second half is the harder one and is asserted just as hard: this route exists to keep the
 * hosts a reader's mail links to out of everyone's records, ours included. A log line that
 * quoted `u` to make debugging easier would put every tracker domain a reader was sent into our
 * own logs — which is the thing the proxy was built to prevent, arrived at from the inside.
 *
 * ── HOW TO SEE THESE FAIL ─────────────────────────────────────────────────────────────────
 *
 *  · Delete the `log.warn("request_failed", …)` call → the first two go red.
 *  · Add `err` or the `u` parameter to the fields → the third goes red.
 */
describe("GET /img — a deliberate refusal is logged, and says only which arm", () => {
  /** Records every line. `child()` returns itself, because `withRequestId` re-binds the logger. */
  function recorder() {
    const lines: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
    const self = {
      level: "debug" as const,
      child: () => self,
      debug: (event: string, fields: Record<string, unknown> = {}) => lines.push({ level: "debug", event, fields }),
      info: (event: string, fields: Record<string, unknown> = {}) => lines.push({ level: "info", event, fields }),
      warn: (event: string, fields: Record<string, unknown> = {}) => lines.push({ level: "warn", event, fields }),
      error: (event: string, fields: Record<string, unknown> = {}) => lines.push({ level: "error", event, fields }),
    };
    return { lines, logger: self as unknown as NonNullable<ApiDeps["logger"]> };
  }

  const refuse = async (u: string) => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });
    const rec = recorder();
    // Assigned onto the object rather than spread into a copy, so an injected port a caller
    // added cannot be left behind by the copy.
    deps.logger = rec.logger;
    const res = await H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps);
    return { res, lines: rec.lines, mid: id };
  };

  it("the SSRF refusal emits exactly one request_failed line naming its arm", async () => {
    const { res, lines } = await refuse("http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(400);

    const failed = lines.filter((l) => l.event === "request_failed");
    expect(failed, "the refusal was served with no line in our own record").toHaveLength(1);
    expect(failed[0]!.fields.route).toBe("/img");
    expect(failed[0]!.fields.status).toBe(400);
    // The ARM. Without a code the line says "something was refused", which is what the
    // platform's status already said.
    expect(failed[0]!.fields.code).toEqual(expect.any(String));
    expect(String(failed[0]!.fields.code)).not.toBe("");
  });

  it("a 4xx is `warn` and not `error` — the proxy refusing is the proxy working", async () => {
    const { lines } = await refuse("http://127.0.0.1/latest/meta-data/");
    const failed = lines.filter((l) => l.event === "request_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe("warn");
  });

  it("logs EXACTLY method/route/status/code — an allow-list, not a substring hope", async () => {
    // ── WHY AN ALLOW-LIST AND NOT A LIST OF THINGS THAT MUST BE ABSENT ────────────────────
    //
    // This assertion was a set of `not.toContain` checks first, and it did not guard: adding
    // the caught error to the fields left every one of them green, because `JSON.stringify`
    // drops an Error's `message` and `stack` (both non-enumerable) and the dump came out
    // unchanged. A test that cannot see the field it exists to forbid is decoration.
    //
    // So the FIELD NAMES are pinned instead. Anything a future edit adds to make debugging
    // easier — the `u` parameter, the resolved host, the message id, the error object — is a
    // red test by construction rather than one somebody remembered to forbid. That matters
    // most for the arm this does not reach: on the unknown-error path `err` may be a driver
    // error whose message carries a connection string, which is the case `middleware.ts`
    // already refuses to log for the same reason.
    //
    // Today the refusal MESSAGES carry nothing either — `SsrfRefusal` is documented as
    // deliberately not holding the url, the hostname or the resolved addresses — so this is
    // belt AND braces, and the belt is the one that can be undone by an edit here.
    const { res, lines } = await refuse("http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(400);

    const failed = lines.filter((l) => l.event === "request_failed");
    expect(failed, "the refusal was served with no line in our own record").toHaveLength(1);
    expect(Object.keys(failed[0]!.fields).sort()).toEqual(["code", "method", "route", "status"]);
  });

  it("no refusal line carries the url, its host, its query, or the message id", async () => {
    // The substring half, kept alongside the allow-list because the two fail differently: this
    // one also covers the `request_unhandled` arm and anything the logger itself binds.
    // The 415 arm, driven by an injected upstream, so the probe url can be an ORDINARY one:
    // the gate refuses an address on sight, which would leave nothing url-shaped to leak. Not
    // tracker-shaped either — a url the service recognises as a known tracker is answered with
    // a transparent placeholder and a 200, so it is not a refusal at all.
    const { db, deps } = await makeDeps(FIXED_NOW, {}, {
      remote: { async fetch() { return { status: 200, contentType: "image/svg+xml", body: PNG_2X3 }; } },
    });
    const s2 = await seedSession(db, { now: FIXED_NOW });
    const { id: mid } = await seedMessage(db, { accountId: s2.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: mid, html: "<img>", loadedRemoteContent: true });

    const host = "cdn-xyzzy9f3b.acme-cdn.com";
    const u = `https://${host}/hero-xyzzy9f3b.svg?rev=xyzzy9f3b`;
    const rec = recorder();
    deps.logger = rec.logger;
    const res = await H(req("GET", `/img?mid=${mid}&u=${encodeURIComponent(u)}`, { bearer: s2.token }), deps);
    const lines = rec.lines;
    expect(res.status, "the probe url must actually be refused, or this asserts nothing").toBe(415);
    expect(lines.filter((l) => l.event === "request_failed")).toHaveLength(1);

    const dump = JSON.stringify(lines, (_k, v) =>
      v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);
    expect(dump, "the sender's host reached our logs").not.toContain(host);
    expect(dump, "the url's query reached our logs").not.toContain("rev=xyzzy9f3b");
    expect(dump, "the url's path reached our logs").not.toContain("hero-xyzzy9f3b.svg");
    // Not the message id either: the requestId the logger already binds is the join key.
    expect(dump, "the message id reached our logs").not.toContain(mid);
  });
});

describe("GET /img counts its own faults, as the envelope does", () => {
  const fetchThrowing = async (thrown: unknown) => {
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { remote: { async fetch() { throw thrown; } } });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });
    const rows: { route: string; status: number; errorClass: string }[] = [];
    deps.faultLog = { record: async (r) => { rows.push({ route: r.route, status: r.status, errorClass: r.errorClass }); } };
    const u = encodeURIComponent("https://cdn.acme-cdn.com/hero.png");
    const res = await H(req("GET", `/img?mid=${id}&u=${u}`, { bearer: s.token }), deps);
    return { status: res.status, rows };
  };

  it("an unnamed throw is a 500 and one fault row naming the route and the class, never the url", async () => {
    expect(await fetchThrowing(new TypeError("x is undefined")))
      .toEqual({ status: 500, rows: [{ route: "/img", status: 500, errorClass: "TypeError" }] });
  });

  it("a refusal of ours at 5xx is one row too", async () => {
    const r = await fetchThrowing(new ServiceError("proxy_broken", 503, "no"));
    expect(r.rows.map((x) => x.status)).toEqual([503]);
  });

  it("CONTROL: the sender's server failing (424) writes no row", async () => {
    expect((await fetchThrowing(new ServiceError("upstream_failed", 424, "down", undefined, false))).rows).toEqual([]);
  });
});

/**
 * ── A PICTURE NO PROXY COULD SERVE COSTS NO DATABASE READ ─────────────────────────────────
 *
 * 2026-10-26: one tab sent 1,080 `/img` in six seconds, most of them malformed, and each read the
 * session before its stateless checks; the cold instances' pooled connections filled the pooler's
 * client cap and Cloud refused everyone for six minutes. The shape is refused before the session
 * now, in the service's words, and a busy database is answered as busy, not as the proxy's 500.
 */
describe("GET /img — the shape before the session, and a busy database answered as busy", () => {
  /** A handle whose every use throws: the answer must not need it. */
  const throwing = (err: () => Error) => new Proxy({}, { get() { throw err(); } }) as unknown as ApiDeps["db"];
  /** The real handle, except that the ownership read (`from(messages)`) throws `err`. */
  const ownershipThrows = (db: ApiDeps["db"], err: Error) => new Proxy(db as object, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p !== "select" || typeof v !== "function") return v;
      return (...a: unknown[]) => new Proxy((v as (...x: unknown[]) => object).apply(t, a), {
        get(q, qp, qr) {
          const f = Reflect.get(q, qp, qr);
          if (qp !== "from" || typeof f !== "function") return f;
          return (table: unknown) => {
            if (table === messages) throw err;
            return (f as (x: unknown) => unknown).call(q, table);
          };
        },
      });
    },
  }) as ApiDeps["db"];
  const picture = encodeURIComponent("https://images.acme-cdn.com/hero.png");
  const long = `https://images.acme-cdn.com/${"a".repeat(PROXY_URL_MAX_CHARS)}`;
  const BUSY: Array<[string, () => Error, string]> = [
    ["the acquire ceiling", () => new DbAcquireTimeoutError(15_000), "DbAcquireTimeoutError"],
    ["the pooler's client cap", () => new DbConnectionCapError("pooler"), "DbConnectionCapError"],
  ];

  it.each([
    ["a mid that is no id", `mid=not-an-id&u=${picture}`, "mid must be an id"],
    ["a u that is not http(s)", `mid=${randomUUID()}&u=${encodeURIComponent("cid:part1.acme")}`, "u must be an http(s) url"],
    ["a u over the cap", `mid=${randomUUID()}&u=${encodeURIComponent(long)}`,
      `u is ${long.length} characters; the limit is ${PROXY_URL_MAX_CHARS}`],
  ])("%s is 400 in the service's words, with no database at all", async (_shape, query, sentence) => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const lines: Array<[string, string[]]> = [];
    const logger = {
      child: () => logger, debug() {}, info() {}, error() {},
      warn: (event: string, fields: Record<string, unknown> = {}) => { lines.push([event, Object.keys(fields).sort()]); },
    };
    const res = await H(req("GET", `/img?${query}`, { bearer: s.token }),
      { ...deps, db: throwing(() => new Error("the database was asked")), logger: logger as never });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "validation_failed", message: sentence });
    expect(res.headers.get("x-ohmail-account"), "an answer given before the session names nobody").toBeNull();
    expect(lines).toEqual([["request_failed", ["code", "method", "route", "status"]]]);
  });

  it("a well-formed request with no session is still 401", async () => {
    const { deps } = await makeDeps();
    expect((await H(req("GET", `/img?mid=${randomUUID()}&u=${picture}`), deps)).status).toBe(401);
  });

  it.each(BUSY)("a session read refused by %s is 503 db_busy, retryable, and one fault row", async (_why, busy, errorClass) => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const rows: Array<{ route: string; status: number; errorClass: string }> = [];
    deps.faultLog = { record: async (r) => { rows.push({ route: r.route, status: r.status, errorClass: r.errorClass }); } };
    const res = await H(req("GET", `/img?mid=${randomUUID()}&u=${picture}`, { bearer: s.token }), { ...deps, db: throwing(busy) });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await res.json()).error).toMatchObject({ code: "db_busy", retryable: true });
    expect(rows).toEqual([{ route: "/img", status: 503, errorClass }]);
  });

  it.each(BUSY)("an ownership read refused by %s is 503 db_busy, not the proxy's 500", async (_why, busy) => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    const res = await H(req("GET", `/img?mid=${id}&u=${picture}`, { bearer: s.token }),
      { ...deps, db: ownershipThrows(deps.db, busy()) });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("db_busy");
  });
});

describe("POST /messages/:id/load-remote", () => {
  it("flips loadedRemoteContent and getBody reflects blocked → loaded", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img src='https://x.example/p.gif'>", loadedRemoteContent: false });

    const before = await (await H(req("GET", `/messages/${id}/body`, { bearer: s.token }), deps)).json();
    expect(before.loadedRemoteContent).toBe(false);

    const res = await H(req("POST", `/messages/${id}/load-remote`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remoteContent: "loaded" });

    const after = await (await H(req("GET", `/messages/${id}/body`, { bearer: s.token }), deps)).json();
    expect(after.loadedRemoteContent).toBe(true);
  });

  it("cross-account → 404", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const { id } = await seedMessage(db, { accountId: other.accountId, folder: "INBOX" });
    const res = await H(req("POST", `/messages/${id}/load-remote`, { bearer: s.token }), deps);
    expect(res.status).toBe(404);
  });
});

describe("tracker-event feeds — 'who tried to spy on you'", () => {
  it("GET /messages/:id/tracker-events lists that message's events; GET /tracker-events pages the account", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    // Opted out of auto-loading: `blocked` derives from the gate's two grants, and a default
    // account holds the auto grant, under which nothing reads as blocked.
    await db.insert(accountSettings).values({ accountId: s.accountId, blockRemoteImagesAt: FIXED_NOW });
    const a = await seedMessage(db, { accountId: s.accountId, fromAddress: "spy-a@acme-com.example", folder: "INBOX" });
    const b = await seedMessage(db, { accountId: s.accountId, fromAddress: "spy-b@acme-com.example", folder: "INBOX" });

    // Seeded directly: the proxy route that used to record these is unmounted,
    // and the FEEDS are what this test is about — they read rows, whoever wrote them.
    await db.insert(trackerEvents).values([a.id, b.id].map((messageId) => ({
      accountId: s.accountId, messageId, kind: "pixel", trackerHost: "t.acme-com.example", detectedAt: FIXED_NOW,
    })));

    const perMsg = await (await H(req("GET", `/messages/${a.id}/tracker-events`, { bearer: s.token }), deps)).json();
    expect(perMsg.items).toHaveLength(1);
    expect(perMsg.items[0].messageId).toBe(a.id);
    expect(perMsg.items[0].pixelHost).toBe("t.acme-com.example");
    expect(perMsg.items[0].kind).toBe("tracking_pixel");
    expect(perMsg.items[0].blocked).toBe(true);

    const feed = await (await H(req("GET", "/tracker-events", { bearer: s.token }), deps)).json();
    expect(feed.items.map((e: { messageId: string }) => e.messageId).sort()).toEqual([a.id, b.id].sort());
    expect(feed).toHaveProperty("nextCursor");
  });

  it("the feed is account-scoped — another account sees none of my events", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW);
    const mine = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const { id } = await seedMessage(db, { accountId: mine.accountId, folder: "INBOX" });
    await db.insert(trackerEvents).values({
      accountId: mine.accountId, messageId: id, kind: "pixel", trackerHost: "t.acme-com.example", detectedAt: FIXED_NOW,
    });

    const otherFeed = await (await H(req("GET", "/tracker-events", { bearer: other.token }), deps)).json();
    expect(otherFeed.items).toHaveLength(0);
  });
});
