/** @vitest-environment jsdom */
/**
 * THE COMPOSITION AS THE NEW SCREEN READS IT (`writing-of.ts`, beside the composer): the record's members handed through, and the members
 * the old view's mount derives derived the same way: the send on screen, the hold and its row, the signatures only
 * once they are known.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import type { EngineDraft } from "@ohmail/wire";
import type { PaneProps } from "@ohmail/app/frame";
import { mailPlaces } from "@ohmail/app/mail";
import { useWriteBeside, useWriting, WriteAbove } from "@ohmail/app/write";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import type { SendState } from "@ohmail/app-logic/writing/mail-send";
import { writingOf } from "@ohmail/app-logic/writing/writing-of";
import en from "../../messages/en.json";
import { act, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";
import { letter } from "../_handoff-steps.js";

const SCOPE = "acc-1";
const KNOWN = { signatures: { mb1: "Mila" }, signaturesHtml: {}, signaturesKnown: true };
const t = (key: string) => key;

function useWritingSnapshot() {
  return { composer: useComposer(), projection: useWriting() };
}

async function stand(drafts: EngineDraft[] = [], send?: SendState) {
  const writing = mailPlaces().write;
  if (writing?.panes.kind !== "columns" || typeof writing.panes.Reading !== "function")
    throw new Error("Write must register its own reading pane");
  const { Reading } = writing.panes;
  let current: ReturnType<typeof useWritingSnapshot> | undefined;
  function ReadPane(props: PaneProps) {
    const read = useWritingSnapshot();
    const beside = useWriteBeside();
    current = read;
    if (send === undefined) return <Reading {...props} />;
    // Put controlled send states into the port the registered pane already reads.
    return (
      <WriteAbove writing={{ ...read.projection, composeSend: send }} beside={beside}>
        <Reading {...props} />
      </WriteAbove>
    );
  }

  const mounted = await mountShell("#/compose", [], drafts, {
    signatures: KNOWN.signatures,
    places: { write: { ...writing, panes: { ...writing.panes, Reading: ReadPane } } },
  });
  await waitFor(() => current !== undefined, "the registered Write pane");
  const letter = within(mounted.el).getByRole("region", { name: en.write.letter });
  const sendLines = () => [...letter.querySelectorAll<HTMLElement>('[role="status"][data-place]')];
  return { ...mounted, read: () => current!, sendLines };
}

beforeEach(() => {
  localStorage.clear();
  setStorageOwner(SCOPE);
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => {
  await unmountAll();
  resetComposerForTest();
  resetStorageOwnerForTest();
});

describe("writingOf", () => {
  it("hands the record through and derives the send, the hold and the signatures as the old mount does", async () => {
    const row = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
    const w = await stand([row]);
    await waitFor(() => w.read().projection.signatures !== "unknown", "the stored signature");
    const ctx = { engine: w.engine, scope: SCOPE, replyTo: null, options: [], consent: KNOWN, drafts: [row], noCredits: false, t, presented: w.engine.read() };
    const before = w.read().projection;
    expect(before.composeSend.phase).toBe("idle");
    expect(before.composeHeld).toBeNull();
    expect(before.composeLocked).toBeNull();
    expect(before.signatures).toEqual({ text: { mb1: "Mila" }, html: {} });
    expect(writingOf(w.read().composer, { ...ctx, consent: { ...KNOWN, signaturesKnown: false } }).signatures).toBe("unknown");
    await act(async () => w.read().projection.openDraft(row));
    await waitFor(() => w.read().projection.compose.subject === "Plans for Friday", "the opened draft");
    Object.assign(w.refuseSend, { on: true, unverified: true });
    await act(async () => w.read().projection.sendCompose());
    await waitFor(() => w.read().projection.composeSend.phase === "unverified", "the unconfirmed send");
    const after = w.read().projection;
    expect(after.composeSend.phase).toBe("unverified");
    expect(after.composeHeld).toEqual({ draftId: "d-a" });
    expect(after.compose.subject).toBe("Plans for Friday");
  });

  it("reads the session of its scope and never mints one: after the account's keys are swept it writes none", async () => {
    const w = await stand();
    const ctx = { engine: w.engine, scope: SCOPE, replyTo: null, options: [], consent: KNOWN, drafts: [], noCredits: false, t, presented: w.engine.read() };
    const keysOf = (): string[] => Object.keys(window.localStorage).filter((key) => key.includes(SCOPE));
    /* The account's keys swept while the composition stands; then the composition is read, as each render reads it. */
    for (const key of keysOf()) window.localStorage.removeItem(key);
    const read = writingOf(w.read().composer, ctx);
    expect(keysOf(), "a key of the account the composition's read wrote").toEqual([]);
    expect(read.composeSend.phase).toBe("idle");
    expect(read.composeHeld).toBeNull();
  });
});

/* The send line’s states by phase, refusal code and the server’s first send. */
const FAILED_CODES = [
  "mailbox_disabled", "send_unreachable", "send_busy", "send_not_secured", "send_login_refused",
  "mailbox_not_signed_in", "forward_original_unavailable", "forward_parts_unsupported", "forward_parts_changed",
  "attachment_part_mismatch", "forward_source_moved", "send_timeout", "draft_too_large", "payload_too_large",
  "staging_refused", "draft_changed", "validation_failed", "from_mailbox_unconfirmed", "draft_unsaved",
  "a_code_no_build_has_heard_of", undefined,
];
const SPOKEN: readonly SendState[] = [
  { phase: "sending", since: Date.now() },
  { phase: "sending", since: Date.now() - 60_000 },
  { phase: "queued" },
  { phase: "queued", accepted: true },
  { phase: "unverified" },
  { phase: "sending", since: Date.now(), previous: true },
  ...FAILED_CODES.map((code): SendState => (code === undefined ? { phase: "failed" } : { phase: "failed", code })),
  { phase: "duplicate", firstSend: "sent" },
  { phase: "duplicate", firstSend: "unverified" },
  { phase: "duplicate", firstSend: "pending" },
  { phase: "duplicate" },
];

describe("the send line's words", () => {
  for (const send of SPOKEN) {
    it(`says its own sentence for ${JSON.stringify(send)}`, async () => {
      const w = await stand([], send);
      const said = w.sendLines().map((line) => line.textContent ?? "");
      expect(said.length).toBe(1);
      expect(said[0]).not.toBe("");
      expect(said[0]).not.toBe(en.write.status.unknown);
      expect(said[0]).not.toMatch(/[{}]/);
    });
  }

  it("names the limit in the too-long sentence", async () => {
    const w = await stand([], { phase: "failed", code: "draft_too_large" });
    const lines = w.sendLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toMatch(/\d/);
  });

  for (const phase of ["idle", "sent"] as const) {
    it(`says nothing for a letter whose send is ${phase}`, async () => {
      const w = await stand([], { phase });
      expect(w.sendLines()).toEqual([]);
    });
  }
});
