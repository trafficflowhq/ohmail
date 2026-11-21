/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { EngineMutation } from "@ohmail/wire";
import type { MutationResult } from "@ohmail/client-engine";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import tagWords from "../../messages/tags.en.json" with { type: "json" };
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
    within(screen.getByRole("menu", { name: "Tag" })).getByRole("menuitemradio", { name: "Studio" }),
  );
}

const report = () =>
  document.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent ?? "";

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
  expect(report()).not.toContain("Tagged “Studio”.");
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
  expect(report()).toContain("Tagged “Studio”.");
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
  expect(report()).toContain("Tagged “Studio”.");
  await act(async () => fireEvent.keyDown(document.body, { key: "z" }));
  expect(writes()).toEqual([assignment, park]);

  await act(async () => finishPark({ ...ack, id: "park-press", key: "park-press" }));
  expect(writes()).toEqual([assignment, park, unpark]);
});
