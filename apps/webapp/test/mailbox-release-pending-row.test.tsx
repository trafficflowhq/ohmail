/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ A PENDING "STOP ORGANIZING HERE" IS ON THE ROW, NOT ONLY IN A LOG ═══════════════════════
 *
 * ── THE DEFECT, MEASURED LIVE ON A REAL PROVIDER AT RC3 ─────────────────────────────────────
 *
 * "Stop organizing here, keep the mail" is recorded as a REQUEST (`release_requested_at`) and
 * honoured by the organizer's own next pass — and on a provider that refuses the release's
 * folder read, that pass retried on every poll for a whole session. For all of it the row kept
 * `organizerRole: "organizer"`, so this pane rendered the ordinary "organized here" description
 * with the ordinary "Stop organizing" button: the person's press showed no trace anywhere, on a
 * mailbox that was deliberately filing nothing while the request stood. A pressed button whose
 * only visible effect is nothing reads as the button not working — and pressing it again writes
 * the same request again, which is how "it does nothing" gets measured twice.
 *
 * The DTO now carries the request (`releaseRequestedAt`), and the row's description names the
 * state: stopping on the next pass, waiting for the server to confirm.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 * The RENDER: a pending row says the pending sentence and not the ordinary organized one, in
 * both languages; the ordinary organized row is the positive control and says the ordinary
 * sentence and not the pending one — a rule whose every case asserts the new sentence has no
 * evidence it left the ordinary row alone.
 *
 * ── HOW TO WATCH THIS FAIL ──────────────────────────────────────────────────────────────────
 *
 *  · WATCHED RED before the pane arm existed: the pending case failed with the ordinary
 *    "organized here" description over a row whose request was standing — the live shape.
 *  · Delete the `releaseRequestedAt` arm from the organizer banner and the pending case goes
 *    red the same way; drop the field from the DTO projection and it goes red one seam earlier.
 */

const copy = en.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;

const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, accountId: "acc1" },
        scope: "full",
      }),
    },
    billing: { subscription: async () => ({ entitlements: null, subscription: healthy }) },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      organizer: async () => ({ holders: [], unreadable: 0 }),
      organize: async () => ({ outcome: "authorized" }),
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

/** The live row: an organizer whose stop request is standing, unanswered by the server so far. */
const pending = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected",
  lastSyncAt: "2026-09-07T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  releaseRequestedAt: "2026-09-07T09:00:00.000Z",
  ...over,
} as MailboxDTO);

/** The ordinary organizer — the positive control, so the new sentence cannot leak onto it. */
const organizing = (over: Partial<MailboxDTO> = {}): MailboxDTO =>
  pending({ releaseRequestedAt: null, ...over });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function mount(locale: "en" | "de", ...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale,
      messages: (locale === "en" ? en : de) as never,
      children: h(MailboxSection),
    }));
  });
  await settle();
  return host;
}

beforeEach(() => { mockListed = []; });
afterEach(async () => { await unmount(); });

describe("a standing stop request is on the row", () => {
  it("says stopping is pending, not that the mailbox is organized here as usual", async () => {
    const el = await mount("en", pending());
    const said = el.textContent ?? "";
    expect(said, "a pressed stop shows no trace on the row — the live RC3 shape")
      .toContain(copy.stopOrganizingPending!);
    expect(said, "the ordinary organized description stands beside a pending stop")
      .not.toContain(copy.stateOrganizingCloud!);
  });

  it("…in German too — a branch resolved in one catalogue and not the other renders the key", async () => {
    const el = await mount("de", pending());
    const said = el.textContent ?? "";
    expect(said, "the pending sentence is missing from the German catalogue's render")
      .toContain(copyDe.stopOrganizingPending!);
    expect(said, "the raw key path reached the screen").not.toContain("stopOrganizingPending");
  });

  it("an ordinary organizer still reads as organized here — the positive control", async () => {
    const el = await mount("en", organizing());
    const said = el.textContent ?? "";
    expect(said, "the ordinary organized row lost its own description")
      .toContain(copy.stateOrganizingCloud!);
    expect(said, "the pending sentence leaked onto a row with nothing pending")
      .not.toContain(copy.stopOrganizingPending!);
  });

  /**
   * THE SIBLING-LAPSE REFUSAL SAYS ITS OWN SENTENCE (mail 0121) — the desktop pane's arm on
   * this surface: a stop refused because a live claim carries this install's id under a nonce it
   * never wrote (a restored image or clone) wears the doc's sentence, which names the holder —
   * another copy of ohmail Cloud, here — and what ends the wait. The plain pending case above is this
   * one's negative arm: the field appears on that refusal alone.
   */
  it("a stop REFUSED by a live sibling says the doc's sentence, never plain pending", async () => {
    const el = await mount("en", pending({ releaseRefusal: "sibling_lapse" }));
    const said = el.textContent ?? "";
    expect(said, "the refusal renders as an ordinary pending confirm — the clone-fight false state")
      .toContain(copy.stopOrganizingSiblingLapseCloud!);
    expect(said, "two sentences about one standing stop")
      .not.toContain(copy.stopOrganizingPending!);
  });

  it("…in German too", async () => {
    const el = await mount("de", pending({ releaseRefusal: "sibling_lapse" }));
    const said = el.textContent ?? "";
    expect(said).toContain(copyDe.stopOrganizingSiblingLapseCloud!);
    expect(said, "the raw key path reached the screen").not.toContain("stopOrganizingSiblingLapse");
  });
});
