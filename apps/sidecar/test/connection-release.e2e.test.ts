import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { formatClaim, META_FOLDER } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { FIXTURE_DOOR } from "../../../packages/organizer/test/_door.js";

/** The probe's door: this throwaway user is the test's own, so the fixture arm of the one door. */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  `start()` MUST NOT LEAVE AN AUTHENTICATED IMAP LOGIN BEHIND
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `connect()` LOGS IN and then LISTs (`packages/core/src/adapters/imap.ts`), so every line after
 * it in `start()` runs with a live authenticated socket that only `stop()` can close — and
 * `apps/sidecar/src/main.ts` answers a rejected `start()` by LOGGING it and continuing to serve
 * the mirror, deliberately (§8: a first sync taking minutes must not make the UI look broken).
 * The two facts compose into a leak: a post-connect throw left the login open for the life of the
 * process, with no handle anywhere that could close it.
 *
 * ── WHY A DESKTOP LEAK IS NOT THE SAME SIZE AS A SERVER ONE ───────────────────────────────
 *
 * iCloud caps concurrent IMAP connections per account, and a desktop user's other clients
 * (Apple Mail, their phone) are already spending that budget. One leaked login on a laptop that
 * relaunches after every crash is a mailbox that eventually refuses to connect at all, and the
 * error the user sees is on the WRONG app.
 *
 * ── THE PATTERN IS NOT NEW HERE, WHICH IS WHY THIS IS A GUARD AND NOT A DESIGN ─────────────
 *
 * `packages/api/src/send-adapter.ts:68-71`, `packages/api/src/attachments-adapter.ts:36-41` and
 * `apps/worker/src/index.ts:1163` all close-then-rethrow around exactly this window. The sidecar
 * missed it. These claims pin the sidecar's copy so it cannot be missed again.
 *
 * ── WHY GREENMAIL AND NOT A FAKE ──────────────────────────────────────────────────────────
 *
 * A counting fake would prove that `close()` was CALLED. The defect is about a SOCKET, so the
 * adapter under test is a real `ImapAdapter` against the real server the rest of this package's
 * e2e uses (`docker-compose.yml`, port 3143) with ONE method sabotaged, and the assertion is that
 * the server-side session is gone afterwards — asked by issuing a real IMAP command on it.
 *
 * Nowhere near a real mailbox: a fresh random GreenMail user per test.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
/** GreenMail's delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`. */
const META_PATH = META_FOLDER.split("/").join(".");

function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

/**
 * A REAL adapter with one post-connect method sabotaged, and every `close()` counted.
 *
 * A `Proxy` rather than a hand-written stand-in on purpose: everything the engine reaches —
 * `connect`, `leaseIo`, `changesSince`, `ensureFolders` — stays the production implementation
 * against the production server, so the only difference from a healthy launch is the one failure
 * under test. A hand-written object would also have to fake the organizer lease, which is the
 * gate `start()` runs BEFORE the failing line, and faking it would make the window this test is
 * about disappear.
 */
function sabotage(real: ImapAdapter, method: "ensureFolders" | "changesSince"): {
  adapter: MailboxAdapter; closes: () => number;
} {
  let closes = 0;
  const adapter = new Proxy(real, {
    get(target, prop) {
      if (prop === method) return async () => { throw new Error(`sabotaged ${String(prop)}`); };
      if (prop === "close") return async () => { closes++; await target.close(); };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as MailboxAdapter;
  return { adapter, closes: () => closes };
}

/**
 * ── A PEEK THAT CAN BE BROKEN AND MENDED WHILE THE INSTALL RUNS ───────────────────────────────
 *
 * `sabotage` above breaks a method for the adapter's whole life, which is right for a launch
 * failure and wrong here: the case needs a lease read that WORKS at startup and fails on a later
 * poll, because arming the mark at startup is what already happened and the poll is what did not.
 *
 * Everything except `leasePeekIo` is the real adapter against the real server. The fault injected
 * is the one the peek genuinely has -- an IO failure -- and injection is the only way to reach it
 * from a test: a healthy server cannot produce it. An ABSENT folder is documented as zero claims
 * ("An ABSENT folder is zero claims -- the truth"), and a folder past the ceiling is answered by
 * the header search, so neither deleting the folder nor flooding it makes this read fail. Both
 * were tried against GreenMail first and both left the peek succeeding.
 */
function breakablePeek(real: ImapAdapter): { adapter: MailboxAdapter; breakIt: (on: boolean) => void } {
  let broken = false;
  const adapter = new Proxy(real, {
    get(target, prop) {
      if (prop === "leasePeekIo") {
        return () => {
          if (broken) throw new Error("sabotaged leasePeekIo: connection reset by peer");
          return (target as unknown as { leasePeekIo(): unknown }).leasePeekIo();
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as MailboxAdapter;
  return { adapter, breakIt: (on: boolean) => { broken = on; } };
}

/**
 * Like {@link breakablePeek}, but it closes BOTH lease doors — the organizer's `leaseIo` and the
 * reader's `leasePeekIo`. The launch gate reads through the first and the pane peeks through the
 * second, so a fixture that breaks only one of them tests the arm it did not mean to.
 */
function breakableLease(real: ImapAdapter): { adapter: MailboxAdapter; breakIt: (on: boolean) => void } {
  let broken = false;
  const adapter = new Proxy(real, {
    get(target, prop) {
      if (prop === "leaseIo" || prop === "leasePeekIo") {
        /* WHEN BROKEN THE DOOR IS NOT THERE AT ALL, rather than there and throwing. That is the
           production shape this arm is written for: `readMailboxLease` asks `hasLeaseIo(adapter)`
           first and raises `LeaseUnavailableError { op: "no_lease_io" }` — "this mailbox's adapter
           cannot reach ohmail/_meta" — which is the class the launch catch branches on. A door
           that throws a RAW error instead propagates past that catch as an unrelated fault and the
           arm is never entered, which is how the first version of this case asserted nothing. */
        if (broken) return undefined;
        return (...args: unknown[]) => {
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
          return fn.apply(target, args);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as MailboxAdapter;
  return { adapter, breakIt: (on: boolean) => { broken = on; } };
}

/**
 * Is the login this adapter opened still usable?
 *
 * `ensureFolders()` is a `list()` plus creates — the same command `connect()` itself issues, so a
 * live authenticated session answers it and a released one cannot. It is asked of the REAL
 * adapter, never the sabotaged Proxy, and creating `ohmail/*` on a throwaway GreenMail user costs
 * nothing (it only ever gets that far when the guard is already failing).
 *
 * Returns the rejection so a failure message can carry it: "the login was still usable" and "it
 * failed for some unrelated reason" must not look the same.
 */
async function loginState(real: ImapAdapter): Promise<{ usable: boolean; why: string }> {
  try {
    await real.ensureFolders(FIXTURE_DOOR);
    return { usable: true, why: "ensureFolders() succeeded — the authenticated session is alive" };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    return { usable: false, why: `${(err as Error).name}: ${(err as Error).message} (code=${code})` };
  }
}

/** Put a fresh CLOUD claim in `ohmail/_meta`, as the worker's gate would. */
async function seedCloudClaim(cfg: ReturnType<typeof greenmail>, installId: string): Promise<void> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  try {
    const list = await c.list();
    if (!list.some((f) => f.path === META_PATH)) await c.mailboxCreate(META_PATH);
    await c.append(META_PATH, formatClaim({
      authorizedAt: null, capabilities: [],
      installId, kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "seed",
    }), ["\\Seen"]);
  } finally {
    await c.logout();
  }
}

/**
 * The events a launch wrote, so a failure can be asserted where the engine actually puts one.
 *
 * `start()` RESOLVES on a mailbox that could not launch, and that is the contract rather than a
 * gap — `engine.ts#start` says so in its own words: it is `Promise.allSettled` over every
 * runtime because *"`main.ts` answers a rejected `start()` by logging and going on to serve the
 * mirror, so a throw here is not fatal to the process. What it must not do is take the OTHER
 * mailboxes down with it. Each runtime's own `start` already closes its login on the way out."*
 * A standalone install holds N mailboxes (the project's design notes, superseded-0.14 note at :831),
 * and one bad password may not stop the other four from opening.
 *
 * So the claim is not "the caller sees a throw" — it is that the failure is REPORTED and the
 * login is RELEASED. This captures the first half; `closes()` and {@link loginState} are the
 * second. That the healthy mailboxes still start is `allSettled`'s own job and is asserted where
 * a second mailbox exists to assert it with (`multi-mailbox.test.ts`, `local-roster.test.ts`);
 * duplicating it here would need a second GreenMail user to say something those already say.
 */
function recorder(): { log: (event: string, fields?: Record<string, unknown>) => void; failures: () => string[] } {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  return {
    log: (event, fields) => { events.push({ event, fields }); },
    failures: () => events
      .filter((e) => e.event === "mailbox_start_failed")
      .map((e) => {
        const err = (e.fields ?? {}).err;
        return err instanceof Error ? err.message : String(err);
      }),
  };
}

describe("a failed launch releases the IMAP login it opened", () => {
  const dirs: string[] = [];
  const running: Sidecar[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function dataDir(): string {
    const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-release-"));
    dirs.push(d);
    return d;
  }

  /**
   * `:548` — `ensureFolders` throws.
   *
   * The likeliest real instance of this, and the one the sibling call sites were written for: a
   * provider hiccup or a hostile folder name in the LIST that `connect()` has already
   * authenticated for.
   */
  it("a throw from ensureFolders closes the login instead of holding it to SIGTERM", async () => {
    const cfg = greenmail();
    const real = new ImapAdapter(cfg);
    const { adapter, closes } = sabotage(real, "ensureFolders");

    const rec = recorder();
    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: () => adapter,
      log: rec.log,
    });

    await grantOrganizeConsent(sidecar);
    running.push(sidecar);

    /* RESOLVES, AND REPORTS. This read `await expect(sidecar.start()).rejects.toThrow(…)` under a
     * comment saying a swallow "would be a different defect wearing this fix's clothes" — written
     * when an install held exactly one mailbox, and never runnable afterwards, so the roster
     * change went by without it. See {@link recorder} for the contract in the engine's own words.
     * A SILENT swallow is still the defect that comment names, and the assertion below is what
     * tells the two apart: the failure has to arrive somewhere a person can read it. */
    /* AND THE ANSWER NAMES IT. `start()` now returns the launches it could not make, so the
       failure arrives in two places a caller can read: this report and the log line below. The
       report is the one a composition standing in front of a person can act on. */
    const report = await sidecar.start();
    expect(report.failures.map((f) => String(f.err))).toEqual([
      expect.stringMatching(/sabotaged ensureFolders/) as unknown as string,
    ]);
    expect(rec.failures(), "the launch failure was swallowed without a word")
      .toEqual([expect.stringMatching(/sabotaged ensureFolders/) as unknown as string]);

    expect(closes(), "start() never closed the adapter it had connected").toBe(1);
    const state = await loginState(real);
    expect(state.usable, `the authenticated socket outlived the failed launch — ${state.why}`).toBe(false);
  }, 60_000);

  /**
   * `:549` — the first drain throws, for a reason that is not the connection's.
   *
   * THE LOGIN IS KEPT NOW, ON THE RUNTIME'S OWN HANDLE, and the guarantee this case holds is
   * unchanged: no login outlives everything that could close it. A store refusal or a pipeline
   * fault in the first drain is not a dead connection (a fix on the phone: closing it showed
   * "Couldn't reconnect" over an answering server), so the poll keeps draining over it and the
   * engine's stop closes it. The poll is the new consumer; the stop is the close.
   */
  it("a throw from the first drain keeps the login for the poll, and the engine's stop closes it", async () => {
    const cfg = greenmail();
    const real = new ImapAdapter(cfg);
    const { adapter, closes } = sabotage(real, "changesSince");

    const rec = recorder();
    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: () => adapter,
      log: rec.log,
    });

    await grantOrganizeConsent(sidecar);
    running.push(sidecar);

    const report = await sidecar.start();
    expect(report.failures.map((f) => String(f.err))).toEqual([
      expect.stringMatching(/sabotaged changesSince/) as unknown as string,
    ]);
    expect(rec.failures(), "the drain failure was swallowed without a word")
      .toEqual([expect.stringMatching(/sabotaged changesSince/) as unknown as string]);

    expect(closes(), "a drain that failed for its own reasons closed the login the poll needs").toBe(0);
    expect((await loginState(real)).usable, "the kept login is not usable").toBe(true);
    await sidecar.stop();
    expect(closes(), "the engine's stop left the kept login open").toBe(1);
    const state = await loginState(real);
    expect(state.usable, `the authenticated socket outlived the engine — ${state.why}`).toBe(false);
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  A LEASE THIS INSTALL CANNOT READ AT POLL TIME IS SAID OUT LOUD
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * A reader whose lease reads keep failing went on presenting an ordinary connected pane with a
   * stale holder in it. Nothing looks wrong, the mail keeps arriving, and the one thing that is
   * not happening -- anybody organizing the mailbox -- is invisible. That is the shape this
   * project has shipped before: a reliability feature rendering as its own healthy state.
   *
   * The mark that exists to prevent it was armed ONLY on the startup path, which is where it was
   * tested. A mailbox spends its life in the POLL.
   *
   * ── WHY THE FAULT IS INJECTED RATHER THAN CAUSED ─────────────────────────────────────────
   *
   * The peek cannot be made to fail by arranging the mailbox, and that is by design rather than an
   * obstacle: an ABSENT folder is documented as zero claims ("An ABSENT folder is zero claims --
   * the truth"), and a folder past the ceiling is answered by the header search. Deleting the
   * folder and flooding it were both tried against the real server first, and both left the peek
   * SUCCEEDING. What is left is what the code says is left -- an IO failure -- so that is what is
   * injected, on the real adapter, for one method, toggled while the install runs.
   *
   * THE FIRST ASSERTION IS THAT THE PEEK FAILED. Without it this case passes when the peek never
   * ran at all, which is exactly how the first attempt at it wasted a pass: the mark was null and
   * the reason was that nothing had been asked, not that nothing had been recorded.
   *
   * MUTATION WATCHED RED: remove the arming from the reader peek's catch and this fails on the
   * SECOND assertion -- `organizer_peek_failed` still fires, and the state stays healthy.
   */
  it("a lease that becomes unreadable AT POLL TIME says so, and stops when it reads again", async () => {
    const cfg = greenmail();
    await seedCloudClaim(cfg, "ohmail-cloud:production");
    const real = new ImapAdapter(cfg);
    const { adapter, breakIt } = breakablePeek(real);

    const events: string[] = [];
    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: () => adapter,
      log: (event: string) => { events.push(event); },
    });
    await grantOrganizeConsent(sidecar);
    running.push(sidecar);

    // It comes up behind the Cloud claim, as a reader, having read the lease successfully.
    await sidecar.start();
    expect(sidecar.organizerState(), "this install did not come up as a reader")
      .toMatchObject({ organizing: false, unreadableSince: null });

    // ── THE LEASE READ STARTS FAILING WHILE IT RUNS ──────────────────────────────────────────
    breakIt(true);
    events.length = 0;
    await sidecar.syncUntilQuiet();

    expect(events, "the peek never failed, so this case is about nothing")
      .toContain("organizer_peek_failed");
    const marked = sidecar.organizerState();
    expect(marked.unreadableSince,
      "a lease this install could not read at poll time left the pane looking healthy")
      .not.toBeNull();
    expect(Number.isNaN(Date.parse(String(marked.unreadableSince))),
      "the mark is not an instant, so a surface cannot say how long it has been true")
      .toBe(false);
    /* The holder it already knew is KEPT. A look that failed is not evidence about who holds the
     * mailbox, and blanking it would be the "nobody organizes this" lie by another route. */
    expect(marked.organizing, "a failed look was allowed to change the verdict").toBe(false);

    // ── AND IT STOPS SAYING IT THE MOMENT A READ SUCCEEDS ────────────────────────────────────
    breakIt(false);
    await sidecar.syncUntilQuiet();

    expect(sidecar.organizerState().unreadableSince,
      "the mark outlived the fault, so the pane keeps warning about a lease that reads fine")
      .toBeNull();
  }, 90_000);

  /**
   * THE SAME FACT, AT LAUNCH — and it is a separate case because the code paths are separate.
   *
   * The sibling above breaks the lease read AFTER a healthy start, so it exercises the poll arm.
   * The launch arm lives in `dialAndGate()`, and during the rebase that merged the reconnect work
   * with the lease work it lost its mark: the sequence was extracted into a function and the
   * assignment did not travel with it. Nothing conflicted, the tree compiled, and both lanes'
   * suites stayed green — because the only guard for the mark was the one above, which asserts
   * `unreadableSince: null` after a SUCCESSFUL start and is true either way.
   *
   * MUTATION WATCHED RED: delete the `organizer = { ... unreadableSince: ... }` assignment from
   * dialAndGate's `LeaseUnavailableError` catch and the third assertion fails.
   */
  it("a lease that is unreadable AT LAUNCH says so, instead of coming up looking healthy", async () => {
    const cfg = greenmail();
    await seedCloudClaim(cfg, "ohmail-cloud:production");
    const real = new ImapAdapter(cfg);
    /* BOTH LEASE DOORS, because the launch gate and the reader's pane do not use the same one:
       `mayOrganize()` reads through `leaseIo`, the pane peeks through `leasePeekIo`. Sabotaging
       only the peek — as the case above does, correctly, for the poll arm — leaves the launch
       reading the lease perfectly well, and this case would then assert nothing. Same shape as
       `breakablePeek`: the accessor throws, and the lease reader wraps it the way it wraps a
       folder it could not read in the field. */
    const { adapter, breakIt } = breakableLease(real);

    const events: string[] = [];
    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: () => adapter,
      log: (event: string) => { events.push(event); },
    });
    await grantOrganizeConsent(sidecar);
    running.push(sidecar);

    // BROKEN BEFORE THE LAUNCH — the whole difference from the case above. The gate's FIRST lease
    // read is the one that fails, so the arm under test is the one `start()` runs.
    breakIt(true);
    await sidecar.start();

    // FIRST, THAT THE READ FAILED. Without it this passes when the gate never asked at all.
    expect(events.join(" | "), "the launch lease read never failed, so this case is about nothing")
      .toContain("start_lease_unavailable");

    const marked = sidecar.organizerState();
    expect(marked.unreadableSince,
      "a lease this install could not read AT LAUNCH left the pane looking healthy")
      .not.toBeNull();
    expect(marked.organizing, "an unreadable lease was allowed to grant organizing").toBe(false);

    /* AND THE SOCKET IS FINE — the fold guard, and the reason the two clocks are two clocks.
       "We cannot read who organizes this mailbox" and "this machine cannot reach the server" are
       different sentences, and a person acts on them differently. A launch that stamped BOTH would
       tell somebody their connection is broken when it is not. */
    const conn = Object.values(sidecar.connectionStates());
    expect(conn.length, "no mailbox was attached, so the fold guard is about nothing").toBe(1);
    expect(conn[0].reachable,
      "an unreadable lease was reported to the person as an unreachable server").toBe(true);
    expect(conn[0].unreachableSince,
      "an unreadable lease started the connection's outage clock").toBeNull();
  }, 90_000);

  /**
   * THE CONTROL, AND IT IS NOT DECORATION.
   *
   * The cheap way to pass both claims above is to close the login at the end of `start()`. That
   * would break the product: the poll timer, `syncUntilQuiet()` and the whole organizer role run
   * on this connection for the life of the process. A healthy launch must therefore end with the
   * login OPEN, and this is the claim that makes the fix a `catch` rather than a `finally`.
   */
  it("a HEALTHY launch keeps the login — the fix must not close what the poll timer needs", async () => {
    const cfg = greenmail();
    const real = new ImapAdapter(cfg);
    let closed = 0;
    const adapter = new Proxy(real, {
      get(target, prop) {
        if (prop === "close") return async () => { closed++; await target.close(); };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as MailboxAdapter;

    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: () => adapter,
    });

    await grantOrganizeConsent(sidecar);
    running.push(sidecar);

    await sidecar.start();
    /* `claimed` beside `organizing`: the engine calls a mailbox ours from the moment its gate is
       entitled to the lease, a round trip before a pass reports itself organizing. A healthy
       launch is both. */
    expect(sidecar.organizerState()).toEqual({
      organizing: true, claimed: true, reason: null, heldBy: null,
      releaseRequestedAt: null, unreadableSince: null, unreadableReason: null, releaseRefusal: null, holderState: null,
    });
    expect(closed, "a successful launch closed the connection the organizer runs on").toBe(0);
    const state = await loginState(real);
    expect(state.usable, `a healthy launch has no usable login — ${state.why}`).toBe(true);
  }, 60_000);

  /**
   * THE OTHER HALF OF THAT CHANGE, AND IT IS THE CONTROL RATHER THAN A THIRD LEAK.
   *
   * This case used to read *"holds no login either"* and assert an UNUSABLE session after both
   * launches. That was true of the model it was written in, where standing down meant stopping:
   * a stood-down install organized nothing, polled nothing and had no use for a connection, so a
   * login it still held was a leak.
   *
   * The loser is a READER now. The symmetric-takeover ruling: the stand-down leaves the
   * install its *"row, credentials, mirror"*, it *"reads the mailbox from now on"*, and it keeps
   * its login and its poll timer to do that with. Closing the socket here would not close a leak;
   * it would stop the mirror growing, which is the whole product difference the reader mode
   * shipped for. So the assertion inverts, and it is still a guard: a build that closes on the
   * stand-down path fails here, and it is a build in which a demoted desktop silently stops
   * receiving the user's mail.
   *
   * What that does NOT license is holding a login for a launch that FAILED — the two cases above
   * are that claim, and this one is what tells the two apart: a stand-down is not a failure.
   *
   * `apps/sidecar/test/organizer-lease.e2e.test.ts` covers the DECISION for this launch (it
   * chooses no placement, claims nothing, and the row outranks the empty folder). This adds the
   * connection.
   */
  it("a relaunch that stands down from its own row keeps its login — a reader reads", async () => {
    const cfg = greenmail();
    await seedCloudClaim(cfg, "ohmail-cloud:production");
    const dir = dataDir();

    // Launch one: the LEASE stands this install down, which is the arm that already closed the
    // login. Asserted too — it is the pattern the row arm has to match, and if it ever regresses
    // this claim should say which of the two broke.
    const firstReal = new ImapAdapter(cfg);
    const first = await createSidecar({
      dataDir: dir, imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: () => firstReal,
    });
    await grantOrganizeConsent(first);
    await first.start();
    expect(first.organizerState().organizing, "the seeded cloud claim must win").toBe(false);
    const afterLeaseStandDown = await loginState(firstReal);
    expect(afterLeaseStandDown.usable,
      `a lease stand-down closed the login the reader reads on — ${afterLeaseStandDown.why}`).toBe(true);
    await first.stop();

    // Launch two: same data directory, so the stand-down is on the row and the gate returns
    // before the lease is consulted at all.
    const secondReal = new ImapAdapter(cfg);
    const second = await createSidecar({
      dataDir: dir, imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: () => secondReal,
    });
    await grantOrganizeConsent(second);
    running.push(second);
    expect(second.world.standDownReason, "the relaunch did not find the stand-down on its row")
      .toBe("organized_elsewhere:cloud");

    await second.start();
    expect(second.organizerState().organizing, "a relaunch must not resume organizing").toBe(false);
    const state = await loginState(secondReal);
    expect(state.usable,
      `a stood-down relaunch has no login to read the mailbox with — ${state.why}`)
      .toBe(true);
  }, 60_000);
});
