/**
 * THE DRAFTS CARD, PER HOLD STATE — what `DraftReader` renders, read through the plan it renders
 * from (`src/ui/draft-card.ts`) over fixture rows, then the discard, the dismiss and the resend on
 * a real wire: the loopback server answers the service's shapes (DELETE 204, or 409
 * `send_recorded` for a send still pending; resolve 200, or 409 `send_still_running`; PUT + send).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EntityReader } from "@ohmail/client-engine";
import { bracketSpan, withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { HELD_SEND_RECHECK_MS, SENDING_STALE_AFTER_MS } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveDrafts, type LiveWorldActions, type WorldDraft } from "../src/state/live";
import { backKeeps, discardDecision, draftCardPlan, sendAgainSentence } from "../src/ui/draft-card";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const NOW = new Date("2026-09-20T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const draftRow = (over: Record<string, unknown>) => ({
  id: "d-1", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the only copy", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: ago(60_000),
  ...over,
});

function rowOf(over: Record<string, unknown>): WorldDraft {
  const drafts = [draftRow(over)];
  const reader = {
    list: <T,>(type: string): T[] => (type === "draft" ? drafts : []) as unknown as T[],
    get: () => undefined,
  } as unknown as EntityReader;
  const [row] = liveDrafts(reader, { now: NOW, zone: "UTC", locale: "en" });
  if (!row) throw new Error("the fixture row was not listed");
  return row;
}

const IDLE = { confirming: false, confirmingSendAgain: false, refusal: null };

describe("the card, one hold state at a time", () => {
  it("an ordinary draft says nothing about a send and offers Discard alone", () => {
    const plan = draftCardPlan(rowOf({}), IDLE);
    expect(plan.held).toBeNull();
    expect(plan.acts).toBeNull();
    expect(plan.discard).toEqual({ kind: "button", label: Copy.draftsDiscard });
    expect(plan.refusal).toBeNull();
  });

  it("a held send inside the window says Sent is being checked, with Send again and the dismiss", () => {
    const plan = draftCardPlan(rowOf({ status: "unverified", updatedAt: ago(60_000) }), IDLE);
    expect(plan.held).toBe(Copy.draftsHeldChecking);
    expect(plan.acts).toEqual({ kind: "buttons", sendAgain: Copy.draftsSendAgain, itWasSent: Copy.draftsItWasSent });
    // Discard is live on a held row: the server admits an unverified discard.
    expect(plan.discard).toEqual({ kind: "button", label: Copy.draftsDiscard });
  });

  it("past the window it says the message is not in Sent", () => {
    const plan = draftCardPlan(rowOf({ status: "unverified", updatedAt: ago(HELD_SEND_RECHECK_MS + 1) }), IDLE);
    expect(plan.held).toBe(Copy.draftsHeldNotInSent);
    expect(plan.acts?.kind).toBe("buttons");
  });

  it("a send that died mid-flight says it was interrupted", () => {
    const plan = draftCardPlan(rowOf({ status: "sending", updatedAt: ago(SENDING_STALE_AFTER_MS + 60_000) }), IDLE);
    expect(plan.held).toBe(Copy.draftsHeldInterrupted);
    expect(plan.acts?.kind).toBe("buttons");
  });

  it("Discard asks in its own place: one sentence, Keep, Discard", () => {
    const plan = draftCardPlan(rowOf({ status: "unverified" }), { ...IDLE, confirming: true });
    expect(plan.discard).toEqual({
      kind: "confirm", what: Copy.draftsDiscardWhat, keep: Copy.draftsDiscardCancel, discard: Copy.draftsDiscardConfirm,
    });
    // One question at a time: the acts stay as they were.
    expect(plan.acts?.kind).toBe("buttons");
  });

  it("Send again asks in the acts' place, with Keep beside it", () => {
    const plan = draftCardPlan(rowOf({ status: "unverified" }), { ...IDLE, confirmingSendAgain: true });
    expect(plan.acts).toEqual({
      kind: "confirm", what: Copy.draftsSendAgainWhat, keep: Copy.draftsDiscardCancel, sendAgain: Copy.draftsSendAgain,
    });
    expect(plan.discard.kind).toBe("button");
  });

  it("a refused discard is a sentence in the row", () => {
    const plan = draftCardPlan(rowOf({ status: "unverified" }), { ...IDLE, refusal: "stillSending" });
    expect(plan.refusal).toBe(Copy.draftsDiscardStillSending);
  });

  it("a Send again that did not send is a sentence in the row, one per ending", () => {
    const row = rowOf({ status: "unverified" });
    expect(draftCardPlan(row, IDLE).sendRefusal).toBeNull();
    expect(draftCardPlan(row, { ...IDLE, sendRefusal: "stillRunning" }).sendRefusal).toBe(Copy.draftsResolveStillRunning);
    expect({
      notReached: sendAgainSentence("notReached"),
      bodyUnknown: sendAgainSentence("bodyUnknown"),
      queued: sendAgainSentence("queued"),
      unverified: sendAgainSentence("unverified"),
      failed: sendAgainSentence("failed"),
    }).toEqual({
      notReached: Copy.draftsResolveFailed,
      bodyUnknown: Copy.draftsBodyUnavailable,
      queued: Copy.replyQueued,
      unverified: Copy.replyUnverified,
      failed: Copy.replyFailed,
    });
  });

  it("a waiting send says so with Cancel send, no held acts, and Discard asks about the send too", () => {
    const row = { heldSays: null, waiting: { key: "k-1", wire: false, rowless: false } };
    const plan = draftCardPlan(row, { ...IDLE, queued: "replyQueuedOffline" });
    expect(plan.waiting).toEqual({ line: Copy.draftsWaiting, caption: Copy.replyQueuedOffline, cancelSend: Copy.cancelSend });
    expect([plan.held, plan.acts]).toEqual([null, null]);
    expect(draftCardPlan(row, { ...IDLE, confirming: true }).discard).toMatchObject({ what: Copy.draftsDiscardWaitingWhat });
    expect(draftCardPlan({ ...row, waiting: { ...row.waiting, wire: true } }, { ...IDLE, queued: "replyQueuedOffline" }).waiting?.caption,
      "a send on the wire was said to wait for the network").toBe(Copy.replySendingLong);
    expect(draftCardPlan(row, { ...IDLE, refusal: "alreadySent" }).refusal).toBe(Copy.replyAlreadySent);
    expect(draftCardPlan(row, { ...IDLE, refusal: "cancelUnknown" }).refusal).toBe(Copy.replyCancelUnreachable);
    expect(draftCardPlan(rowOf({}), IDLE).waiting).toBeNull();
  });

  it("back keeps while a question stands, and belongs to the navigator otherwise", () => {
    expect(backKeeps(true)).toBe(true);
    expect(backKeeps(false)).toBe(false);
  });

  it("refuses an interrupted send's discard here; every other row asks the server", () => {
    expect(discardDecision(rowOf({ status: "sending", updatedAt: ago(SENDING_STALE_AFTER_MS + 60_000) })))
      .toBe("stillSending");
    expect(discardDecision(rowOf({ status: "unverified" }))).toBe("wire");
    expect(discardDecision(rowOf({}))).toBe("wire");
  });
});

/* ── the round trips, on the loopback wire ─────────────────────────────────────────────────── */

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

async function scene(held: Record<string, unknown>, extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m1"));
  fake.addDraft({ ...draftRow({ id: "d-held", status: "unverified", updatedAt: new Date().toISOString() }), ...held } as never);
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid,
    zone: "UTC",
  });
  const listed = () => liveDrafts(boot.engine.read(), { now: new Date(), zone: "UTC", locale: "en" });
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, ...boot, actions, toasts, listed, close };
}

const wire = (fake: ReturnType<typeof mailServer>, method: string, url: string) =>
  fake.seen.filter((r) => r.method === method && r.url === url);

describe("the held row on a real wire", () => {
  it("an unverified row discards: DELETE answers 204 and the row leaves Drafts", async () => {
    const live = await scene({});
    expect(live.listed().map((r) => [r.id, r.heldSays])).toEqual([["d-held", "checking"]]);
    expect(await live.actions.draftDiscard("d-held")).toBe("discarded");
    expect(wire(live.fake, "DELETE", "/drafts/d-held")).toHaveLength(1);
    expect(live.listed()).toEqual([]);
    expect(live.toasts).toEqual([]);
    live.close();
  });

  it("a send still pending refuses by name: the row stays and the card says why in the row", async () => {
    const live = await scene({}, (f) => f.pendSend("d-held"));
    const outcome = await live.actions.draftDiscard("d-held");
    expect(outcome).toBe("stillSending");
    expect(live.listed().map((r) => r.id), "the refusal puts the row back").toEqual(["d-held"]);
    expect(live.toasts, "said in the row, not in a toast").toEqual([]);
    const plan = draftCardPlan(live.listed()[0]!, { ...IDLE, refusal: outcome === "stillSending" ? "stillSending" : null });
    expect(plan.refusal).toBe(Copy.draftsDiscardStillSending);
    live.close();
  });

  it("It was sent — dismiss resolves `arrived` and the row leaves Drafts", async () => {
    const live = await scene({});
    expect(await live.actions.draftResolve("d-held", "arrived")).toBe(true);
    const [req] = wire(live.fake, "POST", "/drafts/d-held/resolve");
    expect(JSON.parse(req!.body)).toEqual({ outcome: "arrived" });
    expect(live.listed()).toEqual([]);
    live.close();
  });

  it("Send again frees the row, then sends it as it stands — the stored text, one key", async () => {
    const live = await scene({ html: "<p>the only copy</p>" });
    expect(await live.actions.draftSendAgain("d-held")).toBe("sent");
    const order = live.fake.seen
      .filter((r) => r.url.startsWith("/drafts/d-held"))
      .map((r) => `${r.method} ${r.url}`);
    expect(order).toEqual(["POST /drafts/d-held/resolve", "PUT /drafts/d-held", "POST /drafts/d-held/send"]);
    expect(JSON.parse(wire(live.fake, "POST", "/drafts/d-held/resolve")[0]!.body)).toEqual({ outcome: "not_arrived" });
    // The PUT writes back what the server holds: formatted text stays formatted, nothing is added.
    const put = JSON.parse(wire(live.fake, "PUT", "/drafts/d-held")[0]!.body) as Record<string, unknown>;
    expect(put.html).toBe("<p>the only copy</p>");
    expect(put.body).toBeUndefined();
    expect(put.subject).toBe("Invoice 12");
    expect((put.to as { address: string }[]).map((a) => a.address)).toEqual(["ada@fake.test"]);
    expect(live.fake.deliveries()).toHaveLength(1);
    expect(live.toasts).toContain(Copy.composeSent);
    live.close();
  });

  it("Send again on a send still pending moves nothing past the refusal, and says it in the row", async () => {
    const live = await scene({}, (f) => f.pendSend("d-held"));
    expect(await live.actions.draftSendAgain("d-held")).toBe("stillRunning");
    expect(wire(live.fake, "PUT", "/drafts/d-held")).toEqual([]);
    expect(wire(live.fake, "POST", "/drafts/d-held/send")).toEqual([]);
    expect(live.toasts, "a send refusal is the row's, never a toast").toEqual([]);
    live.close();
  });

  it("Send again over a body this phone never received sends nothing and writes nothing", async () => {
    const live = await scene({ body: null, bodyOmitted: "over_page_budget" });
    expect(await live.actions.draftSendAgain("d-held")).toBe("bodyUnknown");
    expect(live.fake.seen.filter((r) => r.url.startsWith("/drafts/d-held"))).toEqual([]);
    expect(live.toasts).toEqual([]);
    live.close();
  });

  it("a send the server could not confirm, and one it refused, come back to the row unsaid", async () => {
    const unsure = await scene({}, (f) => f.unverifiedNextSend());
    expect(await unsure.actions.draftSendAgain("d-held")).toBe("unverified");
    expect(wire(unsure.fake, "POST", "/drafts/d-held/send")).toHaveLength(1);
    expect(unsure.toasts).toEqual([]);
    unsure.close();

    const refused = await scene({}, (f) => f.failNext("POST", "/drafts/d-held/send"));
    expect(await refused.actions.draftSendAgain("d-held")).toBe("failed");
    expect(refused.fake.deliveries()).toEqual([]);
    expect(refused.toasts).toEqual([]);
    refused.close();
  });
});

/* ── the card lays the plan out: read from its source, comments blanked ─────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = (rel: string) => withoutComments(fs.readFileSync(path.join(HERE, "..", rel), "utf8"));

describe("DraftReader renders the plan and nothing it decides itself", () => {
  const card = code("src/ui/DraftReader.tsx");

  it("draws both questions and the refusal from draftCardPlan", () => {
    expect(card).toContain("draftCardPlan(row,");
    expect(card).toContain('plan.discard.kind === "confirm"');
    expect(card).toContain('plan.acts.kind === "confirm"');
    expect(card).toContain("{plan.refusal}");
    expect(card).toContain("{plan.sendRefusal}");
    expect(card).toContain("{plan.held}");
  });

  it("asks discardDecision before the wire, and renders the server's refusal in the row", () => {
    const at = card.indexOf("const discard = async");
    const body = card.slice(at, bracketSpan(card, card.indexOf("{", at), "{", "}").end);
    expect(body.indexOf("discardDecision(row)")).toBeGreaterThan(-1);
    expect(body.indexOf("discardDecision(row)")).toBeLessThan(body.indexOf("w.actions.draftDiscard("));
    expect(body).toMatch(/if \(decided !== "wire"\) \{ setRefusal\(\{ why: decided, at: Date\.now\(\) \}\); return; \}/);
    expect(body).toContain('outcome === "stillSending"');
  });

  it("the hardware back is taken only while a question stands, and it keeps", () => {
    const at = card.indexOf('BackHandler.addEventListener("hardwareBackPress"');
    expect(at).toBeGreaterThan(-1);
    const effect = card.slice(card.lastIndexOf("useEffect(", at), at);
    expect(effect).toContain("if (asking === null) return;");
    const handler = card.slice(at, bracketSpan(card, card.indexOf("(", at)).end);
    expect(handler).toContain("setAsking(null)");
    expect(handler).toContain("return true");
  });

  it("both questions keep on the iOS escape gesture too", () => {
    expect(card.match(/onAccessibilityEscape=\{\(\) => setAsking\(null\)\}/g)).toHaveLength(2);
  });

  it("the list row speaks the held sentence the card shows", () => {
    const list = code("app/drafts/index.tsx");
    expect(list.match(/heldSentence\(row\.heldSays\)/g)).toHaveLength(2);
  });
});
