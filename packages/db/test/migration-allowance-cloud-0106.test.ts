import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_JOURNAL } from "../src/admin.js";
import { classifyDrift } from "../src/migration-provenance.js";

/** The bytes a database that ran the first version of this entry records, kept apart from the allowance. */
const APPLIED = 'ALTER TABLE "auth_throttle" ADD COLUMN "notice_account_id" uuid, ADD COLUMN "notice_user_id" uuid;\n';
const TAG = "0106_security_notice_recipients";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const shipped = readFileSync(join(CLOUD_JOURNAL.dir, `${TAG}.sql`), "utf8");
const noGit = { history(): never { throw new Error("not a git repository"); } };

describe("a database that applied the first password reset notice migration still deploys", () => {
  it("its recorded row is admitted without Git history", () => {
    const drift = classifyDrift(
      "cloud", CLOUD_JOURNAL.dir,
      { tag: TAG, when: 1794732061381, expected: sha(shipped), recorded: sha(APPLIED), rowsAtWhen: 1 },
      shipped, noGit, [],
    );
    expect(drift.kind).toBe("allowed");
  });

  it("any other recorded text is refused", () => {
    const other = APPLIED.replace("uuid,", "text,");
    const drift = classifyDrift(
      "cloud", CLOUD_JOURNAL.dir,
      { tag: TAG, when: 1794732061381, expected: sha(shipped), recorded: sha(other), rowsAtWhen: 1 },
      shipped, noGit, [],
    );
    expect(drift.kind).not.toBe("allowed");
  });
});
