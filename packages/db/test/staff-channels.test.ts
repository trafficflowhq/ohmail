import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAFF_CHANNELS, STAFF_CHANNEL_OTHER, AUDIT_LOG_ACTIONS, API_HEALTH_ERROR_CODES,
  DB_ACQUIRE_TIMEOUT_CODE, DB_CONNECTION_CAP_CODE, auditAction, isAuditLogAction, isApiHealthErrorCode,
  staffChannel, staffChannelValue, staffChannelWord, StaffChannelViolation,
  MAILBOX_ERROR_CODES, MAILBOX_ERROR_DETAIL_TOKENS,
} from "../src/index.js";
import { DbAcquireTimeoutError, DbConnectionCapError } from "../src/client.js";
import { presentRoots } from "../../../test/support/public-root.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/* The roots that hold an `audit_log` writer. The staff console is deliberately absent — it is the
   console's own client code, it issues no INSERT, and it is not a published root. */
const WRITER_ROOTS = [
  "apps/worker/src", "packages/core/src", "packages/services/src", "packages/db/src",
  "packages/api/src",
];

function sources(root: string): string[] {
  const abs = join(REPO, root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
    }
  };
  walk(abs);
  return out;
}

/** Every `insert(auditLog).values({ … action: X … })` in the tree, as `(file, the X text)`. */
function auditWriteSites(): Array<{ file: string; action: string }> {
  const found: Array<{ file: string; action: string }> = [];
  for (const root of WRITER_ROOTS) {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8");
      let at = text.indexOf("insert(auditLog)");
      while (at !== -1) {
        // The `action:` property of THIS insert — the next one before the object closes.
        const window = text.slice(at, at + 600);
        const m = /\baction:\s*([^,\n]+)/.exec(window);
        if (m) found.push({ file: file.slice(REPO.length + 1), action: m[1]!.trim() });
        at = text.indexOf("insert(auditLog)", at + 1);
      }
    }
  }
  return found;
}

describe("the staff-visible free-text channels are closed sets", () => {
  it("names four channels, each with members, a test and a reason", () => {
    expect(STAFF_CHANNELS.map((c) => c.channel)).toEqual([
      "mailboxes.error_code", "mailboxes.error_detail", "audit_log.action",
      "api_health.error_code",
    ]);
    for (const c of STAFF_CHANNELS) {
      expect(c.members.length, c.channel).toBeGreaterThan(0);
      expect(c.why.length, c.channel).toBeGreaterThan(40);
      // The predicate and the member list are the SAME source, never two copies.
      for (const m of c.members) expect(c.isMember(m), `${c.channel}/${m}`).toBe(true);
      expect(c.isMember(`${c.members[0]}-not-a-member`), c.channel).toBe(false);
    }
  });

  it("refuses a channel it does not know rather than defaulting", () => {
    expect(() => staffChannel("credit_ledger.source")).toThrow(/not a staff channel/);
    expect(() => staffChannelWord("credit_ledger.source", "x")).toThrow(/not a staff channel/);
  });

  /* ── the write door ──────────────────────────────────────────────────────────────────── */

  it("admits a member and refuses a word outside the set", () => {
    expect(staffChannelValue("mailboxes.error_code", "auth")).toBe("auth");
    expect(() => staffChannelValue("mailboxes.error_code", "auth: 550 5.7.1 no such user"))
      .toThrow(StaffChannelViolation);
    expect(staffChannelValue("mailboxes.error_detail", "AUTHENTICATIONFAILED"))
      .toBe("AUTHENTICATIONFAILED");
    // The forged-token case the allowlist exists for: a server chooses the bracket atom.
    expect(() => staffChannelValue("mailboxes.error_detail", "SECRETPASSWORD123"))
      .toThrow(StaffChannelViolation);
  });

  it("a nullable channel takes null; a NOT NULL one refuses it", () => {
    expect(staffChannelValue("mailboxes.error_code", null)).toBeNull();
    expect(staffChannelValue("mailboxes.error_code", undefined)).toBeNull();
    expect(() => auditAction(null)).toThrow(StaffChannelViolation);
  });

  it("the violation names the channel and the value, and carries a code", () => {
    try {
      auditAction("admin.account.delete_everything");
      expect.unreachable("the door admitted a word outside the set");
    } catch (err) {
      expect(err).toBeInstanceOf(StaffChannelViolation);
      expect((err as StaffChannelViolation).code).toBe("staff_channel_violation");
      expect(String(err)).toContain("audit_log.action");
      expect(String(err)).toContain("admin.account.delete_everything");
    }
  });

  /* ── the read side ───────────────────────────────────────────────────────────────────── */

  it("renders a member as itself and anything else as `other`", () => {
    expect(staffChannelWord("mailboxes.error_code", "tls")).toBe("tls");
    expect(staffChannelWord("mailboxes.error_detail", "ECONNREFUSED")).toBe("ECONNREFUSED");
    // A planted row — a migration, a support script, a restored backup, a writer nobody censused.
    expect(staffChannelWord("mailboxes.error_detail", "Re: your invoice from ACME"))
      .toBe(STAFF_CHANNEL_OTHER);
    expect(staffChannelWord("audit_log.action", "admin.note: called the customer"))
      .toBe(STAFF_CHANNEL_OTHER);
    expect(staffChannelWord("mailboxes.error_code", null)).toBeNull();
  });

  it("`other` is not a member of any channel, so it can never be a real value", () => {
    for (const c of STAFF_CHANNELS) {
      expect(c.isMember(STAFF_CHANNEL_OTHER), c.channel).toBe(false);
    }
    // And it is distinct from `unknown`, which `error_code` really does hold.
    expect(MAILBOX_ERROR_CODES).toContain("unknown");
    expect(STAFF_CHANNEL_OTHER).not.toBe("unknown");
  });

  /* ── the sets are derived from the writers ───────────────────────────────────────────── */

  it("every audit_log write site in the tree spells a member of the set", () => {
    const sites = auditWriteSites();
    // A floor, so a refactor that deletes every INSERT cannot make this vacuous.
    expect(sites.length).toBeGreaterThanOrEqual(11);
    for (const s of sites) {
      expect(s.action, `${s.file}: ${s.action}`).toMatch(/^auditAction\(/);
    }
  });

  it("every audit action literal in a writer root is a member", () => {
    const literals = new Set<string>();
    for (const root of WRITER_ROOTS) {
      for (const file of sources(root)) {
        for (const m of readFileSync(file, "utf8").matchAll(/\bauditAction\("([^"]+)"\)/g)) {
          literals.add(m[1]!);
        }
      }
    }
    expect(literals.size).toBeGreaterThanOrEqual(10);
    for (const word of literals) expect(isAuditLogAction(word), word).toBe(true);
  });

  it("every `admin.` action the console or a route NAMES is a member", () => {
    /* The staff view's predicate is `LIKE 'admin.%'`, and only one of these has an INSERT in this
       tree — the rest are declared by the console's action catalog and written by the plane. A
       set derived from this tree's INSERTs alone rendered `admin.account.suspend` as `other`,
       which `staff-role.pg.test.ts` caught against a real database. */
    const named = new Set<string>();
    for (const root of presentRoots(["apps/admin/data", "apps/admin/app", "packages/services/src",
      "packages/api/src", "packages/db/src"], REPO)) {
      for (const file of sources(root)) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          // Per LINE, and only where the line is about an action — the console's data layer's
          // suspend/resume is a ternary, so an `action: "…"` pattern misses both halves.
          if (!/\baction\b/.test(line)) continue;
          for (const m of line.matchAll(/"(admin\.[a-z_]+\.[a-z_.]+)"/g)) named.add(m[1]!);
        }
      }
    }
    expect([...named].sort()).toEqual([
      "admin.mailbox.resync", "admin.oauth.microsoft.save", "admin.send.retry",
    ]);
    for (const word of named) expect(isAuditLogAction(word), word).toBe(true);

    /* AND THE THREE THAT LEFT THIS SCAN, pinned rather than dropped. The console used to COMPOSE the
       suspend/resume entry from the request it sent and now reads it out of the ANSWER; the credit
       adjustment's form left with the Billing page (CLOUD-025). Past rows of all three stay in
       `audit_log` and the staff view still renders them, so they stay members, and a revert that
       named one client-side again would have to re-add it above rather than pass quietly. */
    expect(isAuditLogAction("admin.account.suspend")).toBe(true);
    expect(isAuditLogAction("admin.account.resume")).toBe(true);
    expect(isAuditLogAction("admin.credits.adjust")).toBe(true);
  });

  it("the set holds the two audit actions writers name through a constant", () => {
    // `packages/db/src/organizer-profile-import.ts` exports both; the writers pass the constant,
    // so the literal scan above cannot see them.
    expect(isAuditLogAction("organizer_profile_found")).toBe(true);
    expect(isAuditLogAction("organizer_profile_import_resolved")).toBe(true);
    expect(AUDIT_LOG_ACTIONS.length).toBe(new Set(AUDIT_LOG_ACTIONS).size);
  });

  it("the health channel holds the acquire timeout the driver arm raises", () => {
    // Spelled in `staff-channels.ts` rather than imported, so this is the drift guard.
    expect(new DbAcquireTimeoutError(1).code).toBe(DB_ACQUIRE_TIMEOUT_CODE);
    expect(isApiHealthErrorCode(DB_ACQUIRE_TIMEOUT_CODE)).toBe(true);
    // The two codes `packages/api/test` asserts a live probe answers with.
    expect(isApiHealthErrorCode("ECONNREFUSED")).toBe(true);
    // An IMAP response code is NOT a database driver code — the health set is its own.
    expect(isApiHealthErrorCode("AUTHENTICATIONFAILED")).toBe(false);
    expect(MAILBOX_ERROR_DETAIL_TOKENS.has("AUTHENTICATIONFAILED")).toBe(true);
    expect(API_HEALTH_ERROR_CODES.size).toBeGreaterThan(20);
  });

  it("…and the connection cap the pooled handle raises", () => {
    expect(new DbConnectionCapError("pooler").code).toBe(DB_CONNECTION_CAP_CODE);
    expect(API_HEALTH_ERROR_CODES.has("db_connection_cap")).toBe(true);
  });
});
