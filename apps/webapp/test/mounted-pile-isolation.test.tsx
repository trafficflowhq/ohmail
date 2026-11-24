/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailPlaces } from "@ohmail/app/mail";
import frameWords from "../../../packages/app/messages/frame.en.json";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";

const letters = [
  message("n1", { folder: "ohmail/News" }),
  message("r1", { folder: "ohmail/Receipts" }),
];
const stream = (place: string) => screen.queryByRole("region", { name: `${place} stream` });
const failure = () => screen.queryByRole("region", { name: frameWords.viewError.title });
const visit = (hash: string) => act(async () => {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
});

beforeEach(() => {
  localStorage.clear();
  stubDom();
});
afterEach(async () => {
  cleanup();
  await unmountAll();
  vi.useRealTimers();
});

function receiptsFailure(broken: () => boolean) {
  const places = mailPlaces();
  const entry = places.receipts;
  if (entry?.panes.kind !== "columns") throw new Error("Receipts must register columns");
  const List = entry.panes.List;
  function ReceiptsList(props: ComponentProps<typeof List>) {
    if (broken()) throw new Error("Receipts failed to draw");
    return <List {...props} />;
  }
  return { ...places, receipts: { ...entry, panes: { ...entry.panes, List: ReceiptsList } } };
}

describe("the frame isolates stream visits", () => {
  it("a pile never visited has no reading pane", async () => {
    await mountShell("#/reads", letters);
    expect(stream("News")).not.toBeNull();
    expect(stream("Receipts")).toBeNull();
    await visit("#/receipts");
    expect(stream("Receipts")).not.toBeNull();
    expect(stream("News")).toBeNull();
  });

  it("a failing inactive Receipts does not take down News and can mount fresh", async () => {
    let broken = false;
    await mountShell("#/receipts", letters, [], { places: receiptsFailure(() => broken) });
    expect(stream("Receipts")).not.toBeNull();
    await visit("#/reads");
    broken = true;
    await act(async () => {});
    expect(within(stream("News")!).getByText("Subject n1")).toBeTruthy();
    expect(failure()).toBeNull();

    await visit("#/receipts");
    expect(failure()).not.toBeNull();
    await visit("#/reads");
    broken = false;
    await visit("#/receipts");
    expect(screen.getByRole("region", { name: "Receipts" })).toBeTruthy();
    expect(failure()).toBeNull();
  });

  it("a pile that fails while visible recovers after leaving and returning", async () => {
    let broken = true;
    await mountShell("#/receipts", letters, [], { places: receiptsFailure(() => broken) });
    expect(failure()).not.toBeNull();
    await visit("#/reads");
    expect(failure()).toBeNull();
    expect(stream("News")).not.toBeNull();
    broken = false;
    await visit("#/receipts");
    expect(screen.getByRole("region", { name: "Receipts" })).toBeTruthy();
    expect(failure()).toBeNull();
  });
});

it("d twice confirms Delete for the visible receipt after visiting News", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { address, mail } = mountStreamFrame({
    at: "#/reads/m/n1", withReply: true, letters: [issue("n1", 20), receipt("r1", 19)],
  });
  expect(stream("News")).not.toBeNull();
  await act(async () => { await address.visit("#/receipts/m/r1"); });
  expect(stream("News")).toBeNull();
  const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
  const reply = actions.getByRole("button", { name: "Reply" });
  act(() => reply.focus());
  fireEvent.keyDown(reply, { key: "d" });
  const confirm = screen.getByRole("menuitem", { name: "Delete" });
  expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
  fireEvent.keyDown(confirm, { key: "d" });
  expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(mail.mutations.flatMap((m) => m.kind === "message_delete" ? [m.messageId] : [])).toEqual(["r1"]);
});
