/** @vitest-environment jsdom */
/**
 * ═══ AN INVITATION WE CANNOT SHOW SAYS SO, IN THE READING PANE ═══════════════════════════════
 *
 * The 2026-09-16 report's first move: an Outlook Web Access invitation whose mail system sent the
 * event as a LINK — no `text/calendar` part, no card, and the pane rendered OWA's boilerplate AS
 * the message. That silence is what sent a user to another mail app.
 *
 * MUTATION-WATCHED (each reddens the case named and no other): the flag forced false → the two
 * "says so" cases; the line rendered unconditionally → the two "says nothing" controls.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { msg, setup, teardown } from "./_view-shell";
import { mountInvitationLetter } from "./fixtures/reader-invitation";

const EN_LINE = en.body.invitationWithoutEvent;
const DE_LINE = de.body.invitationWithoutEvent;

beforeEach(setup);
afterEach(async () => { cleanup(); await teardown(); });

/** The OWA body a reader was shown instead of an event — the boilerplate, verbatim in shape. */
const OWA_BODY =
  "<p>Microsoft Outlook Web Access: <a href=\"https://example.invalid/owa/x\">open this invitation</a>. "
  + "To receive meeting invitations as .iCalendar attachments instead, change your settings.</p>";

function mountPane(open: EngineMessage, { locale }: { locale?: "en" | "de" } = {}) {
  return mountInvitationLetter(open, { text: open.snippet, html: OWA_BODY }, { locale }).element;
}

describe("the reading pane says an invitation arrived whose event it cannot show", () => {
  it("renders the line for an invitation with no event", () => {
    const el = mountPane(msg("owa", { invitationWithoutEvent: true } as Partial<EngineMessage>));
    expect(el.textContent).toContain(EN_LINE);
  });

  /** German reads German — the line is catalogue copy, not a literal in the component. */
  it("renders the German line for a German reader", () => {
    const el = mountPane(
      msg("owa", { invitationWithoutEvent: true } as Partial<EngineMessage>), { locale: "de" },
    );
    expect(el.textContent).toContain(DE_LINE);
  });

  /**
   * THE POSITIVE CONTROL ON THE OTHER ARM: a message whose event CAN be shown — the flag is
   * false, which is what the server answers whenever a calendar part exists — says nothing. The
   * card itself is the attachment strip's and is held by `mime-calendar.test.ts`.
   */
  it("says nothing when the flag is false", () => {
    const el = mountPane(msg("withcard", { invitationWithoutEvent: false } as Partial<EngineMessage>));
    expect(el.textContent).not.toContain(EN_LINE);
  });

  /** An older mirror or server leaves the field ABSENT, which must read exactly like false. */
  it("says nothing when the field is absent", () => {
    const el = mountPane(msg("older"));
    expect(el.textContent).not.toContain(EN_LINE);
  });

  /**
   * THE LINE IS NOT THE MAIL. `.msg-body` is the one element that holds the message and nothing
   * else — `test/conversation.test.ts` and `test/inline-reply.test.ts` select on it — so product
   * speech about the message belongs beside it, never inside it.
   */
  it("keeps the line OUTSIDE .msg-body", () => {
    const el = mountPane(msg("owa", { invitationWithoutEvent: true } as Partial<EngineMessage>));
    expect(el.textContent).toContain(EN_LINE);
    expect(el.querySelector("[data-read-body]")!.textContent).not.toContain(EN_LINE);
  });
});
