/** @vitest-environment jsdom */
/**
 * THE WEB'S REAL HOST, READ BACK BY THE ADAPTER: what today's views are handed on the managed build and the self-hosted
 * one equals what `CloudShell` handed the old shell, input by input. Each hosted wire is the shared file's own object:
 * the one the views fell back to when the old door was handed nothing.
 */
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { NONE, type FrameSupplies, type HostContract } from "@ohmail/app/host";
import type { ServerHello } from "../../app/hello";
import messages from "../../messages/en.json";

/** The words' provider the page's every entry stands under (`LocaleShell`), as the frame's tests mount it. */
const Words = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{children}</NextIntlClientProvider>
);

const flavor = vi.hoisted(() => ({
  selfHost: false,
  /** What the server's `/hello` answers, in turn, where a case says it (`null`: no answer); else the real ask. */
  hellos: null as Array<ServerHello | null> | null,
  asked: 0,
}));
vi.mock("../../app/hello", async () => {
  const real = await vi.importActual<typeof import("../../app/hello")>("../../app/hello");
  return {
    ...real,
    get SELF_HOST_BUILD() { return flavor.selfHost; },
    serverHello: (...args: Parameters<typeof real.serverHello>) => {
      if (flavor.hellos === null) return real.serverHello(...args);
      flavor.asked += 1;
      return Promise.resolve(flavor.hellos.shift() ?? null);
    },
  };
});

const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const frame = {
  places: named("places"), stages: named("stages"), overs: named("overs"), address: named("address"), window: named("window"),
  appearance: named("appearance"), recover: NONE,
} as FrameSupplies;
const engine = named<HostContract["engine"]>("engine");

async function inputsOf(selfHost: boolean, server = { pairing: true, remoteImages: false, searchPeople: false }) {
  return (await hostOf(selfHost, server)).read;
}

/** The web's host as the page builds it, and what the adapter reads back off it. */
async function hostOf(selfHost: boolean, server = { pairing: true, remoteImages: false, searchPeople: false }) {
  flavor.selfHost = selfHost;
  vi.resetModules();
  const { useWebHost } = await import("../../app/(product)/mailbox/web-supplies");
  const { todaysInputs, NO_TODAYS } = await import("../../app/shell/todays-inputs");
  const mailboxFacts = async () => [];
  const words = {
    server, invites: selfHost, subscriptionPage: !selfHost, withdrawManage: () => undefined, storageBlock: !selfHost,
    account: "acct-1", firstRun: undefined, mailboxFacts, resolve: async () => ({ kind: "none" }) as never, confirmed: () => undefined,
  };
  const { result } = renderHook(() => useWebHost(engine, words, frame), { wrapper: Words });
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
    const draft = await import("../../app/(product)/mailbox/draft-reply-wire");
    const { away } = await import("../../app/api-client");
    const { browserNotificationHost } = await import("../../app/shell/notification-settings");
    const { browserNoticePage, webNoticeEmitter } = await import("../../app/shell/notice-emitter");
    const { liveBodyOverApi, SEND_SURFACE } = await import("../../app/(product)/mailbox/web-supplies");
    expect(inputs.consentTransport).toBe(CLOUD_CONSENT);
    expect(inputs.profileImportTransport).toBe(HOSTED);
    expect(inputs.olderBodyWire).toBe(CLOUD_OLDER_BODY);
    expect(inputs.junkWire).toBe(junk.cloudWire);
    expect(inputs.trashWire).toBe(trash.cloudWire);
    expect(inputs.suggestWire).toBe(suggest.CLOUD_WIRE);
    expect(inputs.draftReplyWire).toBe(draft.CLOUD_WIRE);
    expect(inputs.awayTransport).toBe(away);
    // The browser's own notification host, each part the shared file's object; its notices the page's own emitter.
    const pageEmitter = webNoticeEmitter(browserNoticePage, () => { throw new Error("nothing is drawn here"); });
    expect(inputs.notificationHost).toEqual({
      ...browserNotificationHost,
      emitter: { ...pageEmitter, post: expect.any(Function), takeBack: expect.any(Function) },
    });
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
    const { inputs } = await inputsOf(false, { pairing: false, remoteImages: false, searchPeople: false });
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

/** A server that says it fetches pictures. */
const FETCHES_PICTURES = {
  product: "ohmail", flavor: "managed", needsSetup: false,
  features: { staging: true, ai: true, pairing: true, remoteImages: true },
} as ServerHello;

/** The page as `CloudShell` builds it: the server's words asked by the page, its host built from them. */
async function pageAsking(hellos: Array<ServerHello | null>) {
  flavor.selfHost = false;
  flavor.hellos = hellos;
  flavor.asked = 0;
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  vi.resetModules();
  const { useServerWords } = await import("../../app/server-words");
  const { useWebHost } = await import("../../app/(product)/mailbox/web-supplies");
  const { todaysInputs, NO_TODAYS } = await import("../../app/shell/todays-inputs");
  const { WEB_IMAGES } = await import("../../app/(product)/mailbox/image-wire");
  const words = {
    invites: false, subscriptionPage: true, withdrawManage: () => undefined, storageBlock: true,
    account: "acct-1", firstRun: undefined, mailboxFacts: async () => [], resolve: async () => ({ kind: "none" }) as never, confirmed: () => undefined,
  };
  const page = renderHook(() => useWebHost(engine, { ...words, server: useServerWords(false) }, frame), { wrapper: Words });
  return { page, wire: () => todaysInputs(page.result.current, NO_TODAYS).imageWire, WEB_IMAGES };
}

describe("the server's first word on pictures, when the page's first ask got no answer", () => {
  const before = process.env.NEXT_PUBLIC_API_BASE;
  const restore = () => {
    flavor.hellos = null;
    vi.useRealTimers();
    if (before === undefined) delete process.env.NEXT_PUBLIC_API_BASE;
    else process.env.NEXT_PUBLIC_API_BASE = before;
  };

  it("a first /hello that fails and a second that says the server fetches pictures hand the old shell the web's wire", async () => {
    const answered = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    try {
      const { page, wire, WEB_IMAGES } = await pageAsking([null, FETCHES_PICTURES]);
      await answered();
      expect(flavor.asked, "the page's first ask").toBe(1);
      expect(wire(), "a picture wire before the server said it fetches pictures").toBeUndefined();
      window.dispatchEvent(new Event("online"));
      await answered();
      expect(flavor.asked, "the page asked again when the window came back online").toBe(2);
      expect(wire(), "the web's own wire, once the server said it fetches pictures").toBe(WEB_IMAGES);
      page.unmount();
    } finally {
      restore();
    }
  });

  it("with the window online all along it asks again after 30 seconds, and at most three times", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { page, wire } = await pageAsking([null, null, null, null, FETCHES_PICTURES]);
      const waited = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      await waited(0);
      expect(flavor.asked, "the page's first ask").toBe(1);
      await waited(29_999);
      expect(flavor.asked, "asked again before 30 seconds had passed").toBe(1);
      await waited(1);
      expect(flavor.asked, "not asked again after 30 seconds").toBe(2);
      await waited(30_000);
      await waited(30_000);
      expect(flavor.asked, "the page's ask and three more").toBe(4);
      await waited(120_000);
      expect(flavor.asked, "asked a fifth time").toBe(4);
      expect(wire(), "a picture wire with no word from the server").toBeUndefined();
      page.unmount();
    } finally {
      restore();
    }
  });

  it("whichever of the online event and the 30 seconds comes first asks, and the other is let go", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { page } = await pageAsking([null, null, null, null, FETCHES_PICTURES]);
      const waited = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      const online = () => act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0); });
      await waited(0);
      expect(flavor.asked, "the page's first ask").toBe(1);
      await online();
      expect(flavor.asked, "the window came back online").toBe(2);
      await waited(30_000);
      expect(flavor.asked, "the first wait's 30 seconds asked as well as the online event").toBe(3);
      await online();
      await online();
      expect(flavor.asked, "the page's ask and three more").toBe(4);
      await waited(120_000);
      expect(flavor.asked, "asked a fifth time").toBe(4);
      page.unmount();
    } finally {
      restore();
    }
  });

  it("a page that goes while it waits to ask again asks nothing more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { page } = await pageAsking([null, FETCHES_PICTURES]);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(flavor.asked, "the page's first ask").toBe(1);
      page.unmount();
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flavor.asked, "asked after the page went").toBe(1);
    } finally {
      restore();
    }
  });
});
