/** @vitest-environment jsdom */
/**
 * SIGNING THIS BROWSER OUT ON THE NEW SHELL. The way out is Settings' Account section, drawn by the mail's Settings over
 * the web's real doors (`WEB_PANE_PARTS`: the session's door over `GET /auth/session`, and the app's one sign-out
 * function, real here: it revokes at the server and wipes this browser's copy). What a person meets:
 * - the rail leads to Settings, whose Account section says who is signed in;
 * - Sign out revokes the session at the server, wipes this browser's copy of the mail, and leaves by a full load of `/`;
 * - a browser that still holds the mail (another tab holds it open, so its delete is blocked) stays, and says so;
 * - a browser that will not say what it holds stays, and says so;
 * - a server that refused still leaves: the browser is wiped and marked, and the sign-in page finishes it.
 * The server is a double that records each request; the browser's databases are a double that answers each delete as
 * blocked while another tab holds the copy.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "@ohmail/app/host";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { catchConsole, en, json, serve, session, settle, type Server } from "./account/account-harness";
import { engineOver, setup, storeWith, teardown } from "./_view-shell";
import { MailShell } from "./_mail-shell";
import { WEB_PANE_PARTS } from "../app/(product)/mailbox/pane-parts";
import { AccountCleanupContext, AccountCleanupGate, type AccountCleanup } from "../app/(product)/mailbox/AccountCleanupGate";

/** The web's own doors of the Account section, as its entry hands them. */
const WEB_ACCOUNT = (() => {
  const parts = WEB_PANE_PARTS.account;
  if (parts === NONE) throw new Error("the web hands no doors of the Account section");
  return parts;
})();

const SESSION = "GET /api/auth/session";
const LOGOUT = "POST /auth/refresh/logout";
const ACCOUNT = session().user.accountId;
const ADDRESS = "mila@lichtgrat.example";
/** The copy of the mail this browser holds for the signed-in account, by the name the engine gives it. */
const MIRROR = "ohmail-mirror:account-under-test";
/** The registry's anchor: this origin was seen holding no copy before the registry named them all. */
const ANCHOR = "ohmail.mirror.__since";
const PENDING = "signed_out_pending";

/**
 * The tab's full loads, caught before jsdom would follow them; every other read and write of the address is the real
 * one's, so the frame's walks between places move the real fragment.
 */
function catchLoads() {
  const real = window.location;
  const loads: string[] = [];
  const caught = new Proxy(
    {},
    {
      get(_, property) {
        if (property === "assign" || property === "replace") return (to: string) => void loads.push(to);
        const value: unknown = Reflect.get(real, property, real);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
      },
      set(_, property, value) {
        return Reflect.set(real, property, value, real);
      },
    },
  );
  Object.defineProperty(window, "location", { configurable: true, value: caught });
  return {
    loads,
    restore() {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    },
  };
}

/** Whether another tab still holds the copy open: its delete is then BLOCKED, not done. */
let held = false;
/** The copies deleted, in order. */
let deleted: string[] = [];
let server: Server;
let tab: ReturnType<typeof catchLoads>;
let written: ReturnType<typeof catchConsole>;

/**
 * The browser's databases: the copy is listed while another tab holds it open, and each delete is blocked then; else
 * a delete is done. Without the registry's anchor an empty listing proves nothing: the browser will not say.
 */
function databasesOnDisk(): void {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = {
    databases: async () => (held ? [{ name: MIRROR, version: 1 }] : []),
    deleteDatabase: (name: string) => {
      const request = {} as { onsuccess?: () => void; onblocked?: () => void };
      queueMicrotask(() => {
        if (held) return request.onblocked?.();
        deleted.push(name);
        request.onsuccess?.();
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function installSessionFamily() {
  document.cookie = "tf_family=fixture-family; Path=/";
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, optionsOrRun: unknown, run?: () => Promise<unknown>) =>
        (run ?? (optionsOrRun as () => Promise<unknown>))(),
    },
  });
}

beforeEach(async () => {
  setup();
  document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
  installSessionFamily();
  const { bindApiOwner } = await import("../app/api-client");
  bindApiOwner(ACCOUNT);
  held = false;
  deleted = [];
  localStorage.setItem(`ohmail.mirror.${MIRROR}`, "1");
  databasesOnDisk();
  written = catchConsole();
  tab = catchLoads();
  server = serve({
    [SESSION]: () => json(session()),
    [LOGOUT]: () => new Response(null, { status: 204 }),
  });
  const wire = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get("x-ohmail-clear-logout") === "1") {
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      document.cookie = "tf_family=; Path=/; Max-Age=0";
      return new Response(null, { status: 204 });
    }
    if (headers.get("x-ohmail-clear") === "cache") {
      return new Response(null, { status: 202, headers: { "Clear-Site-Data": '"cache"' } });
    }
    return wire(input, init);
  };
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(async () => {
  cleanup();
  server.restore();
  tab.restore();
  written.restore();
  Reflect.deleteProperty(globalThis, "indexedDB");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_family=; Path=/; Max-Age=0";
  Reflect.deleteProperty(navigator, "locks");
  const { bindApiOwner } = await import("../app/api-client");
  bindApiOwner(null);
  vi.restoreAllMocks();
  await teardown();
});

/** The new shell as the web's entry mounts it, with the web's own doors of the Account section, at `at`. */
async function mount(at = "#/ohbox"): Promise<void> {
  window.history.replaceState(null, "", `/${at}`);
  const engine = engineOver(await storeWith([]));
  function Shell() {
    const [cleanup, showCleanup] = useState<AccountCleanup | null>(null);
    return cleanup ? <AccountCleanupGate cleanup={cleanup} /> : (
      <AccountCleanupContext.Provider value={showCleanup}>
        <MailShell demo={false} engine={engine} scope={ACCOUNT} accountDoors={WEB_ACCOUNT} />
      </AccountCleanupContext.Provider>
    );
  }
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ThemeProvider>
        <ToastHost>
          <Shell />
        </ToastHost>
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
  await settle();
  await settle();
}
const press = async (name: string): Promise<void> => {
  const button = await screen.findByRole("button", { name });
  await act(async () => {
    fireEvent.click(button);
  });
  await settle();
  await settle();
};
const said = (sentence: string): boolean => (document.body.textContent ?? "").includes(sentence);

describe("the way out, on the new shell", () => {
  it("the rail leads to Settings, and its Account section says who is signed in", async () => {
    await mount();
    const places = within(await screen.findByRole("navigation", { name: "Places" }));
    await act(async () => {
      fireEvent.click(places.getByRole("button", { name: "Settings" }));
    });
    await settle();
    const menu = within(await screen.findByRole("navigation", { name: en.settings.navAria }));
    await act(async () => {
      fireEvent.click(menu.getByRole("button", { name: "Account" }));
    });
    await settle();
    await settle();
    expect(window.location.hash).toBe("#/settings/account");
    expect(screen.getAllByText(ADDRESS).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: en.account.signOut }).closest(".oh-sheet-foot")).toBeTruthy();
  });

  it("Sign out revokes at the server, wipes this browser's copy, and leaves by a full load of the front door", async () => {
    localStorage.setItem(ANCHOR, "1");
    await mount("#/settings/account");
    server.forget();
    await press(en.account.signOut);
    expect(server.on(LOGOUT), "the session was not ended at the server").toHaveLength(1);
    expect(deleted, "this browser's copy of the mail was not wiped").toContain(MIRROR);
    expect(tab.loads, "it did not leave by a full load of the front door").toEqual(["/"]);
  });

  it("a browser that still holds the mail (another tab holds it open) stays, and says so", async () => {
    localStorage.setItem(ANCHOR, "1");
    held = true;
    await mount("#/settings/account");
    await press(en.account.signOut);
    expect(tab.loads, "it left with the mail still in this browser").toEqual([]);
    expect(said(en.accountOwn.stillHere)).toBe(true);
    expect(said(en.account.signOutBlocked)).toBe(true);
    expect(screen.getByRole("button", { name: en.account.signOut })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Places" })).toBeNull();

    held = false;
    await press(en.account.signOut);
    expect(deleted).toContain(MIRROR);
    expect(server.on(LOGOUT), "a retry of local cleanup revoked the session a second time").toHaveLength(1);
    expect(tab.loads).toEqual(["/"]);
  });

  it("a browser that will not say what it holds stays, and says that and not the blocked sentence", async () => {
    await mount("#/settings/account");
    await press(en.account.signOut);
    expect(tab.loads).toEqual([]);
    expect(said(en.accountOwn.notConfirmed)).toBe(true);
    expect(said(en.account.signOutUnverified)).toBe(true);
    expect(said(en.account.signOutBlocked)).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Places" })).toBeNull();
  });

  it("a server that refused still leaves: this browser is wiped and marked, and the sign-in page finishes it", async () => {
    localStorage.setItem(ANCHOR, "1");
    server.answer(LOGOUT, json({ error: { code: "db_busy", message: "busy", retryable: false } }, 503));
    await mount("#/settings/account");
    await press(en.account.signOut);
    expect(deleted, "this browser's copy of the mail was not wiped").toContain(MIRROR);
    expect(document.cookie, "the browser was not marked as signing out").toContain(PENDING);
    expect(tab.loads).toEqual(["/"]);
  });
});
