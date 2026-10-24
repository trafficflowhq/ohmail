/** @vitest-environment jsdom */
/**
 * THE MAILBOX STEP ASKS FOR THE ADDRESS FIRST. The address is on screen before any tile; an address at a
 * preset's own domain chooses that tile, and a domain the table does not know is looked up
 * (`POST /mailboxes/discover`, the domain only) after a pause or when the field is left: Workspace to Gmail,
 * Microsoft 365 to Microsoft, Proton says why it cannot connect, anything else leaves the picker to the
 * person. A slow or failed lookup holds nothing up, and a tile chosen by hand is never overridden, except
 * the manual tile pressed before the answer came, which gives way to a preset the answer names.
 * A refused connect on the manual tile offers the hosts the lookup found, and only fills the fields.
 * The account step links to sign-in for somebody who already has an account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { launchRefused } from "@trafficflow/services/mail";
import { fixturePassword, personalAt } from "../../../test/support/fixture-credentials.js";
import { PROVIDERS } from "../app/shell/providers.js";
import { LOOKUP_PAUSE_MS } from "../app/shell/address-first.js";

type Answer = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};
const NO_SESSION = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
const found = (preset: string | null, extra: Record<string, unknown> = {}) =>
  ({ status: 200, body: { preset, proton: false, imap: null, smtp: null, ...extra } });

/** One address per named preset, at a domain its own table lists. */
const AT: Record<string, string> = {
  gmail: "gmail.com", microsoft: "outlook.com", icloud: "icloud.com", yahoo: "yahoo.com",
  fastmail: "fastmail.com", gmx: "gmx.net", infomaniak: "infomaniak.com", webde: "web.de",
  tonline: "t-online.de", bluewin: "bluewin.ch",
};
const at = (domain: string): string => personalAt("fixture.pat", domain);

let session: { status: number; body: unknown } = { status: 200, body: FULL };
let discover: Record<string, Answer> = {};
let create: { status: number; body: unknown } | null = null;
let sent: Array<{ path: string; body: unknown }> = [];
let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  session = { status: 200, body: FULL };
  discover = {};
  create = null;
  sent = [];
  window.history.replaceState(null, "", "/join");
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = new URL(String(input), "http://x").pathname.replace(/^\/api/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (a: { status: number; body: unknown }) =>
      new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    if (init?.body !== undefined) sent.push({ path, body: JSON.parse(String(init.body)) });
    if (path === "/auth/session") return json(session);
    if (path === "/oauth/microsoft/availability") return json({ status: 200, body: { available: false, device: false } });
    if (path === "/mailboxes/discover") {
      const domain = (JSON.parse(String(init?.body)) as { domain: string }).domain;
      return json(await (discover[domain] ?? { status: 503, body: { error: { code: "discover_unconfigured", message: "no" } } }));
    }
    if (path === "/mailboxes" && method === "POST" && create) return json(create);
    if (path.startsWith("/mailboxes")) return json({ status: 200, body: { items: [] } });
    return json({ status: 200, body: {} });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function mount() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  const field = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`);
  const type = async (id: string, value: string) => {
    const input = field(id);
    expect(input, `#${id} is not on screen`).toBeTruthy();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  /** Type the address and leave the field, as a person does before the tiles. */
  const address = async (value: string) => {
    await type("join-mb-address", value);
    await act(async () => { field("join-mb-address")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await settle();
  };
  const tiles = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
  const checked = () => tiles().filter((b) => b.getAttribute("aria-checked") === "true")
    .map((b) => b.querySelector(".pvp-name")?.textContent);
  const tile = async (label: string) => {
    const b = tiles().find((t) => t.querySelector(".pvp-name")?.textContent === label);
    expect(b, `no ${label} tile`).toBeTruthy();
    await act(async () => { b!.click(); });
  };
  const press = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const lookups = () => sent.filter((s) => s.path === "/mailboxes/discover").map((s) => s.body);
  return { host, act, settle, field, type, address, tiles, checked, tile, press, lookups };
}

describe("the address comes first and chooses the tile", () => {
  it("the address field is on screen before any tile is chosen", async () => {
    const ui = await mount();
    expect(ui.host.querySelector("h1")?.textContent).toBe(en.join.step_mailbox_title);
    expect(ui.checked()).toEqual([]);
    expect(ui.field("join-mb-address")).toBeTruthy();
    const order = [...ui.host.querySelectorAll('#join-mb-address, [role="radiogroup"]')].map((n) => n.id || "tiles");
    expect(order).toEqual(["join-mb-address", "tiles"]);
  });

  it("an address at each preset's own domain preselects that preset, asking nobody", async () => {
    const ui = await mount();
    for (const p of PROVIDERS.filter((x) => !x.manual)) {
      expect(AT[p.id], `a domain for ${p.id}`).toBeTruthy();
      await ui.address(at(AT[p.id]!));
      expect(ui.checked(), p.id).toEqual([p.label]);
    }
    expect(ui.lookups()).toEqual([]);
  });

  it("the preset's note opens with what you'll need", async () => {
    const ui = await mount();
    await ui.address(at("web.de"));
    expect(ui.host.querySelector(".pvp-note")?.textContent).toContain(en.providerPicker.need_webde);
  });

  it("a domain on Google Workspace goes to Gmail, one on Microsoft 365 to Microsoft; only the domain is sent", async () => {
    discover["acme-workspace.example"] = found("gmail");
    discover["acme-365.example"] = found("microsoft");
    const ui = await mount();
    await ui.address(at("acme-workspace.example"));
    expect(ui.checked()).toEqual(["Gmail"]);
    await ui.address(at("acme-365.example"));
    expect(ui.checked()).toEqual(["Microsoft 365 & Outlook.com"]);
    expect(ui.lookups()).toEqual([{ domain: "acme-workspace.example" }, { domain: "acme-365.example" }]);
  });

  it("an unknown domain leaves the picker to the person, and a preselection it no longer backs goes", async () => {
    discover["acme-own.example"] = found(null);
    const ui = await mount();
    await ui.address(at("gmx.net"));
    expect(ui.checked()).toEqual(["GMX"]);
    await ui.address(at("acme-own.example"));
    expect(ui.checked()).toEqual([]);
    expect(ui.tiles().length).toBe(PROVIDERS.length);
    expect(ui.field("join-mb-pass"), "nothing but the address before a choice").toBeNull();
  });

  it("a failed lookup falls back to the picker", async () => {
    discover["acme-down.example"] = { status: 500, body: { error: { code: "internal", message: "no" } } };
    const ui = await mount();
    await ui.address(at("acme-down.example"));
    expect(ui.checked()).toEqual([]);
    await ui.tile("Fastmail");
    expect(ui.field("join-mb-pass")).toBeTruthy();
  });

  it("a slow lookup holds nothing up, and its late answer does not override a tile chosen by hand", async () => {
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    discover["acme-slow.example"] = new Promise((r) => { answer = r; });
    const ui = await mount();
    await ui.address(at("acme-slow.example"));
    await ui.tile("Infomaniak");
    await ui.type("join-mb-pass", fixturePassword("join-address-first"));
    expect(ui.checked()).toEqual(["Infomaniak"]);
    answer(found("gmail"));
    await ui.settle();
    expect(ui.checked()).toEqual(["Infomaniak"]);
    expect(ui.field("join-mb-pass")?.value).toBe(fixturePassword("join-address-first"));
  });

  it("the manual tile pressed while the lookup is out gives way to the preset it finds; pressed after, it stays", async () => {
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    discover["acme-ws.example"] = new Promise((r) => { answer = r; });
    const ui = await mount();
    await ui.address(at("acme-ws.example"));
    await ui.tile(en.providerPicker.otherLabel);
    expect(ui.checked()).toEqual([en.providerPicker.otherLabel]);
    answer(found("gmail"));
    await ui.settle();
    expect(ui.checked()).toEqual(["Gmail"]);
    await ui.tile(en.providerPicker.otherLabel);
    await ui.settle();
    expect(ui.checked()).toEqual([en.providerPicker.otherLabel]);
  });

  it("a pause in typing looks the domain up without leaving the field", async () => {
    discover["acme-typed.example"] = found("microsoft");
    const ui = await mount();
    await ui.type("join-mb-address", at("acme-typed.example"));
    await ui.act(async () => { await new Promise((r) => setTimeout(r, LOOKUP_PAUSE_MS + 50)); });
    await ui.settle();
    expect(ui.lookups()).toEqual([{ domain: "acme-typed.example" }]);
    expect(ui.checked()).toEqual(["Microsoft 365 & Outlook.com"]);
  });

  it("a Proton address shows Proton's note, and so does a domain the lookup finds on Proton", async () => {
    discover["acme-proton.example"] = found(null, { proton: true });
    const ui = await mount();
    const note = en.providerPicker.protonNote.replace("{other}", en.providerPicker.otherLabel);
    await ui.address(at("proton.me"));
    expect(ui.host.textContent).toContain(note);
    expect(ui.checked()).toEqual([]);
    await ui.address(at("gmx.net"));
    expect(ui.host.textContent).not.toContain(note);
    await ui.address(at("acme-proton.example"));
    expect(ui.host.textContent).toContain(note);
    expect(ui.lookups()).toEqual([{ domain: "acme-proton.example" }]);
  });
});

describe("after a refusal", () => {
  it("a refused password on a named preset says that provider's sentence, and the tiles stay", async () => {
    const r = launchRefused("auth", false) as unknown as { httpStatus: number; code: string; message: string; details: unknown };
    create = { status: r.httpStatus, body: { error: { code: r.code, message: r.message, details: r.details } } };
    const ui = await mount();
    await ui.address(at("web.de"));
    await ui.type("join-mb-pass", fixturePassword("join-address-first"));
    await ui.press(en.join.connectMailbox);
    expect(ui.host.querySelector(".join-error")?.textContent).toBe(en.mailboxes.probe_auth_webde);
    expect(ui.tiles().length).toBe(PROVIDERS.length);
  });

  it("an unreachable host on the manual tile offers the hosts the lookup found, and the press only fills them", async () => {
    discover["acme-srv.example"] = found(null, {
      imap: { host: "imap.acme-srv.example", port: 993, secure: true },
      smtp: { host: "smtp.acme-srv.example", port: 587, secure: false },
    });
    create = {
      status: 422,
      body: { error: { code: "mailbox_probe_failed", message: "unreachable", details: { reason: "connect", transport: "imap" } } },
    };
    const ui = await mount();
    await ui.address(at("acme-srv.example"));
    await ui.tile(en.providerPicker.otherLabel);
    expect(ui.host.textContent, "nothing offered before a refusal").not.toContain("imap.acme-srv.example");
    await ui.type("join-imap", "mail.acme-srv.example");
    await ui.type("join-smtp", "mail.acme-srv.example");
    await ui.type("join-mb-pass", fixturePassword("join-address-first"));
    await ui.press(en.join.connectMailbox);
    const creates = () => sent.filter((s) => s.path === "/mailboxes").length;
    expect(creates()).toBe(1);
    expect(ui.host.textContent).toContain("imap.acme-srv.example");
    await ui.press(en.providerPicker.discoveredUse);
    expect(ui.field("join-imap")?.value).toBe("imap.acme-srv.example");
    expect(ui.field("join-smtp")?.value).toBe("smtp.acme-srv.example");
    expect(creates(), "the press fills the fields and dials nothing").toBe(1);
  });
});

describe("the account step", () => {
  it("links to sign-in for somebody who already has an account", async () => {
    session = NO_SESSION;
    const ui = await mount();
    expect(ui.field("join-email")).toBeTruthy();
    const link = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === en.join.accountSignIn);
    expect(link?.getAttribute("href")).toBe("/login");
  });
});
