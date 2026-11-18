import type { HeldReleaseGroupWire, HeldReleaseWire } from "@ohmail/wire";
import { describe, expect, it, vi } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { heldReleaseDismissedOf, heldReleaseGroups } from "../src/selectors.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";
import { CursorExpiredError, type SyncChange } from "../src/types.js";

/**
 * "NOT NOW" IS THE ACCOUNT'S, SO EVERY DEVICE DROPS THE OFFER WITHIN ONE PULL.
 *
 * Measured on 0.25.0: dismissed on the web, the offer stayed on the Cloud-paired desktop for six
 * minutes, through Pull new mail and a reopened Screener. The desktop's read honoured the server
 * all along; it simply never asked again after the shell mounted. The dismissal now rings the
 * settings doorbell (`held-release-dismiss-doorbell.test.ts`), and the engine re-asks its one
 * held-release door at a drain's settle when that stamp moved since its last answer — only once
 * a surface has asked, so an engine that never shows the offer (the phone) pays nothing.
 */

const ACCOUNT = "acct-1";
const t0 = Date.parse("2026-09-25T14:00:00.000Z");

const group = (ruleId: string, count: number): HeldReleaseGroupWire => ({
  ruleId, kind: "sender", match: `${ruleId}@shape.test`, destination: "INBOX", count,
});

/** One hosted account: the settings doorbell on its log, the offer and its dismissal. */
function account() {
  const log: SyncChange[] = [];
  let seq = 0;
  let groups = [group("r1", 28)];
  let dismissed: string | null = null;
  const fingerprint = () => groups.map((g) => `${g.ruleId}:${g.count}`).join("|");
  const ring = () => {
    const at = new Date(t0 + ++seq * 1_000).toISOString();
    log.push({
      type: "settings", op: "update", id: ACCOUNT, seq, updatedAt: at,
      entity: { accountId: ACCOUNT, updatedAt: at },
    });
  };
  ring(); // the row every bootstrap carries

  const answer = (): HeldReleaseWire => ({
    groups, total: groups.reduce((n, g) => n + g.count, 0), max: 200,
    fingerprint: fingerprint(), dismissed: dismissed === fingerprint(),
  });

  /** A device's door onto this account, counting what it asks. */
  function door() {
    const calls = { sync: 0, held: 0 };
    let heldImpl: () => Promise<HeldReleaseWire> = async () => answer();
    let expireNext = false;
    const adapter = {
      sync: async ({ since }: { since: string }) => {
        calls.sync++;
        if (expireNext && since !== "0") { expireNext = false; throw new CursorExpiredError(); }
        const from = Number(since);
        const page = log.filter((c) => c.seq > from);
        return {
          changes: { creates: [], updates: page, moves: [], deletes: [] },
          cursor: String(seq), hasMore: false, serverTime: new Date(t0).toISOString(),
        };
      },
      mutate: async () => ({ ok: true as const, changes: [] }),
      heldReleases: () => { calls.held++; return heldImpl(); },
      dismissHeldRelease: async (fp: string) => { dismissed = fp; ring(); },
    } as unknown as EngineAdapter;
    return {
      adapter, calls, answer,
      answerWith: (f: typeof heldImpl) => { heldImpl = f; },
      /** The next resuming pull answers 410, as a cursor past the retention horizon does. */
      expireCursor: () => { expireNext = true; },
    };
  }

  return {
    door,
    /** Another settings knob written somewhere — the same doorbell, no dismissal. */
    ring,
    /** The held set changes on the server (new held mail from a decided sender). */
    setGroups: (g: HeldReleaseGroupWire[]) => { groups = g; },
  };
}

async function device(acct: ReturnType<typeof account>, opts: { showsOffer: boolean }) {
  const d = acct.door();
  const engine = new OhmailEngine({ adapter: d.adapter, now: () => new Date(t0) });
  await engine.start();
  // The Screener shell's mount ask — what a surface that renders the offer does once.
  if (opts.showsOffer) await engine.refreshHeldReleases();
  return { engine, ...d };
}

const offered = (e: OhmailEngine) =>
  heldReleaseGroups(e.read()).length > 0 && !heldReleaseDismissedOf(e.read());

describe("the held-release dismissal reaches every device through the one door", () => {
  it("dismissed on the web, the paired desktop drops the offer on its next pull", async () => {
    const acct = account();
    const web = await device(acct, { showsOffer: true });
    const desk = await device(acct, { showsOffer: true });
    expect(offered(web.engine)).toBe(true);
    expect(offered(desk.engine)).toBe(true);

    await web.engine.dismissHeldRelease();
    expect(offered(web.engine)).toBe(false);

    const [pulls, asks] = [desk.calls.sync, desk.calls.held];
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine), "the desktop still offers a dismissed set").toBe(false));
    expect(desk.calls.sync - pulls, "reached within ONE pull").toBe(1);
    expect(desk.calls.held - asks, "one held-release read per settings change").toBe(1);
  });

  it("the reverse: dismissed on the desktop, the web drops it on its next pull", async () => {
    const acct = account();
    const web = await device(acct, { showsOffer: true });
    const desk = await device(acct, { showsOffer: true });

    await desk.engine.dismissHeldRelease();
    expect(offered(desk.engine)).toBe(false);

    await web.engine.syncOnce();
    await vi.waitFor(() => expect(offered(web.engine), "the web still offers a dismissed set").toBe(false));
  });

  /** The cost bound: a pull that carries no settings change asks nothing. */
  it("a pull with no settings change issues no held-release read", async () => {
    const acct = account();
    const desk = await device(acct, { showsOffer: true });
    await desk.engine.syncOnce(); // the post-mount settle may re-ask once for the cold stamp
    await vi.waitFor(() => expect(desk.calls.held).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    const asks = desk.calls.held;
    for (let i = 0; i < 3; i++) await desk.engine.syncOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(desk.calls.held).toBe(asks);
  });

  /** An engine no surface asked — the phone renders no offer — never reads it on a pull. */
  it("an engine that never showed the offer never asks for it", async () => {
    const acct = account();
    const phone = await device(acct, { showsOffer: false });
    const web = await device(acct, { showsOffer: true });
    await web.engine.dismissHeldRelease();
    await phone.engine.syncOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(phone.calls.held).toBe(0);
  });

  /** The server's rule decides a re-offer, and every device reads it through the same door. */
  it("a changed set re-offers on every device alike at the next doorbell", async () => {
    const acct = account();
    const web = await device(acct, { showsOffer: true });
    const desk = await device(acct, { showsOffer: true });
    await web.engine.dismissHeldRelease();
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine)).toBe(false));

    acct.setGroups([group("r1", 29)]);
    acct.ring();
    await web.engine.syncOnce();
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect([offered(web.engine), offered(desk.engine)]).toEqual([true, true]));
  });

  /** A failed re-ask is not the answer: the next settle asks again. */
  it("a re-ask that fails is retried at the next settle", async () => {
    const acct = account();
    const web = await device(acct, { showsOffer: true });
    const desk = await device(acct, { showsOffer: true });
    await desk.engine.syncOnce();
    await new Promise((r) => setTimeout(r, 0));

    await web.engine.dismissHeldRelease();
    let fail = true;
    desk.answerWith(async () => {
      if (fail) { fail = false; throw new Error("door down"); }
      return desk.answer();
    });
    await desk.engine.syncOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(offered(desk.engine)).toBe(true);

    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine)).toBe(false));
  });

  /** A re-bootstrap wipes the answer with the mirror; the offer comes back without a remount. */
  it("a 410 re-bootstrap asks for the offer again at its settle", async () => {
    const acct = account();
    const desk = await device(acct, { showsOffer: true });
    expect(offered(desk.engine)).toBe(true);
    const asks = desk.calls.held;
    desk.expireCursor();
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine), "the wipe took the offer and nothing asked again").toBe(true));
    expect(desk.calls.held - asks).toBe(1);
  });

  /** A doorbell that rang while the read was in the air is not answered by that read. */
  it("a dismissal rung during an in-flight re-ask is asked again at the next settle", async () => {
    const acct = account();
    const web = await device(acct, { showsOffer: true });
    const desk = await device(acct, { showsOffer: true });
    let release!: () => void;
    const before = desk.answer();
    desk.answerWith(() => new Promise((r) => { release = () => r(before); }));
    acct.ring(); // some other settings write: the desktop's bell re-asks, slowly
    await desk.engine.syncOnce();

    await web.engine.dismissHeldRelease(); // rings again while that read is in the air
    await desk.engine.syncOnce();
    desk.answerWith(async () => desk.answer());
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(offered(desk.engine), "the in-flight answer predates the dismissal").toBe(true);

    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine)).toBe(false));
  });

  /** Two reads in the air: the answer asked for LAST owns the mirror, whatever order they land. */
  it("an older answer landing after a newer one does not bring the offer back", async () => {
    const acct = account();
    const desk = await device(acct, { showsOffer: true });
    let releaseSlow!: () => void;
    const stale = desk.answer(); // taken before the dismissal: not dismissed
    desk.answerWith(() => new Promise((r) => { releaseSlow = () => r(stale); }));
    const slow = desk.engine.refreshHeldReleases();

    desk.answerWith(async () => desk.answer());
    await desk.engine.dismissHeldRelease();
    expect(offered(desk.engine)).toBe(false);

    releaseSlow();
    await slow;
    expect(offered(desk.engine), "the older answer overwrote the dismissal").toBe(false);
  });
});
