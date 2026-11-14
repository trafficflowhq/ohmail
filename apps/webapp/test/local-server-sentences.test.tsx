/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import { deriveMailState, seedGrowth, type MailState, type MailboxFacts, type StoreRefusals } from "@ohmail/app-logic/mail-state/mail-state";
import { mailboxErrorKey } from "@ohmail/app-logic/mail-state/mailbox-error-key";
import { setActiveCatalog } from "../app/shell/locale";

/**
 * A SERVER ON THIS COMPUTER IS SAID AS ITS OWN (ruled 2026-10-07 runtime-timeout-sentence).
 * The desktop overlay stamps `errorLocalServer` beside `auth`/`timeout` for a loopback host; ONE
 * chooser picks the local sentence for the strip, where it outranks the generic outage line. The
 * web's own doors never wait for such a server, so web Settings keeps its sentences. en and de.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null,
  continuesAtFolder: null, settled: true, owed: false,
};
let current: MailState = QUIET;
const mockListed: MailboxDTO[] = [];
const healthy = {
  subscription: { plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500, currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null },
  balance: 0, plans: {},
  entitlements: { mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active" },
} as unknown as SubscriptionStatus;
vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: { session: async () => ({ user: { email: "person@example.test", emailVerified: true }, scope: "full" }) },
    billing: { subscription: async () => healthy },
    mailboxes: { list: async () => ({ items: mockListed }), resync: async () => undefined },
  };
});
vi.mock("../app/shell/MailStateProvider", () => ({ useMailState: () => ({ state: current, refresh: () => {} }) }));

const EXACT: StoreRefusals = { count: 612, retrying: 612, exact: true };
const CAPPED: StoreRefusals = { count: 612, retrying: 500, exact: true };
const FLOOR: StoreRefusals = { count: 10_500, retrying: 500, exact: false };
const ONE: StoreRefusals = { count: 1, retrying: 1, exact: true };
const failing = (r?: StoreRefusals): MailState => ({
  ...QUIET, key: "mailboxError", errorCode: "storage", address: "me@example.test", ...(r ? { storeRefusals: r } : {}),
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  setActiveCatalog("en", null);
});

async function stripText(state: MailState, lang: "en" | "de"): Promise<string> {
  current = state;
  setActiveCatalog(lang, null);
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: lang, messages: lang === "en" ? en : de, timeZone: "UTC", now: new Date("2026-09-29T08:00:00.000Z"),
      children: h(SyncBar, { variant: "rail" }),
    }));
  });
  return host.textContent ?? "";
}

const M = en.mailboxes as Record<string, string>;
const DM = de.mailboxes as Record<string, string>;
const SYNC = en.sync as Record<string, string>;

describe("the chooser picks the local server's own key beside auth and timeout only", () => {
  it("auth and timeout from a local server; every other code and every remote one as before", () => {
    expect(mailboxErrorKey("auth", null, undefined, undefined, true)).toEqual({ key: "err_auth_local" });
    expect(mailboxErrorKey("timeout", null, undefined, undefined, true)).toEqual({ key: "err_timeout_local" });
    expect(mailboxErrorKey("connect", null, undefined, undefined, true)).toEqual({ key: "err_connect" });
    expect(mailboxErrorKey("auth", null)).toEqual({ key: "err_auth" });
    expect(mailboxErrorKey("timeout", null, undefined, undefined, false)).toEqual({ key: "err_timeout" });
    // A detail token still outranks it: the never-dialled sentences are about this install.
    expect(mailboxErrorKey("connect", "MAILBOX_PLAINTEXT_REFUSED", undefined, undefined, true)).toEqual({ key: "err_plaintext_refused" });
  });

  it("LOW 5 and its twin: the timeouts name no sign-in — the bound covers every step of the dial", () => {
    for (const key of ["err_timeout_local", "probe_timeout_local"]) {
      expect(M[key], key).toMatch(/did not answer in time/);
      expect(M[key], key).not.toMatch(/sign-in/i);
      expect(DM[key], key).toMatch(/nicht rechtzeitig/);
      expect(DM[key], key).not.toMatch(/Anmeldung/);
    }
  });

  it("the probe key: the two-minute sentence is the incoming leg's only", async () => {
    const { probeCopyKey } = await import("@ohmail/app-logic/doors/local-server-host");
    expect(probeCopyKey("timeout", true)).toBe("probe_timeout_local");
    expect(probeCopyKey("timeout", true, "smtp")).toBe("probe_timeout_smtp");
    expect(probeCopyKey("auth", true, "smtp")).toBe("probe_auth_local");
    expect(probeCopyKey("auth", false)).toBe("probe_auth");
  });

  it("the wire's flag survives the narrowing into the shell's facts", async () => {
    const { toMailboxFacts } = await import("../app/(product)/mailbox/mailbox-facts.js");
    const base = {
      id: "mb1", provider: "imap", address: "me@gateway.test", displayName: null, status: "error",
      lastSyncAt: null, createdAt: "2026-09-20T10:00:00.000Z", errorCode: "timeout",
    } as unknown as MailboxDTO;
    expect(toMailboxFacts({ ...base, errorLocalServer: true }).errorLocalServer).toBe(true);
    expect("errorLocalServer" in toMailboxFacts(base)).toBe(false);
  });

  it("the ladder carries the flag from the row onto the strip's arm", () => {
    const now = Date.parse("2026-09-29T08:00:00.000Z");
    const m: MailboxFacts = {
      id: "mb1", address: "me@gateway.test", status: "error", errorCode: "timeout", errorLocalServer: true,
      disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
      lastSyncAt: new Date(now - 30_000).toISOString(), initialImportCompletedAt: new Date(now - 60_000).toISOString(),
      createdAt: new Date(now - 120_000).toISOString(), unreachableSince: new Date(now - 10_000).toISOString(),
    };
    const state = deriveMailState({
      sync: { phase: "idle" } as never, failureStreak: 0, mailboxes: [m], mirrored: 10, pulled: 10,
      growth: seedGrowth(10), freshness: { state: "current", asOf: new Date(now).toISOString() },
      engineFreshness: { state: "current", asOf: new Date(now).toISOString() }, now, demo: false,
    });
    expect(state).toMatchObject({ key: "mailboxError", errorCode: "timeout", errorLocalServer: true, unreachable: true });
  });
});

describe("the strip", () => {
  const failing = (over: Partial<MailState>): MailState => ({
    ...QUIET, key: "mailboxError", address: "me@gateway.test", ...over,
  });

  it("a local server that went quiet: its own sentence over the outage line, en and de", async () => {
    const s = failing({ errorCode: "timeout", errorLocalServer: true, unreachable: true });
    const enText = await stripText(s, "en");
    expect(enText).toContain(M.err_timeout_local);
    expect(enText).not.toContain(SYNC.unreachable);
    await act(async () => { root?.unmount(); });
    root = null;
    expect(await stripText(s, "de")).toContain(DM.err_timeout_local);
  });

  it("a local server that refused: its own sentence, not the password one", async () => {
    const text = await stripText(failing({ errorCode: "auth", errorLocalServer: true }), "en");
    expect(text).toContain(M.err_auth_local);
    expect(text).not.toContain(M.err_auth);
  });

  it("CONTROL (ruled): a remote host that timed out still reads the generic unreachable line", async () => {
    const text = await stripText(failing({ errorCode: "connect", unreachable: true }), "en");
    expect(text).toContain(SYNC.unreachable);
    expect(text).not.toContain(M.err_timeout_local);
  });
});
