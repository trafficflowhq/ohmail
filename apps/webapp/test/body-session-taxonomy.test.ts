/** @vitest-environment jsdom */
/**
 * ═══ (VWR-4) — A DEAD SESSION IS NOT A BROKEN MESSAGE ═══════════════════════════════════
 *
 * Observed live: with the session dead, opening a message rendered "Couldn't load the full
 * message — showing the preview. Retry", and Retry just re-401'd — the reader told the MESSAGE
 * was broken when their SESSION was gone. The pane's failure note now reads the confirmed
 * session fact (`shell/session-truth.ts`) and, when the session is dead, names it and offers
 * the remedy that works (sign in) instead of the one that cannot (retry).
 *
 * And the inverse: a body failure recorded while the session was bad is re-asked on REVIVAL —
 * the 204-confirmed minting of a new session — so the failure does not outlive its cause.
 *
 * Over the new reader (the reader's own door, `packages/app/test/reader/support/mail.tsx`): the letter's body row is
 * the mutation point, the engine's body asks are what a revival re-asks, and the sentences are the reader's catalogue's.
 */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { letter, mountReader } from "../../../packages/app/test/reader/support/mail.js";
import reader from "../../../packages/app/messages/reader.en.json" with { type: "json" };
import {
  markSessionAlive,
  markSessionDead,
  resetSessionTruthForTests,
} from "@ohmail/app-logic/session/session-truth";

const WORDS = reader.body;
let asks: () => string[] = () => [];

function mountPane(bodyState: "failed" | "full"): void {
  const { mail } = mountReader({
    letters: [letter("m1", { body: undefined, threadId: null } as never)],
    open: "m1",
    bodies: { m1: bodyState === "failed" ? { state: "failed" } : { state: "ready", text: "the whole text", html: null } },
    host: { recover: () => {} },
  });
  asks = () => mail.bodyAsks;
}

beforeEach(() => {
  resetSessionTruthForTests();
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});

afterEach(() => {
  cleanup();
  resetSessionTruthForTests();
  vi.restoreAllMocks();
});

const note = (): HTMLElement | null => screen.queryByRole("alert");
/** The note's way on stands beside its sentence, in the letter's text slot: the one letter on screen. */
const way = () => within(screen.getByRole("article"));
const retried = (): string[] => asks().filter((a) => a === "m1 retry");

describe("the body-failure note tells auth loss apart from content failure", () => {
  it("session alive: a failed body is a content failure, with Retry", async () => {
    mountPane("failed");
    expect(note()).not.toBeNull();
    expect(note()!.textContent).toContain(WORDS.kept.failed);
    expect(way().queryByRole("button", { name: WORDS.kept.tryAgain }), "the human retry disappeared").not.toBeNull();
    expect(way().queryByRole("button", { name: WORDS.signIn })).toBeNull();
  });

  it("session DEAD: the same failure names the session and offers sign-in, not a retry that re-401s", async () => {
    mountPane("failed");
    await act(async () => {
      markSessionDead();
    });
    expect(note(), "the note vanished instead of re-labelling").not.toBeNull();
    expect(note()!.textContent).toContain(WORDS.sessionEnded);
    expect(note()!.textContent).not.toContain(WORDS.kept.failed);
    expect(way().queryByRole("button", { name: WORDS.signIn }), "no sign-in path on the auth-loss note").not.toBeNull();
    expect(way().queryByRole("button", { name: WORDS.kept.tryAgain }), "a Retry whose first press proves it a lie").toBeNull();
  });

  it("a REVIVAL re-asks a failed body once, as a retry — the failure must not outlive its cause", async () => {
    mountPane("failed");
    expect(retried()).toHaveLength(0);
    await act(async () => {
      markSessionAlive();
    });
    expect(retried(), "the revival never re-asked the failed body").toHaveLength(1);
  });

  it("a revival does NOT touch a healthy body — the re-ask is bounded to failures", async () => {
    mountPane("full");
    await act(async () => {
      markSessionAlive();
    });
    expect(retried()).toHaveLength(0);
  });
});
