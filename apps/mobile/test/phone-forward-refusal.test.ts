/**
 * A FORWARD WHOSE ORIGINAL THE SERVER COULD NOT LOAD SAYS SO ON THE PHONE — through `bootEngine`'s
 * real HttpAdapter and engine against a fake speaking the send route's own wire. The phone used to
 * show "Sending didn't work. Try again." for `forward_original_unavailable`, a retry that cannot
 * succeed; it now says the web's sentence, in both languages, online or not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { flushQueued, liveActions, refusedSendSay, stableActions, type LiveWorldActions } from "../src/state/live";
import { forwardCaps } from "../src/compose/attach";
import { forwardFilesPlan } from "../src/compose/forward-files";
import { openLetterKeeper } from "../src/compose/letter-keeper";
import { letterDoor } from "../src/compose/letter-store";
import { forwardPartsAnnounced, forwardPartsReader } from "../src/net/pairing";
import { helloForwardParts } from "../src/engine/boot";
import { sendAgainSentence } from "../src/ui/draft-card";
import type { PhoneMailbox } from "../src/net/mailboxes";
import { failedSendLine } from "../src/ui/send-failed";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const peer = [{ name: null, address: "peer@fake.test" }];
const SEND = "/drafts/d-1/send";
const UNAVAILABLE_409 = {
  error: { code: "forward_original_unavailable", message: "The original could not be loaded, so it was not forwarded." },
};
const EN = "Not sent. The original could not be loaded, so it was not forwarded.";
const DE_SENTENCE = "Nicht gesendet. Das Original konnte nicht geladen werden, darum wurde es nicht weitergeleitet.";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

/**
 * `hello`: what `GET /hello` announces right before a send; `null` is a server with no route.
 * `launch: "unanswered"`: the session's own read of it, as the world makes it, went unanswered.
 */
async function scene(o: { supported?: boolean | null; hello?: Record<string, unknown> | null; deadlineMs?: number; launch?: "unanswered" } = {}) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Scan" }));
  if (o.hello !== null) fake.setHello(o.hello ?? { forwardParts: true });
  const boot = await bootEngine(deps, {
    origin, token: "tok-1", accountId: "acct-1", ...(o.deadlineMs !== undefined ? { forwardPartsDeadlineMs: o.deadlineMs } : {}),
  });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: string[] = [];
  const letters = letterDoor(boot.store);
  let reader: ReturnType<typeof forwardPartsReader> | null = null;
  if (o.launch === "unanswered") {
    fake.answerNext("GET", "/hello", 503, {});
    reader = forwardPartsReader({ standalone: false, fetch: globalThis.fetch.bind(globalThis), profile: { origin } } as never);
    await reader.settled();
  }
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC", letters,
    forwardParts: reader !== null ? reader.said : () => (o.supported === undefined ? true : o.supported),
  });
  return { fake, origin, ...boot, actions, toasts, letters, reader, world: stableActions(() => actions as never) };
}

describe("a forward refused for its original says why", () => {
  it("409 forward_original_unavailable: failed, the forward's own sentence, the row kept", async () => {
    const live = await scene();
    live.fake.answerNext("POST", SEND, 409, UNAVAILABLE_409);
    const res = await live.actions.sendForward("m1", peer, "");
    expect(res).toMatchObject({ outcome: "failed", failure: "replyForwardOriginalUnavailable", draftId: "d-1" });
    expect(live.toasts).toEqual([EN]);
    expect(sayArg(refusedSendSay("replyForwardOriginalUnavailable"))).toBe(EN);
  }, 30_000);

  it("offline does not hide it: an unloadable original is not a network condition", () => {
    expect(failedSendLine("replyForwardOriginalUnavailable", null, true)).toBe(EN);
    expect(failedSendLine("replyForwardOriginalUnavailable", { kind: "lost" }, true)).toBe(EN);
    expect(Copy.replyForwardOriginalUnavailable).toBe(EN);
  });

  it("German carries the web's German sentence", () => {
    expect(DE.replyForwardOriginalUnavailable).toBe(DE_SENTENCE);
  });
});

/* ── a forward lists the letter's files, and sends exactly the ones kept ─────────────────────── */

const KB = 1024;
const FILES = [
  { id: "att-1", filename: "rota-plan.pdf", contentType: "application/pdf", sizeBytes: 196 * KB },
  { id: "att-2", filename: "rota-photo.png", contentType: "image/png", sizeBytes: 823 * KB },
  { id: "att-3", filename: "rota-data.bin", contentType: "application/octet-stream", sizeBytes: 3 * 1024 * KB },
];
const UNSUPPORTED_EN = "Not sent. Your server sends every file of a forward and can't leave out the ones you removed.";
const UNSUPPORTED_DE = "Nicht gesendet. Dein Server sendet jede Datei einer Weiterleitung mit und kann die entfernten nicht weglassen.";
const posts = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.method === "POST");
const sentBody = (fake: ReturnType<typeof mailServer>) =>
  JSON.parse(fake.seen.find((r) => r.method === "POST" && r.url === SEND)!.body) as { forwardParts?: string[]; attachments?: unknown[] };
const box = (smtpMaxSizeBytes: number | null): PhoneMailbox => ({
  id: "mb-1", address: "me@fake.test", organizerRole: null, organizeConsentedAt: null, organizedBy: null,
  organizedByThisInstall: false, organizerState: null, status: null, junkFolder: null, smtpMaxSizeBytes, firstSyncStopFolder: null,
});
/** The optimistic Sent copy's files, by name. */
const sentCopyFiles = (live: Awaited<ReturnType<typeof scene>>) => {
  const copy = live.engine.read().entries<{ subject?: string }>("message").find((e) => e.id !== "m1");
  const list = live.engine.attachmentsOf(copy!.id, { includeInlineParts: true });
  return list.state === "ready" ? list.items.map((i) => i.filename) : list.state;
};

async function listed(live: Awaited<ReturnType<typeof scene>>, o: { kept?: string[] | null; addedBytes?: number; size?: number | null } = {}) {
  await live.actions.forwardFetch("m1");
  await live.engine.loadAttachments("m1").catch(() => undefined);
  return forwardFilesPlan({
    list: live.actions.forwardFiles("m1"), supported: live.actions.forwardPartsSupported(),
    kept: o.kept ?? null, addedBytes: o.addedBytes ?? 0, caps: forwardCaps([box(o.size ?? null)], "mb-1"),
  });
}
const optsOf = (wire: string[] | undefined) => (wire !== undefined ? { forwardParts: wire } : {});

describe("Forward lists the letter's files and sends only those kept", () => {
  it("one of three removed: two go, through the world's own wrapper, and the Sent copy lists two", async () => {
    const live = await scene();
    live.fake.setFiles("m1", FILES);
    const plan = await listed(live, { kept: ["att-1", "att-3"] });
    expect(plan.rows.map((r) => [r.filename, r.removable])).toEqual([["rota-plan.pdf", true], ["rota-photo.png", true], ["rota-data.bin", true]]);
    expect(plan.wire).toEqual(["att-1", "att-3"]);
    const res = await live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(plan.wire));
    expect(res.outcome).toBe("sent");
    expect(sentBody(live.fake).forwardParts).toEqual(["att-1", "att-3"]);
    expect(sentCopyFiles(live)).toEqual(["rota-plan.pdf", "rota-data.bin"]);
  }, 30_000);

  it("nothing removed sends no list, to a new server and an old one alike", async () => {
    for (const hello of [{ forwardParts: true }, {}]) {
      const live = await scene({ hello, supported: hello.forwardParts === true });
      live.fake.setFiles("m1", FILES);
      const plan = await listed(live);
      expect(plan.wire, JSON.stringify(hello)).toBeUndefined();
      expect((await live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(plan.wire))).outcome).toBe("sent");
      expect(sentBody(live.fake)).not.toHaveProperty("forwardParts");
    }
  }, 60_000);

  it("a server that does not announce it: the field is absent, no row is removable, and a choice it cannot keep is said", async () => {
    const live = await scene({ supported: false });
    live.fake.setFiles("m1", FILES);
    expect(sayArg((await listed(live)).line)).toContain("All of them go with it.");
    const plan = await listed(live, { kept: ["att-1"] });
    expect(plan.rows.every((r) => !r.removable)).toBe(true);
    expect(plan.wire).toBeUndefined();
    expect(sayArg(plan.line)).toBe("Forwarded files: 4.0 MB. Your server sends all of them, the ones you removed too. Up to 3.0 MB more from this phone.");
    expect(DE.forwardFilesRemovedGo("4,0 MB", "3,0 MB")).toBe(
      "Weitergeleitete Dateien: 4,0 MB. Dein Server sendet alle mit, auch die entfernten. Bis zu 3,0 MB mehr von diesem Handy.");
  }, 30_000);

  it("a launch whose /hello went unanswered keeps a choice already made: the kept ids go, the removed file is not listed", async () => {
    const live = await scene({ launch: "unanswered" });
    live.fake.setFiles("m1", FILES);
    // The read asked again when the sheet reads it is held, so the sheet sees "not known yet".
    const answer = live.fake.holdNext("GET", "/hello");
    const plan = await listed(live, { kept: ["att-1", "att-3"] });
    expect(plan.rows.map((r) => [r.filename, r.removable])).toEqual([["rota-plan.pdf", false], ["rota-data.bin", false]]);
    expect(plan.wire).toEqual(["att-1", "att-3"]);
    expect(sayArg(plan.line)).toMatch(/^Forwarded files: 3\.\d MB\. Up to 3\.0 MB more from this phone\.$/);
    const res = await live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(plan.wire));
    expect(res.outcome).toBe("sent");
    expect(sentBody(live.fake).forwardParts, "every file left, the removed one included").toEqual(["att-1", "att-3"]);
    answer();
    await live.reader!.settled();
    expect(live.actions.forwardPartsSupported(), "the unanswered launch read latched for the session").toBe(true);
    expect((await listed(live)).rows.every((r) => r.removable)).toBe(true);
  }, 30_000);

  it("a retry after the server took the send is never refused as not sent, whatever /hello says then", async () => {
    for (const after of ["404", "rolled back"] as const) {
      const live = await scene();
      live.fake.setFiles("m1", FILES);
      const plan = await listed(live, { kept: ["att-1", "att-3"] });
      const answer = live.fake.holdNext("POST", SEND);
      live.fake.answerNext("POST", SEND, 200, { status: "queued", message: "accepted, still handing over" });
      const pressed = live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(plan.wire));
      await vi.waitFor(() => expect(posts(live.fake).filter((r) => r.url === SEND)).toHaveLength(1));
      live.fake.setHello(after === "404" ? null : {});
      answer();
      const res = await pressed;
      expect(res.outcome, after).not.toBe("failed");
      expect(live.toasts, after).not.toContain(UNSUPPORTED_EN);
      if (after === "rolled back") expect(res).toMatchObject({ outcome: "unverified", draftId: "d-1" });
      await flushQueued(live.engine, live.actions.releaseConfirmed);
      expect(posts(live.fake).filter((r) => r.url === SEND), `${after}: sent a second time`).toHaveLength(1);
    }
  }, 60_000);

  it("a /hello that no longer announces it right before the send: refused in words, nothing posted, the rows read-only", async () => {
    const live = await scene({ hello: {} });
    live.fake.setFiles("m1", FILES);
    const plan = await listed(live, { kept: ["att-1"] });
    const res = await live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(plan.wire));
    expect(res).toMatchObject({ outcome: "failed", failure: "replyForwardPartsUnsupported" });
    expect(posts(live.fake), "a refused forward wrote or sent something").toHaveLength(0);
    expect(live.toasts.at(-1)).toBe(UNSUPPORTED_EN);
    expect(failedSendLine("replyForwardPartsUnsupported", { kind: "lost" }, false)).toBe(UNSUPPORTED_EN);
    expect(DE.replyForwardPartsUnsupported).toBe(UNSUPPORTED_DE);
    const after = await listed(live, { kept: ["att-1"] });
    expect(after.rows.every((r) => !r.removable)).toBe(true);
    expect(after.wire).toBeUndefined();
  }, 30_000);

  it("a /hello that hangs past its deadline, or answers 503: nothing leaves, then the send goes with its list", async () => {
    for (const stall of ["hang", "503"] as const) {
      const live = await scene({ deadlineMs: 300 });
      live.fake.setFiles("m1", FILES);
      const plan = await listed(live, { kept: ["att-1", "att-3"] });
      // Twice: the press retries once at once, under the same key.
      for (let i = 0; i < 2; i++) {
        if (stall === "hang") live.fake.hangNext("GET", "/hello");
        else live.fake.answerNext("GET", "/hello", 503, { error: { code: "unavailable", message: "down" } });
      }
      const res = await live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(plan.wire));
      expect(res.outcome, stall).toBe("queued");
      expect(posts(live.fake), stall).toHaveLength(0);
      await flushQueued(live.engine, live.actions.releaseConfirmed);
      expect(sentBody(live.fake).forwardParts, stall).toEqual(["att-1", "att-3"]);
    }
  }, 60_000);

  it("unverified, then Send again: the held message goes with no list of its own; unmatched, the choice stays for the resend", async () => {
    const live = await scene();
    live.fake.setFiles("m1", FILES);
    const plan = await listed(live, { kept: ["att-1", "att-3"] });
    const keeper = openLetterKeeper({
      door: live.letters, id: "letter-1", newFileId: uuid,
      words: { mode: "forward", messageId: "m1", mailboxId: null, to: "peer@fake.test", cc: "", bcc: "", subject: "Fwd: Scan", body: "", envelope: null },
    });
    keeper.forwardKept(["att-1", "att-3"]);
    live.fake.unverifiedNextSend();
    const res = await keeper.sendVia(() => live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(plan.wire)));
    expect(res).toMatchObject({ outcome: "unverified", draftId: "d-1" });
    expect(live.letters.letterOf("d-1")?.forwardKept, "the choice left with the unverified answer").toEqual(["att-1", "att-3"]);
    keeper.release();
    live.fake.addDraft({ ...live.fake.draft("d-1")!, id: "d-1", status: "unverified", updatedAt: new Date().toISOString() });
    await live.engine.syncOnce();
    // The held send's claim names its kept list and a Send again carries none: the server cannot match it.
    live.fake.answerNext("POST", SEND, 409, { error: { code: "send_again_changed", message: "not matched", retryable: false } });
    expect(await live.actions.draftSendAgain("d-1")).toBe("changed");
    const lastSend = () => JSON.parse(posts(live.fake).filter((r) => r.url === SEND).at(-1)!.body) as Record<string, unknown>;
    expect(lastSend()).toMatchObject({ again: true });
    expect(lastSend(), "a Send again names a forward list of its own").not.toHaveProperty("forwardParts");
    expect(sendAgainSentence("changed")).toBe(Copy.draftsSendAgainChanged);
    expect(live.letters.letterOf("d-1")?.forwardKept, "the unmatched press dropped the choice").toEqual(["att-1", "att-3"]);
    // Made a draft again from the card, it goes from the composer with the kept files only.
    expect(await live.actions.draftResolve("d-1", "not_arrived")).toBe(true);
    const kept = live.letters.letterOf("d-1")?.forwardKept ?? undefined;
    expect((await live.world.sendForward("m1", peer, "", null, [], false, false, "d-1", optsOf(kept ? [...kept] : undefined))).outcome).toBe("sent");
    expect(lastSend().forwardParts).toEqual(["att-1", "att-3"]);
  }, 30_000);

  it("the server's announcement is read from GET /hello under a deadline; the phone's own engine always has it", async () => {
    const live = await scene({ hello: null });
    const f = globalThis.fetch.bind(globalThis);
    const session = { standalone: false, fetch: f, profile: { origin: live.origin } } as never;
    expect(await helloForwardParts(f, live.origin, 1000), "a 404 is not an answer").toBeNull();
    expect(await forwardPartsAnnounced(session)).toBeNull();
    live.fake.setHello({});
    expect(await helloForwardParts(f, live.origin, 1000), "an ohmail /hello without it").toBe(false);
    live.fake.answerNext("GET", "/hello", 200, "<html>proxy</html>");
    expect(await helloForwardParts(f, live.origin, 1000), "a page that is not ohmail's /hello is not an answer").toBeNull();
    live.fake.setHello({ forwardParts: true });
    expect(await helloForwardParts(f, live.origin, 1000)).toBe(true);
    expect(await forwardPartsAnnounced(session)).toBe(true);
    live.fake.answerNext("GET", "/hello", 503, {});
    expect(await helloForwardParts(f, live.origin, 1000), "a 503 is not an answer").toBeNull();
    live.fake.hangNext("GET", "/hello");
    expect(await helloForwardParts(f, live.origin, 200), "a hung /hello is not an answer").toBeNull();
    expect(await forwardPartsAnnounced({ standalone: true, fetch: f, profile: { origin: "x" } } as never)).toBe(true);
  }, 30_000);

  it("a list that could not be read sends no list and says every file goes; a kept choice still goes", async () => {
    const live = await scene();
    live.fake.failNext("GET", "/messages/m1/attachments");
    const plan = await listed(live);
    expect(plan.wire).toBeUndefined();
    expect(plan.refusal).toBeNull();
    expect(sayArg(plan.line)).toBe("The letter's files could not be read here. All of them go with it.");
    const chosen = forwardFilesPlan({
      list: live.actions.forwardFiles("m1"), supported: true, kept: ["att-1"], addedBytes: 0, caps: forwardCaps([box(null)], "mb-1"),
    });
    expect(chosen.wire).toEqual(["att-1"]);
    expect(sayArg(chosen.line)).toBe("The letter's files could not be read here. The ones you kept go with it.");
    const refused = forwardFilesPlan({
      list: live.actions.forwardFiles("m1"), supported: false, kept: ["att-1"], addedBytes: 0, caps: forwardCaps([box(null)], "mb-1"),
    });
    expect(refused.wire).toBeUndefined();
    expect(sayArg(refused.line)).toBe("The letter's files could not be read here. Your server sends all of them, the ones you removed too.");
    await live.world.sendForward("m1", peer, "", null, [], false, false, null, optsOf(chosen.wire));
    expect(sentBody(live.fake).forwardParts).toEqual(["att-1"]);
  }, 30_000);

  it("4.2 MB forwarded beside 0.68 MB added goes, and the line says what is true", async () => {
    const live = await scene();
    live.fake.setFiles("m1", FILES);
    const added = Buffer.alloc(684 * KB, 1).toString("base64");
    const plan = await listed(live, { addedBytes: 684 * KB });
    expect(plan.refusal).toBeNull();
    expect(sayArg(plan.line)).toBe("Forwarded files: 4.0 MB. Up to 3.0 MB more from this phone.");
    const res = await live.world.sendForward("m1", peer, "", null,
      [{ filename: "r9-photo.jpg", contentType: "image/jpeg", contentBase64: added }], false, false, null, optsOf(plan.wire));
    expect(res.outcome).toBe("sent");
    expect(sentBody(live.fake).attachments).toHaveLength(1);
  }, 30_000);

  it("over what the mailbox takes, or past the forwarded ceiling, Send is refused in words", async () => {
    const live = await scene();
    live.fake.setFiles("m1", FILES);
    const plan = await listed(live, { size: 5 * 1024 * KB });
    expect(sayArg(plan.refusal!)).toContain("your mail server takes");
    const removedBig = await listed(live, { size: 5 * 1024 * KB, kept: ["att-1", "att-2"] });
    expect(removedBig.refusal, "removing the big file did not lift the refusal").toBeNull();
    const big = await scene();
    big.fake.setFiles("m1", [{ id: "att-9", filename: "huge.bin", contentType: "application/octet-stream", sizeBytes: 21 * 1024 * KB }]);
    expect(sayArg((await listed(big)).refusal!)).toBe("The forwarded files are over 20.0 MB. Remove some to send it.");
    expect(big.fake.seen.filter((r) => r.method === "POST")).toHaveLength(0);
  }, 30_000);

  it("a forward whose files changed on the server says so", async () => {
    const live = await scene();
    live.fake.answerNext("POST", SEND, 409, { error: { code: "forward_parts_changed", message: "changed" } });
    const res = await live.world.sendForward("m1", peer, "", null, [], false, false, null, { forwardParts: ["att-1"] });
    expect(res).toMatchObject({ outcome: "failed", failure: "replyForwardPartsChanged" });
    expect(live.toasts.at(-1)).toBe(Copy.replyForwardPartsChanged);
  }, 30_000);
});
