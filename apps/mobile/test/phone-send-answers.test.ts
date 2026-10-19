/**
 * WHAT A PHONE SEND SAYS, FOR EVERY ANSWER THE SEND ROUTE GIVES — through `bootEngine`'s real
 * HttpAdapter and engine, against a fake speaking the route's own wire. Rows
 * PHONE-SEND-UNREACHABLE-HAS-NO-OWN-SENTENCE and
 * PHONE-LATE-SEND-REFUSAL-BINDS-NO-DRAFT; the phone engine behind the same door is measured in
 * `apps/sidecar/test/phone-send-is-one-row.imap.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { queuedCaptionKey } from "../src/engine/send-waits";
import { answersWaiting, flushQueued, liveActions, reconnectFlushDue, refusedSendSay, type LiveWorldActions } from "../src/state/live";
import { failedSendLine } from "../src/ui/send-failed";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
/* @reads: apps/mobile/src/state/world.tsx, apps/mobile/src/ui/MessageActions.tsx */

const here = dirname(fileURLToPath(import.meta.url));
const WORLD = readFileSync(join(here, "../src/state/world.tsx"), "utf8");
const SHEET = readFileSync(join(here, "../src/ui/MessageActions.tsx"), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const peer = [{ name: null, address: "peer@fake.test" }];
const SEND = "/drafts/d-1/send";
const QUEUED_202 = { status: "queued", message: "This send was accepted and is still being handed to your mail server." };
const IN_FLIGHT = { status: "in_flight", message: "A send for this draft is already in progress." };
const UNREACHABLE_424 = { error: { code: "send_unreachable", message: "your mail server could not be reached", retryable: false } };
const NOT_SIGNED_IN_424 = { error: {
  code: "mailbox_not_signed_in", retryable: false,
  message: "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings",
} };

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  return { fake, ...boot, actions, toasts };
}

/** Once the engine holds an answer nobody collected — its own notification, never a clock. */
function lateAnswer(engine: Parameters<typeof answersWaiting>[0]): Promise<true> {
  return new Promise((resolve) => {
    if (answersWaiting(engine)) { resolve(true); return; }
    const off = engine.subscribe(() => { if (answersWaiting(engine)) { off(); resolve(true); } });
  });
}

describe("a send the server accepted says it is still sending, never that it waits", () => {
  it("202 then in_flight: queued, accepted, and the sentence is the web's accepted one", async () => {
    const live = await scene();
    live.fake.answerNext("POST", SEND, 202, QUEUED_202);
    live.fake.answerNext("POST", SEND, 409, IN_FLIGHT);
    const res = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(res).toMatchObject({ outcome: "queued", accepted: true });
    expect(live.toasts).toEqual([Copy.replySendingLong]);
    expect(Copy[queuedCaptionKey("online", res.accepted === true)]).toBe(Copy.replySendingLong);
    expect(Copy[queuedCaptionKey("offline", true)], "the server has it, whatever the network now says").toBe(Copy.replySendingLong);
  }, 30_000);

  it("a transport queue is not an acceptance: it says it has not gone yet", async () => {
    const live = await scene();
    live.fake.failNextStatus("POST", SEND, 500);
    live.fake.failNextStatus("POST", SEND, 500);
    const res = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(res.outcome).toBe("queued");
    expect(res.accepted).toBeUndefined();
    expect(live.toasts).toEqual([Copy.replyQueued]);
  }, 30_000);

  it("an acceptance a later flush reports reaches the ledger's accepted door", async () => {
    const live = await scene();
    live.fake.failNextStatus("POST", SEND, 500);
    live.fake.failNextStatus("POST", SEND, 500);
    const res = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(res.outcome).toBe("queued");
    live.fake.answerNext("POST", SEND, 202, QUEUED_202);
    const accepted: string[] = [];
    const settled = await flushQueued(live.engine, live.actions.releaseConfirmed, (key) => accepted.push(key));
    expect(accepted).toEqual([res.key]);
    expect(settled.has(res.key!), "an acceptance is not terminal").toBe(false);
  }, 30_000);

  it("the composer reads the acceptance off the result and off the ledger", () => {
    expect(SHEET).toContain("setAccepted(result.accepted === true);");
    expect(SHEET).toContain("Copy[queuedCaptionKey(network, accepted, rearmed)]");
    expect(SHEET).toContain("if (said.accepted) setAccepted(true);");
  });

  it("…and an offer again by the server, after which it promises nothing of the network", () => {
    expect(SHEET).toContain("setRearmed(result.rearmed === true);");
    expect(SHEET).toContain("if (said.rearmed) setRearmed(true);");
    expect(WORLD).toContain("settlements.current.set(key, { ...(settlements.current.get(key) ?? NO_SETTLEMENT), rearmed: true });");
  });
});

describe("a send the mail server could not be reached for says so, and keeps its row", () => {
  it("424 send_unreachable: failed, its own sentence, the row bound", async () => {
    const live = await scene();
    live.fake.answerNext("POST", SEND, 424, UNREACHABLE_424);
    const res = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(res).toMatchObject({ outcome: "failed", failure: "replyUnreachable", draftId: "d-1" });
    expect(live.toasts).toEqual([Copy.replyUnreachable]);
    expect(failedSendLine("replyUnreachable", null, true)).toBe(Copy.replyUnreachable);
    expect(failedSendLine("replyUnreachable", { kind: "lost" }, true)).toBe(Copy.composeNotSentOffline);
  }, 30_000);

  it("424 send_busy, past its retries: failed, its own sentence in both languages, the row bound", async () => {
    const live = await scene();
    live.fake.answerNext("POST", SEND, 424, { error: { code: "send_busy", message: "your mail server is busy", retryable: false } });
    const res = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(res).toMatchObject({ outcome: "failed", failure: "replyBusy", draftId: "d-1" });
    expect(live.toasts).toEqual([Copy.replyBusy]);
    expect(Copy.replyBusy).toMatch(/busy/);
    expect(DE.replyBusy).toMatch(/ausgelastet/);
  }, 30_000);
});

describe("a send from a mailbox that is not signed in here says so, and keeps its row", () => {
  it("424 mailbox_not_signed_in: failed, the file's sentence after the kept draft, the row bound", async () => {
    const live = await scene();
    live.fake.answerNext("POST", SEND, 424, NOT_SIGNED_IN_424);
    const res = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(res).toMatchObject({ outcome: "failed", failure: "replyNotSignedIn", draftId: "d-1" });
    expect(live.toasts).toEqual(["Not sent — your draft is kept. This mailbox isn't signed in here. Sign in again in Settings."]);
    expect(sayArg(refusedSendSay("replyNotSignedIn")), "the late-answer door says the same").toBe(live.toasts[0]);
    expect(failedSendLine("replyNotSignedIn", { kind: "lost" }, true), "offline does not hide the sign-in").toBe(live.toasts[0]);
    expect(DE.replyNotSignedIn).toBe("Nicht gesendet — dein Entwurf ist gesichert. Dieses Postfach ist hier nicht angemeldet. Melde es in den Einstellungen neu an.");
  }, 30_000);
});

describe("a refusal that arrives after the engine stopped waiting reaches the composer, with its row", () => {
  it("a 424 answered past the dispatch deadline is collected, named a refused send, and binds the row", async () => {
    const live = await scene();
    const release = live.fake.holdNext("POST", SEND);
    live.fake.answerNext("POST", SEND, 424, UNREACHABLE_424);
    const res = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(res.outcome, "the engine did not stop waiting at its deadline").toBe("queued");
    expect(live.engine.pendingMutations(), "the in-flight send is not on the queue").toHaveLength(0);
    release();
    expect(await lateAnswer(live.engine), "the late answer never arrived").toBe(true);
    expect(reconnectFlushDue([], new Set(), answersWaiting(live.engine)), "nothing pending, an answer waiting: a flush is owed").toBe(true);
    const settled = await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(settled.get(res.key!)).toMatchObject({
      status: "rolled_back", kind: "mail_send", failure: "replyUnreachable", draftId: "d-1",
    });
    expect(answersWaiting(live.engine)).toBe(false);
  }, 60_000);

  it("the world flushes on a waiting answer and the composer binds what the ledger names", () => {
    expect(WORLD).toContain("if (!reconnectFlushDue(pending.map((m) => m.key), tried.current, answersWaiting(engine))) return;");
    expect(WORLD).toContain("showToast(refusedSendSay(o.failure));");
    expect(SHEET).toContain("if (said.draftId !== null) setDraftId(said.draftId);");
    expect(SHEET).toContain("setFailNote(said.failure ?? \"replyFailed\");");
  });

  it("reconnectFlushDue: an answer waiting is owed; otherwise a pending key not yet tried", () => {
    expect(reconnectFlushDue([], new Set(), false)).toBe(false);
    expect(reconnectFlushDue([], new Set(), true)).toBe(true);
    expect(reconnectFlushDue(["k1"], new Set(["k1"]), false)).toBe(false);
    expect(reconnectFlushDue(["k1"], new Set(["k1"]), true)).toBe(true);
    expect(reconnectFlushDue(["k1", "k2"], new Set(["k1"]), false)).toBe(true);
  });

  it("another send's answer taken by a press's own flush is handed to the ledger's next flush", async () => {
    const live = await scene();
    // A: queued by two refusals, so it stands on the queue under its key.
    live.fake.failNextStatus("POST", SEND, 500);
    live.fake.failNextStatus("POST", SEND, 500);
    const a = await live.actions.sendNew("mb-1", peer, "First", "One.");
    expect(a.outcome).toBe("queued");
    // B: its first dispatch refused once, so its own flush replays A as well, and A goes.
    live.fake.failNextStatus("POST", "/drafts/d-2/send", 500);
    const b = await live.actions.sendNew("mb-1", peer, "Second", "Two.");
    expect(b.outcome).toBe("sent");
    expect(answersWaiting(live.engine), "A's answer was taken by B's flush and must still be owed").toBe(true);
    const settled = await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(settled.get(a.key!)).toMatchObject({ status: "confirmed", kind: "mail_send" });
  }, 60_000);
});
