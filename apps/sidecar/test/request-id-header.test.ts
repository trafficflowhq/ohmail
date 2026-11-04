import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { REQUEST_ID_HEADER } from "@trafficflow/api";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

// Every test here stands up the real sidecar (createSidecar boots the engine's PGlite and runs
// its migrations) in the test body — see pglite-budget.ts for the measured cost.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE STANDALONE DOOR HANDS THE CLIENT AN ID IT CAN QUOTE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `withRequestId` has minted a request id for every request for a long time, and bound it to
 * whatever logger the per-request container carries. The client never saw it:
 * `X-Request-Id` was stamped by the two hosted hosts, which mint it before `handle` and set it in
 * their own `noStore` wrappers, and by nothing inside the shared app. This door answers straight
 * out of `app.handle` — `handle()` below is the same entry the stdio bridge and the desktop host
 * listener serve — so a person reporting "it said something went wrong" could name the minute and
 * the screen, never the request. `createApp.handle` now stamps the header at its single exit, and
 * these cases are that fact measured on the composition that was missing it.
 *
 * ── WHAT THIS FILE DOES NOT ASSERT, AND WHY ──────────────────────────────────────────────────
 *
 * NOT that the header's value equals the id on this door's log line, because on this door there
 * is no such line to compare against: the engine's per-request container injects no `logger`
 * (`engine.ts`'s `depsFor`), so `withRequestId` binds `silentLogger` and the record goes nowhere.
 * That is a separate defect with its own lane, and asserting around it here would quietly make
 * this file depend on it. The equality is measured where a logger can be injected into the same
 * seam both doors compose — `packages/api/test/request-id-header.test.ts` — and what is measured
 * here instead is the header's SHAPE and that two requests get two different ids, which is what
 * rules out a constant satisfying "is a string".
 *
 * ── WHY THE CLOCK RAISES THE 500 ─────────────────────────────────────────────────────────────
 *
 * Through the engine's own clock seam (`SidecarConfig.now`), armed only for the duration of one
 * `handle` call: a real throw from inside the enveloped section of a real request on a real
 * route. WHICH stage between the envelope and the handler reads the clock first is not the
 * subject and is not asserted — what is asserted is that the envelope answered 500 and that the
 * answer carried the header. It is armed rather than replaced because `createSidecar` reads the
 * clock while it boots, and a `now` that throws for the whole process cannot build a world.
 */

const ADDRESS = "owner@trafficflow.test";

/** The header as a client reads it. `Headers` is case-insensitive; spelled lowercase on purpose. */
const HEADER = "x-request-id";

/** The class the armed clock raises, named so a 500 is a fact about this fixture. */
class SidecarClockFault extends Error {
  override readonly name = "SidecarClockFault";
}

const dirs: string[] = [];
const sidecars: Sidecar[] = [];
/** Armed only inside {@link underFault}. See the header: the clock is read during boot too. */
let armed = false;

afterEach(async () => {
  armed = false;
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function standUp(): Promise<Sidecar> {
  const dir = await freshDataDir("ohmail-request-id-");
  dirs.push(dir);
  const sidecar = await createSidecar({
    dataDir: dir,
    address: ADDRESS,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: ADDRESS, pass: "mailbox-unreached-password" },
    },
    // Long enough that no timer of the engine's own reads the clock while a case is armed.
    pollIntervalMs: 60 * 60 * 1000,
    vitalsIntervalMs: 60 * 60 * 1000,
    profileFlushIntervalMs: 60 * 60 * 1000,
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    now: (): Date => {
      if (armed) throw new SidecarClockFault("clock fault");
      return new Date();
    },
  });
  sidecars.push(sidecar);
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

describe("X-Request-Id on the standalone door", () => {
  it("an ordinary read carries a minted id", async () => {
    const sidecar = await standUp();
    const res = await readTags(sidecar);

    // Anti-vacuity: a 401 or a 404 would also carry a header and would say nothing about a
    // response that came out of a handler.
    expect(res.status, "the fixture must reach a real handler").toBe(200);
    expect(await res.json()).toMatchObject({ items: [] });
    expect(res.headers.get(HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * THE CASE THE DEFECT WAS ABOUT. A 500 is the answer a person is certain to report, and on this
   * door it was the one leaving with nothing to quote.
   */
  it("a 500 carries it too — the answer a person actually reports", async () => {
    const sidecar = await standUp();

    const res = await underFault(() => readTags(sidecar));

    expect(res.status).toBe(500);
    // Asserted so this case cannot pass on an empty body dressed as a fault.
    expect(await res.json()).toMatchObject({ error: { code: "internal" } });
    expect(
      res.headers.get(HEADER),
      "the door answered 500 and gave the client nothing to quote",
    ).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("two requests get two ids — a constant would satisfy the shape and select every line", async () => {
    const sidecar = await standUp();

    const first = (await readTags(sidecar)).headers.get(HEADER);
    const second = (await readTags(sidecar)).headers.get(HEADER);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  /**
   * The name the client reads is the one the package publishes, so a rename cannot leave the two
   * halves of this contract disagreeing while both files stay green.
   *
   * The `toMatch` is not decoration: comparing the two lookups ALONE is satisfied by a response
   * that carries neither — two nulls are equal — which was measured going green with the stamp
   * removed. The value is asserted first, so the case can be watched fail.
   */
  it("the header is the constant the API package exports", async () => {
    const sidecar = await standUp();
    const res = await readTags(sidecar);
    expect(REQUEST_ID_HEADER.toLowerCase()).toBe(HEADER);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(res.headers.get(HEADER));
  });
});
