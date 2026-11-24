/**
 * the `mailboxes.error_code` taxonomy is defined ONCE.
 *
 * It was written out three times: the worker's union (which EMITS the values), the services DTO
 * union (which SHIPS them to the client), and a `//` comment on the column. Nothing connected
 * them. The failure that buys is quiet in both directions — the DTO promising a code the worker
 * never emits, or the worker emitting one the client cannot map to copy, so the Settings pane
 * renders a blank reason beside a red mailbox.
 *
 * The project's design notes proposed "a guard asserting the two unions match". A single definition is strictly
 * better, so the guard's job changed: it no longer compares two lists, it asserts that a second
 * list has not come BACK. A type-level union cannot be checked at runtime, so the assertion is
 * over the source text — crude, and the only thing that actually catches the regression, since
 * TypeScript is perfectly happy for two identical unions to coexist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAILBOX_ERROR_CODES, isMailboxErrorCode } from "../src/mailbox-errors.js";

// `fileURLToPath`, never `.pathname` — this checkout lives under a directory with a SPACE.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A literal union of the seven codes, however it is spelled or spaced. */
const REDECLARED = /type\s+MailboxErrorCode\s*=\s*["']auth["']/;

describe("one definition of MailboxErrorCode", () => {
  it("the worker does not redeclare the union", () => {
    const src = read("../../../apps/worker/src/mailboxes.ts");
    expect(src).not.toMatch(REDECLARED);
    expect(src).toContain('from "@trafficflow/db"');
  });

  it("the services DTO does not redeclare the union", () => {
    const src = read("../../services/src/dto/types.ts");
    expect(src).not.toMatch(REDECLARED);
    expect(src).toContain('from "@trafficflow/db"');
  });

  it("the column comment no longer carries a fourth copy that can go stale", () => {
    // The comment used to spell out `auth|connect|tls|timeout|storage|sync|unknown`. A comment
    // is a claim under test here (AGENTS.md), and an enumerated one drifts silently.
    expect(read("../src/schema.ts")).not.toContain("auth|connect|tls|timeout|storage|sync|unknown");
  });

  it("carries exactly the seven codes the database column accepts", () => {
    expect([...MAILBOX_ERROR_CODES]).toEqual(
      ["auth", "connect", "tls", "timeout", "storage", "sync", "unknown"]);
  });

  it("narrows a value read back from a TEXT column, which has no type at rest", () => {
    expect(isMailboxErrorCode("auth")).toBe(true);
    expect(isMailboxErrorCode("AUTH")).toBe(false);          // the writer lower-cases; be strict
    expect(isMailboxErrorCode("host:port")).toBe(false);     // a host:port value, one field over
    expect(isMailboxErrorCode(null)).toBe(false);
    expect(isMailboxErrorCode(undefined)).toBe(false);
  });
});
