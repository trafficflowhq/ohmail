/** @vitest-environment jsdom */
/**
 * AN INVITATION THAT CAME AS AN OUTLOOK WEB APP LINK SHOWS ITS CARD once its event is known: the
 * account's Microsoft calendar looked the link's event up and the letter carries its invitation.
 * The card stands where the note would, and the letter's own text stays as it came.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, expect, it } from "vitest";
import en from "../messages/en.json";
import { mountInvitationLetter } from "./fixtures/reader-invitation";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const BASE = "https://outlook.office365.com/owa/tenant.example/";
const STUB = [
  "Microsoft Outlook Web Access:",
  `${BASE}?itemid=AAMkADJh%2FTaHJ8AAV95f1jAAA%3D&exvsurl=1&path=/calendar/item`,
  "",
  "To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to",
  `${BASE}?path=/options/popandimap and select Send meeting invitations in iCalendar format.`,
].join("\n");

const looked = {
  method: "REQUEST", uid: "040000008200E00074C5B7101A82E008@tenant.example", recurrenceId: "", sequence: 0,
  start: "20261203T100000", startsAt: "2026-12-03T09:00:00.000Z", organizer: "colleague@example.invalid",
  invitedAddress: "me@x.invalid", answer: null, answeredAt: null,
};

const letter = (extra: Partial<EngineMessage> = {}): EngineMessage => ({
  id: "owa", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: "Think tank",
  from: { name: "A Colleague", address: "colleague@example.invalid" }, to: [{ name: "Me", address: "me@x.invalid" }], cc: [],
  date: "2026-10-19T08:29:52.000Z", folder: "INBOX", snippet: "Microsoft Outlook Web Access:", unread: false,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-19T08:30:10.000Z",
  ...extra,
}) as unknown as EngineMessage;

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

it("shows the invitation's card with its answers instead of the note", () => {
  const reader = mountInvitationLetter(letter({ invitation: looked } as Partial<EngineMessage>), { text: STUB });
  unmount = reader.unmount;
  const el = reader.element;
  expect(el.textContent).not.toContain(en.body.invitationOwaLink);
  expect(el.querySelectorAll("[role=note]")).toHaveLength(0);
  const card = el.querySelector(".oh-invcard");
  expect(card?.querySelector("h3")?.textContent).toBe("Think tank");
  expect(card?.querySelectorAll(".oh-invcard-answers button")).toHaveLength(3);
  expect(el.querySelector("[data-read-body]")?.textContent).toContain("Microsoft Outlook Web Access:");
});

it("without its event the same letter keeps the note", () => {
  const reader = mountInvitationLetter(letter(), { text: STUB });
  unmount = reader.unmount;
  expect(reader.element.textContent).toContain(en.body.invitationOwaLink);
  expect(reader.element.querySelector(".oh-invcard")).toBeNull();
});
