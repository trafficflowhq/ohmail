/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { EngineMutation } from "@ohmail/wire";
import type { MutationResult } from "@ohmail/client-engine";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import tagWords from "../../messages/tags.en.json" with { type: "json" };
import newsWords from "../../messages/news.en.json" with { type: "json" };
import { MailGround, mailPlaces } from "../../src/mail/index.js";
import { issue, mountStreamFrame } from "../streams/registered-world.js";
import { fakeMail, letter, mountReader, WORDS } from "./support/mail.js";

const letterId = "m1";
const messages = [letter(letterId)];
const tags = { "tag:studio": { id: "studio", name: "Studio", hue: "moss" } };
const assignment = { kind: "tag_assign", messageId: letterId, tagId: "studio", assigned: true };
const ack: MutationResult = { id: "tag-press", key: "tag-press", status: "confirmed", seq: null };

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

function mountTag() {
  const first = fakeMail(messages, [], {}, tags);
  const replacement = fakeMail(messages, [], {}, tags);
  const reader = mountReader({
    letters: messages,
    open: letterId,
    rows: tags,
    words: { ...WORDS.en, ...tagWords },
    host: { engine: first.engine },
  });
  const no = vi.spyOn(replacement.engine, "mutate");
  return { first, replace: () => reader.replaceEngine(replacement.engine), replacementWrites: no };
}

function tag() {
  const bar = within(screen.getByRole("toolbar", { name: "Actions" }));
  fireEvent.click(bar.getByRole("button", { name: "Tag" }));
  fireEvent.click(
    within(screen.getByRole("menu", { name: "Tag" })).getByRole("menuitemcheckbox", { name: "Studio" }),
  );
}

const report = () =>
  document.querySelector('.fr-report [role="status"]:not([data-leaving]) .oh-report-said')?.textContent ?? "";

it("filters the reader's tags, applies with the keyboard and removes with the pointer", async () => {
  const { mail } = mountReader({
    letters: [letter(letterId, { labels: ["studio"] })],
    open: letterId,
    rows: { ...tags, "tag:kiln": { id: "kiln", name: "Kiln", hue: "rosewood" } },
    host: { places: mailPlaces(), above: MailGround },
    words: { ...WORDS.en, ...tagWords },
  });
  const bar = within(screen.getByRole("toolbar", { name: "Actions" }));
  const button = bar.getByRole("button", { name: "Tag" });
  fireEvent.click(button);
  const menu = within(screen.getByRole("menu", { name: "Tag" }));
  expect(menu.getByRole("heading", { name: "Tag" })).toBeTruthy();
  const field = menu.getByRole("textbox", { name: "Tag this message…" });
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "ArrowUp" });
  expect(document.activeElement).toBe(menu.getByRole("menuitemcheckbox", { name: "Kiln" }));
  field.focus();
  fireEvent.change(field, { target: { value: "kIl" } });
  expect(menu.queryByRole("menuitemcheckbox", { name: "Studio" })).toBeNull();
  const kiln = menu.getByRole("menuitemcheckbox", { name: "Kiln", checked: false });
  fireEvent.keyDown(field, { key: "ArrowDown" });
  expect(document.activeElement).toBe(kiln);
  field.focus();
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  expect(mail.mutations).toEqual([{ ...assignment, tagId: "kiln" }]);
  fireEvent.change(field, { target: { value: "studio" } });
  await act(async () => menu.getByRole("menuitemcheckbox", { name: "Studio", checked: true }).click());
  expect(mail.mutations.at(-1)).toEqual({ ...assignment, assigned: false });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Tag" })).toBeNull();
  expect(document.activeElement).toBe(button);
  fireEvent.keyDown(button, { key: "t" });
  expect(screen.getByRole("textbox", { name: "Tag this message…" })).toBe(document.activeElement);
});

it("creates the first tag from the reader's More menu with the existing assignment", async () => {
  const { mail } = mountReader({
    letters: messages,
    open: letterId,
    size: "phone",
    words: { ...WORDS.en, ...tagWords },
  });
  const bar = within(screen.getByRole("toolbar", { name: "Actions" }));
  fireEvent.click(bar.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Tag" }));
  const field = screen.getByRole("textbox", { name: "Tag this message…" });
  fireEvent.change(field, { target: { value: "  Travel  " } });
  expect(screen.getByRole("menuitem", { name: "Create “Travel”" })).toBeTruthy();
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  expect(mail.mutations).toEqual([{ ...assignment, tagId: expect.any(String), createName: "Travel" }]);
  expect(screen.queryByRole("menu", { name: "Tag" })).toBeNull();
});

it.each(["organizer", "reader"] as const)(
  "a stream card's More offers the %s mailbox's tag actions",
  async (organizerRole) => {
    const opened = issue("issue", 12);
    const { mail } = mountStreamFrame({
      at: "#/reads/m/issue",
      phone: true,
      letters: [opened, issue("other", 11)],
      mailboxes: async () => [
        { id: opened.mailboxId, address: opened.from.address, organizerRole, status: "connected" },
      ],
      rows: tags,
      catalogue: { ...WORDS.en, ...newsWords, ...tagWords },
    });
    const bar = within(await screen.findByRole("toolbar", { name: "Actions" }));
    fireEvent.click(bar.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Tag" }));
    const menu = within(screen.getByRole("menu", { name: "Tag" }));
    const field = menu.getByRole("textbox", { name: "Tag this message…" });
    fireEvent.change(field, { target: { value: "Travel" } });
    await waitFor(() =>
      expect(menu.queryByRole("menuitem", { name: "Create “Travel”" }) !== null).toBe(
        organizerRole === "organizer",
      ),
    );
    fireEvent.change(field, { target: { value: "stu" } });
    await act(async () => menu.getByRole("menuitemcheckbox", { name: "Studio", checked: false }).click());
    expect(mail.mutations.filter(({ kind }) => kind === "tag_assign")).toEqual([
      { ...assignment, messageId: "issue" },
    ]);
  },
);

it("a late tag acknowledgement from a replaced engine does not report on the active Reader", async () => {
  const { first, replace, replacementWrites } = mountTag();
  let finish!: (result: MutationResult) => void;
  const mutate = vi.spyOn(first.engine, "mutate").mockImplementation(
    () =>
      new Promise<MutationResult>((resolve) => {
        finish = resolve;
      }),
  );
  tag();
  expect(mutate.mock.calls.map(([m]) => m)).toEqual([assignment]);
  replace();
  await act(async () => finish(ack));
  expect(report()).not.toContain("Studio");
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(replacementWrites).not.toHaveBeenCalled();
});

it("an acknowledged tag's Undo cannot write through the replacement engine", async () => {
  const { first, replace, replacementWrites } = mountTag();
  const writes: EngineMutation[] = [];
  vi.spyOn(first.engine, "mutate").mockImplementation(async (m) => {
    writes.push(m);
    return ack;
  });
  tag();
  await act(async () => {});
  expect(report().trim()).toBe("Studio");
  const oldUndo = screen.getByRole("button", { name: "Undo" });
  replace();
  fireEvent.click(oldUndo);
  fireEvent.keyDown(document.body, { key: "z" });
  await act(async () => {});
  expect(replacementWrites).not.toHaveBeenCalled();
  expect(writes).toEqual([assignment]);
});

it("keeps z for a later Park press when the earlier Tag acknowledges first", async () => {
  const { first } = mountTag();
  const park = { kind: "triage_set", messageId: letterId, state: "set_aside" };
  const unpark = { kind: "triage_set", messageId: letterId, state: "none" };
  let finishTag!: (result: MutationResult) => void;
  let finishPark!: (result: MutationResult) => void;
  const mutate = vi.spyOn(first.engine, "mutate");
  mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishTag = resolve;
      }),
  );
  mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPark = resolve;
      }),
  );
  const writes = () => mutate.mock.calls.map(([mutation]) => mutation);

  tag();
  fireEvent.click(
    within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Park" }),
  );
  expect(writes()).toEqual([assignment, park]);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

  await act(async () => finishTag(ack));
  expect(report().trim()).toBe("Studio");
  await act(async () => fireEvent.keyDown(document.body, { key: "z" }));
  expect(writes()).toEqual([assignment, park]);

  await act(async () => finishPark({ ...ack, id: "park-press", key: "park-press" }));
  expect(writes()).toEqual([assignment, park, unpark]);
});
