/** @vitest-environment jsdom */
/**
 * THE COMPOSITION AS THE NEW SCREEN READS IT (`todays-write.ts`): the record's members handed through, and the members
 * the old view's mount derives derived the same way: the send on screen, the hold and its row, the signatures only
 * once they are known.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTranslations } from "next-intl";
import { screen } from "@testing-library/react";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import type { SendState } from "@ohmail/app-logic/writing/mail-send";
import en from "../../messages/en.json";
import { writingOf, todaysWriteBeside, SEND_LATER_FLOOR_MS } from "../../app/shell/todays-write";
import { act, stubDom } from "../_draft-shell.js";
import { letter } from "../_handoff-steps.js";
import { mountWriting, rounds, unmountWritings } from "./writing-world.js";

const t = ((key: string) => key) as unknown as ReturnType<typeof useTranslations>;
const KNOWN = { signatures: { mb1: "Mila" }, signaturesHtml: {}, signaturesKnown: true };

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* storage blocked */
  }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});

describe("writingOf", () => {
  it("hands the record through and derives the send, the hold and the signatures as the old mount does", async () => {
    const row = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
    const w = await mountWriting({ drafts: [row] });
    const ctx = { engine: w.engine, scope: "acc-1", replyTo: null, options: [], consent: KNOWN, drafts: [row], noCredits: false, t };
    const before = writingOf(w.now(), ctx);
    expect(before.composeSend.phase).toBe("idle");
    expect(before.composeHeld).toBeNull();
    expect(before.composeLocked).toBeNull();
    expect(before.signatures).toEqual({ text: { mb1: "Mila" }, html: {} });
    expect(writingOf(w.now(), { ...ctx, consent: { ...KNOWN, signaturesKnown: false } }).signatures).toBe("unknown");
    await act(async () => w.now().openDraft(row));
    await rounds(6);
    Object.assign(w.refuseSend, { on: true, unverified: true });
    await act(async () => writingOf(w.now(), ctx).sendCompose());
    await rounds(30);
    const after = writingOf(w.now(), ctx);
    expect(after.composeSend.phase).toBe("unverified");
    expect(after.composeHeld).toEqual({ draftId: "d-a" });
    expect(after.compose.subject).toBe("Plans for Friday");
  });
});

describe("todaysWriteBeside", () => {
  it("says the scope it was made for and refuses a time inside the floor", async () => {
    const w = await mountWriting();
    const beside = todaysWriteBeside(w.engine, "acc-1", undefined, true);
    expect(beside.scope).toBe("acc-1");
    expect(beside.surface).toBe("strict");
    expect(todaysWriteBeside(w.engine, "acc-1", null, true).surface).toBe("mailbox");
    expect(todaysWriteBeside(w.engine, "acc-1", 4096, true).surface).toBe(4096);
    const now = Date.parse("2026-09-27T09:00:00.000Z");
    expect(beside.later.floor(now)).toBe(now + SEND_LATER_FLOOR_MS);
    expect(beside.later.options(now).every((o) => Date.parse(o.at) > now + SEND_LATER_FLOOR_MS)).toBe(true);
    expect(beside.lines.split("a@x.invalid, b")).toEqual({ chips: ["a@x.invalid"], tail: "b" });
  });
});

/* Every send state today's send line answers, by phase, refusal code and the server's first send. */
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
      await mountWriting({ view: true, send });
      const said = screen.getAllByRole("status").map((line) => line.textContent ?? "");
      expect(said.length).toBe(1);
      expect(said[0]).not.toBe("");
      expect(said[0]).not.toBe(en.write.status.unknown);
      expect(said[0]).not.toMatch(/[{}]/);
    });
  }

  it("names the limit in the too-long sentence", async () => {
    await mountWriting({ view: true, send: { phase: "failed", code: "draft_too_large" } });
    expect(screen.getByRole("status").textContent).toMatch(/\d/);
  });

  for (const phase of ["idle", "sent"] as const) {
    it(`says nothing for a letter whose send is ${phase}`, async () => {
      await mountWriting({ view: true, send: { phase } });
      expect(screen.queryAllByRole("status")).toEqual([]);
    });
  }
});
