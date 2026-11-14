/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDraft } from "@ohmail/wire";
import { useDraftsList, type DraftsDoor } from "@ohmail/app-logic/drafts";
import { DraftsAbove } from "../../../packages/app/src/drafts/DraftsAbove.js";
import { DraftsList } from "../../../packages/app/src/drafts/DraftsList.js";
import { DraftsReading } from "../../../packages/app/src/drafts/DraftsReading.js";
import { useDiscardWords } from "../../../packages/app/src/drafts/words.js";
import { inWords, pane, stamp } from "../../../packages/app/test/places/lists-world.js";
import messages from "../../../packages/app/messages/drafts.en.json";

const NOW = new Date("2026-09-16T09:00:00.000Z");

const draft = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: "d1",
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: "Invoice for the paper order",
  body: "The only copy of this text lives in this row.",
  to: [{ name: null, address: "sam@customer.example" }],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-09-15T09:00:00.000Z",
  updatedAt: "2026-09-15T14:02:00.000Z",
  ...over,
});


function Drafts({ drafts, overrides }: { drafts: EngineDraft[]; overrides: Partial<DraftsDoor> }) {
  const [open, setOpen] = useState<string | null>(null);
  const model = useDraftsList({
    drafts, scheduled: [], settled: true, owed: false, now: NOW, stamp, appointment: stamp,
    words: useDiscardWords(),
    report: () => {},
    door: {
      open: (draft) => setOpen(draft.id),
      decide: () => ({ kind: "go" }),
      withdrawWaiting: async () => "none",
      discard: async () => ({ kind: "applied" }),
      cancelSchedule: () => {},
      editScheduled: () => {},
      resolve: () => {},
      sendAgain: () => {},
      repliesHere: () => false,
      heldHere: new Set(),
      waiting: new Set(),
      notSent: new Map(),
      ...overrides,
    },
  });
  const props = pane("drafts", { open });
  return (
    <DraftsAbove model={model}>
      <DraftsList {...props} />
      <DraftsReading {...props} />
    </DraftsAbove>
  );
}

function mountDrafts(drafts: EngineDraft[], overrides: Partial<DraftsDoor> = {}) {
  render(inWords(<Drafts drafts={drafts} overrides={overrides} />));
}

const words = messages.drafts;
const list = () => within(screen.getByRole("listbox", { name: words.title }));
const row = (name = /Invoice for the paper order/) => list().getByRole("option", { name });
const heldActions = () => screen.getByRole("toolbar", { name: words.heldActs });
const answerNames = () => within(heldActions()).getAllByRole("button").slice(0, 2).map((b) => b.textContent);
const answers = [words.sendAgain, words.heldItWasSent];
const stateOf = (item = row()) => item.getAttribute("aria-description");

afterEach(cleanup);

describe("a refused discard says why, in its own row", () => {
  it("renders the sentence in the refused row and focuses it, not the other held one", async () => {
    mountDrafts(
      [draft({ id: "u1", status: "unverified" }), draft({ id: "u2", status: "unverified", subject: "Other" })],
      { decide: (id) => id === "u2" ? { kind: "refuse", why: "still-sending" } : { kind: "go" } },
    );
    const refusedRow = row(/Other/);
    const firstRow = row();
    const discard = within(refusedRow.parentElement!).getByRole("button", { name: words.discard });
    discard.focus();
    await act(async () => { fireEvent.click(discard); });
    const line = list().getByRole("alert");
    expect(line.textContent).toBe(words.discardStillSending);
    expect(line.parentElement?.contains(refusedRow)).toBe(true);
    expect(line.parentElement?.contains(firstRow)).toBe(false);
    expect(document.activeElement).toBe(line);
  });

  it("names the other refusal too — a jar this browser cannot read", async () => {
    mountDrafts([draft()], { decide: () => ({ kind: "refuse", why: "unknown-jar" }) });
    await act(async () => { fireEvent.click(list().getByRole("button", { name: words.discard })); });
    expect(list().getByRole("alert").textContent).toBe(words.discardUnknownJar);
  });
});

describe("what a held row says, and the two acts it offers", () => {
  it("offers the two acts for a row held by a durable RECORD, whatever the mirror says", () => {
    const recent = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    mountDrafts([draft({ updatedAt: recent }), draft({ id: "d2", subject: "Other" })], { heldHere: new Set(["d1"]) });
    fireEvent.click(row(/Other/));
    expect(screen.queryByRole("toolbar", { name: words.heldActs })).toBeNull();
    fireEvent.click(row());
    expect(answerNames()).toEqual(answers);
    expect(within(heldActions()).getByText(words.heldChecking)).toBeTruthy();
  });

  it("says the Sent folder is being checked while the engine still looks, and that the message is not there once it has stopped", () => {
    const recent = new Date(NOW.getTime() - 19 * 60 * 1000).toISOString();
    const old = new Date(NOW.getTime() - 21 * 60 * 1000).toISOString();
    mountDrafts([
      draft({ id: "u1", status: "unverified", updatedAt: recent }),
      draft({ id: "u2", status: "unverified", updatedAt: old, subject: "Old" }),
    ]);
    expect(stateOf()).toBe(words.heldChecking);
    expect(stateOf(row(/Old/))).toBe(words.heldNotInSent);
    fireEvent.click(row());
    expect(answerNames()).toEqual(answers);
    fireEvent.click(row(/Old/));
    expect(answerNames()).toEqual(answers);
    expect(document.body.textContent).not.toContain("Did this message arrive");
    expect(document.body.textContent).not.toContain("over a week");
  });

  it("reads an unparseable stamp as past the window — the sentence that claims less", () => {
    mountDrafts([draft({ status: "unverified", updatedAt: "not a date" })]);
    expect(stateOf()).toBe(words.heldNotInSent);
  });

  it("a stranded `sending` row says the send was interrupted", () => {
    mountDrafts([draft({ status: "sending" })]);
    expect(stateOf()).toBe(words.heldInterrupted);
    fireEvent.click(row());
    expect(answerNames()).toEqual(answers);
  });

  it("`Send again` hands the draft to the shell; `It was sent — dismiss` answers `arrived`", () => {
    const again: string[] = [];
    const resolved: Array<[string, string]> = [];
    mountDrafts([draft({ id: "u1", status: "unverified" })], {
      sendAgain: (draft) => again.push(draft.id),
      resolve: (id, outcome) => resolved.push([id, outcome]),
    });
    fireEvent.click(row());
    fireEvent.click(within(heldActions()).getByRole("button", { name: words.sendAgain }));
    expect(again).toEqual(["u1"]);
    expect(resolved).toEqual([]);
    fireEvent.click(within(heldActions()).getByRole("button", { name: words.heldItWasSent }));
    expect(resolved).toEqual([["u1", "arrived"]]);
  });

  it("a held row still has Discard, beside the two acts", () => {
    mountDrafts([draft({ status: "unverified" })]);
    fireEvent.click(row());
    const buttons = within(heldActions()).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual([...answers, words.discard]);
  });
});
