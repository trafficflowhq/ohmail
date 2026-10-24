/**
 * ═══ A CANCEL AFTER THE SEND WENT SAYS SO, AND WHICH MESSAGE WENT ══════════════════════════
 * The flush confirmed the send, the composer is still locked, and the press finds nothing on the
 * queue — it used to close in silence. `gone` means one of two things and the ledger knows which.
 * Cases 7 to 9 are the resumed key in both branches: the answer lost on the way back (the earlier
 * message went) and the send that never left (this press's words went).
 * Mutations: `afterWithdraw` ignoring the verdict → 1, 4; its `gone` arm admitting any verdict
 * → 2; its `withdrawn` arm reading it → 3; the composer passing none → 5.
 */
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { flushQueued, liveActions, type LiveWorldActions } from "../src/state/live";
import { afterWithdraw, type SendVerdict } from "../src/ui/send-cancel";
import { Copy } from "../src/copy";
import type { World } from "../src/state/world";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSER = readFileSync(join(APP, "src/ui/MessageActions.tsx"), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

/** One phone, one loopback server, and a tunnel — the sibling suite's scene, without the door. */
async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  let offline = false;
  let loseAnswers = false;
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid,
    fetch: async (url, init) => {
      if (offline) throw new TypeError("Network request failed");
      const res = await fetch(url, init);
      // THE ANSWER LOST ON THE WAY BACK — the branch the whole field exists for. The server
      // handled the send and holds the reservation; this device was never told. A rejection
      // after the fact is exactly what a dropped connection mid-response looks like from here.
      if (loseAnswers && /^\/drafts\/[^/]+\/send$/.test(new URL(url).pathname)) {
        throw new TypeError("Network request failed");
      }
      return res;
    },
  };
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC",
  });
  return {
    fake, ...boot, actions, toasts,
    tunnel: (on: boolean) => { offline = on; },
    loseTheAnswer: (on: boolean) => { loseAnswers = on; },
  };
}

/** The draft bodies the server was handed, in the order it was handed them. */
const storedBodies = (fake: ReturnType<typeof mailServer>) =>
  fake.seen
    .filter((r) => r.method === "POST" && r.url === "/drafts")
    .map((r) => (JSON.parse(r.body) as { body?: string }).body ?? "");

describe("a cancel pressed after the send already went", () => {
  /** THE PAIR, PRODUCED BY THE MACHINE RATHER THAN BY HAND: the flush settles the key — what the
   *  world writes into the ledger `sendOutcome` reads — and the queue no longer holds it. */
  it("1 — the state is reachable, and the press is told the message went", async () => {
    const live = await scene();
    live.tunnel(true);
    const queued = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(queued.outcome).toBe("queued");

    live.tunnel(false);
    const settled = await flushQueued(live.engine, live.actions.releaseConfirmed);
    const verdict = settled.get(queued.key!)?.status;
    const answer = await live.actions.withdrawSend(queued.key!);

    expect(
      { ledger: verdict, withdrawal: answer, said: afterWithdraw(answer, verdict as SendVerdict) },
      "the press that came after the delivery was closed without a word",
    ).toEqual({ ledger: "confirmed", withdrawal: "gone", said: "already_sent" });
    live.store.close();
    live.fake.server.close();
  });

  it("2 — every other verdict for a gone key still closes", () => {
    const others: SendVerdict[] = ["pending", "rolled_back", "unverified", "unknown"];
    expect(others.map((v) => afterWithdraw("gone", v))).toEqual(others.map(() => "close"));
  });

  /**
   * THE PRESS THAT DID CANCEL MAY NOT SAY THE MESSAGE WENT. `withdrawn` means this press took the
   * send off the queue; a ledger entry from an earlier, different send under a stale key must not
   * turn that into "already sent" — the person would read a delivery they had just prevented.
   */
  it("3 — a withdrawal that cancelled something closes, whatever the ledger says", () => {
    expect(afterWithdraw("withdrawn", "confirmed")).toBe("close");
  });

  it("4 — a request already on the wire still says so, under every verdict", () => {
    const all: SendVerdict[] = ["pending", "confirmed", "rolled_back", "unverified", "unknown"];
    expect(all.map((v) => afterWithdraw("on_the_wire", v))).toEqual(all.map(() => "already_sent"));
  });

  /**
   * The default is the behaviour a caller that knows nothing gets, and the sibling suite drives
   * exactly that form — so a caller left un-updated is unchanged rather than newly wrong.
   */
  it("5 — a caller that supplies no verdict is where it was, and the sheet supplies one", () => {
    expect(afterWithdraw("gone")).toBe("close");
    expect(COMPOSER, "the sheet asks the engine and never the ledger").toContain(
      "withdraw: () => w.actions.withdrawSend(key), verdict: () => w.sendOutcome(key)",
    );
  });

  it("6 — the sheet's restated verdict IS the world's, assignable both ways or this will not compile", () => {
    // `src/ui` may not import the world (`privacy.test.ts` confines it), so the union is
    // restated there. Both directions: a verdict the world gained that the sheet cannot decide,
    // or one the sheet decides that never arrives.
    type WorldVerdict = ReturnType<World["sendOutcome"]>;
    const asWorld: (v: SendVerdict) => WorldVerdict = (v) => v;
    const asSheet: (v: WorldVerdict) => SendVerdict = (v) => v;
    expect(asWorld("confirmed")).toBe("confirmed");
    expect(asSheet("unknown")).toBe("unknown");
  });

  /**
   * ═══ MEASURED, AND IT IS WHY THE SERVER HAS TO SAY IT ══════════════════════════════════════
   * A resumed key is said to deliver the FIRST press's words. That holds only where the first
   * attempt REACHED the server. When it never left — the tunnel, which is the ordinary way a
   * send comes to be standing at all — there is no reservation and this press's own words go,
   * and that is the commoner branch. The two were one answer on the wire until `firstSend`, so
   * a confirmation claiming either version would have been false half the time.
   */
  it("7 — MEASUREMENT: a resumed key whose first attempt never left delivers the SECOND text", async () => {
    const live = await scene();
    live.tunnel(true);
    expect((await live.actions.sendReply("m-1", "FIRST VERSION", false, null)).outcome).toBe("queued");

    live.tunnel(false);
    const second = await live.actions.sendReply("m-1", "SECOND VERSION", false, null);
    await flushQueued(live.engine, live.actions.releaseConfirmed);

    expect(
      {
        outcome: second.outcome, went: storedBodies(live.fake)[0],
        delivered: live.fake.deliveries().length, said: live.toasts.at(-1),
      },
      "the resume delivered twice, delivered the first text, or was announced as an earlier message",
    ).toEqual({
      outcome: "sent", went: "SECOND VERSION", delivered: 1, said: Copy.replySent,
    });
    live.store.close();
    live.fake.server.close();
  });

  /**
   * THE BRANCH THE FIELD EXISTS FOR. Case 7 is the send that never left, where this press's own
   * words go. Here the first attempt reached the server and only its ANSWER was lost: the
   * reservation stands, this press is answered from it, and the first message is what went. The
   * two are one answer on the wire until the server names the replay.
   */
  it("8 — the first attempt DID land: the confirmation says the earlier message went", async () => {
    const live = await scene();
    live.loseTheAnswer(true);
    const first = await live.actions.sendReply("m-1", "FIRST VERSION", false, null);
    expect(first.outcome, "the lost answer did not park the send").toBe("queued");

    live.loseTheAnswer(false);
    const second = await live.actions.sendReply("m-1", "SECOND VERSION", false, null);

    expect(
      { outcome: second.outcome, said: live.toasts.at(-1), delivered: live.fake.deliveries().length },
      "the press that delivered nothing new was announced as though it had",
    ).toEqual({ outcome: "sent", said: Copy.replyEarlierWent, delivered: 1 });
    live.store.close();
    live.fake.server.close();
  });

  /** THE SAME WORDS ARE NOT A DIFFERENT MESSAGE — the ordinary retry, commoner than case 8. The
   *  server names the replay here too, so its field ALONE would say the wrong thing about it. */
  it("9 — a retry of the same words is an ordinary send, though the server names the replay", async () => {
    const live = await scene();
    live.loseTheAnswer(true);
    expect((await live.actions.sendReply("m-1", "the same words", false, null)).outcome).toBe("queued");

    live.loseTheAnswer(false);
    const again = await live.actions.sendReply("m-1", "the same words", false, null);

    expect(
      { outcome: again.outcome, said: live.toasts.at(-1) },
      "an unchanged retry was told its newer text had been held back",
    ).toEqual({ outcome: "sent", said: Copy.replySent });
    live.store.close();
    live.fake.server.close();
  });
});
