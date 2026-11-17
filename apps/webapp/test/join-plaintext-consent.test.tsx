/** @vitest-environment jsdom */
/**
 * SETUP'S MAILBOX STEP CAN CONNECT A HOME MAIL SERVER WITHOUT TLS.
 *
 * `/setup` hands off to `/join`, whose mailbox step had no plaintext path: a LAN server with no TLS
 * dead-ended on "That server offers no encryption" with nothing to tick. The server now marks a
 * `tls_unavailable` refusal `offered` for a host on a private network, per protocol; the step shows
 * one consent line per refused protocol and sends each consent only in its own block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { mailboxProbes } from "./join-mailbox-probes.js";

const session = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
  },
  scope: "full",
};

/** The server's answers to successive `POST /mailboxes`, and the bodies it was sent. */
let answers: Array<{ status: number; body: unknown }> = [];
let posted: Array<{ imap: Record<string, unknown>; smtp: Record<string, unknown> }> = [];
const noTls = (transport: "imap" | "smtp", plaintext: "offered" | "not_private") => ({
  status: 400,
  body: {
    error: {
      code: "mailbox_probe_failed",
      message: transport === "smtp"
        ? "That outgoing (SMTP) mail server offers no encryption — no TLS and no STARTTLS — so we stopped before sending the password."
        : "That incoming (IMAP) mail server offers no encryption — no TLS and no STARTTLS — so we stopped before sending the password.",
      details: { reason: "tls", transport, tls: { kind: "tls_unavailable", plaintext } },
    },
  },
});
const created = { status: 201, body: { id: "mb1", address: "pat@family.example", status: "connected", lastSyncAt: null } };

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  answers = [];
  posted = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, session);
    if (url.includes("/mailboxes") && method === "POST") {
      posted.push(JSON.parse(String(init?.body)));
      const next = answers.shift() ?? created;
      return json(next.status, next.body);
    }
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.restoreAllMocks();
});

/** The two servers a case types. One name on both is one server: its consent is then one line for both. */
async function setupMailboxStep(servers: { imap: string; smtp: string } = { imap: "mail.home.arpa", smtp: "smtp.home.arpa" }) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinRoute: JoinScreen } = await import("../app/(product)/join/JoinRoute.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: false }),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };

  /* The step is the one connect form: its fields by their labels, its tiles by their names, a consent by its switch. */
  const probes = mailboxProbes(host, en, act);
  const { type } = probes;
  await probes.choose(en.providerPicker.otherLabel);
  await type("join-mb-address", "pat@family.example");
  await type("join-imap", servers.imap);
  await type("join-smtp", servers.smtp);
  await type("join-mb-pass", "app-password-fixture");

  const press = async () => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === en.join.connectMailbox);
    expect(button, "no Connect mailbox button").toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  /** The consent line for a protocol, by the words it is named with; `null` when it is not offered. */
  const consent = (label: string): { readonly checked: boolean } | null => {
    const line = probes.consent(label);
    return line === null ? null : { checked: line.getAttribute("aria-checked") === "true" };
  };
  const tick = async (label: string) => {
    const line = probes.consent(label);
    expect(line, `no consent line "${label}"`).toBeTruthy();
    await act(async () => { line!.click(); });
  };
  return { host, type, press, consent, tick };
}

const IMAP_LINE = en.mailboxes.insecureConsentLabel;
const SMTP_LINE = en.mailboxes.insecureConsentLabelSmtp;
const BOTH_LINE = en.mailboxes.insecureConsentLabelBoth;
/** The refusal as the product says it, in the catalogue's words for the protocol that refused. */
const NO_ENCRYPTION = (protocol: "IMAP" | "SMTP") => en.mailboxes.probe_tls_unavailable.replace("{protocol}", protocol);

describe("setup's mailbox step and a home mail server without TLS", () => {
  it("offers each protocol its own consent line, and sends each consent only in its own block", async () => {
    answers = [noTls("imap", "offered"), noTls("smtp", "offered")];
    const ui = await setupMailboxStep();

    await ui.press();
    expect(ui.host.textContent).toContain(NO_ENCRYPTION("IMAP"));
    expect(ui.consent(IMAP_LINE), "no IMAP consent after the IMAP refusal").not.toBeNull();
    expect(ui.consent(SMTP_LINE), "an SMTP line before SMTP refused").toBeNull();
    // Nothing is consented until it is ticked: the first press carried no flag.
    expect(posted[0]!.imap.allowInsecure).toBeUndefined();

    await ui.tick(IMAP_LINE);
    await ui.press();
    expect(posted[1]!.imap.allowInsecure).toBe(true);
    expect(posted[1]!.smtp.allowInsecure, "the IMAP tick leaked into the SMTP block").toBeUndefined();
    // The refusal now names SMTP, and both lines stand, each on its own.
    expect(ui.host.textContent).toContain(NO_ENCRYPTION("SMTP"));
    expect(ui.consent(IMAP_LINE)!.checked).toBe(true);

    await ui.tick(SMTP_LINE);
    await ui.press();
    expect(posted[2]!.imap.allowInsecure).toBe(true);
    expect(posted[2]!.smtp.allowInsecure).toBe(true);
    expect(ui.host.textContent).not.toContain("offers no encryption");
  });

  it("one server for both protocols: one line names both, unticked, and its tick rides both blocks", async () => {
    answers = [noTls("imap", "offered")];
    const ui = await setupMailboxStep({ imap: "mail.home.arpa", smtp: "mail.home.arpa" });
    await ui.press();
    // One name on both fields is one server: the consent is about that server, so one line stands for both.
    expect(ui.consent(BOTH_LINE), "no line for both").not.toBeNull();
    expect(ui.consent(BOTH_LINE)!.checked, "ticked by nobody").toBe(false);
    expect(ui.consent(IMAP_LINE)).toBeNull();
    expect(ui.consent(SMTP_LINE)).toBeNull();
    expect(posted[0]!.imap.allowInsecure).toBeUndefined();
    expect(posted[0]!.smtp.allowInsecure).toBeUndefined();
    await ui.tick(BOTH_LINE);
    await ui.press();
    expect(posted[1]!.imap.allowInsecure).toBe(true);
    expect(posted[1]!.smtp.allowInsecure).toBe(true);
  });

  it("a public server gets no consent line, only the sentence that says why", async () => {
    answers = [{
      status: 400,
      body: { error: {
        code: "mailbox_probe_failed",
        message: "That incoming (IMAP) mail server offers no encryption — no TLS and no STARTTLS — so we stopped before sending the password. It is not on your own network, and ohmail sends a password unencrypted only to a server that is.",
        details: { reason: "tls", transport: "imap", tls: { kind: "tls_unavailable", plaintext: "not_private" } },
      } },
    }];
    const ui = await setupMailboxStep();
    await ui.press();
    expect(ui.host.textContent).toContain("not on your own network");
    expect(ui.consent(IMAP_LINE)).toBeNull();
    expect(ui.consent(SMTP_LINE)).toBeNull();
  });

  it("a consent is about one server: changing the host takes the line and the tick away", async () => {
    answers = [noTls("imap", "offered")];
    const ui = await setupMailboxStep();
    await ui.press();
    await ui.tick(IMAP_LINE);
    await ui.type("join-imap", "mail2.home.arpa");
    expect(ui.consent(IMAP_LINE)).toBeNull();
    await ui.press();
    expect(posted[1]!.imap.allowInsecure).toBeUndefined();
  });

  it("R23-03: a port after the server name is sent as the port, not as part of the name", async () => {
    const ui = await setupMailboxStep();
    await ui.type("join-imap", "mail.home.arpa:1143");
    await ui.type("join-smtp", "[fd00::25]:2525");
    await ui.press();
    expect(posted[0]!.imap).toMatchObject({ host: "mail.home.arpa", port: 1143 });
    expect(posted[0]!.smtp).toMatchObject({ host: "fd00::25", port: 2525 });
    expect(posted[0]!.imap.secure).toBeUndefined();
  });
});
