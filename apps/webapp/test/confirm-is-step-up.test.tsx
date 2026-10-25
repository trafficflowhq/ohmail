/** @vitest-environment jsdom */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ToastHost } from "@ohmail/ui";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import en from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";

/**
 * A CONFIRMATION IS A STEP-UP, NOT A SIGN-IN. Every "Confirm it is you" in Settings →
 * Mailboxes, the account erase and the desktop link ran `POST /auth/login` and a factor, so one
 * browser gathered a new web session per confirmation. Each pane now tries its write, parks it on
 * 403 `step_up_required`, runs `StepUpPrompt` (which re-stamps the session the browser holds) and
 * re-runs the write once with the same body. Driven through the real panes; the API doors are
 * stand-ins that record every call.
 */

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mb = en.mailboxes as unknown as Record<string, string>;
const sec = en.security as unknown as Record<string, string>;
const inv = en.invites as unknown as Record<string, string>;
const link = en.linkDesktop as unknown as Record<string, string>;
const dev = en.devices as unknown as Record<string, string>;
const acct = en.account as unknown as Record<string, string>;
const picker = en.providerPicker as unknown as Record<string, string>;

const EMAIL = "person@example.test";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** Every door call with its arguments; each door answers from its script, then `ok`. */
const rig = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
  script: {} as Record<string, string[]>,
  listed: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: { mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null } } as unknown as MailState,
    refresh: () => {},
  }),
}));

vi.mock("../app/hello", () => ({
  SELF_HOST_BUILD: false,
  serverHello: async () => ({ flavor: "managed", features: { pairing: true } }),
}));

vi.mock("../app/sign-out", () => ({
  forgetThisBrowser: async () => ({ remaining: [], inventoryComplete: true }),
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  const refusal = (a: string): Error | null =>
    a === "step_up" ? new actual.ApiError(403, "step_up_required", "recent two-factor authentication required")
      : a === "enrollment" ? new actual.ApiError(403, "enrollment_incomplete", "finish two-factor enrollment before using this endpoint")
        : a === "unauthorized" ? new actual.ApiError(401, "unauthorized", "authentication required")
          : null;
  const door = <T,>(name: string, ok: T) => async (...args: unknown[]): Promise<T> => {
    rig.calls.push({ name, args });
    const err = refusal(rig.script[name]?.shift() ?? "ok");
    if (err) throw err;
    return ok;
  };
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    assertPasskey: async () => ({ id: "credential" }),
    pendApiOwner: () => {},
    auth: {
      session: async () => ({
        user: {
          accountId: "acct-1", email: "person@example.test", emailVerified: true,
          twofaEnrolled: { webauthn: false, totp: true },
        },
        scope: "full",
      }),
      login: door("auth.login", { status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: door("auth.totpVerify", {}),
      stepUpTotp: door("auth.stepUpTotp", { ok: true }),
      stepUpWebauthnOptions: door("auth.stepUpWebauthnOptions", { options: {} }),
      stepUpWebauthnVerify: door("auth.stepUpWebauthnVerify", { ok: true }),
      desktopLink: door("auth.desktopLink", { code: "ABCD-EFGH", expiresIn: 300 }),
      recoveryCodes: door("auth.recoveryCodes", { codes: ["aaaa-bbbb"] }),
    },
    pair: {
      list: async () => ({ items: [] }),
      mint: door("pair.mint", { id: "p1", token: "tok", grant: "invite", label: "", expiresAt: "2026-10-04T09:00:00.000Z" }),
    },
    billing: { subscription: async () => ({ status: "active", plan: "pro", credits: 100 }) },
    account: {
      access: async () => ({ metered: false }),
      erase: door("account.erase", { erased: true, retained: "billing records only", subscription: "none" }),
    },
    mailboxes: {
      list: async () => ({ items: rig.listed }),
      create: door("mailboxes.create", {}),
      update: door("mailboxes.update", {}),
      remove: door("mailboxes.remove", undefined),
      erase: door("mailboxes.erase", { mailboxId: "mb1", erasing: false, messages: 0, drafts: 0, draftsUnanchored: 0 }),
      resync: async () => undefined,
      organizer: async () => ({ holders: [], unreadable: 0 }),
      organize: door("mailboxes.organize", { outcome: "authorized" }),
    },
  };
});

let roots: Root[] = [];

beforeEach(() => {
  rig.calls = [];
  rig.script = {};
  rig.listed = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); });
}

/** Up to `turns` yields of 15 ms, bounded by COUNT: a loop steered by the clock is a wall-clock site. */
async function waitFor(predicate: () => boolean, what: string, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`gave up after ${turns} turns waiting for: ${what}`);
}

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-09-27T09:00:00.000Z"),
      children: h(ToastHost, null, node),
    }));
  });
  await settle();
  return host;
}

/** One control, by the start of its label, refusing two candidates or none. */
function press(el: HTMLElement, label: string): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>("button, a")]
    .filter((n) => (n.textContent ?? "").trim().startsWith(label));
  expect(found, `exactly one control reading "${label}"`).toHaveLength(1);
  return found[0]!;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field the walk needs is not on screen").toBeTruthy();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  await act(async () => { el!.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}

async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

const prompt = (el: HTMLElement): Element | null => el.querySelector('[data-testid="step-up-prompt"]');
const called = (name: string) => rig.calls.filter((c) => c.name === name);

/** The prompt's code path, the one a fresh-code person takes. */
async function verifyCode(el: HTMLElement): Promise<void> {
  await waitFor(() => el.querySelector("#stepup-code") != null, "the prompt's code field");
  await typeInto(el.querySelector("#stepup-code"), "123456");
  await submit(el.querySelector("#stepup-code")!.closest("form"));
}

const row = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: EMAIL, displayName: null,
  status: "connected", lastSyncAt: "2026-09-26T11:00:00.000Z", createdAt: "2026-09-26T10:00:00.000Z",
  ...over,
} as MailboxDTO);

/** A row the lease stood down, whose one remedy is the take-over. */
const stoodDown = (): MailboxDTO => row({
  provider: "imap", status: "disabled", disabledReason: "organized_elsewhere:local",
  organizerRole: "reader", organizedBy: { kind: "local", name: "a laptop", since: "2026-09-25T08:00:00.000Z" },
  organizerState: "held", organizeConsentedAt: "2026-09-20T10:05:00.000Z", organizerReleasedAt: null,
} as Partial<MailboxDTO>);

interface Pane {
  name: string;
  verb: string;
  /** Mount the pane and press the write. */
  walk: () => Promise<HTMLElement>;
  /** The sentence the pane says when signing in is the remedy. */
  signIn: string;
}

async function mailboxes(listed: MailboxDTO[]): Promise<HTMLElement> {
  rig.listed = listed;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  const el = await render(h(MailboxSection));
  await waitFor(() => (el.textContent ?? "").length > 0, "the pane");
  return el;
}

const PANES: Pane[] = [
  {
    name: "MailboxSection: connect", verb: "mailboxes.create", signIn: dev.stepUpExpired!,
    walk: async () => {
      const el = await mailboxes([]);
      await waitFor(() => [...el.querySelectorAll("button")].some((b) => b.textContent?.trim().startsWith(mb.connect!)), "Connect");
      await click(press(el, mb.connect!));
      await click(press(el, picker.otherLabel!));
      await typeInto(el.querySelector("#mb-address"), EMAIL);
      await typeInto(el.querySelector("#mb-imap"), "mail.example.test");
      await typeInto(el.querySelector("#mb-smtp"), "smtp.example.test");
      await typeInto(el.querySelector("#mb-pass"), "app-password-fixture");
      await submit(el.querySelector("#mb-address")!.closest("form"));
      return el;
    },
  },
  {
    name: "MailboxSection: edit", verb: "mailboxes.update", signIn: dev.stepUpExpired!,
    walk: async () => {
      const el = await mailboxes([row()]);
      await waitFor(() => [...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === mb.edit), "Edit");
      await click(press(el, mb.edit!));
      await typeInto(el.querySelector("#mb-edit-pass"), "new-app-password-fixture");
      await submit(el.querySelector("#mb-edit-pass")!.closest("form"));
      return el;
    },
  },
  {
    name: "MailboxSection: remove", verb: "mailboxes.remove", signIn: dev.stepUpExpired!,
    walk: async () => {
      const el = await mailboxes([row()]);
      await waitFor(() => [...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === mb.remove), "Remove");
      await click(press(el, mb.remove!));
      await click(press(el, mb.removeConfirm!));
      return el;
    },
  },
  {
    name: "MailboxSection: remove and erase", verb: "mailboxes.erase", signIn: dev.stepUpExpired!,
    walk: async () => {
      const el = await mailboxes([row()]);
      await waitFor(() => [...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === mb.remove), "Remove");
      await click(press(el, mb.remove!));
      await click(el.querySelector("#mb-remove-erase")!);
      await typeInto(el.querySelector("#mb-erase-confirm"), EMAIL);
      await click(press(el, mb.removeEraseConfirm!));
      return el;
    },
  },
  {
    name: "MailboxSection: take over", verb: "mailboxes.organize", signIn: dev.stepUpExpired!,
    walk: async () => {
      const el = await mailboxes([stoodDown()]);
      await waitFor(() => [...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === mb.organizerCheck), "the check");
      await click(press(el, mb.organizerCheck!));
      await waitFor(() => [...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === mb.organizerConfirm), "the confirm");
      await click(press(el, mb.organizerConfirm!));
      return el;
    },
  },
  {
    name: "AccountSection: erase", verb: "account.erase", signIn: dev.stepUpExpired!,
    walk: async () => {
      const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
      const el = await render(h(AccountSection));
      await waitFor(() => el.querySelector("#acct-typed") != null, "the facts step");
      await typeInto(el.querySelector("#acct-typed"), EMAIL);
      await submit(el.querySelector("form.acct-confirm"));
      return el;
    },
  },
  {
    name: "SecuritySection: recovery codes", verb: "auth.recoveryCodes", signIn: sec.stepUpExpired!,
    walk: async () => {
      const { SecuritySection } = await import("../app/(product)/mailbox/SecuritySection.js");
      const el = await render(h(SecuritySection));
      await waitFor(() => (el.textContent ?? "").includes(sec.codesGenerate!), "the codes row");
      await click(press(el, sec.codesGenerate!));
      await click(press(el, sec.codesConfirm!));
      return el;
    },
  },
  {
    name: "InvitesSection: mint", verb: "pair.mint", signIn: inv.stepUpExpired!,
    walk: async () => {
      const { InvitesSection } = await import("../app/(product)/mailbox/InvitesSection.js");
      const el = await render(h(InvitesSection));
      await click(press(el, inv.mintAction!));
      return el;
    },
  },
  {
    name: "LinkDesktopScreen: mint", verb: "auth.desktopLink", signIn: link.signInFirst!,
    walk: async () => {
      const { LinkDesktopScreen } = await import("../app/(product)/link-desktop/LinkDesktopScreen.js");
      const el = await render(h(LinkDesktopScreen, { challenge: CHALLENGE }));
      await click(press(el, link.mint!));
      return el;
    },
  },
];

describe("each confirm is a step-up on the session this browser holds", () => {
  for (const pane of PANES) {
    describe(pane.name, () => {
      it("a closed window parks the write; the verified factor re-runs it once with the SAME body; no sign-in", async () => {
        rig.script[pane.verb] = ["step_up"];
        const el = await pane.walk();
        await waitFor(() => prompt(el) != null, "the step-up prompt");
        expect(called(pane.verb), "the write was tried before any factor was asked for").toHaveLength(1);

        await verifyCode(el);
        await waitFor(() => called(pane.verb).length === 2, "the parked write to run again");

        const [first, again] = called(pane.verb);
        expect(again!.args, "the re-run sent a different body").toEqual(first!.args);
        expect(called("auth.stepUpTotp"), "one factor, verified once").toHaveLength(1);
        expect(called("auth.login"), "a confirmation signed in again — one more web session").toHaveLength(0);
        expect(called("auth.totpVerify"), "the sign-in's own factor route was used").toHaveLength(0);
        expect(prompt(el), "the prompt stayed up after the write ran").toBeNull();
      }, 20000);

      it("a fresh window writes on the first press and never shows the prompt", async () => {
        const el = await pane.walk();
        await waitFor(() => called(pane.verb).length === 1, "the write");
        await settle();
        expect(prompt(el), "a fresh session was asked for a factor").toBeNull();
        expect(called(pane.verb)).toHaveLength(1);
        expect(called("auth.stepUpTotp")).toHaveLength(0);
        expect(called("auth.login")).toHaveLength(0);
      }, 20000);

      it("CONTROL: 403 enrollment_incomplete says sign in, and opens no prompt", async () => {
        rig.script[pane.verb] = ["enrollment"];
        const el = await pane.walk();
        await waitFor(() => (el.textContent ?? "").includes(pane.signIn), "the sign-in sentence");
        expect(prompt(el), "a factor was asked of a session that cannot pass step-up").toBeNull();
        expect(called("auth.login")).toHaveLength(0);
      }, 20000);

      it("CONTROL: a second step_up_required after a verified factor is a sentence, never a second prompt", async () => {
        rig.script[pane.verb] = ["step_up", "step_up"];
        const el = await pane.walk();
        await waitFor(() => prompt(el) != null, "the step-up prompt");
        await verifyCode(el);
        await waitFor(() => called(pane.verb).length === 2, "the re-run");
        await waitFor(() => (el.textContent ?? "").includes(pane.signIn), "the sentence");
        expect(prompt(el), "the pane looped into a second prompt").toBeNull();
        expect(called(pane.verb), "the write ran a third time").toHaveLength(2);
        expect(called("auth.stepUpTotp")).toHaveLength(1);
      }, 20000);
    });
  }

  it("the desktop link's retry carries the app's commitment", async () => {
    rig.script["auth.desktopLink"] = ["step_up"];
    const el = await PANES.find((p) => p.verb === "auth.desktopLink")!.walk();
    await waitFor(() => prompt(el) != null, "the step-up prompt");
    await verifyCode(el);
    await waitFor(() => called("auth.desktopLink").length === 2, "the retried mint");
    expect(called("auth.desktopLink").map((c) => c.args[0])).toEqual([{ challenge: CHALLENGE }, { challenge: CHALLENGE }]);
    await waitFor(() => (el.textContent ?? "").includes("ABCD-EFGH"), "the code");
  }, 20000);

  it("a dead session (401) on the desktop link says sign in, with the door to it", async () => {
    rig.script["auth.desktopLink"] = ["unauthorized"];
    const el = await PANES.find((p) => p.verb === "auth.desktopLink")!.walk();
    await waitFor(() => (el.textContent ?? "").includes(link.signInFirst!), "the sign-in sentence");
    const door = [...el.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login");
    expect(door, "no way to the sign-in").toBeTruthy();
    expect(el.querySelector("#link-pw"), "the page asked for a password itself").toBeNull();
    expect(prompt(el)).toBeNull();
  }, 20000);

  it("the erase's submit refuses a mistyped address itself: no DELETE leaves", async () => {
    const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
    const el = await render(h(AccountSection));
    await waitFor(() => el.querySelector("#acct-typed") != null, "the facts step");
    await typeInto(el.querySelector("#acct-typed"), "someone-else@example.test");
    await submit(el.querySelector("form.acct-confirm"));
    expect(called("account.erase"), "a submit past the disabled button erased the account").toHaveLength(0);
    await typeInto(el.querySelector("#acct-typed"), EMAIL);
    await submit(el.querySelector("form.acct-confirm"));
    await waitFor(() => called("account.erase").length === 1, "CONTROL: the typed address erases");
  }, 20000);

  it("the erase names what the factor does, and the typed address is kept across Cancel", async () => {
    rig.script["account.erase"] = ["step_up"];
    const el = await PANES.find((p) => p.verb === "account.erase")!.walk();
    await waitFor(() => prompt(el) != null, "the step-up prompt");
    expect(el.textContent).toContain(acct.factorBody!.replace("{email}", EMAIL));
    await click(press(el, dev.cancel!));
    expect(el.querySelector<HTMLInputElement>("#acct-typed")?.value, "Cancel threw the typed address away").toBe(EMAIL);
    expect(called("account.erase")).toHaveLength(1);
  }, 20000);
});

describe("the refusal a gated write gets decides the pane's next step", () => {
  it("factor on the first step_up_required, sign-in after a verified one, on 401 and on an unfinished enrolment", async () => {
    const { gatedRefusal } = await import("../app/(product)/mailbox/gated-refusal.js");
    const { ApiError } = await import("../app/api-client.js");
    const stepUp = new ApiError(403, "step_up_required", "x");
    expect(gatedRefusal(stepUp, false)).toBe("factor");
    expect(gatedRefusal(stepUp, true)).toBe("sign-in");
    expect(gatedRefusal(new ApiError(401, "unauthorized", "x"), false)).toBe("sign-in");
    expect(gatedRefusal(new ApiError(403, "enrollment_incomplete", "x"), false)).toBe("sign-in");
    // CONTROLS: every other refusal is the verb's own.
    expect(gatedRefusal(new ApiError(403, "email_unverified", "x"), false)).toBe("other");
    expect(gatedRefusal(new ApiError(403, "csrf_failed", "x"), false)).toBe("other");
    expect(gatedRefusal(new ApiError(409, "mailbox_exists", "x"), false)).toBe("other");
    expect(gatedRefusal(new TypeError("network down"), false)).toBe("other");
  });
});

// ── The census: nothing in the product signs in but the sign-in ─────────────────────────────

const PRODUCT = `${process.cwd()}/apps/webapp/app/(product)`;
const LOGIN_CALL = /\bauth\s*\.\s*login\s*\(/g;

/** `auth.login(` CALLS in code, comments and string literals blanked first. */
function loginCalls(src: string): number {
  return [...withoutCommentsAndLiterals(src).matchAll(LOGIN_CALL)].length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = `${dir}/${name}`;
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

describe("the census of sign-ins under (product)", () => {
  it("counts a call and nothing that merely names one", () => {
    expect(loginCalls("const out = await auth.login({ email, password });"), "the call").toBe(1);
    expect(loginCalls("await auth . login ({ email, password });"), "spaced").toBe(1);
    expect(loginCalls("// then auth.login({ email }) signs in"), "a comment").toBe(0);
    expect(loginCalls('const s = "auth.login(";'), "a string").toBe(0);
    expect(loginCalls("auth.loginAs(x); auth.logout();"), "another method").toBe(0);
  });

  it("admits auth.login( in login/LoginScreen.tsx and nowhere else", () => {
    const files = walk(PRODUCT);
    expect(files.length, `the census read nothing under ${PRODUCT} (run vitest from the repo root)`).toBeGreaterThan(20);
    const hits = files
      .map((abs) => ({ file: abs.slice(PRODUCT.length + 1), n: loginCalls(readFileSync(abs, "utf8")) }))
      .filter((f) => f.n > 0)
      .map((f) => f.file);
    expect(hits, "a confirmation that signs in mints a web session per press").toEqual(["login/LoginScreen.tsx"]);
  });
});
