import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter } from "@ohmail/client-engine";

import {
  BRIDGE_DEADLINE_MS, bridgeFetch, createEngineAdapter, engineConfigure, engineLogout, engineStatus,
  WINDOW_SEARCH_PHASES_PATH,
} from "../src/bridge-fetch.js";
import { installOfflineGuard, isShellCommandChannel } from "../src/offline-guard.js";

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

  /**
   * THE ONE ADDRESS REFUSED AS A REJECTION, AND WHY THAT IS STRICTER RATHER THAN LOOSER.
   *
   * The webview implements `invoke` as a POST to a custom scheme its OWN process answers, and it
   * gives up on that scheme — permanently, for the life of the page — when the attempt rejects,
   * falling back to a message channel that has no network in it at all. That recovery is a
   * rejection handler, so a synchronous throw skips it and breaks the bridge without making
   * anything more offline.
   *
   * Refusing it as a rejection means the custom-scheme request is never made and every command
   * travels the channel that cannot address anything. Nothing is allowed out either way.
   */
  it("refuses the shell's own command channel in the shape the runtime recovers from", async () => {
    const scope: Record<string, unknown> = { fetch: () => Promise.resolve("sent") };
    installOfflineGuard(scope);
    const guarded = scope.fetch as (url: string) => unknown;

    for (const address of ["ipc://localhost/engine_request", "http://ipc.localhost/engine_request"]) {
      expect(isShellCommandChannel(address)).toBe(true);
      // Does not throw…
      const answer = guarded(address);
      // …and does not send: it is a refusal, just one the runtime can act on.
      expect(answer).toBeInstanceOf(Promise);
      await expect(answer as Promise<unknown>).rejects.toThrow(/refuses the webview's/);
    }

    // A host that merely CONTAINS the word is not it.
    expect(isShellCommandChannel("https://ipc.localhost.example.invalid/x")).toBe(false);
    expect(isShellCommandChannel("https://example.invalid/ipc://localhost")).toBe(false);
  });

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
