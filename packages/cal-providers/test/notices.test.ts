/**
 * A provider's notice channels, opened and ended, against a stand-in under the real request port:
 * what is checked is what would leave the process (method, address, the port's own lines, the
 * body) and what is made of an answer. Google's shapes are its reference's; Microsoft's are its
 * own pages', not yet tried against Microsoft itself. No request leaves the process, and every id
 * and word here is made up.
 */
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { intlZones } from "@ohmail/cal-core";
import type { HostResolver, PinnedRequestOptions, PinnedResponse } from "@trafficflow/core/net";
import { describe, expect, it } from "vitest";
import { GOOGLE_HOSTS, makeNotices as googleNotices } from "../src/google/index.js";
import { MS_GRAPH_BASE, makeCalendarProviders } from "../src/index.js";
import { GOOGLE_NOTICE_MAX_MS, MICROSOFT_NOTICE_MAX_MS } from "../src/limits.js";
import { makeNotices as microsoftNotices, microsoftHosts } from "../src/microsoft/index.js";
import type { Connection, NoticeChannelAsk, ProviderWord } from "../src/port.js";
import { guardedRequest } from "../src/request/guarded.js";
import type { HttpRequest } from "../src/request/index.js";

const ZONES = intlZones();
const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);
const DAY = 24 * 3_600_000;
const ADDRESS = "https://api.notices.example.test/calendar/notices/google";
const WORD = "a-word-only-this-channel-knows-0123456789abc";
const CHANNEL = "5f0c7a3e-91d2-4c1b-8a57-3a1e9d2b6c40";
const never = new AbortController().signal;
const resolver: HostResolver = { resolve: async () => ["203.0.114.7"] };

const signedIn = (provider: ProviderWord, token = "short-lived"): Connection => ({
  provider,
  start: null,
  credential: { kind: "bearer", accessToken: async () => ({ ok: true, token }) },
});
const ask = (over: Partial<NoticeChannelAsk> = {}): NoticeChannelAsk => ({
  id: CHANNEL,
  address: ADDRESS,
  word: () => WORD,
  untilMs: NOW + 7 * DAY,
  ...over,
});

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly lines: readonly string[];
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | null;
}
type Reply = { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> };

/** The request port over a stand-in that answers what `answer` says, keeping what was sent. */
function port(hosts: ReadonlySet<string>, answer: (s: Sent) => Reply, writes = true) {
  const sent: Sent[] = [];
  const request = async (url: string, opts: PinnedRequestOptions): Promise<PinnedResponse> => {
    const h = (opts.headers ?? {}) as Record<string, string>;
    const s: Sent = {
      method: opts.method ?? "GET",
      url,
      lines: Object.keys(h).sort(),
      authorization: h.authorization ?? null,
      body:
        opts.body === undefined
          ? null
          : (JSON.parse(Buffer.from(opts.body as Uint8Array).toString("utf8")) as Record<string, unknown>),
    };
    sent.push(s);
    const r = answer(s);
    return {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
      stream: Readable.from([
        Buffer.from(r.body === undefined ? "" : JSON.stringify(r.body)),
      ]) as unknown as IncomingMessage,
    };
  };
  const http = guardedRequest({
    resolver,
    request,
    policy: { kind: "cloud" },
    hosts,
    writes,
    limits: { connectMs: 2_000, totalMs: 4_000, maxRedirects: 0, maxBodyBytes: 1024 * 1024 },
  });
  return { http, sent };
}
const deps = (http: ReturnType<typeof port>["http"]) => ({ http, clock: { now: () => NOW }, zones: ZONES });
const reason = (a: { ok: boolean; reason?: string; retryAfterMs?: number | null }): unknown =>
  a.ok ? "ok" : [a.reason, a.retryAfterMs];

describe("Google's notice channels", () => {
  const watched = (over: Record<string, unknown> = {}): Reply => ({
    status: 200,
    body: {
      kind: "api#channel",
      id: CHANNEL,
      resourceId: "o3hgv1538sdjfh",
      resourceUri: "https://www.googleapis.com/calendar/v3/calendars/x/events",
      token: WORD,
      expiration: String(NOW + 6 * DAY),
      ...over,
    },
  });

  it("opens a channel on one calendar: the id asked, the caller's address, the word, the end, and nothing else", async () => {
    const g = port(GOOGLE_HOSTS, () => watched());
    const opened = await googleNotices(deps(g.http)).open(
      signedIn("google"),
      { id: "studio/board 1@group.calendar.example.test" },
      ask(),
      never,
    );
    expect(opened).toEqual({
      ok: true,
      value: { id: CHANNEL, resourceId: "o3hgv1538sdjfh", expiresAtMs: NOW + 6 * DAY },
    });
    expect(g.sent).toEqual([
      {
        method: "POST",
        url: "https://www.googleapis.com/calendar/v3/calendars/studio%2Fboard%201%40group.calendar.example.test/events/watch",
        lines: expect.arrayContaining(["accept", "authorization", "content-type"]),
        authorization: "Bearer short-lived",
        body: {
          id: CHANNEL,
          type: "web_hook",
          address: ADDRESS,
          token: WORD,
          expiration: String(NOW + 7 * DAY),
        },
      },
    ]);
    expect(g.sent[0]!.lines.filter((l) => l.startsWith("if-"))).toEqual([]);
  });

  it("asks for a week at the most, and never keeps an end later than it asked for", async () => {
    const g = port(GOOGLE_HOSTS, () => watched({ expiration: String(NOW + 400 * DAY) }));
    const opened = await googleNotices(deps(g.http)).open(
      signedIn("google"),
      { id: "cal-1" },
      ask({ untilMs: NOW + 90 * DAY }),
      never,
    );
    expect(g.sent[0]!.body!.expiration).toBe(String(NOW + GOOGLE_NOTICE_MAX_MS));
    expect(opened).toEqual({
      ok: true,
      value: { id: CHANNEL, resourceId: "o3hgv1538sdjfh", expiresAtMs: NOW + GOOGLE_NOTICE_MAX_MS },
    });
  });

  it("shows nothing of the word where an ask is printed", () => {
    expect(JSON.stringify(ask())).not.toContain(WORD);
  });

  it("answers a word for every refusal, and follows no answer that is not the channel it asked for", async () => {
    const quota = { error: { errors: [{ reason: "rateLimitExceeded" }] } };
    const cases: ReadonlyArray<readonly [string, Reply, unknown]> = [
      ["the sign-in refused", { status: 401 }, ["sign_in_refused", null]],
      [
        "not allowed",
        { status: 403, body: { error: { errors: [{ reason: "forbidden" }] } } },
        ["forbidden", null],
      ],
      [
        "a spent quota",
        { status: 403, body: quota, headers: { "retry-after": "120" } },
        ["throttled", 120_000],
      ],
      ["too many requests", { status: 429, headers: { "retry-after": "30" } }, ["throttled", 30_000]],
      [
        "a calendar that is watched for nobody",
        { status: 400, body: { error: { errors: [{ reason: "pushNotSupportedForRequestedResource" }] } } },
        ["unsupported", null],
      ],
      ["a calendar that is gone", { status: 404 }, ["not_found", null]],
      ["Google's own fault", { status: 503 }, ["unavailable", null]],
      [
        "a redirect",
        { status: 302, headers: { location: "https://elsewhere.example/" } },
        ["redirect_invalid", null],
      ],
      ["an answer for another channel", watched({ id: "another-channel" }), ["unreadable", null]],
      [
        "an answer without its name for what is watched",
        watched({ resourceId: undefined }),
        ["unreadable", null],
      ],
      [
        "an answer whose name is past any name",
        watched({ resourceId: "r".repeat(200) }),
        ["unreadable", null],
      ],
      ["an answer that ended already", watched({ expiration: String(NOW - 1) }), ["unreadable", null]],
      ["an answer with no end", watched({ expiration: "next week" }), ["unreadable", null]],
      ["an answer that is no JSON object", { status: 200, body: ["x"] }, ["unreadable", null]],
    ];
    for (const [what, reply, expected] of cases) {
      const g = port(GOOGLE_HOSTS, () => reply);
      expect(
        reason(await googleNotices(deps(g.http)).open(signedIn("google"), { id: "cal-1" }, ask(), never)),
        what,
      ).toEqual(expected);
      expect(g.sent.length, what).toBe(1);
    }
  });

  it("asks nothing where there is nothing to ask: a channel that would end at once, a calendar with no id, a sign-in that is none", async () => {
    const g = port(GOOGLE_HOSTS, () => watched());
    const notices = googleNotices(deps(g.http));
    expect(
      reason(await notices.open(signedIn("google"), { id: "cal-1" }, ask({ untilMs: NOW + 60_000 }), never)),
    ).toEqual(["unsupported", null]);
    expect(reason(await notices.open(signedIn("google"), { id: "" }, ask(), never))).toEqual([
      "not_found",
      null,
    ]);
    const refused: Connection = {
      provider: "google",
      start: null,
      credential: {
        kind: "bearer",
        accessToken: async () => ({ ok: false, reason: "consent_needed", retryAfterMs: null }),
      },
    };
    expect(reason(await notices.open(refused, { id: "cal-1" }, ask(), never))).toEqual([
      "consent_needed",
      null,
    ]);
    expect(reason(await notices.close(signedIn("google"), { id: CHANNEL, resourceId: null }, never))).toEqual(
      ["unsupported", null],
    );
    expect(g.sent).toEqual([]);
  });

  it("ends a channel by its id and Google's name for what it watched; one Google no longer knows is ended", async () => {
    for (const [status, expected] of [
      [204, "ok"],
      [404, "ok"],
      [500, ["unavailable", null]],
      [401, ["sign_in_refused", null]],
    ] as const) {
      const g = port(GOOGLE_HOSTS, () => ({ status }));
      expect(
        reason(
          await googleNotices(deps(g.http)).close(
            signedIn("google"),
            { id: CHANNEL, resourceId: "o3hgv1538sdjfh" },
            never,
          ),
        ),
        String(status),
      ).toEqual(expected);
      expect(g.sent.map((s) => [s.method, s.url, s.body])).toEqual([
        [
          "POST",
          "https://www.googleapis.com/calendar/v3/channels/stop",
          { id: CHANNEL, resourceId: "o3hgv1538sdjfh" },
        ],
      ]);
    }
  });
});

describe("Microsoft's notice channels", () => {
  const HOSTS = microsoftHosts(MS_GRAPH_BASE);
  const SUBSCRIPTION = "7f105c7d-2dc5-4530-97cd-4e7ae6534c07";
  const made = (over: Record<string, unknown> = {}): Reply => ({
    status: 201,
    body: {
      id: SUBSCRIPTION,
      resource: "me/calendars/x/events",
      changeType: "created,updated,deleted",
      clientState: null,
      expirationDateTime: "2026-11-19T09:00:00.0000000Z",
      ...over,
    },
  });
  const notices = (http: ReturnType<typeof port>["http"]) =>
    microsoftNotices({ ...deps(http), graphBase: MS_GRAPH_BASE });
  const MS_ADDRESS = "https://api.notices.example.test/calendar/notices/microsoft";

  it("subscribes to one calendar's events with one address, the word and an end: no resource data, no second address", async () => {
    const m = port(HOSTS, () => made());
    const opened = await notices(m.http).open(
      signedIn("microsoft"),
      { id: "AAMk/AGI2+T=" },
      ask({ address: MS_ADDRESS }),
      never,
    );
    expect(opened).toEqual({
      ok: true,
      value: { id: SUBSCRIPTION, resourceId: null, expiresAtMs: Date.UTC(2026, 10, 19, 9, 0, 0) },
    });
    expect(m.sent.map((s) => [s.method, s.url, s.authorization])).toEqual([
      ["POST", "https://graph.microsoft.com/v1.0/subscriptions", "Bearer short-lived"],
    ]);
    // Exactly these five: the caller's id is not sent, and nothing asks for an event's content or names another address.
    expect(m.sent[0]!.body).toEqual({
      changeType: "created,updated,deleted",
      notificationUrl: MS_ADDRESS,
      resource: "me/calendars/AAMk%2FAGI2%2BT%3D/events",
      expirationDateTime: "2026-11-20T07:30:00Z",
      clientState: WORD,
    });
    expect(NOW + MICROSOFT_NOTICE_MAX_MS).toBe(Date.UTC(2026, 10, 20, 7, 30, 0));
  });

  it("answers a word for every refusal and for an answer it cannot read", async () => {
    const cases: ReadonlyArray<readonly [string, Reply, unknown]> = [
      ["the sign-in refused", { status: 401 }, ["sign_in_refused", null]],
      ["not allowed", { status: 403 }, ["forbidden", null]],
      [
        "an address that did not answer the validation",
        { status: 400, body: { error: { code: "InvalidRequest" } } },
        ["unsupported", null],
      ],
      ["too many requests", { status: 429, headers: { "retry-after": "45" } }, ["throttled", 45_000]],
      ["Graph's own fault", { status: 500 }, ["unavailable", null]],
      ["an answer with no id", made({ id: undefined }), ["unreadable", null]],
      ["an answer whose id is past any id", made({ id: "x".repeat(200) }), ["unreadable", null]],
      [
        "an answer that ended already",
        made({ expirationDateTime: "2026-11-17T08:59:59Z" }),
        ["unreadable", null],
      ],
      ["an answer with no end", made({ expirationDateTime: "soon" }), ["unreadable", null]],
    ];
    for (const [what, reply, expected] of cases) {
      const m = port(HOSTS, () => reply);
      expect(
        reason(
          await notices(m.http).open(
            signedIn("microsoft"),
            { id: "cal-1" },
            ask({ address: MS_ADDRESS }),
            never,
          ),
        ),
        what,
      ).toEqual(expected);
    }
  });

  it("never keeps an end later than it asked for", async () => {
    const m = port(HOSTS, () => made({ expirationDateTime: "2027-06-01T00:00:00Z" }));
    const opened = await notices(m.http).open(
      signedIn("microsoft"),
      { id: "cal-1" },
      ask({ address: MS_ADDRESS }),
      never,
    );
    expect(opened).toEqual({
      ok: true,
      value: { id: SUBSCRIPTION, resourceId: null, expiresAtMs: NOW + MICROSOFT_NOTICE_MAX_MS },
    });
  });

  it("removes a subscription by its id, with no version to remove it under; one Graph no longer knows is ended", async () => {
    for (const [status, expected] of [
      [204, "ok"],
      [404, "ok"],
      [503, ["unavailable", null]],
    ] as const) {
      const m = port(HOSTS, () => ({ status }));
      expect(
        reason(
          await notices(m.http).close(signedIn("microsoft"), { id: SUBSCRIPTION, resourceId: null }, never),
        ),
        String(status),
      ).toEqual(expected);
      expect(m.sent.map((s) => [s.method, s.url, s.body])).toEqual([
        ["DELETE", `https://graph.microsoft.com/v1.0/subscriptions/${SUBSCRIPTION}`, null],
      ]);
      expect(m.sent[0]!.lines.filter((l) => l.startsWith("if-"))).toEqual([]);
    }
    const m = port(HOSTS, () => ({ status: 204 }));
    expect(
      reason(await notices(m.http).close(signedIn("microsoft"), { id: "..", resourceId: null }, never)),
    ).toEqual(["not_found", null]);
    expect(m.sent).toEqual([]);
  });
});

describe("the request port's rule for a channel's removal", () => {
  const HOSTS = microsoftHosts(MS_GRAPH_BASE);
  const URL_ = `${MS_GRAPH_BASE}/subscriptions/7f105c7d-2dc5-4530-97cd-4e7ae6534c07`;
  const req = (over: Partial<HttpRequest>): HttpRequest => ({
    method: "DELETE",
    headers: {},
    body: null,
    validators: null,
    signal: never,
    precondition: { kind: "own-channel" },
    auth: { credential: { kind: "bearer", token: "short-lived" }, admits: () => true, tlsOnly: true },
    ...over,
  });

  it("takes it on a DELETE alone: nothing is changed or made without a version", async () => {
    const m = port(HOSTS, () => ({ status: 204 }));
    await expect(m.http.request(URL_, req({}))).resolves.toMatchObject({ arrived: true, status: 204 });
    for (const method of ["PATCH", "PUT"] as const) {
      await expect(
        m.http.request(URL_, req({ method, body: "{}", headers: { "content-type": "application/json" } })),
        method,
      ).rejects.toThrow(TypeError);
    }
    await expect(m.http.request(URL_, req({ method: "POST", body: "{}" }))).rejects.toThrow(TypeError);
    await expect(m.http.request(URL_, req({ auth: null }))).rejects.toThrow(TypeError);
    expect(m.sent.length).toBe(1);
  });

  it("refuses it on a port that was made for reading", async () => {
    const m = port(HOSTS, () => ({ status: 204 }), false);
    await expect(m.http.request(URL_, req({}))).rejects.toThrow(TypeError);
    expect(m.sent).toEqual([]);
  });
});

describe("the notice half as a program gets it", () => {
  const WORDS: readonly ProviderWord[] = ["google", "caldav", "microsoft", "ics"];
  const composed = (writes: boolean) =>
    makeCalendarProviders({
      clock: { now: () => NOW },
      zones: ZONES,
      resolver,
      policy: { kind: "cloud" },
      enabled: new Set(WORDS),
      microsoft: { graphBase: MS_GRAPH_BASE },
      writes,
    });

  it("is made for Google and Microsoft where the program writes, and for nobody where it does not", () => {
    expect(WORDS.map((w) => composed(true).get(w)!.notices?.provider ?? null)).toEqual([
      "google",
      null,
      "microsoft",
      null,
    ]);
    expect(WORDS.map((w) => composed(false).get(w)!.notices)).toEqual([null, null, null, null]);
    expect([
      composed(true).get("google")!.notices!.names,
      composed(true).get("microsoft")!.notices!.names,
    ]).toEqual(["caller", "provider"]);
  });
});
