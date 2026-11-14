/** @vitest-environment jsdom */
/**
 * THE WEB'S REAL HOST, READ BACK BY THE ADAPTER: what today's views are handed on the managed build and the self-hosted
 * one equals what `CloudShell` handed the old shell, input by input. Each hosted wire is the shared file's own object:
 * the one the views fell back to when the old door was handed nothing.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NONE, type FrameSupplies, type HostContract } from "@ohmail/app/host";

const flavor = vi.hoisted(() => ({ selfHost: false }));
vi.mock("../../app/hello", async () => {
  const real = await vi.importActual<typeof import("../../app/hello")>("../../app/hello");
  return {
    ...real,
    get SELF_HOST_BUILD() { return flavor.selfHost; },
  };
});

const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const frame = {
  places: named("places"), stages: named("stages"), address: named("address"), window: named("window"),
  appearance: named("appearance"), recover: NONE,
} as FrameSupplies;
const engine = named<HostContract["engine"]>("engine");

async function inputsOf(selfHost: boolean, server = { pairing: true, remoteImages: false }) {
  return (await hostOf(selfHost, server)).read;
}

/** The web's host as the page builds it, and what the adapter reads back off it. */
async function hostOf(selfHost: boolean, server = { pairing: true, remoteImages: false }) {
  flavor.selfHost = selfHost;
  vi.resetModules();
  const { useWebHost } = await import("../../app/(product)/mailbox/web-supplies");
  const { todaysInputs, NO_TODAYS } = await import("../../app/shell/todays-inputs");
  const mailboxFacts = async () => [];
  const words = {
    server, invites: selfHost, subscriptionPage: !selfHost, withdrawManage: () => undefined, storageBlock: !selfHost,
    account: "acct-1", firstRun: undefined, mailboxFacts, resolve: async () => ({ kind: "none" }) as never, confirmed: () => undefined,
  };
  const { result } = renderHook(() => useWebHost(engine, words, frame));
  return { host: result.current, read: { inputs: todaysInputs(result.current, NO_TODAYS), mailboxFacts } };
}

describe("the web's host, read back as today's inputs", () => {
  it("hands every hosted wire as the shared file's own object, and the managed service's words", async () => {
    const { inputs, mailboxFacts } = await inputsOf(false);
    const { CLOUD_CONSENT } = await import("../../app/(product)/mailbox/consent-over-api");
    const { HOSTED } = await import("../../app/shell/ProfileImportCard");
    const { CLOUD_OLDER_BODY } = await import("../../app/shell/older-body");
    const junk = await import("../../app/(product)/mailbox/junk-wire");
    const trash = await import("../../app/shell/trash-window");
    const suggest = await import("../../app/(product)/mailbox/suggest-wire");
    const draft = await import("../../app/shell/draft-reply");
    const { away } = await import("../../app/api-client");
    const { browserNotificationHost } = await import("../../app/shell/notification-settings");
    const { liveBodyOverApi, SEND_SURFACE } = await import("../../app/(product)/mailbox/web-supplies");
    expect(inputs.consentTransport).toBe(CLOUD_CONSENT);
    expect(inputs.profileImportTransport).toBe(HOSTED);
    expect(inputs.olderBodyWire).toBe(CLOUD_OLDER_BODY);
    expect(inputs.junkWire).toBe(junk.cloudWire);
    expect(inputs.trashWire).toBe(trash.cloudWire);
    expect(inputs.suggestWire).toBe(suggest.CLOUD_WIRE);
    expect(inputs.draftReplyWire).toBe(draft.CLOUD_WIRE);
    expect(inputs.awayTransport).toBe(away);
    expect(inputs.notificationHost).toBe(browserNotificationHost);
    expect(inputs.liveBodyWire).toBe(liveBodyOverApi);
    expect(inputs.mailboxFacts).toBe(mailboxFacts);
    // What `CloudShell` passed: the managed service, its ceiling, Help with the confirmed account, no picture fetcher.
    expect(inputs.managedService).toBe(true);
    expect(inputs.sendSurfaceMaxTotalBytes).toBe(SEND_SURFACE === undefined ? undefined : SEND_SURFACE);
    expect(inputs.support).toEqual({ surface: "web", version: null, commit: null, accountId: "acct-1", mailtoLeaves: true });
    expect(inputs.imageWire).toBeUndefined();
    expect(inputs.imagesFromComputer).toBe(false);
    expect(inputs.actRulesUnmarked).toBe(false);
    expect(inputs.awayIsLocal).toBe(false);
    expect(inputs.awayOnHost).toBeUndefined();
    expect(inputs.firstRun).toBeUndefined();
    expect(inputs.mirrorFreshness).toBeUndefined();
    expect(inputs.desktopSection).toBeUndefined();
    expect(inputs.screenerSuggest).toBeUndefined();
    expect(inputs.onUnread).toBeUndefined();
    expect(inputs.billingSection).toBeDefined();
    expect(inputs.storageSection).toBeDefined();
    expect(inputs.devicesSection).toBeDefined();
    expect(inputs.invitesSection).toBeUndefined();
    // Settings' panes the web fills itself: its Mailboxes (with the filings and the self-check) and About.
    expect(inputs.mailboxSection).toBeDefined();
    expect(inputs.aboutSection).toBeDefined();
    expect(inputs.accountSection).toBeDefined();
    expect(inputs.screeningSection).toBeDefined();
  });

  it("on a server its operator runs: no Load it now, no Help, no subscription, and invites where the server says", async () => {
    const { inputs } = await inputsOf(true);
    expect(inputs.managedService).toBe(false);
    expect(inputs.liveBodyWire).toBeUndefined();
    expect(inputs.support).toBeUndefined();
    expect(inputs.billingSection).toBeUndefined();
    expect(inputs.storageSection).toBeUndefined();
    expect(inputs.invitesSection).toBeDefined();
  });

  it("where the server pairs nothing, Settings has no Devices", async () => {
    const { inputs } = await inputsOf(false, { pairing: false, remoteImages: false });
    expect(inputs.devicesSection).toBeUndefined();
  });

  it("hands the review of who you write to where this page has a client, and nowhere else", async () => {
    const before = process.env.NEXT_PUBLIC_API_BASE;
    const pageFetch = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    try {
      process.env.NEXT_PUBLIC_API_BASE = "/api";
      const { host } = await hostOf(false);
      const review = host.wires.seedReview;
      expect(review, "a page with its own client offers no review").not.toBe(NONE);
      if (review === NONE) return;
      await review.read();
      await review.confirm(["lena@example.invalid"], { idempotencyKey: "press-1" });
      expect(sent).toEqual(["GET /api/consent/seed", "POST /api/consent/seed"]);
      const { CLOUD_SEED_REVIEW } = await import("../../app/(product)/mailbox/consent-over-api");
      expect(review).toBe(CLOUD_SEED_REVIEW);

      process.env.NEXT_PUBLIC_API_BASE = "";
      expect((await hostOf(false)).host.wires.seedReview, "a page with no client offers a review nothing can run").toBe(NONE);
    } finally {
      globalThis.fetch = pageFetch;
      if (before === undefined) delete process.env.NEXT_PUBLIC_API_BASE;
      else process.env.NEXT_PUBLIC_API_BASE = before;
    }
  });

  it("holds the folders flag to the consent object's own word", async () => {
    const { inputs } = await inputsOf(false);
    const { CLOUD_CONSENT } = await import("../../app/(product)/mailbox/consent-over-api");
    expect(inputs.consentTransport?.foldersStorable).toBe(CLOUD_CONSENT.foldersStorable);
  });
});
