/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { settleEditor } from "./_first-paint.js";
import { SENT_BEAT_MS } from "../app/shell/mail-send";
import type { SendState } from "../app/shell/mail-send";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;

/**
 * WHAT AN EDITOR SAYS ABOUT A SEND THAT HAS NOT ARRIVED.
 *
 * The gap row's acceptance is two-sided — "either sending works, or the control does not
 * render as an available primary action" — and the trap on the working side is subtler than
 * the trap on the inert one: a send that is queued, or one the server could not confirm,
 * must never read as a delivered one. That is a claim about RENDERED TEXT and about which
 * control is pressable, so it is asserted here on the rendered component rather than
 * inferred from the state machine that feeds it.
 *
 * `inline-reply.test.ts` and `compose-send.test.ts` drive the happy paths through the whole
 * shell; the failure phases cannot be reached from the demo adapter (the fixtures world never
 * rejects), and mounting a component with each phase is the honest way to pin them.
 * `mail-send.test.ts` in the client-engine package proves the phases are the ones the wire
 * actually produces.
 *
 * A later change generalized `useReplySend` into `useMailSend` — one machine, two surfaces — so the
 * `canSend` table below covers both callers, and the state-machine cases assert that the lock
 * and the empty guard are properties of SENDING rather than of the reply editor.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T09:00:00.000Z");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const message: EngineMessage = {
  id: "m1",
  accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Werkstatt-Besuch?",
  from: { name: "Lena", address: "lena@atelier.example" },
  to: [], cc: [],
  date: NOW.toISOString(),
  folder: "INBOX",
  snippet: "…", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none",
  updatedAt: NOW.toISOString(),
};

/** What the held reply's two verbs reported, newest last — reset by every `mount`. */
let heldAnswers: string[] = [];

async function mount(
  send: SendState,
  text = "Donnerstag passt.",
  heldResolve: { draftId: string; onResolve: (id: string, outcome: string) => void } | null = null,
): Promise<void> {
  heldAnswers = [];
  await unmount();
  const { InlineReply } = await import("../app/shell/InlineReply.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(InlineReply as never, {
          // No `context` and no `now` since that change: the editor renders no mail, so it needs
          // neither the conversation nor a clock to format one with.
          // The editor holds BOTH halves now. Plain text with no markup — `html: ""` is what
          // a message nobody formatted looks like, and it is the shape every assertion below
          // is about.
          message, value: { text, html: "" }, send,
          onChange: () => {}, onClose: () => {}, onSend: () => {},
          /* THE HELD REPLY'S WAY OUT, handed in the way the shell hands it: the row the hold is
             about, and the callback that dispatches the reader's answer. `null` is every mount
             that is not about a held row, which is every other case in this file. */
          ...(heldResolve === null ? {} : { heldResolve }),
        } as never),
      }),
    );
  });
  // The reply's editor is behind `RichEditorLazy` — one seam, one helper.
  await settleEditor();
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

afterEach(unmount);

/**
 * The send verb, found by its VARIANT rather than by its label.
 *
 * The label used to be the locator (`/^(Send|Sending)/`) and that stopped working the moment the
 * button gained its own states: a `queued` send says "Queued" and a delivered one says "Sent", so
 * a label-matched finder returned `undefined` and the case died reading `.disabled` of nothing —
 * which reads as a crash in the editor rather than as a stale locator. The primary variant is the
 * one durable fact about this control; Cancel beside it is a ghost.
 */
const sendBtn = (): HTMLButtonElement =>
  host!.querySelector<HTMLButtonElement>(".reply-actions .btn.primary")!;
const status = (): HTMLElement | null => host!.querySelector<HTMLElement>(".send-status");
/** The editable surface of the rich editor — `.reply-editor` is the frame around it now. */
const surface = (): HTMLElement => host!.querySelector<HTMLElement>(".reply-editor .rte-surface")!;

/**
 * No phase may produce copy a hurried reader takes for a delivery.
 *
 * The lookbehind is the whole point: "Not sent yet" and "was not delivered" are exactly the
 * strings this slice wants, and a bare `/sent|delivered/` would ban them while happily
 * passing "Sent." So the guard is against an UNNEGATED claim, which is the thing that would
 * actually mislead. "Sent folder" is exempt for the same reason: there it is the name of an
 * IMAP folder the user is being told to go and look in, which is the opposite of a claim.
 */
/* "not sure this was sent" is the one negated form admitted: the engine saying it does not know is
   not a claim of delivery, and the held sentence says exactly that. Everything else that spells
   `sent` without a `not` in front of it still reads as a claim. */
const CLAIMS_DELIVERY = /(?<!\bnot (?:sure (?:this|it) was )?)\b(sent(?!\s+folder)|delivered|on its way)\b/i;

describe("the reply editor's send states", () => {
  it("idle — nothing to report, and Send is live", async () => {
    await mount({ phase: "idle" });
    expect(status()).toBeNull();
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().textContent).toContain("Send");
  });

  it("sending — locked, busy, and the text is not editable out from under the request", async () => {
    await mount({ phase: "sending" });
    expect(sendBtn().disabled).toBe(true);
    expect(sendBtn().getAttribute("aria-busy")).toBe("true");
    // `readOnly` is a textarea's word for it; a `contenteditable` says `contenteditable="false"`,
    // which is what `RichEditor`'s `editable` prop sets. The claim is unchanged: mid-send the
    // text is still on screen and still cannot be edited out from under the request.
    expect(surface().getAttribute("contenteditable")).toBe("false");
    // And the toolbar goes with it — a live formatting button would edit a document the caret
    // cannot reach.
    expect([...host!.querySelectorAll<HTMLButtonElement>(".rte-b")].every((b) => b.disabled))
      .toBe(true);
    expect(status()!.textContent).toContain("Sending your reply");
  });

  it("queued — says NOT sent, keeps the text, and stays locked", async () => {
    // Locked is the load-bearing half: a second press mints a second Idempotency-Key, which
    // is a second reservation, which is a second delivery to a real person.
    await mount({ phase: "queued" });
    expect(sendBtn().disabled).toBe(true);
    expect(status()!.textContent).toContain("Not sent yet");
    expect(status()!.textContent).not.toMatch(CLAIMS_DELIVERY);
    expect(surface().textContent).toContain("Donnerstag passt.");
  });

  it("the button carries the phase the stylesheet paints — and only for the phases it paints", async () => {
    // `data-send` is the whole hand-off to `packages/ui`: it keeps the accent fill while the
    // control is natively disabled and runs the band along its foot. Written from the lane's
    // phase, never inferred from `disabled`, because "locked" is true of states that must look
    // completely different — mid-send and refused-because-empty are both disabled buttons.
    await mount({ phase: "sending" });
    expect(sendBtn().getAttribute("data-send")).toBe("sending");
    expect(sendBtn().textContent).toContain("Sending");

    await mount({ phase: "sent" });
    expect(sendBtn().getAttribute("data-send")).toBe("sent");
    expect(sendBtn().textContent).toContain("Sent");

    await mount({ phase: "queued" });
    expect(sendBtn().getAttribute("data-send")).toBe("queued");
    expect(sendBtn().textContent).toContain("Queued");

    // Back to rest: Send is the retry, and an attribute the stylesheet has no rule for would be
    // a claim in the DOM that nothing is making.
    await mount({ phase: "failed" });
    expect(sendBtn().getAttribute("data-send")).toBeNull();
    await mount({ phase: "idle" });
    expect(sendBtn().getAttribute("data-send")).toBeNull();
  });

  it("the server's accepted-pending send says the product HAS it; the transport's does not", async () => {
    // The two `queued` states are one flag apart and one sentence apart, and the sentence is a
    // claim about somebody's mail. Asserted on the RENDERED editor, not only on the pure
    // component, because this is the surface the reader is looking at.
    await mount({ phase: "queued", accepted: true });
    expect(status()!.textContent).toContain("Still sending");
    expect(status()!.textContent).not.toMatch(CLAIMS_DELIVERY);

    await mount({ phase: "queued" });
    expect(status()!.textContent).toContain("Not sent yet");
    expect(
      status()!.textContent,
      "a request that may never have arrived was reported as still on its way",
    ).not.toContain("Still sending");
  });

  it("unverified — the warning stands and Send is LOCKED", async () => {
    /**
     * REWRITTEN BY RULING. This asserted the opposite — that Send comes back — on the reasoning
     * that "the server refuses every further send of that draft, so locking would brick this
     * reply". The premise was false: the compose shed the draft id before re-sending, so the next
     * press created a NEW draft under a NEW key, and server uniqueness is
     * `(account_id, idempotency_key)`. Nothing collided, and both reservations could deliver the
     * same message.
     *
     * `unverified` is terminal-UNKNOWN, not failed. The send may already have gone, so a retry is
     * safe only if it reuses the key it went under. Nothing may mint a fresh one; the send parks
     * with the warning in front of the person. This test was asserting the defect.
     */
    await mount({ phase: "unverified" });
    expect(sendBtn().disabled).toBe(true);
    expect(status()!.textContent).toContain("not sure this was sent");
    expect(status()!.textContent).toContain("Sent folder");
    expect(status()!.className).toContain("warn");
  });

  it("failed — the plain sentence, never the server's wire, and Send is live again", async () => {
    // REWRITTEN BY RULING, 2026-08-21. This used to assert the server's reason rendered
    // verbatim ("Not sent: {reason}"), and that contract is what put "Nicht gesendet:
    // authentication required" — the API middleware's own 401 envelope text — in front of a
    // real subscriber during a deploy blip. The failed line now says the one thing true of
    // every refusal: the draft is kept, and the live Send button beside it is the retry.
    // `send-status-copy.test.tsx` pins the never-the-wire half per class of reason.
    await mount({ phase: "failed", reason: "A prior send under this key failed and was not delivered." });
    expect(sendBtn().disabled).toBe(false);
    expect(status()!.textContent).toContain("Sending didn't work");
    expect(status()!.textContent, "the wire leaked into the sentence").not.toContain("was not delivered");
    expect(status()!.className).toContain("error");
  });

  it("every non-delivered phase is announced, and none of them claims delivery", async () => {
    for (const phase of ["sending", "queued", "unverified", "failed"] as const) {
      await mount({ phase });
      const line = status()!;
      // Out-of-band outcomes: a retry can resolve minutes after focus moved on.
      expect(line.getAttribute("role")).toBe("status");
      expect(line.getAttribute("aria-live")).toBe("polite");
      expect(line.textContent, phase).not.toMatch(CLAIMS_DELIVERY);
    }
  });

  it("an empty body cannot be sent, in any phase where Send is otherwise live — and the press is TOLD why", async () => {
    // `unverified` is no longer in this list because Send is locked there whatever the body
    // says — see the ruling quoted above. It is covered by the lock table instead.
    // The refusal changed shape (FIX-021): nothing written and nothing attached keeps the button
    // PRESSABLE, wearing the reason, and the press earns a sentence instead of sending — the
    // machine-level rows below still prove nothing is dispatched.
    for (const phase of ["idle", "failed"] as const) {
      await mount({ phase }, "   ");
      expect(sendBtn().disabled, `${phase}: an empty reply's Send is refused in words, not dead`).toBe(false);
      expect(sendBtn().getAttribute("aria-disabled"), phase).toBe("true");
      expect(sendBtn().title, phase).toBe("Write something or attach a file.");
      await act(async () => { sendBtn().click(); });
      expect(host!.textContent, `${phase}: the refused press earned no sentence`)
        .toContain("Write something or attach a file.");
    }
  });
});

/**
 * The engine outcome → phase mapping, one row at a time. `mail-send.test.ts` in the
 * client-engine package proves which outcomes the wire produces; this proves each of them
 * arrives at the right thing on screen — the one seam where "queued" could quietly become
 * "sent" with no test noticing.
 */
describe("phaseFor", () => {
  const result = (over: Record<string, unknown>) =>
    ({ id: "i", key: "k", seq: null, ...over }) as never;

  it("confirmed ⇒ idle (the editor is done and closes)", async () => {
    const { phaseFor } = await import("../app/shell/mail-send.js");
    expect(phaseFor(result({ status: "confirmed" })).phase).toBe("idle");
  });

  it("queued ⇒ queued, NEVER idle", async () => {
    const { phaseFor } = await import("../app/shell/mail-send.js");
    const err = { code: "send_in_flight", message: "already in progress", retryable: true };
    expect(phaseFor(result({ status: "queued", error: err })).phase).toBe("queued");
  });

  it("rolled_back + send_unverified ⇒ its OWN phase, not `failed`", async () => {
    // The distinction is the point: `failed` means "definitely not delivered" and invites a
    // retry; `unverified` means "we cannot tell" and must say so instead.
    const { phaseFor } = await import("../app/shell/mail-send.js");
    const err = { code: "send_unverified", message: "We couldn't confirm this send.", retryable: false };
    expect(phaseFor(result({ status: "rolled_back", error: err })).phase).toBe("unverified");
  });

  it("any other rejection ⇒ failed, carrying the server's own words", async () => {
    const { phaseFor } = await import("../app/shell/mail-send.js");
    const err = { code: "send_failed", message: "A prior send under this key failed.", retryable: false };
    const next = phaseFor(result({ status: "rolled_back", error: err }));
    expect(next.phase).toBe("failed");
    expect(next.reason).toBe("A prior send under this key failed.");
  });

  /**
   * `duplicate_send` — the server refused a second copy of a message it already has.
   *
   * Its own phase for the same reason `unverified` has one: `failed` means *nothing went out, try
   * again*, and here something identical may already be in somebody's inbox. The `firstSend` fact
   * rides in the refusal's structured details because the sentence the reader sees depends on it
   * and only the server knows which of the three states applies.
   */
  it("duplicate_send ⇒ its OWN phase, carrying the first send's state", async () => {
    const { phaseFor } = await import("../app/shell/mail-send.js");
    const err = {
      code: "duplicate_send",
      message: "This exact message was already sent from this mailbox at 2026-07-28T12:00:00.000Z.",
      retryable: false,
      details: { firstSend: { status: "sent", at: "2026-07-28T12:00:00.000Z" } },
    };
    const next = phaseFor(result({ status: "rolled_back", error: err }));
    expect(next.phase).toBe("duplicate");
    expect(next.firstSend).toBe("sent");
    expect(next.code).toBe("duplicate_send");
  });

  /**
   * A DUPLICATE REFUSED WHILE THE FIRST ATTEMPT IS STILL RUNNING IS NOT A SETTLED STATE.
   *
   * The server marks that one RETRYABLE, so the engine queues it rather than rolling it back, and
   * the surface reaches `phaseFor` as `queued` — "Not sent yet, ohmail is still trying" — instead of
   * the `duplicate` sentence. That is the honest line: the first attempt can still fail before it
   * reaches the mail server, and then this message has NOT been sent and the retry will send it.
   * Settling on `duplicate` here is how the message is lost while the screen looks calm.
   */
  it("a duplicate whose first attempt is still RUNNING reads as queued, not as a settled duplicate", async () => {
    const { phaseFor } = await import("../app/shell/mail-send.js");
    const err = {
      code: "duplicate_send", message: "…already being sent…", retryable: true,
      details: { firstSend: { status: "pending" } },
    };
    const next = phaseFor(result({ status: "queued", error: err }));
    expect(next.phase).toBe("queued");
    expect(next.accepted, "and NOT 'accepted' — nothing has been accepted for this key").toBeUndefined();
  });

  it("duplicate_send with an unconfirmed first send says so, not `sent`", async () => {
    const { phaseFor } = await import("../app/shell/mail-send.js");
    const err = {
      code: "duplicate_send", message: "…", retryable: false,
      details: { firstSend: { status: "unverified", at: "2026-07-28T12:00:00.000Z" } },
    };
    expect(phaseFor(result({ status: "rolled_back", error: err })).firstSend).toBe("unverified");
  });

  it("duplicate_send with a state this build does not know DROPS it rather than guessing", async () => {
    // A newer server may name a fourth state. The surface then says the one sentence true of all
    // of them; rendering a stranger's token, or throwing, are both worse than degrading.
    const { phaseFor } = await import("../app/shell/mail-send.js");
    for (const details of [
      { firstSend: { status: "teleported" } },
      { firstSend: null },
      { firstSend: "sent" },
      undefined,
      "not an object",
    ]) {
      const err = { code: "duplicate_send", message: "…", retryable: false, details };
      const next = phaseFor(result({ status: "rolled_back", error: err }));
      expect(next.phase, JSON.stringify(details)).toBe("duplicate");
      expect(next.firstSend, JSON.stringify(details)).toBeUndefined();
    }
  });
});

/**
 * `canSend` is the ONE rule behind every consumer: the reply button's `disabled`, the compose
 * button's, both `mod+Enter` bindings, and the state machine's own refusal. It is asserted
 * directly because it used to be two copies: a mutation that deleted the guard inside
 * `useReplySend.send` left every test green, since they all pressed the button. One predicate,
 * one guard, one place it can be broken.
 */
describe("canSend — the reply's rows", () => {
  const cases: Array<[SendState["phase"], string, boolean, string]> = [
    ["idle", "text", true, "the ordinary case"],
    ["idle", "   ", false, "the server accepts a blank body, so we must not"],
    ["sending", "text", false, "a second key is a second delivery"],
    ["queued", "text", false, "the intent is already out there under a key"],
    // RULED: terminal-UNKNOWN, so the send parks. A fresh key after an unverified reservation is
    // a second delivery by construction — the row asserted the defect.
    ["unverified", "text", false, "parked: it may already have gone, and a new key cannot collide"],
    ["failed", "text", true, "definitely not delivered — retry is the right offer"],
    ["failed", "", false, "…but still not an empty one"],
    // A duplicate refusal is answered by EDITING the message, so the button has to stay live —
    // locking it would leave the reader with a refusal and no way to act on it.
    ["duplicate", "text", true, "the way past a duplicate refusal is a change, which needs Send"],
  ];

  for (const [phase, body, expected, why] of cases) {
    it(`${phase} + ${JSON.stringify(body)} ⇒ ${expected} — ${why}`, async () => {
      const { canSend } = await import("../app/shell/mail-send.js");
      // A reply carries no recipient of its own: `Engine.enrich` derives it from the parent, so
      // `inReplyTo` + `body` IS the whole mutation the button judges.
      expect(canSend({ phase }, { kind: "mail_send", inReplyTo: "m1", body })).toBe(expected);
    });
  }
});

/**
 * THE COMPOSE ROWS, which are the whole difference between the two callers.
 *
 * A reply inherits a recipient and a mailbox; a compose has to be given both, and if either is
 * missing the send must not be OFFERED — a Send button on an account with nothing to send from
 * is the inert affordance this slice closes, and a `to: []` reaching the wire costs a `POST
 * /drafts` row before the send answers 400 "draft has no recipients".
 */
describe("canSend — the compose rows", () => {
  const ADDR = [{ name: null, address: "a@example.com" }];
  const cases: Array<[string, Record<string, unknown>, boolean, string]> = [
    ["the ordinary case", { to: ADDR, mailboxId: "mb" }, true, "recipient, mailbox and a body"],
    ["no recipient", { to: [], mailboxId: "mb" }, false, "an empty To is not a send"],
    [
      "a typo'd recipient",
      { to: [], mailboxId: "mb" },
      false,
      "`composePlan` empties `to` when ANY entry fails to parse, so the refusal lives in the mutation",
    ],
    ["no mailbox", { to: ADDR }, false, "nothing to send FROM — the mirror could not name one"],
    ["mailbox is empty string", { to: ADDR, mailboxId: "" }, false, "…and a blank one is not one"],
  ];

  for (const [name, over, expected, why] of cases) {
    it(`${name} ⇒ ${expected} — ${why}`, async () => {
      const { canSend } = await import("../app/shell/mail-send.js");
      const m = { kind: "mail_send", inReplyTo: null, body: "hello", subject: "s", ...over };
      expect(canSend({ phase: "idle" }, m as never)).toBe(expected);
    });
  }

  it("an empty body is refused for a compose too", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    expect(canSend({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: null, body: "  ", to: ADDR, mailboxId: "mb",
    })).toBe(false);
  });
});

/**
 * AN ATTACHMENT IS CONTENT (owner report: "sending just a screenshot to someone requires me to
 * enter text"). The lock is `sendNeedsContent` — empty body AND no attachments — and the surfaces
 * read `sendRefusal` so a refusal can be said. Mutation: drop the attachments term from
 * `sendNeedsContent` (back to the body-only rule) and the first two rows go red.
 */
describe("canSend — an attachment is content", () => {
  const ADDR = [{ name: null, address: "a@example.com" }];
  const FILE = { filename: "shot.png", contentType: "image/png", contentBase64: "aGk=" };

  it("a reply with an attachment and no words sends", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    expect(canSend({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: "m1", body: "  ", attachments: [FILE],
    })).toBe(true);
  });

  it("a compose with an attachment and no words sends", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    expect(canSend({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: null, body: "", to: ADDR, mailboxId: "mb", attachments: [FILE],
    })).toBe(true);
  });

  it("an EXPLICITLY EMPTY attachments list is not content — the two spellings of none agree", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    expect(canSend({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: null, body: "", to: ADDR, mailboxId: "mb", attachments: [],
    })).toBe(false);
  });

  it("sendRefusal names the reason, and a stronger lock outranks the missing word", async () => {
    const { sendRefusal } = await import("../app/shell/mail-send.js");
    // Nothing to send, and that is the stated reason…
    expect(sendRefusal({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: null, body: " ", to: ADDR, mailboxId: "mb",
    })).toBe("needs_content");
    // …unless the lane is held: never "write something" over a send in flight.
    expect(sendRefusal({ phase: "sending" }, {
      kind: "mail_send", inReplyTo: null, body: " ", to: ADDR, mailboxId: "mb",
    })).toBe("locked");
    // Content present but no recipient is the form's own gap, not a content refusal.
    expect(sendRefusal({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: null, body: "", to: [], mailboxId: "mb", attachments: [FILE],
    })).toBe("incomplete");
    // The admitted case answers null — canSend's own truth.
    expect(sendRefusal({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: null, body: "", to: ADDR, mailboxId: "mb", attachments: [FILE],
    })).toBe(null);
  });

  it("a forward never needs content — its content is the forwarded message", async () => {
    const { sendNeedsContent } = await import("../app/shell/mail-send.js");
    expect(sendNeedsContent({ kind: "mail_send", inReplyTo: null, body: "", forwardOf: "m9" })).toBe(false);
    // …and `forwardOf: null` is NOT a forward: the wordless, fileless case still refuses.
    expect(sendNeedsContent({ kind: "mail_send", inReplyTo: null, body: "", forwardOf: null })).toBe(true);
  });
});

/**
 * THE STATE MACHINE ITSELF, not the button in front of it.
 *
 * `canSend` is consulted in two places and the button is the only caller today, so a mutation
 * that stopped `useMailSend.send` from consulting it survived every other test in this file.
 * That guard is the one that matters for any future caller — a keyboard shortcut, a Reply Run
 * step — because none of them go through a `disabled` attribute. A probe component drives the
 * hook directly against a recording engine so the refusal is observable.
 *
 * The compose cases here matter for the same reason twice over: Compose's `mod+Enter` binding
 * and its button both call `onSend`, and neither can be reached through a `disabled` attribute
 * from a test that presses twice inside one tick.
 */
describe("useMailSend refuses on its own, not only via the button", () => {
  interface Recorder {
    mutations: Array<Record<string, unknown>>;
    engine: unknown;
    toasts: string[];
    settled: string[];
    /** What `onSettled` was HANDED beside the key — the settled mutation, draft id included. */
    settledWith: Array<Record<string, unknown> | undefined>;
  }

  function recorder(triage: string | null = null, status = "confirmed"): Recorder {
    const mutations: Array<Record<string, unknown>> = [];
    const toasts: string[] = [];
    const settled: string[] = [];
    const settledWith: Array<Record<string, unknown> | undefined> = [];
    const engine = {
      mutate: async (m: Record<string, unknown>) => {
        mutations.push(m);
        return {
          id: "i", key: `k${mutations.length}`, seq: 1,
          // Only the send itself takes the injected outcome; the follow-up `triage_set` is
          // not what any of these cases is about.
          status: m.kind === "mail_send" ? status : "confirmed",
          ...(status === "queued" ? { error: { code: "send_in_flight", retryable: true } } : {}),
        };
      },
      read: () => ({
        get: () => (triage ? { ...message, triage: { state: triage } } : message),
        list: () => [], entries: () => [], version: () => 1,
      }),
      flushPending: async () => [],
      /* THE FOUR THE HOOK ASKS FOR BESIDE `mutate`/`read`, and they are answered rather than
         omitted because an absent method is a TypeError inside an effect, which React reports as a
         mount failure in every case in the file at once — a shape indistinguishable from a
         regression in the code under test. `hasLateResults` is false on purpose: the mount-time
         adoption pass must not consume the `flushPending` answer these cases hand to `flush`. */
      pendingMutations: () => [],
      subscribe: () => () => { /* nothing here notifies */ },
      hasLateResults: () => false,
    };
    return { mutations, engine, toasts, settled, settledWith };
  }

  type Mut = Record<string, unknown>;
  const reply = (body: string): Mut => ({ kind: "mail_send", inReplyTo: "m1", body });
  const compose = (body: string): Mut => ({
    kind: "mail_send", inReplyTo: null, body, subject: "Hallo",
    to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb",
  });

  /** Mount a probe that exposes the hook's `send`. */
  async function probe(rec: Recorder): Promise<(m: Mut) => void> {
    await unmount();
    const { useMailSend } = await import("../app/shell/mail-send.js");
    let send!: (m: Mut) => void;
    const Probe = (): null => {
      const api = useMailSend(
        rec.engine as never,
        ((m: string) => rec.toasts.push(m)) as never,
        ((key: string, m?: Record<string, unknown>) => {
          rec.settled.push(key);
          rec.settledWith.push(m);
        }) as never,
      );
      send = api.send as unknown as (m: Mut) => void;
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
      }));
    });
    return (m) => send(m);
  }

  /**
   * A PRESS NOW CROSSES A TASK BOUNDARY, so the drain has to as well. `useMailSend.send`
   * acknowledges on screen and defers `engine.mutate` to a later task (`afterPaint`), which a
   * microtask-only drain can never reach: microtasks drain before the task ends. Flushing a
   * zero-delay timer per round is what makes this helper able to observe the send it started.
   */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    }
  };

  /**
   * Run out the CLOSING BEAT a settled send holds its state for (`SENT_BEAT_MS`).
   *
   * `onSettled` — the shell's "close this surface" callback — now fires on that beat rather than
   * on the confirmation, so a case asserting the surface closed has to let it elapse. Real timers
   * in this suite, so it is a real wait; separate from `drain` because a case that wants the
   * delivered state on screen BEFORE the surface closes needs the drain without it.
   */
  const beat = async (): Promise<void> => {
    await act(async () => { await new Promise((r) => { setTimeout(r, SENT_BEAT_MS + 50); }); });
  };

  /**
   * THE TWO DEFECTS A REVIEW FOUND IN THE ACCEPTED-PENDING STATE, pinned from the outside.
   *
   * Both survived the first round because every case constructed `{phase:"queued", accepted:true}`
   * BY HAND and asserted what it renders. Nothing drove the flag through the machine, which is
   * where both defects lived: one in what `absorb` calls, one in what the next answer overwrites.
   */
  async function acceptedProbe(): Promise<{
    send: (m: Mut) => void;
    stateOf: (k: string) => { phase: string; accepted?: true };
    settled: string[];
    goOnline: () => void;
  }> {
    await unmount();
    const { useMailSend } = await import("../app/shell/mail-send.js");
    const settled: string[] = [];
    let api!: { send: (m: Mut) => void; stateOf: (k: string) => { phase: string; accepted?: true } };
    // The FIRST answer is the send route's own 202 (`send_queued`); every later one is the 409
    // a same-key retry gets while the reservation is live (`send_in_flight`). That is the exact
    // sequence a real accepted send produces, and the sequence nothing used to exercise.
    const engine = {
      mutate: async () => ({
        id: "i", key: "k1", seq: 1, status: "queued",
        error: { code: "send_queued", retryable: true },
      }),
      read: () => ({ get: () => message, list: () => [], entries: () => [], version: () => 1 }),
      flushPending: async () => [{
        id: "i", key: "k1", seq: 1, status: "queued",
        error: { code: "send_in_flight", retryable: true },
      }],
      /* THE FOUR THE HOOK ASKS FOR BESIDE `mutate`/`read`, and they are answered rather than
         omitted because an absent method is a TypeError inside an effect, which React reports as a
         mount failure in every case in the file at once — a shape indistinguishable from a
         regression in the code under test. `hasLateResults` is false on purpose: the mount-time
         adoption pass must not consume the `flushPending` answer these cases hand to `flush`. */
      pendingMutations: () => [],
      subscribe: () => () => { /* nothing here notifies */ },
      hasLateResults: () => false,
    };
    const Probe = (): null => {
      api = useMailSend(
        engine as never,
        (() => { /* toasts are another case */ }) as never,
        ((key: string) => { settled.push(key); }) as never,
      ) as never;
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
      }));
    });
    return {
      send: (m) => api.send(m),
      stateOf: (k) => api.stateOf(k),
      settled,
      // The hook flushes immediately on `online` — a real trigger, and the one that does not
      // need the suite to sit through the retry backoff.
      goOnline: () => { window.dispatchEvent(new Event("online")); },
    };
  }

  it("an accepted-pending send NEVER runs onSettled — the shell reads that as a delivery", async () => {
    // `AppShell.onSendSettled` marks the answered message read, steps the
    // Reply Run past the item, drops a drafted alternative and discards a recovery row. Its own
    // docblock says three times that it fires on a confirmation and on nothing else. Calling it
    // for a send whose fate is unknown states "this was answered" about a message that may never
    // have left — which is what the first version of this state did, on a 600 ms beat.
    const p = await acceptedProbe();
    await act(async () => { p.send(reply("Danke!")); });
    await drain();
    expect(p.stateOf("m1").phase).toBe("queued");
    expect(p.stateOf("m1").accepted).toBe(true);

    // Well past the beat a delivery would have closed on.
    await beat();
    await beat();
    expect(
      p.settled,
      "an undelivered send closed the surface — the shell marks the message read on this",
    ).toEqual([]);
  });

  it("the retry that answers in_flight does not turn `accepted` back into `may not have arrived`", async () => {
    // The 202 is said ONCE. Every retry after it is answered 409 `in_flight`, which carries no
    // accepted flag — so a state rebuilt from each answer flipped the line from "the product has
    // this" to "this has not gone yet, we are still trying" five seconds after the press, and
    // stayed there. The request provably DID arrive; there is a committed reservation. That is
    // the two flavours collapsing, running backwards.
    const p = await acceptedProbe();
    await act(async () => { p.send(reply("Danke!")); });
    await drain();
    expect(p.stateOf("m1").accepted).toBe(true);

    await act(async () => { p.goOnline(); });
    await drain();

    expect(p.stateOf("m1").phase, "the lane left the queued state on a retry").toBe("queued");
    expect(
      p.stateOf("m1").accepted,
      "a committed reservation stopped being remembered, so the surface un-said it",
    ).toBe(true);
  });

  it("an empty reply body dispatches NOTHING, even called directly", async () => {
    const rec = recorder();
    const send = await probe(rec);
    await act(async () => { send(reply("   ")); });
    expect(rec.mutations).toEqual([]);
  });

  it("an empty COMPOSE body dispatches NOTHING either", async () => {
    const rec = recorder();
    const send = await probe(rec);
    await act(async () => { send({ ...compose(""), body: "  " }); });
    expect(rec.mutations).toEqual([]);
  });

  it("a compose with NO recipient dispatches nothing — no orphan draft on the wire", async () => {
    const rec = recorder();
    const send = await probe(rec);
    await act(async () => { send({ ...compose("hello"), to: [] }); });
    expect(rec.mutations).toEqual([]);
  });

  it("a compose with no mailbox to send FROM dispatches nothing", async () => {
    const rec = recorder();
    const send = await probe(rec);
    const { mailboxId: _drop, ...noMailbox } = compose("hello");
    await act(async () => { send(noMailbox); });
    expect(rec.mutations).toEqual([]);
  });

  it("a second press while the first is in flight dispatches NOTHING — one key, one delivery", async () => {
    const rec = recorder();
    const send = await probe(rec);
    await act(async () => {
      send(reply("first"));
      send(reply("again"));
    });
    // The dispatch is a task later than the press (`afterPaint`), so the count is only
    // meaningful once that task has run — the drain is what makes the refusal observable.
    await drain();
    expect(rec.mutations.filter((m) => m.kind === "mail_send")).toHaveLength(1);
  });

  it("TWO COMPOSE PRESSES IN ONE TICK are one delivery — the lock is a ref, not state", async () => {
    // THE GUARD the send button paid for, re-asserted on the surface compose added. `disabled` cannot help
    // here: it only exists after the re-render the second call already beat, so a machine that
    // gated on React state would let both presses read `idle`, mint two Idempotency-Keys, make
    // two reservations and deliver the same message to the same stranger twice. Change the
    // `locked` ref in `mail-send.ts` back to a `states[...]` read and this goes to 2.
    const rec = recorder();
    const send = await probe(rec);
    await act(async () => {
      send(compose("Guten Tag"));
      send(compose("Guten Tag"));
    });
    // The dispatch is a task later than the press (`afterPaint`), so the count is only
    // meaningful once that task has run — the drain is what makes the refusal observable.
    await drain();
    expect(rec.mutations.filter((m) => m.kind === "mail_send")).toHaveLength(1);
  });

  it("a QUEUED send stays locked — the intent is already out there under a key", async () => {
    const rec = recorder(null, "queued");
    const send = await probe(rec);
    await act(async () => { send(reply("first")); });
    await drain();
    expect(rec.mutations).toHaveLength(1);

    await act(async () => { send(reply("impatient second press")); });
    expect(rec.mutations).toHaveLength(1);
  });

  it("a confirmed reply clears Answer Later, and says the reply went", async () => {
    const rec = recorder("reply_later");
    const send = await probe(rec);
    await act(async () => { send(reply("Danke!")); });
    await drain();
    expect(rec.mutations.map((m) => m.kind)).toEqual(["mail_send", "triage_set"]);
    expect(rec.mutations[1]).toMatchObject({ messageId: "m1", state: "none" });
    expect(rec.toasts).toContain("Reply sent.");
    await beat();
    expect(rec.settled).toEqual(["m1"]);
  });

  it("a Parked message keeps its state when the reply lands", async () => {
    const rec = recorder("set_aside");
    const send = await probe(rec);
    await act(async () => { send(reply("Danke!")); });
    await drain();
    expect(rec.mutations.map((m) => m.kind)).toEqual(["mail_send"]);
  });

  /**
   * SEND IS NOT DONE (owner 2026-10-22: "I had a resurfaced message and clicked only send on it
   * and not send and done and it marked as done!"). A plain reply leaves a pin and a booking
   * where they were; only Done, Send + Done or a deliberate read releases them. Supersedes the
   * 2026-08-24 rule ("§16 UI wave item 6") that a reply spends the pin.
   */
  it("a confirmed plain reply to a RESURFACED (pinned) message leaves the pin alone", async () => {
    const rec = recorder("resurfaced");
    const send = await probe(rec);
    await act(async () => { send(reply("Hier ist die Antwort.")); });
    await drain();
    expect(rec.mutations.map((m) => m.kind), "a plain Send spent the pin").toEqual(["mail_send"]);
  });

  it("a confirmed plain reply to a BOOKED (bubbled_up) message keeps the booking", async () => {
    const rec = recorder("bubbled_up");
    const send = await probe(rec);
    await act(async () => { send(reply("Danke!")); });
    await drain();
    expect(rec.mutations.map((m) => m.kind), "a plain Send cancelled the booking").toEqual(["mail_send"]);
  });

  it("a FAILED reply to a resurfaced message spends nothing", async () => {
    const rec = recorder("resurfaced", "rolled_back");
    const send = await probe(rec);
    await act(async () => { send(reply("Hier ist die Antwort.")); });
    await drain();
    expect(rec.mutations.map((m) => m.kind)).toEqual(["mail_send"]);
  });

  /**
   * the DANGEROUS DIRECTION, which had no test.
   *
   * `settle`'s comment states the rule — *"a send that failed must never clear a debt"* — and
   * `absorb` enforces it with `if (res.status === "confirmed")`. Nothing exercised the other side:
   * every case above injects `confirmed` or `queued`, and the `failed` case elsewhere in this file
   * mounts presentational state rather than driving the hook. So the one branch protecting the
   * user's reminder had no red-test evidence behind it.
   *
   * The consequence if it broke: the message leaves Answer Later, the reply never went, and the
   * only record that it was owed is gone. That is strictly worse than the bug the answer-later change fixed — losing
   * the reminder AND the reply, instead of merely keeping a discharged one.
   */
  it.each(["failed", "unverified"])(
    "a %s send leaves the message IN Answer Later — the debt outlives the attempt",
    async (status) => {
      const rec = recorder("reply_later", status);
      const send = await probe(rec);
      await act(async () => { send(reply("Danke!")); });
      await drain();
      expect(
        rec.mutations.map((m) => m.kind),
        "a triage_set here would discharge a debt the send never paid",
      ).toEqual(["mail_send"]);
      expect(rec.settled, "nothing settled: the send did not land").toEqual([]);
    },
  );

  it("a CONFIRMED COMPOSE clears nothing and settles the compose surface, not a message", async () => {
    // Clearing Answer Later is a reply's business. A compose answers nothing, so a `triage_set` here would be the
    // machine discharging a debt on whatever message the mirror happened to hand back — which is
    // exactly what a shared `settle` with no `inReplyTo` branch would do. Delete that branch and
    // the first assertion picks up a second mutation.
    const rec = recorder("reply_later");
    const send = await probe(rec);
    await act(async () => { send(compose("Guten Tag")); });
    await drain();
    expect(rec.mutations.map((m) => m.kind)).toEqual(["mail_send"]);
    await beat();
    expect(rec.settled).toEqual(["compose"]);
    expect(rec.toasts).toContain("Message sent.");
    // …and it does not claim to have sent a REPLY.
    expect(rec.toasts).not.toContain("Reply sent.");
  });

  /**
   * ══ THE SETTLE CARRIES THE MUTATION, DRAFT ID INCLUDED — CMP-F1's client seam ═══════════
   *
   * `AppShell.onSendSettled` decides what happens to the autosaved draft row by comparing the
   * row it holds against the `draftId` the SETTLED mutation carried: equal ⇒ the send used the
   * row and it became the sent message (release); absent ⇒ the press beat the first save's
   * round trip, the adapter made its own row, and the one autosave adopted is a phantom copy of
   * a delivered message (discard). Reproduced on the hosted service 2026-08-12, single session,
   * healthy auth: Send moments after the autosave timer left the SENT text in Drafts through many seconds
   * of syncs and a hard reload — reopenable with Send live, which is a double-send invite.
   *
   * Mutation: revert `settledRef.current(key, m)` to `settledRef.current(key)` in `settle`.
   * Real failure text:
   *   AssertionError: settle no longer hands the shell the settled mutation — the draft
   *   bookkeeping cannot tell a used row from a phantom: expected undefined to deeply equal
   *   { kind: 'mail_send', …, draftId: 'row-1' }
   */
  it("settle hands the shell the settled MUTATION, not only the key", async () => {
    const rec = recorder();
    const send = await probe(rec);
    const m = { ...compose("Guten Tag"), draftId: "row-1" };
    await act(async () => { send(m); });
    await drain();
    await beat();
    expect(rec.settled).toEqual(["compose"]);
    expect(
      rec.settledWith[0],
      "settle no longer hands the shell the settled mutation — the draft bookkeeping cannot "
        + "tell a used row from a phantom",
    ).toEqual(m);
  });

  it("a compose and a reply hold SEPARATE locks — one in flight does not block the other", async () => {
    const rec = recorder(null, "queued");
    const send = await probe(rec);
    await act(async () => { send(compose("Guten Tag")); });
    await drain();
    await act(async () => { send(reply("Donnerstag passt.")); });
    await drain();
    expect(rec.mutations.filter((m) => m.kind === "mail_send")).toHaveLength(2);
  });
});

describe("clearsTriage", () => {
  it("a delivered reply discharges Answer Later", async () => {
    const { clearsTriage } = await import("../app/shell/mail-send.js");
    expect(clearsTriage("reply_later")).toBe(true);
  });

  it("…and leaves a booking, a pin, Parked, Muted and no-state alone", async () => {
    const { clearsTriage } = await import("../app/shell/mail-send.js");
    expect(clearsTriage("bubbled_up")).toBe(false);
    expect(clearsTriage("resurfaced")).toBe(false);
    expect(clearsTriage("set_aside")).toBe(false);
    expect(clearsTriage("muted")).toBe(false);
    expect(clearsTriage(undefined)).toBe(false);
  });
});

describe("no path mints a fresh key after an unverified send", () => {
  /**
   * ── THE CONTROL FOR THE RULING ─────────────────────────────────────────────────────────────
   *
   * `send_unverified` is terminal-UNKNOWN: the reservation may already have delivered and nobody
   * can tell. The only safe retry reuses the key it went under. A fresh key cannot collide with
   * the old one — server uniqueness is `(account_id, idempotency_key)` — so minting one is a
   * second delivery by construction, not a race.
   *
   * Three separate mechanisms had to agree for this to be safe, and each was wrong on its own:
   * `canSend` left Send enabled, the durable lock was released so the key could not be resumed,
   * and the compose shed its draft id so the next press built a whole new draft. This asserts all
   * three at once, on the surfaces a person can actually reach.
   */
  it("Send is locked, the key is not released, and the compose keeps its draft", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const send = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/mail-send.ts"), "utf8");
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");

    // 1. the button
    const { canSend } = await import("../app/shell/mail-send.js");
    expect(canSend({ phase: "unverified" } as never, { body: "text" } as never)).toBe(false);

    // 2. the durable key survives the terminal outcome, so a retry can reuse it
    expect(
      send,
      "the send lock is released on `unverified`, so the key cannot be resumed and the next press "
        + "mints a new one",
    ).toMatch(/next\.phase !== "unverified"\s*\)?\s*(releaseSendLock|releaseEnded)\(/);

    // 3. nothing re-sends without the draft id
    expect(
      shell,
      "the compose sheds its draft id after an unverified send — a new draft means a new key",
    ).not.toMatch(/draftId: _stranded/);
  });
});

describe("an unverified send survives every way back to it", () => {
  /**
   * ── ROUND SIX, THE CRITICAL ────────────────────────────────────────────────────────────────
   *
   * Locking the phase closed the path a person takes with the composer still open. Two others
   * stayed open, and both end in a fresh key for a message that may already be in an inbox:
   *
   *  · REOPENING THE DRAFT. `stateOf` read React state, which starts empty on every mount, so a
   *    remounted composer was `idle` with Send live. Editing it then changed the fingerprint, and
   *    a fingerprint that does not match DELETED the retained lock — so the key was gone too.
   *  · THE AGE LIMIT. An unsettled lane is dropped after seven days. That is right for wreckage
   *    and wrong here: an unverified send is not an abandoned lane, it is a message that may be
   *    sitting in somebody's inbox, and the key is the only thing that still names it.
   *
   * The durable lock now carries the fact, so it outlives both.
   */
  const LANE = "compose";
  const OWNER = "acct-r6";

  afterEach(() => { try { window.localStorage.clear(); } catch { /* jsdom */ } });

  it("the lock is not dropped by the age limit", async () => {
    const { claimSendLock, markSendLockUnverified, readSendLock, SEND_LOCK_TTL_MS } =
      await import("../app/shell/send-lock.js");
    const at = 1_000_000;
    claimSendLock({ v: 1, lane: LANE, key: "K1", at, draftId: "d1", fp: "fp-a", subject: "draft:d1", session: "sess-1" }, NONE_OWED, OWNER);
    markSendLockUnverified(LANE, "fp-a", OWNER);

    const wayPast = at + SEND_LOCK_TTL_MS + 1;
    expect(
      readSendLock(LANE, "fp-a", wayPast, NONE_OWED, OWNER),
      "the key was aged out — the next press mints a new one for a message that may have gone",
    ).toBe("K1");
  });

  it("the age limit does not drop it through `allSendLocks` either", async () => {
    /**
     * THE SIBLING, AND WHY A SECOND CASE RATHER THAN TRUST.
     *
     * `readSendLock` exempted unverified locks from the age limit; `allSendLocks` filtered on the
     * limit alone AND persisted what it filtered. Nothing calls it today, so nothing was wrong
     * yet — but its docblock invited a restart's adoption pass, and the first author to write one
     * would have found that seven days on it deletes the single record saying a message may
     * already have been delivered. `unverifiedSendLock` then answers false, the composer comes
     * back live, and the next press mints a fresh key.
     *
     * The case above drives only `readSendLock`, so it cannot see this. Both now share one
     * liveness predicate, and this is the assertion that holds them together.
     */
    const { claimSendLock, markSendLockUnverified, allSendLocks, unverifiedSendIntents, SEND_LOCK_TTL_MS } =
      await import("../app/shell/send-lock.js");
    const at = 1_000_000;
    claimSendLock({ v: 1, lane: LANE, key: "K1", at, draftId: "d1", fp: "fp-a", subject: "draft:d1", session: "sess-1" }, NONE_OWED, OWNER);
    claimSendLock({ v: 1, lane: "other", key: "K2", at, draftId: "d2", fp: "fp-b", subject: "draft:d2" }, NONE_OWED, OWNER);
    markSendLockUnverified(LANE, "fp-a", OWNER);

    const wayPast = at + SEND_LOCK_TTL_MS + 1;
    const live = allSendLocks(wayPast, NONE_OWED, OWNER);
    expect(
      live.map((r) => r.lane),
      "the unverified lock was aged out of the adoption pass; the ordinary one is correctly gone",
    ).toEqual([LANE]);

    // AND IT PERSISTS what it filters — so a second read must still find it, not a fresh drop.
    expect(
      unverifiedSendIntents(LANE, OWNER).map((i) => i.fp),
      "the adoption pass deleted the record on its way past, so nothing knows a send went out",
    ).toEqual(["fp-a"]);
  });

  it("the lock is not deleted when the draft is edited", async () => {
    const { claimSendLock, markSendLockUnverified, readSendLock, unverifiedSendIntents } =
      await import("../app/shell/send-lock.js");
    claimSendLock({ v: 1, lane: LANE, key: "K1", at: 1_000, draftId: "d1", fp: "fp-a", subject: "draft:d1", session: "sess-1" }, NONE_OWED, OWNER);
    markSendLockUnverified(LANE, "fp-a", OWNER);

    // Reopening and editing changes the fingerprint. The key cannot be REUSED for different
    // content — that is correct — but the record must survive, or nothing knows a send went out.
    expect(readSendLock(LANE, "fp-EDITED", 2_000, NONE_OWED, OWNER)).toBeNull();
    expect(
      unverifiedSendIntents(LANE, OWNER).map((i) => i.fp),
      "editing the draft erased the evidence that a send may already have been delivered",
    ).toEqual(["fp-a"]);
  });

  it("the terminal branch records the fact, or nothing above it has anything to read", async () => {
    /**
     * The three assertions above all seed the lock directly, so none of them can see whether the
     * send path ever MARKS it — and without that mark the durable fact does not exist and every
     * one of them is vacuous. Asserted against the source because the mount harness in this file
     * drives `phaseFor`/`canSend` rather than the hook's own terminal branch; a real mount is the
     * better instrument and is the same tooling gap already filed for the phone.
     */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/mail-send.ts"), "utf8");
    expect(
      src,
      "the unverified terminal branch does not record the fact durably, so reopening the draft "
        + "finds nothing and Send comes back live",
    ).toMatch(/markSendLockUnverified\(key, fp, owner\.current\)/);
    expect(
      src,
      "`stateOf` does not consult the durable fact, so a remounted composer starts idle",
    ).toMatch(/unverifiedSendIntents\(key, owner\.current\)/);
  });

  it("a remounted composer starts parked, not idle", async () => {
    const { claimSendLock, markSendLockUnverified, unverifiedSendIntents } =
      await import("../app/shell/send-lock.js");
    claimSendLock({ v: 1, lane: LANE, key: "K1", at: 1_000, draftId: "d1", fp: "fp-a", subject: "draft:d1", session: "sess-1" }, NONE_OWED, OWNER);
    markSendLockUnverified(LANE, "fp-a", OWNER);

    // What `stateOf` consults on a fresh mount. React state is empty there; this is not.
    expect(
      unverifiedSendIntents(LANE, OWNER).map((i) => i.fp),
      "a fresh mount has no memory of the unverified send, so Send comes back live",
    ).toEqual(["fp-a"]);

    const { canSend } = await import("../app/shell/mail-send.js");
    expect(
      canSend({ phase: "unverified" } as never, { body: "text" } as never),
      "and the phase that fact produces still refuses to send",
    ).toBe(false);
  });
});

describe("the unverified lock names a message, and refuses when nobody named one", () => {
  /**
   * ── THE ONE RULE, AND THE TWO STATES ITS NEW FIELD DISTINGUISHES ────────────────────────────
   *
   * `canSend` refused every `unverified` state. The compose surface has one lane for every message
   * this browser will ever write, so that refusal — plus a durable record deliberately exempt from
   * the age limit, plus a `stateOf` that reads it on every mount — locked the mailbox out of ALL
   * future new-message sends after a single ambiguous delivery.
   *
   * `unresolved` names the messages instead. Absent and empty are different statements and both
   * are asserted here: absent is a state nobody supplied intents for (`phaseFor` cannot — it sees
   * a result, not the message) and must fail closed, which is the behaviour before the field
   * existed.
   */
  const msg = (over: Record<string, unknown> = {}): never => ({
    kind: "mail_send", inReplyTo: null, body: "text", subject: "s",
    to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb", ...over,
  } as never);

  it("an `unverified` state with nothing named still refuses — fail closed", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    expect(canSend({ phase: "unverified" } as SendState, msg())).toBe(false);
    // And an EMPTY list is the answered case: the record was read and holds nothing.
    expect(canSend({ phase: "unverified", unresolved: [] } as SendState, msg())).toBe(true);
  });

  it("the parked SUBJECT is refused and a different subject is admitted", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    const { sendFingerprint } = await import("../app/shell/send-lock.js");
    const ambiguous = msg({ inReplyTo: "giulia", body: "the reply that may already have gone" });
    const state = {
      phase: "unverified",
      unresolved: [{ subjects: ["reply:giulia"], fp: sendFingerprint(ambiguous) }],
    } as SendState;

    expect(canSend(state, ambiguous), "the ambiguous reply became sendable").toBe(false);
    expect(
      canSend(state, msg({ inReplyTo: "petra", body: "a reply to somebody else" })),
      "one ambiguous delivery locked every other conversation",
    ).toBe(true);
  });

  it("an EDIT does not escape the park — the subject is what is parked, not the text", async () => {
    /**
     * The fingerprint was the identity, and an edit changes it: type one character into a reply
     * whose outcome nobody knows, press Send, and a fresh key went out for a message that may
     * already have been delivered. The subject is what an edit does not change.
     */
    const { canSend } = await import("../app/shell/mail-send.js");
    const { sendFingerprint } = await import("../app/shell/send-lock.js");
    const first = msg({ inReplyTo: "giulia", body: "as first written" });
    const state = {
      phase: "unverified",
      unresolved: [{ subjects: ["reply:giulia"], fp: sendFingerprint(first) }],
    } as SendState;

    expect(
      canSend(state, msg({ inReplyTo: "giulia", body: "edited after the unverified attempt" })),
      "an edit walked out of the lock and would send under a fresh key",
    ).toBe(false);
    // A rich or signed reply is the same message too: the fingerprint moves, the subject does not.
    expect(
      canSend(state, msg({ inReplyTo: "giulia", body: "as first written\n\n-- \nMila", html: "<p>x</p>" })),
      "an unchanged reply that acquired its signature and HTML walked out of the lock",
    ).toBe(false);
  });

  it("a draft row is a subject, and a compose whose subject cannot be named FAILS CLOSED", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    const { sendFingerprint } = await import("../app/shell/send-lock.js");
    const sent = msg({ draftId: "d-9", body: "as first written" });
    const state = {
      phase: "unverified",
      unresolved: [{ subjects: ["draft:d-9"], fp: sendFingerprint(sent) }],
    } as SendState;

    expect(canSend(state, msg({ draftId: "d-9", body: "edited afterwards" }))).toBe(false);
    expect(
      canSend(state, msg({ draftId: "d-40", body: "another draft entirely" })),
      "a different draft row was parked by this one",
    ).toBe(true);
    /**
     * A compose with NO row and NO session id on the state: the subject cannot be named at all.
     * That is not evidence of a different message, and the cost of guessing wrong is a duplicate
     * delivery — so it refuses. The two states are told apart by the next assertion, where the
     * session IS named and a different session sends.
     */
    expect(
      canSend(state, msg({ body: "a compose this browser cannot name" })),
      "a message whose subject could not be read was admitted beside an unresolved send",
    ).toBe(false);
    expect(
      canSend({ ...state, session: "sess-2" } as SendState, msg({ body: "a new compose session" })),
      "a named, different compose session was parked by another message",
    ).toBe(true);
  });

  it("the compose session is the subject before a draft row exists", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    const { sendFingerprint, sendSubject } = await import("../app/shell/send-lock.js");
    const first = msg({ body: "the new message that may already have gone" });
    expect(sendSubject(first, "sess-1"), "the session is not the subject").toBe("compose:sess-1");
    expect(sendSubject(first, null), "an unnameable compose must not answer a subject").toBeUndefined();
    const state = {
      phase: "unverified", session: "sess-1",
      unresolved: [{ subjects: ["compose:sess-1"], fp: sendFingerprint(first) }],
    } as SendState;

    // Same session, edited text — still the same message-in-progress.
    expect(canSend(state, msg({ body: "edited, same compose session" }))).toBe(false);
    // The compose was delivered or abandoned, so the session id went with the scratch buffer.
    expect(
      canSend({ ...state, session: "sess-2" } as SendState, msg({ body: "a genuinely new message" })),
      "a new compose session was parked by the previous message",
    ).toBe(true);
  });

  it("the hook's own refusal and the button read ONE derivation", async () => {
    /**
     * The comment beside `send`'s guard already claimed `canSend` there "applies the SAME rule the
     * button's `disabled` uses". It read `states[key]`, which starts empty on every mount, while
     * the button read `stateOf`, which consults the durable record — so the claim was false for
     * exactly the half that survives a reload. Asserted against the source because the harness in
     * this file drives the pure functions rather than the hook; `send-lock-durable.test.tsx`
     * drives the mounted hook and its reload.
     */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/mail-send.ts"), "utf8");
    expect(
      src,
      "`send` judges React state alone, so a caller that is not the button gets past the durable "
        + "fact the button enforces",
    ).toMatch(/if \(!canSend\(stateFor\(key\), m\)\) \{/);
    /**
     * AND THE REFUSAL STILL RETURNS. The check gained a body — the row the message has since
     * acquired is written onto the record on the way out (`attachSendLockDraft`) — and a body is
     * a place a `return` can be lost, which would leave the refusal computing something and then
     * sending anyway. Asserted as the LAST statement of that block.
     */
    expect(
      src,
      "the refused press no longer returns, so `canSend` decides nothing",
    ).toMatch(/if \(!canSend\(stateFor\(key\), m\)\) \{[\s\S]*?\n {8}return;\n {6}\}/);
    expect(src, "`stateOf` is a second derivation beside `stateFor`").toMatch(/stateOf: stateFor,/);
  });
});

describe("the warn sentence is about the message on screen", () => {
  /**
   * ── THE OTHER HALF OF THE LANE-SCOPED PHASE ────────────────────────────────────────────────
   *
   * `SendStatus` renders a warn line for `unverified` — "We couldn't confirm this send. Check your
   * Sent folder before retrying." With the press no longer refused for a different message, the
   * phase alone would put that warning above a live Send button on mail it is not about, for as
   * long as the record lives, which is deliberately for ever. `sendStateFor` is what the surfaces
   * render, and it shares `canSend`'s predicate rather than restating it.
   */
  const msg = (over: Record<string, unknown> = {}): never => ({
    kind: "mail_send", inReplyTo: null, body: "text", subject: "s",
    to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb", ...over,
  } as never);

  it("the parked message keeps the warning, and a different one is not given it", async () => {
    const { sendStateFor, sendVerb } = await import("../app/shell/mail-send.js");
    const { sendFingerprint } = await import("../app/shell/send-lock.js");
    const ambiguous = msg({ inReplyTo: "giulia", body: "the reply that may already have gone" });
    const state = {
      phase: "unverified",
      unresolved: [{ subjects: ["reply:giulia"], fp: sendFingerprint(ambiguous) }],
    } as SendState;

    expect(sendStateFor(state, ambiguous).phase, "the parked message lost its warning").toBe("unverified");
    expect(
      sendStateFor(state, msg({ inReplyTo: "petra", body: "a reply to somebody else" })).phase,
      "a warning about somebody else's mail stands above a live Send button",
    ).toBe("idle");
    // Narrowed for the sentence, NOT for the rule: a `canSend` reading the narrowed state must
    // answer exactly what one reading the original answers.
    const { canSend } = await import("../app/shell/mail-send.js");
    expect(canSend(sendStateFor(state, ambiguous), ambiguous)).toBe(false);
    expect(sendVerb(sendStateFor(state, ambiguous), "compose").key).toBe("send");
  });

  it("a phase nobody named intents for keeps its warning — fail closed", async () => {
    const { sendStateFor } = await import("../app/shell/mail-send.js");
    expect(sendStateFor({ phase: "unverified" } as SendState, msg()).phase).toBe("unverified");
  });

  it("every other phase passes through untouched", async () => {
    const { sendStateFor } = await import("../app/shell/mail-send.js");
    for (const phase of ["idle", "sending", "queued", "sent", "failed"] as const) {
      const state = { phase } as SendState;
      expect(sendStateFor(state, msg()), `the ${phase} phase was rewritten`).toBe(state);
    }
  });

  it("both surfaces render the narrowed state, and judge the unnarrowed one", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const compose = readFileSync(resolve(process.cwd(), "apps/webapp/app/views/ComposeView.tsx"), "utf8");
    const reply = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/InlineReply.tsx"), "utf8");
    expect(
      compose,
      "the compose surface renders the lane's phase, so an unresolved send warns about mail the "
        + "reader is not writing",
    ).toMatch(/<SendStatus send=\{shown\}/);
    expect(
      reply,
      "the inline reply renders the lane's phase, same defect",
    ).toMatch(/<SendStatus send=\{sendStateFor\(send, wouldSend\)\}/);
    /* ── AND THE WAY OUT, ON BOTH OF THEM, OFF THE SAME NARROWED STATE ──────────────────────
       A surface that states the hold and offers nothing to do about it sends the reader to
       another screen to answer a question this one asked. Both doors gate the verbs on the
       phase the SENTENCE renders from, so a hold that says nothing here offers nothing either. */
    expect(
      compose,
      "the composer states the hold and offers no way to answer it",
    ).toMatch(/heldResolve !== null && shown\.phase === "unverified"/);
    expect(
      reply,
      "the reply editor states the hold and offers no way to answer it",
    ).toMatch(/heldResolve !== null && sendStateFor\(send, wouldSend\)\.phase === "unverified"/);
  });
});

/* The send fingerprint's field census moved with the function: `packages/client-engine/test/send-fingerprint.test.ts`. */

describe("a record written before the subject existed still parks something", () => {
  /**
   * The identity gained a subject. A record stored under the earlier rule has none, and comparing
   * `undefined` against a real subject is false for every message — so such a record would have
   * parked NOTHING, which is the fail-open direction on a guard whose whole job is to stop a
   * second delivery. It parks by the fingerprint it was written under: weaker than a subject, and
   * the only question that record can answer.
   */
  const msg = (over: Record<string, unknown> = {}): never => ({
    kind: "mail_send", inReplyTo: null, body: "text", subject: "s",
    to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb", ...over,
  } as never);

  it("it refuses its own content and admits a different message", async () => {
    const { canSend } = await import("../app/shell/mail-send.js");
    const { sendFingerprint } = await import("../app/shell/send-lock.js");
    const stored = msg({ body: "written under the earlier rule" });
    const state = {
      phase: "unverified", session: "sess-1",
      unresolved: [{ subjects: [], fp: sendFingerprint(stored) }],
    } as SendState;

    expect(
      canSend(state, stored),
      "a record from the earlier rule parks nothing, so its message is sendable again",
    ).toBe(false);
    expect(canSend(state, msg({ body: "something else entirely" }))).toBe(true);
  });
});

describe("the row the composer is holding decides too, not only the jar", () => {
  /**
   * ══ THE ROW THE SEND MADE FOR ITSELF ══════════════════════════════════════════════════════
   *
   * Measured live on the release candidate, recipient total 2. A compose pressed with no row of
   * its own: the SEND creates the row (`POST /drafts` inside the press) and parks THAT row on the
   * server as `unverified` — and the client never learns its id, because the adapter makes it and
   * the result carries none. Meanwhile the composer's own armed autosave minted a second row with
   * the same text. Drafts listed two rows before anybody touched anything; reopening the first
   * found no record naming it, took the recovery door, and one press sent the message again.
   *
   * The server's mark is the witness the record cannot be: it survives a row this browser never
   * heard of, a record lost with its storage, and another device's send. So a compose HOLDING a
   * row the mirror calls `unverified` is refused on that alone — with the sentence, not only the
   * lock, because a button that is dead for no stated reason is its own defect.
   */
  const msg = (over: Record<string, unknown> = {}): never => ({
    kind: "mail_send", inReplyTo: null, body: "text", subject: "s",
    to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb", ...over,
  } as never);
  const IDLE = { phase: "idle" } as SendState;
  const rows = [
    { id: "A", status: "unverified" },
    { id: "B", status: "draft" },
    { id: "C", status: "sent" },
    // A send that died without a verdict — past `draft`, and NOT a confirmation.
    { id: "S", status: "sending" },
  ];
  /** The mirror `holdOf` reads — the drafts above and nothing else. */
  const mirror = {
    read: () => ({
      get: <T,>(_type: string, id: string): T | undefined =>
        rows.find((r) => r.id === id) as T | undefined,
    }),
  };
  /**
   * THE HOLD, THROUGH THE REAL PREDICATE. `heldRowUnverified` consumes an answer now instead of
   * reading the row itself, so these cases drive `holdOf` and hand it what it says — which is what
   * makes them a check on the seam rather than on a hand-built enum.
   */
  const holdFor = async (rowId: string | null, session: string | null) => {
    const { holdOf } = await import("../app/shell/send-lock.js");
    return holdOf(mirror, { lane: "compose", draftId: rowId, session });
  };

  /**
   * Mutation: `if (row === undefined) return state;` in place of the status test. Real failure
   * text: AssertionError: a compose holding a row the server could not confirm is sendable —
   * one press is a second copy: expected true to be false
   */
  it("a held row the server marked unverified refuses the press, and says why", async () => {
    const { heldRowUnverified, canSend, sendStateFor } = await import("../app/shell/mail-send.js");
    const held = heldRowUnverified(IDLE, "A", await holdFor("A", "s1"), "s1");
    expect(
      canSend(held, msg()),
      "a compose holding a row the server could not confirm is sendable — one press is a second copy",
    ).toBe(false);
    /* The sentence renders off the phase, and only for the message it is about. */
    expect(
      sendStateFor(held, msg()).phase,
      "the press is refused with no sentence above it",
    ).toBe("unverified");
    /* It matches the ROW as well as the session, so it holds whether or not the composer has
       adopted the row — the parked branch deliberately does not. */
    expect(
      canSend(heldRowUnverified(IDLE, "A", await holdFor("A", null), null), msg({ draftId: "A" })),
      "the row's own name does not park it",
    ).toBe(false);
  });

  /**
   * ── AND THE REPLY LANE, WHICH THE PROJECTION COULD NOT NAME ───────────────────────────────
   *
   * `sendSubjects` names a reply `reply:<parent id>` and never `draft:<row>`, so an intent
   * carrying the row alone matched no reply mutation: `unresolvedNames` answered false, the
   * warning was dropped and Send stayed live over a reply whose own row sat at `unverified`.
   * The inline editor's buffer is per-message scratch and carries no row, so nothing else on
   * that surface could see the row either — a press created a second row and sent under a fresh
   * key, which is a second copy of a reply that may already have gone.
   *
   * Mutation: drop the `reply:` name from `heldRowUnverified`'s subjects. Real failure text:
   *   AssertionError: a reply whose own row the server could not confirm is sendable — one press
   *   is a second copy of it
   */
  it("a held REPLY row refuses the press for its own message and nobody else's", async () => {
    const { heldRowUnverified, canSend, sendStateFor } = await import("../app/shell/mail-send.js");
    const { holdOf } = await import("../app/shell/send-lock.js");
    const replyHold = holdOf(mirror, { lane: "m1", draftId: "A", session: null });
    const held = heldRowUnverified(IDLE, "A", replyHold, null, "m1");

    expect(
      canSend(held, msg({ inReplyTo: "m1", to: undefined })),
      "a reply whose own row the server could not confirm is sendable — one press is a second "
      + "copy of it",
    ).toBe(false);
    expect(
      sendStateFor(held, msg({ inReplyTo: "m1", to: undefined })).phase,
      "the reply's press is refused with no sentence above it",
    ).toBe("unverified");

    /* THE POSITIVE CONTROL. A reply to a DIFFERENT message is not this row's message, and a
       rule that refused it would lock the reader out of answering every other conversation. */
    expect(
      canSend(held, msg({ inReplyTo: "m2", to: undefined })),
      "a reply to another message is refused by a row that has nothing to do with it",
    ).toBe(true);
  });

  /**
   * ── THE HELD REPLY'S TWO VERBS, IN THE EDITOR THE READER ACTUALLY OPENS ───────────────────
   *
   * The Drafts row offered the answers; this editor offered none, so a held reply reached the one
   * surface a reader goes to and had nothing but a refused Send. Same component on both doors, so
   * the words and the outcomes cannot fall apart.
   *
   * Mutation: drop the `heldResolve` block from `InlineReply`. Real failure text:
   *   AssertionError: a held reply's editor offers no way to answer the question its own sentence
   *   asks: expected null not to be null
   */
  it("a held reply's editor carries the two verbs, and Send stays refused", async () => {
    const { heldRowUnverified } = await import("../app/shell/mail-send.js");
    const { holdOf } = await import("../app/shell/send-lock.js");
    const held = heldRowUnverified(
      { phase: "idle" } as SendState,
      "r1",
      holdOf(
        { read: () => ({ get: <T,>(): T => ({ status: "unverified" } as T) }) },
        { lane: "m1", draftId: "r1", session: null },
      ),
      null,
      "m1",
    );
    await mount(held, "Donnerstag passt.", {
      draftId: "r1",
      onResolve: (id, outcome) => { heldAnswers.push(`${id}:${outcome}`); },
    });

    expect(
      host!.querySelector(".draft-resolve"),
      "a held reply's editor offers no way to answer the question its own sentence asks",
    ).not.toBeNull();
    expect(
      sendBtn().disabled,
      "the held reply's Send is live — one press is a second copy of a message that may already "
      + "have been delivered",
    ).toBe(true);

    const verbs = Array.from(host!.querySelectorAll<HTMLElement>(".draft-resolve button"));
    const arrived = verbs.find((b) => (b.textContent ?? "").trim() === "It was sent — dismiss");
    const not = verbs.find((b) => (b.textContent ?? "").trim() === "Send again");
    expect(arrived, "the editor lost the arrived verb").toBeDefined();
    expect(not, "the editor lost the did-not-arrive verb").toBeDefined();

    await act(async () => { not!.click(); });
    await act(async () => { arrived!.click(); });
    expect(
      heldAnswers,
      "the editor's verbs report the wrong row or the wrong outcome — the reader's answer is "
      + "filed against another message",
    ).toEqual(["r1:not_arrived", "r1:arrived"]);
  });

  /**
   * THE POSITIVE CONTROL. Without it the rule above is satisfied by an editor that always asks
   * whether the message arrived — a question about a send nobody has attempted.
   */
  it("an ordinary reply editor asks nothing and sends", async () => {
    await mount({ phase: "idle" }, "Donnerstag passt.", {
      draftId: "r1",
      onResolve: (id, outcome) => { heldAnswers.push(`${id}:${outcome}`); },
    });
    expect(
      host!.querySelector(".draft-resolve"),
      "an ordinary reply is asked whether it arrived, which is a question about a send that was "
      + "never attempted",
    ).toBeNull();
    expect(sendBtn().disabled, "the ordinary reply stopped being sendable").toBe(false);
  });

  /**
   * THE POSITIVE CONTROLS, without which the rule above would be satisfied by refusing every
   * compose in the account.
   */
  it("an ordinary draft, a sent row and no row at all are left alone", async () => {
    const { heldRowUnverified, canSend } = await import("../app/shell/mail-send.js");
    for (const [row, why] of [
      ["B", "an ordinary saved draft is refused — every reopened draft becomes unsendable"],
      /* A row the mirror cannot NAME is `unknown`, not `parked`: a mirror that has not finished
         loading must not read as a hold, or a cold reload puts a warning over a dead button for a
         message nothing is waiting on. */
      ["gone", "a row the mirror does not know is refused — a mirror that has not loaded blocks Send"],
    ] as Array<[string, string]>) {
      expect(canSend(heldRowUnverified(IDLE, row, await holdFor(row, "s1"), "s1"), msg()), why).toBe(true);
    }
    expect(
      canSend(heldRowUnverified(IDLE, null, await holdFor(null, "s1"), "s1"), msg()),
      "a compose holding no row at all is refused",
    ).toBe(true);
    /* A press already on the wire keeps its own state: it is locked for a stronger reason. */
    expect(
      heldRowUnverified({ phase: "sending" } as SendState, "A", await holdFor("A", "s1"), "s1").phase,
      "an in-flight press was overwritten by this refusal",
    ).toBe("sending");
  });

  /**
   * ── AND A ROW PAST `draft` THAT IS NOT `unverified` IS HELD TOO — invariant S(2) ────────────
   *
   * `C` is `sent` and used to leave Send live, on the reading that "the message is over". The
   * predicate is about the ROW, not about how the send ended: a compose still holding a `sent` row
   * cannot write to it (the server refuses every PUT past `draft`) and must not send it again. The
   * ordinary path never reaches this — a confirmed send releases the row — so refusing here costs
   * nothing and closes the same shape a STRANDED `sending` row had, which is the one that was
   * measured delivering twice.
   */
  it("a STRANDED `sending` row is held; a `sent` one is finished and is not", async () => {
    /**
     * ── THE ONE STATUS THAT SETTLES RATHER THAN PARKS ─────────────────────────────────────────
     *
     * This case asserted that a `sent` row refuses the press too, on the reading that every status
     * past `draft` is a hold. The WRITE half of that is right and has not moved — nothing may PUT
     * to a delivered row, and `holdOf` still calls it parked. What was wrong is the SENTENCE: the
     * surface projected the park into "We couldn't confirm this send" about a message the mirror
     * says was delivered, which sends somebody looking for mail that is in their Sent folder and
     * refuses a press that would have replayed the original key.
     *
     * `sent` is the SERVER's terminal confirmation and it is authoritative over a local record
     * saying nobody knows. So the row is let go of, the record is settled, and the surface says
     * nothing — a press after that is a genuinely new send under a key of its own.
     *
     * `sending` keeps both halves: a send that died without a verdict is not a confirmation.
     *
     * Mutation: drop `hold.status === "sent"` from `heldRowUnverified`.
     */
    const { heldRowUnverified, canSend } = await import("../app/shell/mail-send.js");
    expect(
      canSend(heldRowUnverified(IDLE, "S", await holdFor("S", "s1"), "s1"), msg()),
      "a send that died without a verdict stopped being held — one press is a second copy",
    ).toBe(false);
    expect(
      canSend(heldRowUnverified(IDLE, "C", await holdFor("C", "s1"), "s1"), msg()),
      "a message the mirror says was DELIVERED is refused with the couldn't-confirm sentence over "
      + "it — a false state, and it hides the row that did send",
    ).toBe(true);
  });
});
