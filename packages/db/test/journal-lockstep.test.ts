import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAIL_MIGRATIONS_DIR, SQLITE_MIGRATIONS_DIR } from "@ohmail/db-mail";

/**
 * THE TWO JOURNALS MOVE TOGETHER, OR SOMEBODY SAYS WHY NOT.
 *
 * The shared journal is the one every deployment runs and the one a change lands in first. The
 * store a device carries needs the same change expressed differently — and "differently" is
 * sometimes "not at all": a constraint change is a table rebuild there, and an index the server
 * needs for a query plan may be pointless on a single-user store.
 *
 * What must never happen is the third case: a change lands on one side and nobody decides about
 * the other. So every entry numbered after the fork owes either a same-numbered sibling or a
 * `.noop` file whose contents are the reason. A missing sibling fails here, at the commit that
 * created it, rather than at a device that quietly has an older schema.
 *
 * The other direction has one declared exception: a DEVICE-ONLY entry, which changes this store
 * alone and says why in a `-- device-only: <reason>` header line (0138: the server's word index is
 * already stemmed). It is no orphan, and it answers no shared entry that shares its number.
 */

/** The last shared entry that predates the second journal; everything after it owes a decision. */
const FORK_AFTER = 90;

const deviceOnly = (file: string): boolean =>
  file.endsWith(".sql") && /^-- device-only: \S/m.test(readFileSync(join(SQLITE_MIGRATIONS_DIR, file), "utf8"));
const numberOf = (file: string): number | null => {
  const m = /^(\d{4})_/.exec(file);
  return m ? Number.parseInt(m[1] as string, 10) : null;
};

describe("the two journals stay in lockstep", () => {
  const shared = readdirSync(MAIL_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const device = readdirSync(SQLITE_MIGRATIONS_DIR).sort();

  it("reads a shared journal that actually has entries", () => {
    expect(shared.length).toBeGreaterThan(50);
    expect(shared.some((f) => numberOf(f) === FORK_AFTER)).toBe(true);
  });

  it("gives every shared entry after the fork a sibling or a stated reason", () => {
    const owed = shared.filter((f) => (numberOf(f) ?? 0) > FORK_AFTER);
    const missing = owed.filter((f) => {
      const n = numberOf(f);
      const prefix = String(n).padStart(4, "0");
      return !device.some((d) => (d.startsWith(`${prefix}_`) && !deviceOnly(d)) || d === `${prefix}.noop`);
    });
    expect(missing, "shared entries with no sibling and no stated reason").toEqual([]);
  });

  it("has no device entry that answers a shared entry which does not exist", () => {
    const numbers = new Set(shared.map(numberOf).filter((n): n is number => n !== null));
    const orphans = device
      .filter((f) => (numberOf(f) ?? 0) > FORK_AFTER && !deviceOnly(f))
      .filter((f) => !numbers.has(numberOf(f) as number));
    expect(orphans, "device entries answering nothing in the shared journal").toEqual([]);
  });

  it("reads the device-only declaration it admits, and only from a header line", () => {
    // Contained, not listed: a later device-only entry is admitted by its header, not by this file.
    expect(device.filter(deviceOnly), "the declared device-only entries").toContain("0138_device_search_stems.sql");
    expect(deviceOnly("0137_draft_forward_of.sql"), "an ordinary twin is not device-only").toBe(false);
  });
});
