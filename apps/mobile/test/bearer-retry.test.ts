/**
 * A RETRY OF AN UNANSWERED REFRESH IS NOT A REUSE — the phone's half.
 *
 * A rotation succeeds and its response is lost. The phone still holds the old token, retries, and
 * the server reads a spent token as theft: family revoked, pairing gone, and the person is asked
 * to scan a code for a dropped packet. The discriminator is a NAME the phone gives each attempt,
 * written to the keystore BEFORE the request is submitted and repeated until an answer lands.
 *
 * Four properties, each with the mutation that reddens it named at the case:
 *
 *  1. the name is armed BEFORE the wire, carried ON the wire, and cleared BY the adoption;
 *  2. a retry of an unanswered attempt — including one that outlived the process — repeats it;
 *  3. two wake-deletion debts on one profile spend ONE rotation (MB-R13-05: a list snapshot taken
 *     once and a manager per debt presents the consumed token and revokes the pairing at launch);
 *  4. a swept family is told apart from an ordinary end, and says so.
 *
 * The server model here rotates SINGLE-USE and implements the attempt arm, because a stub that
 * re-answers a spent token cannot fail any of this.
 */
import { describe, expect, it } from "vitest";
import { BearerManagerRN, type RefreshVault, type SessionDeath } from "../src/net/bearer";
import { deathRefusal, noteSessionDeath } from "../src/net/session-death";
import { sayRefusal } from "../src/refusal";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { drainPendingWakeDrops, type PairingEnv } from "../src/net/pairing";

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

/** The refusal the real door gives a swept family — `packages/api/test/auth-flow.test.ts`. */
const REUSE_BODY = JSON.stringify({ error: { code: "unauthorized", message: "refresh token reuse detected" } });

/**
 * The door, modelled the way it now behaves: one rotation per token, and a CONSUMED token
 * re-presented naming the attempt that consumed it is answered off the live line instead of
 * sweeping. Anything else presenting a consumed token revokes the family — a 401 carrying the
 * reuse sentence, which is what the real route relays.
 */
function doorModel() {
  const wire: Array<{ token?: string; attemptId?: string }> = [];
  let head = "ref-1";
  let minted = 0;
  let revoked = false;
  /** token → the attempt that spent it. */
  const spentBy = new Map<string, string | undefined>();
  /** Answers to swallow before any reply lands — the dropped response. */
  let dropNext = 0;

  const mint = (): string => {
    minted += 1;
    head = `ref-${minted + 1}`;
    return head;
  };
  const refresh = (body: { refreshToken?: string; attemptId?: string }): Response => {
    wire.push({ token: body.refreshToken, attemptId: body.attemptId });
    if (revoked) return new Response(REUSE_BODY, { status: 401, headers: { "content-type": "application/json" } });
    const presented = body.refreshToken ?? "";
    if (spentBy.has(presented)) {
      const by = spentBy.get(presented);
      if (by !== undefined && by === body.attemptId) {
        // The same attempt: consume the live line and answer with its replacement.
        spentBy.set(head, body.attemptId);
        const next = mint();
        return new Response(JSON.stringify({ tokens: { accessToken: `acc-${minted}`, refreshToken: next } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      revoked = true;
      return new Response(REUSE_BODY, { status: 401, headers: { "content-type": "application/json" } });
    }
    if (presented !== head) {
      return new Response(REUSE_BODY, { status: 401, headers: { "content-type": "application/json" } });
    }
    spentBy.set(presented, body.attemptId);
    const next = mint();
    return new Response(JSON.stringify({ tokens: { accessToken: `acc-${minted}`, refreshToken: next } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };

  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const opts = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    if (url.endsWith("/auth/refresh")) {
      const res = refresh(JSON.parse(opts.body ?? "{}") as { refreshToken?: string; attemptId?: string });
      if (dropNext > 0) {
        // THE LOST RESPONSE: the server did its half; the client hears nothing back.
        dropNext -= 1;
        throw new Error("network went away with the answer");
      }
      return res;
    }
    // Every other route is authenticated: a cold manager 401s and the recovery is what rotates.
    const auth = opts.headers?.authorization ?? "";
    if (!auth.startsWith("Bearer acc-")) return new Response(null, { status: 401 });
    return new Response(null, { status: 204 });
  };
  return {
    fetchImpl,
    wire,
    isRevoked: () => revoked,
    rotations: () => minted,
    dropTheNextAnswer: () => { dropNext += 1; },
  };
}

/** A vault over a real profile row — what the app binds, not a recorder. */
function vaultOver(profiles: ServerProfileStore, id: string): RefreshVault {
  return {
    save: (t, held) => profiles.saveRefreshToken(id, t, held),
    clear: (held) => profiles.clearRefreshToken(id, held),
    armAttempt: (a, head, held) => profiles.armRefreshAttempt(id, a, head, held),
    oweSignOut: async () => false,
  };
}

describe("the phone names every refresh attempt", () => {
  it("arms the name BEFORE the wire, sends it, and the adoption clears it", async () => {
    // MUTATION WATCHED: move the `armAttempt` await to after the fetch — `armedBeforeWire` reads
    // false, because the one case a durable name exists for is the answer that never comes back.
    const door = doorModel();
    const profiles = new ServerProfileStore(memoryKV());
    const row = await profiles.add({
      origin: "https://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    let armedBeforeWire = false;
    const vault = vaultOver(profiles, row.id);
    const watching: RefreshVault = {
      ...vault,
      armAttempt: async (a, head, held) => {
        armedBeforeWire = door.wire.length === 0;
        return vault.armAttempt(a, head, held);
      },
    };
    const mgr = new BearerManagerRN({
      origin: row.origin, accessToken: null, refreshToken: "ref-1", vault: watching,
      fetchImpl: door.fetchImpl,
    });

    expect((await mgr.fetch("https://a.example/push/subscriptions/x", { method: "DELETE" })).status).toBe(204);
    expect(armedBeforeWire, "the name is on disk before the request is submitted").toBe(true);
    expect(door.wire[0]!.attemptId, "and it travels with the token").toBeTruthy();
    const after = (await profiles.list())[0]!;
    expect(after.refreshAttempt, "the adoption answers the attempt and clears it").toBeNull();
    expect(after.refreshToken, "the rotation is persisted").toBe("ref-2");
  });

  it("a LOST answer is retried under the same name, and the family survives it", async () => {
    // MUTATION WATCHED: `this.attempt ?? mintAttemptId()` → `mintAttemptId()` — the retry carries
    // a second name, the door reads a spent token from a stranger, and `isRevoked()` goes true.
    const door = doorModel();
    const profiles = new ServerProfileStore(memoryKV());
    const row = await profiles.add({
      origin: "https://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const mgr = new BearerManagerRN({
      origin: row.origin, accessToken: null, refreshToken: "ref-1",
      vault: vaultOver(profiles, row.id), fetchImpl: door.fetchImpl,
    });

    door.dropTheNextAnswer();
    // The rotation lands server-side; the answer never arrives, so the request is not recovered.
    expect((await mgr.fetch("https://a.example/push/subscriptions/x", { method: "DELETE" })).status).toBe(401);
    const armed = (await profiles.list())[0]!.refreshAttempt;
    expect(armed, "an unanswered attempt is owed, and written down").toBeTruthy();
    expect((await profiles.list())[0]!.refreshToken, "the phone still holds the OLD token").toBe("ref-1");

    // THE RETRY.
    expect((await mgr.fetch("https://a.example/push/subscriptions/x", { method: "DELETE" })).status).toBe(204);
    expect(door.isRevoked(), "a retry of an unanswered attempt is not a reuse").toBe(false);
    expect(door.wire[1]!.attemptId, "the retry repeats the name").toBe(armed);
    expect(door.wire[1]!.token, "and re-presents the token it still holds").toBe("ref-1");
    expect((await profiles.list())[0]!.refreshAttempt, "answered, and cleared").toBeNull();
    expect(mgr.paired(), "the pairing is intact").toBe(true);
  });

  it("a name survives the process: a relaunch mid-attempt retries as itself", async () => {
    // MUTATION WATCHED: drop `refreshAttempt` from the constructor — the relaunched manager mints
    // a fresh name, the door sees a stranger on a spent token, and the pairing is revoked.
    const door = doorModel();
    const profiles = new ServerProfileStore(memoryKV());
    const row = await profiles.add({
      origin: "https://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const first = new BearerManagerRN({
      origin: row.origin, accessToken: null, refreshToken: "ref-1",
      vault: vaultOver(profiles, row.id), fetchImpl: door.fetchImpl,
    });
    door.dropTheNextAnswer();
    await first.fetch("https://a.example/push/subscriptions/x", { method: "DELETE" });

    // The app is killed here. A launch reads the row — token AND the attempt it still owes.
    const stored = (await profiles.list())[0]!;
    const relaunched = new BearerManagerRN({
      origin: stored.origin, accessToken: null, refreshToken: stored.refreshToken,
      refreshAttempt: stored.refreshAttempt,
      vault: vaultOver(profiles, stored.id), fetchImpl: door.fetchImpl,
    });
    expect((await relaunched.fetch("https://a.example/push/subscriptions/x", { method: "DELETE" })).status).toBe(204);
    expect(door.isRevoked(), "the relaunch finished its own attempt").toBe(false);
    expect(door.wire[1]!.attemptId).toBe(stored.refreshAttempt);
  });

  it("MB-R13-05 — two wake debts on one profile spend ONE rotation, and the pairing lives", async () => {
    // MUTATION WATCHED: rebuild a manager per debt from a list snapshot taken once (the shape
    // this replaces) — the second manager presents the CONSUMED token, the door sweeps the
    // family, and `isRevoked()` goes true while the launch is still booting that same profile.
    const door = doorModel();
    const profiles = new ServerProfileStore(memoryKV());
    const row = await profiles.add({
      origin: "https://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    await profiles.markPendingWakeDrop(row.id, "sub-A");
    await profiles.markPendingWakeDrop(row.id, "sub-B");
    const env = {
      profiles,
      engineDeps: { openExecutor: async () => undefined, deleteDatabase: async () => undefined, uuid: () => "u" },
      fetchImpl: door.fetchImpl,
    } as unknown as PairingEnv;

    const stillOwed = await drainPendingWakeDrops(env);
    // THE HARM FIRST: the defect is not an unpaid debt, it is a pairing revoked during launch.
    expect(door.isRevoked(), "paying two debts must not end the pairing").toBe(false);
    expect(stillOwed, "both debts are paid").toEqual([]);
    expect(await profiles.pendingWakeDrops()).toEqual([]);
    expect(door.rotations(), "one manager, one rotation for both debts").toBe(1);
    expect((await profiles.list())[0]!.refreshToken, "and the rotation is kept").toBe("ref-2");
  });

  it("a SWEPT family is told apart from an ordinary end — in the log, not in the sentence", async () => {
    // MUTATION WATCHED: `body.error?.message === REUSE_REFUSAL` → `false` in `readDeathReason`
    // — the theft signal reads as an ordinary end and the log loses the one fact worth keeping.
    // The SENTENCE no longer splits: three spellings of one refusal told a person holding two
    // phones a different thing on each, so the reason went to the log and the words became one
    // (`pairing-ended-one-sentence.test.ts`). What is asked here is that the CLASS survives.
    const door = doorModel();
    const profiles = new ServerProfileStore(memoryKV());
    const row = await profiles.add({
      origin: "https://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const mgr = new BearerManagerRN({
      origin: row.origin, accessToken: null, refreshToken: "ref-1",
      vault: vaultOver(profiles, row.id), fetchImpl: door.fetchImpl,
    });
    const deaths: SessionDeath[] = [];
    mgr.onSessionDead((why) => void deaths.push(why));

    // A stale token from a DIFFERENT attempt: the genuine reuse signal.
    await mgr.fetch("https://a.example/push/subscriptions/x", { method: "DELETE" });
    const stale = new BearerManagerRN({
      origin: row.origin, accessToken: null, refreshToken: "ref-1",
      vault: vaultOver(profiles, row.id), fetchImpl: door.fetchImpl,
    });
    const staleDeaths: SessionDeath[] = [];
    stale.onSessionDead((why) => void staleDeaths.push(why));
    await stale.fetch("https://a.example/push/subscriptions/x", { method: "DELETE" });

    expect(door.isRevoked(), "the theft arm still fires — this is the property being kept").toBe(true);
    expect(staleDeaths, "and the phone hears WHICH death it was").toEqual(["revoked"]);
    const logged: string[] = [];
    noteSessionDeath(staleDeaths[0]!, (l) => logged.push(l));
    expect(logged, "the theft is named where a maintainer reads it")
      .toEqual(['{"service":"pairing","event":"session_dead","why":"revoked"}']);
    expect(sayRefusal(deathRefusal("revoked")), "and the person gets the one sentence, with its remedy")
      .toBe(sayRefusal(deathRefusal("refused")));
    expect(sayRefusal(deathRefusal("revoked"))).toMatch(/Pair this phone again\./);
    expect(deaths, "the manager that did nothing wrong was not told it was revoked").not.toContain("revoked");
  });
});
