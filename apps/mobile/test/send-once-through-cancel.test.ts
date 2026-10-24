/**
 * ═══ CANCEL CANCELS, AND ONE INTENT CARRIES ONE KEY ══════════════════════════════════════════
 *
 * The defect this file measures, in the person's own words: send while offline, read "Not sent
 * yet", press Cancel, write the reply again, send — and when the phone reconnects the
 * correspondent receives the message TWICE. The queued send's lifetime was tied to a component
 * that can be unmounted, and its Idempotency-Key was minted per composer rather than per intent,
 * so the second press was a second reservation and both went.
 *
 * Measured at the base commit through this app's own `bootEngine` composition: two
 * `POST /drafts/:id/send` requests under TWO keys.
 *
 * ── WHAT IS DRIVEN, AND WHY IT IS NOT A RENDER ───────────────────────────────────────────────
 *
 * There is no React Native renderer in this workspace (`test/fourth-door.test.ts` records it), so
 * the composer's decision lives in `src/ui/send-cancel.ts` and is driven directly; the sheet is
 * READ to prove those are the decisions it takes. Everything below the decision is real: the
 * engine, the durable outbox, the loopback mail server and its send reservation (a second send
 * under a key it already holds is answered from the first and dials nothing, exactly as
 * `outbound_sends` UNIQUE `(accountId, idempotencyKey)` does).
 *
 * ── HOW TO WATCH EACH ONE FAIL ───────────────────────────────────────────────────────────────
 *
 *  1. `cancelAct` answering `"close"` for Cancel send over a queued send → controls 1 and 3; answering
 *     `"withdraw"` for a plain close of the sheet → controls 6 and 10 (a send told it goes on the return never went).
 *  2. `withdrawQueued` without `this.withdrawnKeys.add(key)` → control 5.
 *  3. `withdrawQueued` without the queue removal → control 1.
 *  4. `dispatch` without the withdrawn read → control 5: a batch sends a row already withdrawn.
 *  5. `restoreOutbox` without the `withdrawn` skip → control 4: a relaunch re-queues a cancelled send.
 *  6. `dispatchSend` without the standing-key lookup → control 1b: a second press, a second key.
 *  7. `dispatchSend` joining a send the sheet left by its intent alone → controls 7 and 7b.
 *  8. `cancelSendPress` saying the cancellation over `gone`, or asking twice → controls 9 and 8.
 *  9. `dispatchSend` joining a send restored after a relaunch by its intent alone → control 7R.
 * 10. `keepAct` closing over the words of a send whose Cancel is owed → control 11.
 * 11. `cancelWaitingSend` keeping a rowless send's words only on `withdrawn`, or not reading the
 *     write-back's verdict → controls 12 and 12b.
 * Each was run, watched red by the assertion named beside it, and restored from a pristine copy
 * proved by `cmp`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { OUTBOX_TYPE, type EngineMutation, type WithdrawOutcome } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { queuedCaptionKey } from "../src/engine/send-waits";
import { installNetworkReader, networkNow, type NetworkReader } from "../src/net/network-door";
import { flushQueued, liveActions, liveDrafts, sendIntentOf, sendWireDiffers, type LiveWorldActions } from "../src/state/live";
import { keepAct } from "../src/ui/compose-keep";
import { openLetterKeeper } from "../src/compose/letter-keeper";
import { letterDoor } from "../src/compose/letter-store";
import {
  afterWithdraw, cancelAct, cancelledSay, cancelSendOffered, cancelSendPress, keptSay, type CloseRoad, type SendVerdict, type WithdrawAnswer,
} from "../src/ui/send-cancel";
import { Copy } from "../src/copy";
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

/**
 * One phone, one loopback server, and a transport this test owns: `tunnel(true)` is the phone
 * with no signal (a rejected fetch — `code: "network"`, retryable, and it spends none of the
 * outbox's give-up ceiling, which is what being in a tunnel really is), and `holdTheSend()`
 * stops the send request AT THE DOOR so a Cancel can be pressed while it is on the wire.
 */
async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  let offline = false;
  let holding = false;
  let atTheDoor!: () => void;
  const reachedTheDoor = new Promise<void>((r) => { atTheDoor = r; });
  let openTheDoor!: () => void;
  const doorOpened = new Promise<void>((r) => { openTheDoor = r; });
  /** Sends that reach the server and lose their answer on the way back. */
  let loseSendAnswers = 0;
  /** Held writes wait at the door until released. */
  let held: { path: (p: string) => boolean; reached: () => void; opened: Promise<void> } | null = null;
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid,
    fetch: async (url, init) => {
      if (offline) throw new TypeError("Network request failed");
      const path = new URL(url).pathname;
      if (holding && /^\/drafts\/[^/]+\/send$/.test(path)) {
        atTheDoor();
        await doorOpened;
      }
      const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      if (held !== null && method !== "GET" && held.path(path)) {
        held.reached();
        await held.opened;
      }
      const res = await fetch(url, init);
      if (loseSendAnswers > 0 && /^\/drafts\/[^/]+\/send$/.test(path)) {
        loseSendAnswers -= 1;
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
  const letters = letterDoor(boot.store);
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC", letters,
  });
  return {
    fake, origin, deps, ...boot, actions, toasts, letters,
    tunnel: (on: boolean) => { offline = on; },
    holdTheSend: () => { holding = true; return { reachedTheDoor, openTheDoor }; },
    loseSendAnswers: (n: number) => { loseSendAnswers = n; },
    /** Hold every write whose path matches at the door, until `open()`. */
    hold: (path: (p: string) => boolean) => {
      let reached!: () => void;
      const atDoor = new Promise<void>((r) => { reached = r; });
      let open!: () => void;
      const opened = new Promise<void>((r) => { open = r; });
      held = { path, reached, opened };
      return { atDoor, open: () => { held = null; open(); } };
    },
    /** What the sheet said as it closed, in order. */
    sheetSaid: [] as string[],
  };
}

/** Every `POST /drafts/:id/send` the server was asked to make, with the key it carried. */
const sendRequests = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(r.url));

/**
 * The composer's press, exactly as the sheet takes it: decide by the way out, leave or ask, then
 * say or close. `null` is a Cancel send pressed while the last one is still asked. `verdict` is the
 * world's ledger at the press, which this harness has no flush ledger for.
 */
async function pressCancel(
  live: Awaited<ReturnType<typeof scene>>,
  key: string | null,
  road: CloseRoad,
  alreadySent = false,
  o: { asking?: { current: boolean }; verdict?: SendVerdict } = {},
): Promise<"close" | "keepSend" | "already_sent" | "unknown" | null> {
  const act = cancelAct({ road, phase: "queued", key, alreadySent });
  if (act === "keepSend") live.actions.leaveSend(key!);
  if (act !== "withdraw") return act;
  const end = await cancelSendPress({
    asking: o.asking ?? { current: false }, withdraw: () => live.actions.withdrawSend(key!),
    verdict: () => o.verdict ?? "unknown", standalone: false, bound: false,
  });
  if (end?.say) live.sheetSaid.push(sayArg(end.say));
  return end === null ? null : end.said;
}

/** The app killed and launched again over the same device store (CONTROL 4's relaunch). */
async function relaunch(live: Awaited<ReturnType<typeof scene>>) {
  live.store.close();
  const again = await bootEngine(live.deps, { origin: live.origin, token: "tok-1", accountId: "acct-1" });
  if (again.kind !== "ready") throw new Error("boot refused");
  const actions = liveActions({ engine: again.engine, toast: (m) => live.toasts.push(sayArg(m)), uuid, zone: "UTC" });
  return { ...again, actions };
}

/** Airplane mode as the phone reads it: the network door says offline (the tunnel cuts the wire). */
function airplane(): { set(s: "online" | "offline"): void } {
  let state: "online" | "offline" = "offline";
  const listeners = new Set<(r: unknown) => void>();
  const reader: NetworkReader = { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } };
  installNetworkReader(reader);
  return { set(s) { state = s; for (const l of [...listeners]) l(s); } };
}
afterEach(() => { installNetworkReader(null); });

/** The server's rows that went, as `address|words`. */
const sentRows = (fake: ReturnType<typeof mailServer>) => fake.draftRows()
  .filter((d) => (d as { status?: string }).status === "sent")
  .map((d) => `${(d as { to?: Array<{ address: string }> }).to?.map((x) => x.address).join(",")}|${(d as { body?: string }).body}`)
  .sort();

describe("a message the person cancelled is never sent, and never sent twice", () => {
  it("CONTROL 1 — offline, Cancel, compose again, reconnect: ONE delivery under ONE key", async () => {
    const live = await scene();
    live.tunnel(true);

    const first = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(first.outcome).toBe("queued");
    expect(first.key).toBeTruthy();

    // THE PRESS, with no network: the attempt may have left (this phone shares no disk to claim on),
    // so the server's answer is owed and the sheet says it could not reach it — never "withdrawn".
    expect(await pressCancel(live, first.key ?? null, "cancelSend")).toBe("unknown");
    expect(live.engine.pendingMutations(), "the cancelled send is still on the queue").toHaveLength(0);

    // …and the person writes it again and sends.
    const second = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(second.outcome).toBe("queued");

    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);

    const out = sendRequests(live.fake);
    expect(
      { sends: out.length, keys: new Set(out.map((r) => r.key)).size, delivered: live.fake.deliveries().length },
      "the correspondent received it twice",
    ).toEqual({ sends: 1, keys: 1, delivered: 1 });
    // The one that went is the one the person actually composed second.
    expect(out[0]!.key).toBe(second.key ?? out[0]!.key);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 1b — the app was KILLED instead: the restored intent's key is resumed, not re-minted", async () => {
    const live = await scene();
    live.tunnel(true);
    const first = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(first.outcome).toBe("queued");

    /* NO CANCEL AND NO WITHDRAWAL — the composer died with the process, so the queued row is
       still there when the person opens the reply again. The only thing between this press and
       a second copy is that the send resumes the INTENT's key instead of minting a new one. */
    const second = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(second.outcome).toBe("queued");
    expect(
      new Set(live.engine.pendingMutations().map((p) => p.key)).size,
      "the second press minted a second reservation",
    ).toBe(1);

    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(live.fake.deliveries(), "one intent delivered twice").toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 2 — the positive: an ordinary send goes, and an uncancelled queued send goes once", async () => {
    const live = await scene();
    // Online, nothing queued, nothing cancelled: the ordinary press.
    expect((await live.actions.sendReply("m-1", "straight out", false, null)).outcome).toBe("sent");
    expect(live.fake.deliveries()).toHaveLength(1);

    // And a send the person did NOT cancel still leaves on the reconnect — the fix may not
    // swallow the queue it is there to make cancellable.
    live.tunnel(true);
    expect((await live.actions.sendReply("m-1", "the one after", false, null)).outcome).toBe("queued");
    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(live.fake.deliveries(), "an uncancelled queued send was swallowed").toHaveLength(2);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 3 — Cancel after the wire took it says so, withdraws nothing, and it lands once", async () => {
    const live = await scene();
    live.tunnel(true);
    const queued = await live.actions.sendReply("m-1", "too late for this", false, null);
    expect(queued.outcome).toBe("queued");

    // The reconnect flush picks it up and the send request is held AT THE DOOR: on the wire,
    // unanswered — the one moment at which a cancellation is a promise nobody can keep.
    const door = live.holdTheSend();
    live.tunnel(false);
    const flushing = flushQueued(live.engine, live.actions.releaseConfirmed);
    await door.reachedTheDoor;

    expect(await pressCancel(live, queued.key ?? null, "cancelSend")).toBe("already_sent");

    door.openTheDoor();
    await flushing;
    expect(live.fake.deliveries(), "the message the composer said was sent did not go").toHaveLength(1);
    expect(sendRequests(live.fake)).toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 6 — offline, Back, reconnect: the send the sheet promised goes ONCE under its first key", async () => {
    const live = await scene();
    live.tunnel(true);
    const first = await live.actions.sendReply("m-1", "goes when the signal is back", false, null);
    expect(first.outcome).toBe("queued");

    // Back over the waiting send: the sheet goes, the send stays.
    expect(await pressCancel(live, first.key ?? null, "close")).toBe("keepSend");
    expect(live.engine.pendingMutations().map((p) => p.key), "the close took the send off the queue").toEqual([first.key]);

    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(live.fake.deliveries(), "a send told it goes on the return never went").toEqual([first.key]);
    expect(live.fake.withdrawnKeys(), "the close asked a withdraw").toEqual([]);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 7 — offline, forward to Alice, Back, forward to Bob, reconnect: each forward goes, to its own", async () => {
    const live = await scene();
    live.tunnel(true);
    const a = await live.actions.sendForward("m-1", [{ name: "Alice", address: "alice@fake.test" }], "Alice, see below.", null);
    expect(await pressCancel(live, a.key ?? null, "close")).toBe("keepSend");
    const b = await live.actions.sendForward("m-1", [{ name: "Bob", address: "bob@fake.test" }], "Bob, see below.", null);
    expect([a.outcome, b.outcome]).toEqual(["queued", "queued"]);
    expect(b.key, "the second forward retired the one the sheet left waiting").not.toBe(a.key);

    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(new Set(live.fake.deliveries())).toEqual(new Set([a.key, b.key]));
    const sentTo = live.fake.draftRows().filter((d) => (d as { status?: string }).status === "sent")
      .map((d) => (d as { to?: Array<{ address: string }> }).to?.map((x) => x.address).join(",")).sort();
    expect(sentTo).toEqual(["alice@fake.test", "bob@fake.test"]);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 7b — a reply left waiting, then a reply with other words: both go; the same words again join it", async () => {
    const live = await scene();
    live.tunnel(true);
    const first = await live.actions.sendReply("m-1", "The contract is below.", false, null);
    expect(await pressCancel(live, first.key ?? null, "close")).toBe("keepSend");
    const again = await live.actions.sendReply("m-1", "The contract is below.", false, null);
    expect(again.key, "the same words pressed again are the send that waits").toBe(first.key);
    const other = await live.actions.sendReply("m-1", "And can we talk at ten?", false, null);
    expect(other.key).not.toBe(first.key);

    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(new Set(live.fake.deliveries())).toEqual(new Set([first.key, other.key]));
    const bodies = live.fake.draftRows().filter((d) => (d as { status?: string }).status === "sent")
      .map((d) => String((d as { body?: string }).body)).sort();
    expect(bodies).toEqual(["And can we talk at ten?", "The contract is below."]);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 7R — a forward left waiting outlives a relaunch: the same one again joins it, one to Bob is its own", async () => {
    const live = await scene();
    live.tunnel(true);
    const alice = [{ name: "Alice", address: "alice@fake.test" }];
    const a = await live.actions.sendForward("m-1", alice, "Alice, see below.", null);
    expect(await pressCancel(live, a.key ?? null, "close")).toBe("keepSend");
    // Killed and launched again, still with no network: the left mark lived in the dead session.
    const again = await relaunch(live);
    const same = await again.actions.sendForward("m-1", alice, "Alice, see below.", null);
    expect(same.key, "the same forward pressed after the relaunch was a second message").toBe(a.key);
    const b = await again.actions.sendForward("m-1", [{ name: "Bob", address: "bob@fake.test" }], "Bob, see below.", null);
    expect(b.key, "after the relaunch the forward to Bob retired the one to Alice").not.toBe(a.key);

    live.tunnel(false);
    await again.verifyIdentity();
    await again.engine.start();
    await flushQueued(again.engine, again.actions.releaseConfirmed);
    expect(sentRows(live.fake)).toEqual(["alice@fake.test|Alice, see below.", "bob@fake.test|Bob, see below."]);
    expect(live.fake.deliveries()).toHaveLength(2);
    again.store.close();
    live.fake.server.close();
  });

  it("CONTROL 8 — Cancel send pressed twice while the server is asked: the second press says nothing, the first says it went", async () => {
    const live = await scene();
    // The send reaches the server and both its answers are lost: the sheet says it is still trying.
    live.loseSendAnswers(2);
    const queued = await live.actions.sendReply("m-1", "this one went", false, null);
    expect(queued.outcome).toBe("queued");
    expect(live.fake.deliveries()).toHaveLength(1);

    const door = live.hold((p) => p === "/sends/withdraw");
    const asking = { current: false };
    const first = pressCancel(live, queued.key ?? null, "cancelSend", false, { asking });
    await door.atDoor;
    expect(await pressCancel(live, queued.key ?? null, "cancelSend", false, { asking }), "the second press was asked").toBeNull();
    door.open();
    expect(await first).toBe("already_sent");
    expect(live.sheetSaid, "a press told the person nothing was sent").toEqual([]);
    expect(live.fake.deliveries()).toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 9 — Cancel send after the flush delivered it, before the ledger heard: no cancellation is said", async () => {
    const live = await scene();
    live.tunnel(true);
    const queued = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(queued.outcome).toBe("queued");
    void live.actions.pileToggle("m-1", "replyLater");
    await new Promise((r) => setTimeout(r, 50));
    // The flush delivers the reply, then waits on the verb behind it: the world has not heard yet.
    const door = live.hold((p) => !p.startsWith("/drafts"));
    live.tunnel(false);
    const flushing = flushQueued(live.engine, live.actions.releaseConfirmed);
    await door.atDoor;
    expect(live.fake.deliveries()).toEqual([queued.key]);
    expect(await pressCancel(live, queued.key ?? null, "cancelSend")).toBe("close");
    expect(live.sheetSaid, "a delivered reply was told nothing was sent").toEqual([]);
    door.open();
    await flushing;
    live.store.close();
    live.fake.server.close();
  });

  /* Measured on 0.30.0 with a phone paired to Cloud: airplane mode, Send, Back, and the letter was
     neither sent nor in Drafts. The paired door, with the network door reading offline. */
  for (const relaunched of [false, true]) {
    it(`CONTROL 10 — no network, Send, Back${relaunched ? ", a relaunch" : ""}, the network back: it goes once and is in Sent`, async () => {
      const live = await scene();
      const net = airplane();
      live.tunnel(true);
      const first = await live.actions.sendReply("m-1", "Sent from a plane.", false, null);
      expect(first.outcome).toBe("queued");
      expect(live.toasts).toEqual([Copy.replyQueuedOffline]);
      expect(await pressCancel(live, first.key ?? null, "close")).toBe("keepSend");
      expect(sayArg(keptSay(queuedCaptionKey(networkNow()))), "the close did not repeat the caption").toBe(Copy.replyQueuedOffline);

      const phone = relaunched ? await relaunch(live) : live;
      expect(phone.engine.pendingMutations().map((p) => p.key), "the closed sheet's send left the queue").toEqual([first.key]);
      live.tunnel(false);
      net.set("online");
      if (relaunched) {
        await phone.verifyIdentity();
        await phone.engine.start();
      }
      const settled = await flushQueued(phone.engine, phone.actions.releaseConfirmed);
      expect(settled.get(first.key!)?.status).toBe("confirmed");
      expect(live.fake.deliveries(), "not exactly one delivery under the first key").toEqual([first.key]);
      expect(live.fake.withdrawnKeys(), "the close asked a withdraw").toEqual([]);
      expect(sentRows(live.fake)).toEqual(["ada@fake.test|Sent from a plane."]);
      expect(live.fake.draftRows(), "a draft was left beside the sent letter").toHaveLength(1);
      await flushQueued(phone.engine, phone.actions.releaseConfirmed);
      expect(sendRequests(live.fake)).toHaveLength(1);
      phone.store.close();
      live.fake.server.close();
    });
  }

  it("CONTROL 11 — Cancel send with no network, then Back: nothing goes, and the words reach Drafts", async () => {
    const live = await scene();
    const net = airplane();
    live.tunnel(true);
    const words = "Second thoughts.";
    const first = await live.actions.sendReply("m-1", words, false, null);
    expect(first.outcome).toBe("queued");
    // The server cannot be asked, so the Cancel is owed and the sheet says so.
    expect(await pressCancel(live, first.key ?? null, "cancelSend")).toBe("unknown");
    // Back, as the sheet takes it: no row on this door holds the words, so the close keeps them.
    expect(cancelAct({ road: "close", phase: "queued", key: first.key ?? null, alreadySent: false, cancelOwed: true })).toBe("close");
    if (keepAct({ phase: "queued", worth: true, filesOver: 0, armed: false, cancelOwed: true }) === "keep") {
      expect(await live.actions.draftKeep({
        mode: "reply", messageId: "m-1", mailboxId: null, to: [], subject: "", body: words, files: 0, draftId: null,
      })).toBe("kept");
    }

    live.tunnel(false);
    net.set("online");
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(live.fake.deliveries(), "a cancelled send went").toEqual([]);
    expect(live.fake.withdrawnKeys()).toEqual([first.key]);
    const drafts = live.fake.draftRows().map((d) => [(d as { status?: string }).status ?? "draft", (d as { body?: string }).body]);
    expect(drafts, "the cancelled letter was neither sent nor in Drafts").toEqual([["draft", words]]);
    expect(live.toasts.at(-1)).toBe(Copy.composeKeptQueued);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 12 — a refused send leaves its files with the row it left; Cancel send of a letter no row holds drops them", async () => {
    const live = await scene();
    const words = { mode: "reply" as const, messageId: "m-1", mailboxId: "mb-1", to: "", cc: "", bcc: "", subject: "", envelope: null };
    const file = { filename: "plan.pdf", contentType: "application/pdf", contentBase64: Buffer.alloc(32, 5).toString("base64") };
    const letter = openLetterKeeper({ door: live.letters, id: uuid(), newFileId: uuid, words: { ...words, body: "See the plan." } });
    letter.addFile({ ...file, sizeBytes: 32 });
    live.fake.answerNext("POST", "/drafts/d-1/send", 422, { error: { code: "message_rejected", message: "rejected by test", retryable: false } });
    letter.markSend();
    const refused = await live.actions.sendReply("m-1", "See the plan.", false, null, null, [file]);
    letter.sendAnswered(refused);
    expect(refused).toMatchObject({ outcome: "failed", draftId: "d-1" });
    expect(live.letters.filesOf("d-1").map((f) => f.filename), "the refusal dropped the files").toEqual(["plan.pdf"]);
    expect(live.letters.letterOf("d-1")?.send ?? null).toBeNull();

    airplane();
    live.tunnel(true);
    const other = openLetterKeeper({ door: live.letters, id: uuid(), newFileId: uuid, words: { ...words, body: "Never mind." } });
    other.addFile({ ...file, sizeBytes: 32 });
    other.markSend();
    const queued = await live.actions.sendReply("m-1", "Never mind.", false, null, null, [file]);
    other.sendAnswered(queued);
    expect(queued.outcome).toBe("queued");
    // The signal back before the press: the server is asked and answers it withdrawn.
    live.tunnel(false);
    expect(await pressCancel(live, queued.key ?? null, "cancelSend")).toBe("close");
    other.cancelled(null);
    expect(live.letters.letters().map((l) => l.body), "the cancelled letter outlived Nothing was sent").toEqual(["See the plan."]);
    live.store.close();
    live.fake.server.close();
  });

  for (const kind of ["reply", "new"] as const) {
    it(`CONTROL 12 (${kind}) — Cancel send from Drafts with no network: nothing goes, and the words stay a draft`, async () => {
      const live = await scene();
      const net = airplane();
      live.tunnel(true);
      const words = "Second thoughts from Drafts.";
      const first = kind === "reply"
        ? await live.actions.sendReply("m-1", words, false, null)
        : await live.actions.sendNew("mb-1", [{ name: "Bo", address: "bo@fake.test" }], "Offline subject", words);
      expect(live.engine.waitingSends().map((w) => w.draftId)).toEqual([null]);
      expect(await live.actions.cancelWaitingSend(first.key!)).toEqual({ said: "unknown", kept: "kept" });
      const listed = liveDrafts(live.engine.read(), { now: new Date(), zone: "UTC", locale: "en" } as never, live.engine.waitingSends());
      expect(listed.map((d) => d.body), "the words left Drafts").toEqual([words]);
      live.tunnel(false);
      net.set("online");
      await flushQueued(live.engine, live.actions.releaseConfirmed);
      expect(live.fake.deliveries(), "a cancelled send went").toEqual([]);
      const drafts = live.fake.draftRows().map((d) => [(d as { status?: string }).status ?? "draft", (d as { body?: string }).body]);
      expect(drafts, "Cancel send from Drafts lost the words").toEqual([["draft", words]]);
      live.store.close();
      live.fake.server.close();
    }, 60_000);
  }

  it("CONTROL 12b — a withdrawn Cancel send whose write-back is refused says the words were not kept", async () => {
    const live = await scene();
    const net = airplane();
    live.tunnel(true);
    const first = await live.actions.sendReply("m-1", "Words to keep.", false, null);
    live.tunnel(false);
    net.set("online");
    live.fake.answerNext("POST", "/drafts", 422, { error: { code: "invalid_request", message: "refused" } });
    expect(await live.actions.cancelWaitingSend(first.key!)).toEqual({ said: "withdrawn", kept: "notKept" });
    expect(live.toasts.at(-1)).toBe(Copy.sendCancelledNotKept);
    expect(live.toasts).not.toContain(Copy.sendCancelledInDrafts);
    expect(live.fake.deliveries()).toEqual([]);
    live.store.close();
    live.fake.server.close();
  }, 60_000);

  it("CONTROL 5 — a row waiting in the flush's batch is withdrawn and never sent", async () => {
    const live = await scene();
    live.tunnel(true);
    // TWO intents on the queue: a reply and a forward of the same message. The flush takes each
    // entry off the queue only at its own turn (`takeTurn`), so while the first is on the wire the
    // second is still queued and Cancel withdraws it there. The read on the line before the wire
    // is watched by `repress-one-delivery.test.ts` (a fresh press waiting its gate turn).
    const reply = await live.actions.sendReply("m-1", "the one that goes", false, null);
    const fwd = await live.actions.sendForward("m-1", [{ name: "Bo", address: "bo@fake.test" }], "and this one", null);
    expect([reply.outcome, fwd.outcome]).toEqual(["queued", "queued"]);
    expect(live.engine.pendingMutations()).toHaveLength(2);

    const door = live.holdTheSend();
    live.tunnel(false);
    const flushing = flushQueued(live.engine, live.actions.releaseConfirmed);
    await door.reachedTheDoor;

    // The batch tail is still a queued verb, and the press withdraws it.
    expect(live.engine.pendingMutations().map((p) => p.key)).toEqual([fwd.key]);
    expect(await live.actions.withdrawSend(fwd.key!)).toBe("withdrawn");

    door.openTheDoor();
    await flushing;
    expect(
      live.fake.deliveries(),
      "the withdrawn intent was sent anyway, from inside a batch",
    ).toEqual([reply.key]);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 4 — a withdrawn row survives a restart as withdrawn, and no boot sends it", async () => {
    const live = await scene();
    live.tunnel(true);
    const queued = await live.actions.sendReply("m-1", "cancelled before the signal came back", false, null);
    expect(queued.outcome).toBe("queued");
    // No network: the server cannot be asked about an attempt that may have left, so the Cancel is owed.
    expect(await live.actions.withdrawSend(queued.key!)).toBe("unknown");

    // THE MARK IS ON DISK, on the row itself — not a memory flag that dies with the process — with its debt.
    const rows = live.store.entries<{ key?: string; withdrawn?: boolean; withdrawOwed?: boolean }>(OUTBOX_TYPE)
      .filter((e) => e.entity.key === queued.key);
    expect(rows, "the withdrawal wrote nothing durable").toHaveLength(1);
    expect([rows[0]!.entity.withdrawn, rows[0]!.entity.withdrawOwed]).toEqual([true, true]);

    // THE RELAUNCH. Same store, same account: the row is read back as withdrawn and dropped
    // rather than queued, so the boot that follows a cancel has nothing to deliver.
    live.store.close();
    // The signal is back on the relaunch — a restart that stayed offline would prove nothing
    // about whether a boot with a wire would have sent it.
    live.tunnel(false);
    const again = await bootEngine(live.deps, { origin: live.origin, token: "tok-1", accountId: "acct-1" });
    if (again.kind !== "ready") throw new Error("boot refused");
    expect(
      again.engine.pendingMutations().filter((p) => p.key === queued.key),
      "the relaunch re-queued a send the person cancelled",
    ).toHaveLength(0);
    await again.verifyIdentity();
    await again.engine.start();
    await flushQueued(again.engine, liveActions({ engine: again.engine, toast: () => undefined, zone: "UTC" }).releaseConfirmed);
    expect(live.fake.deliveries(), "a cancelled send was delivered by a later boot").toHaveLength(0);
    expect(sendRequests(live.fake)).toHaveLength(0);
    // The relaunch asked the withdraw the last session owed, and the server tombstoned the key.
    expect(live.fake.withdrawnKeys()).toEqual([queued.key]);
    again.store.close();
    live.fake.server.close();
  });
});

describe("the intent, and the decisions the composer takes", () => {
  it("one intent per message and per verb — a reply and a forward of one message are not the same send", () => {
    expect(sendIntentOf({ kind: "mail_send", inReplyTo: "m-1", body: "x" } as never)).toBe("reply:m-1");
    expect(sendIntentOf({ kind: "mail_send", inReplyTo: null, forwardOf: "m-1", body: "x" } as never)).toBe("fwd:m-1");
    // A send this app cannot name that way mints a fresh key rather than guessing a shared one.
    expect(sendIntentOf({ kind: "mail_send", inReplyTo: null, body: "x" } as never)).toBeNull();
    // Not every verb is a send.
    expect(sendIntentOf({ kind: "mark_seen", messageIds: ["m-1"], unread: false } as never)).toBeNull();
  });

  it("a press that adds or drops a file, or sets a time, carries something the waiting send does not", () => {
    const press = { kind: "mail_send", inReplyTo: "m-1", body: "See attached." } as EngineMutation;
    // The waiting one went through the engine's enrichment; the press did not.
    const waiting = { ...press, to: [{ name: "Ada", address: "ada@fake.test" }], subject: "Re: Invoice 12" } as EngineMutation;
    const file = { filename: "contract.pdf", contentType: "application/pdf", contentBase64: "JVBERi0xLjQK" };
    expect(sendWireDiffers(waiting, press), "an unaltered press read as another message").toBe(false);
    expect(sendWireDiffers(waiting, { ...press, attachments: [file] } as EngineMutation)).toBe(true);
    expect(sendWireDiffers({ ...waiting, attachments: [file] } as EngineMutation, press)).toBe(true);
    expect(sendWireDiffers({ ...waiting, attachments: [file] } as EngineMutation, { ...press, attachments: [{ ...file }] } as EngineMutation)).toBe(false);
    expect(sendWireDiffers(waiting, { ...press, sendAt: "2030-01-02T09:00:00Z" } as EngineMutation)).toBe(true);
    expect(sendWireDiffers(waiting, { ...press, body: "Other words." } as EngineMutation)).toBe(true);
  });

  it("a close keeps a queued send, only Cancel send withdraws it, and every other close is just a close", () => {
    const queued = { phase: "queued", key: "k-1", alreadySent: false } as const;
    expect(cancelAct({ road: "close", ...queued })).toBe("keepSend");
    expect(cancelAct({ road: "cancelSend", ...queued })).toBe("withdraw");
    // After a Cancel the server could not answer: the sentence was said, a close only dismisses.
    expect(cancelAct({ road: "close", ...queued, cancelOwed: true })).toBe("close");
    expect(cancelAct({ road: "cancelSend", ...queued, cancelOwed: true })).toBe("withdraw");
    for (const road of ["close", "cancelSend"] as const) {
      // The second press, after "too late" was read.
      expect(cancelAct({ road, ...queued, alreadySent: true })).toBe("close");
      // No key, nothing to name.
      expect(cancelAct({ road, ...queued, key: null })).toBe("close");
      expect(cancelAct({ road, phase: "idle", key: null, alreadySent: false })).toBe("close");
      expect(cancelAct({ road, phase: "sending", key: "k-1", alreadySent: false })).toBe("close");
      // Unverified: the server could not say whether it left, and "cancelled" is not a claim this device can make.
      expect(cancelAct({ road, phase: "unverified", key: "k-1", alreadySent: false })).toBe("close");
    }
    expect(cancelSendOffered(queued)).toBe(true);
    expect(cancelSendOffered({ ...queued, alreadySent: true })).toBe(false);
    expect(cancelSendOffered({ phase: "unverified", key: "k-1", alreadySent: false })).toBe(false);
    expect(cancelSendOffered({ phase: "idle", key: null, alreadySent: false })).toBe(false);
    // Drafts is named only where a row is known to hold the words.
    expect(sayArg(cancelledSay({ standalone: true, bound: false }))).toBe(Copy.sendCancelledInDrafts);
    expect(sayArg(cancelledSay({ standalone: false, bound: true }))).toBe(Copy.sendCancelledInDrafts);
    expect(sayArg(cancelledSay({ standalone: false, bound: false }))).toBe(Copy.sendCancelled);
    // A close over a waiting send says the sheet's own caption again.
    for (const k of ["replyQueuedOffline", "replyQueued", "replySendingLong"] as const) expect(sayArg(keptSay(k))).toBe(Copy[k]);
  });

  it("the sheet's restated answers ARE the engine's — assignable both ways, or this will not compile", () => {
    // `src/ui` may not import the engine package (`privacy.test.ts` confines it), so the union is
    // restated there. Both directions, because either one alone admits a drift: a member the
    // engine gained that the sheet cannot decide, or one the sheet decides that never arrives.
    const asEngine: (a: WithdrawAnswer) => WithdrawOutcome = (a) => a;
    const asSheet: (a: WithdrawOutcome) => WithdrawAnswer = (a) => a;
    expect(asEngine("on_the_wire")).toBe("on_the_wire");
    expect(asSheet("withdrawn")).toBe("withdrawn");
  });

  it("only the on-the-wire answer keeps the composer open with a sentence", () => {
    expect(afterWithdraw("withdrawn")).toBe("close");
    expect(afterWithdraw("gone")).toBe("close");
    expect(afterWithdraw("on_the_wire")).toBe("already_sent");
    // Nothing cancelled: on the phone, the server not answering for a send that may have left.
    expect(afterWithdraw("unknown")).toBe("unknown");
  });

  it("THE WIRING — the sheet takes these decisions on every road out, and renders the sentence", () => {
    expect(COMPOSER).toContain('from "./send-cancel"');
    // Every close goes through the one function that decides: the button, the scrim behind
    // the sheet, and the platform back gesture. A bare `onClose` on any of the three is a
    // way out nothing decides.
    expect(COMPOSER).toContain("onRequestClose={closeComposer}");
    expect(COMPOSER.match(/onPress=\{closeComposer\}/g) ?? [], "a close that does not withdraw").toHaveLength(2);
    expect(COMPOSER).toContain('cancelAct({ road: "close", phase, key: queuedKey, alreadySent, cancelOwed: cancelUnreachable })');
    // The verdict rides beside the answer since `send-cancel-says-it-went.test.ts`: a `gone`
    // key that the flush CONFIRMED says the message went rather than closing in silence.
    expect(COMPOSER).toContain("withdraw: () => w.actions.withdrawSend(key), verdict: () => w.sendOutcome(key)");
    // And the refused cancel is SAID, in place, rather than looking like a broken button.
    expect(COMPOSER).toContain("Copy.replyAlreadySent");
    expect(Copy.replyAlreadySent).toContain("Too late to cancel");
    // On its way covers a delivered send AND one still being handed over: never "has been sent".
    expect(Copy.replyAlreadySent).toContain("already on its way");
    // The Cancel the server could not answer is said too, never a silent press.
    expect(COMPOSER).toContain("else setCancelUnreachable(true)");
    expect(COMPOSER).toContain("Copy.replyCancelUnreachable");
    expect(Copy.replyCancelUnreachable).toContain("Couldn't reach the server to cancel");
  });
});
