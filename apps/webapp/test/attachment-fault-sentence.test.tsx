/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../app/shell/locale";
import {
  AttachmentStrip, fileFaultSentence, fileRetryIsOffered,
  type AttachmentItem, type AttachmentStripProps,
} from "../app/components/AttachmentStrip";

/**
 * A FILE THAT COULD NOT BE FETCHED SAYS WHICH SIDE FAILED, in the reader's language, and is a
 * retry only where asking again can help. Every failure read "Couldn't fetch — try again" and
 * every tile was the retry, so a refused sign-in invited a second connection that could only be
 * refused again, and the reason sat in an English tooltip.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  setActiveCatalog(DEFAULT_LOCALE, null);
});

async function mount(props: AttachmentStripProps): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(AttachmentStrip, props)));
}

const failed = (over: Partial<AttachmentItem>): AttachmentItem => ({
  id: "a1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1000,
  state: "failed", error: "the server's English sentence", ...over,
});

const strip = (it: AttachmentItem, onOpen = vi.fn()): AttachmentStripProps => ({
  items: { state: "ready", items: [it] }, onOpen, onDownloadAll: () => {}, downloadingAll: false,
});

/** [class, code, status, retryable, en, de] — one row per side. */
const SIDES: [string, string | null, number | null, boolean, string, string][] = [
  ["ohmail", "internal", 500, true, "ohmail couldn't fetch this file", "ohmail konnte diese Datei nicht holen"],
  ["busy", "mailbox_busy", 429, true, "ohmail already has this mailbox's connections open", "ohmail hat die Verbindungen zu diesem Postfach schon offen"],
  ["unreachable", "mail_server_unreachable", 424, true, "Your mail server didn't answer", "Dein Mailserver hat nicht geantwortet"],
  ["server_busy", "mail_server_busy", 424, true, "Your mail server isn't serving this mailbox right now", "Dein Mailserver bedient dieses Postfach gerade nicht"],
  ["not_secured", "mail_server_not_secured", 424, false, "Your mail server wouldn't secure the connection", "Dein Mailserver hat die Verbindung nicht gesichert"],
  ["login_refused", "mail_server_login_refused", 424, false, "Your mail server refused the sign-in — check the password in Settings", "Dein Mailserver hat die Anmeldung abgelehnt — prüf das Passwort in den Einstellungen"],
  ["reconnect", "mailbox_reconnect_required", 424, false, "This mailbox's sign-in has expired — reconnect it in Settings", "Die Anmeldung dieses Postfachs ist abgelaufen — verbinde es in den Einstellungen neu"],
  ["not_signed_in", "mailbox_not_signed_in", 424, false, "This mailbox isn't signed in here — sign in again in Settings", "Dieses Postfach ist hier nicht angemeldet — melde es in den Einstellungen neu an"],
  ["gone", "not_found", 404, false, "Not where your mailbox had it — moved or deleted", "Nicht dort, wo dein Postfach sie hatte — verschoben oder gelöscht"],
  ["refused", "step_up_required", 403, false, "ohmail can't fetch this file here", "ohmail kann diese Datei hier nicht holen"],
  ["offline", "network", null, true, "Couldn't reach ohmail — check your connection", "ohmail war nicht erreichbar — prüf deine Verbindung"],
];

describe("each side that failed has its own sentence, in English and German", () => {
  it.each(SIDES)("%s", async (_cls, code, status, retryable, sayEn, sayDe) => {
    const it = failed({ code, status, retryable });
    expect(fileFaultSentence(it)).toBe(sayEn);
    setActiveCatalog("de", fillFrom(en as never, de as never) as never);
    expect(fileFaultSentence(it)).toBe(sayDe);
  });

  it("the sentences are all different sentences", () => {
    expect(new Set(SIDES.map((r) => r[4])).size).toBe(SIDES.length);
  });
});

describe("Try again is offered where asking again can help, and only there", () => {
  it("a retryable failure is the retry, its state line says so, and a press re-asks", async () => {
    const onOpen = vi.fn();
    await mount(strip(failed({ code: "mail_server_unreachable", status: 424, retryable: true }), onOpen));
    const tile = host!.querySelector<HTMLButtonElement>("button.att-tile")!;
    expect(tile.textContent).toContain("Your mail server didn't answer — try again");
    expect(tile.title).toBe("Your mail server didn't answer");
    await act(async () => tile.click());
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("a refused sign-in is not a button, says no try again, and a press cannot reach onOpen", async () => {
    const onOpen = vi.fn();
    await mount(strip(failed({ code: "mail_server_login_refused", status: 424, retryable: false }), onOpen));
    expect(host!.querySelector("button")).toBeNull();
    const tile = host!.querySelector<HTMLDivElement>(".att-tile")!;
    expect(tile.dataset.state).toBe("failed");
    expect(tile.textContent).toContain("Your mail server refused the sign-in");
    expect(tile.textContent).not.toContain("try again");
    await act(async () => tile.click());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("a message moved since the last sync is the retry: the next sync finds it again", async () => {
    const onOpen = vi.fn();
    await mount(strip(failed({ code: "not_found", status: 404, retryable: true }), onOpen));
    const tile = host!.querySelector<HTMLButtonElement>("button.att-tile")!;
    expect(tile.textContent).toContain("Not where your mailbox had it — moved or deleted — try again");
    await act(async () => tile.click());
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("a dead OAuth sign-in is not a button and names the reconnect", async () => {
    await mount(strip(failed({ code: "mailbox_reconnect_required", status: 424, retryable: false })));
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector(".att-tile")!.textContent).toContain("reconnect it in Settings");
  });

  it("a mailbox not signed in here is not a button and names the sign-in", async () => {
    await mount(strip(failed({ code: "mailbox_not_signed_in", status: 424, retryable: false })));
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector(".att-tile")!.textContent).toContain("sign in again in Settings");
  });

  it("a fault of ours that states it cannot help is not a button", async () => {
    await mount(strip(failed({ code: "internal", status: 500, retryable: false })));
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector(".att-tile")!.textContent).not.toContain("try again");
  });

  it("a mail server at its limit is the retry, and says it is not serving the mailbox", async () => {
    await mount(strip(failed({ code: "mail_server_busy", status: 424, retryable: true })));
    expect(host!.querySelector("button.att-tile")!.textContent).toContain("isn't serving this mailbox right now — try again");
  });

  it("a session refusal keeps its retry, as the list's does", () => {
    expect(fileRetryIsOffered({ code: "unauthorized", retryable: false })).toBe(true);
  });

  it("a throw nothing classified is retryable, and a bare harness item reads as one", () => {
    expect(fileRetryIsOffered({ code: null, retryable: true })).toBe(true);
    expect(fileRetryIsOffered({})).toBe(true);
  });
});

describe("a picture the engine will ask for again says so", () => {
  it.each([
    ["mailbox_busy", 429, "ohmail already has this mailbox's connections open — trying again shortly", "ohmail hat die Verbindungen zu diesem Postfach schon offen — wird gleich nochmal versucht"],
    ["mail_server_unreachable", 424, "Your mail server didn't answer — trying again shortly", "Dein Mailserver hat nicht geantwortet — wird gleich nochmal versucht"],
  ] as const)("%s", async (code, status, sayEn, sayDe) => {
    await mount(strip(failed({ code, status, retryable: true, reasking: true })));
    expect(host!.querySelector(".att-state")!.textContent).toBe(sayEn);
    await act(async () => root!.unmount());
    host!.remove();
    root = null;
    setActiveCatalog("de", fillFrom(en as never, de as never) as never);
    await mount(strip(failed({ code, status, retryable: true, reasking: true })));
    expect(host!.querySelector(".att-state")!.textContent).toBe(sayDe);
  });

  it("control: without the re-ask the line reads as before", async () => {
    await mount(strip(failed({ code: "mailbox_busy", status: 429, retryable: true })));
    expect(host!.querySelector(".att-state")!.textContent).toBe("ohmail already has this mailbox's connections open — try again");
  });
});
