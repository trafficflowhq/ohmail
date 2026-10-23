/**
 * THE MESSAGE SCREEN'S VERBS, ON A REAL WIRE — every new action in `src/state/live.ts`
 * (mirrored from the webapp's `AppShell.onMessageAction` arms) driven through the same
 * `bootEngine` composition the app runs, against the loopback mail server.
 *
 * What bites, per verb:
 *  · reply / reply all / forward ride `mail_send` — TWO requests (`POST /drafts`, then
 *    `POST /drafts/:id/send`), the envelope derived exactly as the webapp derives it: a plain
 *    reply leaves it to `Engine.enrich` (to = the sender, `Re:` subject, the parent's
 *    mailbox), reply-all carries `replyAllRecipients`' own envelope, a forward carries
 *    `forwardOf`, `Fwd:` and only the recipients the user typed — and REFUSES a `no_forward`
 *    parent before anything reaches the wire;
 *  · the three horizons are TOGGLES — the verb that filed a message takes it out again;
 *  · Resurface's chooser writes the chosen instant; Now writes the `resurfaced` state, not a
 *    date; Done on a scheduled message clears the booking AND files it read;
 *  · Move and the deliberate read switch are the same one-mutation verbs every list uses;
 *  · tag toggle / tag-or-create hit `POST /messages/:id/tags` with the delta, never a labels
 *    array;
 *  · Screening runs the webapp's rule ladder: a standing same-kind rule is RETARGETED (never
 *    duplicated), no standing rule means ONE `rule_create` with `applyRetro`, and a sender
 *    still waiting at the gate is decided with `screener_decide` (the server promotes the
 *    rule; no second row is written);
 *  · a server refusal ROLLS BACK and answers `false` with the failure sentence — measured
 *    with an armed 422, not a stubbed adapter.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { FOLDER_OF_VIEW, type EngineMessage } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveActions,
  liveMessage,
  replyAllRecipients,
  tomorrowNine,
  nextWeekNine,
  setTimeLabel,
  moveTargetsFor,
  presentedOf,
  standsInOhbox,
  type LiveWorldActions,
  type WorldMail,
} from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

async function liveOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity(); // the app's own sequence: the verdict opens the drain routes
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid: deps.uuid,
    zone: "UTC",
  });
  return { ...boot, actions, toasts };
}

/** One test-world per case: server, allow-rule for the standing sender, one message. */
async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  extra(fake);
  const live = await liveOn(fake, origin);
  return { fake, live };
}

const wire = (fake: ReturnType<typeof mailServer>, method: string, path: string) =>
  fake.seen.filter((r) => r.method === method && r.url === path);

/**
 * THE ROW THE SCREEN PRESSES ON, built the way the app builds it — `liveMessage` over the
 * PROJECTION, so `presentedFolder` is the sender's routing and `folder` is where the mail is
 * filed. The move panel and `move()` are driven through this and never through a hand-made
 * object: the whole defect was the two places being one value, and a fixture that supplies them
 * separately could not see it.
 */
function row(live: { engine: Parameters<typeof liveMessage>[0] }, id: string): WorldMail {
  const m = liveMessage(live.engine, id, { now: new Date("2026-08-19T10:00:00Z"), zone: "UTC" });
  if (!m) throw new Error(`no row for ${id}`);
  return m;
}

/** Poll a condition to settledness — for the deliberately-unawaited dispatches. */
async function settle(cond: () => boolean, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}

describe("reply, reply all, forward — mail_send on the real wire", () => {
  it("a plain reply: POST /drafts with the enriched envelope, then the send", async () => {
    const { fake, live } = await scene();
    expect((await live.actions.sendReply("m1", "Thanks!", false)).outcome).toBe("sent");
    const drafts = wire(fake, "POST", "/drafts");
    expect(drafts).toHaveLength(1);
    const body = JSON.parse(drafts[0]!.body) as {
      inReplyToMessageId: string; subject: string; to: { address: string }[]; body: string; mailboxId: string;
    };
    expect(body.inReplyToMessageId).toBe("m1");
    expect(body.subject).toBe("Re: Welcome");
    expect(body.to.map((r) => r.address)).toEqual(["sender@fake.test"]);
    expect(body.body).toBe("Thanks!");
    expect(body.mailboxId).toBe("mb-1");
    expect(wire(fake, "POST", "/drafts/d-1/send")).toHaveLength(1);
    expect(live.toasts).toContain(Copy.replySent);
    live.store.close();
    fake.server.close();
  });

  it("reply all carries replyAllRecipients' own envelope — sender leads To, Cc survives", async () => {
    const { fake, live } = await scene((f) =>
      f.addMessage({
        ...dto("m2", { subject: "Plans" }),
        to: [{ name: null, address: "me@fake.test" }, { name: null, address: "peer@fake.test" }],
        cc: [{ name: null, address: "third@fake.test" }],
      } as ReturnType<typeof dto>),
    );
    const m = live.engine.read().get<EngineMessage>("message", "m2")!;
    // The predicate the sheet renders from is the same one the send resolves.
    expect(replyAllRecipients(m, [])).not.toBeNull();
    expect((await live.actions.sendReply("m2", "All hands…", true)).outcome).toBe("sent");
    const body = JSON.parse(wire(fake, "POST", "/drafts")[0]!.body) as {
      to: { address: string }[]; cc: { address: string }[];
    };
    expect(body.to.map((r) => r.address)).toEqual(["sender@fake.test", "me@fake.test", "peer@fake.test"]);
    expect(body.cc.map((r) => r.address)).toEqual(["third@fake.test"]);
    live.store.close();
    fake.server.close();
  });

  it("a 1:1 message offers no reply-all envelope", async () => {
    const { fake, live } = await scene((f) =>
      f.addMessage({
        ...dto("m3"),
        to: [{ name: null, address: "me@fake.test" }],
      } as ReturnType<typeof dto>),
    );
    const m = live.engine.read().get<EngineMessage>("message", "m3")!;
    expect(replyAllRecipients(m, [])).toBeNull();
    live.store.close();
    fake.server.close();
  });

  it("forward: no inReplyTo, Fwd: subject, the typed recipients, forwardOf on the send", async () => {
    const { fake, live } = await scene();
    expect((await live.actions.sendForward("m1", [{ name: null, address: "colleague@x.test" }], "FYI")).outcome).toBe("sent");
    const draft = JSON.parse(wire(fake, "POST", "/drafts")[0]!.body) as {
      inReplyToMessageId: string | null; subject: string; to: { address: string }[];
    };
    expect(draft.inReplyToMessageId).toBeNull();
    expect(draft.subject).toBe("Fwd: Welcome");
    expect(draft.to.map((r) => r.address)).toEqual(["colleague@x.test"]);
    const send = JSON.parse(wire(fake, "POST", "/drafts/d-1/send")[0]!.body) as { forwardOf?: string };
    expect(send.forwardOf).toBe("m1");
    expect(live.toasts).toContain(Copy.forwarded);
    live.store.close();
    fake.server.close();
  });

  it("the signature seals into the reply's body — one blank line, then the block's exact text", async () => {
    const { fake, live } = await scene();
    expect((await live.actions.sendReply("m1", "Thanks!", false, "Casey Reeve\nohmail")).outcome).toBe("sent");
    const body = JSON.parse(wire(fake, "POST", "/drafts")[0]!.body) as { body: string };
    // What is shown is what ships (`withSignature`): the body, one blank line, the block.
    expect(body.body).toBe("Thanks!\n\nCasey Reeve\nohmail");
    live.store.close();
    fake.server.close();
  });

  it("a null signature leaves the reply byte-identical to one built before the block existed", async () => {
    const { fake, live } = await scene();
    expect((await live.actions.sendReply("m1", "Thanks!", false, null)).outcome).toBe("sent");
    const body = JSON.parse(wire(fake, "POST", "/drafts")[0]!.body) as { body: string };
    expect(body.body).toBe("Thanks!");
    live.store.close();
    fake.server.close();
  });

  it("a signature never makes an empty reply sendable — the refusal is judged on the body alone", async () => {
    const { fake, live } = await scene();
    expect((await live.actions.sendReply("m1", "   ", false, "Casey")).outcome).toBe("failed");
    expect(wire(fake, "POST", "/drafts")).toHaveLength(0);
    live.store.close();
    fake.server.close();
  });

  it("the signature seals into the forward's note — above the server-quoted original by construction", async () => {
    const { fake, live } = await scene();
    expect(
      (await live.actions.sendForward("m1", [{ name: null, address: "c@x.test" }], "FYI", "Casey")).outcome,
    ).toBe("sent");
    const body = JSON.parse(wire(fake, "POST", "/drafts")[0]!.body) as { body: string };
    // The server appends the quoted original AFTER the body it is handed (`send-service.ts`),
    // so the note + signature stand above the quoted history in what the recipient reads.
    expect(body.body).toBe("FYI\n\nCasey");
    live.store.close();
    fake.server.close();
  });

  it("a no_forward parent leaves only after the ask — unconfirmed is refused before the wire", async () => {
    const { fake, live } = await scene((f) =>
      f.addMessage({
        ...dto("m4"),
        sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: false },
      } as unknown as ReturnType<typeof dto>),
    );
    expect((await live.actions.sendForward("m4", [{ name: null, address: "a@b.test" }], "")).outcome).toBe("failed");
    expect(wire(fake, "POST", "/drafts")).toHaveLength(0);
    // The person answered the sheet's ask: the forward goes, and the send states the confirmation.
    expect(
      (await live.actions.sendForward("m4", [{ name: null, address: "a@b.test" }], "", null, [], false, true)).outcome,
    ).toBe("sent");
    const send = JSON.parse(wire(fake, "POST", "/drafts/d-1/send")[0]!.body) as { forwardOf?: string; forwardConfirmed?: boolean };
    expect(send.forwardOf).toBe("m4");
    expect(send.forwardConfirmed).toBe(true);
    live.store.close();
    fake.server.close();
  });

  it("an ordinary forward states no confirmation — the flag rides only a no_forward original", async () => {
    const { fake, live } = await scene();
    expect((await live.actions.sendForward("m1", [{ name: null, address: "c@x.test" }], "", null, [], false, true)).outcome).toBe("sent");
    const send = JSON.parse(wire(fake, "POST", "/drafts/d-1/send")[0]!.body) as { forwardConfirmed?: boolean };
    expect(send.forwardConfirmed).toBeUndefined();
    live.store.close();
    fake.server.close();
  });

  it("a refused send rolls back: false, and the failure sentence", async () => {
    const { fake, live } = await scene();
    fake.failNext("POST", "/drafts");
    expect((await live.actions.sendReply("m1", "Thanks!", false)).outcome).toBe("failed");
    expect(live.toasts).toContain(Copy.replyFailed);
    live.store.close();
    fake.server.close();
  });
});

describe("the horizons are toggles; the chooser writes real instants", () => {
  it("Later files, then takes it out again — reply_later, then none", async () => {
    const { fake, live } = await scene();
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    let posts = wire(fake, "POST", "/messages/m1/triage").map((r) => JSON.parse(r.body) as { state: string });
    expect(posts.map((p) => p.state)).toEqual(["reply_later"]);
    expect(live.toasts).toContain(Copy.toastQueued);
    // The toggle reads the mirror the mutation's own overlay already updated.
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    posts = wire(fake, "POST", "/messages/m1/triage").map((r) => JSON.parse(r.body) as { state: string });
    expect(posts.map((p) => p.state)).toEqual(["reply_later", "none"]);
    expect(live.toasts).toContain(Copy.toastUnqueued);
    live.store.close();
    fake.server.close();
  });

  it("resurfaceAt writes the chosen instant; Now writes the state; Done clears and reads", async () => {
    const { fake, live } = await scene();
    const when = tomorrowNine(new Date()).toISOString();
    expect(await live.actions.resurfaceAt("m1", when)).toBe(true);
    const booked = wire(fake, "POST", "/messages/m1/triage").map((r) => JSON.parse(r.body) as { state: string; bubbleUpAt?: string });
    expect(booked[0]).toEqual({ state: "bubbled_up", bubbleUpAt: when });
    expect(live.toasts.some((t) => t.startsWith("Resurfaces "))).toBe(true);

    // DONE on the scheduled message: the booking is cleared first, then the deliberate read.
    expect(await live.actions.resurfaceDone("m1")).toBe(true);
    const after = wire(fake, "POST", "/messages/m1/triage").map((r) => (JSON.parse(r.body) as { state: string }).state);
    expect(after).toEqual(["bubbled_up", "none"]);
    expect(wire(fake, "PATCH", "/messages").some((r) => r.body.includes('"unread":false') && r.body.includes("m1"))).toBe(true);
    expect(live.toasts).toContain(Copy.toastResurfaceDone);

    expect(await live.actions.resurfaceNow("m1")).toBe(true);
    const last = wire(fake, "POST", "/messages/m1/triage").map((r) => (JSON.parse(r.body) as { state: string }).state);
    expect(last[last.length - 1]).toBe("resurfaced");
    live.store.close();
    fake.server.close();
  });

  it("the horizon presets land at 09:00 and read back the same wall clock", () => {
    const from = new Date("2026-08-22T15:00:00");
    const tomorrow = tomorrowNine(from);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getDate()).not.toBe(from.getDate());
    const monday = nextWeekNine(from);
    expect(monday.getDay()).toBe(1);
    expect(monday.getHours()).toBe(9);
    expect(monday.getTime()).toBeGreaterThan(from.getTime());
    // The toast's label is the instant read back in the reader's zone.
    const saturday = new Date("2026-08-22T15:00:00.000Z");
    expect(setTimeLabel("2026-08-28T09:00:00.000Z", saturday, "UTC")).toBe("Fri 09:00");
    expect(setTimeLabel("next Friday", saturday, "UTC")).toBe("next Friday");
  });
});

describe("move, the read switch, tags", () => {
  it("move relocates this message and never offers where it already is", async () => {
    const { fake, live } = await scene();
    expect(moveTargetsFor({ presentedFolder: "INBOX" as EngineMessage["folder"] }))
      .toEqual(["reads", "receipts", "screened", "spam"]);
    expect(await live.actions.move(row(live, "m1"), "reads")).toBe(true);
    const posted = JSON.parse(wire(fake, "POST", "/messages/m1/move")[0]!.body) as { folder: string };
    expect(posted.folder).toBe(FOLDER_OF_VIEW.reads);
    // The press retargets the sender's rule too, and says so.
    expect(live.toasts).toContain(Copy.toastRuledMoved(Copy.placeReads, 1, "Test Sender"));
    /* AND THE SENDER'S ROUTING WENT WITH IT. A pile shows the place the sender's rule names, so a
       bare folder move is undone by the next partition — reported on the 0.19.0 desktop as "Move →
       Ohbox did nothing, twice". The rule that held this sender in the Ohbox is retargeted in the
       same press. */
    const ruled = fake.seen.filter((r) => r.url.startsWith("/rules/") && r.method !== "GET");
    expect(ruled.length, "the sender's routing never reached the wire").toBeGreaterThan(0);
    expect(JSON.stringify(ruled.map((r) => r.body))).toContain(FOLDER_OF_VIEW.reads);
    // Moving to the place it is already in dispatches nothing — and SAYS so, rather than
    // returning in silence, which is the half of that report the sentence owns.
    expect(await live.actions.move(row(live, "m1"), "reads")).toBe(false);
    expect(wire(fake, "POST", "/messages/m1/move")).toHaveLength(1);
    expect(live.toasts).toContain(Copy.toastMoveAlready(Copy.placeReads));
    live.store.close();
    fake.server.close();
  });

  /**
   * WHERE THE MAIL IS SHOWN IS NOT WHERE IT IS FILED, and the press means the shown place.
   *
   * A newsletter ruled to `ohmail/News` sits physically in the INBOX. Before this the panel
   * filtered on the filed folder — so Ohbox, the destination the 0.19.0 report pressed, was not
   * offered at all — and the arm read the raw mirror for both values, so the retarget landed on
   * the rule holding the sender at the INBOX, of which there is none. Both halves read the
   * projection now, and the whole press is one rule edit with nothing on the move route.
   */
  it("a message presented in a pile is moved at the place it is SHOWN in", async () => {
    /* A SCREEN-OUT since ARCH-R902: an admitting rule no longer shows an unmoved
       INBOX letter elsewhere, so the two locations disagree only under a DENY rule's shelf. */
    const { fake, live } = await scene((f) => {
      f.addRule(ruleDto("r-reads", "sender", "reader@fake.test", FOLDER_OF_VIEW.screened));
      f.addMessage(dto("m9", { subject: "Weekly", from: { name: "Reader", address: "reader@fake.test" } }));
    });
    const m = row(live, "m9");
    // The two locations disagree — which is the fixture's whole point, asserted before the press.
    expect(m.folder, "the mail is filed in the INBOX").toBe("INBOX");
    expect(m.presentedFolder, "and it is shown in Screened").toBe(FOLDER_OF_VIEW.screened);
    // So the panel offers the Ohbox and withholds Screened, the pile the row is already in.
    expect(moveTargetsFor(m)).toEqual(["ohbox", "reads", "receipts", "spam"]);

    expect(await live.actions.move(m, "ohbox")).toBe(true);
    // Only the rule changes — the letter is already filed where the Ohbox is — and the sentence says that.
    expect(live.toasts).toContain(Copy.toastRuledFuture(Copy.placeOhbox, "Reader"));
    /* THE RULE HOLDING THIS SENDER IN READS is what moved, and the mail never left the INBOX:
       nothing on the move route, because it is already where the Ohbox is. */
    const ruled = fake.seen.filter((r) => r.url.startsWith("/rules/") && r.method !== "GET");
    expect(ruled.map((r) => r.url), "the rule shown in Reads was not the one retargeted")
      .toEqual(["/rules/r-reads"]);
    expect(JSON.parse(ruled[0]!.body) as { destination: string })
      .toMatchObject({ destination: FOLDER_OF_VIEW.ohbox });
    expect(wire(fake, "POST", "/messages/m9/move"), "the mail was already in the INBOX").toHaveLength(0);
    live.store.close();
    fake.server.close();
  });

  /**
   * A READER MAILBOX'S MOVE. The server records the press for the install that organizes the
   * mailbox and answers 202: nothing has moved, and the phone said "Moved to Reads." anyway for
   * the length of a release. The sentence now comes from the answer, the row stays where it is,
   * and the engine keeps the request until a change confirms it.
   */
  it("a move the server queues for the organizer says so, and the message does not move", async () => {
    const { fake, live } = await scene();
    fake.queueNextForOrganizer("POST", "/messages/m1/move");

    expect(await live.actions.move(row(live, "m1"), "reads")).toBe(true);

    // The sender's rule goes with the letter (`r-allow` decides them), so the sentence names both.
    expect(live.toasts).toContain(Copy.toastMoveQueuedWithRule(Copy.placeReads, "Studio laptop"));
    expect(live.toasts, "the phone reported a move nobody made").not.toContain(Copy.toastMoved(Copy.placeReads));
    expect(live.engine.read().get<EngineMessage>("message", "m1")!.folder).toBe("INBOX");
    expect(live.engine.organizerRequests().map((r) => r.messageId)).toEqual(["m1"]);
    live.store.close();
    fake.server.close();
  });

  /** An unnamed holder is a real holder — the sentence drops the name, never the fact. */
  it("an unnamed organizer still gets its own sentence", async () => {
    const { fake, live } = await scene();
    fake.queueNextForOrganizer("POST", "/messages/m1/move", null);
    expect(await live.actions.move(row(live, "m1"), "reads")).toBe(true);
    expect(live.toasts).toContain(Copy.toastMoveQueuedWithRuleUnknown(Copy.placeReads));
    live.store.close();
    fake.server.close();
  });

  it("the deliberate read switch is mark_seen with no via — both directions", async () => {
    const { fake, live } = await scene();
    expect(await live.actions.markSeen("m1", false)).toBe(true);
    expect(await live.actions.markSeen("m1", true)).toBe(true);
    const patches = wire(fake, "PATCH", "/messages").map((r) => JSON.parse(r.body) as { ids: string[]; unread: boolean });
    expect(patches.map((p) => p.unread)).toEqual([false, true]);
    expect(patches.every((p) => p.ids.includes("m1"))).toBe(true);
    live.store.close();
    fake.server.close();
  });

  it("tag toggle sends the delta; tag-or-create carries the typed name under a minted id", async () => {
    const { fake, live } = await scene();
    expect(await live.actions.tagCreate("m1", "Invoices")).toBe(true);
    const created = JSON.parse(wire(fake, "POST", "/messages/m1/tags")[0]!.body) as {
      tagId: string; name?: string; assigned: boolean;
    };
    expect(created.name).toBe("Invoices");
    expect(created.assigned).toBe(true);
    expect(created.tagId).toMatch(/^00000000-0000-4000-8000-/);
    expect(live.toasts).toContain(Copy.tagTagged("Invoices"));

    // The next drain carries the tag row; creating the same name again TOGGLES, never 409s.
    await live.engine.syncOnce();
    expect(await live.actions.tagCreate("m1", "invoices")).toBe(true);
    const second = JSON.parse(wire(fake, "POST", "/messages/m1/tags")[1]!.body) as { tagId: string; name?: string };
    expect(second.name).toBeUndefined();
    expect(second.tagId).toBe(created.tagId);
    live.store.close();
    fake.server.close();
  });
});

describe("delete — DELETE /messages/:id, to the provider's Trash, never an expunge", () => {
  it("dispatches the delete and the tombstone drops the row from the mirror at once", async () => {
    const { fake, live } = await scene();
    expect(live.engine.read().get<EngineMessage>("message", "m1")).toBeDefined();
    expect(await live.actions.deleteMessage("m1")).toBe(true);
    // The wire verb is the contract's own — no move, no expunge-shaped call.
    expect(wire(fake, "DELETE", "/messages/m1")).toHaveLength(1);
    // The optimistic tombstone: the row is out of every living view, not refiled.
    expect(live.engine.read().get<EngineMessage>("message", "m1")).toBeUndefined();
    expect(live.toasts).toContain(Copy.toastDeleted);
    expect(live.toasts).not.toContain(Copy.deleteFailed);
    live.store.close();
    fake.server.close();
  });

  it("a refusal (the no-Trash 422) rolls the row back whole, with the failure sentence", async () => {
    const { fake, live } = await scene();
    fake.failNext("DELETE", "/messages/m1");
    expect(await live.actions.deleteMessage("m1")).toBe(false);
    // The rollback restores the row — a delete the server refused did not happen anywhere.
    expect(live.engine.read().get<EngineMessage>("message", "m1")).toBeDefined();
    expect(live.toasts).toContain(Copy.deleteFailed);
    live.store.close();
    fake.server.close();
  });

  /** The same door for Delete — the fix is the adapter's, so one verb cannot hold it alone. */
  it("a delete the server queues for the organizer says so, and the message stays", async () => {
    const { fake, live } = await scene();
    fake.queueNextForOrganizer("DELETE", "/messages/m1");

    expect(await live.actions.deleteMessage("m1")).toBe(true);

    expect(live.toasts).toContain(Copy.toastDeleteQueued("Studio laptop"));
    expect(live.toasts, "the phone reported a delete nobody made").not.toContain(Copy.toastDeleted);
    expect(live.engine.read().get<EngineMessage>("message", "m1")).toBeDefined();
    expect(live.engine.organizerRequests()).toHaveLength(1);
    live.store.close();
    fake.server.close();
  });

  it("a message the mirror no longer holds is refused locally — nothing on the wire", async () => {
    const { fake, live } = await scene();
    expect(await live.actions.deleteMessage("gone")).toBe(false);
    expect(wire(fake, "DELETE", "/messages/gone")).toHaveLength(0);
    live.store.close();
    fake.server.close();
  });
});

describe("the codex round-1 fixes, on the wire", () => {
  it("reading a RESURFACED message on screen sends it AS A GLANCE — the label travels, no failure toast", async () => {
    // Owner ruling 2026-08-26: reading a resurfaced message STICKS. The reader's involuntary read
    // goes to the server labelled `via: "glance"` — the route marks read WITHOUT spending the
    // pin — instead of being skipped client-side (the skip left the row flipping back to unread).
    // In the Ohbox the open itself reads nothing; the reader's thread-read rule does.
    const { fake, live } = await scene((f) =>
      f.addMessage({
        ...dto("r1", { subject: "Pinned" }),
        triage: { messageId: "r1", state: "resurfaced", bubbleUpAt: null, setAt: "2026-08-20T09:00:00Z", updatedAt: "2026-08-20T09:00:00Z" },
      } as unknown as ReturnType<typeof dto>),
    );
    expect(await live.actions.openMessage("r1")).toBe(true);
    expect(wire(fake, "PATCH", "/messages"), "the Ohbox open reads nothing by itself").toHaveLength(0);
    await live.actions.markGlanced(["r1"]);   // the reader's rule, with the message on screen
    const glance = wire(fake, "PATCH", "/messages");
    expect(glance).toHaveLength(1);
    expect(glance[0]!.body.includes("r1")).toBe(true);
    expect(glance[0]!.body.includes("glance"), "the label must be on the request, or the pin is spent").toBe(true);
    expect(live.toasts).toEqual([]);
    // …and the deliberate release still spends it: Done files it read.
    expect(await live.actions.resurfaceDone("r1")).toBe(true);
    expect(wire(fake, "PATCH", "/messages").length).toBeGreaterThan(1);
    live.store.close();
    fake.server.close();
  });

  it("an Ohbox open reads nothing; the reader's read is a glance — via rides the mutation", async () => {
    const { fake, live } = await scene();
    await live.actions.openMessage("m1");
    expect(wire(fake, "PATCH", "/messages")).toHaveLength(0);
    await live.actions.markGlanced(["m1"]);
    const patch = wire(fake, "PATCH", "/messages");
    expect(patch).toHaveLength(1);
    expect(patch[0]!.body.includes("m1")).toBe(true);
    expect(patch[0]!.body.includes("glance")).toBe(true);
    live.store.close();
    fake.server.close();
  });

  it("the row carries BOTH locations, and the panel is built from the presented one", async () => {
    // A screened-out sender's undecided-residence mail is PRESENTED on the shelf while it
    // physically sits in INBOX — the consent cutline's one projection. The row used to
    // carry the physical folder alone and the panel filtered on it, so the pile the reader was
    // looking at was offered back to them and the place they wanted was withheld.
    const fake = mailServer();
    const origin = await listen(fake.server);
    // A screen-out since ARCH-R902: only a DENY rule still shows an unmoved INBOX letter elsewhere.
    fake.addRule(ruleDto("r-reads", "sender", "reader@fake.test", "ohmail/Screened"));
    fake.addMessage(dto("p1", { from: { name: "R", address: "reader@fake.test" }, folder: "INBOX" }));
    const live = await liveOn(fake, origin);
    const { liveMessage: msgOf } = await import("../src/state/live");
    const seen = msgOf(live.engine, "p1", { now: new Date(), zone: "UTC" })!;
    expect(seen.folder, "a move mutation is still measured against the filed folder").toBe("INBOX");
    expect(seen.presentedFolder).toBe("ohmail/Screened");
    expect(moveTargetsFor(seen)).toEqual(["ohbox", "reads", "receipts", "spam"]);
    live.store.close();
    fake.server.close();
  });

  it("deciding a WAITING sender leaves the subject's mail past the gate to the server's pass", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("g2", { from: { name: "K", address: "knock2@door.test" }, folder: "ohmail/Screener" }));
    fake.addMessage(dto("g3", { from: { name: "K", address: "knock2@door.test" }, folder: "INBOX" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("g2", "reads", "sender")).toBe(true);
    const decide = wire(fake, "POST", "/screener/g2");
    expect(decide).toHaveLength(1);
    // THE-CLIENTS-FIFTY: the decide carries the past-mail answer and the pass moves `g3`; the
    // phone moves neither row itself (a move would be unawaited, so the window is waited out).
    expect((JSON.parse(decide[0]!.body) as { applyRetro?: boolean }).applyRetro).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(wire(fake, "POST", "/messages/g3/move")).toHaveLength(0);
    expect(wire(fake, "POST", "/messages/g2/move")).toHaveLength(0);
    live.store.close();
    fake.server.close();
  });

  it("a send the server never answered is QUEUED, said honestly — never announced as sent", async () => {
    const { fake, live } = await scene();
    // The server goes away between the sync and the send: a transport failure is retryable,
    // so the intent stands on the engine's queue under its Idempotency-Key.
    await new Promise<void>((r) => fake.server.close(() => r()));
    const result = await live.actions.sendReply("m1", "Into the void", false);
    // `queued` — the composer LOCKS on this outcome (a second Send would be a second
    // Idempotency-Key); the intent stands on the engine's queue for the reconnect flush,
    // and the result carries the KEY the composer's settle effect follows in the ledger.
    expect(result.outcome).toBe("queued");
    expect(live.engine.pendingMutations().some((m) => m.key === result.key)).toBe(true);
    expect(live.toasts).toContain(Copy.replyQueued);
    expect(live.toasts).not.toContain(Copy.replySent);
    expect(live.engine.pendingMutations().length).toBeGreaterThan(0);
    live.store.close();
  });

  it("an UNVERIFIED send locks, never re-arms — the check-Sent sentence, not 'try again'", async () => {
    const { fake, live } = await scene();
    fake.unverifiedNextSend();
    const result = await live.actions.sendReply("m1", "Did this leave?", false);
    // The server could not say whether the message left; a fresh-key retry is the duplicate
    // door, so the outcome is its own locked state with its own sentence.
    expect(result.outcome).toBe("unverified");
    expect(live.toasts).toContain(Copy.replyUnverified);
    expect(live.toasts).not.toContain(Copy.replySent);
    expect(live.toasts).not.toContain(Copy.replyFailed);
    live.store.close();
    fake.server.close();
  });

  it("a blip is retried in place — queued once, confirmed on the immediate flush", async () => {
    const { fake, live } = await scene();
    // One 500 on the draft create: retryable, so the send queues — and the in-place flush
    // replays it (same key) against a server that is back, landing without a queued phase.
    fake.failNextStatus("POST", "/drafts", 500);
    expect((await live.actions.sendReply("m1", "Second try lands", false)).outcome).toBe("sent");
    expect(live.toasts).toContain(Copy.replySent);
    expect(wire(fake, "POST", "/drafts").length).toBe(2);
    live.store.close();
    fake.server.close();
  });
});

describe("the forward field's recipient parsing", () => {
  it("display-named entries parse; one bad entry refuses the whole set", async () => {
    const { parseRecipients } = await import("../src/state/live");
    expect(parseRecipients("Alice <alice@example.org>, bob@example.org")).toEqual([
      { name: "Alice", address: "alice@example.org" },
      { name: null, address: "bob@example.org" },
    ]);
    // A malformed second entry refuses EVERYTHING — never a silently narrowed audience.
    expect(parseRecipients("alice@example.org, bob.example.org")).toBeNull();
    // A quoted display name keeps its comma — one entry, not a refused split.
    expect(parseRecipients('"Doe, Alice" <alice@example.org>')).toEqual([
      { name: "Doe, Alice", address: "alice@example.org" },
    ]);
    expect(parseRecipients("")).toEqual([]);
  });
});

describe("screening from the open message — the webapp's rule ladder", () => {
  it("a standing same-kind rule is retargeted, never duplicated; the press moves only the letter it was made on", async () => {
    const { fake, live } = await scene();
    expect(await live.actions.screenSender("m1", "reads", "sender")).toBe(true);
    // The allow rule (sender → INBOX) is the standing row: PATCH, not a second POST /rules.
    const retarget = fake.seen.filter((r) => r.method === "PATCH" && r.url === "/rules/r-allow");
    expect(retarget).toHaveLength(1);
    expect((JSON.parse(retarget[0]!.body) as { destination: string }).destination).toBe(FOLDER_OF_VIEW.reads);
    expect(wire(fake, "POST", "/rules")).toHaveLength(0);
    // THE-CLIENTS-FIFTY: the retarget asks the pass for the rest of the mail already here; the
    // phone moves exactly the letter pressed on (RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX), and it
    // never stands in the Ohbox again.
    await new Promise((r) => setTimeout(r, 500));
    expect(wire(fake, "POST", "/messages/m1/move")).toHaveLength(1);
    expect(fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/move"))).toHaveLength(1);
    expect(standsInOhbox(presentedOf(live.engine.read(), new Date(), false), "m1")).toBe(false);
    live.store.close();
    fake.server.close();
  });

  it("no standing rule means ONE rule_create with applyRetro", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m9", { from: { name: "New", address: "new@fresh.test" }, folder: "ohmail/News" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("m9", "receipts", "domain")).toBe(true);
    const creates = wire(fake, "POST", "/rules").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ kind: "domain", match: "fresh.test", destination: FOLDER_OF_VIEW.receipts });
    live.store.close();
    fake.server.close();
  });

  it("a sender still waiting at the gate is decided, not ruled beside the gate", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("g1", { from: { name: "Knock", address: "knock@door.test" }, folder: "ohmail/Screener" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("g1", "ohbox", "sender")).toBe(true);
    expect(wire(fake, "POST", "/screener/g1")).toHaveLength(1);
    expect(wire(fake, "POST", "/rules")).toHaveLength(0);
    live.store.close();
    fake.server.close();
  });
});

/**
 * ── 0.19: THE PAST-MAIL ANSWER TRAVELS FROM THE PHONE TOO ────────────────────────────────
 *
 * The phone sent a hard `applyRetro: true` with nothing on screen saying so, on every path: a
 * promise the person could neither read nor decline. The sheet now carries the switch, and these
 * assert what reaches the WIRE for each answer — including the two paths that had no way to say
 * it at all, the retarget and the rule that already points at the destination.
 */
describe("applying the rule to past mail, from the phone", () => {
  it("declining it still writes the rule, and says so on the wire", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m9", { from: { name: "New", address: "new@fresh.test" }, folder: "ohmail/News" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("m9", "receipts", "sender", false)).toBe(true);
    const creates = wire(fake, "POST", "/rules").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ match: "new@fresh.test", applyRetro: false });
    live.store.close();
    fake.server.close();
  });

  it("a retarget carries the answer — the path that could not express it before", async () => {
    const { fake, live } = await scene();
    expect(await live.actions.screenSender("m1", "reads", "sender", false)).toBe(true);
    const patch = wire(fake, "PATCH", "/rules/r-allow");
    expect(patch).toHaveLength(1);
    expect(JSON.parse(patch[0]!.body) as Record<string, unknown>)
      .toMatchObject({ destination: FOLDER_OF_VIEW.reads, applyRetro: false });
    live.store.close();
    fake.server.close();
  });

  it("a rule already at the destination is RE-ARMED when the answer is yes, and left alone when it is no", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    // The person's own rule: over an inferred one the OFF press claims it (REVIEW-026 HIGH 1,
    // `rule-overlay-provenance.test.ts`), which is not this case's question.
    fake.addRule({ ...ruleDto("r-standing", "sender", "sender@fake.test", "INBOX"), provenance: "manual" });
    fake.addMessage(dto("m1", { subject: "Welcome" }));
    const live = await liveOn(fake, origin);

    // OFF: a habit-click writes nothing at all — no rule, no re-arm.
    expect(await live.actions.screenSender("m1", "ohbox", "sender", false)).toBe(true);
    expect(wire(fake, "PATCH", "/rules/r-standing")).toHaveLength(0);
    expect(wire(fake, "POST", "/rules")).toHaveLength(0);

    // ON: the standing rule is asked for the backlog, at the destination it already has.
    expect(await live.actions.screenSender("m1", "ohbox", "sender", true)).toBe(true);
    const patch = wire(fake, "PATCH", "/rules/r-standing");
    expect(patch).toHaveLength(1);
    expect(JSON.parse(patch[0]!.body) as Record<string, unknown>)
      .toMatchObject({ destination: "INBOX", applyRetro: true });
    live.store.close();
    fake.server.close();
  });

  it("the gate carries it too, on the decision that promotes the rule", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("g2", { from: { name: "Knock", address: "knock@door.test" }, folder: "ohmail/Screener" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("g2", "reads", "sender", false)).toBe(true);
    const decide = wire(fake, "POST", "/screener/g2");
    expect(decide).toHaveLength(1);
    expect(JSON.parse(decide[0]!.body) as Record<string, unknown>)
      .toMatchObject({ decision: "yes", applyRetro: false });
    live.store.close();
    fake.server.close();
  });

  it("the default is ON, and the default is what the sheet sends", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m8", { from: { name: "New", address: "new@fresh.test" }, folder: "ohmail/News" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("m8", "receipts", "sender")).toBe(true);
    const creates = wire(fake, "POST", "/rules").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(creates[0]).toMatchObject({ applyRetro: true });
    live.store.close();
    fake.server.close();
  });

  /**
   * THE SWITCH IS ON THE SHEET AND WIRED TO THE DISPATCH. There is no React Native renderer in
   * this workspace (`send-later-not-on-this-phone.test.ts` records it), so what a mount would have
   * added — is the control actually wired — is read off the file. Needles are CODE, never comment
   * prose: the switch's role and checked state, and the argument reaching `screenSender`.
   */
  it("the screening sheet renders the switch and hands its value to the dispatch", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src/ui/MessageActions.tsx"),
      "utf8",
    );
    expect(src, "the past-mail option is not a switch a driver can press or read")
      .toContain('accessibilityRole="switch"');
    expect(src).toContain("accessibilityState={{ checked: applyRetro }}");
    expect(src, "the sheet's own state must reach the action, not a literal")
      .toContain("w.actions.screenSender(m.id, dest, scope, applyRetro)");
    expect(src, "the default is ON").toContain("useState(true)");
  });

  it("the sheet's caption follows the answer, and never claims mail simply moves", () => {
    // The old single sentence promised "what is already here moves", which the pass does not do —
    // it re-evaluates and skips anything the person already acted on.
    expect(Copy.screeningNoteRetro("@x.test")).toContain("applies the rule to the rest of the mail it has already filed");
    expect(Copy.screeningNoteRetro("@x.test")).toContain("left alone");
    expect(Copy.screeningNote("@x.test")).toContain("The rest of their mail here stays where it is");
    // The press files the letter pressed on now, on either answer, and the caption says so first.
    for (const s of [Copy.screeningNote("@x.test"), Copy.screeningNoteRetro("@x.test")]) expect(s).toMatch(/^This message moves there now\./);
    for (const s of [Copy.screeningNote("@x.test"), Copy.screeningNoteRetro("@x.test")]) {
      expect(s, "no sentence may promise that the backlog simply moves").not.toContain("is already here moves");
    }
    expect(Copy.screeningRetroToggle).toBeTruthy();
  });
});
