/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import type { Answered, Refusal, RefusalDetails } from "@ohmail/app-logic/mailboxes/connect/types";
import messagesEn from "../../../packages/app/messages/mailboxes.en.json";
import messagesDe from "../../../packages/app/messages/mailboxes.de.json";
import doorsEn from "../../../packages/app/messages/doors.en.json";
import doorsDe from "../../../packages/app/messages/doors.de.json";
import { fakeDoor } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * THE FIRST-RUN TEST VERDICT NAMES ONLY THE FIELDS ON SCREEN. Behind a named provider the stage
 * shows no host and no port, and a refused test said "Check the IMAP host and port" anyway. The
 * generic entry has both fields, so there it keeps the sentence that names them — the control.
 *
 * RE-POINTED (the switch's older tests, sorted once): the first run is the new frame's stage
 * (`_first-run-stage.tsx`), its mailbox step the one connect form (`packages/app/src/mailboxes/connect`)
 * over a wire that answers as the door did (`fakeDoor`: the door's refusal is the wire's answer, `details.transport`
 * saying which leg), in the stage's catalogue (`packages/app/messages/mailboxes.*.json`). The new form asks for more
 * before a Test than today's did: a provider (no tile is pre-selected: a Gmail address chooses Gmail's tile, the
 * named provider these cases are about; the generic entry is its own tile), the address, the password and, on the
 * generic entry, both servers; the cases give them. The verdict is what the form says at the press as a refusal (an
 * alert). The service's own refusal on the generic form reaches the form as the web's wire hands it on: its status,
 * code, sentence and details. Both languages use the notice for the combined server-name field.
 *
 * RETIRED HERE: "on the generic entry, which has both fields, the sentence names them". On a new connection the new
 * form has one field per server (a port goes after the name), and its refusal for an unreachable incoming server
 * names that field and says where a port goes; the form's own model holds it
 * (`packages/app-logic/test/mailboxes/connect/model.test.ts`, "an unreachable host on the manual entry ...").
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const messages = messagesEn;
const de = messagesDe;
const copy = messages.mailboxes as unknown as Record<string, string>;

/** A refusal as the doors read one: `details.transport` says which leg. */
const refusal = (reason: string, transport: "imap" | "smtp"): Answered<never> => ({
  ok: false,
  refusal: {
    status: 422, code: "mailbox_probe_failed", message: "the server's own sentence",
    details: { ...NO_DETAILS, reason, transport } as RefusalDetails,
  } as Refusal,
});
/** A thrown refusal of the service, as the web's wire hands it to the form. */
const answered = (e: Error): Answered<never> => {
  const r = e as Error & { httpStatus?: number; status?: number; code?: string; details?: Partial<RefusalDetails> };
  return {
    ok: false,
    refusal: {
      status: r.httpStatus ?? r.status ?? 422, code: r.code ?? "", message: r.message,
      details: { ...NO_DETAILS, ...r.details } as RefusalDetails,
    } as Refusal,
  };
};

type Said = typeof messages;
const PROBED = { ok: true as const, value: { host: "imap.gmail.com", user: "do-not-reply@gmail.com", folders: 2 } };

async function mount(reason: string, opts: {
  transport?: "imap" | "smtp"; locale?: "en" | "de";
  connect?: Answered<never>; probe?: "ok";
  /** The generic entry (both servers typed); else a named provider, Gmail. */
  generic?: boolean;
} = {}): Promise<{ el: HTMLElement; press: (label: string) => Promise<void> }> {
  const said: Said = opts.locale === "de" ? (de as unknown as Said) : messages;
  const wire = fakeDoor({
    probe: [opts.probe === "ok" ? PROBED : refusal(reason, opts.transport ?? "imap")],
    connect: [opts.connect ?? refusal(reason, opts.transport ?? "imap")],
  } as never);
  const st = await mountStage({ rows: [], door: "local", connect: wire.door, locale: opts.locale ?? "en", verbs: { ai: "unset" } });
  const el = st.el;
  const press = async (label: string): Promise<void> => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    expect(button, `no button labelled ${label}`).toBeTruthy();
    await act(async () => { button!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  };
  const type = async (label: string, value: string): Promise<void> => {
    const input = within(el).getByLabelText(label) as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value } }); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  };
  await press(said.onboarding.welcomeStart);
  if (opts.generic) {
    await press(said.providerPicker.otherShort);
    const join = (opts.locale === "de" ? doorsDe : doorsEn).join;
    await act(async () => { within(el).getByText(join.manualPorts).click(); });
    await type(said.onboarding.address, "someone@example.test");
    await type(said.onboarding.password, "app-password-fixture");
    await type(said.onboarding.imapHost, "imap.example.test");
    await type(said.onboarding.smtpHost, "smtp.example.test");
  } else {
    await type(said.onboarding.address, "do-not-reply@gmail.com");
    const tiles = within(el).getByRole("group", { name: said.providerPicker.label });
    expect(within(tiles).getByRole("button", { name: "Gmail" }).getAttribute("aria-pressed")).toBe("true");
    await press("Gmail");
    await type(said.onboarding.password, "app-password-fixture");
  }
  return { el, press };
}

/** What the form says at the press as a refusal. */
const verdict = (el: HTMLElement): string =>
  [...el.querySelectorAll('[role="alert"]')].map((n) => (n.textContent ?? "").trim()).filter(Boolean).join(" ");

describe("the first-run refusal names the outgoing server", () => {
  it("a password only the outgoing server refused, in English and in German", async () => {
    for (const [locale, said] of [["en", messages], ["de", de]] as const) {
      const { el, press } = await mount("auth", { transport: "smtp", locale });
      await press(said.onboarding.test);
      expect(verdict(el)).toContain(said.mailboxes.probe_auth_smtp);
    }
  });

  it("control: a password the incoming server refused keeps the incoming sentence", async () => {
    const { el, press } = await mount("auth", { generic: true });
    await press("Test connection");
    expect(verdict(el)).toContain(copy.probe_auth);
  });

  it("behind a named provider, an outgoing server that did not answer is named as the outgoing one", async () => {
    const { el, press } = await mount("timeout", { transport: "smtp" });
    await press("Test connection");
    expect(verdict(el)).toContain("outgoing (SMTP)");
    expect(verdict(el)).not.toMatch(/\bport\b|\bhost\b|server name/i);
  });

  it("the connect's refusal is the catalogue's sentence in German, not the server's English", async () => {
    const { el, press } = await mount("auth", {
      locale: "de",
      probe: "ok",
      connect: refusal("auth", "smtp"),
    });
    await press(de.onboarding.test);
    await press(de.onboarding.connect);
    expect(verdict(el)).toContain(de.mailboxes.probe_auth_smtp);
    expect(el.textContent).not.toContain("the server's own sentence");
  });

  /* The generic form shows both hosts: an outgoing refusal sent the person to the IMAP host and
     port, under the incoming Test that had just passed. The refusal is the service's own. */
  it("on the generic form, a connect the outgoing server refused names the SMTP host, in English and in German", async () => {
    const { MailboxService } = await import("@trafficflow/services/mail");
    const svc = new MailboxService({ keyProvider: {} } as never);
    for (const reason of ["connect", "timeout", "tls"] as const) {
      const wire = await svc.create({ accountId: "a", now: () => new Date() } as never, {
        provider: "imap", address: "pat@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, user: "pat@example.test", pass: "fixture-password" },
        smtp: { host: "smtp.example.test", port: 587, secure: false },
      } as never, { probe: async () => ({ verdict: "ok" }), smtpProbe: async () => ({ verdict: "refuse", code: reason }) } as never)
        .then(() => { throw new Error("the create was not refused"); }, (e: unknown) => e as Error);
      for (const [locale, said] of [["en", messages], ["de", de]] as const) {
        const { el, press } = await mount(reason, { locale, probe: "ok", connect: answered(wire), generic: true });
        await press(said.onboarding.test);
        await press((locale === "de" ? doorsDe : doorsEn).join.manualConnect);
        const t = createTranslator({ locale, messages: said, namespace: "mailboxes" });
        expect(verdict(el), `${reason}, ${locale}`).toContain(t(`probe_${reason}_noport`, { field: "smtp" }));
        expect(verdict(el), `${reason}, ${locale}`).toMatch(/SMTP/);
        expect(verdict(el), `${reason}, ${locale}`).not.toMatch(/IMAP/);
      }
    }
  });
});

describe("the first-run test verdict", () => {
  it("on the generic entry, which has both fields, the sentence names them", async () => {
    const { el, press } = await mount("connect", { generic: true });
    expect(within(el).getByLabelText(messages.onboarding.imapHost)).toBeTruthy();
    expect(within(el).getByLabelText(messages.onboarding.smtpHost)).toBeTruthy();
    await press(messages.onboarding.test);
    expect(verdict(el)).toMatch(/IMAP|incoming/i);
    expect(verdict(el)).toMatch(/port/i);
  });

  for (const reason of ["connect", "timeout", "tls"]) {
    it(`behind a named provider, ${reason} names no host and no port`, async () => {
      const { el, press } = await mount(reason);
      expect(within(el).queryByLabelText(messages.onboarding.imapHost)).toBeNull();
      expect(within(el).queryByLabelText(messages.onboarding.smtpHost)).toBeNull();
      await press(messages.onboarding.test);
      expect(verdict(el)).not.toBe("");
      expect(verdict(el)).not.toMatch(/\bport\b|\bhost\b|server name/i);
    });
  }
});
