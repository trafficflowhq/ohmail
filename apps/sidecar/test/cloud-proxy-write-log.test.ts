import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_DEADLINE_MS } from "../src/cloud-auth.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import { STAGED_UPLOAD_TIMEOUT_MS } from "../src/cloud-staged-upload.js";
import { createSidecarLog } from "../src/log.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import type { CloudMirror } from "../src/cloud-mirror.js";

/**
 * A DESKTOP ON THE CLOUD DOOR LOGS EACH WRITE IT FORWARDS (incident 0916).
 *
 * Every screener decision, draft, move and send on this door is forwarded to the hosted account,
 * and none of them reached `engine.log`: an incident there was not investigable from the client.
 * One line per forwarded mutation, through the REAL logger so the census cannot drop a field the
 * call site hands over — and nothing of the request body on any line.
 */

const ADDRESS = "stranger@example.test";
const SUBJECT = "Quarterly figures for Dana";
const KEY = "idem-2f9c1e7a-5b44-4d1e-9a0f-3c2b8d6e1a70";

interface Answer { status: number; body: unknown }

function door(answer: (path: string) => Answer) {
  const lines: string[] = [];
  const sent: string[] = [];
  const auth = {
    authedFetch: async (path: string) => {
      sent.push(path);
      const a = answer(path);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    },
  } as unknown as CloudAuth;
  const mirror = {
    online: () => true,
    markConnectivity: () => {},
    awaitCloudSeq: async () => true,
    awaitFreshPull: async () => true,
    localSeq: async () => null,
  } as unknown as CloudMirror;
  const proxy = createWriteThroughProxy({ auth, mirror, log: createSidecarLog({ sink: (l) => lines.push(l) }) });
  const post = (path: string, body: unknown, key: string | null = KEY) => proxy.forward(new Request(`http://engine${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
  }));
  const events = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === name);
  return { proxy, post, lines, sent, events };
}

describe("a forwarded write leaves one line in the engine log", () => {
  it("a Screener decision and a saved draft each log their route, status and time", async () => {
    const d = door(() => ({ status: 200, body: { ok: true } }));
    expect((await d.post("/screener/11111111-1111-4111-8111-111111111111", { sender: ADDRESS, decision: "in" })).status).toBe(200);
    expect((await d.post("/drafts", { subject: SUBJECT, to: [{ address: ADDRESS }], body: "numbers" })).status).toBe(200);
    const forwarded = d.events("cloud_write_forwarded");
    expect(forwarded.map((l) => [l.method, l.routeClass, l.status])).toEqual([
      ["POST", "/screener/:id", 200],
      ["POST", "/drafts", 200],
    ]);
    for (const l of forwarded) {
      expect(typeof l.ms).toBe("number");
      // A prefix of the key's hash, so a line can be matched to the account's record of the
      // write — never the key, which replays the write.
      expect(l.keyHash).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(d.lines.join("\n")).not.toContain(KEY);
    expect(d.events("cloud_write_refused")).toEqual([]);
  });

  it("no line carries the body's address or subject", async () => {
    const d = door(() => ({ status: 200, body: { ok: true } }));
    await d.post("/screener/11111111-1111-4111-8111-111111111111", { sender: ADDRESS, decision: "in" });
    await d.post("/drafts", { subject: SUBJECT, to: [{ address: ADDRESS }], body: "numbers" });
    expect(d.lines.length).toBeGreaterThan(0);
    const all = d.lines.join("\n");
    expect(all).not.toContain(ADDRESS);
    expect(all).not.toContain(SUBJECT);
    expect(all).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("a write the account refuses logs the refusal with the account's code", async () => {
    const d = door(() => ({ status: 409, body: { error: { code: "draft_conflict", message: `for ${ADDRESS}` } } }));
    expect((await d.post("/drafts", { subject: SUBJECT }, null)).status).toBe(409);
    expect(d.events("cloud_write_forwarded").map((l) => [l.status, l.keyHash])).toEqual([[409, null]]);
    expect(d.events("cloud_write_refused").map((l) => [l.routeClass, l.status, l.code])).toEqual([["/drafts", 409, "draft_conflict"]]);
    expect(d.lines.join("\n")).not.toContain(ADDRESS);
  });

  it("a read is not a write and logs nothing", async () => {
    const d = door(() => ({ status: 200, body: { items: [] } }));
    await d.proxy.forward(new Request("http://engine/consent"));
    expect(d.sent).toEqual(["/consent"]);
    expect(d.events("cloud_write_forwarded")).toEqual([]);
  });
});

describe("a send's upload is bounded as a staged file's is, not as a write's", () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A server still reading the body: the forward settles only when its signal aborts. */
  function slowDoor() {
    const connectivity: boolean[] = [];
    const auth = {
      authedFetch: (_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    } as unknown as CloudAuth;
    const mirror = { online: () => true, markConnectivity: (on: boolean) => { connectivity.push(on); } } as unknown as CloudMirror;
    const proxy = createWriteThroughProxy({ auth, mirror });
    const settle = async (path: string, ms: number): Promise<string> => {
      const verdict = proxy.forward(new Request(`http://engine${path}`, {
        method: "POST", body: JSON.stringify({ attachments: [{ contentBase64: "QUFB" }] }),
        headers: { "content-type": "application/json", "idempotency-key": KEY },
      })).then((r) => `answered ${r.status}`);
      await vi.advanceTimersByTimeAsync(ms);
      return await Promise.race([verdict, Promise.resolve("still pending")]);
    };
    return { settle, connectivity };
  }

  it("a send still uploading past the write deadline is not cut, and its own timeout leaves the door online", async () => {
    vi.useFakeTimers();
    const d = slowDoor();
    const send = d.settle("/drafts/d-1/send", REQUEST_DEADLINE_MS + 1_000);
    expect(await send).toBe("still pending");
    expect(d.connectivity).toEqual([]);
    // At the bound the window is answered the retryable 503, and other writes stay open.
    expect(await d.settle("/drafts/d-2/send", STAGED_UPLOAD_TIMEOUT_MS)).toBe("answered 503");
    expect(d.connectivity).toEqual([]);
  });

  it("Send later with files uploads them inline too, on the send's bound, and its own timeout leaves the door online", async () => {
    vi.useFakeTimers();
    const d = slowDoor();
    expect(await d.settle("/drafts/d-1/schedule-with-files", REQUEST_DEADLINE_MS + 1_000)).toBe("still pending");
    expect(d.connectivity).toEqual([]);
    expect(await d.settle("/drafts/d-2/schedule-with-files", STAGED_UPLOAD_TIMEOUT_MS)).toBe("answered 503");
    expect(d.connectivity).toEqual([]);
  });

  it("control: any other write keeps its deadline, and a forward that fails marks the door offline", async () => {
    vi.useFakeTimers();
    const d = slowDoor();
    expect(await d.settle("/drafts", REQUEST_DEADLINE_MS)).toBe("answered 503");
    expect(d.connectivity).toEqual([false]);
  });
});

/**
 * A ROUTE THAT CARRIES A TYPED SIGN-IN IS FORWARDED WHOLE AND KEPT NOWHERE ON THIS MACHINE.
 *
 * `POST /mailboxes` rides this relay with a mailbox's password in its body. The calendar's connect
 * and its sign-in typed again ride it the same way, with a password or a subscription's whole
 * address (whoever has that address reads the calendar). All three are held to one proof here: the
 * body reaches the account's server once and as it was sent; and of what this door itself writes or
 * keeps (its log lines through the real logger, the keys it remembers as applied, everything it
 * hands the mirror, the answer it gives back) nothing holds a character of what was typed.
 */
describe("a body that carries a typed sign-in", () => {
  /** A value nobody wrote down, of letters and digits only: it reads the same in JSON, in a path and in a log. */
  const marker = (tag: string): string => `${tag}${randomUUID().replaceAll("-", "")}`;
  const CONNECTION = "7c0d4f0e-3b1a-4a55-8f1c-2f6a9a3b1c22";

  function rig(answer: (path: string) => { status: number; body: unknown; seq?: string }) {
    const lines: string[] = [];
    const forwarded: { path: string; headers: string; body: string }[] = [];
    const mirrorHeard: unknown[][] = [];
    const applied = new Set<string>();
    const auth = {
      authedFetch: async (path: string, init: RequestInit) => {
        forwarded.push({
          path, headers: JSON.stringify([...new Headers(init.headers)]),
          body: init.body === undefined ? "" : new TextDecoder().decode(init.body as ArrayBuffer),
        });
        const a = answer(path);
        return new Response(JSON.stringify(a.body), {
          status: a.status, headers: { "content-type": "application/json", ...(a.seq === undefined ? {} : { "x-sync-seq": a.seq }) },
        });
      },
    } as unknown as CloudAuth;
    const heard = <T>(name: string, value: T) => async (...args: unknown[]): Promise<T> => {
      mirrorHeard.push([name, ...args]);
      return value;
    };
    const mirror = {
      online: () => true,
      markConnectivity: (on: boolean) => { mirrorHeard.push(["markConnectivity", on]); },
      awaitCloudSeq: heard("awaitCloudSeq", true),
      awaitFreshPull: heard("awaitFreshPull", true),
      localSeq: heard("localSeq", null),
    } as unknown as CloudMirror;
    const proxy = createWriteThroughProxy({ auth, mirror, applied, log: createSidecarLog({ sink: (l) => lines.push(l) }) });
    const answers: string[] = [];
    const post = async (path: string, body: unknown, key: string): Promise<number> => {
      const res = await proxy.forward(new Request(`http://engine${path}`, {
        method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "idempotency-key": key },
      }));
      answers.push(`${res.status} ${JSON.stringify([...res.headers])} ${await res.text()}`);
      return res.status;
    };
    /** Everything this door wrote, kept or handed on, but the forward itself. */
    const kept = (): string =>
      [lines.join("\n"), JSON.stringify([...applied]), JSON.stringify(mirrorHeard, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))].join("\n");
    return { post, lines, forwarded, applied, answers, kept };
  }

  /** The three routes, each with what a person types into it. */
  const typed = () => {
    const secrets = {
      mailbox: marker("mkmailpw"), caldav: marker("mkdavpw"), user: marker("mkuser"), address: marker("mkfeed"),
      again: marker("mkagainpw"), moved: marker("mkmoved"),
    };
    const asks: { path: string; routeClass: string; body: unknown; holds: string[] }[] = [
      {
        path: "/mailboxes", routeClass: "/mailboxes", holds: [secrets.mailbox],
        body: { address: "mila@studio.example.test", imap: { host: "imap.studio.example.test", port: 993, user: "mila", pass: secrets.mailbox } },
      },
      {
        path: "/calendar/connections", routeClass: "/calendar/connections", holds: [secrets.caldav, secrets.user],
        body: { way: "caldav", connectionId: CONNECTION, server: "https://dav.studio.example.test/", user: secrets.user, password: secrets.caldav },
      },
      {
        path: "/calendar/connections", routeClass: "/calendar/connections", holds: [secrets.address],
        body: { way: "ics", connectionId: randomUUID(), address: `https://feeds.example.test/${secrets.address}/basic.ics?key=${secrets.address}` },
      },
      {
        path: `/calendar/connections/${CONNECTION}/sign-in`, routeClass: "/calendar/connections/:id/sign-in", holds: [secrets.again],
        body: { user: "mila", password: secrets.again },
      },
      {
        path: `/calendar/connections/${CONNECTION}/sign-in`, routeClass: "/calendar/connections/:id/sign-in", holds: [secrets.moved],
        body: { address: `https://feeds.example.test/${secrets.moved}/basic.ics` },
      },
    ];
    return { asks, all: Object.values(secrets) };
  };

  it("is forwarded once and whole, and no log line, kept key, word to the mirror or answer of this door holds any of it", async () => {
    const d = rig(() => ({ status: 202, body: { id: CONNECTION, status: "active" }, seq: "41" }));
    const { asks, all } = typed();
    const keys = asks.map(() => `press-${randomUUID()}`);
    for (const [i, ask] of asks.entries()) expect(await d.post(ask.path, ask.body, keys[i]!), ask.path).toBe(202);

    // The control: each body arrived at the account's server as it was sent, once.
    expect(d.forwarded.map((f) => f.path)).toEqual(asks.map((a) => a.path));
    for (const [i, ask] of asks.entries()) {
      expect(d.forwarded[i]!.body, ask.path).toBe(JSON.stringify(ask.body));
      for (const secret of ask.holds) expect(d.forwarded[i]!.body.includes(secret), ask.path).toBe(true);
      // In the body alone: never in the path or a header of the forward.
      expect([d.forwarded[i]!.path, d.forwarded[i]!.headers].some((part) => all.some((secret) => part.includes(secret))), ask.path).toBe(false);
    }
    // One line a write, naming the route's pattern: no id of the path, and nothing typed.
    const forwardedLines = d.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "cloud_write_forwarded");
    expect(forwardedLines.map((l) => [l.method, l.routeClass, l.status])).toEqual(asks.map((a) => ["POST", a.routeClass, 202]));
    // What the door keeps of a write is its key, and it kept all five: the search below is of something.
    expect([...d.applied].sort()).toEqual([...keys].sort());
    const kept = d.kept();
    expect(kept).toContain("awaitCloudSeq");
    expect(all.filter((secret) => kept.includes(secret) || d.answers.join("\n").includes(secret))).toEqual([]);
    expect(kept.includes(CONNECTION)).toBe(false);
  });

  it("is in no line when the account refuses it either, whatever the refusal quotes back", async () => {
    // A server that quoted the body back in its refusal: this door hands the answer on and logs its code alone.
    const { asks, all } = typed();
    let n = 0;
    const d = rig(() => ({ status: 400, body: { error: { code: "validation_failed", message: `refused: ${JSON.stringify(asks[n++]!.body)}` } } }));
    for (const ask of asks) expect(await d.post(ask.path, ask.body, `press-${randomUUID()}`), ask.path).toBe(400);
    const refusedLines = d.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "cloud_write_refused");
    expect(refusedLines.map((l) => [l.routeClass, l.status, l.code])).toEqual(asks.map((a) => [a.routeClass, 400, "validation_failed"]));
    expect(all.filter((secret) => d.kept().includes(secret))).toEqual([]);
    // Nothing is remembered as applied for a write the account refused.
    expect([...d.applied]).toEqual([]);
  });
});
