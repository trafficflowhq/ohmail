/** @vitest-environment jsdom */
/**
 * ONE LIVE WIZARD PER BROWSER. The page that confirms an address opened /join whatever else was open,
 * so the tab still on "Check your email" and the confirming tab could both walk the setup, and each
 * recovery-code set one of them made cancelled the other's. The confirming page now offers the setup
 * to a waiting tab: the waiting tab claims it, the page grants one claim inside its window or opens
 * /join itself, never both, and a factor or a code set made in one tab ends that step in the other.
 * Two tabs here are two React roots over one server and the real BroadcastChannel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base32Seed } from "../../../test/support/fixture-credentials.js";
import en from "../messages/en.json";

/** The authenticator seed the setup step answers with, assembled at run time. */
const SEED = base32Seed("join-one-live-wizard");

const nav = vi.hoisted(() => ({ pushes: [] as string[] }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => { nav.pushes.push(to); }, replace: () => {} }),
}));
// Real time passes between two tabs here; a loaded host stretches it.
vi.setConfig({ testTimeout: 30_000 });

const CHANNEL = "ohmail.join.handoff";
const NEVER_STARTED = {
  state: "closed", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
  erasureAt: null, erasedAt: null, formerlyPaid: false, lifecycleEpoch: "2026-09-22T00:00:00.000Z",
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string): Response => json({ error: { code, message: code } }, status);

/** The one server both tabs talk to, and the browser's one cookie jar. */
let jar: "none" | "enrollment" | "full";
let codeSets = 0;
let sessionFault: (() => Response) | null = null;
/* The server's answer to a jar with no refresh cookie, which is every jar here: an empty one, or an enrollment
   session's. The waiting tab's first read meets it, and the tab holds that session as ended from then on. */
const noRefreshCookie = (): Response => refusal(401, "refresh_missing");
let refreshAnswer: () => Response = noRefreshCookie;
let verifyAnswer: () => Response;
let calls: string[] = [];
let unmounts: Array<() => Promise<void>> = [];
let originalFetch: typeof globalThis.fetch;
let act: (cb: () => Promise<void> | void) => Promise<void>;

const user = () => ({
  userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
  twofaEnrolled: { webauthn: false, totp: jar === "full", recoveryCodes: codeSets > 0 },
});

function serve(path: string): Response {
  if (path === "/auth/session") {
    if (sessionFault) return sessionFault();
    return jar === "none" ? refusal(401, "unauthorized") : json({ user: user(), scope: jar });
  }
  if (path === "/auth/refresh") return refreshAnswer();
  if (path === "/auth/register") return json({ status: "ok" }, 202);
  if (path === "/auth/verify-email") return verifyAnswer();
  if (path === "/auth/2fa/totp/enroll") {
    return json({ secret: SEED, otpauthUrl: `otpauth://totp/ohmail:fixture?secret=${SEED}&issuer=ohmail` });
  }
  if (path === "/auth/2fa/totp/activate") { jar = "full"; return json({ twofaEnrolled: user().twofaEnrolled }); }
  if (path === "/auth/2fa/recovery-codes") { codeSets += 1; return json({ codes: [`set${codeSets}-aaaa`, `set${codeSets}-bbbb`] }); }
  if (path === "/account/access") {
    return json({ metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, lifecycle: NEVER_STARTED });
  }
  if (path === "/account/manage-link") return json({ url: "https://plane.example/manage?token=t" });
  if (path.startsWith("/mailboxes")) return json({ items: [] });
  return json({});
}

const enrolled = (): Response => {
  jar = "enrollment";
  return json({ status: "enrollment", user: user(), next: "enroll_2fa", enrollmentToken: "x", expiresIn: 300 });
};

beforeEach(async () => {
  vi.resetModules();
  jar = "none"; codeSets = 0; sessionFault = null; calls = []; unmounts = []; nav.pushes.length = 0;
  refreshAnswer = noRefreshCookie;
  verifyAnswer = enrolled;
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  window.history.replaceState(null, "", "/join");
  localStorage.clear();
  sessionStorage.clear();
  for (const name of document.cookie.split(";").map((c) => c.split("=")[0]!.trim()).filter(Boolean)) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const path = new URL(String(input), "http://x").pathname.replace(/^\/api/, "");
    calls.push(path);
    return serve(path);
  }) as unknown as typeof globalThis.fetch;
  const React = await import("react");
  act = (React as unknown as { act: typeof act }).act;
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const u of unmounts) await u();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const tick = (ms = 10) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** Real time passes, the tabs answer; true once `cond` holds, false after `ms`. */
async function until(cond: () => boolean, ms = 6_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(20);
  return cond();
}

/** One tab: /join (public signup) or the confirming page, mounted in its own root. */
async function tab(which: "join" | "verify") {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const screen = which === "join"
    ? React.createElement((await import("../app/(product)/join/JoinScreen.js")).JoinScreen, { initialCode: "", publicSignup: true })
    : React.createElement((await import("../app/(product)/verify-email/VerifyEmailScreen.js")).VerifyEmailScreen, { initialToken: "tok" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: screen }));
  });
  for (let i = 0; i < 10; i += 1) await tick(0);
  unmounts.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const type = async (id: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`);
    expect(input, `#${id} is not on screen`).toBeTruthy();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const press = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    for (let i = 0; i < 10; i += 1) await tick(0);
  };
  const title = () => host.querySelector("h1")?.textContent ?? null;
  return { host, type, press, title };
}

/** A /join tab taken to "Check your email". */
async function waiting() {
  const a = await tab("join");
  await a.type("join-email", "pat@family.example");
  await a.type("join-name", "Pat");
  await a.type("join-pw", "a-long-signup-password");
  await a.press(en.join.createAccount);
  expect(a.title()).toBe(en.join.step_sent_title);
  return a;
}

/** The confirming page, its password typed and confirmed. */
async function confirm() {
  const v = await tab("verify");
  await v.type("verify-pw", "a-long-signup-password");
  await v.press(en.verify.confirm);
  return v;
}

/** Everything said on the channel while `fn` runs, as a third party in the same origin hears it. */
async function overheard(fn: () => Promise<void>): Promise<unknown[]> {
  const heard: unknown[] = [];
  const ear = new BroadcastChannel(CHANNEL);
  ear.onmessage = (e: MessageEvent) => { heard.push(e.data); };
  try {
    await fn();
    await tick(50);
  } finally {
    ear.close();
  }
  return heard;
}

describe("the confirming page hands the setup over, or continues it, never both", () => {
  it("a tab waiting on Check your email takes the setup over; the confirming page opens no /join and offers nothing", async () => {
    const a = await waiting();
    const v = await confirm();
    await until(() => a.title() !== en.join.step_sent_title);
    expect(a.title(), "the waiting tab did not carry on into the setup").toBe(en.join.step_factor_title);
    await tick(1_200);
    expect(nav.pushes, "the confirming page opened a second wizard").toEqual([]);
    expect(v.title()).toBe(en.verify.doneTitle);
    expect(v.host.textContent).toContain(en.verify.handedOff);
    expect(v.host.querySelectorAll("a, button, input"), "the page that handed off offers a control").toHaveLength(0);
  });

  it("without a grant, a tab that holds its session as ended asks nothing: the next /join it opens stays quiet", async () => {
    await tab("join");
    const opened = calls.length;
    // The two roots share their modules here, so this is the next page of the same tab.
    await tab("join");
    expect(calls.slice(opened)).toEqual([]);
  });

  it("with no tab waiting, the confirming page opens /join itself once its window has passed", async () => {
    const v = await confirm();
    const asked = Date.now();
    expect(nav.pushes, "/join opened before any waiting tab could answer").toEqual([]);
    expect(await until(() => nav.pushes.length > 0)).toBe(true);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(900);
    expect(nav.pushes).toEqual(["/join"]);
    expect(v.host.textContent).not.toContain(en.verify.handedOff);
  });

  it("a claim that arrives after the window gets no grant: /join opens there and the waiting tab stays put", async () => {
    const Real = globalThis.BroadcastChannel;
    const claims: unknown[] = [];
    /* The waiting tab is throttled: what it hears arrives 1.5 s late, so its claim comes after the window. */
    class Throttled {
      private real: BroadcastChannel;
      private closed = false;
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(name: string) {
        this.real = new Real(name);
        this.real.onmessage = (e) => { setTimeout(() => { if (!this.closed) this.onmessage?.(e); }, 1_500); };
      }
      postMessage(m: unknown) { if (!this.closed) { claims.push(m); this.real.postMessage(m); } }
      close() { this.closed = true; this.real.close(); }
    }
    globalThis.BroadcastChannel = Throttled as unknown as typeof BroadcastChannel;
    let a: Awaited<ReturnType<typeof waiting>>;
    try {
      a = await waiting();
    } finally {
      globalThis.BroadcastChannel = Real;
    }
    const said = await overheard(async () => {
      await confirm();
      expect(await until(() => nav.pushes.length > 0)).toBe(true);
      expect(await until(() => claims.length > 0), "the waiting tab never claimed, so this proves nothing").toBe(true);
      // Long enough for a grant to the late claim to reach the throttled tab.
      await tick(2_500);
    });
    expect(said.filter((m) => (m as { kind?: string }).kind === "granted"), "a claim after the window was granted").toEqual([]);
    expect(nav.pushes).toEqual(["/join"]);
    expect(a.title(), "a late answer made a second live wizard").toBe(en.join.step_sent_title);
  });

  it("with two tabs waiting, exactly one of them moves on", async () => {
    const first = await waiting();
    const second = await waiting();
    await confirm();
    const moved = () => [first, second].filter((t) => t.title() === en.join.step_factor_title).length;
    expect(await until(() => moved() > 0)).toBe(true);
    await tick(1_200);
    expect(moved()).toBe(1);
    expect([first, second].filter((t) => t.title() === en.join.step_sent_title)).toHaveLength(1);
    expect(nav.pushes).toEqual([]);
  });
});

describe("a browser whose channel is missing or refuses continues as before", () => {
  const Real = globalThis.BroadcastChannel;
  afterEach(() => { globalThis.BroadcastChannel = Real; });
  class Refusing {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage(): void { throw new DOMException("refused", "DataCloneError"); }
    close(): void {}
  }
  const shapes: Array<[string, unknown]> = [
    ["no BroadcastChannel", undefined],
    ["a constructor that throws", function Throwing() { throw new Error("blocked"); }],
    ["a channel that refuses to post", Refusing],
  ];
  for (const [what, Channel] of shapes) {
    it(`${what}: the confirming page opens /join itself and says nothing went wrong`, async () => {
      (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = Channel;
      const v = await confirm();
      expect(await until(() => nav.pushes.length > 0)).toBe(true);
      expect(nav.pushes).toEqual(["/join"]);
      expect(v.host.querySelector(".join-error")).toBeNull();
    });
  }
});

describe("only an account sent on to its setup is offered", () => {
  it("a wrong password, a dead link and an account that already has a factor say nothing on the channel", async () => {
    const quiet = await overheard(async () => {
      verifyAnswer = () => refusal(401, "credential_refused");
      const wrong = await confirm();
      expect(wrong.host.textContent).toContain(en.verify.refusedPassword);
      verifyAnswer = () => refusal(400, "invalid_token");
      const dead = await confirm();
      expect(dead.host.textContent).toContain(en.verify.refusedLink);
      verifyAnswer = () => json({ status: "verified" });
      const factor = await confirm();
      expect(factor.title()).toBe(en.verify.doneTitle);
      expect(factor.host.textContent).toContain(en.verify.doneBody);
      await tick(1_200);
    });
    expect(quiet).toEqual([]);
    expect(nav.pushes).toEqual([]);
    // The control: the same ear hears an offer, and the offer carries no account fact.
    verifyAnswer = enrolled;
    const offer = await overheard(async () => {
      await confirm();
      await until(() => nav.pushes.length > 0);
    });
    expect(offer).toHaveLength(1);
    expect(Object.keys(offer[0] as object).sort()).toEqual(["kind", "nonce", "v"]);
    // The nonce is hex; the account's address cannot hide in it.
    expect(JSON.stringify(offer)).not.toMatch(/pat|family/i);
  });

  it("opening the confirming page asks nothing and says nothing until the password is confirmed", async () => {
    const heard = await overheard(async () => { await tab("verify"); await tick(200); });
    expect(calls.filter((p) => p === "/auth/verify-email")).toEqual([]);
    expect(heard).toEqual([]);
  });
});

describe("the tab that took the setup over says when it cannot read it", () => {
  it("a fault on its read is the can't-reach screen, and Try again carries on", async () => {
    const a = await waiting();
    sessionFault = () => refusal(503, "unavailable");
    await confirm();
    expect(await until(() => a.title() === en.onboarding.resumeUnreachableTitle), "the fault was swallowed").toBe(true);
    sessionFault = null;
    await a.press(en.onboarding.resumeRetry);
    expect(await until(() => a.title() === en.join.step_factor_title)).toBe(true);
  });

  it("a session gone by then is the expired screen, with sign-in carrying on into the setup", async () => {
    const a = await waiting();
    sessionFault = () => refusal(401, "unauthorized");
    refreshAnswer = () => refusal(401, "unauthorized");
    await confirm();
    expect(await until(() => a.title() === en.join.expiredTitle), "the expiry was swallowed").toBe(true);
    expect(a.host.textContent).toContain(en.join.expiredOpen);
    expect([...a.host.querySelectorAll("a")].find((l) => l.textContent === en.join.signIn)?.getAttribute("href"))
      .toBe("/login?next=join");
  });
});

describe("one set of recovery codes across the tab that took over and a second /join", () => {
  it("a factor added in the second tab ends the factor step in the first: its press re-reads, and no second set is made", async () => {
    const a = await waiting();
    await confirm();
    expect(await until(() => a.title() === en.join.step_factor_title)).toBe(true);
    // A second /join, opened by hand: it adds the authenticator and saves its codes.
    const b = await tab("join");
    expect(b.title()).toBe(en.join.step_factor_title);
    await b.press(en.join.useTotp);
    await b.type("join-totp", "123456");
    await b.press(en.join.activate);
    expect(await until(() => b.host.querySelectorAll(".join-codes li").length > 0)).toBe(true);
    expect(codeSets).toBe(1);
    const enrolments = calls.filter((p) => p === "/auth/2fa/totp/enroll").length;
    // Back in the first tab, the factor step is still on screen; the person does what it asks.
    await a.press(en.join.useTotp);
    if (a.host.querySelector("#join-totp")) {
      await a.type("join-totp", "654321");
      await a.press(en.join.activate);
    }
    await until(() => a.title() !== en.join.step_factor_title, 2_000);
    expect(calls.filter((p) => p === "/auth/2fa/totp/enroll").length, "a second factor was started").toBe(enrolments);
    expect(codeSets, "the codes the second tab showed were cancelled").toBe(1);
    expect(a.title()).toBe(en.join.step_plan_title);
  });
});
