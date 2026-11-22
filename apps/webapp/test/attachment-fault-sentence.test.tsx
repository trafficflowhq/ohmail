/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fileRetryIsOffered } from "@ohmail/app-logic/reader";
import type { ReaderFile, ReaderFiles } from "../../../packages/app/src/reader/ports";
import { ReaderFilesFixture } from "./fixtures/reader-files";

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
});

async function mount(item: ReaderFile, onRetry = vi.fn(), locale: "en" | "de" = "en"): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const files: ReaderFiles = {
    hold: () => () => {},
    itemsOf: () => ({ state: "ready", items: [item] }),
    ensure: onRetry,
    open: () => {},
    downloadAll: () => {},
    downloadingAll: () => false,
    cidImagesOf: () => new Map(),
    needCidImages: () => {},
  };
  await act(async () => root!.render(React.createElement(ReaderFilesFixture, {
    files, messageId: "message", locale,
  })));
}

const failed = (over: Partial<ReaderFile>): ReaderFile => ({
  id: "a1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1000,
  inline: false, state: "failed", ...over,
});
const reason = (): string => host!.querySelector('[role="status"]')!.textContent ?? "";
const retry = (): HTMLButtonElement | null => host!.querySelector(".oh-file button");

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
    const file = failed({ code, status, retryable });
    await mount(file);
    expect(reason()).toBe(sayEn);
    await mount(file, vi.fn(), "de");
    expect(reason()).toBe(sayDe);
  });

  it("the sentences are all different sentences", () => {
    expect(new Set(SIDES.map((r) => r[4])).size).toBe(SIDES.length);
  });
});

describe("Try again is offered where asking again can help, and only there", () => {
  it("a retryable failure is the retry, its state line says so, and a press re-asks", async () => {
    const onRetry = vi.fn();
    await mount(failed({ code: "mail_server_unreachable", status: 424, retryable: true }), onRetry);
    const tile = retry()!;
    expect(reason()).toBe("Your mail server didn't answer");
    expect(tile.textContent).toBe("Try again");
    await act(async () => tile.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith("message", "a1", { retry: true });
  });

  it("a refused sign-in is not a button, says no try again, and a press cannot reach onOpen", async () => {
    const onRetry = vi.fn();
    await mount(failed({ code: "mail_server_login_refused", status: 424, retryable: false }), onRetry);
    expect(host!.querySelector("button")).toBeNull();
    const tile = host!.querySelector<HTMLDivElement>(".oh-file")!;
    expect(tile.dataset.state).toBe("failed");
    expect(tile.textContent).toContain("Your mail server refused the sign-in");
    expect(tile.textContent).not.toMatch(/try again/i);
    await act(async () => tile.click());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a message moved since the last sync is the retry: the next sync finds it again", async () => {
    const onRetry = vi.fn();
    await mount(failed({ code: "not_found", status: 404, retryable: true }), onRetry);
    const tile = retry()!;
    expect(reason()).toBe("Not where your mailbox had it — moved or deleted");
    expect(tile.textContent).toBe("Try again");
    await act(async () => tile.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith("message", "a1", { retry: true });
  });

  it("a dead OAuth sign-in is not a button and names the reconnect", async () => {
    await mount(failed({ code: "mailbox_reconnect_required", status: 424, retryable: false }));
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector(".oh-file")!.textContent).toContain("reconnect it in Settings");
  });

  it("a mailbox not signed in here is not a button and names the sign-in", async () => {
    await mount(failed({ code: "mailbox_not_signed_in", status: 424, retryable: false }));
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector(".oh-file")!.textContent).toContain("sign in again in Settings");
  });

  it("a fault of ours that states it cannot help is not a button", async () => {
    await mount(failed({ code: "internal", status: 500, retryable: false }));
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector(".oh-file")!.textContent).not.toMatch(/try again/i);
  });

  it("a mail server at its limit is the retry, and says it is not serving the mailbox", async () => {
    await mount(failed({ code: "mail_server_busy", status: 424, retryable: true }));
    expect(reason()).toContain("isn't serving this mailbox right now");
    expect(retry()?.textContent).toBe("Try again");
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
    ["mailbox_busy", 429, "ohmail already has this mailbox's connections open. Ohmail will try again shortly.", "Ohmail versucht es gleich noch einmal. ohmail hat die Verbindungen zu diesem Postfach schon offen."],
    ["mail_server_unreachable", 424, "Your mail server didn't answer. Ohmail will try again shortly.", "Ohmail versucht es gleich noch einmal. Dein Mailserver hat nicht geantwortet."],
  ] as const)("%s", async (code, status, sayEn, sayDe) => {
    await mount(failed({ code, status, retryable: true, reasking: true }));
    expect(reason()).toBe(sayEn);
    await mount(failed({ code, status, retryable: true, reasking: true }), vi.fn(), "de");
    expect(reason()).toBe(sayDe);
  });

  it("control: without the re-ask the line reads as before", async () => {
    await mount(failed({ code: "mailbox_busy", status: 429, retryable: true }));
    expect(reason()).toBe("ohmail already has this mailbox's connections open");
    expect(retry()?.textContent).toBe("Try again");
  });
});
