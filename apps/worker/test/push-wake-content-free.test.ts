import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { createECDH, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  startPushWake, WAKE_BODY, WAKE_BODY_BYTES, type WakeSource, type PushWakePost,
} from "../src/push-wake.js";
import type { PushEndpointGuard, VapidFromEnv, WebPushKeys } from "@trafficflow/core/net";
import { makeVapidIdentity } from "@trafficflow/core/net";
import { changeLog, type Tx } from "@trafficflow/db";
import {
  makeSubscriber, openAes128Gcm, parseVapidAuthorization, type FakeSubscriber,
} from "../../../packages/core/test/webpush-subscriber.js";
import { farSide, NOT_HTTP, SWITCH } from "../../../packages/core/test/far-side.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  INVARIANT #1 / #5 — THE WAKE IS CONTENT-FREE, AND THIS FILE IS THE EVIDENCE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A push wake travels through a THIRD PARTY: the UnifiedPush distributor the user chose, which is
 * very often somebody else's `ntfy`. Anything in that request is a fact about a person's mail
 * disclosed to an operator they have no relationship with — and a count or a folder name is a
 * fact, not a hint. So the payload is a closed constant, and "closed" has to be a thing a test
 * can fail on rather than a thing a comment claims.
 *
 * ── WHAT ENCRYPTION CHANGED ABOUT THESE CENSUSES, AND WHAT IT DID NOT ────────────────────────
 *
 * The sender now sends the same constant in one of TWO wire forms: sealed with RFC 8291 to the
 * device's own key when the registration carries `p256dh`/`auth`, and in the clear when it does
 * not. That breaks the ONE assertion these censuses used to lean on hardest — "the body on the
 * wire is byte-identical to the constant" — because a sealed body is necessarily different every
 * time: a fresh salt and ephemeral key per message, which is not a nicety but the thing that stops
 * an AES-GCM key/nonce reuse.
 *
 * So the census moved DOWN A LAYER rather than being weakened. What is pinned now:
 *
 *  1. THE CONSTANT — the literal and its byte length, unchanged.
 *  2. THE SOURCE — the sender's own code, comments stripped, may name no message-derived value,
 *     may carry exactly ONE request body, and may hand exactly ONE thing to the encryptor: the
 *     identifier `WAKE_BODY`. This is the census that goes red when somebody THREADS A SUBJECT
 *     THROUGH.
 *  3. THE WIRE, BOTH ARMS — the keyless request is compared in full and byte-for-byte to what it
 *     has always been; the keyed request is DECRYPTED with the subscriber's private key and the
 *     plaintext compared to the constant. The header DELTA between the two arms is a closed set,
 *     and the VAPID token's CLAIM SET is a closed set, because a signed token is the most
 *     inviting place in this request for a per-account value to hide.
 *  4. THE SEAM — the POST port's arity and the exact shape of its third argument, so there is no
 *     parameter a future edit could route content through without changing this file.
 *
 * ── HOW THIS WAS WATCHED RED ───────────────────────────────────────────────────────────────
 *
 * Three separate mutations, because one is no longer enough to reach every arm:
 *
 *  · `body: sealed ?? WAKE_BODY` → `body: sealed ?? JSON.stringify({ type: "wake", subject: SUBJ })`
 *    — censuses 2 (two `body:`, a `JSON.stringify`, a `subject` identifier) and 3 (the keyless
 *    wire bytes) go red.
 *  · a `subject` threaded into the KEYS argument of the port — census 4's shape assertion goes
 *    red, and census 2's forbidden-identifier scan with it.
 *  · a `jti` added to the VAPID claim set carrying the account id — census 3's claim-set
 *    assertion goes red, and NOTHING ELSE DOES. That mutation is the reason the claim set is
 *    pinned here at all: it survives every other assertion in this file.
 */

const SRC = fileURLToPath(new URL("../src/push-wake.ts", import.meta.url));

/**
 * The source with COMMENTS REMOVED — and the stripping is the load-bearing part of census 2.
 *
 * Without it the census is worthless in both directions. The module's own docblock says "not the
 * subject, not the sender" as part of explaining the invariant, so a naive text scan for `subject`
 * is red on a file that is CORRECT — and a census that is red when the code is right gets weakened
 * until it is green, which is how the guard stops guarding. Equally, a scan that only looked at
 * comments would pass a file whose comments were tidy and whose code was not.
 *
 * A small state machine rather than a regex: a regex that removes `//…` also removes the tail of
 * `"https://…"`, and the file does contain URL-ish strings. So string and template literals are
 * tracked and their contents preserved verbatim.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; i += 2; continue; }
      if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      out += c; i += 1; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; }
      i += 1; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; i += 2; continue; }
      if (c === "\n") out += c;                      // keep line numbers honest
      i += 1; continue;
    }
    // inside a string: nothing is a comment, and a backslash escapes the next character
    if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
    if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) {
      mode = "code";
    }
    out += c; i += 1;
  }
  return out;
}

/** A row as the sender projects it. `p256dh`/`auth` null ⇒ a raw consumer, plaintext arm. */
interface Row {
  id: string;
  endpoint: string | null;
  p256dh?: string | null;
  auth?: string | null;
  transport?: "webpush" | "unifiedpush";
  familyId?: string | null;
}

/**
 * A db double: the sender reads the registrations, asks the change log whether the window held a
 * record that is not the calendar's, and (on 404/410) deletes one row. `held` is that answer: a
 * mail advance unless a case says the window was the calendar's alone. `asked` counts the question.
 */
function fakeDb(rows: Row[], held = true): { db: Tx; deleted: string[]; asked: () => number } {
  const deleted: string[] = [];
  let asked = 0;
  const filled = rows.map((r) => ({ p256dh: null, auth: null, ...r }));
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => (table === changeLog
          ? { limit: () => { asked += 1; return Promise.resolve(held ? [{ one: 1 }] : []); } }
          : Promise.resolve(filled)),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted.push("one");
        return Promise.resolve([]);
      },
    }),
  } as unknown as Tx;
  return { db, deleted, asked: () => asked };
}

/** A hub double. `emit` is what the real hub's LISTEN dispatch calls. */
function fakeSource(): { source: WakeSource; emit: (accountId: string, seq: bigint) => void } {
  const subs = new Set<(a: string, s: bigint) => void>();
  return {
    source: {
      subscribeAll(cb) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    },
    emit(accountId, seq) {
      for (const cb of subs) cb(accountId, seq);
    },
  };
}

/**
 * The single-shard answer. The shipped configuration is one shard, where `accountInShard` returns
 * true without touching the database; the sharded case has its own test rather than being smuggled
 * in as a default here.
 */
const OWN_ALL = async (): Promise<boolean> => true;

/** A guard that clears everything and pins to one address — the permit branch, executed. */
const PERMIT: PushEndpointGuard = { async check() { return ["203.0.113.9"]; } };

/**
 * A deployment with no VAPID keypair — which is the state every test here ran in before the
 * encrypting arm existed, and is still the state of a self-host that has not set one. Named rather
 * than inlined so that "which arm is this test exercising" is readable at the call site.
 */
const NO_VAPID: VapidFromEnv = { kind: "absent", why: "no VAPID keypair is configured" };

/**
 * The scalar left-padded to the curve's 32 bytes. `createECDH().getPrivateKey()` returns the
 * scalar minimal-length big-endian, so one whose top byte is zero comes back 31 bytes — about one
 * key in 256 — and the product's `decodeExact` (correctly) refuses a 31-byte VAPID key. Padding
 * fixes the FIXTURE; the product's strict length check is untouched. A longer buffer is a bug and
 * refuses. Control below: the "VAPID fixture pads a short private scalar to 32 bytes" describe.
 */
function padScalarTo32(k: Buffer): Buffer {
  if (k.length > 32) throw new Error(`scalar is ${k.length} bytes, longer than the 32-byte curve order`);
  return k.length === 32 ? k : Buffer.concat([Buffer.alloc(32 - k.length), k]);
}

/** A deployment WITH one. Fresh per call so no test depends on another's key material. */
function withVapid(): { vapid: VapidFromEnv; publicKey: string } {
  const e = createECDH("prime256v1");
  e.generateKeys();
  const publicKey = e.getPublicKey().toString("base64url");
  return {
    vapid: {
      kind: "configured",
      identity: makeVapidIdentity({
        publicKey, privateKey: padScalarTo32(e.getPrivateKey()).toString("base64url"),
        subject: "mailto:ops@example.net",
      }),
    },
    publicKey,
  };
}

const tick = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** One captured request, in full: nothing about it is summarised before it is asserted on. */
interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A real listener that records whole requests. Returns the port and a stop function. */
async function listener(
  onRequest: (c: Captured) => void, status = 201,
): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      onRequest({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(status).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

describe("the VAPID fixture pads a short private scalar to 32 bytes (control for #0191)", () => {
  /**
   * `withVapid()` used to pass `getPrivateKey()` straight through, so a scalar whose top byte is
   * zero arrived 31 bytes and `makeVapidIdentity`'s `decodeExact` refused it — a ~1-in-256 flake.
   * A deterministic 31-byte vector (leading zero in its 32-byte form) drives the padding here.
   */
  const scalar31 = Buffer.from(
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex",
  );

  it("the fixture vector is genuinely 31 bytes, non-zero at the top", () => {
    expect(scalar31).toHaveLength(31);
    expect(scalar31[0]).not.toBe(0);            // its 32-byte form is what carries the leading zero
  });

  it("pads to exactly 32 bytes, zero-filled on the LEFT, value preserved", () => {
    const padded = padScalarTo32(scalar31);
    expect(padded).toHaveLength(32);
    expect(padded[0]).toBe(0);
    expect(padded.subarray(1).equals(scalar31)).toBe(true);
  });

  it("refuses a scalar longer than the curve order", () => {
    expect(() => padScalarTo32(Buffer.alloc(33))).toThrow(/longer than/);
  });

  it("the padded key round-trips through the product's decoder; the raw 31-byte key does NOT", () => {
    const padded = padScalarTo32(scalar31);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(padded);
    const pub = ecdh.getPublicKey().toString("base64url");

    // Padded: accepted by decodeExact and the pair check inside makeVapidIdentity.
    expect(() => makeVapidIdentity({
      publicKey: pub, privateKey: padded.toString("base64url"), subject: "mailto:ops@example.net",
    })).not.toThrow();

    // Raw 31-byte: exactly the flake — the product refuses it, which is why the fixture must pad.
    expect(() => makeVapidIdentity({
      publicKey: pub, privateKey: scalar31.toString("base64url"), subject: "mailto:ops@example.net",
    })).toThrow(/31 bytes, expected 32/);
  });
});

describe("census 1 — the wake payload is a closed constant", () => {
  it("is the exact literal, and the exact byte length", () => {
    expect(WAKE_BODY).toBe('{"type":"wake"}');
    expect(Buffer.byteLength(WAKE_BODY, "utf8")).toBe(WAKE_BODY_BYTES);
    expect(WAKE_BODY_BYTES).toBe(15);
  });

  it("parses to exactly one key, whose value carries no information about the account", () => {
    const parsed = JSON.parse(WAKE_BODY) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["type"]);
    expect(parsed.type).toBe("wake");
  });

  it("has NO `id` field — which is what keeps a wake from becoming a notification", () => {
    /**
     * Not a restatement of the assertion above. The connector's default payload renderer reads an
     * `id` out of the decrypted JSON and renders NOTHING when there is none, so the absence of that
     * one key is the whole reason a wake is silent on the phone rather than a visible notification
     * with no useful text in it. Pinned here as its own fact because the two properties would be
     * broken by different edits: adding a `title` would be a privacy regression, and adding an `id`
     * would start rendering notifications without changing what the payload discloses.
     */
    expect(Object.keys(JSON.parse(WAKE_BODY) as object)).not.toContain("id");
  });
});

describe("census 2 — the sender's SOURCE names no message-derived value", () => {
  const code = stripComments(readFileSync(SRC, "utf8"));

  it("the stripper itself works — comments gone, code and strings intact", () => {
    // The guard on the guard. A stripper that returned "" would make every assertion below pass.
    expect(code).toContain("export const WAKE_BODY");
    expect(code).toContain('{"type":"wake"}');
    expect(code).not.toContain("INVARIANT, NOT A PREFERENCE");     // a docblock phrase
    expect(code.length).toBeGreaterThan(1000);                     // not silently emptied
  });

  /**
   * The forbidden set: every identifier shape a message-derived value would arrive as in THIS
   * repository. Property access and object keys, not bare words — a bare-word list cannot tell
   * `subject` in a sentence from `subject` in an expression, and the sentences are where the
   * invariant is explained.
   */
  const FORBIDDEN: [string, RegExp][] = [
    ["a subject", /\.subject\b|\bsubject\s*[:,)]/],
    ["a snippet or preview", /\bsnippet\b|\bpreview\b/i],
    ["a body's text or html", /\bbodyText\b|\bbodyHtml\b|\bhtmlBody\b/],
    ["a sender identity", /\bfromName\b|\bfromAddress\b|\bsenderName\b/],
    ["a header bag", /\bheaderBag\b|\bheadersJson\b|\brawHeaders\b/],
    ["a message or thread table", /\bmessages\b|\bmessageBodies\b|\bmessageStates\b|\bthreads\b/],
    ["a count of anything", /\bcount\s*[:,]|unreadCount|\bnewCount\b/],
    ["a mailbox or folder name", /\bfolderName\b|\bmailboxName\b|\bfolder\b/],
    ["the account id on the wire", /\bqueryString\b|searchParams|\?accountId=/],
  ];

  for (const [what, re] of FORBIDDEN) {
    it(`does not reach for ${what}`, () => {
      const hit = re.exec(code);
      expect(hit?.[0] ?? null).toBeNull();
    });
  }

  it("carries exactly one request body, with the constant as its only plaintext form", () => {
    const bodies = [...code.matchAll(/\bbody\s*:/g)];
    expect(bodies.length).toBe(1);
    expect(code).toMatch(/\bbody\s*:\s*sealed\s*\?\?\s*WAKE_BODY\b/);
  });

  it("seals only the constant or the exact opaque browser binding", () => {
    expect([...code.matchAll(/encryptWebPushBody\s*\(/g)]).toHaveLength(1);
    expect(code).toMatch(/\bsealed\s*=\s*encryptWebPushBody\(payload,\s*keys\)/);
    expect(code).toContain('const payload = binding === undefined ? WAKE_BODY : `{"type":"wake","binding":"${binding}"}`');
    expect([...code.matchAll(/JSON\.stringify\(/g)]).toHaveLength(1);
    expect(code).toContain('createHash("sha256").update(JSON.stringify([accountId, familyId])).digest("hex")');
    expect(code).toMatch(/row.transport === "webpush" && row.familyId\s*\? browserWakeBinding\(accountId, row.familyId\)/);
  });

  it("reads only delivery material and the browser session binding from the registration", () => {
    const cols = [...code.matchAll(/pushSubscriptions\.(\w+)/g)].map((m) => m[1]!);
    expect([...new Set(cols)].sort())
      .toEqual(["accountId", "auth", "endpoint", "id", "p256dh", "sessionFamilyId", "transport"]);

    const select = /db\.select\(\{([\s\S]*?)\}\)/.exec(code);
    expect(select).not.toBeNull();
    const keys = [...select![1]!.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!);
    expect(keys.sort()).toEqual(["auth", "endpoint", "familyId", "id", "p256dh", "transport"]);
    expect(code).toMatch(/id:\s*pushSubscriptions\.id/);
    expect(code).toMatch(/endpoint:\s*pushSubscriptions\.endpoint/);
    expect(code).toMatch(/p256dh:\s*pushSubscriptions\.p256dh/);
    expect(code).toMatch(/auth:\s*pushSubscriptions\.auth/);
    expect(code).toMatch(/transport:\s*pushSubscriptions\.transport/);
    expect(code).toMatch(/familyId:\s*pushSubscriptions\.sessionFamilyId/);
  });

  it("asks the change log one question, by the literal 1, and reads no column of it", () => {
    /**
     * The second read decides whether a window dials at all. It is in scope of the request, so
     * its shape is pinned like the first: one projection, the literal `1`, and three columns named
     * only to bound it: the account, the window's seqs and the kind. A fourth name here is a value
     * of somebody's mail log on its way into the sender.
     */
    const selects = [...code.matchAll(/db\.select\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]!.trim());
    expect(selects).toHaveLength(2);
    expect(selects[1]).toBe("one: sql<number>`1`");
    const cols = [...code.matchAll(/changeLog\.(\w+)/g)].map((m) => m[1]!);
    expect([...new Set(cols)].sort()).toEqual(["accountId", "entityType", "seq"]);
    expect([...code.matchAll(/\.from\((\w+)\)/g)].map((m) => m[1])).toEqual(["pushSubscriptions", "changeLog"]);
    // The kinds it leaves out are the calendar's own list, by name: not a list typed here.
    expect(code).toMatch(/notInArray\(changeLog\.entityType,\s*\[\.\.\.CALENDAR_RECORD_KINDS\]\)/);
  });

  it("every field it logs SURVIVES the logger's allow-list", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  A LOG LINE WHOSE FIELDS ARE ALL DROPPED IS A LINE THAT SAYS NOTHING
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * `createLogger` applies an allow-list to field NAMES and silently drops anything not on it,
     * reporting the omission as `droppedFields`. So a call site can be correct, reviewed, tested,
     * and still emit an empty line in production.
     *
     * MEASURED, not hypothetical. The first managed deploy of this module logged
     * `event="push_wake_started" droppedFields=["vapid","encryptedWakes"]` — a line whose entire
     * purpose was to state whether encrypted wakes were on, conveying nothing. Nothing in the suite
     * saw it, because every test here injects its own logger double and never meets the real
     * allow-list. This is the guard that closes that gap: the names this module uses are checked
     * against the SHIPPED list rather than against a double.
     *
     * The fix for a failure here is `reason`/`state`/`kind` — names that already exist for this —
     * and NOT a new entry on the allow-list. `log.ts` argues that a per-caller widening is how that
     * list stops being enumerable.
     */
    const { ALLOWED_FIELDS } = await import("@trafficflow/core");
    const allowed = new Set(ALLOWED_FIELDS.map((f) => f.toLowerCase()));

    // Every field name this module passes to a log call, read out of its own source.
    const names = new Set<string>();
    for (const m of code.matchAll(/log\?\.\w+\(\s*"[^"]+"\s*,\s*\{([\s\S]*?)\n(\s*)\}\)/g)) {
      for (const f of m[1]!.matchAll(/(?:^|\n)\s*(?:\.\.\.\([^)]*\))?\s*([A-Za-z_]\w*)\s*:/g)) {
        names.add(f[1]!);
      }
    }
    expect(names.size, "the field scan found nothing — it cannot be asserting anything").toBeGreaterThan(1);

    const dropped = [...names].filter((n) => !allowed.has(n.toLowerCase()));
    expect(dropped, `these field names are DROPPED by the logger, so the lines carrying them say `
      + `less than they appear to: ${dropped.join(", ")}`).toEqual([]);
  });

  it("never logs key material, and never logs the endpoint", () => {
    /**
     * The new columns are secrets in a way the endpoint is not: `auth` is the device's
     * authentication secret, and anyone holding it plus the endpoint can send a wake this app will
     * act on. Log lines go to a drain, so the rule is that neither key ever appears in a logged
     * object at all. Asserted by reading every `log?.` call's argument text.
     */
    const logged = [...code.matchAll(/log\?\.\w+\(([\s\S]*?)\n\s*\}\)|log\?\.\w+\(([^)]*)\)/g)]
      .map((m) => m[1] ?? m[2] ?? "").join("\n");
    expect(logged.length).toBeGreaterThan(50);          // the scan found the calls at all
    for (const secret of ["p256dh", "auth", "keys", "sealed", "endpoint", "url"]) {
      expect(logged, `a log call mentions ${secret}`).not.toMatch(new RegExp(`\\b${secret}\\b`));
    }
  });

  it("keeps the hub's seq as a window's two bounds, and hands them to the deciding read alone", () => {
    // The hub hands (accountId, seq). `seq` is an activity counter: it bounds the one read that
    // asks whether the window held anything but the calendar's records, and goes nowhere else.
    // That it reaches no request and no log line is run below, on numbers that could not be missed.
    // Here: the only uses of the two bounds.
    expect(code).toMatch(/subscribeAll\(\(accountId,\s*seq\)\s*=>/);
    const uses = code.split("\n").filter((line) => /\b(lowest|highest)\b/.test(line)).map((line) => line.trim());
    expect(uses).toEqual([
      "const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; lowest: bigint; highest: bigint }>();",
      "const fire = async (accountId: string, lowest: bigint, highest: bigint): Promise<void> => {",
      "gte(changeLog.seq, lowest),",
      "lte(changeLog.seq, highest),",
      "if (seq < open.lowest) open.lowest = seq;",
      "if (seq > open.highest) open.highest = seq;",
      "void fire(accountId, window.lowest, window.highest).catch((err: unknown) => {",
      "const window = { timer, lowest: seq, highest: seq };",
    ]);
  });
});

describe("census 3a — the KEYLESS wire is byte-for-byte what it always was", () => {
  it("a distinctive subject in scope appears in no byte of the request", async () => {
    /**
     * The subject is REAL and it is in scope: it sits in this test's closure and in the fake db's
     * rows, exactly where a careless edit would find it. The assertion is over the whole captured
     * request — request line, every header name and value, and the body — because a body census
     * alone would pass a sender that appended `?subject=…` to the endpoint or set an
     * `X-Ohmail-Subject` header.
     */
    const SUBJECT = "Q3-BOARD-PACK-CONFIDENTIAL-9f2a";

    let captured: Captured | null = null;
    const l = await listener((c) => { captured = c; });
    const endpoint = `http://127.0.0.1:${l.port}/up/topic-${SUBJECT.toLowerCase()}`;

    try {
      const { db } = fakeDb([{ id: "row-1", endpoint }]);
      const { source, emit } = fakeSource();
      // The REAL default post — no injected double — so what is asserted is what goes on a socket.
      const wake = startPushWake({
        dbOf: () => db,
        source,
        ownsAccount: OWN_ALL,
        // Loopback is only dialable under the relaxed policy; the pin is the literal itself.
        guard: { async check() { return ["127.0.0.1"]; } },
        vapid: NO_VAPID,
        debounceMs: 5,
        minIntervalMs: 0,
      });
      emit("acct-1", 7n);
      for (let i = 0; i < 60 && !captured; i++) await tick(25);
      wake.stop();

      expect(captured).not.toBeNull();
      const c = captured!;

      // The body is the constant, byte for byte.
      expect(c.body.toString("utf8")).toBe(WAKE_BODY);
      expect(c.body).toHaveLength(WAKE_BODY_BYTES);
      expect(c.method).toBe("POST");
      // And it is NOT encrypted — a keyless registration must not grow a content coding.
      expect(c.headers["content-encoding"]).toBeUndefined();
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers["content-type"]).toBe("application/json");

      // The subject appears NOWHERE — not in the path, not in a header name, not in a value.
      // (The endpoint's own path carries it, because the DISTRIBUTOR chose that URL; that string
      // came from the registration, not from a message. So the path is compared to the registered
      // path rather than searched — anything APPENDED to it would fail this.)
      expect(c.url).toBe(`/up/topic-${SUBJECT.toLowerCase()}`);
      const headerBlob = Object.entries(c.headers).map(([k, v]) => `${k}: ${String(v)}`).join("\n");
      expect(headerBlob).not.toContain(SUBJECT);
      expect(headerBlob.toLowerCase()).not.toContain(SUBJECT.toLowerCase());
      expect(c.body.toString("utf8")).not.toContain(SUBJECT);

      // And the account id — which the sender DOES know — never leaves either.
      expect(c.url).not.toContain("acct-1");
      expect(headerBlob).not.toContain("acct-1");
      expect(c.body.toString("utf8")).not.toContain("acct-1");
      // Nor the seq the hub handed over.
      expect(c.body.toString("utf8")).not.toContain("7");
    } finally {
      l.close();
    }
  });

  it("a keyless registration is served even when the deployment HAS a keypair", async () => {
    // The two arms are chosen per ROW, not per deployment. A raw consumer keeps working on a
    // server that also seals for phones — otherwise turning encryption on would silently break
    // every `ntfy` topic somebody watches directly.
    let captured: Captured | null = null;
    const l = await listener((c) => { captured = c; });
    try {
      const { db } = fakeDb([{ id: "raw", endpoint: `http://127.0.0.1:${l.port}/up/raw` }]);
      const { source, emit } = fakeSource();
      const wake = startPushWake({
        dbOf: () => db, source, ownsAccount: OWN_ALL,
        guard: { async check() { return ["127.0.0.1"]; } },
        vapid: withVapid().vapid,
        debounceMs: 5, minIntervalMs: 0,
      });
      emit("acct-1", 1n);
      for (let i = 0; i < 60 && !captured; i++) await tick(25);
      wake.stop();
      expect(captured).not.toBeNull();
      expect(captured!.body.toString("utf8")).toBe(WAKE_BODY);
      expect(captured!.headers["content-encoding"]).toBeUndefined();
    } finally {
      l.close();
    }
  });
});

it("seals the browser family selected before a delayed delivery", async () => {
  const account = "account-browser";
  const family = "family-old";
  const sub = makeSubscriber();
  const { vapid } = withVapid();
  const seen: Captured[] = [];
  const l = await listener((request) => { seen.push(request); });
  const reading = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<string[]>();
  const { db } = fakeDb([
    { id: "browser", endpoint: `http://127.0.0.1:${l.port}/wake`,
      p256dh: sub.p256dh, auth: sub.auth, transport: "webpush", familyId: family },
  ]);
  const { source, emit } = fakeSource();
  const wake = startPushWake({
    dbOf: () => db, source, ownsAccount: OWN_ALL, vapid, debounceMs: 1, minIntervalMs: 0,
    guard: { check: () => { reading.resolve(); return resume.promise; } },
  });
  try {
    emit(account, 1n);
    await reading.promise;
    resume.resolve(["127.0.0.1"]);
    for (let attempt = 0; attempt < 80 && seen.length === 0; attempt++) await tick(25);
    expect(seen).toHaveLength(1);
    const plaintext = openAes128Gcm(seen[0]!.body, sub).toString("utf8");
    expect(JSON.parse(plaintext)).toEqual({
      type: "wake",
      binding: createHash("sha256").update(JSON.stringify([account, family])).digest("hex"),
    });
  } finally {
    wake.stop();
    l.close();
  }
});

describe("census 3b — the SEALED wire carries the same constant and nothing else", () => {
  /** Drive one keyed registration through the real sender and capture the real request. */
  async function sealedRequest(): Promise<{
    captured: Captured; sub: FakeSubscriber; publicKey: string; keyless: Captured;
  }> {
    const sub = makeSubscriber();
    const { vapid, publicKey } = withVapid();
    const seen: Captured[] = [];
    const l = await listener((c) => { seen.push(c); });
    try {
      // Two rows on one account: keyed first, keyless second, so the HEADER DELTA between the two
      // arms is measured on requests from the same pass rather than across two tests.
      const { db } = fakeDb([
        { id: "phone", endpoint: `http://127.0.0.1:${l.port}/up/phone`, p256dh: sub.p256dh, auth: sub.auth },
        { id: "raw", endpoint: `http://127.0.0.1:${l.port}/up/raw` },
      ]);
      const { source, emit } = fakeSource();
      const wake = startPushWake({
        dbOf: () => db, source, ownsAccount: OWN_ALL,
        guard: { async check() { return ["127.0.0.1"]; } },
        vapid, debounceMs: 5, minIntervalMs: 0,
      });
      emit("acct-1", 1n);
      for (let i = 0; i < 80 && seen.length < 2; i++) await tick(25);
      wake.stop();
      expect(seen.length, "both rows should have been dialled").toBe(2);
      const captured = seen.find((c) => c.url === "/up/phone")!;
      const keyless = seen.find((c) => c.url === "/up/raw")!;
      expect(captured).toBeDefined();
      expect(keyless).toBeDefined();
      return { captured, sub, publicKey, keyless };
    } finally {
      l.close();
    }
  }

  it("DECRYPTS to the exact fifteen-byte constant, with the subscriber's own private key", async () => {
    const { captured, sub } = await sealedRequest();
    // The whole point of the slice, asserted the only way that means anything: open the ciphertext
    // the shipped sender produced, using only what a real device holds.
    const plaintext = openAes128Gcm(captured.body, sub);
    expect(plaintext.toString("utf8")).toBe(WAKE_BODY);
    expect(plaintext).toHaveLength(WAKE_BODY_BYTES);
    // And the body on the wire is NOT the plaintext — otherwise the assertion above would be
    // passing for the wrong reason.
    expect(captured.body.toString("utf8")).not.toBe(WAKE_BODY);
    expect(captured.body).toHaveLength(118);
    expect(captured.headers["content-encoding"]).toBe("aes128gcm");
    expect(captured.headers["content-length"]).toBe("118");
  });

  it("a sealed body does NOT open with a different device's key", async () => {
    const { captured } = await sealedRequest();
    expect(() => openAes128Gcm(captured.body, makeSubscriber())).toThrow();
  });

  it("the header DELTA over the keyless arm is a CLOSED SET of exactly two", async () => {
    /**
     * Not "the keyed request has these headers" — that would pass a request that also grew an
     * `X-Ohmail-Account`. The DELTA between the two arms of the same pass is computed and compared,
     * so any third header the encrypted path adds is red whatever it is called.
     */
    const { captured, keyless } = await sealedRequest();
    const added = Object.keys(captured.headers).filter((k) => !(k in keyless.headers)).sort();
    expect(added).toEqual(["authorization", "content-encoding"]);
    const removed = Object.keys(keyless.headers).filter((k) => !(k in captured.headers));
    expect(removed).toEqual([]);
    // The shared headers that legitimately DIFFER in value, also a closed set.
    const changed = Object.keys(keyless.headers)
      .filter((k) => k in captured.headers && String(captured.headers[k]) !== String(keyless.headers[k]))
      .sort();
    expect(changed).toEqual(["content-length", "content-type"]);
    expect(captured.headers.ttl).toBe("240");
    expect(keyless.headers.ttl).toBe("240");
  });

  it("the VAPID token VERIFIES, and its claim set is exactly {aud, exp, sub}", async () => {
    /**
     * The claim set is pinned because it is the one part of this request that is structured,
     * signed, and trivially extensible — which makes it the natural hiding place for a per-account
     * value. A `jti` carrying an account id would survive every other assertion in this file: the
     * body would still decrypt to the constant, the header delta would still be two, and the
     * source scan would not see a forbidden identifier. This is the assertion that catches it.
     */
    const { captured, publicKey } = await sealedRequest();
    const auth = String(captured.headers.authorization);
    const parsed = parseVapidAuthorization(auth);

    expect(parsed.verified, "the signature does not verify against its own k= field").toBe(true);
    expect(parsed.k).toBe(publicKey);
    expect(parsed.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(Object.keys(parsed.claims).sort()).toEqual(["aud", "exp", "sub"]);
    // The audience is the endpoint's ORIGIN — never its per-device path. Asserted as a shape
    // (the listener's port is chosen by the kernel) plus the explicit absence of the path, which
    // is the half that would regress if somebody passed the whole URL to the signer.
    expect(String(parsed.claims.aud)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(String(parsed.claims.aud)).not.toContain("/up");
    expect(String(parsed.claims.aud)).not.toContain("phone");
    // And nothing account-shaped rode along.
    expect(auth).not.toContain("acct-1");
    expect(JSON.stringify(parsed.claims)).not.toContain("acct-1");
  });

  it("the account id and the device's keys never reach the wire in readable form", async () => {
    const { captured, sub } = await sealedRequest();
    const whole = Buffer.concat([
      Buffer.from(`${captured.method} ${captured.url}\n`, "utf8"),
      Buffer.from(Object.entries(captured.headers).map(([k, v]) => `${k}: ${String(v)}`).join("\n"), "utf8"),
      captured.body,
    ]).toString("binary");
    expect(whole).not.toContain("acct-1");
    // The device's own auth secret must not be echoed back at it — it is a shared secret, and a
    // request that carried it would hand it to the distributor in the middle.
    expect(whole).not.toContain(sub.auth);
    // `p256dh` is not secret, but it has no business on the wire either: the record identifies the
    // key by the SERVER's ephemeral point, not the device's.
    expect(whole).not.toContain(sub.p256dh);
  });
});

describe("a deployment with NO keypair skips keyed rows rather than sending a discard", () => {
  it("counts the skip, warns ONCE, and leaves the row alone", async () => {
    const sub = makeSubscriber();
    const warned: string[] = [];
    const posts: string[] = [];
    const post: PushWakePost = (url) => { posts.push(url); return Promise.resolve({ status: 201 }); };
    const { db, deleted } = fakeDb([
      { id: "a", endpoint: "https://p.example/up/a", p256dh: sub.p256dh, auth: sub.auth },
      { id: "b", endpoint: "https://p.example/up/b", p256dh: sub.p256dh, auth: sub.auth },
    ]);
    const { source, emit } = fakeSource();
    const wake = startPushWake({
      dbOf: () => db, source, ownsAccount: OWN_ALL, guard: PERMIT, post,
      vapid: NO_VAPID, debounceMs: 5, minIntervalMs: 0,
      log: { info: () => {}, warn: (e) => { warned.push(e); } },
    });
    emit("acct-1", 1n);
    await tick(200);
    wake.stop();

    // Nothing was sent: a plaintext body to a connector expecting the encrypted profile is a
    // discard dressed as a delivery, and `sent()` must not count one.
    expect(posts).toEqual([]);
    expect(wake.sent()).toBe(0);
    expect(wake.skipped()).toBe(2);
    // ONE line for two rows — the counter is the per-occurrence signal, not the log.
    expect(warned.filter((e) => e === "push_wake_vapid_unconfigured")).toHaveLength(1);
    // And the registration is NOT pruned: it becomes deliverable the moment a keypair is set.
    expect(deleted).toEqual([]);
  });

  it("a row with only ONE of the two key columns is treated as keyless, not as broken", async () => {
    // A half-row is corrupt, not half-capable. Treating it as keyed would throw inside the
    // encryptor on every wake for ever; treating it as keyless sends the constant, which is what
    // a row with no usable keys is.
    const calls: (WebPushKeys | null)[] = [];
    const post: PushWakePost = (_u, _p, keys) => { calls.push(keys); return Promise.resolve({ status: 201 }); };
    const { db } = fakeDb([
      { id: "a", endpoint: "https://p.example/up/a", p256dh: makeSubscriber().p256dh, auth: null },
      { id: "b", endpoint: "https://p.example/up/b", p256dh: null, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
    ]);
    const { source, emit } = fakeSource();
    const wake = startPushWake({
      dbOf: () => db, source, ownsAccount: OWN_ALL, guard: PERMIT, post,
      vapid: withVapid().vapid, debounceMs: 5, minIntervalMs: 0,
    });
    emit("acct-1", 1n);
    await tick(200);
    wake.stop();
    expect(calls).toEqual([null, null]);
    expect(wake.skipped()).toBe(0);
  });
});

describe("an INVALID keypair stops the sender dead — including the arm that would still work", () => {
  it("sends nothing at all, subscribes to nothing, and says why once", async () => {
    /**
     * The one place this module deliberately does LESS on a failure than it could. An operator who
     * pasted a mismatched pair would otherwise still see their own raw `ntfy` topic receiving
     * wakes, and would conclude the feature works — while every phone gets nothing. A half-working
     * feature hides the mistake when the working half is the half nobody tests with.
     */
    const warned: string[] = [];
    const posts: string[] = [];
    const post: PushWakePost = (url) => { posts.push(url); return Promise.resolve({ status: 201 }); };
    let subscribed = 0;
    const source: WakeSource = {
      subscribeAll() { subscribed += 1; return () => {}; },
    };
    const { db } = fakeDb([{ id: "raw", endpoint: "https://p.example/up/raw" }]);
    const wake = startPushWake({
      dbOf: () => db, source, ownsAccount: OWN_ALL, guard: PERMIT, post,
      vapid: { kind: "invalid", why: "TF_VAPID_PUBLIC_KEY and TF_VAPID_PRIVATE_KEY are not a pair" },
      debounceMs: 5, minIntervalMs: 0,
      log: { info: () => {}, warn: (e) => { warned.push(e); } },
    });
    await tick(100);

    expect(subscribed, "an invalid configuration must not even subscribe to the hub").toBe(0);
    expect(posts).toEqual([]);
    expect(wake.sent()).toBe(0);
    expect(warned).toEqual(["push_wake_vapid_invalid"]);
    // And the handle is inert but safe to use — the composition root calls stop() unconditionally.
    expect(() => wake.stop()).not.toThrow();
    expect(() => wake.stop()).not.toThrow();
  });

  it("the refusal reason is logged WITHOUT any key material", () => {
    const fields: Record<string, unknown>[] = [];
    const { db } = fakeDb([]);
    startPushWake({
      dbOf: () => db, source: { subscribeAll: () => () => {} }, ownsAccount: OWN_ALL, guard: PERMIT,
      vapid: { kind: "invalid", why: "TF_VAPID_PRIVATE_KEY is 2 bytes, expected 32" },
      log: { info: () => {}, warn: (_e, f) => { fields.push(f ?? {}); } },
    });
    expect(fields).toHaveLength(1);
    const blob = JSON.stringify(fields[0]);
    expect(blob).toContain("expected 32");
    // A length is a safe thing to say; the value is not, and the reason strings never carry one.
    expect(blob).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});

describe("a HOSTILE distributor response cannot hold a socket or kill the organizer", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE RESPONSE IS AN ATTACK SURFACE, NOT DATA
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The peer at the other end of a wake POST is a distributor whoever registered the endpoint
   * chose. On a multi-account server that is any authenticated account, and "the endpoint I
   * registered points at a server I wrote" is the ordinary case. Two shapes, both one line of
   * server code, both read against the first version of `defaultPost`:
   *
   *  · **DRIP** — answer the headers, then send a byte every so often and never end. The first
   *    version cleared its abort timer in a `finally` that ran when the HEADERS arrived, so from
   *    that moment nothing bounded the request, and `resume()` drained happily for ever. Every
   *    later wake added another held socket.
   *  · **RESET** — answer the headers, then destroy the socket. `resume()` with no `'error'`
   *    listener makes that an unhandled `'error'` on an `IncomingMessage`, which in Node takes the
   *    PROCESS down — and it arrives after `post()` has already resolved, so the caller's own
   *    `try/catch` cannot see it. The organizer dies, every mailbox stops syncing, for a wake.
   *
   * ── HOW THESE WERE WATCHED RED ────────────────────────────────────────────────────────────
   *
   * Against the pre-fix body (`clearTimeout` in a headers-time `finally`, `res.stream.resume()`,
   * no error listener): DRIP hung — the server never saw its connection close and the assertion
   * timed out — and RESET aborted the whole test FILE with an unhandled stream error, which is
   * exactly the production failure wearing a test harness. Both green after the fix.
   */

  it("a DRIP body does not hold the socket past the request timeout", async () => {
    let closed = false;
    let ticker: ReturnType<typeof setInterval> | null = null;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(201, { "content-type": "text/plain" });
      // Never `end()`. A byte at a time, for ever — a perfectly well-formed HTTP response that
      // simply does not finish.
      ticker = setInterval(() => { res.write("."); }, 20);
      (ticker as unknown as { unref?: () => void }).unref?.();
      res.on("close", () => {
        closed = true;
        if (ticker) clearInterval(ticker);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const { db } = fakeDb([{ id: "r", endpoint: `http://127.0.0.1:${port}/up/drip` }]);
      const { source, emit } = fakeSource();
      const wake = startPushWake({
        dbOf: () => db, source, ownsAccount: OWN_ALL,
        guard: { async check() { return ["127.0.0.1"]; } },
        vapid: NO_VAPID,
        debounceMs: 5, minIntervalMs: 0,
        // A short deadline so the assertion is about the MECHANISM and not about waiting out the
        // shipped eight seconds. The pre-fix code ignored it entirely once headers had arrived.
        timeoutMs: 300,
      });
      emit("acct-1", 1n);

      // The client must give up and drop the connection. Generous bound — three times the
      // deadline — so this fails on "never closes", not on a slow machine.
      for (let i = 0; i < 120 && !closed; i++) await tick(25);
      expect(closed, "the client held a dripping connection open past its own deadline").toBe(true);
      wake.stop();
    } finally {
      if (ticker) clearInterval(ticker);
      server.close();
    }
  });

  it("a RESET mid-body is a non-delivery, not a crash — and the next wake still works", async () => {
    // Two endpoints on one account: the hostile one first, then a well-behaved one. The second
    // POST arriving is the evidence that the first did not take the process (or the pass) with it.
    let hostileHits = 0;
    const hostile = createServer((req, res) => {
      req.resume();
      hostileHits += 1;
      res.writeHead(201, { "content-length": "1024" });   // promise a body…
      res.write("x");
      // …then vanish. `destroy()` on the socket is an RST as far as the client is concerned.
      res.socket?.destroy();
    });
    hostile.listen(0, "127.0.0.1");
    await once(hostile, "listening");
    const hostilePort = (hostile.address() as AddressInfo).port;

    let goodHits = 0;
    const good = createServer((req, res) => {
      req.resume();
      req.on("end", () => { goodHits += 1; res.writeHead(201).end(); });
    });
    good.listen(0, "127.0.0.1");
    await once(good, "listening");
    const goodPort = (good.address() as AddressInfo).port;

    try {
      const { db } = fakeDb([
        { id: "hostile", endpoint: `http://127.0.0.1:${hostilePort}/up/reset` },
        { id: "good", endpoint: `http://127.0.0.1:${goodPort}/up/ok` },
      ]);
      const { source, emit } = fakeSource();
      const wake = startPushWake({
        dbOf: () => db, source, ownsAccount: OWN_ALL,
        guard: { async check() { return ["127.0.0.1"]; } },
        vapid: NO_VAPID,
        debounceMs: 5, minIntervalMs: 0, timeoutMs: 1_000,
      });
      emit("acct-1", 1n);

      for (let i = 0; i < 200 && goodHits === 0; i++) await tick(25);
      expect(hostileHits, "the hostile endpoint was never dialled, so nothing was proven").toBe(1);
      expect(goodHits, "a reset on one endpoint stopped the endpoint beside it").toBe(1);
      wake.stop();
    } finally {
      hostile.close();
      good.close();
    }
  });

  it.each([
    ["a change of protocol (101)", SWITCH],
    ["an answer that is no HTTP", NOT_HTTP],
  ])("%s is a non-delivery, not a hold — the endpoint beside it is still woken", async (_shape, bytes) => {
    // The 101 endpoint first: a request that never settled held the whole pass, so the second row never got its wake.
    let switched = 0;
    const switching = await farSide((socket) => { switched += 1; socket.write(bytes); });
    let goodHits = 0;
    const good = createServer((req, res) => {
      req.resume();
      req.on("end", () => { goodHits += 1; res.writeHead(201).end(); });
    });
    good.listen(0, "127.0.0.1");
    await once(good, "listening");
    const goodPort = (good.address() as AddressInfo).port;

    try {
      const { db, deleted } = fakeDb([
        { id: "switching", endpoint: `${switching.url}/up/switch` },
        { id: "good", endpoint: `http://127.0.0.1:${goodPort}/up/ok` },
      ]);
      const { source, emit } = fakeSource();
      const wake = startPushWake({
        dbOf: () => db, source, ownsAccount: OWN_ALL,
        guard: { async check() { return ["127.0.0.1"]; } },
        vapid: NO_VAPID,
        debounceMs: 5, minIntervalMs: 0, timeoutMs: 1_000,
      });
      emit("acct-1", 1n);

      for (let i = 0; i < 120 && goodHits === 0; i++) await tick(25);
      expect(switched, "the switching endpoint was never dialled, so nothing was proven").toBe(1);
      expect(goodHits, "a 101 on one endpoint held the pass, and the endpoint beside it was never woken").toBe(1);
      // Given up as any failed POST is: not counted as sent, not pruned, tried again on the next wake.
      expect(wake.sent()).toBe(1);
      expect(deleted).toEqual([]);
      wake.stop();
    } finally {
      await switching.close();
      good.close();
    }
  });

  it("stop() cuts a pass mid-account — a deposed leader stops dialling the remaining rows", async () => {
    /**
     * The lock-loss half. A worker that loses its leader lock while `fire()` is walking an
     * account's rows used to keep going row by row, beside a successor doing the same — the
     * duplicate-wake shape reached from the teardown side rather than the sharding side.
     */
    const dialled: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });

    const post: PushWakePost = async (url) => {
      dialled.push(url);
      if (dialled.length === 1) await gate;      // hold the FIRST dial open
      return { status: 201 };
    };

    const { db } = fakeDb([
      { id: "a", endpoint: "https://push.example.com/up/a" },
      { id: "b", endpoint: "https://push.example.com/up/b" },
      { id: "c", endpoint: "https://push.example.com/up/c" },
    ]);
    const { source, emit } = fakeSource();
    const wake = startPushWake({
      dbOf: () => db, source, ownsAccount: OWN_ALL, guard: PERMIT, post, vapid: NO_VAPID,
      debounceMs: 5, minIntervalMs: 0,
    });
    emit("acct-1", 1n);
    for (let i = 0; i < 80 && dialled.length === 0; i++) await tick(25);
    expect(dialled.length, "the first dial never started").toBe(1);

    wake.stop();                                  // leadership lost, mid-pass
    release!();                                   // let the in-flight dial finish
    await tick(200);

    expect(dialled, "a stopped sender kept dialling the rest of the account's rows")
      .toEqual(["https://push.example.com/up/a"]);
  });
});

describe("a window of the calendar's records alone dials nothing", () => {
  const ROW = { id: "r", endpoint: "https://push.example.com/up/abc" };
  const run = async (rows: Row[], held: boolean): Promise<{ posts: number; asked: number }> => {
    const { db, asked } = fakeDb(rows, held);
    let posts = 0;
    const post: PushWakePost = () => { posts += 1; return Promise.resolve({ status: 201 }); };
    const { source, emit } = fakeSource();
    const wake = startPushWake({ dbOf: () => db, source, guard: PERMIT, post, ownsAccount: OWN_ALL, vapid: NO_VAPID, debounceMs: 5, minIntervalMs: 0 });
    emit("acct-1", 4n);
    emit("acct-1", 9n);
    await tick(200);
    wake.stop();
    return { posts, asked: asked() };
  };

  it("no record but the calendar's: no request, however many registrations stand", async () => {
    expect(await run([ROW, { ...ROW, id: "r2", endpoint: "https://push.example.com/up/def" }], false)).toEqual({ posts: 0, asked: 1 });
  });

  it("a record that is not the calendar's: one request per registration, and the question asked once for the window", async () => {
    expect(await run([ROW, { ...ROW, id: "r2", endpoint: "https://push.example.com/up/def" }], true)).toEqual({ posts: 2, asked: 1 });
  });

  it("no registration: the change log is not asked at all", async () => {
    expect(await run([], true)).toEqual({ posts: 0, asked: 0 });
  });

  it("the window's seqs reach no request and no log line, on every path that writes one", async () => {
    const SEQS = [7300017300017n, 7300027300027n];
    const said: unknown[] = [];
    const log = {
      info: (event: string, fields?: Record<string, unknown>) => { said.push([event, fields]); },
      warn: (event: string, fields?: Record<string, unknown>) => { said.push([event, fields]); },
    };
    const sent: unknown[][] = [];
    /** One pass over two registrations: a refusing gate, then a dead endpoint that is pruned. */
    const pass = async (db: Tx): Promise<void> => {
      const refuseFirst: PushEndpointGuard = { async check(url) { if (url.endsWith("/refused")) throw new Error("no"); return ["203.0.113.9"]; } };
      const post: PushWakePost = (...args) => { sent.push(args); return Promise.resolve({ status: 410 }); };
      const { source, emit } = fakeSource();
      const wake = startPushWake({ dbOf: () => db, source, guard: refuseFirst, post, ownsAccount: OWN_ALL, vapid: NO_VAPID, log, debounceMs: 5, minIntervalMs: 0 });
      for (const seq of SEQS) emit("acct-1", seq);
      await tick(200);
      wake.stop();
    };
    await pass(fakeDb([{ id: "a", endpoint: "https://push.example.com/refused" }, { id: "b", endpoint: "https://push.example.com/gone" }]).db);
    // And a pass whose own read fails: the one line that carries a thrown value.
    await pass({ select: () => { throw new Error(`a driver's words: ${SEQS.join(" ")}`); } } as unknown as Tx);

    expect(said.map((line) => (line as [string])[0]).sort()).toEqual(["push_wake_endpoint_pruned", "push_wake_endpoint_refused", "push_wake_pass_failed"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(3);
    const fields = said.flatMap((line) => Object.entries((line as [string, Record<string, unknown> | undefined])[1] ?? {}));
    // The failed pass hands the thrown value to the logger whole, which writes its class and code and no word of it.
    expect(fields.filter(([name]) => name === "err")).toHaveLength(1);
    const written = JSON.stringify([fields.filter(([name]) => name !== "err"), sent], (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    expect(written).not.toContain("73000");
  });
});

describe("the shard filter — only the owning shard's leader wakes an account", () => {
  it("an account this shard does not own is never queried and never dialled", async () => {
    let selected = 0;
    const db = {
      select: () => ({ from: () => ({ where: () => { selected += 1; return Promise.resolve([]); } }) }),
      delete: () => ({ where: () => Promise.resolve([]) }),
    } as unknown as Tx;
    const posts: string[] = [];
    const post: PushWakePost = (url) => { posts.push(url); return Promise.resolve({ status: 201 }); };
    const { source, emit } = fakeSource();
    const wake = startPushWake({
      dbOf: () => db, source, guard: PERMIT, post, vapid: NO_VAPID, debounceMs: 5, minIntervalMs: 0,
      // The sharded answer: this account belongs to somebody else's lock.
      ownsAccount: async () => false,
    });
    emit("someone-elses-account", 1n);
    await tick(200);
    wake.stop();

    // Not even the SELECT — the ownership question is answered before the query, so a shard that
    // owns nothing costs one predicate per wake rather than a table read per wake.
    expect(selected, "a shard queried an account it does not own").toBe(0);
    expect(posts).toEqual([]);
  });
});

describe("census 4 — the POST seam has no parameter content could ride", () => {
  it("is called with exactly (url, pin, keys) and nothing else", async () => {
    const calls: unknown[][] = [];
    const post: PushWakePost = (...args) => {
      calls.push(args);
      return Promise.resolve({ status: 201 });
    };
    const { db } = fakeDb([{ id: "r", endpoint: "https://push.example.com/up/abc" }]);
    const { source, emit } = fakeSource();
    const wake = startPushWake({
      dbOf: () => db, source, ownsAccount: OWN_ALL, guard: PERMIT, post, vapid: NO_VAPID,
      debounceMs: 5, minIntervalMs: 0,
    });
    emit("acct-1", 1n);
    for (let i = 0; i < 60 && calls.length === 0; i++) await tick(25);
    wake.stop();

    expect(calls.length).toBe(1);
    expect(calls[0]!.length).toBe(3);
    expect(calls[0]![0]).toBe("https://push.example.com/up/abc");
    expect(calls[0]![1]).toEqual(["203.0.113.9"]);
    // A keyless row hands `null` — not `undefined`, not `{}`. The absence is explicit.
    expect(calls[0]![2]).toBeNull();
  });

  it("the KEYS argument is exactly the two key fields off the row, and nothing else", async () => {
    /**
     * The third parameter is the one place a widening could hide, so its shape is pinned rather
     * than its presence. `{ p256dh, auth }` and no third property: a `subject` threaded through
     * here — which is exactly what a careless "while I'm at it" edit to the projection would
     * produce, since the row is right there — fails this.
     */
    const sub = makeSubscriber();
    const calls: unknown[][] = [];
    const post: PushWakePost = (...args) => {
      calls.push(args);
      return Promise.resolve({ status: 201 });
    };
    const { db } = fakeDb([
      { id: "r", endpoint: "https://push.example.com/up/abc", p256dh: sub.p256dh, auth: sub.auth },
    ]);
    const { source, emit } = fakeSource();
    const wake = startPushWake({
      dbOf: () => db, source, ownsAccount: OWN_ALL, guard: PERMIT, post, vapid: withVapid().vapid,
      debounceMs: 5, minIntervalMs: 0,
    });
    emit("acct-1", 1n);
    for (let i = 0; i < 60 && calls.length === 0; i++) await tick(25);
    wake.stop();

    expect(calls.length).toBe(1);
    expect(calls[0]!.length).toBe(3);
    const keys = calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(keys).sort()).toEqual(["auth", "p256dh"]);
    expect(keys.p256dh).toBe(sub.p256dh);
    expect(keys.auth).toBe(sub.auth);
  });
});
