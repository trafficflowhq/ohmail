/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  deriveMailState, seedGrowth, type MailState, type MailStateInputs, type MailboxFacts,
} from "../app/shell/mail-state";

/**
 * A `_meta` THAT TAKES NO DELETE ASKS FOR A PERMISSION, NEVER A DELETION (mail 0143). The server
 * refuses ohmail's own removals, so the cure is the folder's delete right; a sentence telling the
 * person to delete or remove mail would cost them mail and cure nothing. Read off the rendered
 * strip in both catalogues, with a planted imperative as the control that the refusal reads text.
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

/** An imperative to delete or remove, or one aimed at the person's mail, in either catalogue. */
const DELETE_ASKED = /(^|[.—]\s*)(delete|remove|lösche|entferne)\b|\b(delete|remove|lösche|entferne)\s+(your|the|deine|die|dort)\b/i;

describe("the undeletable meta folder's sentence", () => {
  it.each([
    ["en", "permission"],
    ["de", "Berechtigung"],
  ] as const)("%s names the folder and asks for a permission, never a deletion", async (locale, permission) => {
    const text = await strip("meta_undeletable", locale);
    expect(text).toContain("ohmail/_meta");
    expect(text).toContain(permission);
    expect(text, "the cure asks the person to delete mail").not.toMatch(DELETE_ASKED);
    expect(text).not.toContain("blocked_meta_undeletable");
  });

  it("CONTROL: a planted imperative to delete is caught", async () => {
    const text = await strip("meta_undeletable", "en");
    expect(`${text} Delete the messages in it.`).toMatch(DELETE_ASKED);
    expect(`${await strip("meta_undeletable", "de")} Lösche die Nachrichten.`).toMatch(DELETE_ASKED);
  });
});

/* A mailbox at its quota refused the claim for room (mail 0185): the sentence names the full
   mailbox and where to make room, never the folder ohmail could not read. */
describe("the full mailbox's sentence", () => {
  it.each([
    ["en", "full", "Free up space", ["cannot read its own folder"]],
    ["de", "voll", "Schaffe Platz", ["kann seinen eigenen Ordner"]],
  ] as const)("%s says the mailbox is full and where to make room", async (locale, full, room, never) => {
    const text = await strip("mailbox_full", locale);
    expect(text).toContain(full);
    expect(text).toContain(room);
    for (const n of never) expect(text).not.toContain(n);
    expect(text).not.toContain("_meta");
    expect(text).not.toContain("blocked_mailbox_full");
    expect(text, "the cure asks the person to delete mail").not.toMatch(DELETE_ASKED);
  });
});
