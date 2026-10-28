import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveLocale } from "../src/i18n/locale";
import { attachmentFaultNote } from "../src/ui/attachment-fault-note";
import { liveActions } from "../src/state/live";

/**
 * THE PHONE'S FILE TILE SAYS WHICH SIDE FAILED. Every failure read "Couldn't open this file. Tap
 * to try again.", and every tap re-asked the person's mail server — for a refused sign-in too,
 * which answers the same way each time. The sentence now comes from the same class table as the
 * web reader, in English and German, and the tap is offered, and re-asks, only where it can help.
 */

afterEach(() => { setActiveLocale("en"); });

/** [code, status, retryable, en, de] */
const SIDES: [string | null, number | null, boolean, string, string][] = [
  ["internal", 500, true, "ohmail couldn't fetch this file. Tap to try again.", "ohmail konnte diese Datei nicht holen. Tippe, um es nochmal zu versuchen."],
  ["mailbox_busy", 429, true, "ohmail already has this mailbox's connections open. Tap to try again.", "ohmail hat die Verbindungen zu diesem Postfach schon offen. Tippe, um es nochmal zu versuchen."],
  ["mail_server_unreachable", 424, true, "Your mail server didn't answer. Tap to try again.", "Dein Mailserver hat nicht geantwortet. Tippe, um es nochmal zu versuchen."],
  ["mail_server_busy", 424, true, "Your mail server isn't serving this mailbox right now. Tap to try again.", "Dein Mailserver bedient dieses Postfach gerade nicht. Tippe, um es nochmal zu versuchen."],
  ["mailbox_not_signed_in", 424, false, "This mailbox isn't signed in here. Sign in again in Settings.", "Dieses Postfach ist hier nicht angemeldet. Melde es in den Einstellungen neu an."],
  ["internal", 500, false, "ohmail couldn't fetch this file.", "ohmail konnte diese Datei nicht holen."],
  ["mail_server_not_secured", 424, false, "Your mail server wouldn't secure the connection, so the file wasn't fetched.", "Dein Mailserver hat die Verbindung nicht gesichert, darum wurde die Datei nicht geholt."],
  ["mail_server_login_refused", 424, false, "Your mail server refused the sign-in. Check the mailbox's password in Settings.", "Dein Mailserver hat die Anmeldung abgelehnt. Prüf das Passwort des Postfachs in den Einstellungen."],
  ["mailbox_reconnect_required", 424, false, "This mailbox's sign-in has expired. Reconnect it in Settings.", "Die Anmeldung dieses Postfachs ist abgelaufen. Verbinde es in den Einstellungen neu."],
  ["not_found", 404, false, "This message is not where your mailbox had it. It moved or was deleted.", "Diese Nachricht ist nicht dort, wo dein Postfach sie hatte. Sie wurde verschoben oder gelöscht."],
  ["not_found", 404, true, "This message is not where your mailbox had it. It moved or was deleted. Tap to try again.", "Diese Nachricht ist nicht dort, wo dein Postfach sie hatte. Sie wurde verschoben oder gelöscht. Tippe, um es nochmal zu versuchen."],
  ["step_up_required", 403, false, "ohmail can't fetch this file here.", "ohmail kann diese Datei hier nicht holen."],
  ["network", null, true, "Couldn't reach ohmail. Check your connection. Tap to try again.", "ohmail war nicht erreichbar. Prüf deine Verbindung. Tippe, um es nochmal zu versuchen."],
];

describe("one sentence per side, English and German, the tap only where it can help", () => {
  it.each(SIDES)("%s at %s, retryable %s", (code, status, retryable, sayEn, sayDe) => {
    expect(attachmentFaultNote({ code, status, retryable })).toBe(sayEn);
    setActiveLocale("de");
    expect(attachmentFaultNote({ code, status, retryable })).toBe(sayDe);
  });
});

describe("a tap re-asks the mail server only where the refusal said it could help", () => {
  function actionsOver(item: { state: "failed"; code: string; retryable: boolean; status: number }) {
    const openAttachment = vi.fn(async () => undefined);
    const engine = {
      openAttachment,
      attachmentsOf: () => ({ state: "ready" as const, items: [{ id: "a1", mimeType: "application/pdf", filename: "f.pdf", ...item }] }),
      attachmentBlobOf: () => undefined,
    };
    const actions = liveActions({ engine: engine as never, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" });
    return { actions, openAttachment };
  }

  it("a refused sign-in is not asked again, and its facts come back", async () => {
    const { actions, openAttachment } = actionsOver({ state: "failed", code: "mail_server_login_refused", retryable: false, status: 424 });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const got = await actions.openAttachmentBytes("m1", "a1");
    spy.mockRestore();
    expect(openAttachment).not.toHaveBeenCalled();
    expect(got).toEqual({ state: "failed", code: "mail_server_login_refused", retryable: false, status: 424 });
  });

  it("a message moved since the last sync is asked again, so a tap after the next sync fetches it", async () => {
    const { actions, openAttachment } = actionsOver({ state: "failed", code: "not_found", retryable: true, status: 404 });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await actions.openAttachmentBytes("m1", "a1");
    spy.mockRestore();
    expect(openAttachment).toHaveBeenCalledWith("m1", "a1", { retry: true });
  });

  it("CONTROL: an unreachable server is asked again, with the retry flag", async () => {
    const { actions, openAttachment } = actionsOver({ state: "failed", code: "mail_server_unreachable", retryable: true, status: 424 });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await actions.openAttachmentBytes("m1", "a1");
    spy.mockRestore();
    expect(openAttachment).toHaveBeenCalledWith("m1", "a1", { retry: true });
  });
});

describe("a picture the engine will ask for again says so", () => {
  it.each([
    ["mailbox_busy", 429, "ohmail already has this mailbox's connections open. Trying again shortly.", "ohmail hat die Verbindungen zu diesem Postfach schon offen. Wird gleich nochmal versucht."],
    ["mail_server_unreachable", 424, "Your mail server didn't answer. Trying again shortly.", "Dein Mailserver hat nicht geantwortet. Wird gleich nochmal versucht."],
  ] as const)("%s", (code, status, sayEn, sayDe) => {
    expect(attachmentFaultNote({ code, status, retryable: true, reasking: true })).toBe(sayEn);
    setActiveLocale("de");
    expect(attachmentFaultNote({ code, status, retryable: true, reasking: true })).toBe(sayDe);
  });

  it("control: without the re-ask the tap is offered as before", () => {
    expect(attachmentFaultNote({ code: "mailbox_busy", status: 429, retryable: true })).toBe("ohmail already has this mailbox's connections open. Tap to try again.");
  });
});
