/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";

/**
 * LEAVING ENDS THE FACTOR CHECK, AS CANCEL DOES. The wall's Back and a pane switch in Settings take
 * the pane away while the step-up answer is still on the wire. That answer used to run the parked
 * verb anyway: the account was erased after the person had backed out, and the wall still said
 * nothing was deleted. Each arm holds the answer, leaves, lets it land and counts what went out;
 * the controls let it land with the pane still open, and the verb runs once. The real api-client
 * runs; only `fetch` is answered here.
 *
 * RE-POINTED (the switch's older tests, sorted once): the Settings arm stands on the new shell. The password change is
 * the new Settings' Account section (`packages/app/src/account/account`) over the web's own doors (`WEB_PANE_PARTS`),
 * mounted through the new shell's test door (`_mail-shell.tsx`'s `MailShell`), its factor the web's dialog
 * (`StepUp`); the switch is a press on another entry of the Settings menu. The erase is no section of the new Settings:
 * it is the web's own page (`/account/delete`, `DeleteAccountRoute`), and leaving it is the page going away under the
 * dialog, as a browser's Back or another place takes it. Every expectation is as it stood; the wall's arm and the
 * prompt's stand as they were.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rig = vi.hoisted(() => ({ wipes: 0 }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

/* The local wipe the erase runs after its 200: counted, never run against this page. */
vi.mock("../app/sign-out", async (original) => ({
  ...await original<typeof import("../app/sign-out")>(),
  forgetThisBrowser: async () => {
    rig.wipes += 1;
    return { remaining: [], inventoryComplete: true };
  },
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));

const EMAIL = "person@example.test";
const ERASE = "DELETE /api/account";
const CHANGE = "POST /api/auth/password";
const STEP_UP_REQUIRED = { error: { code: "step_up_required", message: "recent two-factor authentication required" } };

/** The account the page's session is (the erase page settles whose browser this is from the header and the cookie). */
const OWNER = "7a0c3f9e-5d61-4f7a-9d2e-2b1f8c4e6a10";
/** The erase page's own inputs: its answers name the account, as a live server's do. */
let owned = false;
/** Whose session this is: on the new shell's Settings and the erase page, the account identifier in the browser's cookie (the web's
 *  doors refuse a window whose account the browser does not hold); the wall and the prompt keep their own. */
let sessionAccount = "acct-under-test";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(owned ? { "X-Ohmail-Account": OWNER } : {}) },
  });

/** Every request that left, as `METHOD /path`. */
let wire: string[] = [];
/** Lets the held step-up answer land. */
let release: (() => void) | null = null;
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const sent = (line: string): number => wire.filter((l) => l === line).length;

beforeEach(() => {
  wire = [];
  release = null;
  rig.wipes = 0;
  owned = false;
  sessionAccount = "acct-under-test";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input), "http://localhost").pathname}`;
    wire.push(line);
    if (line === "GET /api/auth/session") {
      return json(200, {
        user: { id: "u1", accountId: sessionAccount, email: EMAIL, twofaEnrolled: { webauthn: false, totp: true } },
        scope: "full",
      });
    }
    // The first try of each verb meets a closed window; the one the factor sends goes through.
    if (line === ERASE) {
      return sent(ERASE) === 1
        ? json(403, STEP_UP_REQUIRED)
        : json(200, { erased: true, retained: "one billing row", subscription: "none" });
    }
    if (line === CHANGE) return sent(CHANGE) === 1 ? json(403, STEP_UP_REQUIRED) : json(200, { revoked: 1 });
    if (line === "POST /api/auth/step-up/totp") {
      await new Promise<void>((r) => {
        release = r;
      });
      return json(200, { ok: true });
    }
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  // A control that erased latched this tab on the erased account; the next arm starts unlatched.
  (await import("@ohmail/app-logic/session/account-erased")).clearAccountErased();
  vi.restoreAllMocks();
});

async function mountNode(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
  });
  return host;
}

async function mountWall(): Promise<HTMLElement> {
  const { WallRoute } = await import("../app/(product)/mailbox/WallRoute.js");
  return mountNode(h(WallRoute, { facts: { reason: "payment_required" as const } }));
}

/** Settings → Account on the new shell, with the web's own doors of the section: the password change. */
async function mountSettings(): Promise<HTMLElement> {
  owned = true;
  sessionAccount = OWNER;
  document.cookie = `tf_owner=${OWNER}; Path=/`;
  document.cookie = "tf_csrf=csrf-under-test; Path=/";
  const client = await import("../app/api-client.js");
  client.setAccountHeaderCapability(true);
  client.bindApiOwner(OWNER);
  window.history.replaceState(null, "", "/#/settings/account");
  const { MailShell } = await import("./_mail-shell.js");
  const { engineOver, storeWith } = await import("./_view-shell.js");
  const { WEB_PANE_PARTS } = await import("../app/(product)/mailbox/pane-parts.js");
  const { NONE } = await import("@ohmail/app/host");
  const doors = WEB_PANE_PARTS.account;
  if (doors === NONE) throw new Error("the web hands no doors of the Account section");
  const engine = engineOver(await storeWith([]));
  return mountNode(h(MailShell, {
    demo: false,
    engine,
    accountDoors: doors,
    scope: OWNER,
    support: { surface: "web", version: null, commit: null, accountId: OWNER },
  }));
}

/** The web's page that erases the account, at its own address, as a session that may erase it opens it. */
async function mountErasePage(): Promise<{ c: HTMLElement; leave: () => Promise<void> }> {
  owned = true;
  sessionAccount = OWNER;
  document.cookie = `tf_owner=${OWNER}; Path=/`;
  document.cookie = "tf_csrf=csrf-under-test; Path=/";
  (await import("../app/api-client.js")).setAccountHeaderCapability(true);
  const { DeleteAccountRoute } = await import("../app/(product)/account/delete/DeleteAccountRoute.js");
  let gone: () => void = () => {};
  function Page(): React.ReactElement | null {
    const [shown, setShown] = React.useState(true);
    gone = () => setShown(false);
    return shown ? h(DeleteAccountRoute) : null;
  }
  const c = await mountNode(h(Page));
  return { c, leave: async () => { await act(async () => { gone(); }); } };
}

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function submit(form: Element): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const button = (c: ParentNode, label: string): HTMLButtonElement => {
  const found = [...c.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === label);
  expect(found, `exactly one button reading "${label}"`).toHaveLength(1);
  return found[0]!;
};

async function changeToThePrompt(c: HTMLElement): Promise<void> {
  await waitFor(() => c.querySelector("#pwc-current") != null, "the password form");
  await type(c.querySelector<HTMLInputElement>("#pwc-current")!, "old-correct-horse-password");
  await type(c.querySelector<HTMLInputElement>("#pwc-next")!, "new-battery-staple-password");
  await type(c.querySelector<HTMLInputElement>("#pwc-repeat")!, "new-battery-staple-password");
  await submit(c.querySelector("#pwc-current")!.closest("form")!);
}

/** The factor's dialog: the web's `StepUp` over the door's dialog. */
const dialog = (c: ParentNode): Element | null => c.querySelector('[role="dialog"]');

/** Types the code into the factor's dialog and presses Verify; the answer stays on the wire until `land`. */
async function verifyHeldInDialog(c: HTMLElement): Promise<void> {
  const codeField = '[role="dialog"] input[autocomplete="one-time-code"]';
  await waitFor(() => c.querySelector(codeField) != null, "the factor's dialog");
  const code = c.querySelector<HTMLInputElement>(codeField)!;
  await type(code, "123456");
  await submit(code.closest("form")!);
  await waitFor(() => release !== null, "the step-up answer held on the wire");
}

/** Types the address back on the erase page and presses Delete: the closed window opens the factor's dialog. */
async function eraseOnThePageToTheDialog(c: HTMLElement): Promise<void> {
  const blank = (): HTMLInputElement | null =>
    [...c.querySelectorAll<HTMLInputElement>("input")].find((i) => i.closest('[role="dialog"]') === null) ?? null;
  await waitFor(() => blank() !== null, "the erase page's form");
  await type(blank()!, EMAIL);
  const begin = [...c.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    [...b.childNodes].filter((n) => n.nodeName !== "KBD").map((n) => n.textContent ?? "").join("").trim() === en.deleteAccount.begin);
  await click(begin!);
}

/** The held answer lands, and whatever it runs gets a few turns to run. */
async function land(): Promise<void> {
  await act(async () => {
    release!();
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function erasedOwner(): Promise<string | null> {
  return (await import("@ohmail/app-logic/session/account-erased")).accountErasedOwner();
}

describe("the wall's Back while the factor is checked", () => {
  it("the password change: not sent again after Back", async () => {
    const c = await mountWall();
    await click(button(c, en.accessLock.changePassword));
    await changeToThePrompt(c);
    await verifyHeldInDialog(c);
    expect(sent(CHANGE)).toBe(1);

    expect(button(c, en.accessLock.back).closest("[inert]")).not.toBeNull();
    await act(async () => {
      dialog(c)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog(c), "Escape took the prompt away").toBeNull();
    await land();

    expect(sent(CHANGE), "POST /auth/password went out after Escape").toBe(1);
    await waitFor(() => c.textContent!.includes(en.passwordChange.cancelled), "the discarded factor");
    await click(button(c, en.accessLock.back));
    button(c, en.accessLock.changePassword);
  });

  it("CONTROL: the answer lands with the pane open, and the change is sent once more", async () => {
    const c = await mountWall();
    await click(button(c, en.accessLock.changePassword));
    await changeToThePrompt(c);
    await verifyHeldInDialog(c);
    await land();

    await waitFor(() => c.textContent!.includes("1 other session was signed out"), "the change's receipt");
    expect(sent(CHANGE)).toBe(2);
  });
});

/* The prompt alone, without a host's own guard: every host that parks a verb behind it (devices,
   mailboxes, desktop link, approval, join) leans on this. */
describe("the prompt itself", () => {
  async function mountPrompt(calls: string[]): Promise<{ c: HTMLElement; drop: () => void }> {
    const { StepUp } = await import("../app/(product)/mailbox/StepUp.js");
    let drop: () => void = () => {};
    function Host(): React.ReactElement | null {
      const [shown, setShown] = React.useState(true);
      drop = () => setShown(false);
      return shown
        ? h(StepUp, {
          onVerified: () => calls.push("verified"),
          onCancel: () => calls.push("cancel"),
          onDiscarded: () => calls.push("discarded"),
        })
        : null;
    }
    const c = await mountNode(h(Host));
    return { c, drop: () => drop() };
  }

  it("taken away while the answer is held, it never calls onVerified", async () => {
    const calls: string[] = [];
    const { c, drop } = await mountPrompt(calls);
    await verifyHeldInDialog(c);

    await act(async () => {
      drop();
    });
    await land();

    expect(calls, "a prompt that is gone ran the parked verb").not.toContain("verified");
  });

  it("CONTROL: left in place, the same answer calls onVerified once", async () => {
    const calls: string[] = [];
    const { c } = await mountPrompt(calls);
    await verifyHeldInDialog(c);
    await land();

    expect(calls).toEqual(["verified"]);
  });
});

describe("Settings: another pane while the factor is checked", () => {
  beforeEach(async () => {
    (await import("./_view-shell.js")).setup();
    Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  });
  afterEach(async () => {
    (await import("../app/api-client.js")).bindApiOwner(null);
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    window.history.replaceState(null, "", "/");
  });

  /**
   * Away from the Account section while the factor's dialog stands. The dialog is modal on the new shell (its scrim and
   * Esc are Cancel; a press on the rail behind it left it standing), and the test door's host hands Settings its
   * Account section alone, so no other menu entry stands: a person leaves it by the address, the browser's Back or a
   * link to another place, and the section is drawn no more, as another section of the menu took it away.
   */
  const leaveTheSection = async (): Promise<void> => {
    await act(async () => {
      window.history.pushState(null, "", "/#/ohbox");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  };

  it("the erase: no DELETE /account after the switch", async () => {
    const { c, leave } = await mountErasePage();
    await eraseOnThePageToTheDialog(c);
    await verifyHeldInDialog(c);
    /* The page asks the factor before its first DELETE (its own design: `delete-account-page.test.tsx`, "over a window
       that is already open, the press still asks the factor and erases nothing before it"), so none has gone out when
       the person leaves, where today's Settings had tried once into the closed window. */
    expect(sent(ERASE), "the page tried an erase before the factor").toBe(0);

    await leave();
    expect(dialog(c), "the switch took the pane away").toBeNull();
    await land();

    expect(sent(ERASE), "DELETE /account went out after the switch").toBe(0);
    expect(rig.wipes).toBe(0);
    expect(await erasedOwner()).toBeNull();
  });

  it("the password change: not sent again after the switch", async () => {
    const c = await mountSettings();
    await waitFor(() => [...c.querySelectorAll("button")].some((b) => b.textContent?.trim() === en.passwordChange.submit), "the password's verb");
    await click([...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === en.passwordChange.submit)!);
    await changeToThePrompt(c);
    await verifyHeldInDialog(c);

    await leaveTheSection();
    expect(dialog(c), "the switch took the pane away").toBeNull();
    await land();

    expect(sent(CHANGE), "POST /auth/password went out after the switch").toBe(1);
  });
});
