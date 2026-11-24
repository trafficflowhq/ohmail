/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@ohmail/ui";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot } from "@ohmail/app/account";
import { StoragePane, useStorage } from "../../../../packages/app/src/account/storage/index.js";
import { en, json, published, refusal, serve, settle, Words, type Server } from "./storage-harness";
import { NEAR, open, ROSTER } from "./storage-fixtures";

/**
 * THE CALLS OF ONE VISIT, BEFORE AND AFTER. The shipped section and the new pane over the web's filling are each
 * walked through the same visit over the same scripted server: open; the storage mails switched (taken); switched
 * back (refused); Change plan, refused for the factor, the factor verified, sent again and left for the page; leave.
 * The two ordered lists of method, path and body keys are equal. The factor's own ceremony is the doors' dialog's
 * (both stand in for it here, so neither list carries it); what is compared is what the pane asks.
 */

let roster: unknown[] | null = ROSTER;
vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", () => ({ useMailboxFacts: () => roster }));
/** The shipped section's factor prompt, stood in for: the case answers it as the dialog would. */
const prompt = vi.hoisted(() => ({ verified: null as null | (() => void) }));
vi.mock("../../app/(product)/mailbox/StepUp", () => ({
  StepUp: (props: { onVerified: () => void }) => {
    prompt.verified = props.onVerified;
    return null;
  },
}));

const CHANGE = "POST /api/account/manage-link/change";
const WRITE = "PATCH /api/account/storage";
let server: Server;
let verify: (() => void) | null = null;
const factor: FactorSlot = (ask) => {
  verify = ask.onVerified;
  return null;
};

beforeEach(() => {
  roster = ROSTER;
  verify = null;
  prompt.verified = null;
  server = serve(() => open(NEAR));
  // The visit's script, the same for both: the write taken, the write refused, the change refused for the factor,
  // then the change answered with the page.
  server.answer(WRITE, json({}), refusal(500, "internal"));
  server.answer(CHANGE, refusal(403, "step_up_required"), json({ url: "https://pay.example.com/manage/visit" }));
});
afterEach(() => {
  cleanup();
  server.restore();
});

async function walk(pane: ReactNode, factorVerified: () => void): Promise<string[]> {
  await published();
  server.forget();
  const { unmount } = render(
    <Words>
      <ThemeProvider>{pane}</ThemeProvider>
    </Words>,
  );
  const sw = () => screen.getByRole("switch", { name: en.settings.storageMail });
  for (const press of [() => fireEvent.click(sw()), () => fireEvent.click(sw())]) {
    await act(async () => press());
    await settle();
  }
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.settings.storageChangePlan }));
  });
  await settle();
  await act(async () => factorVerified());
  await settle();
  unmount();
  await settle();
  return server.sent.map((s) => `${s.line} {${s.keys.join(",")}}`);
}

describe("one visit to Settings › Storage asks the server the same things, in the same order", () => {
  it("the shipped section and the new pane", async () => {
    const { StorageSection } = await import("../../app/(product)/mailbox/StorageSection");
    const before = await walk(<StorageSection />, () => prompt.verified!());
    cleanup();
    server.restore();
    server = serve(() => open(NEAR));
    server.answer(WRITE, json({}), refusal(500, "internal"));
    server.answer(CHANGE, refusal(403, "step_up_required"), json({ url: "https://pay.example.com/manage/visit" }));

    const { useStorageDoor } = await import("../../app/(product)/mailbox/storage-door");
    function Anew() {
      return <StoragePane model={useStorage(useStorageDoor(null))} body="pane" factor={factor} />;
    }
    const after = await walk(<Anew />, () => verify!());

    expect(before).toEqual([
      `${WRITE} {mail}`,
      "GET /api/account/access {}",
      `${WRITE} {mail}`,
      `${CHANGE} {lang}`,
      `${CHANGE} {lang}`,
    ]);
    expect(after).toEqual(before);
  });
});
