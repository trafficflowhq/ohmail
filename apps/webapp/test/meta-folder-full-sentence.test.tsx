/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  deriveMailState, seedGrowth, type MailState, type MailStateInputs, type MailboxFacts,
} from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A FULL `ohmail/_meta` IS CURED BY MOVING MAIL, NEVER BY DELETING IT (mail 0142). The filler a
 * person can cure is their own mail filed into the folder, so a sentence telling them to remove
 * or delete would cost them that mail. Read off the rendered strip in both catalogues; the
 * `lease_unreadable` row beside it is the control that the refusal reads real text.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let current: MailState | null = null;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

const NOW = Date.parse("2026-10-04T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const blocked = (reason: string): MailboxFacts => ({
  id: "mb1", address: "person@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: reason, syncBlockedSince: ago(120_000), lastSyncAt: ago(30_000),
  initialImportCompletedAt: ago(600_000), createdAt: ago(900_000),
});

const inputs = (reason: string): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false },
  failureStreak: 3, mailboxes: [blocked(reason)], mirrored: 495, growth: seedGrowth(495),
  freshness: { state: "current" as const, asOf: ago(30_000) },
  engineFreshness: { state: "current" as const, asOf: ago(30_000) },
  now: NOW, demo: false,
} as MailStateInputs);

async function strip(reason: string, locale: "en" | "de"): Promise<string> {
  current = deriveMailState(inputs(reason));
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC", now: new Date(NOW),
      children: h(SyncBar, null),
    }));
  });
  return container.textContent ?? "";
}

const DESTRUCTIVE = /remov|delet|lösch|entfern/i;

describe("the full meta folder's sentence", () => {
  it.each([
    ["en", "ohmail/_meta", "Move mail that was filed into it to another folder"],
    ["de", "ohmail/_meta", "Verschiebe dort abgelegte Mails in einen anderen Ordner"],
  ] as const)("%s names the folder and the move, and never a removal", async (locale, folder, move) => {
    const text = await strip("meta_folder_full", locale);
    expect(text).toContain(folder);
    expect(text).toContain(move);
    expect(text, "the cure would delete the person's own mail").not.toMatch(DESTRUCTIVE);
    expect(text).not.toContain("blocked_meta_folder_full");
  });

  it("CONTROL: the refusal reads rendered words — a planted removal is caught", async () => {
    const text = await strip("meta_folder_full", "en");
    expect(`${text} Remove it.`).toMatch(DESTRUCTIVE);
    expect(await strip("lease_unreadable", "de")).toContain("kann seinen eigenen Ordner");
  });
});
