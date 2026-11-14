import { describe, expect, it } from "vitest";
import { forwardEnvelopePlan, forwardSend } from "../app/shell/forward-send";
import { canSend, sendKeyOf, inlineForwardKey, COMPOSE_SEND_KEY } from "@ohmail/app-logic/writing/mail-send";
import { activeFormatLocale, setActiveFormatZone } from "../app/shell/locale";
import type { EngineMessage } from "@ohmail/client-engine";

/**
 * THE FORWARD'S PLAN AND WIRE — the pure halves of the inline forward, pinned key by key.
 *
 * `InlineReply` judges the Send lock with these functions and `AppShell.sendReply`'s forward
 * arm builds the mutation from them; these tests are what keeps that one derivation honest.
 * The lane tests pin `sendKeyOf`'s surface argument: a forward is ONE mutation shape sent
 * from TWO surfaces (the compose form and the thread's dock), and the lane is what keeps the
 * dock's "Sending…", its scratch-clear and its settle off the compose form's — see
 * `mail-send.ts` for the cleanup that branches on it.
 */

const parent = { id: "orig-1", subject: "Terrace numbers" } as Pick<EngineMessage, "id" | "subject">;

describe("forwardEnvelopePlan — recipients are the user's, never derived", () => {
  it("untouched is the REFUSABLE empty set, not a derivation from the parent", () => {
    const plan = forwardEnvelopePlan(null, ["me@own.test"]);
    expect(plan.to).toEqual([]);
    expect(plan.cc).toBeNull();
    expect(plan.bcc).toBeNull();
    // …and `canSend` refuses exactly that shape: no recipient, no send.
    const m = forwardSend(parent, { body: "note", mailboxId: "mb1", plan });
    expect(canSend({ phase: "idle" }, m)).toBe(false);
  });

  it("an edit parses through the compose parser — a valid To unlocks, a typo empties the whole envelope", () => {
    const good = forwardEnvelopePlan({ to: "a@b.test, ", cc: "", bcc: "" }, []);
    expect(good.to).toEqual([{ name: null, address: "a@b.test" }]);
    expect(canSend({ phase: "idle" }, forwardSend(parent, { body: "note", mailboxId: "mb1", plan: good }))).toBe(true);

    const typo = forwardEnvelopePlan({ to: "a@b.test, not-an-address", cc: "", bcc: "" }, []);
    expect(typo.to, "the whole-envelope-or-nothing rule, same as a reply edit").toEqual([]);
    expect(typo.invalid.to).toContain("not-an-address");
  });
});

describe("forwardSend — the wire, key by key", () => {
  it("carries forwardOf and Fwd:, never inReplyTo; optional keys ride only when present", () => {
    const plan = forwardEnvelopePlan({ to: "a@b.test, ", cc: "", bcc: "" }, []);
    setActiveFormatZone("Europe/Zurich");
    const m = forwardSend(parent, { body: "note", mailboxId: "mb1", plan });
    setActiveFormatZone(null);
    expect(m).toEqual({
      kind: "mail_send",
      inReplyTo: null,
      forwardOf: "orig-1",
      // The reader's clock, so the quoted header names the original's date as the rows read it.
      forwardClock: { zone: "Europe/Zurich", locale: activeFormatLocale() },
      subject: "Fwd: Terrace numbers",
      body: "note",
      mailboxId: "mb1",
      to: [{ name: null, address: "a@b.test" }],
    });

    // No mailbox resolved ⇒ the key stays OFF the wire and `canSend` keeps Send locked —
    // a forward has no parent-derived sender the way `enrich` gives a reply one.
    const bare = forwardSend(parent, { body: "note", plan });
    expect("mailboxId" in bare).toBe(false);
    expect(canSend({ phase: "idle" }, bare)).toBe(false);
  });
});

/**
 * ── A FORWARD'S BODY IS OPTIONAL, AND A REPLY'S IS NOT ────────────────────────────────────
 *
 * Reported from real use: *"forwarding a mail enforces a message, a fwd mail must also be able
 * to be sent without a message."* `canSend`'s empty-body refusal was written for a REPLY, where
 * an empty body means the send carries nothing at all; on a forward the forwarded message IS the
 * content, and the note above it is the optional part. The refusal made the common case — pass
 * this along, no comment — unreachable from the one surface that offers it.
 *
 * The discriminator is `forwardOf`, which is exclusive with `inReplyTo` by construction
 * (`types.ts`), so nothing else in the predicate has to change and no caller passes a flag.
 * Every OTHER refusal still applies to a forward: no recipient, no sending mailbox, a send
 * already in flight.
 */
describe("canSend — a forward may be sent with no note of its own", () => {
  const addressed = forwardEnvelopePlan({ to: "a@b.test, ", cc: "", bcc: "" }, []);

  it("an EMPTY note sends — the forwarded message is the message", () => {
    const m = forwardSend(parent, { body: "", mailboxId: "mb1", plan: addressed });
    expect(canSend({ phase: "idle" }, m)).toBe(true);
  });

  it("…and so does a note that is only whitespace — the same emptiness, spelled differently", () => {
    const m = forwardSend(parent, { body: "   \n\t ", mailboxId: "mb1", plan: addressed });
    expect(canSend({ phase: "idle" }, m)).toBe(true);
  });

  it("a REPLY with an empty body is still refused — the rule is narrowed, not deleted", () => {
    // The reason the refusal exists at all: the server accepts a blank body and would post it,
    // and a reply with no body carries nothing whatsoever to the person reading it.
    expect(canSend({ phase: "idle" }, { kind: "mail_send", inReplyTo: "msg-9", body: "" })).toBe(false);
    expect(canSend({ phase: "idle" }, { kind: "mail_send", inReplyTo: "msg-9", body: "  " })).toBe(false);
  });

  it("a COMPOSE with an empty body is still refused — a forward is the only exemption", () => {
    expect(canSend(
      { phase: "idle" },
      { kind: "mail_send", inReplyTo: null, body: "", mailboxId: "mb1", to: [{ name: null, address: "a@b.test" }] },
    )).toBe(false);
  });

  it("the OTHER refusals still bind an empty forward — recipients, mailbox, and a send in flight", () => {
    // No recipient: the untouched plan's refusable empty set.
    expect(canSend(
      { phase: "idle" },
      forwardSend(parent, { body: "", mailboxId: "mb1", plan: forwardEnvelopePlan(null, []) }),
    )).toBe(false);
    // No sending mailbox resolved.
    expect(canSend({ phase: "idle" }, forwardSend(parent, { body: "", plan: addressed }))).toBe(false);
    // Already sending — a second press mints a second reservation, which is a second delivery.
    const m = forwardSend(parent, { body: "", mailboxId: "mb1", plan: addressed });
    expect(canSend({ phase: "sending" }, m)).toBe(false);
    expect(canSend({ phase: "queued" }, m)).toBe(false);
  });

  it("`forwardOf: null` is NOT a forward — the exemption reads the field, not the key's presence", () => {
    // The wire types `forwardOf?: string | null`, so a null is expressible; it means "not a
    // forward" and must keep the empty-body refusal it would otherwise walk around.
    expect(canSend(
      { phase: "idle" },
      { kind: "mail_send", inReplyTo: null, forwardOf: null, body: "", mailboxId: "mb1", to: [{ name: null, address: "a@b.test" }] },
    )).toBe(false);
  });
});

describe("sendKeyOf — the lane derives from the mutation plus, at most, the surface", () => {
  it("a reply lands on the message it answers, whatever the surface says", () => {
    const m = { kind: "mail_send", inReplyTo: "msg-9", body: "x" } as Parameters<typeof sendKeyOf>[0];
    expect(sendKeyOf(m)).toBe("msg-9");
    expect(sendKeyOf(m, "inline")).toBe("msg-9");
  });

  it("a forward lands on the compose surface by default and on its own fwd: lane from the dock", () => {
    const plan = forwardEnvelopePlan({ to: "a@b.test, ", cc: "", bcc: "" }, []);
    const m = forwardSend(parent, { body: "note", mailboxId: "mb1", plan });
    // The compose form's forward keeps the lane it has always had…
    expect(sendKeyOf(m)).toBe(COMPOSE_SEND_KEY);
    // …and the dock's gets its own, so neither surface's button, scratch or settle can land
    // on the other's. The lane doubles as the scratch suffix — one string, one meaning.
    expect(sendKeyOf(m, "inline")).toBe(inlineForwardKey("orig-1"));
    expect(inlineForwardKey("orig-1")).toBe("fwd:orig-1");
  });
});
