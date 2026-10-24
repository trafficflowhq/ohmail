/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, answerConsentWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { bootCacheKey } from "../app/shell/boot-cache";
import { CONSENT_BOOT_SCOPE } from "../app/shell/consent-state";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { MailboxFacts } from "../app/shell/mail-state";

// The first mount pays the shell's cold import.
vi.setConfig({ testTimeout: 30_000 });

/**
 * SETUP RESUMES, ONCE PER TAB. An account that never connected a mailbox came back to an empty mail
 * client. On the web doors the shell now sends it to the setup page (`/join`), once per tab, and only
 * on answers: both reads answered, nothing in the URL, no sign-in return, and not after the setup
 * page's own "Do this later" (`/?setup=later`).
 */

let resumes = 0;
const door = (over: Partial<FirstRunHost> = {}): FirstRunHost => ({
  door: "cloud",
  ai: "on",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb-new" }),
  organize: async () => "stored",
  complete: async () => {},
  probeReason: () => null,
  probeMessage: () => null,
  setupHref: "/join",
  resume: () => { resumes += 1; },
  oauthPending: () => false,
  ...over,
});

/** Mount, then let both reads land. */
async function shell(facts: MailboxFacts[], opts: Parameters<typeof mountShell>[1] = {}): Promise<HTMLElement> {
  const c = await mountShell(facts, { firstRun: door(), ...opts });
  await tick(100);
  return c;
}

/** Wrap the harness's fetch so one route answers differently. */
function answerRoute(part: string, res: () => Promise<Response>): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes(part) ? res() : inner(input as RequestInfo, init)) as typeof globalThis.fetch;
}

beforeEach(() => {
  installShellEnv();
  resumes = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.cookie = "tf_owner=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  window.history.replaceState(null, "", "/");
});
afterEach(async () => {
  await teardownShellEnv();
  window.history.replaceState(null, "", "/");
});

describe("an account with no mailbox and no finished setup", () => {
  it("is sent to the setup page from the default view", async () => {
    await shell([]);
    expect(resumes).toBe(1);
  });

  it("only once per tab: a second load in the same tab stays", async () => {
    await shell([]);
    await teardownShellEnv();
    installShellEnv();
    await shell([]);
    expect(resumes).toBe(1);
  });

  it("is not routed when the tab's mark cannot be written", async () => {
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (this === window.sessionStorage) throw new DOMException("refused", "SecurityError");
      real.call(this, k, v);
    });
    await shell([]);
    expect(resumes).toBe(0);
  });
});

describe("never on a missing answer", () => {
  it("a failed mailbox read is not an empty list", async () => {
    await shell([], { probe: async () => { throw Object.assign(new Error("db_busy"), { status: 503 }); } });
    expect(resumes).toBe(0);
  });

  it("a failed consent read is not an unfinished setup", async () => {
    answerRoute("/consent", async () => new Response("{}", { status: 503 }));
    await shell([]);
    expect(resumes).toBe(0);
  });

  it("the boot cache's consent is not the live answer", async () => {
    document.cookie = "tf_owner=acct_live_1";
    window.localStorage.setItem(
      bootCacheKey(CONSENT_BOOT_SCOPE, "acct_live_1"),
      JSON.stringify({ v: 1, seedConfirmedAt: ISO, dormancyDays: 60, screeningBaselineAt: null }),
    );
    answerRoute("/consent", () => new Promise<Response>(() => {}));
    await shell([]);
    expect(resumes).toBe(0);
  });
});

describe("stays where the account or the URL says so", () => {
  it("an account with a mailbox", async () => {
    await shell([mailbox()]);
    expect(resumes).toBe(0);
  });

  it("an account that finished or cancelled setup", async () => {
    answerConsentWith({ onboardingCompletedAt: ISO });
    await shell([]);
    expect(resumes).toBe(0);
  });

  it.each([
    ["/#/settings"], ["/#/screener"], ["/#/first-run"], ["/?settings=mailboxes"], ["/?oauth=error&reason=consent_declined"],
  ])("a deep link: %s", async (url) => {
    window.history.replaceState(null, "", url);
    await shell([]);
    expect(resumes).toBe(0);
  });

  it("a mailbox sign-in return in flight", async () => {
    await shell([], { firstRun: door({ oauthPending: () => true }) });
    expect(resumes).toBe(0);
  });

  it("a door with no setup page (the desktop window)", async () => {
    await shell([], { firstRun: door({ setupHref: undefined, resume: undefined, oauthPending: undefined }) });
    expect(resumes).toBe(0);
  });
});

describe("the setup page's \"Do this later\" (/?setup=later)", () => {
  it("does not bounce back, drops the parameter, and holds for the rest of the tab", async () => {
    window.history.replaceState(null, "", "/?setup=later");
    await shell([]);
    expect(resumes).toBe(0);
    expect(window.location.search).toBe("");
    await teardownShellEnv();
    installShellEnv();
    await shell([]);
    expect(resumes).toBe(0);
  });
});
