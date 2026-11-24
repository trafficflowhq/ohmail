/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import type { MailboxDTO } from "../app/api-client";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { formalAddress } from "./_formal-address";
import {
  act,
  installConfirmEnv,
  ISO,
  mountCloudShell,
  refresh204,
  rememberOwner,
  scriptRefresh,
  scriptSession,
  sessionFull,
  syncCalls,
  teardownConfirmEnv,
  tick,
  warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const copy = messages.mailboxes;
const copyDe = de.mailboxes;
const refused = "the removal could not be written";
const factorTitle = (catalogue: typeof messages | typeof de): string =>
  catalogue.stepUp.titleCode.replace(/\.$/, "");

const SERVICE = "packages/services/src/mailbox-service.ts";

/**
 * The removal method's own body, and it REFUSES when the anchor is gone.
 *
 * `indexOf` of a signature that had been reflowed returned -1, `slice(-1)` handed back one
 * character, and the two guards below then read an empty string: one `toContain` reds, the other
 * is a `not.toContain` and passed for nothing. A signature change must red here instead.
 */
function removalMethod(src: string): string {
  const at = src.indexOf("  async delete(");
  expect(at, `${SERVICE} no longer declares \`async delete(\` — the guards below would read ''`)
    .toBeGreaterThan(0);
  const body = src.slice(at);
  return body.slice(0, body.indexOf("\n  /**", 10));
}

function mailbox(id = "mb1"): MailboxDTO {
  return {
    id,
    provider: "icloud",
    address: [id, "example.invalid"].join("@"),
    displayName: null,
    status: "connected",
    lastSyncAt: ISO,
    createdAt: ISO,
    organizerRole: "organizer",
    initialImportCompletedAt: ISO,
    organizeConsentedAt: ISO,
  };
}

beforeAll(warmCloudShell);
beforeEach(async () => {
  installConfirmEnv();
  (await import("../app/api-client")).bindApiOwner(null);
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
});
afterEach(async () => {
  await teardownConfirmEnv();
  (await import("../app/api-client")).bindApiOwner(null);
});

async function click(button: HTMLElement): Promise<void> {
  await act(async () => button.click());
  await tick(100);
}

async function mount(items = [mailbox()], options: { closed?: boolean; locale?: "de" } = {}) {
  let listed = items;
  let closed = options.closed ?? false;
  let reads = 0;
  const removeCalls: string[] = [];
  const attempts: string[] = [];
  const factorCalls: string[] = [];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/account/access") return Response.json({ metered: false });
    if (path === "/api/mailboxes" && method === "GET") {
      reads += 1;
      return Response.json({ items: listed });
    }
    if (path === "/api/auth/step-up/totp" && method === "POST") {
      factorCalls.push(method);
      closed = false;
      return Response.json({ ok: true });
    }
    if (path.startsWith("/api/mailboxes/") && method === "DELETE") {
      const id = path.slice("/api/mailboxes/".length);
      attempts.push(id);
      if (closed) {
        return Response.json({ error: { code: "step_up_required", message: "Verification required" } }, { status: 403 });
      }
      removeCalls.push(id);
      if (id === "mb-refused") {
        return Response.json({ error: { code: "internal", message: refused } }, { status: 500 });
      }
      listed = listed.filter((item) => item.id !== id);
      return new Response(null, { status: 204 });
    }
    return fixture(input, init);
  };

  const words = options.locale === "de" ? de : messages;
  window.location.hash = "#/settings/mailboxes";
  const frame = await mountCloudShell(options.locale === "de"
    ? (shell) => createElement(NextIntlClientProvider, { locale: "de", messages: de, timeZone: "UTC", children: shell })
    : undefined);
  await tick(3000);
  const pane = within(within(frame).getByRole("region", { name: words.settings.mailboxes }));
  const addressOf = (item: MailboxDTO) => (name: string) => name.includes(item.address);
  const confirmation = (item = items[0]!) =>
    screen.queryByRole("dialog", { name: words.mailboxes.removeTitle.replace("{address}", item.address) });
  async function open(item = items[0]!): Promise<void> {
    await click(pane.getByRole("button", { name: addressOf(item), expanded: false }));
  }
  return {
    confirmation,
    open,
    attempts,
    removeCalls,
    factorCalls,
    reads: () => reads,
    row: (item: MailboxDTO) => pane.queryByRole("button", { name: addressOf(item) }),
    remove: () => pane.getByRole("button", { name: words.mailboxes.remove }),
    async ask(item = items[0]!) {
      await open(item);
      await click(pane.getByRole("button", { name: words.mailboxes.remove }));
    },
    async confirm(item = items[0]!) {
      await click(within(confirmation(item)!).getByRole("button", { name: words.mailboxes.removeConfirm }));
    },
  };
}

describe("the door exists at all", () => {
  it("a connected mailbox row offers Remove", async () => {
    const view = await mount();
    await view.open();
    expect(view.remove()).toBeTruthy();
  });

  it("Remove opens a CONFIRMATION and removes nothing by itself", async () => {
    const view = await mount();
    await view.ask();
    expect(view.confirmation(), "Remove did not open a confirmation").toBeTruthy();
    expect(view.attempts, "the first press must not destroy anything").toEqual([]);
  });

  it("Keep it removes nothing and returns to the list", async () => {
    const view = await mount();
    await view.ask();
    await click(within(view.confirmation()!).getByRole("button", { name: copy.removeCancel }));
    expect(view.confirmation()).toBeNull();
    expect(view.attempts).toEqual([]);
    expect(view.remove(), "the row is still there and still removable").toBeTruthy();
  });
});

describe("the confirmation states the consequences, and each one is true of the server", () => {
  it("names all five, in the person's own language", async () => {
    const item = mailbox();
    const view = await mount([item]);
    await view.ask();
    const said = view.confirmation()!.textContent ?? "";
    for (const key of [
      "removeStops", "removeMailSafe", "removeCredential", "removeScheduled", "removeCopyStays",
    ] as const) {
      expect(said, `the confirmation does not say ${key}`).toContain(copy[key]);
    }
    expect(said).toContain(item.address);
  });

  /**
   * THE LOAD-BEARING PROMISE. `MailboxService.delete` opens no IMAP connection at all, so no
   * folder and no message on the user's own server is reachable from this press. The guard reads
   * the service rather than trusting the sentence.
   */
  it("`removeMailSafe` is true: the service touches no mail on the server", () => {
    const src = readFileSync(SERVICE, "utf8");
    const method = removalMethod(src);
    expect(method, "the removal must not open a mail connection").not.toMatch(/probe|ImapAdapter|imapProbe/);
    expect(copy.removeMailSafe, "the promise must name where the mail stays")
      .toMatch(/mail server/);
  });

  /**
   * THE UNFLATTERING ONE, AND THE REASON IT IS WORDED THE WAY IT IS. A removal that keeps the copy
   * deletes credentials and nothing else, so the synced copy survives; only the erase arm stamps.
   */
  it("`removeCopyStays` is true: the service deletes credentials and not messages", () => {
    const src = readFileSync(SERVICE, "utf8");
    const method = removalMethod(src);
    expect(method).toContain("tx.delete(mailboxCredentials)");
    expect(method, "a removal that purged the mirror would make the confirmation's copy false")
      .not.toContain("tx.delete(messages)");
    // THE PER-MAILBOX ERASE EXISTS, and this sentence stays true of the removal that KEEPS the
    // copy because the caller has to ask for the other one: the statement before the erasure's
    // stamp is the early return that sends every ordinary removal home. Read as the LINE BEFORE
    // rather than as "a gate appears somewhere" — the method carries two other `opts.erase`
    // branches, either of which would satisfy that and say nothing about the stamp. The client's
    // keep path sends no erase; the erase is its own call (`mailbox-erase-press.test.tsx`).
    const lines = method.split("\n");
    const sweepAt = lines.findIndex((l) => l.includes("stampMailboxErasure("));
    expect(sweepAt, "the erasure's stamp is gone — this guard reads it").toBeGreaterThan(0);
    let before = sweepAt - 1;
    while (before > 0 && /^\s*(\/[/*]|\*|$)/.test(lines[before]!)) before -= 1;
    expect(lines[before], "every ordinary removal must return before the sweep")
      .toMatch(/^\s*if \(!opts\.erase\) return\b/);
    const client = readFileSync("apps/webapp/app/api-client.ts", "utf8");
    const removeLine = client.split("\n").find((l) => /^\s*remove: \(id: string\) =>/.test(l));
    expect(removeLine, "the keep path's call is gone — this guard reads it").toBeTruthy();
    expect(removeLine, "the removal that keeps the copy sends an erase").not.toMatch(/erase/);
    expect(copy.removeCopyStays).toMatch(/stays in your account/);
  });

  /** The consequence with no other surface — a queued send that will not happen. */
  it("`removeScheduled` is true: the removal closes the appointments it orphans", () => {
    const src = readFileSync(SERVICE, "utf8");
    expect(src).toContain("closeRemovedMailboxAppointments");
    expect(copy.removeScheduled).toMatch(/Drafts/);
  });

  it("the confirmation never says the mail is deleted", async () => {
    const view = await mount();
    await view.ask();
    const said = (view.confirmation()!.textContent ?? "").toLowerCase();
    expect(said).not.toMatch(/deletes your mail|your mail is deleted|removes your messages/);
  });
});

describe("the removal itself is behind the account's second factor", () => {
  it("on a closed window the confirm opens the step-up, and the DELETE lands only after the factor", async () => {
    const target = mailbox("mb-target");
    const view = await mount([target], { closed: true });
    await view.ask();
    await view.confirm();

    const prompt = screen.getByRole("dialog", { name: factorTitle(messages) });
    const code = within(prompt).getByRole("textbox", { name: messages.stepUp.codeLabel });
    expect(prompt.querySelector('input[type="password"]'), "the confirm asked for a password").toBeNull();
    expect(view.attempts).toEqual([target.id]);
    expect(view.removeCalls).toEqual([]);
    expect(view.factorCalls).toEqual([]);

    await act(async () => { fireEvent.change(code, { target: { value: "123456" } }); });
    await click(within(prompt).getByRole("button", { name: messages.stepUp.verify }));
    expect(view.factorCalls).toEqual(["POST"]);
    expect(view.attempts).toEqual([target.id, target.id]);
    expect(view.removeCalls, "the removal did not reach the server").toEqual([target.id]);
  });

  it("the prompt says it is authorising a REMOVAL, not a save", async () => {
    const view = await mount([mailbox()], { closed: true });
    await view.ask();
    await view.confirm();
    const said = screen.getByRole("dialog", { name: factorTitle(messages) }).textContent ?? "";
    expect(said, "the prompt describes the wrong act").toContain(copy.factorBodyRemove);
    expect(said).not.toContain(copy.factorBodyEdit);
  });

  it("a refused removal returns to the confirmation with the server's sentence", async () => {
    const view = await mount([mailbox("mb-refused")]);
    await view.ask();
    await view.confirm();
    expect(view.confirmation(), "the refusal left the confirmation").toBeTruthy();
    expect(view.confirmation()!.textContent).toContain(refused);
  });

  it("a completed removal re-reads the list and the rail's strip", async () => {
    const target = mailbox("mb-target");
    const view = await mount([target, mailbox("mb-other")]);
    await view.ask(target);
    const before = view.reads();
    await view.confirm(target);
    expect(view.removeCalls).toEqual([target.id]);
    expect(view.reads() - before, "the list and the strip would stay a poll behind").toBeGreaterThanOrEqual(2);
    expect(view.row(target)).toBeNull();
  });

  it("a completed removal drains the window's mirror once, and a refused one does not", async () => {
    const target = mailbox("mb-target");
    const other = mailbox("mb-refused");
    const view = await mount([target, other]);
    await view.ask(target);
    const before = syncCalls();
    await view.confirm(target);
    expect(view.removeCalls).toEqual([target.id]);
    expect(syncCalls() - before, "the closed appointments wait for the next poll").toBe(1);

    await view.ask(other);
    const beforeRefusal = syncCalls();
    await view.confirm(other);
    expect(view.removeCalls).toEqual([target.id, other.id]);
    expect(syncCalls() - beforeRefusal, "a refused removal changed nothing to drain").toBe(0);
  });
});

describe("the copy exists in both catalogues", () => {
  it("every removal key the pane reads is translated", () => {
    const keys = [
      "remove", "removeTitle", "removeStops", "removeMailSafe", "removeCredential",
      "removeScheduled", "removeCopyStays", "removeReconnect", "removeConfirm",
      "removeCancel", "removeWorking", "factorBodyRemove",
    ] as const;
    for (const k of keys) {
      expect(copy[k], `en is missing mailboxes.${k}`).toBeTruthy();
      expect(copyDe[k], `de is missing mailboxes.${k}`).toBeTruthy();
      expect(copyDe[k], `de.${k} was left in English`).not.toBe(copy[k]);
    }
    // The title interpolates the address in both, or one locale confirms an unnamed mailbox.
    expect(copy.removeTitle).toContain("{address}");
    expect(copyDe.removeTitle).toContain("{address}");
  });

  it("the German removal speaks to the reader as du, from the confirmation to the factor screen", async () => {
    const view = await mount([mailbox()], { closed: true, locale: "de" });
    await view.ask();
    const sheet = view.confirmation()!;
    expect(sheet.textContent).toContain(copyDe.removeMailSafe);
    expect(formalAddress(sheet), "the confirmation says Sie").toEqual([]);
    await click(within(sheet).getByRole("button", { name: copyDe.removeConfirm }));
    expect(screen.getByRole("textbox", { name: de.stepUp.codeLabel })).toBeTruthy();
    expect(screen.getByText(copyDe.factorBodyRemove)).toBeTruthy();
    expect(formalAddress(screen.getByRole("dialog", { name: factorTitle(de) })), "the factor screen says Sie")
      .toEqual([]);
  });

  it("the German confirmation makes the same untouched-mail promise", () => {
    // The promise is the reason a person can press the button. A locale that dropped it would be
    // a different product in German.
    expect(copyDe.removeMailSafe).toMatch(/Mailserver/);
    expect(copyDe.removeCopyStays).toMatch(/Account/);
  });
});
