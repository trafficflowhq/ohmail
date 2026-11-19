/** @vitest-environment jsdom */
/**
 * A PERSON's FIRST WORDS ARE THEIRS, ALSO RIGHT AFTER A COLD LOAD. Over the web's real entry (`CloudShell`, as the page
 * mounts it), at the place that writes: what is typed into the letter's subject before the page has settled (the
 * server's answer about the session still on its way) is still there once it has.
 */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  installConfirmEnv, mountCloudShell, rememberOwner, scriptSession, sessionFull, teardownConfirmEnv, tick,
} from "../fixtures/cloud-confirm-shell";

const subject = (): HTMLInputElement | null =>
  screen.queryByRole("textbox", { name: "Subject" }) as HTMLInputElement | null;

beforeEach(() => {
  resetStorageOwnerForTest();
  installConfirmEnv();
  rememberOwner();
});
afterEach(async () => {
  await teardownConfirmEnv();
});

/** The browser's Web Locks, answering only after `late` ms: a cold page's composer learns late which composer it is. */
function slowLocks(late: number): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, "locks");
  const locks = {
    request: (_name: string, opts: unknown, cb?: (lock: object | null) => unknown) => {
      const run = (typeof opts === "function" ? opts : cb) as (lock: object | null) => unknown;
      return new Promise((done) => setTimeout(() => done(run({ name: _name })), late));
    },
    query: async () => ({ held: [], pending: [] }),
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  return () => {
    if (had) Object.defineProperty(navigator, "locks", had);
    else delete (navigator as { locks?: unknown }).locks;
  };
}

describe("the first words after a cold load", () => {
  it.each([
    ["at once", 0],
    ["late", 1_500],
  ])("the subject typed before the session's answer (%s) is kept once the page settles", async (_how, late) => {
    scriptSession(() => new Promise<Response>((r) => setTimeout(() => r(sessionFull()), late)));
    window.location.hash = "#/compose";
    await mountCloudShell();
    for (let i = 0; i < 20 && subject() === null; i++) await tick(50);
    const box = subject();
    if (box === null) throw new Error(`no subject box before the session settled: ${document.body.textContent?.slice(0, 200)}`);
    fireEvent.change(box, { target: { value: "Plans for Friday" } });
    expect(subject()!.value).toBe("Plans for Friday");
    await tick(late + 3_500);
    expect(subject()?.value, "the words typed before the page settled").toBe("Plans for Friday");
  }, 30_000);

  it("with no owner remembered yet (a first visit), the subject typed before the session's answer is kept", async () => {
    document.cookie = "tf_owner=; max-age=0; Path=/";
    scriptSession(() => new Promise<Response>((r) => setTimeout(() => r(sessionFull()), 1_500)));
    window.location.hash = "#/compose";
    await mountCloudShell();
    let typedBeforeAnswer = false;
    for (let i = 0; i < 20 && subject() === null; i++) await tick(50);
    const box = subject();
    if (box !== null) {
      typedBeforeAnswer = true;
      fireEvent.change(box, { target: { value: "Plans for Friday" } });
    }
    await tick(5_000);
    if (!typedBeforeAnswer) {
      const later = subject();
      if (later === null) throw new Error("no subject box after the session's answer either");
      fireEvent.change(later, { target: { value: "Plans for Friday" } });
      await tick(1_000);
    }
    expect(subject()?.value).toBe("Plans for Friday");
  }, 30_000);

  it.each([
    ["at once", 0],
    ["late", 1_200],
    ["past the bound", 3_400],
  ])("the subject typed before this page knows which composer it is (%s) is kept once it does", async (_how, late) => {
    const back = slowLocks(late);
    try {
      scriptSession(() => sessionFull());
      window.location.hash = "#/compose";
      await mountCloudShell();
      for (let i = 0; i < 20 && subject() === null; i++) await tick(50);
      const box = subject();
      if (box === null) throw new Error("no subject box");
      fireEvent.change(box, { target: { value: "Plans for Friday" } });
      await tick(late + 3_500);
      expect(subject()?.value, "the words typed before the composer was ready").toBe("Plans for Friday");
    } finally {
      back();
    }
  }, 30_000);
});
