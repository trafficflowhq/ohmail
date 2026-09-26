import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";

import { createLocalEngine } from "../src/bridge-fetch.js";
import { createWindowOutbox, WINDOW_OUTBOX_FILE } from "../../sidecar/src/window-outbox.js";

/**
 * A CHANGE MADE WHILE THE SERVER IS OUT OF REACH OUTLIVES THE WINDOW.
 *
 * The window's engine is the one `createLocalEngine` builds, over a stand-in shell whose far side
 * is the sidecar's real outbox door on a real directory and a hosted account that answers the
 * Cloud door's `503 offline_read_only` until it comes back. "Closing the window" drops the engine;
 * "relaunching" builds a fresh one over the same directory. Before the fix the outbox was memory
 * only, and a send queued offline never left.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as { __TAURI_INTERNALS__?: { invoke: Invoke } };

function encode(status: number, body = "", headers: [string, string][] = []): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: headers }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const JSON_TYPE: [string, string][] = [["content-type", "application/json"]];
/** The mailbox this window serves — the mount key the gate hands `createLocalEngine`. */
const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OFFLINE = JSON.stringify({ error: { code: "offline_read_only", message: "ohmail Cloud is out of reach", retryable: true } });

interface World {
  dir: string;
  online: boolean;
  /** The NEXT send commits and then its answer is lost on the way back. */
  loseNextSendAnswer: boolean;
  /** Keys a send was delivered under — the hosted reservation dedupes a repeat of one. */
  delivered: string[];
  deleted: string[];
  sendRequests: number;
  /** Anything else the window asked for — read by name, so an unexpected request is visible. */
  otherReads: string[];
}

/** Install the stand-in; the answer relaunches the sidecar — a fresh door over the same directory. */
function standInShell(w: World): () => void {
  let door = createWindowOutbox({ dataDir: w.dir, authorized: async () => true, log: () => undefined, scope: () => MAILBOX });
  let drafts = 0;
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") throw new Error(`the stand-in has no ${command}`);
      const p = payload as { method: string; url: string; headers: [string, string][]; body: number[] };
      const key = p.headers.find(([n]) => n.toLowerCase() === "idempotency-key")?.[1] ?? "";
      const body = new TextDecoder().decode(Uint8Array.from(p.body));
      if (p.url.startsWith("/local/window/outbox")) {
        const res = await door.handle(new Request(`http://sidecar${p.url}`, {
          method: p.method, ...(p.method === "GET" ? {} : { body }),
        }));
        return encode(res.status, res.status === 204 ? "" : await res.text(), JSON_TYPE);
      }
      if (!w.online) return encode(503, OFFLINE, JSON_TYPE);
      if (p.method === "POST" && p.url === "/drafts") {
        drafts++;
        return encode(201, JSON.stringify({ id: `draft-${drafts}`, bcc: [], contentRevision: `r-${drafts}` }), JSON_TYPE);
      }
      const send = /^\/drafts\/([^/]+)\/send$/.exec(p.url);
      if (p.method === "POST" && send) {
        w.sendRequests++;
        if (!w.delivered.includes(key)) w.delivered.push(key);
        if (w.loseNextSendAnswer) {
          w.loseNextSendAnswer = false;
          throw new Error("the answer was lost on the way back");
        }
        return encode(200, JSON.stringify({ status: "sent", providerMessageId: "<sent-1@example.test>" }), JSON_TYPE);
      }
      const del = /^\/messages\/([^/]+)$/.exec(p.url);
      if (p.method === "DELETE" && del) {
        w.deleted.push(del[1]!);
        return encode(200, JSON.stringify({ id: del[1], updatedAt: "2026-09-26T08:00:00.000Z" }), JSON_TYPE);
      }
      // The drain after a replay: an empty account, so its success is what retires the echo.
      if (p.method === "GET" && p.url.startsWith("/sync/snapshot")) {
        return encode(200, JSON.stringify({ asOfSeq: 1, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } }), JSON_TYPE);
      }
      if (p.method === "GET" && p.url.startsWith("/sync?")) {
        return encode(200, JSON.stringify({
          changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false,
          serverTime: "2026-09-26T08:00:00.000Z",
        }), JSON_TYPE);
      }
      w.otherReads.push(`${p.method} ${p.url}`);
      return encode(404, JSON.stringify({ error: { code: "not_found", message: "not in the stand-in" } }), JSON_TYPE);
    },
  };
  return () => {
    door = createWindowOutbox({ dataDir: w.dir, authorized: async () => true, log: () => undefined, scope: () => MAILBOX });
  };
}

let relaunchSidecar: () => void = () => undefined;

async function launch(): Promise<OhmailEngine> {
  relaunchSidecar();
  const engine = createLocalEngine(MAILBOX);
  await engine.hydrate();
  return engine;
}

/**
 * One drive: the restored outbox replays first, then the drain. The drain's success retires a
 * confirmed verb's record without awaiting it, so the window stays open a few ticks after — a
 * real window lives far longer than that.
 */
async function drive(engine: OhmailEngine): Promise<void> {
  await engine.syncOnce().catch(() => undefined);
  for (let i = 0; i < 5; i++) await new Promise((r) => { setTimeout(r, 0); });
}

const SEND = {
  kind: "mail_send" as const, inReplyTo: null, mailboxId: MAILBOX,
  to: [{ name: null, address: "b@example.test" }], subject: "ohmail-e2e outbox", body: "queued while offline",
};

let w: World;
beforeEach(() => {
  w = {
    dir: mkdtempSync(join(tmpdir(), "outbox-window-")), online: false, loseNextSendAnswer: false,
    delivered: [], deleted: [], sendRequests: 0, otherReads: [],
  };
  relaunchSidecar = standInShell(w);
});
afterEach(() => {
  delete host.__TAURI_INTERNALS__;
  rmSync(w.dir, { recursive: true, force: true });
});

describe("the desktop window's outbox survives the window", () => {
  it("a send and a delete queued while the server is out of reach go out after a relaunch, once", async () => {
    const first = await launch();
    const sent = await first.mutate(SEND);
    const gone = await first.mutate({ kind: "message_delete", messageId: "m-1" });
    expect(sent.status).toBe("queued");
    expect(gone.status).toBe("queued");
    // The window closes with both still waiting. The server comes back before the next launch.
    w.online = true;

    const second = await launch();
    await drive(second);
    expect(w.delivered).toEqual([sent.key]);
    expect(w.deleted).toEqual(["m-1"]);

    // A third launch finds nothing left to replay: the record went when the send settled.
    const third = await launch();
    await drive(third);
    expect(w.sendRequests).toBe(1);
    expect(w.deleted).toEqual(["m-1"]);
    expect(readdirSync(w.dir)).not.toContain(WINDOW_OUTBOX_FILE);
    expect(w.otherReads).toEqual([]);
  });

  it("a replay whose answer was lost is asked again under the same key, and delivers once", async () => {
    const first = await launch();
    const sent = await first.mutate(SEND);
    expect(sent.status).toBe("queued");
    w.online = true;
    w.loseNextSendAnswer = true;

    const second = await launch();
    await drive(second);
    expect(w.sendRequests).toBe(1);

    const third = await launch();
    await drive(third);
    // Two requests, one delivery: the repeat carried the original key.
    expect(w.sendRequests).toBe(2);
    expect(w.delivered).toEqual([sent.key]);
    const fourth = await launch();
    await drive(fourth);
    expect(w.sendRequests).toBe(2);
  });

  it("a queued change is on the door's disk before the window can close, not after an answer", async () => {
    const first = await launch();
    await first.mutate(SEND);
    expect(readdirSync(w.dir)).toContain(WINDOW_OUTBOX_FILE);
  });
});
