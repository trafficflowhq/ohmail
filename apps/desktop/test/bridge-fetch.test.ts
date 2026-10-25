import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter } from "@ohmail/client-engine";

import {
  BRIDGE_DEADLINE_MS, bridgeFetch, bridgeTransportReading, createEngineAdapter, engineConfigure, engineLogout, engineRetry,
  engineStartOver, engineStatus, engineSwitchCommit, engineSwitchRestore, engineUnlockRetry, invokeShell,
  LARGE_BODY_FROM_BYTES, WINDOW_SEARCH_PHASES_PATH,
} from "../src/bridge-fetch.js";
import { installOfflineGuard } from "../src/offline-guard.js";

/**
 * The bridge, driven against a stand-in shell.
 *
 * `desktop-shell.test.ts` asserts what the config says; this asserts what the code does. The
 * command channel is replaced with a function that records what it was asked for and answers in
 * the shell's own encoding — a four-byte length, the metadata JSON, then the body bytes — so a
 * passing test here is a test about this side of that encoding rather than about a double written
 * to agree with it.
 *
 * The one thing it cannot cover is the shell's half: that is Rust, and it is covered there
 * (`cargo test --features local-engine` runs the frame codec against a real child process).
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}

const host = globalThis as Host;

/** Encode an answer exactly as the shell's `engine_request` does. */
function encode(
  status: number,
  body: string | Uint8Array = "",
  headers: [string, string][] = [],
  statusText = "OK",
): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: headers }));
  const payload = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked {
  command: string;
  payload?: Record<string, unknown>;
}

/** Install a stand-in shell. Returns the log of what the page asked it for. */
function shellAnswering(answer: (asked: Asked) => unknown): Asked[] {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      asked.push({ command, payload });
      return answer({ command, payload });
    },
  };
  return asked;
}

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

/* The in-process scheme answers a raw response as an ArrayBuffer of the page's realm; one from
   another realm (an iframe's, a test's `vm` context) is the same bytes and must read as them. */
describe("the transport a raw answer crossed by", () => {
  it("reads the scheme's ArrayBuffer, of this realm or another, as bytes, and counts it as ipc", async () => {
    const { runInNewContext } = await import("node:vm");
    const bytes = encode(200, JSON.stringify({ ok: true }));
    const foreign = runInNewContext("new ArrayBuffer(n)", { n: bytes.byteLength }) as ArrayBuffer;
    new Uint8Array(foreign).set(bytes);
    expect(foreign instanceof ArrayBuffer).toBe(false);
    for (const answer of [bytes.slice().buffer, foreign]) {
      shellAnswering(() => answer);
      const before = bridgeTransportReading();
      const res = await bridgeFetch("/health");
      expect(await res.json()).toEqual({ ok: true });
      expect(bridgeTransportReading()).toEqual({ bridgeTransport: "ipc", answers: before.answers + 1, json: before.json });
    }
  });
});

describe("the bridge", () => {
  it("sends the request the client composed, and nothing it did not", async () => {
    const asked = shellAnswering(() => encode(200, "{}"));

    await bridgeFetch("/mailboxes", {
      method: "post",
      headers: { "content-type": "application/json", "idempotency-key": "k-1" },
      body: '{"name":"work"}',
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.command).toBe("engine_request");
    const sent = asked[0]!.payload!;
    // Upper-cased, because a method is not case-insensitive on the wire.
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/mailboxes");
    expect(sent.headers).toEqual([
      ["content-type", "application/json"],
      ["idempotency-key", "k-1"],
    ]);
    // Bytes, so a body is a body whether or not it happens to be text.
    expect(sent.body).toEqual([...new TextEncoder().encode('{"name":"work"}')]);
    // THE CREDENTIAL IS NOT HERE, and that is the point of the whole arrangement: the shell adds
    // the engine's authorization on its own side, so the page holds nothing it could leak.
    expect(JSON.stringify(sent)).not.toMatch(/authorization/i);
  });

  it("a LARGE text body crosses as its own text, and a large byte body as base64 — never a number array", async () => {
    // The command channel is JSON: an array of byte values costs the renderer several bytes per
    // byte sent, which is most of a large attachment's cost. The shell takes either spelling.
    const asked = shellAnswering(() => encode(200, "{}"));
    const text = `{"a":"${"x".repeat(LARGE_BODY_FROM_BYTES)}"}`;
    await bridgeFetch("/local/window/outbox", { method: "POST", body: text });
    expect(asked[0]!.payload!.bodyText).toBe(text);
    expect("body" in asked[0]!.payload!).toBe(false);

    const bytes = new Uint8Array(LARGE_BODY_FROM_BYTES + 3);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) & 0xff;
    await bridgeFetch("/cloud/staged-upload/t-1", { method: "PUT", body: bytes });
    const b64 = asked[1]!.payload!.body64 as string;
    expect(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).toEqual(bytes);
    expect("body" in asked[1]!.payload!).toBe(false);
  });

  it("…and a body under the line keeps the shape every ordinary request has always had", async () => {
    const asked = shellAnswering(() => encode(200, "{}"));
    await bridgeFetch("/drafts", { method: "POST", body: "x".repeat(LARGE_BODY_FROM_BYTES - 1) });
    expect(Array.isArray(asked[0]!.payload!.body)).toBe(true);
    expect("bodyText" in asked[0]!.payload!).toBe(false);
  });

  it("puts the answer back together as a Response", async () => {
    shellAnswering(() =>
      encode(201, '{"id":"m-1"}', [
        ["content-type", "application/json"],
        ["x-sync-seq", "42"],
      ], "Created"),
    );

    const res = await bridgeFetch("/messages");
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.headers.get("x-sync-seq")).toBe("42");
    expect(await res.json()).toEqual({ id: "m-1" });
  });

  it("carries bytes that are not text", async () => {
    // A mail body or an attachment is the case the encoding exists for: re-encoding one through a
    // JSON string would cost a copy and a UTF-8 assumption these bytes break.
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    shellAnswering(() => encode(200, bytes, [["content-type", "image/png"]]));

    const res = await bridgeFetch("/messages/m-1/attachments/a-1");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("reads both shapes the command channel answers in", async () => {
    // The custom-scheme transport hands back an ArrayBuffer; the message channel it falls back to
    // under this app's CSP hands back a plain array of byte values, because that path returns
    // through a JSON callback. Reading only one of them would work on a developer's machine and
    // fail in the packaged app, or the reverse.
    const encoded = encode(200, "ok");
    for (const shape of [encoded.buffer, [...encoded]]) {
      shellAnswering(() => shape);
      const res = await bridgeFetch("/health");
      expect(await res.text()).toBe("ok");
    }
  });

  it("answers a 204 without inventing a body", async () => {
    // `new Response(bytes, { status: 204 })` throws even for zero bytes. The engine answers 204 to
    // several mutations, so getting this wrong would turn every successful delete into a transport
    // failure — which the client would then retry.
    shellAnswering(() => encode(204, "", [], "No Content"));
    const res = await bridgeFetch("/messages/m-1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("fails the caller when there is no shell to ask", async () => {
    delete host.__TAURI_INTERNALS__;
    await expect(bridgeFetch("/sync")).rejects.toThrow(/not running inside the ohmail shell/);
    await expect(engineStatus()).rejects.toThrow(/not running inside the ohmail shell/);
  });

  it("rejects an aborted request rather than leaving the race unsettled", async () => {
    // The client bounds exactly one call with a signal and RACES the abort against the answer. A
    // transport that ignored the signal would leave that race to be won by a request that never
    // comes back, which is the hang the bound exists to prevent.
    shellAnswering(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = bridgeFetch("/messages/m-1/attachments", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("gives up on a never-answering engine at the transport deadline, by NAME", async () => {
    // A wedged-but-alive engine used to leave every press pending for ever with no sentence:
    // the bridge carried a deadline for no caller but the one with a signal. The rejection is
    // NAMED so a press site's catch can render its message as the sentence.
    vi.useFakeTimers();
    try {
      shellAnswering(() => new Promise(() => {}));
      const pending = bridgeFetch("/mailboxes");
      const verdict = pending.then(
        () => "answered",
        (err: Error) => `${err.name}: ${err.message}`,
      );
      await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
      expect(await verdict).toBe(
        "BridgeDeadlineError: ohmail Desktop: the local engine did not answer within a minute, "
        + "so this request was given up.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer inside the deadline resolves and leaves NO timer behind", async () => {
    // The timer is cleared on settle — a deadline that outlives its answer would reject into
    // nothing per request and keep a long-lived page's timer table growing.
    vi.useFakeTimers();
    try {
      shellAnswering(() => encode(200, "ok"));
      const res = await bridgeFetch("/health");
      expect(await res.text()).toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a body it cannot send rather than sending the wrong bytes", async () => {
    shellAnswering(() => encode(200));
    await expect(bridgeFetch("/x", { method: "POST", body: { not: "a string" } })).rejects.toThrow(
      /string or bytes/,
    );
  });

  it("treats an impossible status as a transport failure, not as an answer", async () => {
    // A status this shell could not have produced means the two ends disagreed. A fabricated 500
    // would look like the engine's own answer; a thrown error is what the client turns into a
    // retryable failure.
    shellAnswering(() => encode(0));
    await expect(bridgeFetch("/sync")).rejects.toThrow(/status 0/);
  });

  it("builds the client's adapter over itself", async () => {
    const asked = shellAnswering(({ command }) =>
      command === "engine_status"
        ? { state: "serving", mailboxId: "mbx-1" }
        : encode(200, JSON.stringify({ body: "hello", html: null })),
    );

    expect(await engineStatus()).toEqual({ state: "serving", mailboxId: "mbx-1" });

    // The real class, driven end to end: the adapter composes a request, the bridge encodes it, the
    // stand-in shell answers, and the adapter parses what came back.
    const adapter = createEngineAdapter();
    await adapter.fetchBody("m-1");

    const request = asked.find((a) => a.command === "engine_request")!;
    expect(request.payload!.method).toBe("GET");
    // Root-relative, because the engine's own base URL is not a fact this page needs.
    expect(String(request.payload!.url).startsWith("/")).toBe(true);
  });

  it("marks a send's own writes, and only those, for an answer before the copy's echo", async () => {
    const draft = JSON.stringify({ id: "d-1", mailboxId: "mbx-1", bcc: [], contentRevision: "r1", updatedAt: new Date().toISOString() });
    const asked = shellAnswering(({ payload }) => {
      const url = String(payload!.url);
      if (url.endsWith("/send")) return encode(200, JSON.stringify({ status: "sent", providerMessageId: "<p@x>" }));
      return encode(url.startsWith("/drafts") ? (payload!.method === "POST" ? 201 : 200) : 200, url.startsWith("/drafts") ? draft : "{}");
    });
    const adapter = createEngineAdapter();
    const fields = { mailboxId: "mbx-1", subject: "s", body: "b", to: [{ name: null, address: "a@x.test" }], cc: [], bcc: [] };
    await adapter.mutate({ kind: "draft_save", draftId: null, ...fields } as never, { idempotencyKey: "save-1" });
    await adapter.mutate({ kind: "mail_send", inReplyTo: null, ...fields } as never, { idempotencyKey: "send-1" });
    await adapter.mutate({ kind: "mail_send", inReplyTo: null, draftId: "d-1", ...fields } as never, { idempotencyKey: "send-2" });
    const marks = asked.filter((a) => a.command === "engine_request" && a.payload!.method !== "GET").map((a) =>
      `${String(a.payload!.method)} ${String(a.payload!.url)} ${(a.payload!.headers as [string, string][]).find(([n]) => n === "x-ohmail-echo")?.[1] ?? "-"}`);
    expect(marks).toEqual([
      "POST /drafts -", "POST /drafts later", "POST /drafts/d-1/send later", "PUT /drafts/d-1 later", "POST /drafts/d-1/send later",
    ]);
  });

  it("a forward naming its files asks the engine's /hello first; a server without it is refused with nothing posted", async () => {
    const asked = shellAnswering(({ payload }) =>
      encode(200, String(payload?.url) === "/hello" ? JSON.stringify({ product: "ohmail", features: {} }) : "{}"));
    const adapter = createEngineAdapter();
    const refused = await adapter.mutate(
      { kind: "mail_send", inReplyTo: null, forwardOf: "m-1", forwardParts: [], subject: "Fwd: x", body: "fyi", to: [{ name: null, address: "sam@example.test" }] },
      { idempotencyKey: "k-1" },
    ).catch((e: unknown) => e as { code?: string });
    expect((refused as { code?: string }).code).toBe("forward_parts_unsupported");
    const requests = asked.filter((a) => a.command === "engine_request").map((a) => `${String(a.payload!.method)} ${String(a.payload!.url)}`);
    expect(requests).toEqual(["GET /hello"]);
  });
});

describe("the offline guard", () => {
  it("throws where it is called, for every address that is one", () => {
    const scope: Record<string, unknown> = {
      fetch: () => Promise.resolve("sent"),
      XMLHttpRequest: class {},
      WebSocket: class {},
      EventSource: class {},
    };
    installOfflineGuard(scope);
    expect(() => (scope.fetch as () => unknown)("https://example.invalid")).toThrow(
      /offline by construction/,
    );
    expect(() => new (scope.WebSocket as new (u: string) => unknown)("wss://example.invalid")).toThrow(
      /offline by construction/,
    );
  });

  /* What the guard hands on — this build's own spelling of the command scheme and nothing else — is
     `command-channel-egress.test.ts`, with the real guard on every platform's spelling. */

  /**
   * A FORGOTTEN BRIDGE IS LOUD.
   *
   * The client's adapter falls back to the global `fetch` when nothing is injected into it, which
   * in a browser would quietly try to reach a server this build does not have. Here the guard has
   * replaced that global with a thrower, so the mistake surfaces at the first request with the
   * guard named in the message.
   *
   * Both spellings are accepted because both are that same refusal: in this tree the adapter is the
   * real client and it fails when it calls the sealed `fetch`; in the published preview the module
   * is the stub and it fails at construction. What must never happen is neither.
   */
  it("makes an un-bridged adapter fail at the first request", async () => {
    const original = globalThis.fetch;
    try {
      installOfflineGuard();
      await expect(
        (async () => {
          const adapter = new HttpAdapter({ baseUrl: "" });
          await adapter.fetchBody("m-1");
        })(),
      ).rejects.toThrow(/offline by construction|no Cloud sync client/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE DOOR GESTURE AT A TIME — a sign-out and a door switch may not overlap
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `Shell::logout` reads the door configuration once and acts on that snapshot: it asks the engine
 * to clear the credential of the door it read, and only then removes `config.json`. A door switch
 * landing inside that window REPLACES the engine, so the clear goes to the new door and the old
 * door's sealed mailbox password is still on disk under a sign-out reported as done. It is two
 * deliberate gestures in the same second — a Settings panel with both on it — and the strongest
 * credential this product holds locally.
 *
 * Both commands are invoked from `bridge-fetch.ts` and from nowhere else (no other module names
 * either string), so the window's latch is the whole of the reachable path. The Rust shell's own
 * re-read is a second line of defence and is owed on the cargo-host lane.
 */
describe("a sign-out and a door switch are one gesture at a time", () => {
  /**
   * A shell that holds the FIRST command until the test says so and answers every later one at
   * once. Only the first is held deliberately: a shell that held them all would make a latch's
   * absence read as a hung test rather than as the second command reaching the shell, and a
   * timeout is not a measurement of this property.
   */
  function heldShell(): { asked: Asked[]; release: () => void } {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const asked = shellAnswering(async () => {
      if (first) { first = false; await gate; }
      return {};
    });
    return { asked, release: () => release() };
  }

  it("REFUSES a door switch while a sign-out is still out, and names the one in flight", async () => {
    const held = heldShell();
    const out = engineLogout();

    await expect(engineConfigure({ mode: "cloud" } as never)).rejects.toThrow(/signing out/);
    expect(
      held.asked.map((a) => a.command),
      "the switch reached the shell, which is the snapshot this latch exists to protect",
    ).toEqual(["engine_logout"]);

    held.release();
    await out;
  });

  it("REFUSES a sign-out while a door switch is still out", async () => {
    // The other order, because the snapshot is taken on whichever arrives first and a latch that
    // only held one way would leave the same window open from the other side.
    const held = heldShell();
    const out = engineConfigure({ mode: "cloud" } as never);

    await expect(engineLogout()).rejects.toThrow(/changing the door/);
    expect(held.asked.map((a) => a.command)).toEqual(["engine_configure"]);

    held.release();
    await out;
  });

  it("POSITIVE CONTROL — one after the other is ordinary, and a refusal does not latch it shut", async () => {
    /* Without this the latch is satisfied by one that never opens again — a Settings panel whose
       Sign out works once per launch. The refusal above happens first deliberately: the `finally`
       that clears the latch is what makes the gesture after it possible at all. */
    const asked = shellAnswering(() => ({}));

    await engineLogout();
    await engineConfigure({ mode: "cloud" } as never);
    await engineLogout();

    expect(asked.map((a) => a.command))
      .toEqual(["engine_logout", "engine_configure", "engine_logout"]);
  });

  it("a gesture that THREW releases the latch too", async () => {
    // The shell refuses a sign-out it could not complete (`LOGOUT_UNCHANGED`), and that refusal is
    // the state a person retries from. A latch left shut by it would turn one refused sign-out
    // into a door nobody can leave for the rest of the launch.
    shellAnswering(() => { throw new Error("the engine refused to clear the stored login"); });

    await expect(engineLogout()).rejects.toThrow(/refused to clear/);
    await expect(engineLogout()).rejects.toThrow(/refused to clear/);
  });
});

describe("the shell's own commands give up at the same deadline", () => {
  /** Every door into the shell this module owns, each asked of a shell that never answers. */
  const DOORS: [string, () => Promise<unknown>][] = [
    ["engineStatus", () => engineStatus()],
    ["invokeShell", () => invokeShell("diagnostic_facts")],
    ["engineConfigure", () => engineConfigure({ mode: "cloud" } as never)],
    ["engineLogout", () => engineLogout()],
    ["engineSwitchCommit", () => engineSwitchCommit()],
    ["engineSwitchRestore", () => engineSwitchRestore()],
    ["engineUnlockRetry", () => engineUnlockRetry()],
    ["engineStartOver", () => engineStartOver()],
    ["engineRetry", () => engineRetry()],
  ];

  for (const [name, ask] of DOORS) {
    it(`${name} rejects BY NAME when the shell never answers`, async () => {
      vi.useFakeTimers();
      /* Answered AFTER the verdict, so a door gesture's latch opens again for the next case. */
      let answer = (): void => {};
      const late = new Promise<Record<string, never>>((r) => { answer = () => r({}); });
      try {
        shellAnswering(() => late);
        const verdict = ask().then(() => "answered", (err: Error) => err.name);
        await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
        expect(await Promise.race([verdict, Promise.resolve("still pending")])).toBe("BridgeDeadlineError");
      } finally {
        answer();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    });
  }

  it("an answer inside the deadline resolves and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      shellAnswering(() => ({ state: "serving" }));
      await expect(engineStatus()).resolves.toEqual({ state: "serving" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the door latch stays shut until the SHELL answers, not until the deadline", async () => {
    /* The latch guards the shell's one snapshot of the door. A sign-out given up by the window
       is still running in the shell, so a door switch started then would meet that snapshot. */
    vi.useFakeTimers();
    try {
      let answer = (): void => {};
      const held = new Promise<void>((r) => { answer = r; });
      const asked = shellAnswering(async ({ command }) => {
        if (command === "engine_logout") await held;
        return {};
      });
      const out = engineLogout().then(() => "answered", (err: Error) => err.name);
      await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
      expect(await Promise.race([out, Promise.resolve("still pending")])).toBe("BridgeDeadlineError");
      await expect(engineConfigure({ mode: "cloud" } as never)).rejects.toThrow(/signing out/);
      expect(asked.map((a) => a.command)).toEqual(["engine_logout"]);
      answer();
      await vi.advanceTimersByTimeAsync(0);
      await engineConfigure({ mode: "cloud" } as never);
      expect(asked.map((a) => a.command)).toEqual(["engine_logout", "engine_configure"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a Search's timings go to the engine's own log, through the bridge", () => {
  it("the adapter carries the capability, and a record is one POST to the door with the record as its body", async () => {
    const asked = shellAnswering(() => encode(204));
    const adapter = createEngineAdapter();
    expect(typeof adapter.reportSearchPhases).toBe("function");
    const record = {
      verdict: "matched" as const, debounceMs: 250, sendMs: 0, roundTripMs: 160, paintMs: 4, totalMs: 414,
      serverMs: 108, sentAtMs: 1_790_000_000_000, answeredAtMs: 1_790_000_000_160,
    };
    await adapter.reportSearchPhases!(record);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.command).toBe("engine_request");
    expect(asked[0]!.payload).toMatchObject({ method: "POST", url: WINDOW_SEARCH_PHASES_PATH });
    const body = new TextDecoder().decode(new Uint8Array(asked[0]!.payload!.body as number[]));
    expect(JSON.parse(body)).toEqual(record);
  });
});

/**
 * A STALE 402 AFTER AN OPEN VERDICT IS NOT BELIEVED — the browser tab's rule, on this door. The
 * account's own read answering `access: "open"` opens a window as long as the service's verdict
 * cache; a 402 from an instance still holding the old refusal inside it raises no lock, and one
 * after it does. Both answers are stored for the next first paint under the window's owner.
 */
describe("the access notice after an open verdict", () => {
  it("disbelieves a 402 for a minute after an open answer, and believes one after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T08:00:00.000Z"));
    // This file runs without a DOM; the window's storage is a plain map here.
    const jar = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => jar.get(k) ?? null,
      setItem: (k: string, v: string) => { jar.set(k, String(v)); },
      removeItem: (k: string) => { jar.delete(k); },
      key: (i: number) => [...jar.keys()][i] ?? null,
      get length() { return jar.size; },
      clear: () => { jar.clear(); },
    });
    try {
      const { onAccessRefused, ACCOUNT_ACCESS_PATH } = await import("../src/bridge-fetch.js");
      const { setStorageOwner } = await import("../../webapp/app/shell/storage-owner.js");
      setStorageOwner("mbx_stale");
      const seen: unknown[] = [];
      const stop = onAccessRefused((f) => seen.push(f));
      const refusal = JSON.stringify({ error: { code: "subscription_required", details: { reason: "payment_required" } } });
      shellAnswering(({ payload }) => (payload?.url === ACCOUNT_ACCESS_PATH
        ? encode(200, JSON.stringify({ metered: true, access: "open" }))
        : encode(402, refusal)));
      await bridgeFetch(ACCOUNT_ACCESS_PATH);
      expect(localStorage.getItem("ohmail.access.mbx_stale")).toBe("open");
      // The window the drain loop reads is this one: the bridge's open answer feeds it.
      const { liftedAt, refusalIsStale } = await import("../../webapp/app/shell/access-window.js");
      expect(refusalIsStale()).toBe(true);
      expect(liftedAt(), "an open answer with no refusal before it is not a reopening").toBeNull();
      await bridgeFetch("/mailboxes");
      expect(seen, "a stale 402 raised the lock inside the window").toEqual([]);
      vi.setSystemTime(new Date("2026-09-26T08:01:01.000Z"));
      expect(refusalIsStale()).toBe(false);
      await bridgeFetch("/mailboxes");
      expect(seen).toHaveLength(1);
      expect(localStorage.getItem("ohmail.access.mbx_stale")).toBe("closed");
      // Paid: the next open answer lands over the stored refusal, and that instant is the reopening.
      await bridgeFetch(ACCOUNT_ACCESS_PATH);
      expect(liftedAt()).toBe(Date.parse("2026-09-26T08:01:01.000Z"));
      stop();
      setStorageOwner(null);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
