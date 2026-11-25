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
import { mailboxProbes } from "./join-mailbox-probes.js";

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
  const { JoinRoute: JoinScreen } = await import("../app/(product)/join/JoinRoute.js");
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
  /* The step is the one connect form: its fields by their labels, its tiles by their names. The account step's
     own field keeps its id. */
  const probes = mailboxProbes(host, en, act);
  const field = (id: string) => probes.input(id);
  const type = async (id: string, value: string) => {
    expect(field(id), `#${id} is not on screen`).toBeTruthy();
    await probes.typeInto(field(id), value, id);
  };
  /** Type the address and leave the field, as a person does before the tiles. */
  const address = async (value: string) => {
    await type("join-mb-address", value);
    await act(async () => { field("join-mb-address")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await settle();
  };
  const { tiles, checked } = probes;
  const tile = async (label: string) => {
    const b = tiles().find((t) => t.textContent === label);
    expect(b, `no ${label} tile`).toBeTruthy();
    await act(async () => { b!.click(); });
  };
  const press = async (label: string) => {
    const button = probes.button(label);
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const lookups = () => sent.filter((s) => s.path === "/mailboxes/discover").map((s) => s.body);
  return { host, act, settle, field, type, address, tiles, checked, tile, press, lookups, alerts: probes.alerts };
}

describe("the address comes first and chooses the tile", () => {
  it("the address field is on screen before any tile is chosen", async () => {
    const ui = await mount();
    expect(ui.host.querySelector("h1")?.textContent?.trim()).toBe(en.onboarding.providerFirst);
    expect(ui.checked()).toEqual([]);
    expect(ui.field("join-mb-address")).toBeTruthy();
    const address = ui.field("join-mb-address")!;
    const group = ui.tiles()[0]!.closest('[role="group"]')!;
    const order = [...ui.host.querySelectorAll("input, [role=group]")]
      .filter((n) => n === address || n === group)
      .map((n) => (n === address ? "join-mb-address" : "tiles"));
    expect(order).toEqual(["join-mb-address", "tiles"]);
  });

  it("an address at each preset's own domain preselects that preset, asking nobody", async () => {
    const ui = await mount();
    for (const p of PROVIDERS.filter((x) => !x.manual)) {
      expect(AT[p.id], `a domain for ${p.id}`).toBeTruthy();
      await ui.address(at(AT[p.id]!));
      const name = p.id === "microsoft" ? en.providerPicker.microsoftShort
        : p.id === "icloud" ? en.providerPicker.icloudShort : p.label;
      expect(ui.checked(), p.id).toEqual([name]);
    }
    expect(ui.lookups()).toEqual([]);
  });

  it("the preset's note opens with what you'll need", async () => {
    const ui = await mount();
    await ui.address(at("web.de"));
    await ui.tile("WEB.DE");
    expect(ui.host.textContent).toContain(en.providerPicker.need_webde);
  });

  it("a provider's help link opens beside the sign-up, never in its place, and carries no referrer, as the shipped picker's links did", async () => {
    const ui = await mount();
    await ui.address(at("gmail.com"));
    expect(ui.checked()).toEqual(["Gmail"]);
    await ui.tile("Gmail");
    const links = [en.providerPicker.help_gmail, en.providerPicker.prereq_gmail].map(
      (name) => [...ui.host.querySelectorAll("a")].find((a) => a.textContent === name) ?? null,
    );
    for (const a of links) {
      expect(a, "the help link is drawn").not.toBeNull();
      expect(a!.getAttribute("href")).toMatch(/^https:\/\/myaccount\.google\.com\//);
      expect(a!.getAttribute("target"), "the link opens in a tab of its own").toBe("_blank");
      expect(a!.getAttribute("rel") ?? "", "the link carries no referrer").toMatch(/noreferrer/);
    }
  });

  it("a domain on Google Workspace goes to Gmail, one on Microsoft 365 to Microsoft; only the domain is sent", async () => {
    discover["acme-workspace.example"] = found("gmail");
    discover["acme-365.example"] = found("microsoft");
    const ui = await mount();
    await ui.address(at("acme-workspace.example"));
    expect(ui.checked()).toEqual(["Gmail"]);
    await ui.address(at("acme-365.example"));
    expect(ui.checked()).toEqual([en.providerPicker.microsoftShort]);
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
    expect(ui.tiles()).toEqual([]);
    await ui.type("join-mb-pass", fixturePassword("join-address-first"));
    answer(found("gmail"));
    await ui.settle();
    expect(ui.field("join-mb-pass")?.value).toBe(fixturePassword("join-address-first"));
    await ui.press(en.onboarding.back);
    expect(ui.checked()).toEqual(["Infomaniak"]);
  });

  it("the manual tile pressed while the lookup is out gives way to the preset it finds; pressed after, it stays", async () => {
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    discover["acme-ws.example"] = new Promise((r) => { answer = r; });
    const ui = await mount();
    await ui.address(at("acme-ws.example"));
    await ui.tile(en.providerPicker.otherShort);
    expect(ui.tiles()).toEqual([]);
    expect(ui.host.textContent).toContain(en.join.manualTitle);
    expect(ui.host.querySelector('a[href="/login"]')?.textContent).toBe(en.join.signIn);
    answer(found("gmail"));
    await ui.settle();
    expect(ui.checked()).toEqual(["Gmail"]);
    await ui.tile(en.providerPicker.otherShort);
    await ui.settle();
    expect(ui.tiles()).toEqual([]);
    expect(ui.host.textContent).toContain(en.join.manualTitle);
  });

  it("a pause in typing looks the domain up without leaving the field", async () => {
    discover["acme-typed.example"] = found("microsoft");
    const ui = await mount();
    await ui.type("join-mb-address", at("acme-typed.example"));
    await ui.act(async () => { await new Promise((r) => setTimeout(r, LOOKUP_PAUSE_MS + 50)); });
    await ui.settle();
    expect(ui.lookups()).toEqual([{ domain: "acme-typed.example" }]);
    expect(ui.checked()).toEqual([en.providerPicker.microsoftShort]);
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
    await ui.tile("WEB.DE");
    await ui.type("join-mb-pass", fixturePassword("join-address-first"));
    await ui.press(en.join.connectMailbox);
    expect(ui.alerts().map((a) => a.textContent)).toEqual([en.mailboxes.probe_auth_webde]);
    await ui.press(en.onboarding.back);
    expect(ui.tiles().length).toBe(PROVIDERS.length);
    expect(ui.checked()).toEqual(["WEB.DE"]);
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
    await ui.tile(en.providerPicker.otherShort);
    expect(ui.host.textContent, "nothing offered before a refusal").not.toContain("imap.acme-srv.example");
    await ui.type("join-imap", "mail.acme-srv.example");
    await ui.type("join-smtp", "mail.acme-srv.example");
    await ui.type("join-mb-pass", fixturePassword("join-address-first"));
    await ui.press(en.join.manualConnect);
    const creates = () => sent.filter((s) => s.path === "/mailboxes").length;
    expect(creates()).toBe(1);
    expect(ui.host.textContent).toContain("imap.acme-srv.example");
    await ui.press(en.providerPicker.discoveredUse);
    expect(ui.field("join-imap")?.value).toBe("imap.acme-srv.example");
    expect(ui.field("join-smtp")?.value).toBe("smtp.acme-srv.example");
    expect(creates(), "the press fills the fields and dials nothing").toBe(1);
  });

  it("taking the hosts the lookup found takes the wizard's sentence away too, as the step's press did", async () => {
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
    await ui.tile(en.providerPicker.otherShort);
    await ui.type("join-imap", "mail.acme-srv.example");
    await ui.type("join-smtp", "mail.acme-srv.example");
    await ui.type("join-mb-pass", fixturePassword("join-address-first"));
    await ui.press(en.join.manualConnect);
    // Another tab signs this browser in as somebody else: the next press sends nothing and the wizard says so.
    session = { status: 200, body: { ...FULL, user: { ...FULL.user, accountId: "b2", email: "sam@family.example" } } };
    await ui.press(en.join.manualConnect);
    const changed = en.join.accountChanged.replace("{email}", "sam@family.example");
    expect(ui.host.textContent).toContain(changed);
    await ui.press(en.providerPicker.discoveredUse);
    expect(ui.field("join-imap")?.value).toBe("imap.acme-srv.example");
    expect(ui.host.textContent).not.toContain(changed);
  });
});

describe("the account step", () => {
  it("links to sign-in for somebody who already has an account", async () => {
    session = NO_SESSION;
    const ui = await mount();
    expect(ui.field("join-email")).toBeTruthy();
    const link = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === en.join.signIn);
    expect(link?.getAttribute("href")).toBe("/login");
  });
});
