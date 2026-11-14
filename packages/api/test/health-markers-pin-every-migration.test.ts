import { describe, it, expect } from "vitest";
import { MAIL_JOURNAL, CLOUD_JOURNAL } from "@trafficflow/db/admin";
import {
  MAIL_SCHEMA_MARKERS, SCHEMA_INDEX_MARKERS, SCHEMA_CHECK_MARKERS, MAIL_CHECK_DEFINITION_MARKERS,
  MAIL_COLUMN_TYPE_MARKERS, MAIL_FUNCTION_MARKERS, SCHEMA_FK_MARKERS,
} from "../src/routes/health-markers.js";
import {
  CLOUD_SCHEMA_MARKERS, CLOUD_INDEX_MARKERS, CLOUD_CHECK_DEFINITION_MARKERS, CLOUD_FK_MARKERS,
  CLOUD_FUNCTION_MARKERS,
} from "../src/routes/health-cloud.js";
import {
  droppedByTheJournal, entryObjects, markersOfDroppedObjects, pinsByMigration, unpinnedVerdict, type MarkerSet,
} from "./journal-marker-derivation.js";

/**
 * EVERY MIGRATION THE CENSUS CAN PROVE IS PINNED BY A MARKER ITS OWN SQL CREATES. The column class
 * is derived from the journal and the definition and type classes carry per-entry pins, but the
 * index, CHECK-name, key and cloud-index lists were held only by the newest-tag gate and the
 * no-phantom check: deleting the only probe of mail 0118, mail 0071 or cloud 0034 left every reader
 * green, and mail 0018 had never been probed. A database the `when` watermark skipped an older
 * migration on is visible only through that migration's own marker.
 */

const MAIL: MarkerSet = {
  columns: MAIL_SCHEMA_MARKERS, indexes: SCHEMA_INDEX_MARKERS, checks: SCHEMA_CHECK_MARKERS,
  definitions: MAIL_CHECK_DEFINITION_MARKERS, types: MAIL_COLUMN_TYPE_MARKERS,
  foreignKeys: SCHEMA_FK_MARKERS, functions: MAIL_FUNCTION_MARKERS,
};
const CLOUD: MarkerSet = {
  columns: CLOUD_SCHEMA_MARKERS, indexes: CLOUD_INDEX_MARKERS, checks: [],
  definitions: CLOUD_CHECK_DEFINITION_MARKERS, types: [], foreignKeys: CLOUD_FK_MARKERS,
  functions: CLOUD_FUNCTION_MARKERS,
};
// The mail derivation's identifier class (`mail-marker-derivation.ts`); cloud takes the default.
const mailPins = (m: MarkerSet = MAIL) => pinsByMigration(MAIL_JOURNAL, m, { identifier: "[a-z_]+" });
const cloudPins = (m: MarkerSet = CLOUD) => pinsByMigration(CLOUD_JOURNAL, m);

const BASELINE = "baseline era (at or before 0016): certified by adoption (`baseline.ts`), not by a per-migration marker";

/** Provable mail migrations no marker pins, each with its reason. The list may only shrink. */
const MAIL_UNPINNED: Record<string, string> = {
  "0001_cute_black_queen": `${BASELINE}; contacts and rules`,
  "0004_graduations": `${BASELINE}; the graduations ledger`,
  "0005_warm_black_bird": `${BASELINE}; learning_signals`,
  "0009_tracker_events": `${BASELINE}; the tracker ledger`,
  "0010_optimal_roland_deschain": `${BASELINE}; notes, snippets, notify rules, away_responders`,
  "0011_attachments": `${BASELINE}; attachments`,
  "0012_spicy_gravity": `${BASELINE}; drafts and kb_entries`,
  "0013_outbound_sends": `${BASELINE}; outbound_sends`,
  "0014_bent_lady_deathstrike": `${BASELINE}; workflows and workflow_runs`,
  "0015_workflow_step_dedup": `${BASELINE}; the workflow dedup keys`,
  "0016_workflow_proposals": `${BASELINE}; workflow_proposals`,
  "0032_unsubscribe_records": "the unsubscribe ledger: no API path selects it (a staff read would be a delivery oracle)",
  "0068_retire_device_sync_fn": "drops 0067's function; nothing to probe, and its absence is the same tolerated state",
  "0069_folders_enabled_reissue": "a reissue of 0066 (REISSUED_ORIGINALS); folders_enabled_at is probed at 0066",
};

/** Provable cloud migrations no marker pins, each with its reason. The list may only shrink. */
const CLOUD_UNPINNED: Record<string, string> = {
  "0000_auth_ceremony": "baseline: the identity tables, certified by adoption (`baseline.ts#baselineObjects`)",
  "0001_push_subscriptions": "baseline: push_subscriptions, certified by adoption; not on a certified API read path",
  "0032_retire_billing_tables": "table and function DROPS only: an untaken drop costs disk, and no class probes an absence",
  "0049_alert_driver_gaps_staff_grant": "a GRANT to `ohmail_admin` only, and only where that role exists: no class probes a privilege, /health reads as the runtime role, and an untaken grant fails the API arm's alert stamp, which the worker reports as that arm dark",
  "0059_account_storage_holds_staff_grant": "a GRANT to `ohmail_admin` only, and only where that role exists: no class probes a privilege, /health reads as the runtime role, and an untaken grant leaves the API arm's storage-cap rule refused, which its alert pass reports as unread",
};

const without = <T,>(list: ReadonlyArray<T>, pred: (e: T) => boolean): ReadonlyArray<T> => {
  const out = list.filter((e) => !pred(e));
  expect(out.length, "the deletion under test removed exactly one entry").toBe(list.length - 1);
  return out;
};

describe("every provable migration is pinned by a /health marker its own SQL creates", () => {
  it("mail: pinned, or unpinned with a reason", () => {
    const v = unpinnedVerdict(mailPins(), MAIL_UNPINNED);
    expect(v.missing, "a mail migration no marker pins — add the marker, or list it with the reason").toEqual([]);
  });

  it("cloud: pinned, or unpinned with a reason", () => {
    const v = unpinnedVerdict(cloudPins(), CLOUD_UNPINNED);
    expect(v.missing, "a cloud migration no marker pins — add the marker, or list it with the reason").toEqual([]);
  });

  it("the unpinned lists only shrink: a pinned or unknown entry refuses, and every reason is written", () => {
    for (const [pins, list] of [[mailPins(), MAIL_UNPINNED], [cloudPins(), CLOUD_UNPINNED]] as const) {
      const v = unpinnedVerdict(pins, list);
      expect(v.stale, "a listed migration IS pinned — the entry would hide a later drop of its marker").toEqual([]);
      expect(v.unknown, "a listed name is not a provable entry of this journal").toEqual([]);
      for (const [tag, why] of Object.entries(list)) expect(why.trim().length, `${tag} has no reason`).toBeGreaterThan(0);
    }
    // THE CONTROL: a pinned entry and an unknown name, each refused through the same verdict.
    const v = unpinnedVerdict(mailPins(), { ...MAIL_UNPINNED, "0118_account_isolation": "x", "9999_nothing": "x" });
    expect(v.stale).toEqual(["0118_account_isolation"]);
    expect(v.unknown).toEqual(["9999_nothing"]);
  });

  it("every sparse marker pins a migration that creates its object", () => {
    // Stronger than the no-phantom check: the object must be CREATED, in its creating form.
    expect(mailPins().idle, "a mail marker pins no migration").toEqual([]);
    expect(cloudPins().idle, "a cloud marker pins no migration").toEqual([]);
  });

  it("each definition needle is written by the newest creation of its constraint and by no earlier one", () => {
    for (const r of [mailPins(), cloudPins()]) {
      expect(r.definitions.length).toBeGreaterThan(0);
      for (const d of r.definitions)
        expect(d.writers, `${d.marker}: the needle does not tell this migration's database from the one before`)
          .toEqual([d.creators[d.creators.length - 1]]);
    }
  });

  it("only the census's provable entries are asked: data-only and validate-only are not", () => {
    const mail = mailPins().pins;
    const cloud = cloudPins().pins;
    expect(mail.has("0085_heal_disabled_readers"), "a data-only migration was asked for a marker").toBe(false);
    expect(cloud.has("0045_attachment_staging_digest_validate"), "a validate-only one was asked").toBe(false);
    expect(mail.has("0083_organizer_role"), "a migration with DDL and backfills was skipped").toBe(true);
  });
});

describe("the deletions this census exists for are each red, and the ordinary case is admitted", () => {
  it("the ordinary case: the lists as they stand leave nothing missing", () => {
    expect(unpinnedVerdict(mailPins(), MAIL_UNPINNED).missing).toEqual([]);
    expect(unpinnedVerdict(cloudPins(), CLOUD_UNPINNED).missing).toEqual([]);
  });

  it.each([
    ["messages_id_account_uq", "0118_account_isolation"],
    ["message_bodies_withheld_idx", "0071_withheld_provenance_index"],
    ["users_email_unique_idx", "0018_login_email_identity"],
  ])("mail: without the %s index marker, %s is unpinned", (name, tag) => {
    const m = { ...MAIL, indexes: without(SCHEMA_INDEX_MARKERS, ([n]) => n === name) };
    expect(unpinnedVerdict(mailPins(m), MAIL_UNPINNED).missing).toEqual([tag]);
  });

  it("cloud: without the webauthn_challenges_expires_idx marker, 0034 is unpinned", () => {
    const m = { ...CLOUD, indexes: without(CLOUD_INDEX_MARKERS, ([n]) => n === "webauthn_challenges_expires_idx") };
    expect(unpinnedVerdict(cloudPins(m), CLOUD_UNPINNED).missing).toEqual(["0034_webauthn_challenge_expiry"]);
  });

  it("a key pins only its newest creator: without the rule key's marker, 0153 is unpinned and 0118 is not", () => {
    // 0118 created the key and 0153 recreated it with its delete action; 0118 keeps its own markers.
    const m = { ...MAIL, foreignKeys: without(SCHEMA_FK_MARKERS, ([n]) => n === "routing_decisions_matched_rule_id_account_fk") };
    expect(unpinnedVerdict(mailPins(m), MAIL_UNPINNED).missing).toEqual(["0153_rule_revoke_keeps_its_decisions"]);
  });

  it("a CHECK name pins only its first creator: without the newest needle, the replacements are unpinned", () => {
    // `away_responders_piles_closed` is made by 0096 and replaced under its name by 0101 and 0123.
    // A name probe cannot tell either replacement from 0096; the definition's needle does.
    const m = { ...MAIL, definitions: without(MAIL_CHECK_DEFINITION_MARKERS, ([n]) => n === "away_responders_piles_closed") };
    expect(unpinnedVerdict(mailPins(m), MAIL_UNPINNED).missing).toEqual(["0101_away_piles_wider", "0123_news_pile_check"]);
  });

  it("the seven entries that made and widened a list mail 0202 dropped ask for no marker", () => {
    // 0029 made `mailboxes_sync_blocked_reason_closed`; 0102, 0105, 0124, 0142, 0143 and 0185
    // replaced it under its name. The constraint is gone, so nothing in a catalog records them.
    const pins = mailPins();
    for (const tag of ["0102_sync_blocked_reason_read_limited", "0105_sync_blocked_reason_clock_off",
      "0124_sync_blocked_reason_account_closed", "0142_sync_blocked_reason_meta_folder_full",
      "0143_sync_blocked_reason_meta_undeletable", "0185_sync_blocked_reason_mailbox_full"]) {
      expect(unpinnedVerdict(pins, MAIL_UNPINNED).missing, tag).not.toContain(tag);
    }
    expect(unpinnedVerdict(pins, MAIL_UNPINNED).missing).toEqual([]);
  });
});

describe("what a later entry dropped asks for no marker, and no marker names it", () => {
  it("no marker probes an object the journal has dropped: it would hold /health at 503 for ever", () => {
    expect(markersOfDroppedObjects(MAIL_JOURNAL, MAIL)).toEqual([]);
    expect(markersOfDroppedObjects(CLOUD_JOURNAL, CLOUD)).toEqual([]);
  });

  it("a marker left behind on a dropped column, index or function is red", () => {
    const gone = droppedByTheJournal(MAIL_JOURNAL).gone;
    // Mail 0200 took these three; each was probed until it did.
    expect([...gone]).toEqual(expect.arrayContaining([
      "index messages_account_arrival_order_idx", "index messages_account_mailbox_unread_idx", "function message_bodies_body_tsv_bounded",
    ]));
    const left: MarkerSet = {
      ...MAIL,
      indexes: [...SCHEMA_INDEX_MARKERS, ["messages_account_arrival_order_idx", "x"]],
      functions: [...MAIL_FUNCTION_MARKERS, ["message_bodies_body_tsv_bounded", "x"]],
      columns: [...MAIL_SCHEMA_MARKERS, ["messages", "subject_tsv"]],
    };
    expect(markersOfDroppedObjects(MAIL_JOURNAL, left)).toEqual([
      "column messages.subject_tsv", "index messages_account_arrival_order_idx", "function message_bodies_body_tsv_bounded",
    ]);
  });

  it("an entry whose every object was dropped is asked for no marker; one that keeps an object still is", () => {
    const { retired, gone } = droppedByTheJournal(MAIL_JOURNAL);
    expect(retired.has("0008_hybrid_search"), "its columns and indexes left with 0200").toBe(true);
    expect(mailPins().pins.has("0008_hybrid_search")).toBe(false);
    // 0125 made the History index, which stays, beside objects 0200 dropped: still provable.
    expect(gone.has("index messages_account_msg_order_idx")).toBe(false);
    expect(retired.has("0125_message_search")).toBe(false);
    expect(mailPins().pins.has("0125_message_search")).toBe(true);
  });

  it("reads what one entry makes and drops, a guarded drop and a table's columns included", () => {
    const o = entryObjects(`CREATE TABLE "t" (\n  "id" uuid,\n  "n" integer\n);
      CREATE INDEX IF NOT EXISTS "t_n_idx" ON "t" USING btree ("n");
      ALTER TABLE "u" DROP COLUMN IF EXISTS "old", ADD COLUMN "fresh" text;
      DROP INDEX IF EXISTS "u_old_idx"; DROP FUNCTION IF EXISTS "f"(); DROP TRIGGER "tg" ON "u";`);
    expect(o.made.map((m) => m.key)).toEqual(["table t", "column t.id", "column t.n", "index t_n_idx", "column u.fresh"]);
    expect(o.dropped.map((m) => m.key)).toEqual(["column u.old", "index u_old_idx", "function f", "trigger tg"]);
  });
});
