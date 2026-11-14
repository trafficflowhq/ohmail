/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import { filerKey, type FilerSentence, type MailState, type WebFiler } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A SELF-HOSTED WEB BUILD NAMES ITSELF, NEVER OHMAIL CLOUD. Settings → Mailboxes said "Cloud is not
 * organizing this mailbox…", "This takes Cloud's claim…", "Another ohmail Cloud install has
 * claimed…" and "Take over on Cloud…" on a server its operator runs. Watched red at the base:
 * every server case read the Cloud sentence. The managed build is the control and keeps its words.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = en.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;
const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

const build = vi.hoisted(() => ({ selfHost: false }));
vi.mock("../app/hello", async () => {
  const actual = await vi.importActual<typeof import("../app/hello")>("../app/hello");
  return {
    ...actual,
    get SELF_HOST_BUILD() { return build.selfHost; },
    serverHello: async () => null,
  };
});

let mockListed: MailboxDTO[] = [];
let organizeOutcome: "authorized" | "already_organizing" = "authorized";
/** The takeover check's fresh read: a live server holder unless a case says it stopped. */
const peekOf = (active: boolean) => ({
  state: active ? "held" : "stopped", unreadable: 0,
  holders: [{ kind: "cloud", displayName: null, heartbeatAt: "2026-09-26T08:00:00.000Z", active }],
});
let mockPeek = peekOf(true);

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
      organizer: async () => mockPeek,
      organize: async () => ({ outcome: organizeOutcome }),
      release: async () => ({ outcome: "requested" }),
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

const SINCE = "2026-09-01T08:00:00.000Z";
const row = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected",
  lastSyncAt: "2026-09-07T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "organizer", organizedBy: null, organizerState: null,
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null, releaseRequestedAt: null,
  ...over,
} as MailboxDTO);
/** This install's own claim, left behind: a reader the server says is still claimed by us. */
const stranded = (): MailboxDTO => row({
  organizerRole: "reader", organizedBy: { kind: "cloud", name: null, since: SINCE },
  organizedByThisInstall: true, organizerState: "stopped",
} as Partial<MailboxDTO>);
/** Another server-kind install's claim — the stand-down the takeover answers. */
const claimedElsewhere = (): MailboxDTO => row({
  organizerRole: "reader", organizedBy: { kind: "cloud", name: null, since: SINCE },
  organizedByThisInstall: false, organizerState: "held",
} as Partial<MailboxDTO>);

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

const buttonExactly = (el: HTMLElement, label: string): HTMLButtonElement | null =>
  [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) ?? null;

async function press(el: HTMLElement, label: string): Promise<void> {
  const b = buttonExactly(el, label);
  expect(b, `no "${label}" control on the pane`).not.toBeNull();
  await act(async () => { b!.click(); });
  await settle();
}

/** The pane's text node by node: `textContent` fuses "Reading only" and "Cloud is…" into one word. */
function textOf(el: HTMLElement): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? "");
  return parts.join(" ");
}

beforeEach(() => { mockListed = []; organizeOutcome = "authorized"; mockPeek = peekOf(true); build.selfHost = false; });
afterEach(async () => { await unmount(); });

describe.each([
  { name: "ohmail Cloud (the managed build, the control)", selfHost: false, filer: "cloud" as WebFiler },
  { name: "a self-hosted server", selfHost: true, filer: "server" as WebFiler },
])("on the web, $name names itself in the claim and the takeover", ({ selfHost, filer }) => {
  beforeEach(() => { build.selfHost = selfHost; });
  const said = (sentence: FilerSentence): string => copy[filerKey(sentence, filer)]!;

  it("the heading", async () => {
    const el = await mount("en", row());
    expect(el.querySelector("h2")?.textContent).toBe(said("heading"));
  });

  it("the claim left behind, and what releasing it does", async () => {
    const el = await mount("en", stranded());
    expect(el.textContent).toContain(said("claimLeftBehind"));
    await press(el, copy.releaseClaim!);
    expect(el.textContent).toContain(said("releaseClaimWhat"));
  });

  it("a server holder's claim, the takeover's check, its effect and its answer", async () => {
    let el = await mount("en", claimedElsewhere());
    expect(el.textContent).toContain(said("claimedElsewhere"));
    expect(el.textContent).toContain(said("takeoverHow"));
    await press(el, said("takeoverCheck"));
    expect(el.textContent).toContain(said("takeoverEffect"));
    await press(el, copy.organizerConfirm!);
    expect(el.textContent).toContain(said("takeoverQueued"));

    organizeOutcome = "already_organizing";
    el = await mount("en", claimedElsewhere());
    await press(el, said("takeoverCheck"));
    await press(el, copy.organizerConfirm!);
    expect(el.textContent).toContain(said("takeoverAlready"));

    // A holder that stopped: the effect line promises nothing about it, in this install's spelling.
    mockPeek = peekOf(false);
    el = await mount("en", claimedElsewhere());
    await press(el, said("takeoverCheck"));
    expect(el.textContent).toContain(said("takeoverEffectLapsed"));
  });

  it("the takeover's how names the button under it", () => {
    expect(said("takeoverHow")).toContain(said("takeoverCheck"));
    expect(copyDe[filerKey("takeoverHow", filer)]).toContain(copyDe[filerKey("takeoverCheck", filer)]);
  });
});

describe("a self-hosted pane renders no Cloud sentence, in either language", () => {
  /* Every organizer state the pane draws, with the two wells a press opens. The managed build is
     the control: the same walk there reads Cloud, so the needle can match what it looks for. */
  async function walk(locale: "en" | "de"): Promise<string> {
    const said: string[] = [];
    const c = locale === "en" ? copy : copyDe;
    for (const items of [
      [row()],
      [row({ releaseRequestedAt: SINCE })],
      [row({ releaseRequestedAt: SINCE, releaseRefusal: "sibling_lapse" } as Partial<MailboxDTO>)],
      [row({ organizerRole: "reader", organizedBy: { kind: "local", name: "a laptop", since: SINCE } })],
      [row({ organizerRole: "reader", organizedBy: null, organizerReleasedAt: SINCE })],
    ]) said.push(textOf(await mount(locale, ...items)));
    let el = await mount(locale, stranded());
    await press(el, c.releaseClaim!);
    said.push(textOf(el));
    el = await mount(locale, claimedElsewhere());
    said.push(textOf(el));
    /* Pressed by either column's label, so a pane still reading the other one is walked, not stopped. */
    const labels = (["server", "cloud"] as const).map((f) => c[filerKey("takeoverCheck", f)]!);
    await press(el, labels.find((label) => buttonExactly(el, label)) ?? labels[0]!);
    said.push(textOf(el));
    await press(el, c.organizerConfirm!);
    said.push(textOf(el));
    return said.join("\n");
  }

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: CONTROL — the managed build reads Cloud on the same walk`, async () => {
      build.selfHost = false;
      expect(await walk(locale)).toMatch(/\bCloud\b/);
    });

    it(`${locale}: the self-hosted build reads none`, async () => {
      build.selfHost = true;
      const text = await walk(locale);
      expect(text.match(/.{0,60}\bCloud\b.{0,40}/g) ?? []).toEqual([]);
    });
  }
});
