import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createSidecarLogger } from "../src/log.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  AN UNHANDLED ROUTE FAULT IS RECORDED ON THE STANDALONE DOOR
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `withErrorEnvelope` answers anything it does not recognise with a 500 `internal` and writes ONE
 * line about it — `request_unhandled`, carrying the method, the route pattern and the thrown
 * value's class — through `deps.logger`, falling back to `silentLogger` when a host injects none.
 * The engine's per-request container injected none, so on this door that line went nowhere: the
 * client was told `internal` and the fault was recorded in no log at all.
 *
 * That matters more here than on the hosted door. A standalone install's database is on the user's
 * own laptop and nobody queries it, so the log is the only witness there is — and "something went
 * wrong" with no line behind it is a report nobody can act on.
 *
 * ── WHY THIS DRIVES THE REAL COMPOSITION AND THE REAL LOGGER ─────────────────────────────────
 *
 * The subject is a WIRING fact about one object literal, so nothing here may build that object:
 * every case goes through `createSidecar` and `sidecar.handle`, and the sink is the real
 * `createSidecarLogger`. Reading the emitted BYTES rather than a fake logger's calls is the same
 * rule `boot-phases` and the sync-loop wiring guard follow, and for the same reason — a call site
 * can hand over a field the census then refuses, and only the line itself shows which happened.
 *
 * ── HOW THE FAULT IS RAISED ─────────────────────────────────────────────────────────────────
 *
 * Through the engine's own clock seam (`SidecarConfig.now`), ARMED only for the duration of one
 * `handle` call. That is a real throw from inside the enveloped section of a real request on a
 * real route; WHICH stage between the envelope and the handler raises it is not the subject and
 * is not asserted — what is asserted is that the envelope caught it, answered 500 `internal`, and
 * left a line naming the route.
 *
 * The clock is armed rather than replaced because a `now` that throws for the whole process
 * cannot boot one: the constructor and the sync loop read it too. Both intervals are set an hour
 * out and no drain is asked for, so nothing but the request under test reads the clock inside the
 * window.
 */

/**
 * THE THROWN VALUE. A named class so `errorClass` on the line is a fact about this fixture rather
 * than the bare `Error` every other fault in the process also produces.
 */
class SidecarRouteFault extends Error {
  override readonly name = "SidecarRouteFault";
}

/**
 * The thrown MESSAGE, which must reach neither the log nor the response.
 *
 * `packages/core`'s logger turns an `err` field into `errorClass` + `errorCode` and never its
 * message or stack, and the envelope answers a fixed sentence rather than the thrown one. Both
 * halves are properties of code outside this package, which is exactly why a door-level case
 * asserts them: this is the composition where they are observed together.
 */
const THROWN_DETAIL = "clock-fault-detail-that-must-not-be-published";

const ADDRESS = "owner@trafficflow.test";

/** A mailbox that connects, holds no claims and reports no changes. Nothing here dials. */
function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const claims: RawClaimMessage[] = [];
  let nextUid = 1;
  const meta: LeaseIo = {
    async ensureMetaFolder(): Promise<void> {},
    async listClaims(): Promise<RawClaimMessage[]> {
      return claims.map((c) => ({ ...c }));
    },
    async appendClaim(raw: string): Promise<void> {
      claims.push({ ref: nextUid++, raw });
    },
    async removeClaims(refs: readonly unknown[]): Promise<void> {
      const gone = new Set(refs);
      for (let i = claims.length - 1; i >= 0; i--) {
        if (gone.has(claims[i]!.ref)) claims.splice(i, 1);
      }
    },
    /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
    uidValidity: () => 4_100,
  };
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}

interface Line { level: string; event: string; [k: string]: unknown }

describe("a route fault on the standalone door reaches the log", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  /** The emitted bytes, and the same lines parsed. Both, because one case reads the raw text. */
  const raw: string[] = [];
  const lines: Line[] = [];
  /** Armed only inside {@link underFault}. See the header: the clock is read during boot too. */
  let armed = false;

  afterEach(async () => {
    armed = false;
    raw.length = 0;
    lines.length = 0;
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-unhandled-");
    const logger = createSidecarLogger({
      sink: (l) => { raw.push(l); lines.push(JSON.parse(l) as Line); },
    });
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: ADDRESS, pass: "mailbox-unreached-password" },
      },
      address: ADDRESS,
      machineName: "unhandled fault host",
      /* THE SECOND DOOR, ARMED. `depsForHost` spreads `depsFor()`, so the sink reaches it by
         inheritance rather than by its own line — which is exactly the kind of claim that is
         true until somebody stops spreading. Arming costs nothing here: it mounts a route table
         and a mint, and binds no socket. */
      hostMode: true,
      // Long enough that no timer reads the clock on its own — see the header.
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      profileFlushIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      now: (): Date => {
        if (armed) throw new SidecarRouteFault(THROWN_DETAIL);
        return new Date();
      },
      log: () => {},
      // THE SUBJECT. Absent, and `request_unhandled` has no sink on this door.
      logger,
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.start();
    return sidecar;
  }

  /** `GET /tags` — an ordinary account-scoped read on the full pipeline, which carries the envelope. */
  const readTags = (s: Sidecar): Promise<Response> =>
    s.handle(new Request("http://local/tags", {
      headers: { authorization: `Bearer ${s.sessionToken}` },
    }));

  /** One request with the clock armed. Disarmed in `finally` so a failure cannot leave it set. */
  async function underFault<T>(fn: () => Promise<T>): Promise<T> {
    armed = true;
    try {
      return await fn();
    } finally {
      armed = false;
    }
  }

  it("answers 500 internal and writes one request_unhandled line naming the route", async () => {
    const sidecar = await boot();
    const before = lines.filter((l) => l.event === "request_unhandled").length;
    expect(before, "a boot with no request wrote a route-fault line").toBe(0);

    const res = await underFault(() => readTags(sidecar));

    expect(res.status).toBe(500);
    const body = await res.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("internal");

    const unhandled = lines.filter((l) => l.event === "request_unhandled");
    expect(
      unhandled.length,
      "the door answered 500 and left no record of what failed",
    ).toBe(1);
    const line = unhandled[0]!;
    // The route the person was on, the class that was thrown, and the answer they were given.
    // Asserted by value: a line that reached the sink carrying nothing is the same dead end as
    // no line at all.
    expect(line.level).toBe("error");
    expect(line.route).toBe("/tags");
    expect(line.method).toBe("GET");
    expect(line.status).toBe(500);
    expect(line.errorClass).toBe("SidecarRouteFault");
    /* `withRequestId` binds the id ABOVE the envelope, onto whatever logger the container
       carries — so an id on this line is also evidence the line came from the injected logger
       with that binding intact rather than from somewhere else.

       Compared against a shape, not against a response header: `X-Request-Id` is set by the
       hosted handlers (`apps/api-vercel/src/handler.ts`, `apps/server/src/handler.ts`) and
       `app.handle` does not set it, so on this door the id lives only in the log. */
    expect(typeof line.requestId, "the recorded fault carries no request id").toBe("string");
    expect(String(line.requestId).length).toBeGreaterThan(0);
  });

  it("publishes the thrown message in neither the answer nor the record", async () => {
    const sidecar = await boot();

    const res = await underFault(() => readTags(sidecar));

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(THROWN_DETAIL);
    // The sentence the client IS given, asserted so this case cannot pass on an empty body.
    expect(JSON.parse(text)).toMatchObject({ error: { message: "internal error" } });

    expect(
      lines.filter((l) => l.event === "request_unhandled"),
      "the no-leak claim is about a line that was written; none was",
    ).toHaveLength(1);
    expect(raw.join("\n")).not.toContain(THROWN_DETAIL);
  });

  it("THE HOST DOOR records it too — the door a paired phone talks to", async () => {
    /* A control per door, because a sink that reaches one composition and not the other is the
       shape this row was filed for.

       `GET /devices` WITH A BEARER, and both halves are forced. `/hello` was the first choice and
       ANSWERED 200 under the armed clock: it is `anonymous: true`, so its pipeline omits the
       session step and nothing on that path reads `now` — a fixture whose precondition never
       enters the arm under test. The session step reads `deps.now()` when a token is present
       (`packages/api/src/middleware.ts:495`), so the token has to be there; it does not have to
       be VALID, because the throw happens before the lookup's answer matters. The unfaulted
       control below shows what that same request answers when the clock behaves. */
    const sidecar = await boot();
    expect(sidecar.handleHost, "the host door is not armed, so this case proves nothing")
      .toBeDefined();
    const before = lines.filter((l) => l.event === "request_unhandled").length;
    const devices = (): Promise<Response> => sidecar.handleHost!(new Request("http://host/devices", {
      headers: { authorization: "Bearer not-a-paired-token" },
    }));

    // THE ARM IS ENTERED, shown by the difference the fault makes to the same request.
    expect((await devices()).status, "an unfaulted read did not reach the session step").toBe(401);
    const res = await underFault(devices);

    expect(res.status).toBe(500);
    const unhandled = lines.filter((l) => l.event === "request_unhandled");
    expect(
      unhandled.length - before,
      "the host door answered 500 and left no record — the sink is not inherited",
    ).toBe(1);
    const line = unhandled[unhandled.length - 1]!;
    expect(line.route).toBe("/devices");
    expect(line.errorClass).toBe("SidecarRouteFault");
    expect(String(raw.join("\n"))).not.toContain(THROWN_DETAIL);
  });

  it("writes no such line for a request the route answers normally", async () => {
    const sidecar = await boot();

    // The positive control. Without it every assertion above is satisfied by a door that
    // reports EVERY request as an unhandled fault, and the product would be a log of nothing
    // but failures while this file stayed green.
    const res = await readTags(sidecar);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [] });
    expect(
      lines.filter((l) => l.event === "request_unhandled"),
      "an ordinary read was recorded as an unhandled fault",
    ).toHaveLength(0);
  });
});
