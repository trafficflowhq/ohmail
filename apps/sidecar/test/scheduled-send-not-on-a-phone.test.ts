import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { drafts, mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { COMPOSITION_PASSES, NO_APPOINTMENTS_HERE, runsPass } from "../src/composition-passes.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A PHONE MAKES NO APPOINTMENTS — `PHONE-SCHEDULED-SEND-IS-NOT-REFUSED-ON-THE-PHONE`
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `PHONE-0.17-RULING.md` §2 lists scheduled/send-later among the features that are OFF on a phone,
 * "refused at the door with one sentence and not composed". The ruling wins over the code, and the
 * code disagreed: the only `organizerKind`-keyed condition in this package was the `machineName`
 * requirement, and the scheduled-send pass ran per organizing runtime with no gate on the kind. So
 * a standalone phone accepted a promise to send at 09:00 and kept it only if somebody happened to
 * have ohmail running at 09:00 — which is the promise a phone cannot make.
 *
 * ── TWO CONDITIONS, MEASURED INDEPENDENTLY, AND THAT IS THE POINT ───────────────────────────
 *
 * The DOOR stops the promise being made (`POST /drafts/:id/schedule` → 409, one sentence); the
 * PASS stops a delivery from a standing row (`sendScheduled` never enters
 * `runScheduledSendPass`). Neither implies the other: a store carried over from a build without
 * the door still holds appointments, and a door that refuses is no answer for the row already
 * there. Each has its own case below, and each has its desktop PAIR in the same run — a file that
 * only exercises the refusing arm cannot see the regression it is most likely to cause.
 *
 * CANCEL is deliberately still open on a phone, and it has its own case: taking the appointment
 * off is the only remedy its owner has left, and a door that refused that too would strand the
 * row it refused to keep.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────────
 *
 * In `src/composition-passes.ts` give `mobile` the member (`mobile: ["scheduled-send"]`) and three
 * cases redden at once: the table, the pass (the row leaves `scheduled`) and the door (200 where a
 * 409 belongs). Delete the `if (!runsPass(...)) return` guard in `sendScheduled` and the pass case
 * alone reddens — which is what proves the two conditions are separate. Give
 * `AppointmentsRefused` a `cancel` override that throws and the REMEDY case alone reddens (409
 * where 200 belongs), so that case is not passing on an inherited method nobody exercised. All
 * three mutations were run and each restore was verified by `cmp`.
 */

/** `ohmail/_meta` in memory, empty — so the install under test wins its own lease uncontested. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/**
 * A mailbox with nothing in it whose SEND records the attempt and then throws.
 *
 * Recording before throwing is what makes "the phone did not send" an assertion rather than a
 * hope: a composition that ran the pass anyway leaves the attempt here, whatever the transport
 * then did with it.
 */
function quietMailbox(meta: MemoryMetaFolder) {
  const sends: OutboundMessage[] = [];
  const factory = (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => ({
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
      return { ...EMPTY_BATCH };
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
    async send(m: OutboundMessage): Promise<SendResult> {
      sends.push(m);
      throw new Error("this test's mailbox must never be asked to send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
  return { factory, sends };
}

const HOUR = 60 * 60 * 1000;

describe("a composition that keeps no appointments", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  interface Booted {
    sidecar: Sidecar;
    sends: OutboundMessage[];
    events: string[];
  }

  /**
   * One install of a chosen kind, ASSEMBLED AND NOT STARTED — see {@link start} for why the two
   * are separate here.
   *
   * `machineName` is passed for both kinds because a non-desktop composition is required to name
   * itself; the consent+role write is this file's PRECONDITION and not its subject — the gate
   * reads the consent and every service write door reads the role, and an install that has been
   * organizing for a while carries both.
   */
  async function assemble(organizerKind?: "mobile"): Promise<Booted> {
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const dataDir = await freshDataDir("ohmail-no-appointments-");
    const events: string[] = [];
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        // A password is what makes `start()` take the connected path at all.
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the install under test",
      ...(organizerKind === undefined ? {} : { organizerKind }),
      // Long enough that the poll timer never fires: every drain here is one the test asked for.
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox.factory,
      log: (event: string) => events.push(event),
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    return { sidecar, sends: mailbox.sends, events };
  }

  /**
   * START, AND THE DRAIN `start()` RUNS ITSELF.
   *
   * Separate from {@link assemble} so a fixture row can be written BEFORE the first drain, which
   * is what makes the pass's answer about a row that was actually there to claim.
   */
  async function start(b: Booted): Promise<void> {
    await b.sidecar.start();
    expect(
      b.sidecar.organizerState().organizing,
      "the install is not organizing, so nothing here is about an organizer's pass",
    ).toBe(true);
  }

  /**
   * A SECOND DRAIN, AND THE RENEW THAT USED TO END THE PHONE'S TENURE.
   *
   * This is the pass a `mobile` install could not survive before mail 0103: a renew appends its
   * new claim and expunges the old copy afterwards, and a phone could not rank its own kind — so
   * it read its own residue as a stranger's, lost the race and stood down, and the stand-down's
   * own closer then finalized the appointment with the handover sentence. That hid the question
   * this file asks. The kind is rankable now, so the phone keeps the mailbox across the renew and
   * the pass's refusal is what the row's state reports.
   */
  async function secondPass(b: Booted): Promise<void> {
    const cycles = await b.sidecar.syncUntilQuiet();
    expect(cycles, "no second drain ran, so nothing below is measured across a renew")
      .toBeGreaterThan(0);
  }

  /**
   * A DUE APPOINTMENT, written straight onto the row.
   *
   * Not through `ScheduleService`: it refuses a past time against the server's own clock, and a
   * past time is the whole fixture — the pass claims `send_at <= now`. This is also the only shape
   * in which such a row can exist on a phone once the door refuses, which is the population the
   * pass guard is for: a store from a build that accepted the promise before the refusal landed.
   */
  async function dueAppointment(sidecar: Sidecar): Promise<string> {
    const [d] = await sidecar.db.insert(drafts).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      subject: "the appointment",
      body: "the words",
      to: [{ name: null, address: "you@example.com" }],
      status: "scheduled",
      sendAt: new Date(Date.now() - HOUR),
      // The key the claim arm requires, minted at schedule time exactly as the service mints it.
      sendKey: randomUUID(),
    }).returning();
    return d!.id;
  }

  /** An ordinary draft with a recipient — what the schedule door is offered. */
  async function plainDraft(sidecar: Sidecar): Promise<string> {
    const [d] = await sidecar.db.insert(drafts).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      subject: "later, maybe",
      body: "the words",
      to: [{ name: null, address: "you@example.com" }],
      status: "draft",
    }).returning();
    return d!.id;
  }

  const draftRow = async (sidecar: Sidecar, id: string) => {
    const [row] = await sidecar.db.select().from(drafts).where(eq(drafts.id, id));
    return row!;
  };

  const scheduleReq = (b: Booted, id: string, method: "POST" | "DELETE"): Request =>
    new Request(`http://local/drafts/${id}/schedule`, {
      method,
      headers: {
        authorization: `Bearer ${b.sidecar.sessionToken}`,
        "content-type": "application/json",
      },
      ...(method === "POST"
        ? { body: JSON.stringify({ sendAt: new Date(Date.now() + 2 * HOUR).toISOString() }) }
        : {}),
    });

  /* ── THE TABLE ──────────────────────────────────────────────────────────────────────────── */

  it("THE TABLE — a phone's schedule holds no scheduled-send producer, and a desktop's does", () => {
    expect(runsPass("mobile", "scheduled-send")).toBe(false);
    expect(runsPass("local", "scheduled-send")).toBe(true);
    expect(runsPass("cloud", "scheduled-send")).toBe(true);
    /* EXHAUSTIVE, and the `Record<OrganizerKind, …>` type is what enforces it — this line
       is the runtime half, so a kind added with a `// @ts-expect-error` or a cast is still seen.
       A fourth kind reaching the claim without an answer here is the defect `organizerKind` was
       made a field to prevent. */
    expect(Object.keys(COMPOSITION_PASSES).sort()).toEqual(["cloud", "local", "mobile"]);
  });

  /* ── THE PASS ───────────────────────────────────────────────────────────────────────────── */

  it("THE PASS — two drains on a phone leave a due appointment standing, with nothing offered to any server", async () => {
    const b = await assemble("mobile");
    const draftId = await dueAppointment(b.sidecar);
    await start(b);
    await secondPass(b);

    // THE PHONE STILL HOLDS ITS OWN MAILBOX ACROSS THE RENEW. Asserted before the row, because a
    // stand-down would close the appointment for a reason that is not this file's subject and the
    // row would then read the same either way — the shape this case was written around once.
    expect(b.sidecar.organizerState()).toMatchObject({ organizing: true });
    expect(b.events, "the phone stood down from its own mailbox").not.toContain("organizer_stand_down");
    expect(b.events).not.toContain("lease_lost_race");
    expect(b.events, "the appointment was closed by a stand-down, not left standing by the pass")
      .not.toContain("scheduled_sends_stood_down");

    const row = await draftRow(b.sidecar, draftId);
    // STILL `scheduled` with its key: nothing claimed it, so nothing can have sent it. The claim
    // arm is the only writer that moves a row off this status, and it runs before any dial.
    expect(row.status, "a phone claimed an appointment it cannot keep").toBe("scheduled");
    expect(row.sendKey, "the appointment was claimed — the key is cleared by a claim").not.toBeNull();
    expect(b.sends, "a phone offered a scheduled message to the mail server").toHaveLength(0);

    // AND THE REASON IS ON THE RECORD. `scheduled_send_pass` is absent because the pass was never
    // entered — a send that never happened is visible by that line's absence, so the line that
    // says WHY has to be present in its place.
    expect(b.events).toContain("scheduled_send_pass_not_composed");
    expect(b.events.filter((e) => e === "scheduled_send_pass_not_composed")).toHaveLength(1);
    expect(b.events, "the pass ran on a composition that composes none").not.toContain("scheduled_send_pass");
    expect(b.events).not.toContain("scheduled_send_pass_failed");
  });

  it("THE DESKTOP PAIR — the same fixture on a desktop is claimed by the pass", async () => {
    const b = await assemble();
    const draftId = await dueAppointment(b.sidecar);
    await start(b);
    await secondPass(b);

    /* CLAIMED, which is the property under test, and NOT "sent": this file's transport throws, so
       what the claim becomes afterwards (a deferral or a closed row with a sentence) belongs to
       the pass's own tests. The claim flips the status in its own transaction before any dial, so
       "left `scheduled`" is the one observation that separates "the pass ran" from "it did not". */
    const row = await draftRow(b.sidecar, draftId);
    expect(row.status, "the desktop's own pass did not claim a due appointment").not.toBe("scheduled");
    expect(b.events, "the desktop refused its own pass").not.toContain("scheduled_send_pass_not_composed");
  });

  /* ── THE DOOR ───────────────────────────────────────────────────────────────────────────── */

  it("THE DOOR — a phone refuses to make an appointment, with the sentence", async () => {
    const b = await assemble("mobile");
    await start(b);
    const draftId = await plainDraft(b.sidecar);

    const res = await b.sidecar.handle(scheduleReq(b, draftId, "POST"));
    expect(res.status, "a phone accepted a promise it cannot keep").toBe(409);
    const body = (await res.json()) as { error?: { message?: string } };
    /* THE CONSTANT, never a re-typed copy: a sentence asserted by a literal here would let the
       shipped one drift into something less true while this stayed green. */
    expect(JSON.stringify(body)).toContain(NO_APPOINTMENTS_HERE);

    // AND THE ROW IS UNTOUCHED — a refusal that had already written `send_at` would be a promise
    // made and denied in the same breath, and the Drafts screen would read "Sends" either way.
    const row = await draftRow(b.sidecar, draftId);
    expect(row.status).toBe("draft");
    expect(row.sendAt).toBeNull();
    expect(row.sendKey).toBeNull();
  });

  it("THE DESKTOP PAIR — the same request on a desktop makes the appointment", async () => {
    const b = await assemble();
    await start(b);
    const draftId = await plainDraft(b.sidecar);

    const res = await b.sidecar.handle(scheduleReq(b, draftId, "POST"));
    expect(res.status, "the desktop's own schedule door was refused").toBe(200);
    const row = await draftRow(b.sidecar, draftId);
    expect(row.status).toBe("scheduled");
    expect(row.sendAt).not.toBeNull();
  });

  it("THE REMEDY — a phone still CANCELS an appointment that stands in its store", async () => {
    // The refusal is about making a promise, never about ending one. A phone whose store came
    // from a build that accepted appointments must be able to take them off: the pass will never
    // send them, so cancel is the only thing that can change the row.
    const b = await assemble("mobile");
    const draftId = await dueAppointment(b.sidecar);
    await start(b);

    const res = await b.sidecar.handle(scheduleReq(b, draftId, "DELETE"));
    expect(res.status, "a phone refused the one remedy its owner has left").toBe(200);
    const row = await draftRow(b.sidecar, draftId);
    expect(row.status).toBe("draft");
    expect(row.sendAt).toBeNull();
    expect(row.sendKey).toBeNull();
  });
});
