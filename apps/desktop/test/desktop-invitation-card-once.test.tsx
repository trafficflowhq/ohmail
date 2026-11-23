/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { EngineProvider } from "../../webapp/app/shell/engine";
import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment.js";
import { ROSTER, storeWith } from "../../webapp/test/_draft-shell";
import { EXCHANGE_ICAL, GOOGLE, type InviteShape } from "../../../packages/core/test/fixtures/invite-shapes";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame";
import { DesktopLocale } from "../src/DesktopLocale";
import { linkSlot } from "../src/link-in";

/**
 * ON THE DESKTOP, A MEETING INVITATION SHOWS ITS EVENT ONCE, ABOVE THE MAIL (owner screenshot
 * 2026-10-22). The window armed as the desktop arms it, the reading pane over the real attachment
 * seam, a Google invitation's two calendar parts (the alternative and invite.ics) as ingest
 * stores them: one card, before the body, and invite.ics once in the strip (the nameless
 * alternative is the body the card reads, never a tile). Exchange's alternative alone: its tile.
 */

for (const name of ["text", "arrayBuffer"] as const) {
  if (typeof (Blob.prototype as unknown as Record<string, unknown>)[name] !== "function") {
    (Blob.prototype as unknown as Record<string, () => Promise<unknown>>)[name] = function (this: Blob) {
      return new Promise((ok, no) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result);
        fr.onerror = () => no(fr.error);
        if (name === "text") fr.readAsText(this);
        else fr.readAsArrayBuffer(this);
      });
    };
  }
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { React: unknown }).React = React;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const ID = "m-google";
const shell = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } };

beforeAll(() => {
  enableDesktopAttachments();
});

const message = {
  id: ID, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Invitation: Quarterly planning", from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [{ name: "Mila Reader", address: "mila@example.test" }], cc: [],
  date: "2026-10-22T08:00:00.000Z", folder: "INBOX", snippet: GOOGLE.text, unread: false,
  hasAttachments: true, attachmentCount: 2,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-22T08:00:00.000Z",
} as unknown as EngineMessage;

async function engineServing(shape: InviteShape): Promise<OhmailEngine> {
  const adapter: EngineAdapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: message.date,
    }),
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => ({
      text: shape.text, html: shape.html, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }),
    listAttachments: async () => shape.parts.map((p) => ({
      id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length,
      inline: p.inline, contentId: p.contentId, messageId: ID,
    })),
    fetchAttachment: async (id: string) => new Blob([shape.parts.find((p) => p.id === id)!.bytes], { type: "application/octet-stream" }),
  };
  return new OhmailEngine({ adapter, store: await storeWith([{ ...message, mailboxId: ROSTER[0]!.id }], []) });
}

const noChange = () => undefined;

async function openInDesktop(shape: InviteShape): Promise<HTMLElement> {
  const engine = await engineServing(shape);
  const props: DesktopFrameProps = {
    engine, status: { state: "serving", mode: "local" }, session: "live", sessionRefused: false,
    sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null, storage: null,
    mayLinkOut: false, manageOffered: false, withdrawManage: noChange, rereadAccess: noChange,
    reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: noChange, onStatus: noChange,
    openOverlay: noChange, takeOver: noChange, firstRunOpen: false, firstRun: undefined, takesMailLinks: true,
    scope: "acct-invitation-desktop", onUnread: noChange,
    liveBody: async () => ({ kind: "loaded", text: shape.text, html: shape.html }),
    links: linkSlot(), connection: { read: () => null, subscribe: () => noChange },
  };
  window.location.hash = `#/ohbox/m/${ID}`;
  render(<DesktopLocale><ThemeProvider><ToastHost>
    <EngineProvider demo={false} engine={engine}><DesktopFrame {...props} /></EngineProvider>
  </ToastHost></ThemeProvider></DesktopLocale>);
  return screen.findByRole("region", { name: "Open message" });
}

beforeEach(() => {
  shell.__TAURI_INTERNALS__ = { invoke: async () => null };
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:tauri://localhost/obj";
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  delete shell.__TAURI_INTERNALS__;
});

async function until(done: () => boolean, ms = 4_000): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 20) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

describe("the desktop reading pane: one event card, after the mail", () => {
  it("a Google invitation's two calendar parts draw one card after the body and before the files", async () => {
    const host = await openInDesktop(GOOGLE);
    await until(() => host.querySelector("button.oh-file-main") !== null && host.querySelector(".ics-card") !== null);
    // Settle past the arrival: a second card would land with the same texts.
    await until(() => false, 300);
    const cards = host.querySelectorAll(".ics-card");
    expect(cards, "the invitation drew no card, or one per part").toHaveLength(1);
    const body = host.querySelector("[data-read-body]");
    expect(body, "the premise: the pane drew the body").not.toBeNull();
    expect(body!.contains(cards[0]!)).toBe(false);
    expect(body!.compareDocumentPosition(cards[0]!) & Node.DOCUMENT_POSITION_FOLLOWING, "the card is after the body").toBeTruthy();
    const tiles = host.querySelectorAll("button.oh-file-main");
    expect(tiles, "invite.ics is listed twice, or the file left the strip").toHaveLength(1);
    expect(cards[0]!.compareDocumentPosition(tiles[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tiles[0]!.querySelector(".oh-file-title")?.textContent).toBe("invite.ics");
  });

  it("an Exchange invitation (the alternative only) draws its card and keeps its one tile", async () => {
    const host = await openInDesktop(EXCHANGE_ICAL);
    await until(() => host.querySelector(".ics-card") !== null);
    await until(() => false, 300);
    expect(host.querySelectorAll(".ics-card")).toHaveLength(1);
    const tiles = host.querySelectorAll(".oh-files .oh-file");
    expect(tiles, "the only copy of the event left the strip").toHaveLength(1);
    expect(tiles[0]!.querySelector(".oh-file-title")?.textContent).toBe("invite.ics");
  });
});
