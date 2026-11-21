/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web";

const MAILBOX = "mb";
const SENDER = "heron@rig.invalid";
const PROMISES = ["files there too", "applies the rule", "This moves the mail that is here"];

const letter = (id: string, subject: string): EngineMessage => ({
  id, accountId: ACCOUNT, mailboxId: MAILBOX, threadId: null, messageIdHeader: null,
  subject, from: { name: "Heron", address: SENDER }, to: [], cc: [], date: ISO,
  folder: "INBOX", snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
});

beforeAll(warmScreeningWeb, 60_000);
afterEach(teardownScreeningWeb);

async function senderSheet(
  handedBack: boolean,
  letters: readonly EngineMessage[],
  locale: "en" | "de" = "en",
): Promise<HTMLElement> {
  installScreeningWeb("#/ohbox/m/m1", (path, query, method) => {
    if (method === "GET" && path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: MAILBOX, address: "me@family.example", status: "connected",
        createdAt: ISO, lastSyncAt: ISO, initialImportCompletedAt: ISO,
        organizerRole: handedBack ? "reader" : "organizer",
        organizerState: null, organizedBy: null,
        organizerReleasedAt: handedBack ? ISO : null,
        organizerChecked: true, organizeConsentedAt: ISO,
      }] });
    }
    if (method === "GET" && path === "/api/sync" && query.get("types") !== "rule") {
      return syncScreeningWeb(letters.map((message, index) => ({
        type: "message", op: "create", seq: index + 1, id: message.id,
        updatedAt: ISO, entity: message,
      })), letters.length);
    }
    return undefined;
  });
  const shell = within(await mountScreeningWeb(locale));
  await tick(4000);
  const t = (locale === "en" ? en : de).screening;
  await click(shell.getByRole("button", { name: /^Heron / }));
  return within(document.body).getByRole("dialog", { name: t.aria.replace("{sender}", SENDER) });
}

const click = (control: HTMLElement) => act(() => { fireEvent.click(control); });

describe("the sender sheet over a mailbox nothing organizes", () => {
  const letters = [letter("m1", "Hello")];

  it("a hand-back says nothing organizes it in place of the filing promise, en and de", async () => {
    const english = await senderSheet(true, letters);
    expect(english.querySelector(".sm-org")?.textContent).toBe(en.screening.orgNobody);
    expect(within(english).getByRole("radio", { name: en.place.ohbox }).getAttribute("aria-description"),
      "the destination promised filing nothing performs").toBeNull();
    for (const promise of PROMISES) expect(english.textContent).not.toContain(promise);

    await teardownScreeningWeb();
    const german = await senderSheet(true, letters, "de");
    expect(german.querySelector(".sm-org")?.textContent).toBe(de.screening.orgNobody);
  });

  it("CONTROL: where this install organizes it the foot says what a press files", async () => {
    const sheet = await senderSheet(false, letters);
    expect(sheet.querySelector(".sm-org")).toBeNull();
    expect(within(sheet).getByRole("radio", { name: en.place.ohbox }).getAttribute("aria-description") ?? "").not.toBe("");
  });
});

describe("the subject-rule sheet over a mailbox nothing organizes", () => {
  async function subjectSheet(handedBack: boolean): Promise<HTMLElement> {
    const sender = await senderSheet(handedBack, [letter("m1", "Invoice 12"), letter("m2", "Invoice 13")]);
    await click(within(sender).getByRole("menuitem", { name: en.screening.cardSubject }));
    return within(document.body).getByRole("dialog", {
      name: en.screening.subjectAria.replace("{who}", SENDER),
    });
  }

  const choose = (sheet: HTMLElement) => click(within(sheet).getByRole("option", { name: /^Ohbox(?:\s|$)/ }));

  it("says so beside the destinations and in the confirm, never what the rule would file", async () => {
    const sheet = await subjectSheet(true);
    expect(sheet.querySelector(".sm-org")?.textContent).toBe(en.screening.subjectOrgNobody);
    await choose(sheet);
    const confirm = sheet.querySelector(".sm-confirm")!;
    expect(confirm.textContent).toContain(en.screening.subjectOrgNobody);
    expect(confirm.textContent, "the confirm promised filing nothing performs").not.toContain("applies the rule");
  });

  it("CONTROL: an organized mailbox keeps the confirm's own sentence", async () => {
    const sheet = await subjectSheet(false);
    expect(sheet.querySelector(".sm-org")).toBeNull();
    await choose(sheet);
    expect(sheet.querySelector(".sm-confirm")!.textContent).not.toContain(en.screening.subjectOrgNobody);
  });
});
