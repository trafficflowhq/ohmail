/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { act, message, mountShell, openRegion, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";
import { rounds } from "./_handoff-steps.js";
import { key, letter, letterTo, letterText, openReplyOn, replyText, stubAnimate } from "./_writing-shell.js";
import { typeInto } from "./fixtures/rich-editor-driver";

const OWNER = "acc-attachment-hold";
const RECIPIENT = ["sam", "example.invalid"].join("@");
let releaseConversion: (() => void) | null = null;

vi.mock("@ohmail/app-logic/write/image-quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ohmail/app-logic/write/image-quality")>();
  return {
    ...actual,
    // Hold the picked file before it is committed, then let the real converter return it.
    compressImage: async (file: Blob) => {
      await new Promise<void>((resolve) => { releaseConversion = resolve; });
      return actual.compressImage(file, "original");
    },
  };
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  setStorageOwner(OWNER);
  stubDom();
  stubAnimate();
});

afterEach(async () => {
  await unmountAll();
  releaseConversion?.();
  releaseConversion = null;
  resetStorageOwnerForTest();
});

const sends = (s: DraftShell) =>
  s.sent.filter((m): m is Extract<EngineMutation, { kind: "mail_send" }> => m.kind === "mail_send");
const send = (surface: HTMLElement) => within(surface).getByRole<HTMLButtonElement>("button", { name: "Send" });

async function compose(body: string) {
  const s = await mountShell("#/ohbox", [message("m1")]);
  await key("c");
  await waitFor(() => letterTo(s.el) !== null && letterText(s.el) !== null, "the Write fields");
  const to = letterTo(s.el)!;
  await act(async () => {
    fireEvent.change(to, { target: { value: RECIPIENT } });
    fireEvent.keyDown(to, { key: "Enter" });
    typeInto(letterText(s.el)!, body);
  });
  const surface = letter(s.el)!;
  await waitFor(() => !send(surface).disabled, "Send with a recipient and message");
  return { s, surface };
}

async function pickFile(surface: HTMLElement, name: string, type: string): Promise<void> {
  expect(within(surface).getByRole("button", { name: /^Attach/ })).toBeTruthy();
  const input = surface.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array(1024)], name, { type });
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
  await waitFor(() => releaseConversion !== null, "the chosen file held in conversion");
}

async function finishConversion(): Promise<void> {
  const release = releaseConversion!;
  releaseConversion = null;
  await act(async () => { release(); });
  await rounds(10, 0);
}

describe("a pending attachment holds the send", () => {
  it("refuses the press, names the file, and puts nothing on the wire", async () => {
    const { s, surface } = await compose("Notes are attached.");
    await pickFile(surface, "notes.txt", "text/plain");

    await act(async () => { send(surface).click(); });
    await rounds(4, 0);
    expect(sends(s), "a message was sent while the chosen file was still converting").toEqual([]);
    expect(within(surface).getByText("Still attaching notes.txt.")).toBeTruthy();
    expect(send(surface).disabled).toBe(true);
  }, 20_000);

  it("the press after it lands carries the attachment", async () => {
    const { s, surface } = await compose("Notes are attached.");
    await pickFile(surface, "notes.txt", "text/plain");
    await finishConversion();

    await waitFor(() => within(surface).queryByRole("button", { name: "Remove notes.txt" }) !== null, "the attachment tile");
    expect(within(surface).queryByText(/Still attaching/)).toBeNull();
    expect(send(surface).disabled).toBe(false);
    expect(sends(s), "finishing the attachment sent without a press").toEqual([]);

    await act(async () => { send(surface).click(); });
    await rounds(10, 0);
    const out = sends(s);
    expect(out).toHaveLength(1);
    expect((out[0]!.attachments ?? []).map((attachment) => attachment.filename)).toEqual(["notes.txt"]);
  }, 20_000);

  it("the reply surface holds the same lock — the path beside it", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s);
    await act(async () => { typeInto(replyText(s.el)!, "Receipt attached."); });
    const surface = openRegion(s.el)!;
    await waitFor(() => !send(surface).disabled, "the reply can send before a file is picked");

    await pickFile(surface, "receipt.pdf", "application/pdf");
    expect(within(surface).getByText("Still attaching receipt.pdf.")).toBeTruthy();
    expect(send(surface).disabled).toBe(true);
    await act(async () => { send(surface).click(); });
    await rounds(4, 0);
    expect(sends(s)).toEqual([]);
  }, 20_000);

  it("an ordinary send with no attachment is unchanged (the positive control)", async () => {
    const { s, surface } = await compose("Nothing attached here.");
    expect(within(surface).queryByText(/Still attaching/)).toBeNull();
    expect(send(surface).disabled).toBe(false);
    await act(async () => { send(surface).click(); });
    await rounds(10, 0);
    expect(sends(s)).toHaveLength(1);
  }, 20_000);
});
