/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PaneProps } from "@ohmail/app/frame/contract";
import { TextProvider } from "@ohmail/app/text";
import { useDraftsList } from "@ohmail/app-logic/drafts";
import messages from "../../../packages/app/messages/drafts.en.json";
import { DraftsAbove } from "../../../packages/app/src/drafts/DraftsAbove.js";
import { DraftsList } from "../../../packages/app/src/drafts/DraftsList.js";
import { DraftsReading } from "../../../packages/app/src/drafts/DraftsReading.js";
import { useDiscardWords } from "../../../packages/app/src/drafts/words.js";

const draft = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: "d1",
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: over.id === "p1" ? "An ordinary draft" : "Invoice for the paper order",
  body: "The only copy of this text lives in this row.",
  to: [{ name: null, address: "sam@customer.example" }],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T14:02:00.000Z",
  ...over,
});

const resolved: string[] = [];
const sentAgain: string[] = [];
const now = new Date("2026-08-07T15:00:00.000Z");

function Drafts({ drafts }: { drafts: EngineDraft[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const model = useDraftsList({
    drafts,
    scheduled: [],
    settled: true,
    owed: false,
    now,
    stamp: (iso) => iso,
    appointment: (iso) => iso,
    words: useDiscardWords(),
    report: () => {},
    door: {
      open: (draft) => setOpen(draft.id),
      decide: () => ({ kind: "go" }),
      withdrawWaiting: async () => "none",
      discard: async () => ({ kind: "applied" }),
      cancelSchedule: () => {},
      editScheduled: () => {},
      resolve: (id, outcome) => resolved.push(`${id}:${outcome}`),
      sendAgain: (draft) => sentAgain.push(draft.id),
      repliesHere: () => false,
      heldHere: new Set(),
      waiting: new Set(),
      notSent: new Map(),
    },
  });
  const pane: PaneProps = {
    route: { place: "drafts", sub: null, open, stage: null, words: {} },
    plan: {
      size: "expanded", short: false, pointer: "fine", device: "desktop",
      pose: null, rail: "words", columns: 2, handles: true,
    },
    keysHere: true,
  };
  return (
    <DraftsAbove model={model}>
      <DraftsList {...pane} />
      <DraftsReading {...pane} />
    </DraftsAbove>
  );
}

function mountDrafts(drafts: EngineDraft[]): void {
  render(
    <TextProvider locale="en" messages={messages} timeZone="UTC">
      <Drafts drafts={drafts} />
    </TextProvider>,
  );
}

const heldRow = () => screen.getByRole("option", { name: /Invoice for the paper order/ });
const ordinaryRow = () => screen.getByRole("option", { name: /An ordinary draft/ });
const heldActions = () => screen.queryByRole("toolbar", { name: messages.drafts.heldActs });

function verb(name: string): HTMLElement {
  const toolbar = screen.getByRole("toolbar", { name: messages.drafts.heldActs });
  return within(toolbar).getByRole("button", { name });
}

afterEach(() => {
  cleanup();
  resolved.length = 0;
  sentAgain.length = 0;
});

describe("a held row offers the two answers a reader can actually give", () => {
  it("an unverified row carries both verbs; an ordinary draft carries none", () => {
    mountDrafts([
      draft({ id: "u1", status: "unverified" }),
      draft({ id: "p1", updatedAt: "2026-08-07T13:00:00.000Z" }),
    ]);

    fireEvent.click(ordinaryRow());
    expect(heldActions(), "an ordinary draft is asked whether it arrived").toBeNull();

    fireEvent.click(heldRow());
    expect(heldActions(), "a held row offers no way to answer its own note").not.toBeNull();
    expect(verb("It was sent")).toBeDefined();
    expect(verb("Send again")).toBeDefined();
  });

  it("each act dispatches its OWN thing for its own row", () => {
    mountDrafts([draft({ id: "u1", status: "unverified" })]);
    fireEvent.click(heldRow());

    fireEvent.click(verb("Send again"));
    expect(sentAgain, '"Send again" did not hand the row to the shell').toEqual(["u1"]);
    expect(resolved, '"Send again" answered for the send instead of handing the row to the shell').toEqual([]);

    fireEvent.click(verb("It was sent"));
    expect(resolved).toEqual(["u1:arrived"]);
  });

  it("a stranded `sending` row names its state and carries both verbs", () => {
    mountDrafts([
      draft({ id: "s1", status: "sending" }),
      draft({ id: "p1", updatedAt: "2026-08-07T13:00:00.000Z" }),
    ]);

    expect(heldRow().getAttribute("aria-description"), "the interrupted row stopped saying what happened")
      .toContain("the send was interrupted");
    fireEvent.click(ordinaryRow());
    expect(heldActions(), "an ordinary draft is asked whether it arrived").toBeNull();
    fireEvent.click(heldRow());
    expect(heldActions(), "a row whose send died mid-flight offers no way to answer").not.toBeNull();
    expect(verb("It was sent")).toBeDefined();
    expect(verb("Send again")).toBeDefined();
  });

  it("the stranded row's verbs carry its own id and outcome", () => {
    mountDrafts([draft({ id: "s1", status: "sending" })]);
    fireEvent.click(heldRow());

    fireEvent.click(verb("Send again"));
    expect(sentAgain, "the interrupted row's act is misrouted").toEqual(["s1"]);
    fireEvent.click(verb("It was sent"));
    expect(resolved).toEqual(["s1:arrived"]);
  });

  it("the held row still carries its own Discard trigger", () => {
    mountDrafts([draft({ id: "u1", status: "unverified" })]);
    const list = screen.getByRole("listbox", { name: messages.drafts.title });
    expect(within(list).queryByRole("button", { name: "Discard" }), "the held row lost its Discard trigger")
      .not.toBeNull();
  });
});

describe("the shell asks about the hold BEFORE it opens a reply", () => {
  // Its four cases over the shell's composition moved to `drafts-resolve-held-shell.test.ts`.

  /**
   * ONE component on EVERY door, so the words and the outcomes cannot fall apart.
   *
   * Three doors show a held message: the Drafts row, the message's own reply editor, and the
   * composer. The Drafts row had the answers; the other two stated the hold and offered nothing,
   * so the only exit from either was to leave for a third screen.
   */
  it("all three doors render the same resolution component", () => {
    const read = (rel: string): string =>
      readFileSync(resolve(process.cwd(), rel), "utf8");
    const drafts = read("packages/app/src/drafts/DraftsReading.tsx");
    const status = read("packages/app/src/write/status/Status.tsx");
    const write = read("packages/app/src/write/Letter.tsx");
    const reply = read("packages/app/src/write/Reply.tsx");
    expect(drafts).toMatch(/import \{ HeldSendAnswers \} from "\.\.\/write\/HeldSendAnswers\.js"/);
    expect(drafts).toMatch(/<HeldSendAnswers\s/);
    expect(status).toMatch(/import \{ HeldSendAnswers \} from "\.\.\/HeldSendAnswers\.js"/);
    expect(status).toMatch(/<HeldSendAnswers\s/);
    expect(write).toMatch(/const lines = useLetterSendLines\(\)/);
    expect(status).toMatch(/<Status at="top" \{\.\.\.said\}/);
    expect(reply).toMatch(/<Status\s+at="one"[^>]*held=\{reply\.held\}/);
  });
});
