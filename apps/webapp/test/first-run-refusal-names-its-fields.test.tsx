/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * THE FIRST-RUN TEST VERDICT NAMES ONLY THE FIELDS ON SCREEN. Behind a named provider the stage
 * shows no host and no port, and a refused test said "Check the IMAP host and port" anyway. The
 * generic entry has both fields, so there it keeps the sentence that names them — the control.
 */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = messages.mailboxes as unknown as Record<string, string>;

const facts: OnboardingFacts = {
  door: "local", mailbox: null, account: { onboardingCompletedAt: null }, ai: "unset", queuedSenders: 0,
};

/** A refusal as the doors read one: `details.transport` says which leg. */
const refusal = (reason: string, transport: "imap" | "smtp"): Error =>
  Object.assign(new Error("the server's own sentence"), { code: "mailbox_probe_failed", details: { reason, transport } });

async function mount(reason: string, opts: {
  transport?: "imap" | "smtp"; locale?: "en" | "de"; connect?: FirstRunHost["connect"]; probe?: FirstRunHost["probe"];
} = {}): Promise<{ el: HTMLElement; press: (label: string) => Promise<void> }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "local",
    ai: "unset",
    probe: opts.probe ?? (async () => { throw refusal(reason, opts.transport ?? "imap"); }),
    connect: opts.connect ?? (async () => ({ id: "mb-1" })),
    organize: async () => "stored",
    complete: async () => { /* nothing to finish here */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => reason,
    probeMessage: () => "the server's own sentence",
  };
  const said = opts.locale === "de" ? de : messages;
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: opts.locale ?? "en", messages: said, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host, facts, onRefresh: () => {}, onLeave: () => {},
          pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: null,
        }),
      }),
    }));
  });
  const press = async (label: string): Promise<void> => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    expect(button, `no button labelled ${label}`).toBeTruthy();
    await act(async () => { button!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  };
  await press(said.onboarding.welcomeStart);
  return { el, press };
}

const verdict = (el: HTMLElement): string => el.querySelector(".set-verdict.bad")?.textContent ?? "";

afterEach(async () => {
  const { DEFAULT_LOCALE, setActiveCatalog } = await import("../app/shell/locale");
  setActiveCatalog(DEFAULT_LOCALE, null);
});

describe("the first-run refusal names the outgoing server", () => {
  it("a password only the outgoing server refused, in English and in German", async () => {
    for (const [locale, said] of [["en", messages], ["de", de]] as const) {
      const { el, press } = await mount("auth", { transport: "smtp", locale });
      await press(said.onboarding.test);
      expect(verdict(el)).toContain(said.mailboxes.probe_auth_smtp);
    }
  });

  it("control: a password the incoming server refused keeps the incoming sentence", async () => {
    const { el, press } = await mount("auth");
    const generic = el.querySelector<HTMLInputElement>('input[type="radio"][value="imap"]');
    await act(async () => { generic!.click(); });
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
    const { fillFrom, setActiveCatalog } = await import("../app/shell/locale");
    setActiveCatalog("de", fillFrom(messages as never, de as never));
    const { el, press } = await mount("auth", {
      locale: "de",
      probe: async (input) => ({ host: input.imap.host, user: input.address, folders: 2 }),
      connect: async () => { throw refusal("auth", "smtp"); },
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
    const { fillFrom, setActiveCatalog } = await import("../app/shell/locale");
    const svc = new MailboxService({ keyProvider: {} } as never);
    for (const reason of ["connect", "timeout", "tls"]) {
      const wire = await svc.create({ accountId: "a", now: () => new Date() } as never, {
        provider: "imap", address: "pat@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true, user: "pat@example.test", pass: "fixture-password" },
        smtp: { host: "smtp.example.test", port: 587, secure: false },
      } as never, { probe: async () => ({ verdict: "ok" }), smtpProbe: async () => ({ verdict: "refuse", code: reason }) } as never)
        .then(() => { throw new Error("the create was not refused"); }, (e: unknown) => e as Error);
      for (const [locale, said] of [["en", messages], ["de", de]] as const) {
        setActiveCatalog(locale, locale === "de" ? fillFrom(messages as never, de as never) : messages as never);
        const { el, press } = await mount(reason, {
          locale,
          probe: async (input) => ({ host: input.imap.host, user: input.address, folders: 2 }),
          connect: async () => { throw wire; },
        });
        await act(async () => { el.querySelector<HTMLInputElement>('input[type="radio"][value="imap"]')!.click(); });
        await press(said.onboarding.test);
        await press(said.onboarding.connect);
        const own = (said.mailboxes as Record<string, string>)[`probe_${reason}_smtp`];
        expect(verdict(el), `${reason}, ${locale}`).toContain(locale === "en" ? wire.message : own);
        expect(verdict(el), `${reason}, ${locale}`).toMatch(/SMTP/);
        expect(verdict(el), `${reason}, ${locale}`).not.toMatch(/IMAP/);
      }
    }
  });
});

describe("the first-run test verdict", () => {
  for (const reason of ["connect", "timeout", "tls"]) {
    it(`behind a named provider, ${reason} names no host and no port`, async () => {
      const { el, press } = await mount(reason);
      expect(el.querySelector('input[type="radio"][value="gmail"]:checked'), "the stage opens on a named provider").toBeTruthy();
      await press("Test connection");
      expect(verdict(el)).not.toBe("");
      expect(verdict(el)).not.toMatch(/\bport\b|\bhost\b|server name/i);
    });
  }

  it("on the generic entry, which has both fields, the sentence names them", async () => {
    const { el, press } = await mount("connect");
    const generic = el.querySelector<HTMLInputElement>('input[type="radio"][value="imap"]');
    expect(generic).toBeTruthy();
    await act(async () => { generic!.click(); });
    expect(el.querySelector("[id$='-imap-port']"), "the generic entry shows a port field").toBeTruthy();
    await press("Test connection");
    expect(verdict(el)).toContain(copy.probe_connect!);
  });
});
