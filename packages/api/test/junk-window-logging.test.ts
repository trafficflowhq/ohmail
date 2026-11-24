import { accountOfMailbox } from "@trafficflow/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ImapAdapter, MessageGoneError } from "@trafficflow/core/adapters/imap";
import { createLogger } from "@trafficflow/core/mail";
import { accountSettings, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { readFileSync } from "node:fs";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { listJunk } from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * SA-R9-06 — THE JUNK WINDOW'S ERROR LOGGING NAMES A CLASS AND A CODE, NEVER A FOLDER.
 *
 * `MessageGoneError` and `EpochUnknownError` both carry a RAW SERVER PATH in their message
 * (`adapters/imap.ts`), and a junk folder is a folder a person made — their own words.
 * `err: String(err)` flattened the throw to a STRING before the logger saw it, and a thrown
 * string's whole text is emitted as `errorText` by design (`core/log.ts`), so the path reached the
 * operator log. Handing the logger the THROWN VALUE instead uses its `err` contract, which is what
 * makes "we never log a driver message" a property of the logger rather than a convention at each
 * call site.
 *
 * The verdict is read off the REAL logger's emitted LINE — never a fake sink's argument — for
 * `log-census`'s own reason: a second copy of the rule is a second thing to get wrong.
 *
 * ── THE SUBJECT MOVED WITH THE RESCUE (mail 0115) ─────────────────────────────────────────
 *
 * The behavioural case used to drive the rescue's husk PRE-FETCH, which left the API when the
 * rescue became a recorded command: the route opens no socket now, so it has no adapter throw to
 * mishandle. The rule is the WINDOW's and not the rescue's — the two READS still dial, and
 * `junk_window_read_failed` is where a folder-naming throw reaches a log line today. That is the
 * subject below. The census half is unchanged and still covers both live-folder windows.
 *
 * Mutation watched red (2026-09-17): restore `err: String(err)` at the list read's catch and this
 * file goes red on both the class assertion and the path assertion; restored from a pristine
 * copy taken before the mutation and proved by `cmp`.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");
const JUNK_PATH = "INBOX/Spamverdacht";

async function seed(): Promise<{
  deps: ApiDeps; db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string; mailboxId: string; lines: string[];
}> {
  const db = await makeTestDb();
  vi.restoreAllMocks();
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  const accountId = randomUUID();
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `junk-${randomUUID().slice(0, 8)}@example.invalid`,
    junkFolder: JUNK_PATH,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  const lines: string[] = [];
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
    // THE REAL LOGGER, with the bytes it hands its sink as the verdict.
    logger: createLogger({ service: "api", level: "debug", sink: (l: string) => { lines.push(l); } }),
    now: () => NOW,
  } as unknown as ApiDeps;
  return { deps, db, accountId, mailboxId: mb!.id, lines };
}

beforeEach(() => vi.restoreAllMocks());

describe("SA-R9-06 — a live junk read that throws a folder-naming error", () => {
  it("logs errorClass and errorCode and NO folder path", async () => {
    const { deps, accountId, mailboxId, lines } = await seed();
    // The shape the adapter's own unconditional epoch guard raises — its message carries the
    // folder's real path, which is exactly what may not reach the line.
    vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockRejectedValue(new MessageGoneError({ folder: JUNK_PATH, ref: "7:2" }));

    const page = await listJunk(deps, accountId);
    // The degrade is STATED — an unreachable window is never an empty list — which is what makes
    // the log line the only place the throw could have leaked.
    expect(page.mailboxes.map((m) => m.window)).toEqual(["unreachable"]);

    const line = lines.find((l) => l.includes("junk_window_read_failed"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    // The class and the code are what an operator needs, and all they get.
    expect(parsed.errorClass).toBe("MessageGoneError");
    expect(parsed.errorCode).toBe("EMSGGONE");
    // The person's folder name is not in the line, in any field.
    expect(line).not.toContain(JUNK_PATH);
    expect(line).not.toContain("Spamverdacht");
    // A thrown STRING's text channel is silent here: this was an Error, not a string.
    expect(parsed.errorText).toBeUndefined();
    // The correlation the line is for survives.
    expect(parsed.mailboxId).toBe(mailboxId);
  });
});

/**
 * THE SAME RULE IN THE TWIN. `trash-window.ts` is `junk-window.ts`'s structural twin — the same
 * live folder read, the same search-append, the same `catch` around an adapter call whose errors
 * name the folder. It carried the identical `err: String(err)`, so fixing one of the pair would
 * have been half a fix. The census reads CODE, not comments, so a re-introduction in either
 * window is visible; the behavioural verdict above is the junk half's.
 */
describe("neither live-folder window hands the logger a stringified throw", () => {
  it.each([
    "packages/api/src/junk-window.ts",
    "packages/api/src/trash-window.ts",
  ])("%s", (rel) => {
    const code = withoutComments(readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8"));
    const hits = [...code.matchAll(/\berr\s*:\s*String\s*\(/g)];
    expect(hits.map((h) => code.slice(h.index, h.index! + 40)), `${rel} stringifies a throw`)
      .toEqual([]);
  });
});
