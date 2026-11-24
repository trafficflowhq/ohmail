/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarAct } from "@ohmail/app-logic/calendar";
import type { ReaderReply } from "../../src/reader/ports.js";
import { calendar } from "../../src/calendar/entry.js";
import {
  calendarRecord,
  connectionRecord,
  mirror,
  UPDATED,
  WORDS as CALENDAR_WORDS,
} from "../calsetup/world.js";
import calmailEn from "../../messages/calmail.en.json" with { type: "json" };
import calmailDe from "../../messages/calmail.de.json" with { type: "json" };
import { fakeMail, letter, mountReader, WORDS } from "./support/mail.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as Animation;
});
afterEach(cleanup);

function mailbox(
  access = calendarRecord().access,
  protectedLetter = false,
  lang: "en" | "de" = "en",
  reply?: ReaderReply,
) {
  const world = mirror({
    enabledAt: UPDATED,
    secondZone: null,
    weekNumbers: false,
    dayFromMinute: null,
    dayToMinute: null,
    newEventsCalendarId: "cal-1",
  });
  const record = calendarRecord({ access });
  const connection = connectionRecord();
  world.put("calendar_connection", connection.id, connection);
  world.put("calendar", record.id, record);
  const press = vi.fn(async (_act: CalendarAct) => ({ key: "create" }));
  world.port.press = press;
  const message = letter("m1", {
    unread: false,
    subject: "Visit on Thursday",
    cc: [{ name: "June Potter", address: "june@example.invalid" }],
  });
  if (protectedLetter) message.sensitivity.sensitive = true;
  const mail = fakeMail([message]);
  const mounted = mountReader({
    letters: [message],
    open: message.id,
    lang,
    parts: reply ? { reply } : undefined,
    words: { ...CALENDAR_WORDS[lang], ...WORDS[lang], ...(lang === "de" ? calmailDe : calmailEn) },
    host: {
      engine: {
        ...mail.engine,
        store: {
          ...world.engine.store,
          get: (kind: string, id: string) =>
            kind === "calendar" && id === record.id
              ? record
              : kind === "calendar_connection" && id === connection.id
                ? connection
                : undefined,
        },
      } as typeof mail.engine,
      products: "both",
      calendar,
      wires: { calendar: world.port },
    },
  });
  return { ...mounted, message, press };
}

it("v opens the letter's draft without writing and stays out of text fields", async () => {
  const { address, press, message } = mailbox();
  const field = document.createElement("input");
  document.body.append(field);
  fireEvent.keyDown(field, { key: "v" });
  field.remove();
  expect(address.read()).toBe("#/ohbox/m/m1");
  fireEvent.keyDown(document.body, { key: "v" });
  expect(address.read()).toBe("#/cal/week?panel=new");
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  expect((form.getByRole("textbox", { name: "New event" }) as HTMLInputElement).value).toBe(message.subject);
  expect(form.getByRole("button", { name: "Invite Ben Kiln" })).toBeTruthy();
  expect(form.getByRole("button", { name: "Invite June Potter" })).toBeTruthy();
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press.mock.calls[0]?.[0]).toMatchObject({ event: { title: message.subject } });
  expect(press.mock.calls[0]?.[0]).toHaveProperty("event.invitees", []);
});

it("puts Add to calendar last after a divider, and sends only accepted guests after confirmation", async () => {
  const { press, message } = mailbox();
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  const menu = screen.getByRole("menu", { name: "More" });
  const items = within(menu).getAllByRole("menuitem");
  const add = within(menu).getByRole("menuitem", { name: "Add to calendar" });
  expect(items.at(-1)).toBe(add);
  expect(add.previousElementSibling?.tagName).toBe("HR");
  expect(add.querySelector("kbd")?.textContent).toBe("v");
  fireEvent.click(add);
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  fireEvent.click(form.getByRole("button", { name: "Invite June Potter" }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  const ask = within(screen.getByRole("dialog", { name: "Send an invitation to June Potter?" }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(ask.getByRole("button", { name: "Send invitation" }));
  expect(press).toHaveBeenCalledTimes(1);
  expect(press.mock.calls[0]?.[0]).toMatchObject({
    event: { title: message.subject, invitees: [{ name: "June Potter", role: "required" }] },
  });
});

it("confirms accepted letter guests and manually added guests together", async () => {
  const { press } = mailbox();
  fireEvent.keyDown(document.body, { key: "v" });
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  fireEvent.click(form.getByRole("button", { name: "Invite Ben Kiln" }));
  fireEvent.click(form.getByRole("button", { name: "Invite June Potter" }));
  fireEvent.click(form.getByRole("button", { name: "Invitees" }));
  const picker = within(screen.getByRole("dialog", { name: "Add invitees" }));
  fireEvent.change(picker.getByRole("textbox", { name: "Name or address" }), {
    target: { value: ["Mara <mara", "example.test>"].join("@") },
  });
  fireEvent.click(picker.getByRole("menuitem", { name: /^Mara\s/ }));
  fireEvent.click(form.getByRole("button", { name: /^Mara/ }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Optional", checked: false }));
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).not.toHaveBeenCalled();
  const ask = within(screen.getByRole("dialog", { name: /Mara.*Ben Kiln.*June Potter/ }));
  fireEvent.click(ask.getByRole("button", { name: "Send invitations" }));
  expect(press).toHaveBeenCalledTimes(1);
  expect(press.mock.calls[0]?.[0]).toMatchObject({
    event: {
      invitees: [
        { name: "Mara", role: "optional" },
        { name: "Ben Kiln", role: "required" },
        { name: "June Potter", role: "required" },
      ],
    },
  });
});

it("uses the German label in the letter menu", () => {
  mailbox(undefined, false, "de");
  fireEvent.click(screen.getByRole("button", { name: "Mehr" }));
  expect(screen.getByRole("menuitem", { name: "Zum Kalender hinzufügen" })).toBeTruthy();
});

it.each([
  ["reader", false],
  ["owner", true],
] as const)(
  "offers neither entry point for a read-only calendar or protected letter (%s, %s)",
  (access, protectedLetter) => {
    const { address, press } = mailbox(access, protectedLetter);
    fireEvent.keyDown(document.body, { key: "v" });
    expect(address.read()).toBe("#/ohbox/m/m1");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: /calendar|new event/i })).toBeNull();
    expect(press).not.toHaveBeenCalled();
  },
);

it("does not open the calendar over a reply", () => {
  const reply: ReaderReply = {
    Sheet: () => <section aria-label="Editing a reply" />,
    useOpen: () => () => undefined,
    useVerbs: () => [{ id: "send", label: "Send", icon: "send" }],
  };
  const { address, press } = mailbox(undefined, false, "en", reply);
  expect(screen.getByRole("region", { name: "Editing a reply" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "v" });
  expect(address.read()).toBe("#/ohbox/m/m1");
  expect(screen.queryByRole("menuitem", { name: "Add to calendar" })).toBeNull();
  expect(press).not.toHaveBeenCalled();
});
