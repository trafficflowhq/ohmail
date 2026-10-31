import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, auditLog, changeLog, mailboxes, mailboxFolders, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION,
} from "@trafficflow/db";
import {
  makeProfileDoc, profileFingerprint, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import {
  SyncService, setAutoSuggest, setBlockAutoUnsubscribe, setBlockRemoteImages,
  setBlockTrackingPixels, setDormancyDays, setFoldersEnabled, setLocale, effectiveMailboxSignatures, profileImportService,
  setMailboxFoldersEnabled, setThemeFace,
  type ServiceContext, type SettingsDTO,
} from "../src/index.js";

/**
 * ═══ A SETTINGS WRITE TRAVELS THE SYNC CHANNEL — the `settings` entity ═══════════════════════
 *
 * The measured defect (owner, live): disabling folders in a browser left an open desktop window
 * drawing the folders group — an empty "no folders" husk over tombstoned entities — until the
 * app was restarted, and the reading-pane image/tracker postures went equally stale on every
 * other signed-in surface. Root shape: the consent answer was read at boot and never refreshed,
 * because nothing about a settings write ever reached the change log — the wake channel had
 * nothing to ring and the delta feed nothing to carry.
 *
 * The fix in this seam: EVERY consent-settings writer appends one `settings` change row
 * (`entity_id` = the account id, op always `"update"`) in the SAME transaction as its column.
 * `recordChanges` NOTIFYs the wake channel at commit — the chokepoint
 * `change-notify-chokepoint.test.ts` already proves — so both directions of the cross-surface
 * story reduce to the same two facts proven here:
 *
 *  · web → desktop: the browser's PATCH lands here, the row rings the hosted wake, the sidecar
 *    mirror pulls it and re-emits it locally (`apps/sidecar/test/cloud-mirror-settings.test.ts`),
 *    and the desktop shell's stamp effect re-asks `GET /consent`;
 *  · desktop → web: the desktop's PATCH is FORWARDED verbatim to this same writer
 *    (`apps/desktop/test/desktop-cloud-settings.test.tsx` pins the forward), so it lands on the
 *    identical row and the identical ring; the browser's wake stream drains and its shell
 *    re-asks (`apps/webapp/test/settings-propagation.test.tsx`).
 *
 * Also pinned: the entity NEVER materializes as a tombstone. "No settings row yet" is a real
 * state (every knob at its default, created lazily), and `SyncService` reads a null entity as a
 * DELETE — so `materializeSettings` must answer the default-shaped DTO for an account whose row
 * does not exist. `setMailboxFoldersEnabled` is exactly that case: it writes `mailboxes` only.
 */

const svc = new SyncService();

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "own@example.com" }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-08-26T00:00:00.000Z"), requestId: "r",
  };
  return { db, accountId, mailboxId: mb.id, ctx };
}

async function settingsRows(db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string) {
  return db.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId),
    eq(changeLog.entityType, "settings"),
  ));
}

type AnyChange = { type: string; op: string; id: string; entity?: unknown };
const settingsChanges = (page: {
  changes: { creates: AnyChange[]; updates: AnyChange[]; moves: AnyChange[]; deletes: AnyChange[] };
}) => ({
  updates: [...page.changes.creates, ...page.changes.updates, ...page.changes.moves]
    .filter((c) => c.type === "settings"),
  deletes: page.changes.deletes.filter((c) => c.type === "settings"),
});

describe("every consent-settings writer appends the settings change row, in its own transaction", () => {
  it("one row per write, entity_id = the account id, op = update — all nine writers", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();

    const writers: Array<[string, () => Promise<unknown>]> = [
      ["setFoldersEnabled", () => setFoldersEnabled(ctx, true)],
      ["setMailboxFoldersEnabled", () => setMailboxFoldersEnabled(ctx, mailboxId, false)],
      ["setBlockRemoteImages", () => setBlockRemoteImages(ctx, false)],
      ["setBlockTrackingPixels", () => setBlockTrackingPixels(ctx, false)],
      ["setBlockAutoUnsubscribe", () => setBlockAutoUnsubscribe(ctx, true)],
      ["setDormancyDays", () => setDormancyDays(ctx, 30)],
      ["setAutoSuggest", () => setAutoSuggest(ctx, true)],
      ["setLocale", () => setLocale(ctx, "de")],
      ["setThemeFace", () => setThemeFace(ctx, "ohmarchy")],
    ];

    let before = 0;
    for (const [name, run] of writers) {
      await run();
      const rows = await settingsRows(db, accountId);
      expect(rows.length, `${name} appended no settings change row — its write rings no wake`)
        .toBe(before + 1);
      before = rows.length;
      const last = rows[rows.length - 1]!;
      expect(last.entityId).toBe(accountId);
      expect(last.op).toBe("update");
    }
  });

  it("the master folders toggle rings even for an account with ZERO user folders", async () => {
    // The folder creates/deletes cover an inventoried account; an account with no user folders
    // appends no entity rows at all, so the settings row is the ONLY thing that can ring the
    // wake for its flip — the case that stayed silent for ever before this seam existed.
    const { db, accountId, ctx } = await setup();
    await setFoldersEnabled(ctx, true);
    const rows = await settingsRows(db, accountId);
    expect(rows).toHaveLength(1);
  });
});

describe("the delta materializes the settings entity — and never as a tombstone", () => {
  it("carries the row's own scalars and the per-mailbox exceptions", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    await db.insert(mailboxFolders)
      .values({ mailboxId, folder: "Projects/Acme", uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n });

    await setFoldersEnabled(ctx, true);
    await setBlockRemoteImages(ctx, true);
    await setMailboxFoldersEnabled(ctx, mailboxId, false);

    const delta = await svc.getChanges(ctx, { since: "0" });
    const { updates, deletes } = settingsChanges(delta);
    expect(deletes).toHaveLength(0);
    expect(updates.length).toBeGreaterThan(0);
    const entity = updates[updates.length - 1]!.entity as SettingsDTO;
    expect(entity.accountId).toBe(accountId);
    expect(entity.foldersEnabledAt).not.toBeNull();
    expect(entity.blockRemoteImagesAt).not.toBeNull();
    expect(entity.folderMailboxesOff[mailboxId]).toBeTruthy();
    // The stamp a client compares — it must be the row's own, not an invented instant.
    expect(entity.updatedAt).toBe("2026-08-26T00:00:00.000Z");
  });

  it("an account with NO settings row drains a default-shaped UPDATE, never a delete", async () => {
    // `setMailboxFoldersEnabled` writes `mailboxes` alone — no `account_settings` row exists
    // afterwards. If `materializeSettings` answered null here, `SyncService` would emit this
    // change as a DELETE and every mirror would tombstone a record that means "all defaults".
    const { accountId, mailboxId, ctx } = await setup();
    void accountId;
    await setMailboxFoldersEnabled(ctx, mailboxId, false);

    const delta = await svc.getChanges(ctx, { since: "0" });
    const { updates, deletes } = settingsChanges(delta);
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
    const entity = updates[0]!.entity as SettingsDTO;
    expect(entity.foldersEnabledAt).toBeNull();
    expect(entity.dormancyDays).toBeNull();
    expect(entity.folderMailboxesOff[mailboxId]).toBeTruthy();
  });

  /**
   * THE STAMP MOVES ON A PER-MAILBOX FLIP — a review finding. The exception lives on
   * `mailboxes`, but the entity's `updatedAt` is the `account_settings` row's own; a client that
   * already holds the entity compares stamps and ignores a re-apply whose stamp did not move, so
   * a per-mailbox flip that left the row untouched was a doorbell nobody could hear. The writer
   * now touches the row in the same transaction — including creating it for an account that has
   * never written a knob.
   */
  it("a per-mailbox flip moves the entity's stamp, so a stamp-watching client re-asks", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "own@example.com" }).returning();
    let tick = 0;
    const ctx: ServiceContext = {
      db, accountId, userId: null,
      now: () => new Date(Date.parse("2026-08-26T00:00:00.000Z") + ++tick * 1_000),
      requestId: "r",
    };
    await setBlockRemoteImages(ctx, true); // establishes the row and a first stamp
    const first = await svc.getChanges(ctx, { since: "0" });
    const before = settingsChanges(first).updates.pop()!.entity as SettingsDTO;

    await setMailboxFoldersEnabled(ctx, mb.id, false);
    const second = await svc.getChanges(ctx, { since: "0" });
    const after = settingsChanges(second).updates.pop()!.entity as SettingsDTO;
    expect(after.folderMailboxesOff[mb.id]).toBeTruthy();
    expect(after.updatedAt > before.updatedAt,
      `the stamp did not move (${before.updatedAt} → ${after.updatedAt}) — the flip is silent to stamp watchers`,
    ).toBe(true);
  });

  /**
   * THE DOORBELL RIDES SNAPSHOT PAGE 1 — a review finding on the bootstrap race: a settings
   * write landing between a fresh mirror's boot consent read and the snapshot's `asOfSeq` sits
   * BELOW the cursor the snapshot commits, so the delta never delivers it and the tab holds
   * stale consent until the next settings write. Page 1 therefore carries the entity — one row,
   * default-shaped even before the first knob write — so every bootstrap starts with a stamp.
   */
  it("snapshot page 1 carries exactly one settings entity", async () => {
    const { ctx, accountId } = await setup();
    const snap = await svc.getSnapshot(ctx, {});
    const rows = (snap.changes as Array<{ type: string; id: string; op: string; entity: unknown }>)
      .filter((c) => c.type === "settings");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("create");
    expect(rows[0]!.id).toBe(accountId);
    const entity = rows[0]!.entity as SettingsDTO;
    expect(entity.foldersEnabledAt).toBeNull(); // default-shaped: no knob has been written
  });
});

/**
 * IMPORT RINGS THE DOORBELL. Import writes the copy's signature to the re-added mailbox, and a
 * window holds the signature map from `GET /consent` until the settings stamp moves; an import
 * that left the stamp and the change log alone was a write no window ever saw.
 */
describe("Import settings brings the signature back to every window", () => {
  it("a removed row beside the re-added one: the drain carries a later stamp, the live row is served", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const OLD = "-- \nthe old sign-off";
    await db.insert(accounts).values({ id: accountId, name: `sig-${accountId.slice(0, 8)}` });
    const [gone] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "own@example.com", status: "disabled", signature: OLD,
    }).returning();
    const [live] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "own@example.com" }).returning();
    let tick = 0;
    const ctx: ServiceContext = {
      db, accountId, userId: null,
      now: () => new Date(Date.parse("2026-08-26T00:00:00.000Z") + ++tick * 1_000), requestId: "r",
    };
    await setBlockRemoteImages(ctx, true); // a first stamp, as every window holds one
    const before = settingsChanges(await svc.getChanges(ctx, { since: "0" })).updates.pop()!.entity as SettingsDTO;

    const doc = makeProfileDoc({
      screener: [{ address: "anna@example.com" }], rules: [], notifyRules: [], awayResponder: null,
      tagNames: [], signature: OLD,
    }, { updatedAt: new Date("2026-08-20T00:00:00.000Z"), producer: { kind: "local", version: "0.30.20" } });
    const read = async (): Promise<ProfileReadResult> => ({
      state: "found", doc, installId: "elsewhere", ref: 1, residue: 0, generation: 1,
    });
    const first = await profileImportService.apply(ctx, live!.id, { fingerprint: profileFingerprint(doc) }, { read });

    const after = settingsChanges(await svc.getChanges(ctx, { since: "0" })).updates.pop()!.entity as SettingsDTO;
    expect(after.updatedAt > before.updatedAt,
      `the import left the stamp at ${before.updatedAt}: no window re-asks for the signature`).toBe(true);
    expect("seq" in first && first.seq, "the signature write appended no change row").not.toBeNull();
    const served = await effectiveMailboxSignatures(db as never, accountId);
    expect(served.signatures[live!.id]).toBe(OLD);
    expect(gone!.id in served.signatures, "the removed row's signature is served").toBe(false);

    const rows = (await settingsRows(db, accountId)).length;
    await db.delete(auditLog).where(eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION));
    const again = await profileImportService.apply(ctx, live!.id, { fingerprint: profileFingerprint(doc) }, { read });
    expect("seq" in again && again.seq).toBeNull();
    expect((await settingsRows(db, accountId)).length, "an import that changed nothing rang the doorbell").toBe(rows);
    const later = settingsChanges(await svc.getChanges(ctx, { since: "0" })).updates.pop()!.entity as SettingsDTO;
    expect(later.updatedAt, "an import that changed nothing moved the stamp every window compares").toBe(after.updatedAt);
  });
});
