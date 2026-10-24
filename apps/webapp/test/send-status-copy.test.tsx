/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SendStatus, sendLine } from "../app/shell/SendStatus.js";
import { phaseFor, type SendState } from "../app/shell/mail-send.js";

/**
 * WHAT A FAILED SEND SAYS — plain sentences, never the wire (owner report, 2026-08-21).
 *
 * A real subscriber was shown "Nicht gesendet: authentication required". The string after the
 * colon is `packages/api/src/middleware.ts:216`'s own refusal envelope message, quoted raw by the
 * old `statusFailed` ("Not sent: {reason}") — a protocol sentence, in English, inside a German
 * UI, telling a signed-in person nothing they could act on. The ruled contract:
 *
 *   · a failed send says one plain thing — the draft is kept, try again — because that is what
 *     is true of every refusal the machine cannot name (`mail-send.ts`: "Text kept, Send live
 *     again"), and the Send control beside it IS the retry;
 *   · `mailbox_disabled` keeps its own sentence (a state with a control on the same screen);
 *   · the session's "sign in" is said by the ONE component that can know a session is genuinely
 *     dead — the SyncBar, after `REFUSAL_SUSTAIN_MS` of re-made refusals — never by a single send's
 *     error, which cannot tell a deploy blip from a revocation; a MAILBOX with no sign-in here is
 *     the server's own code, `mailbox_not_signed_in`, and that one says so.
 *
 * The server's text stays in `SendState.reason` for diagnostics; it just never renders.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(send: SendState, messages: typeof en | typeof de, locale: string, scope: "reply" | "compose" = "reply"): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale={locale} messages={messages as never} timeZone="UTC">
        <SendStatus send={send} scope={scope} lane={null} showing={null} />
      </NextIntlClientProvider>,
    );
  });
  return host.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("a failed send never relays the wire", () => {
  it("the API's own 401 envelope text does not reach the user — the plain sentence does", () => {
    const text = render(
      { phase: "failed", reason: "authentication required", code: "unauthorized" },
      en, "en",
    );
    expect(text, "the protocol string was quoted at the user").not.toContain("authentication required");
    expect(text).toContain("Sending didn't work");
    expect(text, "the sentence must say the draft survives").toContain("draft is kept");
    expect(text, "the sentence must point at the retry that exists").toContain("Try again");
  });

  it("an SMTP refusal string does not reach the user either", () => {
    const text = render(
      { phase: "failed", reason: "550 5.7.1 relay access denied" },
      en, "en",
    );
    expect(text).not.toContain("relay access denied");
    expect(text).toContain("Sending didn't work");
  });

  it("the German catalog carries the same plain sentence — the incident was seen in German", () => {
    const text = render(
      { phase: "failed", reason: "authentication required", code: "unauthorized" },
      de, "de",
    );
    expect(text).not.toContain("authentication required");
    expect(text).toContain("Senden hat nicht geklappt");
  });

  it("mailbox_disabled keeps its own sentence — a state with a control on the same screen", () => {
    const text = render(
      { phase: "failed", reason: "mailbox disabled", code: "mailbox_disabled" },
      en, "en",
    );
    expect(text).toContain("That address is disconnected");
    expect(text).not.toContain("mailbox disabled");
  });

  it("forward_original_unavailable names the refusal — the original, not the sending, is what failed", () => {
    const en1 = render(
      { phase: "failed", reason: "The original could not be loaded, so it was not forwarded.", code: "forward_original_unavailable" },
      en, "en",
    );
    expect(en1).toContain("The original could not be loaded, so it was not forwarded.");
    expect(en1).not.toContain("Sending didn't work");
    const de1 = render(
      { phase: "failed", reason: "The original could not be loaded, so it was not forwarded.", code: "forward_original_unavailable" },
      de, "de",
    );
    expect(de1).toContain("Das Original konnte nicht geladen werden");
  });

  it("send_not_secured and send_login_refused name the mail server's refusal, in both languages", () => {
    const cases = [
      ["send_not_secured", "The connection to your mail server couldn't be secured", "konnte nicht verschlüsselt werden"],
      ["send_login_refused", "Your mail server refused the sign-in", "Dein Mailserver hat die Anmeldung abgelehnt"],
    ] as const;
    for (const [code, enText, deText] of cases) {
      const send: SendState = { phase: "failed", reason: "server words", code };
      const en1 = render(send, en, "en");
      expect(en1).toContain(enText);
      expect(en1).toContain("draft is kept");
      expect(en1).not.toContain("Sending didn't work");
      act(() => root?.unmount());
      host?.remove();
      const de1 = render(send, de, "de");
      expect(de1).toContain(deText);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("send_unreachable says the mail server could not be reached and where the message is, in both scopes and both languages", () => {
    // Tester round 22: the send gave up after its retries; the row is an ordinary draft again, and
    // the phone's facts are the true ones — kept in Drafts, sent again by a press.
    const send: SendState = { phase: "failed", reason: "This was not sent — your mail server could not be reached.", code: "send_unreachable" };
    for (const scope of ["reply", "compose"] as const) {
      const en1 = render(send, en, "en", scope);
      expect(en1).toContain("Your mail server couldn't be reached");
      expect(en1).toContain("kept in Drafts");
      expect(en1).not.toContain("Try again");
      expect(en1).not.toContain("Sending didn't work");
      act(() => root?.unmount());
      host?.remove();
      const de1 = render(send, de, "de", scope);
      expect(de1).toContain("Dein Mailserver war nicht erreichbar");
      expect(de1).toContain("in den Entwürfen");
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("send_busy says the mail server would not take it now, in both scopes and both languages", () => {
    const send: SendState = { phase: "failed", reason: "This was not sent — your mail server is busy.", code: "send_busy" };
    for (const scope of ["reply", "compose"] as const) {
      const en1 = render(send, en, "en", scope);
      expect(en1).toContain("Your mail server is busy");
      expect(en1).toContain("draft is kept");
      expect(en1).not.toContain("Sending didn't work");
      act(() => root?.unmount());
      host?.remove();
      const de1 = render(send, de, "de", scope);
      expect(de1).toContain("Dein Mailserver ist gerade ausgelastet");
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("a forward's refusals and a timed-out dial say what happened, in both scopes and both languages", () => {
    // 2026-10-19: a forward refused `attachment_part_mismatch` showed "Sending didn't work … Try
    // again" — the one sentence that says nothing about what failed. Each code below can reach a
    // person from the send route, and each now names its cause and the act that helps.
    const cases = [
      ["attachment_part_mismatch", "An attachment of the original didn't come back from your mail server the way it arrived",
        "Ein Anhang des Originals kam von deinem Mailserver nicht so zurück, wie er angekommen ist"],
      ["forward_source_moved", "The message you're forwarding has moved on your mail server",
        "Die Nachricht, die du weiterleitest, wurde auf deinem Mailserver verschoben"],
      ["send_timeout", "Your mail server didn't answer in time", "Dein Mailserver hat nicht rechtzeitig geantwortet"],
    ] as const;
    for (const [code, enText, deText] of cases) {
      const send: SendState = { phase: "failed", reason: "the server's own words", code };
      for (const scope of ["reply", "compose"] as const) {
        const en1 = render(send, en, "en", scope);
        expect(en1, code).toContain(enText);
        expect(en1, code).toContain("draft is kept");
        expect(en1, code).not.toContain("Sending didn't work");
        expect(en1, code).not.toContain("the server's own words");
        act(() => root?.unmount());
        host?.remove();
        const de1 = render(send, de, "de", scope);
        expect(de1, code).toContain(deText);
        expect(de1, code).not.toContain("Senden hat nicht geklappt");
        act(() => root?.unmount());
        host?.remove();
      }
    }
  });

  it("mailbox_not_signed_in says the file's sentence after the kept draft, with no Try again, in both scopes and languages", () => {
    const send = phaseFor({ status: "rolled_back", error: {
      code: "mailbox_not_signed_in", retryable: false,
      message: "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings",
    } } as never);
    expect(send).toMatchObject({ phase: "failed", code: "mailbox_not_signed_in" });
    for (const scope of ["reply", "compose"] as const) {
      expect(render(send, en, "en", scope))
        .toBe("Not sent — your draft is kept. This mailbox isn't signed in here — sign in again in Settings.");
      act(() => root?.unmount());
      host?.remove();
      expect(render(send, de, "de", scope))
        .toBe("Nicht gesendet — dein Entwurf ist gesichert. Dieses Postfach ist hier nicht angemeldet — melde es in den Einstellungen neu an.");
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("a send refused past the draft limit names the limit, and claims neither a kept draft nor a retry", () => {
    // Tester round 22: a 413 on Send said "your draft is kept. Try again." — neither was true.
    for (const code of ["draft_too_large", "payload_too_large"] as const) {
      const send: SendState = { phase: "failed", reason: "the server's own words", code };
      for (const scope of ["reply", "compose"] as const) {
        const en1 = render(send, en, "en", scope);
        expect(en1, code).toMatch(/^Not sent\. It's too (long|large) to send/);
        if (code === "draft_too_large") expect(en1, code).toMatch(/the limit is 262(\.1)? kB/i);
        for (const lie of ["kept", "Try again", "Sending didn't work"]) expect(en1, `${code} ${scope}`).not.toContain(lie);
        act(() => root?.unmount());
        host?.remove();
        const de1 = render(send, de, "de", scope);
        expect(de1, code).toMatch(/^Nicht gesendet\. Die (Nachricht|Antwort) ist zu (lang|groß) zum Senden/);
        for (const lie of ["gesichert", "Versuch es", "Senden hat nicht geklappt"]) expect(de1, `${code} ${scope}`).not.toContain(lie);
        act(() => root?.unmount());
        host?.remove();
      }
    }
  });

  it("a save refused before the send (validation_failed, from_mailbox_unconfirmed) says not sent and never kept", () => {
    for (const code of ["validation_failed", "from_mailbox_unconfirmed"] as const) {
      const send: SendState = { phase: "failed", reason: "the server's own words", code };
      for (const scope of ["reply", "compose"] as const) {
        const en1 = render(send, en, "en", scope);
        expect(en1, `${code} ${scope}`).toMatch(/^Not sent\. This (message|reply) could not be saved first/);
        for (const lie of ["kept", "Sending didn't work"]) expect(en1, `${code} ${scope}`).not.toContain(lie);
        act(() => root?.unmount());
        host?.remove();
        const de1 = render(send, de, "de", scope);
        expect(de1, `${code} ${scope}`).toMatch(/^Nicht gesendet\. Diese (Nachricht|Antwort) konnte vorher nicht gespeichert werden/);
        for (const lie of ["gesichert", "Senden hat nicht geklappt"]) expect(de1, `${code} ${scope}`).not.toContain(lie);
        act(() => root?.unmount());
        host?.remove();
      }
    }
  });

  it("a compose send refused over a version changed elsewhere says so, and never that the words are kept before they are", () => {
    const send: SendState = { phase: "failed", reason: "x", code: "draft_changed" };
    const en1 = render(send, en, "en", "compose");
    expect(en1).toMatch(/^Not sent\. This draft was changed in another window or on another device/);
    expect(en1).not.toContain("kept");
    act(() => root?.unmount());
    host?.remove();
    const de1 = render(send, de, "de", "compose");
    expect(de1).toMatch(/^Nicht gesendet\. Dieser Entwurf wurde in einem anderen Fenster oder auf einem anderen Gerät geändert/);
    expect(de1).not.toContain("gespeichert");
  });

  it("control: a refusal with no sentence of its own still says the general line", () => {
    const text = render({ phase: "failed", reason: "x", code: "some_new_code" }, en, "en", "compose");
    expect(text).toBe(en.compose.statusFailed);
  });

  it("sendLine is the one derivation: the toast's key is the line's key", () => {
    expect(sendLine({ phase: "failed", code: "send_unreachable" }, false)).toEqual({ tone: "error", key: "statusUnreachable" });
    expect(sendLine({ phase: "failed", code: "draft_too_large" }, false)).toEqual({ tone: "error", key: "statusTooLong" });
    expect(sendLine({ phase: "idle" }, false)).toBeNull();
  });
});
