import { afterEach, describe, expect, it, vi } from "vitest";
import { updateAnswerOf as engineUpdateAnswerOf } from "@ohmail/client-engine";
import {
  clearUpdateAnswer, lowerServerUpdating, onUpdateAnswer, raiseUpdateAnswer, resetUpdateAnswerForTests, updateAnswer,
  updateAnswerOf, withUpdateAnswer,
} from "../src/net/update-answer";
import { gateFor } from "../src/state/gate";
import type { ConnectionState } from "../src/net/connection";
import { refuse } from "../src/refusal";
import { listen, pairServer, pairThroughConfirm, sqlWorld } from "./helpers/pair-server";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { PairingEnv } from "../src/net/pairing";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";

function testEnv(): { env: PairingEnv } {
  const map = new Map<string, string>();
  const kv: SecureKV = {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  return { env: { profiles: new ServerProfileStore(kv), engineDeps: deps } };
}

/**
 * ═══ A SERVER THAT SAYS THIS APP IS TOO OLD, OR THAT IT IS BEING UPDATED ═════════════════════
 *
 * Heard on the paired session's transport and nowhere else, by status AND code together, and told
 * to one card. The answer reaches its caller whole (the engine's rule keeps a queued act queued),
 * "too old" stands until the app is updated, "being updated" lifts on the next 2xx from the same
 * server, and a standalone phone (no server) can never raise either.
 */

const ORIGIN = "https://mail.example.test";
const answerBody = (code: string): string => JSON.stringify({ error: { code, message: code, retryable: true } });
const respond = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "application/json" } });

afterEach(() => { resetUpdateAnswerForTests(); });

describe("the phone's own reading of the two answers", () => {
  it("is the client engine's, status and code together, over every pair this phone could meet", () => {
    const codes = ["client_too_old", "server_updating", "db_busy", "offline_read_only", "", null, undefined, 7];
    for (const status of [200, 204, 401, 402, 410, 426, 429, 500, 503]) {
      for (const code of codes) {
        expect(updateAnswerOf(status, code), `${status} ${String(code)}`).toBe(engineUpdateAnswerOf(status, code));
      }
    }
    expect(updateAnswerOf(426, "client_too_old")).toBe("tooOld");
    expect(updateAnswerOf(503, "server_updating")).toBe("serverUpdating");
  });
});

describe("the wrap", () => {
  it("426 client_too_old and 503 server_updating raise the card, and the answer reaches its caller whole", async () => {
    for (const [status, code, answer] of [[426, "client_too_old", "tooOld"], [503, "server_updating", "serverUpdating"]] as const) {
      resetUpdateAnswerForTests();
      const told = vi.fn();
      onUpdateAnswer(told);
      const wrapped = withUpdateAnswer(async () => respond(status, answerBody(code)), ORIGIN);
      const res = await wrapped(`${ORIGIN}/sync`);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
      expect(updateAnswer()).toEqual({ answer, origin: ORIGIN });
      expect(told).toHaveBeenCalledTimes(1);
    }
  });

  it("only by status and code together: an edge's 503, db_busy, offline, a bare 426 and mismatched pairs raise nothing", async () => {
    for (const [status, text] of [
      [503, "Service Unavailable"], [503, answerBody("db_busy")], [503, answerBody("offline_read_only")], [426, "Upgrade Required"],
      [426, answerBody("server_updating")], [503, answerBody("client_too_old")], [429, answerBody("client_too_old")],
    ] as const) {
      const res = await withUpdateAnswer(async () => respond(status, text), ORIGIN)(`${ORIGIN}/sync`);
      expect(res.status).toBe(status);
      expect(await res.text(), "the body was not handed back whole").toBe(text);
      expect(updateAnswer(), `${status} ${text.slice(0, 24)}`).toBeNull();
    }
  });

  it("is about the server's own origin: a storage host's 503 and its 200 say nothing", async () => {
    raiseUpdateAnswer({ answer: "serverUpdating", origin: ORIGIN });
    const off = withUpdateAnswer(async () => respond(200, "{}"), ORIGIN);
    await off("https://storage.example.test/grant");
    await off(`${ORIGIN}.evil.example/sync`);
    await off("not a url");
    expect(updateAnswer()?.answer, "an answer from another host lifted the card").toBe("serverUpdating");
    resetUpdateAnswerForTests();
    await withUpdateAnswer(async () => respond(503, answerBody("server_updating")), ORIGIN)("https://storage.example.test/grant");
    expect(updateAnswer(), "a storage host's 503 raised the card").toBeNull();
    // The whole origin is the server's, its default port and a trailing slash included.
    await withUpdateAnswer(async () => respond(503, answerBody("server_updating")), `${ORIGIN}/`)(`${ORIGIN}:443/hello`);
    expect(updateAnswer()?.answer).toBe("serverUpdating");
  });

  it("a 2xx from the server lifts \"being updated\" and nothing else", async () => {
    const ok = withUpdateAnswer(async () => respond(200, "{}"), ORIGIN);
    raiseUpdateAnswer({ answer: "serverUpdating", origin: ORIGIN });
    await ok(`${ORIGIN}/sync`);
    expect(updateAnswer()).toBeNull();
    raiseUpdateAnswer({ answer: "tooOld", origin: ORIGIN });
    await ok(`${ORIGIN}/sync`);
    expect(updateAnswer()?.answer).toBe("tooOld");
  });
});

describe("the slot", () => {
  it("\"too old\" is never replaced by \"being updated\" from the same server; another server's answer replaces it", () => {
    raiseUpdateAnswer({ answer: "tooOld", origin: ORIGIN });
    raiseUpdateAnswer({ answer: "serverUpdating", origin: ORIGIN });
    expect(updateAnswer()?.answer).toBe("tooOld");
    raiseUpdateAnswer({ answer: "serverUpdating", origin: "https://other.example.test" });
    expect(updateAnswer()).toEqual({ answer: "serverUpdating", origin: "https://other.example.test" });
    lowerServerUpdating(ORIGIN);
    expect(updateAnswer(), "another server's 2xx lifted this card").not.toBeNull();
  });

  it("a session is a server's turn to be judged: the connection layer clears it", () => {
    raiseUpdateAnswer({ answer: "tooOld", origin: ORIGIN });
    clearUpdateAnswer();
    expect(updateAnswer()).toBeNull();
  });

  it("a watcher that throws does not stop the others hearing", () => {
    const heard = vi.fn();
    onUpdateAnswer(() => { throw new Error("a surface fell over"); });
    onUpdateAnswer(heard);
    raiseUpdateAnswer({ answer: "tooOld", origin: ORIGIN });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("the gate", () => {
  const live = { k: "live", session: {} as never } as ConnectionState;
  const facts = { answer: "tooOld" as const, origin: ORIGIN };

  it("puts the card ahead of the wall and of mail, for a live session only", () => {
    const lock = { reason: "payment_required" as const };
    expect(gateFor(live, 1, null, facts)).toEqual({ to: "update", answer: "tooOld", origin: ORIGIN });
    expect(gateFor(live, 1, lock, facts)).toEqual({ to: "update", answer: "tooOld", origin: ORIGIN });
    expect(gateFor(live, 1, lock, null)).toEqual({ to: "wall", facts: lock });
    expect(gateFor(live, 1, null, null)).toEqual({ to: "mail" });
    expect(gateFor(live, 1), "every existing caller is unchanged").toEqual({ to: "mail" });
  });

  it("is about a live session alone: nothing paired, booting or refused meets no card", () => {
    expect(gateFor({ k: "starting" }, 0, null, facts)).toEqual({ to: "boot" });
    expect(gateFor({ k: "idle" }, 0, null, facts)).toEqual({ to: "welcome" });
    expect(gateFor({ k: "refused", reason: refuse("notPairedHere") }, 1, null, facts)).toEqual({ to: "servers" });
  });
});

describe("a paired session, end to end over a real socket", () => {
  it("426 on the engine's own transport raises the card, 'being updated' lifts on the next answer, and a standalone phone has no wrap", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-old");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-old" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      fake.answerWith({ status: 426, code: "client_too_old" });
      const res = await paired.session.fetch(`${origin}/sync?since=0&limit=1&types=message`);
      expect(res.status).toBe(426);
      expect(updateAnswer()).toEqual({ answer: "tooOld", origin });

      resetUpdateAnswerForTests();
      fake.answerWith({ status: 503, code: "server_updating" });
      await paired.session.fetch(`${origin}/sync?since=0&limit=1&types=message`);
      expect(updateAnswer()).toEqual({ answer: "serverUpdating", origin });
      fake.answerWith(null);
      await paired.session.fetch(`${origin}/sync?since=0&limit=1&types=message`);
      expect(updateAnswer()).toBeNull();
      paired.session.store.close();
    } finally {
      fake.server.close();
    }
  });
});
