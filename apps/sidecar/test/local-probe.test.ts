import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
import { readFileSync } from "node:fs";
import { vi } from "vitest";

import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

// Every case here stands a PGlite up. The default 5 s is a budget for a pure function.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ `POST /local/mailboxes/probe` — THE SIXTH MEMBER OF THE AHEAD-OF-TABLE FAMILY ═════════
 *
 * ── WHY IT EXISTS, AND WHY IT DID NOT NEED TO BEFORE ────────────────────────────────────────
 *
 * "Test connection" in the guided flow rides a probe: the engine dials the server somebody just
 * typed and answers a verdict. It rode the SHARED `POST /mailboxes/probe`, which is `stepUp:
 * true` — correctly, because its body carries a mailbox password.
 *
 * On this door a step-up is not a guard but a permanent refusal. The launch session's
 * `lastTwofaAt` is written ONCE at boot (`identity.ts#mintLaunchSession`, "there is no second
 * factor on a local install"), so `withStepUp` admits requests for `stepUpWindowMs` — five
 * minutes — and refuses every one after that for the life of the process.
 *
 * IT WAS SAFE BY ACCIDENT UNTIL THIS RELEASE, and the accident is worth writing down because it
 * is the shape of the defect: the flow's connect FORM was withheld the moment a mailbox existed,
 * so the only state in which the button could be pressed was one where the engine had just come
 * up — the same window in which the launch stamp is fresh. `local-first-run.ts` said exactly
 * that, and it was true.
 *
 * Settings → **Add mailbox** ends it. The form is reachable at any point in a launch now, and the
 * flow's primary stays DISABLED until a verdict exists — so on the shared route "Add mailbox" is
 * a dead end on every window that has been open longer than a coffee, which is every real one.
 *
 * MEASURED, not reasoned. Against a real sidecar behind the built window bundle, the shared route
 * answered the mail server's own refusal 170 s after boot and `403 step_up_required` at 330 s.
 * The cases below reproduce both halves in-process by AGEING THE SESSION ROW rather than by
 * waiting: `withStepUp` compares `now()` against `last_twofa_at`, so moving the stamp back six
 * minutes is the same arithmetic seen from the other side, and it is the only half a test can
 * move without a clock injection the engine does not offer.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const HOST = "imap.example.test";
const USER = "owner@example.test";

/**
 * The dial, as a double. `connect`/`close` are the whole of {@link ProbeDialer}; `listFolders` is
 * the optional third the TEST action's `countFolders` reads, and it is here because the count is
 * part of the verdict this route exists to produce.
 *
 * It REFUSES a wrong password, so a green from these cases is a probe that ran rather than a
 * probe that was skipped.
 */
function dialer(pass: string) {
  return (cfg: { auth?: { user?: string; pass?: string }; host?: string }) => ({
    async connect(): Promise<void> {
      if (cfg.auth?.pass !== pass) {
        const err = new Error("authentication failed") as Error & { authenticationFailed?: boolean };
        err.authenticationFailed = true;
        throw err;
      }
    },
    async close(): Promise<void> {},
    async listFolders(): Promise<string[]> {
      return ["INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive", "Notes"];
    },
    /* The SYNC adapter's surface, for the boot that happens before any of this. The engine builds
       one at launch; nothing in these cases drains, so the members that matter are the ones the
       lease composition touches. */
    leaseIo: () => ({
      async ensureMetaFolder(): Promise<void> {},
      async listClaims(): Promise<never[]> { return []; },
      async appendClaim(): Promise<void> {},
      async removeClaims(): Promise<void> {},
      /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
      uidValidity: () => 4_100,
    }),
    leasePeekIo: () => ({ async listClaims(): Promise<never[]> { return []; } }),
    async capabilities() {
      return { move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince() {
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move() { return { folder: "INBOX", ref: "1:1" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
  });
}

async function boot(smtpDial?: SmtpDial): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-local-probe-");
  const s = await createSidecar({
    dataDir,
    imap: {
      host: HOST, port: 993, secure: true,
      auth: { user: USER, pass: "seed-password" },
    },
    address: USER,
    machineName: "this machine",
    // Long enough that no timer fires on its own — every pass is one a case asked for.
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: { 1: Buffer.alloc(32, 7) },
    adapterFactory: dialer("the-right-password"),
    /* THE SUBMISSION DIAL. With an `adapterFactory` and no dial of its own the engine composes
       one that succeeds for every host, which cannot produce the state the cases below are
       about — a submission server that says no. */
    ...(smtpDial ? { smtpDial } : {}),
    log: () => {},
  } as never);
  cleanups.push(async () => {
    await s.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  await s.start();
  return s;
}

/** The window's own probe body: the incoming block always, the outgoing one when it is typed. */
interface ProbeBody {
  address: string;
  imap: { host: string; port: number; secure: boolean; user: string; pass: string };
  smtp?: Record<string, unknown>;
}

const body: ProbeBody = {
  address: "second@example.test",
  imap: { host: HOST, port: 993, secure: true, user: "second@example.test", pass: "the-right-password" },
};

/** The engine's own submission-probe seam: the config it would dial with, or a throw. */
type SmtpDial = (smtp: { host?: string; port?: number }) => Promise<void>;

const SMTP_OK = "smtp.example.test";
const SMTP_BAD = "outgoing.example.test";

/** The outgoing block the window sends beside `imap` — the form's own fields, no password. */
const outgoing = (host: string): Record<string, unknown> =>
  ({ host, port: 465, secure: true, user: "second@example.test" });

/**
 * A submission server that accepts one host and refuses the other with the class a wrong
 * password produces. Every dial it sees is recorded, so a case can prove the leg RAN: a
 * `not_configured` answer and a leg that was silently skipped read the same on the wire.
 */
function smtpDouble(): { dial: SmtpDial; dialled: string[] } {
  const dialled: string[] = [];
  return {
    dialled,
    dial: async (smtp) => {
      dialled.push(smtp.host ?? "");
      if ((smtp.host ?? "") === SMTP_BAD) {
        throw Object.assign(new Error("authentication failed"), { code: "EAUTH" });
      }
    },
  };
}

const probeVia = async (s: Sidecar, path: string, over: ProbeBody = body): Promise<Response> =>
  s.handle(new Request(`http://local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(over),
  }));

/**
 * A WINDOW THAT HAS BEEN OPEN LONGER THAN THE STEP-UP WINDOW.
 *
 * The stamp moves rather than the clock, for the reason the header gives. Six minutes: the window
 * is five, and a value just past it would make this case sensitive to how long the boot took.
 */
async function ageTheSession(s: Sidecar): Promise<void> {
  await s.db.execute(
    sql`update sessions set last_twofa_at = now() - interval '6 minutes'`,
  );
}

describe("testing a connection on the standalone door", () => {
  it("SUCCEEDS on a window older than the step-up gate, and answers the verdict's three facts", async () => {
    const s = await boot();
    await ageTheSession(s);

    const res = await probeVia(s, "/local/mailboxes/probe");
    expect(res.status).toBe(200);
    const dto = await res.json() as { host: string; user: string; folders: number | null };
    /* THE PROVEN RUNG, THE ACCEPTED IDENTITY AND THE COUNT — the three the connect form renders.
       `folders` is what `countFolders: true` buys and the reason this route may not be built with
       the create's prober: a verdict with no number is a sentence about a login, and the count is
       the part somebody can check against their own mailbox. */
    expect(dto.host).toBe(HOST);
    expect(dto.user).toBe("second@example.test");
    expect(dto.folders).toBe(7);
  });

  it("and the SHARED route refuses the same call on the same window — the defect this closes", async () => {
    /* ── THE MEASUREMENT, IN-PROCESS ────────────────────────────────────────────────────────
     * This is the mutation "route the flow's probe back at the shared path" as a permanent case
     * rather than a one-off: if the window ever goes back to `POST /mailboxes/probe`, the walk it
     * breaks is "Settings → Add mailbox" on any install open more than five minutes, and the
     * person sees a refusal about two-factor authentication on a door that has no second factor.
     */
    const s = await boot();
    await ageTheSession(s);

    const res = await probeVia(s, "/mailboxes/probe");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "step_up_required" } });
  });

  it("the shared route gets PAST the gate on a fresh window — which is why this went unnoticed", async () => {
    /* ── THE CONTROL, and it is what makes the case above mean what it says ──────────────────
     *
     * Without it, "the shared route answered 403" could be true because the route is unreachable
     * in this composition for some reason of its own, and the case would be green over a claim it
     * never tested. Here the SAME call on a window whose launch stamp is still fresh gets past
     * `withStepUp` and fails further in — so the 403 above is the stamp expiring and nothing else.
     *
     * IT FAILS AT THE DIAL, and that is a second thing worth recording. `config.adapterFactory`
     * is threaded into the probes the `/local/*` handlers build (`probeOpts`) and NOT into the
     * shared route's, which composes `makeImapProbe(deps, { countFolders: true })` on its own —
     * so on this door the shared probe opens a real socket even in a composition told to dial
     * through a double. The local route does not, which is one more reason the flow's test action
     * belongs on it. Not asserted as a status: what matters is the ABSENCE of the refusal.
     */
    const s = await boot();
    const res = await probeVia(s, "/mailboxes/probe");
    expect(res.status, "the shared route refused before it ever dialled").not.toBe(403);
  });

  it("REFUSES a wrong password with the taxonomy the connect form renders", async () => {
    /* The route is the transport; the refusal is the service's. `localProbeReason` in the window
       reads `details.reason` to choose its sentence, so a handler that dropped the details would
       put the generic line on screen with the answer unread in the same response. */
    const s = await boot();
    await ageTheSession(s);

    const res = await probeVia(s, "/local/mailboxes/probe", {
      ...body, imap: { ...body.imap, pass: "wrong" },
    });
    expect(res.status).toBe(400);
    const wire = await res.json() as { error: { code: string; details?: { reason?: string } } };
    expect(wire.error.code).toBe("mailbox_probe_failed");
    expect(wire.error.details?.reason).toBe("auth");
  });

  it("REFUSES an unauthenticated call, like every other member of the family", async () => {
    const s = await boot();
    const res = await s.handle(new Request("http://local/local/mailboxes/probe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(res.status).toBe(401);
  });

  /* ── AND THE OUTGOING SERVER, WHICH THE CONNECT ALSO DIALS ────────────────────────────────
     The seal writes an `smtp` credential beside the `imap` one and refuses the whole mailbox when
     the submission server says no, so a test that asked only the incoming server reported a green
     over a connect that was about to fail — three real shapes reach it, and the one that hurts is
     a preset whose outgoing host is wrong for the account, which nobody typed. */
  it("answers BOTH legs: the incoming verdict stands and the outgoing one is named", async () => {
    const smtp = smtpDouble();
    const s = await boot(smtp.dial);
    await ageTheSession(s);

    const res = await probeVia(s, "/local/mailboxes/probe", { ...body, smtp: outgoing(SMTP_BAD) });
    expect(res.status, "a refused submission server took the whole test down").toBe(200);
    const dto = await res.json() as {
      host: string; folders: number | null;
      sending?: { state: string; host?: string; reason?: string };
    };
    /* THE RECEIVING VERDICT IS UNCHANGED — that is the whole point of answering rather than
       throwing: the person needs to know which of the two servers refused. */
    expect(dto.host).toBe(HOST);
    expect(dto.folders).toBe(7);
    expect(dto.sending).toEqual({ state: "refused", host: SMTP_BAD, reason: "auth" });
    /* THE LEG RAN. Without this, the answer above could be a refusal composed from nothing. */
    expect(smtp.dialled, "the submission server was never dialled").toContain(SMTP_BAD);
  });

  it("says OK when the outgoing server accepts the same login", async () => {
    const smtp = smtpDouble();
    const s = await boot(smtp.dial);
    await ageTheSession(s);

    const res = await probeVia(s, "/local/mailboxes/probe", { ...body, smtp: outgoing(SMTP_OK) });
    expect(res.status).toBe(200);
    const dto = await res.json() as { sending?: { state: string; host?: string } };
    expect(dto.sending).toEqual({ state: "ok", host: SMTP_OK });
    expect(smtp.dialled).toEqual([SMTP_OK]);
  });

  /* AN OUTGOING SERVER WITH NO ENCRYPTION ON THIS NETWORK: the test says so with the offer, so the
     form opens the outgoing consent line from the test rather than only from a refused connect. */
  it("an outgoing server with no encryption on this network carries the plaintext offer", async () => {
    const s = await boot(async (smtp) => {
      if ((smtp as { allowInsecure?: boolean }).allowInsecure !== true) {
        throw new Error("Error upgrading connection with STARTTLS: 502 5.5.1 Unrecognized command");
      }
    });
    const res = await probeVia(s, "/local/mailboxes/probe", {
      ...body, smtp: { host: "192.168.1.20", port: 587, secure: false, user: "second@example.test" },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { sending?: unknown }).sending).toEqual({
      state: "refused", host: "192.168.1.20", reason: "tls", tls: { kind: "tls_unavailable", plaintext: "offered" },
    });
  });

  it("a BLANK outgoing field is an answer, not a refusal — and nothing is dialled", async () => {
    /* `smtpHost: ""` records a pair with nothing on the outgoing side, which this product
       supports: the mailbox receives and does not send. The verdict says so rather than passing
       silently, so the person is not told sending works when nothing is set up to do it. */
    const smtp = smtpDouble();
    const s = await boot(smtp.dial);
    await ageTheSession(s);

    const res = await probeVia(s, "/local/mailboxes/probe", { ...body, smtp: { host: "" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sending: { state: "not_configured" } });
    expect(smtp.dialled, "a blank outgoing field opened a socket").toEqual([]);
  });

  it("an ABSENT outgoing block reads the same way — a form with nothing typed there", async () => {
    const smtp = smtpDouble();
    const s = await boot(smtp.dial);
    await ageTheSession(s);

    const res = await probeVia(s, "/local/mailboxes/probe");
    expect(await res.json()).toMatchObject({ sending: { state: "not_configured" } });
    expect(smtp.dialled).toEqual([]);
  });

  it("WRITES NOTHING — a probe is a dial, not a create", async () => {
    // The whole difference between this and `POST /local/mailboxes`. A probe that left a row
    // behind would be an "Add mailbox" flow that half-added a mailbox at the test press.
    const s = await boot();
    await ageTheSession(s);
    const before = await s.db.execute(sql`select count(*)::int as n from mailboxes`);
    await probeVia(s, "/local/mailboxes/probe");
    const after = await s.db.execute(sql`select count(*)::int as n from mailboxes`);
    expect(after.rows).toEqual(before.rows);
  });
});

/**
 * ═══ THE FAMILY, ENUMERATED — so a TENTH member cannot arrive without a test ══════════════
 *
 * Nine paths are served by `engine.ts`'s `handle` AHEAD of the route table. Their authority is
 * the per-launch bearer — minted at boot, added shell-side, never reaching the window, impossible
 * for a page to compose.
 *
 * ── AND THERE ARE NOW TWO REASONS TO BE HERE, NOT ONE ─────────────────────────────────────
 *
 * This header said "every one of them is there for the same reason: its shared twin is
 * `stepUp: true`, and on this door a step-up is a permanent refusal rather than a guard". That
 * was true of six. `/local/mailboxes/connections` has NO shared twin, and the distinction is
 * worth keeping rather than smoothing over: it is here because the hosted service has nothing to
 * report at that path at all. Its mailboxes are attached by a worker on a shard, and the liveness
 * of a socket on a machine nobody is sitting at is not a fact any account can be asked for. A
 * route in `packages/api`'s shared table would be hosted surface invented for a desktop
 * lifecycle.
 *
 * What both reasons produce is the same property, which is the one this file tests: every member
 * is a statement about THIS COMPUTER, so none may appear in `desktopHostRoutes`.
 *
 * The list is written down HERE because the property they share is not a property of any one of
 * them. Each is a statement about THIS COMPUTER, so none may appear in `desktopHostRoutes` — the
 * table the LAN and Tailscale doors match against, which a paired phone reaches. Adding one there
 * would open it on three doors at once, silently, and the 404 that protects it today is
 * structural only for as long as somebody keeps checking.
 */
describe("the ahead-of-table family", () => {
  const FAMILY = [
    "/local/stored-login",
    "/local/organizer/takeover",
    "/local/mailboxes",
    "/local/mailboxes/probe",
    "/local/mailboxes/:id",
    "/local/mailboxes/:id/organize",
    "/local/mailboxes/connections",
    // The network-return relay's door: THIS computer's sockets, like the read beside it.
    "/local/mailboxes/connections/retry",
    // The name this computer's letters carry: on the bearer, the display name only, never a credential or a server.
    "/local/mailboxes/:id/name",
  ] as const;

  it("is exactly these nine, as an EXACT SET read out of the source", () => {
    /* AN EXACT SET, not a one-way containment. A census that only asked "is each of my seven
       served?" would keep saying seven while an eighth arrived — a route with an authority nobody
       argued for, reachable on a bearer nobody re-examined. It did its job on the seventh: the
       connections read landed and this line went red in the same run. The source is normalised rather than
       matched literally: the block decides two ways, an exact `url.pathname` comparison for the
       fixed paths and a regex for the two that carry an id. */
    const block = preTableBlock();
    const normalised = block
      .replace(/\\\//g, "/")
      .replace(/\(\[0-9a-fA-F-\]\{36\}\)/g, ":id");
    const served = new Set(
      [...normalised.matchAll(/(?:\^|")(\/local\/[A-Za-z:/-]+)(?:\$|")/g)].map((m) => m[1]!),
    );
    expect([...served].sort()).toEqual([...FAMILY].sort());
  });

  /**
   * THE QUESTION AS A FUNCTION, so the admitting arm can be driven into a refusal. Reading the
   * real table and finding nothing is a pass a broken reader also produces — a typo in the
   * pattern, an empty table, a `some` over the wrong field — so the same reader is handed a set
   * with a family member planted in it and has to name it.
   */
  const familyOn = (routes: ReadonlyArray<{ pattern: string }>): string[] =>
    FAMILY.filter((path) =>
      routes.some((r) => r.pattern === path || r.pattern.startsWith(`${path}/`)));

  it("is absent from the doors a paired device reaches — all nine, not two", () => {
    /* `lan-routes.test.ts` makes this assertion for the two members that existed when it was
       written. The property belongs to the family rather than to those two, so it is made over
       the whole list here: a phone on the same network must not be able to add a mailbox to
       somebody's computer, remove one, seal a password onto one, ask this machine to open a
       socket to a host the phone named, or enumerate which of this computer's mail servers are
       currently answering. */
    expect(
      familyOn(desktopHostRoutes),
      "reachable from the host and LAN doors — these are actions about THIS COMPUTER",
    ).toEqual([]);
  });

  it("POSITIVE CONTROL: the same reader names a planted route, parent and child alike", () => {
    /* The removal door is the one a brief asked to be put on all three handles, which is why the
       control plants exactly that. A phone must not remove a mailbox from a computer; the guard
       is evidence only because this arm watches it fire. */
    const planted = [...desktopHostRoutes, { pattern: "/local/mailboxes/:id" }];
    /* TWO names, not one, and that is the prefix rule working: the planted path is also a child
       of `/local/mailboxes`, so a member added under any family path is named by its parent too. */
    expect(familyOn(planted)).toEqual(["/local/mailboxes", "/local/mailboxes/:id"]);
    const child = [...desktopHostRoutes, { pattern: "/local/mailboxes/:id/organize" }];
    expect(familyOn(child)).toEqual([
      "/local/mailboxes", "/local/mailboxes/:id", "/local/mailboxes/:id/organize",
    ]);
  });
});

/** The stretch of `engine.ts` that decides which paths are served ahead of the route table. */
function preTableBlock(): string {
  const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
  const from = src.indexOf("const localRemoveMatch");
  const to = src.indexOf("if (localAction)", from);
  expect(from, "the pre-table block moved — this census is reading nothing").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}
