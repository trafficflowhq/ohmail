/* @reads: apps/mobile/src/ui/MessageActions.tsx apps/mobile/src/net/pairing.ts */
/**
 * A SEND PRESSED WITH NO NETWORK WAITS, ONCE, AND GOES WHEN THE NETWORK IS BACK.
 *
 * The standalone door through this app's own `bootEngine` composition, over a local door that
 * answers as the engine does when it cannot reach the mail server (`409 {status: "failed"}`).
 * Measured on the base: every offline press reached the engine, failed, and left a draft row; a
 * press again was a new key and another row. The network is the door's (`net/network-door.ts`),
 * driven by a reader this file owns. The composer is read, not rendered (`fourth-door.test.ts`).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootEngine, LOCAL_ENGINE_ORIGIN, type LocalEngineDoor, type MobileEngineDeps } from "../src/engine/boot";
import { queuedCaptionKey, sendWaitsForNetwork } from "../src/engine/send-waits";
import { installNetworkReader, networkNow, type NetworkReader } from "../src/net/network-door";
import { answersWaiting, confirmedSendSay, flushQueued, liveActions, liveDrafts } from "../src/state/live";
import { cancelAct, cancelSendPress, keptSay, type CloseRoad, type SendVerdict } from "../src/ui/send-cancel";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSER = readFileSync(join(APP, "src/ui/MessageActions.tsx"), "utf8");
const PAIRING = readFileSync(join(APP, "src/net/pairing.ts"), "utf8");
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

afterEach(() => { installNetworkReader(null); });

/** The platform's reader, turned by hand. */
function networkSwitch(start: "online" | "offline"): { reader: NetworkReader; set(s: "online" | "offline"): void } {
  let state = start;
  const listeners = new Set<(r: unknown) => void>();
  return {
    reader: { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    set(s) { state = s; for (const l of [...listeners]) l(s); },
  };
}

/** One standalone phone: the loopback server stands in for the engine behind the local door. */
async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  const net = networkSwitch("online");
  installNetworkReader(net.reader);
  /** The engine's own answers to a draft's next sends, in order, before the fake answers any. */
  const sendAnswers = new Map<string, Array<() => Response>>();
  /** While set, a send step that reached the engine waits here: the request is on the wire. */
  const slow: { gate: Promise<void> | null } = { gate: null };
  const door: LocalEngineDoor = {
    sessionToken: "launch-1",
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(url.pathname) && slow.gate) await slow.gate;
      const scripted = req.method === "POST" ? sendAnswers.get(/^\/drafts\/([^/]+)\/send$/.exec(url.pathname)?.[1] ?? "")?.shift() : undefined;
      if (scripted) {
        await req.text();
        return scripted();
      }
      // THE ENGINE WITH NO NETWORK: the send cannot reach the mail server and is refused as failed.
      if (networkNow() === "offline" && req.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(url.pathname)) {
        await req.text();
        return new Response(JSON.stringify({ status: "failed", message: "the mail server could not be reached" }), {
          status: 409, headers: { "content-type": "application/json" },
        });
      }
      const body = req.method === "GET" ? undefined : await req.text();
      return fetch(`${origin}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    },
  };
  /* A mirror of its own: the outbox is durable, and a shared one would restore the last case's send. */
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid,
    fetch: async () => { throw new Error("the global transport was used on the standalone door"); },
  };
  const config = { origin: LOCAL_ENGINE_ORIGIN, accountId: "acct-1", localEngine: door, network: networkNow } as const;
  const toasts: string[] = [];
  const launch = async () => {
    const boot = await bootEngine(deps, config);
    if (boot.kind !== "ready") throw new Error("boot refused");
    await boot.engine.start();
    const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
    return { engine: boot.engine, store: boot.store, actions };
  };
  const first = await launch();
  /** The app killed and launched again over the same device store. */
  const relaunch = async () => {
    first.store.close();
    return launch();
  };
  return { fake, net, ...first, toasts, sendAnswers, relaunch, slow };
}

/** The send route's re-arm: a passing refusal of the mail server, offered again after the wait it names. */
const offeredAgain = (): Response => new Response(JSON.stringify({ error: {
  code: "send_unreachable", message: "your mail server could not be reached", retryable: true, details: { retryAfter: 2 },
} }), { status: 424, headers: { "content-type": "application/json", "retry-after": "2" } });
/** The same re-arm over our own per-mailbox IMAP cap: a forward's read found both of the mailbox's slots in use. */
const capOfferedAgain = (): Response => new Response(JSON.stringify({ error: {
  code: "mailbox_busy", message: "this mailbox already has as many live connections as we will open at once", retryable: true,
  details: { retryAfter: 2 },
} }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
/** A fault of the server's own, retryable: the press flushes the whole queue under its keys. */
const serverFault = (): Response => new Response(JSON.stringify({ error: { code: "server_error", message: "refused by test" } }),
  { status: 500, headers: { "content-type": "application/json" } });

const drafted = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.method === "POST" && r.url === "/drafts");
const sendsOf = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(r.url));
const TO = [{ name: "Bo", address: "bo@fake.test" }];

/** The sheet's way out over a waiting send, as it takes it: decide, then say the sentence it leaves with. */
async function wayOut(
  s: Awaited<ReturnType<typeof scene>>, res: { key?: string; accepted?: boolean; rearmed?: boolean }, road: CloseRoad,
  verdict: SendVerdict = "unknown",
): Promise<string | null> {
  const act = cancelAct({ road, phase: "queued", key: res.key ?? null, alreadySent: false });
  if (act === "keepSend") {
    s.actions.leaveSend(res.key!);
    return sayArg(keptSay(queuedCaptionKey(networkNow(), res.accepted === true, res.rearmed === true)));
  }
  if (act === "close") return null;
  const end = await cancelSendPress({
    asking: { current: false }, withdraw: () => s.actions.withdrawSend(res.key!), verdict: () => verdict, standalone: true, bound: false,
  });
  return end === null ? null : end.say !== null ? sayArg(end.say) : end.said;
}

describe("a send pressed with no network", () => {
  it("waits in the outbox under one key, reaches nothing, and says it goes when the network is back", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Offline", "Written on a train.");
    expect(res.outcome, "the press did not wait for the network").toBe("queued");
    expect(res.key, "a waiting send carries the key the composer follows").toBeTruthy();
    const pending = s.engine.pendingMutations();
    expect(pending.map((p) => p.mutation.kind)).toEqual(["mail_send"]);
    expect(pending[0]!.key).toBe(res.key);
    expect(drafted(s.fake), "the words were not kept in one draft").toHaveLength(1);
    expect(sendsOf(s.fake), "the send step reached the engine with no network").toHaveLength(0);
    expect(s.toasts).toContain(Copy.replyQueuedOffline);
    s.store.close();
  }, 60_000);

  it("pressed again, it stays one key and one draft, and goes once", async () => {
    const s = await scene();
    s.net.set("offline");
    for (let i = 0; i < 3; i++) await s.actions.sendReply("m-1", "The same reply.", false);
    const keys = new Set(s.engine.pendingMutations().map((p) => p.key));
    expect(keys.size, "a press again minted a second key").toBe(1);
    expect(drafted(s.fake), "each press left a draft").toHaveLength(1);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries(), "not exactly one delivery").toEqual([...keys]);
    expect(drafted(s.fake), "not exactly one draft row").toHaveLength(1);
    /* A new mail has no reply to resume: its second press is refused at the sheet, whose Send is
       lit only while the composer idles, and a waiting send is `queued`. */
    expect(COMPOSER).toMatch(/const canSend =\s*\n?\s*phase === "idle" &&/);
    s.store.close();
  }, 60_000);

  it("goes once when the network is back", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Offline", "Written on a train.");
    expect(res.outcome).toBe("queued");
    s.net.set("online");
    const settled = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(settled.get(res.key!)?.status, "the waiting send did not go when the network came back").toBe("confirmed");
    expect(s.fake.deliveries(), "not exactly one delivery").toEqual([res.key]);
    expect(drafted(s.fake), "not exactly one draft row").toHaveLength(1);
    expect(s.engine.pendingMutations()).toHaveLength(0);
    /* A second flush finds nothing to send. */
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(sendsOf(s.fake)).toHaveLength(1);
    s.store.close();
  }, 60_000);

  it("left while it waits, it goes once when the network is back", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "On a train", "Goes when the signal does.");
    expect(res.outcome).toBe("queued");
    const said = await wayOut(s, res, "close");
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(sendsOf(s.fake), "a send told it goes on the return never went").toHaveLength(1);
    expect(s.fake.deliveries()).toEqual([res.key]);
    expect(drafted(s.fake), "not exactly one draft row").toHaveLength(1);
    expect(said, "the sheet did not say the send still waits").toBe(Copy.replyQueuedOffline);
    s.store.close();
  }, 60_000);

  it("left while it waits, a forward to someone else is a message of its own, and both go", async () => {
    const s = await scene();
    s.net.set("offline");
    const a = await s.actions.sendForward("m-1", [{ name: "Alice", address: "alice@fake.test" }], "Alice, see below.");
    expect(await wayOut(s, a, "close")).toBe(Copy.replyQueuedOffline);
    const b = await s.actions.sendForward("m-1", [{ name: "Bob", address: "bob@fake.test" }], "Bob, see below.");
    expect(b.key, "the second forward retired the one the sheet left waiting").not.toBe(a.key);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(new Set(s.fake.deliveries())).toEqual(new Set([a.key, b.key]));
    const sent = s.fake.draftRows().filter((d) => (d as { status?: string }).status === "sent")
      .map((d) => [(d as { to?: Array<{ address: string }> }).to?.map((x) => x.address).join(","), (d as { body?: string }).body]);
    expect(sent.sort()).toEqual([["alice@fake.test", "Alice, see below."], ["bob@fake.test", "Bob, see below."]]);
    s.store.close();
  }, 60_000);

  it("left while it waits, then a relaunch: a forward to someone else is still a message of its own, and both go", async () => {
    const s = await scene();
    s.net.set("offline");
    const a = await s.actions.sendForward("m-1", [{ name: "Alice", address: "alice@fake.test" }], "Alice, see below.");
    expect(await wayOut(s, a, "close")).toBe(Copy.replyQueuedOffline);
    const after = await s.relaunch();
    const b = await after.actions.sendForward("m-1", [{ name: "Bob", address: "bob@fake.test" }], "Bob, see below.");
    expect(b.key, "after the relaunch the second forward retired the one the sheet left waiting").not.toBe(a.key);
    s.net.set("online");
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    const sent = s.fake.draftRows().filter((d) => (d as { status?: string }).status === "sent")
      .map((d) => (d as { to?: Array<{ address: string }> }).to?.map((x) => x.address).join(","));
    expect(sent.sort(), "Alice's forward was replaced after the relaunch").toEqual(["alice@fake.test", "bob@fake.test"]);
    after.store.close();
  }, 60_000);

  it("left while it waits, the same words with a file are a message of their own, and the file goes", async () => {
    const s = await scene();
    s.net.set("offline");
    const first = await s.actions.sendReply("m-1", "See attached.", false);
    expect(await wayOut(s, first, "close")).toBe(Copy.replyQueuedOffline);
    const file = { filename: "contract.pdf", contentType: "application/pdf", contentBase64: "JVBERi0xLjQKJcfsj6IK" };
    const second = await s.actions.sendReply("m-1", "See attached.", false, null, null, [file]);
    expect(second.key, "the press with the file was answered by the send without it").not.toBe(first.key);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(new Set(s.fake.deliveries())).toEqual(new Set([first.key, second.key]));
    expect(sendsOf(s.fake).filter((r) => r.body.includes("contract.pdf")).map((r) => r.key), "the file never left")
      .toEqual([second.key]);
    s.store.close();
  }, 60_000);

  it("pressed again with a file over a send not left, the file rides that send: one delivery, with it", async () => {
    const s = await scene();
    s.net.set("offline");
    const first = await s.actions.sendReply("m-1", "See attached.", false);
    const file = { filename: "contract.pdf", contentType: "application/pdf", contentBase64: "JVBERi0xLjQKJcfsj6IK" };
    const again = await s.actions.sendReply("m-1", "See attached.", false, null, null, [file]);
    expect(again.key, "a press again of one reply minted a second key").toBe(first.key);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toEqual([first.key]);
    expect(sendsOf(s.fake).some((r) => r.body.includes("contract.pdf")), "the waiting send answered the press and dropped its file")
      .toBe(true);
    s.store.close();
  }, 60_000);

  it("Cancel send over a send that already went, before the ledger heard, says no cancellation", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Gone", "Already in Sent.");
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toEqual([res.key]);
    expect(await wayOut(s, res, "cancelSend", "pending"), "a sent row was said to be in Drafts").toBe("close");
    s.store.close();
  }, 60_000);

  it("cancelled while it waits, it keeps the words in its one draft and sends nothing on the return", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Second thoughts", "Maybe not.");
    expect(res.outcome).toBe("queued");
    expect(await wayOut(s, res, "cancelSend")).toBe(Copy.sendCancelledInDrafts);
    expect(Copy.sendCancelledInDrafts).toContain("in Drafts");
    const rows = s.fake.draftRows();
    expect(rows.map((r) => r.subject), "the cancelled letter's words were lost").toEqual(["Second thoughts"]);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(sendsOf(s.fake), "a cancelled send went on the return").toHaveLength(0);
    s.store.close();
  }, 60_000);

  it("CONTROL: online, the same press goes at once, and Send later offline still reaches the engine", async () => {
    const s = await scene();
    const sent = await s.actions.sendNew("mb-1", TO, "Online", "At the desk.");
    expect(sent.outcome).toBe("sent");
    expect(sendsOf(s.fake)).toHaveLength(1);
    s.net.set("offline");
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    await s.actions.sendNew("mb-1", TO, "Later", "Tomorrow's.", null, later);
    expect(s.fake.seen.some((r) => r.method === "POST" && /\/schedule$/.test(r.url)),
      "an appointment was held as though it were a delivery").toBe(true);
    s.store.close();
  }, 60_000);
});

describe("the sentence a waiting send earns when it goes on the return", () => {
  it("a new mail says it was sent, a reply that the reply was", async () => {
    const s = await scene();
    s.net.set("offline");
    const mail = await s.actions.sendNew("mb-1", TO, "Offline", "A mail of its own.");
    const reply = await s.actions.sendReply("m-1", "An answer.", false);
    expect([mail.outcome, reply.outcome]).toEqual(["queued", "queued"]);
    s.net.set("online");
    const settled = await flushQueued(s.engine, s.actions.releaseConfirmed);
    const say = (key: string | undefined) => sayArg(confirmedSendSay(settled.get(key!)!, new Date(), "UTC"));
    expect(say(mail.key), "a new mail went with the reply's sentence").toBe(Copy.composeSent);
    expect(say(reply.key)).toBe(Copy.replySent);
    s.store.close();
  }, 60_000);

  it("by kind, an earlier press's confirmation, and an appointment", () => {
    const o: { forward: boolean; fresh: boolean; sendAt: string | null; earlierWent: boolean } =
      { forward: false, fresh: false, sendAt: null, earlierWent: false };
    const say = (x: Partial<typeof o>) => confirmedSendSay({ ...o, ...x }, new Date(), "UTC");
    expect(say({ forward: true })).toEqual({ say: "forwarded" });
    expect(say({ fresh: true, earlierWent: true })).toEqual({ say: "composeEarlierWent" });
    expect(say({ earlierWent: true })).toEqual({ say: "replyEarlierWent" });
    expect(say({ forward: true, earlierWent: true })).toEqual({ say: "forwardEarlierWent" });
    expect(say({ fresh: true, sendAt: "2030-01-02T09:00:00Z" }).say).toBe("scheduledFor");
  });
});

/* The server offered the send again after a passing refusal, and its window for the key runs out
   two minutes after the press whatever this phone does: a phone that stays offline past it is
   told the refusal on the return and nothing goes. So no sentence may promise the return. */
describe("a send the server offered again promises nothing about the network", () => {
  it("the radio drops as the answer arrives: the press says it is still trying, never that it goes when the network is back", async () => {
    const s = await scene();
    s.sendAnswers.set("d-1", [() => { s.net.set("offline"); return offeredAgain(); }]);
    const res = await s.actions.sendNew("mb-1", TO, "In a lift", "Written in a lift.");
    expect(res.outcome).toBe("queued");
    expect(networkNow()).toBe("offline");
    expect(s.toasts).toEqual([Copy.replyQueued]);
    expect(res.rearmed, "the press did not hear that the server offered it again").toBe(true);
    expect(Copy[queuedCaptionKey(networkNow(), res.accepted === true, res.rearmed === true)]).toBe(Copy.replyQueued);
    s.store.close();
  }, 60_000);

  it("offered again over our own full IMAP cap, the radio dropping as it answers: still trying, no promise either", async () => {
    const s = await scene();
    s.sendAnswers.set("d-1", [() => { s.net.set("offline"); return capOfferedAgain(); }]);
    const res = await s.actions.sendNew("mb-1", TO, "Fwd: the plan", "Passing this along.");
    expect(res.outcome).toBe("queued");
    expect(res.rearmed, "the press did not hear that the server offered it again").toBe(true);
    expect(s.toasts).toEqual([Copy.replyQueued]);
    s.store.close();
  }, 60_000);

  it("held offline, then offered again on the return: the ledger hears it, so the composer stops promising", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Offline", "Written on a train.");
    expect(res.outcome).toBe("queued");
    // The server never saw this one: the return does send it, so the promise is true here.
    expect(res.rearmed).toBeUndefined();
    expect(s.toasts).toEqual([Copy.replyQueuedOffline]);
    s.net.set("online");
    s.sendAnswers.set("d-1", [offeredAgain]);
    const rearmed: string[] = [];
    const settled = await flushQueued(s.engine, s.actions.releaseConfirmed, undefined, undefined, (key) => rearmed.push(key));
    expect(settled.has(res.key!), "an offer again is not terminal").toBe(false);
    expect(rearmed).toEqual([res.key]);
    s.store.close();
  }, 60_000);

  it("offered again inside another press's flush: the answer waits for the ledger, which hears it", async () => {
    const s = await scene();
    s.net.set("offline");
    const a = await s.actions.sendNew("mb-1", TO, "First", "One.");
    expect(a.outcome).toBe("queued");
    s.net.set("online");
    // B's first answer is a fault of ours, so its press flushes the whole queue: A's replay is offered again.
    s.sendAnswers.set("d-1", [offeredAgain]);
    s.sendAnswers.set("d-2", [serverFault]);
    const b = await s.actions.sendNew("mb-1", TO, "Second", "Two.");
    expect(b.outcome).toBe("sent");
    expect(answersWaiting(s.engine), "A's offer again was taken by B's flush and never reached the ledger").toBe(true);
    const rearmed: string[] = [];
    await flushQueued(s.engine, s.actions.releaseConfirmed, undefined, undefined, (key) => rearmed.push(key));
    expect(rearmed).toEqual([a.key]);
    s.store.close();
  }, 60_000);
});

describe("the decision, in one place", () => {
  it("holds the send step on offline only", () => {
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/send", "offline")).toBe(true);
    expect(sendWaitsForNetwork("post", "/drafts/d-1/send", "offline")).toBe(true);
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/send", "online")).toBe(false);
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/send", "unknown")).toBe(false);
    /* The draft is written, Send later records a time, and the rest of the door is untouched. */
    expect(sendWaitsForNetwork("POST", "/drafts", "offline")).toBe(false);
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/schedule", "offline")).toBe(false);
    expect(sendWaitsForNetwork("GET", "/sync", "offline")).toBe(false);
  });

  it("names the waiting sentence off the network door, in the sheet and in the press's answer", () => {
    expect(queuedCaptionKey("offline")).toBe("replyQueuedOffline");
    expect(queuedCaptionKey("online")).toBe("replyQueued");
    // Offered again by the server: its window runs whatever the network does.
    expect(queuedCaptionKey("offline", false, true)).toBe("replyQueued");
    expect(queuedCaptionKey("online", false, true)).toBe("replyQueued");
    expect(queuedCaptionKey("offline", true, true)).toBe("replySendingLong");
    expect(COMPOSER).toContain('phase === "queued" ? Copy[queuedCaptionKey(network, accepted, rearmed)] : Copy.replyUnverified');
    expect(COMPOSER).toContain("const network = useNetworkNow();");
  });

  it("the standalone boot is the one that hands the network door in", () => {
    const boot = PAIRING.slice(PAIRING.indexOf("origin: LOCAL_ENGINE_ORIGIN,"));
    expect(boot.slice(0, boot.indexOf("});")), "the standalone door boots with no network reader").toContain("network: networkNow,");
  });
});

describe("a waiting send in Drafts", () => {
  type Phone = { engine: Awaited<ReturnType<typeof scene>>["engine"] };
  const listed = (p: Phone, now = new Date()) =>
    liveDrafts(p.engine.read(), { now, zone: "UTC", locale: "en" } as unknown as Parameters<typeof liveDrafts>[1], p.engine.waitingSends())
      .map((d) => [d.subject, d.state]);
  const rowOf = (p: Phone, key: string) => p.engine.waitingSends().find((w) => w.key === key)!.draftId!;

  it("a new mail and a reply are listed at once as waiting, once each, and never as interrupted", async () => {
    const s = await scene();
    s.fake.stampDrafts();
    s.net.set("offline");
    await s.actions.sendNew("mb-1", TO, "Offline", "Written on a train.");
    await s.actions.sendReply("m-1", "An answer.", false);
    const both = [["Re: Invoice 12", "waiting"], ["Offline", "waiting"]];
    expect(listed(s), "a waiting send is missing from Drafts or listed as an ordinary draft").toEqual(both);
    await s.engine.syncOnce();
    expect(listed(s), "the drain listed a waiting send's row a second time").toEqual(both);
    expect(listed(s, new Date(Date.now() + 11 * 60_000)), "a waiting send turned interrupted").toEqual(both);
    s.store.close();
  }, 60_000);

  for (const relaunched of [false, true]) {
    it(`Discard cancels it: nothing is sent, nothing failed, nothing left unsaved${relaunched ? ", after a relaunch" : ""}`, async () => {
      const s = await scene();
      s.fake.stampDrafts();
      s.net.set("offline");
      const res = await s.actions.sendNew("mb-1", TO, "Second thoughts", "Maybe not.");
      const p = relaunched ? await s.relaunch() : s;
      expect(await p.actions.draftDiscard(rowOf(p, res.key!))).toBe("discarded");
      expect(s.toasts.at(-1)).toBe(Copy.draftsDiscardedNotSent);
      expect(listed(p)).toEqual([]);
      s.net.set("online");
      const settled = await flushQueued(p.engine, p.actions.releaseConfirmed);
      expect(settled.get(res.key!), "the cancelled send was said to fail").toBeUndefined();
      expect(sendsOf(s.fake), "a discarded send went on the return").toHaveLength(0);
      expect(p.engine.abandoned(), "the discard left a change that could not be saved").toHaveLength(0);
      expect(s.fake.draftRows()).toHaveLength(0);
      expect(s.toasts).not.toContain(Copy.replyFailed);
      p.store.close();
    }, 60_000);
  }

  it("Cancel send keeps the words as the same draft, and nothing goes on the return", async () => {
    const s = await scene();
    s.fake.stampDrafts();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Second thoughts", "Maybe not.");
    const row = rowOf(s, res.key!);
    const end = await cancelSendPress({
      asking: { current: false }, withdraw: async () => (await s.actions.cancelWaitingSend(res.key!)).said, verdict: () => "unknown",
      standalone: true, bound: true,
    });
    expect(end?.say && sayArg(end.say)).toBe(Copy.sendCancelledInDrafts);
    const drafts = liveDrafts(s.engine.read(), { now: new Date(), zone: "UTC", locale: "en" } as never, s.engine.waitingSends());
    expect(drafts.map((d) => [d.id, d.state, d.subject]), "the words did not come back as the same draft")
      .toEqual([[row, "open", "Second thoughts"]]);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(sendsOf(s.fake), "a cancelled send went on the return").toHaveLength(0);
    s.store.close();
  }, 60_000);

  it("Discard over a send already on the wire deletes nothing and says it is on its way; it is sent", async () => {
    const s = await scene();
    s.fake.stampDrafts();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Going", "On its way.");
    const row = rowOf(s, res.key!);
    let open!: () => void;
    s.slow.gate = new Promise<void>((r) => { open = r; });
    s.net.set("online");
    const flushing = flushQueued(s.engine, s.actions.releaseConfirmed);
    for (let i = 0; i < 100 && sendsOf(s.fake).length === 0 && s.engine.waitingSends()[0]?.wire !== true; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await s.actions.draftDiscard(row), "a send on the wire was discarded under it").toBe("alreadySent");
    open();
    expect((await flushing).get(res.key!)?.status).toBe("confirmed");
    expect(s.fake.draft(row)?.status, "the sent row was deleted").toBe("sent");
    expect(s.fake.deliveries()).toEqual([res.key]);
    s.store.close();
  }, 60_000);
});
