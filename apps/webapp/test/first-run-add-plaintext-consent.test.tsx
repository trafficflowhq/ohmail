/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { Answered, ConnectProbed } from "@ohmail/app-logic/mailboxes/connect/types";
import { providerById } from "@ohmail/app-logic/mailboxes/connect/providers";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import {
  M, O, P, fakeDoor, id, no, noEncryption, refusal, type DoorScript,
} from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * THE ADD-A-MAILBOX RUN CAN CONNECT A HOME MAIL SERVER WITHOUT TLS. Setup's mailbox step and
 * Settings → Mailboxes offer a consent line per protocol after the server refuses that protocol
 * as having no TLS on a private network; `#/first-run/add` sent no consent at all, so the same
 * server connected from two doors and not from this one. The doubles answer as the doors do: a
 * Test refuses the incoming half by throwing, the outgoing half's refusal arrives on Connect.
 *
 * RE-POINTED (the switch's older tests, sorted once): the add run is the new frame's first-run stage at
 * `#/first-run/add` (`_first-run-stage.tsx`), its mailbox step the one connect form
 * (`packages/app/src/mailboxes/connect`) over a wire that answers as the door does (`fakeDoor`: a refusal is the
 * door's answer, its details the engine's taxonomy); a field is found by its label, a consent line by its switch's
 * name, a provider by its tile. The ports are not typed: the form's own defaults stand. Every expectation is as it
 * stood. One case left for the form's own model ("an unreachable host on the generic entry offers the hosts the lookup
 * found": `packages/app-logic/test/mailboxes/connect/model.test.ts`, "an unreachable host on the manual entry lets
 * the looked-up hosts be offered"): a new connection's server is one field, its port written in it only where it is
 * not the usual one, so today's port fields' contents are no longer there to read.
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const copy = M;
const IMAP_LINE = copy.insecureConsentLabel;
const SMTP_LINE = copy.insecureConsentLabelSmtp;
const BOTH_LINE = copy.insecureConsentLabelBoth;
/** The words the old case read from the web's catalogue, now the stage's (the same sentences). */
const messages = { onboarding: O, providerPicker: P };

/** A refusal with no plaintext offer: the server has no encryption and offers nothing. */
const NO_OFFER = no(refusal("mailbox_probe_failed", {
  reason: "tls", transport: "imap",
  tls: { kind: "tls_unavailable", plaintext: null, certHost: null, expectedHost: null, suggestedHost: null, trustVariable: null, certificate: null },
}));
const CONNECTED = { ok: true as const, value: { mailboxId: id("mb-2"), address: "pat@home.example" } };

/** The fields of the form, by their labels. */
const LABEL = { address: O.address, pass: O.password, imap: O.imapHost, smtp: O.smtpHost } as const;

it("an unreachable host on the generic entry offers the hosts the lookup found, and the press fills them", async () => {
  const ui = await addRun({
    probe: [no(refusal("mailbox_probe_failed", { reason: "connect", transport: "imap" }))],
    discover: {
      preset: null, proton: false,
      imap: { host: "imap.studio.example", port: 993, secure: true },
      smtp: { host: "smtp.studio.example", port: 587, secure: true },
    },
  });
  await ui.press(P.otherShort);
  await ui.type("address", "person@studio.example");
  await ui.type("pass", "app-password-fixture");
  await ui.type("imap", "old.studio.example");
  await ui.type("smtp", "old.studio.example");
  expect(ui.el.textContent).not.toContain("imap.studio.example");
  await ui.press(O.test);
  expect(ui.lookups()).toContainEqual({ domain: "studio.example" });
  await ui.press(P.discoveredUse);
  expect((within(ui.el).getByLabelText(LABEL.imap) as HTMLInputElement).value).toBe("imap.studio.example");
  expect((within(ui.el).getByLabelText(LABEL.smtp) as HTMLInputElement).value).toBe("smtp.studio.example");
  expect(ui.connected()).toHaveLength(0);
});

/** The add run, at its address, over a connect wire scripted as the case says. */
async function addRun(script: DoorScript, door: "cloud" | "local" = "cloud") {
  const wire = fakeDoor(script);
  const st = await mountStage({ rows: [], at: "#/first-run/add", door, connect: wire.door, verbs: { ai: "on" } });
  const el = st.el;
  const settle = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
  const press = async (label: string): Promise<void> => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    expect(button, `no button labelled ${label}`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const type = async (field: keyof typeof LABEL, value: string): Promise<void> => {
    const input = within(el).getByLabelText(LABEL[field]) as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value } }); });
  };
  const consent = (label: string): HTMLElement | null => within(el).queryByRole("switch", { name: label });
  const tick = async (label: string): Promise<void> => {
    const box = consent(label);
    expect(box, `no consent line "${label}"`).toBeTruthy();
    await act(async () => { box!.click(); });
  };
  /** Where an old checkbox said `checked`, the switch says `aria-checked`. */
  const checked = (box: HTMLElement | null): boolean => box?.getAttribute("aria-checked") === "true";
  return {
    el, press, type, consent, tick, checked, settle,
    probed: () => wire.of("probe").map((c) => c.sent as Record<string, unknown>),
    connected: () => wire.of("connect").map((c) => (c.sent as { input: Record<string, unknown> }).input),
    lookups: () => wire.of("discover").map((c) => ({ domain: c.sent })),
  };
}

async function mount(
  /** A protocol is a refusal offering it; `null` offers nothing; any other answer is the door's as it stands. */
  refusals: Array<"imap" | "smtp" | null | Answered<ConnectProbed>>, connectRefusals: Array<"imap" | "smtp"> = [],
  /** The outgoing host typed; the incoming one is `mail.home.arpa`. */
  outgoing = "smtp.home.arpa",
  /** What a passing test says about the outgoing server, test by test. */
  sending: Array<ConnectProbed["sending"]> = [],
) {
  const probe: Answered<ConnectProbed>[] = refusals.map((r) =>
    r === "imap" || r === "smtp" ? noEncryption(r) : r === null ? NO_OFFER : r);
  for (let i = 0; i < 8; i++) {
    const said = sending.shift();
    probe.push({ ok: true, value: { host: "mail.home.arpa", user: "pat@home.example", folders: 1, ...(said ? { sending: said } : {}) } as ConnectProbed });
  }
  const connect = [...connectRefusals.map((leg) => noEncryption(leg)), CONNECTED, CONNECTED];
  const ui = await addRun({ probe, connect });
  await ui.press(P.otherShort);
  await ui.type("address", "pat@home.example");
  await ui.type("pass", "app-password-fixture");
  await ui.type("imap", "mail.home.arpa");
  await ui.type("smtp", outgoing);
  return {
    el: ui.el, press: ui.press, type: ui.type, tick: ui.tick,
    consent: (label: string) => {
      const box = ui.consent(label);
      return box === null ? null : { checked: ui.checked(box), el: box };
    },
    get probed() { return ui.probed(); },
    get connected() { return ui.connected(); },
  };
}

const insecure = (block: unknown): boolean | undefined => (block as { allowInsecure?: boolean } | undefined)?.allowInsecure;

describe("the add-a-mailbox run and a home mail server without TLS", () => {
  it("offers each protocol its own consent line after that protocol is refused, and sends each only in its block", async () => {
    const ui = await mount(["imap"], ["smtp"]);

    await ui.press("Test connection");
    expect(ui.consent(IMAP_LINE), "no IMAP consent after the IMAP refusal").not.toBeNull();
    expect(ui.consent(SMTP_LINE), "an SMTP line before SMTP refused").toBeNull();
    expect(ui.el.textContent).toContain(copy.insecureConsentWarning);
    expect((ui.probed[0]!.imap as { allowInsecure?: boolean }).allowInsecure).toBeUndefined();

    await ui.tick(IMAP_LINE);
    await ui.press("Test connection");
    expect((ui.probed[1]!.imap as { allowInsecure?: boolean }).allowInsecure).toBe(true);
    expect((ui.probed[1]!.smtp as { allowInsecure?: boolean }).allowInsecure, "the IMAP tick leaked into SMTP").toBeUndefined();

    // The create dials the outgoing server too, and its refusal opens that protocol's line.
    await ui.press(messages.onboarding.connect);
    expect(ui.consent(SMTP_LINE), "no SMTP consent after the SMTP refusal").not.toBeNull();
    expect(ui.consent(IMAP_LINE)!.checked, "the IMAP tick was lost").toBe(true);

    await ui.tick(SMTP_LINE);
    await ui.press("Test connection");
    expect((ui.probed[2]!.smtp as { allowInsecure?: boolean }).allowInsecure).toBe(true);

    await ui.press(messages.onboarding.connect);
    expect(ui.connected).toHaveLength(2);
    expect((ui.connected[1]!.imap as { allowInsecure?: boolean }).allowInsecure).toBe(true);
    expect((ui.connected[1]!.smtp as { allowInsecure?: boolean }).allowInsecure).toBe(true);
  });

  it("a consent is about one server: changing the host takes the line and the tick away", async () => {
    const ui = await mount(["imap"]);
    await ui.press("Test connection");
    await ui.tick(IMAP_LINE);
    await ui.type("imap", "mail2.home.arpa");
    expect(ui.consent(IMAP_LINE)).toBeNull();
    await ui.press("Test connection");
    expect((ui.probed[1]!.imap as { allowInsecure?: boolean }).allowInsecure).toBeUndefined();
  });

  it("a refusal that offers nothing opens no line", async () => {
    const ui = await mount([null]);
    await ui.press("Test connection");
    expect(ui.consent(IMAP_LINE)).toBeNull();
    expect(ui.consent(SMTP_LINE)).toBeNull();
  });

  /* ONE SERVER ON BOTH LEGS, ONE CONSENT. A home server offers neither leg encryption; the line
     the incoming refusal opens names both, and ticking it sends the claim on both blocks — each
     re-proved by its own probe — so the outgoing server is not refused a second time. */
  it("one host on both legs: one line for both, and its tick claims both", async () => {
    const ui = await mount(["imap"], [], "mail.home.arpa");
    await ui.press("Test connection");
    expect(ui.consent(BOTH_LINE), "no line for the one server").not.toBeNull();
    expect(ui.consent(IMAP_LINE), "a line per protocol over one server").toBeNull();
    expect(ui.consent(SMTP_LINE)).toBeNull();

    await ui.tick(BOTH_LINE);
    await ui.press("Test connection");
    expect([insecure(ui.probed[1]!.imap), insecure(ui.probed[1]!.smtp)]).toEqual([true, true]);
    await ui.press(messages.onboarding.connect);
    expect([insecure(ui.connected[0]!.imap), insecure(ui.connected[0]!.smtp)]).toEqual([true, true]);
  });

  it("two hosts: the outgoing line opens from the test that found no encryption there", async () => {
    const ui = await mount([], [], "smtp.home.arpa", [
      { state: "refused", host: "smtp.home.arpa", reason: "tls", tls: { kind: "tls_unavailable", plaintext: "offered" } },
    ]);
    await ui.press("Test connection");
    expect(ui.consent(SMTP_LINE), "the test's outgoing verdict opened no line").not.toBeNull();
    expect(ui.consent(IMAP_LINE)).toBeNull();
    expect(ui.el.textContent).toContain(messages.onboarding.sendingRefusedNoTls.replace("{host}", "smtp.home.arpa"));

    await ui.tick(SMTP_LINE);
    await ui.press("Test connection");
    expect([insecure(ui.probed[1]!.imap), insecure(ui.probed[1]!.smtp)]).toEqual([undefined, true]);
  });
});

/* A SERVER ON THIS COMPUTER WITH ITS OWN CERTIFICATE (Proton Mail Bridge). The engine's refusal
   offers that certificate; the line names its fingerprint, unticked, and only a tick for the
   fingerprint now shown claims it: a certificate that changed is asked about again. */
describe("the add run and a mail server on this computer with its own certificate", () => {
  const print = (first: string) => [first, ...Array.from({ length: 31 }, (_, i) => (i + 16).toString(16).toUpperCase())].join(":");
  const BRIDGE = print("4A");
  const OTHER = print("FF");
  const ownCertificate = (sha256: string): Answered<ConnectProbed> => no(refusal("mailbox_probe_failed", {
    reason: "tls", transport: "imap", localServer: true,
    tls: { kind: "self_signed", certificate: sha256, plaintext: null, certHost: null, expectedHost: null, suggestedHost: null, trustVariable: null },
  }));
  const trusts = (block: unknown) => (block as { trustCertificate?: string } | undefined)?.trustCertificate;
  const LINE = copy.trustCertificateLabelBoth;
  /* The fingerprint as its own line of plain text: a paragraph whose whole text is it. */
  const printLine = (el: HTMLElement, sha256: string): HTMLParagraphElement | null =>
    [...el.querySelectorAll("p")].find((p) => (p.textContent ?? "").trim() === sha256) ?? null;
  /* What the consent's accessible description carries: the text of the element it points to. */
  const carries = (el: HTMLElement, sha256: string): boolean => {
    const id = el.getAttribute("aria-describedby");
    return (document.getElementById(id ?? "")?.textContent ?? "").trim() === sha256;
  };

  it("names the fingerprint unticked, and its tick claims it for both legs of the one host", async () => {
    const ui = await mount([ownCertificate(BRIDGE)], [], "127.0.0.1");
    await ui.type("imap", "127.0.0.1");
    await ui.press("Test connection");
    expect(ui.el.textContent).toContain(copy.probe_tls_self_signed_local);
    expect(ui.consent(LINE), "no trust line").not.toBeNull();
    expect(ui.consent(LINE)!.checked, "trust offered ticked").toBe(false);
    expect(printLine(ui.el, BRIDGE), "the fingerprint stands on no own line of text").not.toBeNull();
    expect(carries(ui.consent(LINE)!.el, BRIDGE), "the trust line carries no fingerprint").toBe(true);
    expect(ui.consent(LINE)!.el.closest("label")?.textContent ?? "", "the fingerprint sits inside the trust line, not on its own").not.toContain(BRIDGE);
    expect(trusts(ui.probed[0]!.imap)).toBeUndefined();

    await ui.tick(LINE);
    await ui.press("Test connection");
    expect([trusts(ui.probed[1]!.imap), trusts(ui.probed[1]!.smtp)]).toEqual([BRIDGE, BRIDGE]);
    await ui.press(messages.onboarding.connect);
    expect([trusts(ui.connected[0]!.imap), trusts(ui.connected[0]!.smtp)]).toEqual([BRIDGE, BRIDGE]);
  });

  it("a certificate that changed is asked about again, and the old tick claims nothing", async () => {
    const ui = await mount([ownCertificate(BRIDGE), ownCertificate(OTHER)], [], "127.0.0.1");
    await ui.type("imap", "127.0.0.1");
    await ui.press("Test connection");
    await ui.tick(LINE);
    await ui.press("Test connection");
    expect(ui.consent(LINE)!.checked).toBe(false);
    expect(printLine(ui.el, OTHER), "the changed fingerprint stands on no own line of text").not.toBeNull();
    expect(carries(ui.consent(LINE)!.el, OTHER), "the trust line carries no changed fingerprint").toBe(true);
    /* The test's press, by the word it wears now (a refused test leaves it "Test connection"). */
    await ui.press(ui.el.textContent!.includes(messages.onboarding.testAgain) ? messages.onboarding.testAgain : messages.onboarding.test);
    expect([trusts(ui.probed[2]!.imap), trusts(ui.probed[2]!.smtp)]).toEqual([undefined, undefined]);
  });

  it("control: a refusal with no certificate opens no trust line", async () => {
    const ui = await mount(["imap"], [], "127.0.0.1");
    await ui.press("Test connection");
    expect(ui.el.textContent).not.toContain(copy.trustCertificateNote);
  });
});

describe("the add run asks for the address first", () => {
  /** The add run's form, nothing typed; `discover` answers the lookup the way the hosted route does. */
  async function form(discover?: (domain: string) => unknown, door: "cloud" | "local" = "cloud") {
    const wire = fakeDoor({
      probe: [no(refusal("mailbox_probe_failed", { reason: "connect", transport: "imap" }))],
      connect: [CONNECTED],
      ...(discover ? {} : { discover: "none" as const }),
      localServerWait: door === "local",
    });
    if (discover) {
      /* The lookup answers per domain, as the hosted route does. */
      const asked: unknown[] = [];
      (wire.door as { discover: unknown }).discover = (domain: string) => { asked.push({ domain }); return Promise.resolve(discover(domain)); };
      lookupsOf = () => asked;
    } else lookupsOf = () => [];
    const st = await mountStage({ rows: [], at: "#/first-run/add", door, connect: wire.door, verbs: { ai: "on" } });
    const el = st.el;
    const field = (suffix: "address" | "imap" | "pass" | "smtp") => {
      const label = { address: O.address, imap: O.imapHost, pass: O.password, smtp: O.smtpHost }[suffix];
      return within(el).queryByLabelText(label) as HTMLInputElement | null;
    };
    const address = async (value: string): Promise<void> => {
      const input = field("address")!;
      await act(async () => { fireEvent.change(input, { target: { value } }); });
      await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
      await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
    };
    /** The provider chosen: the pressed tile, said as the provider's id. */
    const chosen = () => {
      const tile = [...el.querySelectorAll('[role="group"] button[aria-pressed="true"]')][0];
      const name = (tile?.textContent ?? "").trim();
      if (name === P.otherShort) return "imap";
      if (name === P.microsoftShort) return "microsoft";
      return ["webde", "infomaniak", "gmx"].find((p) => providerById(p)?.label === name) ?? name;
    };
    const choose = async (id: string) => {
      const label = id === "imap" ? P.otherShort : providerById(id)!.label;
      const tile = [...el.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => (b.textContent ?? "").trim() === label);
      await act(async () => { tile!.click(); });
    };
    return { el, field, address, chosen, choose, get lookups() { return lookupsOf(); } };
  }
  let lookupsOf: () => unknown[] = () => [];

  it("the address field comes before the choice, and its domain moves the choice", async () => {
    const ui = await form((domain) => (domain === "acme-365.example"
      ? { preset: "microsoft", proton: false, imap: null, smtp: null } : null));
    /* The address field and the provider's tiles, in the order they stand. */
    const order = [...ui.el.querySelectorAll('input, [role="group"] button')].map((n) => (n instanceof HTMLInputElement ? n.type : "radio"));
    expect(order[0]).toBe("text");
    await ui.address(personalAt("fixture.pat", "web.de"));
    expect(ui.chosen()).toBe("webde");
    await ui.address("pat@acme-365.example");
    expect(ui.chosen()).toBe("microsoft");
    expect(ui.lookups).toEqual([{ domain: "acme-365.example" }]);
  });

  it("a choice made by hand stays, and a Proton address says why it cannot connect", async () => {
    const ui = await form();
    await ui.choose("infomaniak");
    await ui.address(personalAt("fixture.pat", "gmx.net"));
    await ui.address(personalAt("fixture.pat", "proton.me"));
    expect(ui.el.textContent).toContain(messages.providerPicker.protonNote.replace("{other}", messages.providerPicker.otherLabel));
    await act(async () => { within(ui.el).getByRole("button", { name: O.back }).click(); });
    expect(ui.chosen()).toBe("infomaniak");
  });

  it("on this computer's own engine, a Proton address says how to reach Bridge here", async () => {
    const ui = await form(undefined, "local");
    await ui.address(personalAt("fixture.pat", "proton.me"));
    const other = messages.providerPicker.otherLabel;
    expect(ui.el.textContent).toContain(messages.providerPicker.protonNoteDesktop.replace("{other}", other));
    expect(ui.el.textContent).not.toContain(messages.providerPicker.protonNote.replace("{other}", other));
  });
});
