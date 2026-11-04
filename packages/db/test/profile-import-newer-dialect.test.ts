import { describe, it, expect } from "vitest";
import { profileImportResolutionExists, profileImportWriteReleased, recordProfileImportResolution } from "@trafficflow/db";
import { makeTestDb } from "../src/testing.js";

/**
 * A NEWER-FORMAT "NOT NOW", READ BACK ON BOTH STORES — one file, two runs.
 *
 * The dismissal is keyed to the refused version, compared as TEXT. The device store's `->>`
 * answers a JSON number as an INTEGER and never equals a TEXT, so the phone recorded the answer
 * and never read it back: its gate held every stranger for as long as that document stood.
 * `audit_log` has no foreign key, so both projects seed and run this identically.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000ab";
const MAILBOX = "00000000-0000-4000-8000-0000000000ac";

describe("a newer-format dismissal, on whichever store this is", () => {
  it("is found by its version, and a different version is not", async () => {
    const db = await makeTestDb();
    const at = { accountId: ACCOUNT, mailboxId: MAILBOX };
    expect(await profileImportResolutionExists(db, { ...at, newerV: 99 })).toBe(false);
    await recordProfileImportResolution(db, { ...at, decision: "declined", newerV: 99 });
    expect(await profileImportResolutionExists(db, { ...at, newerV: 99 })).toBe(true);
    expect(await profileImportResolutionExists(db, { ...at, newerV: 98 })).toBe(false);
    // Written once: the duplicate check reads the same comparison.
    await recordProfileImportResolution(db, { ...at, decision: "declined", newerV: 99 });
    expect(await profileImportResolutionExists(db, { ...at, newerV: 99 })).toBe(true);
  });

  it("a version past 2^31 is compared, not cast, on both stores", async () => {
    const db = await makeTestDb();
    const at = { accountId: ACCOUNT, mailboxId: MAILBOX };
    await recordProfileImportResolution(db, { ...at, decision: "declined", newerV: 2 ** 40 });
    expect(await profileImportResolutionExists(db, { ...at, newerV: 2 ** 40 })).toBe(true);
  });
});

/* AN ANSWER COVERS ONE COPY. A copy's name ends with the second it was saved and its writer; an answer recorded
   before copies were named this way names the content alone, and covers the copies saved before it. */
describe("an answer names one copy, on whichever store this is", () => {
  const content = `2:${"a".repeat(64)}`;
  const copy = (second: number, install = "0123456789abcdef") => `${content}~${second}-${install}`;
  const T = 1_790_000_000;
  const at = { accountId: ACCOUNT, mailboxId: MAILBOX };

  it("a later copy with the same settings, or another install's, is not answered", async () => {
    const db = await makeTestDb();
    await recordProfileImportResolution(db, { ...at, decision: "imported", fingerprint: copy(T) });
    expect({
      same: await profileImportResolutionExists(db, { ...at, fingerprint: copy(T) }),
      released: await profileImportWriteReleased(db, { ...at, fingerprint: copy(T) }),
      later: await profileImportResolutionExists(db, { ...at, fingerprint: copy(T + 1) }),
      laterReleased: await profileImportWriteReleased(db, { ...at, fingerprint: copy(T + 1) }),
      otherInstall: await profileImportResolutionExists(db, { ...at, fingerprint: copy(T, "fedcba9876543210") }),
      contentAlone: await profileImportResolutionExists(db, { ...at, fingerprint: content }),
    }).toEqual({ same: true, released: true, later: false, laterReleased: false, otherInstall: false, contentAlone: false });
  });

  it("an answer from before covers the copies saved up to five minutes after it, and no later one", async () => {
    const db = await makeTestDb();
    await recordProfileImportResolution(db, { ...at, decision: "imported", fingerprint: content, at: new Date(T * 1000) });
    await recordProfileImportResolution(db, { ...at, decision: "declined", fingerprint: `${content}.${"b".repeat(32)}`, at: new Date(T * 1000) });
    const answered = async (fingerprint: string) => [
      await profileImportResolutionExists(db, { ...at, fingerprint }), await profileImportWriteReleased(db, { ...at, fingerprint }),
    ];
    expect({
      before: await answered(copy(T - 3600)),
      within: await answered(copy(T + 300)),
      after: await answered(copy(T + 301)),
      content: await answered(content),
      declined: await answered(`${content}.${"b".repeat(32)}~${T - 60}-0123456789abcdef`),
      otherRemovals: await answered(`${content}.${"c".repeat(32)}~${T - 60}-0123456789abcdef`),
    }).toEqual({
      before: [true, true], within: [true, true], after: [false, false], content: [true, true],
      declined: [true, false], otherRemovals: [false, false],
    });
  });
});
