/**
 * The REQUIRED mail-marker set, derived from the mail journal's own SQL rather than from the
 * `MAIL_SCHEMA_MARKERS` list under test. `health.test.ts` used to compute `expected` as
 * `MAIL_SCHEMA_MARKERS.length + …`, so deleting an OLDER marker lowered `expected` and
 * `markersFound` together and the probe assertion stayed green — a database with a silently
 * missing column would then read healthy, the inverted `schema_incomplete` incident. This module
 * reads the journal instead: `deriveMailColumnMarkerCount()` is what the probe assertion pins to,
 * and `health-markers-from-the-journal.test.ts` asserts coverage in both directions.
 *
 * The unit is the migration's own: the mail health markers probe ONE column per migration table
 * facet (see the `MAIL_SCHEMA_MARKERS` docblocks — 0058 marks `folder_state.next_attempt_at` and
 * deliberately not the same pair it also adds to `flag_state`). So a "facet" is a
 * `(creating-migration, table)` pair, and the required set is every facet the journal creates
 * minus a documented grandfather list. Indexes and CHECKs are curated by a semantic the SQL does
 * not carry (a marker exists only where a MISSING object is SILENT), so this module does not
 * derive their coverage — the anti-drift gate and the no-phantom check hold those classes.
 */
import { MAIL_JOURNAL } from "@trafficflow/db/admin";
import {
  parseJournalObjects,
  deriveColumnMarkerCount,
  type JournalObjects,
} from "./journal-marker-derivation.js";

/** The mail journal's objects — {@link JournalObjects} shape, kept as a named alias. */
export type MailJournalObjects = JournalObjects;

/**
 * The mail journal's objects, parsed by the shared {@link parseJournalObjects}. Pinned to the
 * `[a-z_]+` identifier class the mail derivation was written against, so its numbers stay
 * byte-for-byte — the wider default would newly capture `attachments.content_sha256` and move the
 * mail facet count.
 */
export const parseMailJournalObjects = (): MailJournalObjects =>
  parseJournalObjects(MAIL_JOURNAL, { identifier: "[a-z_]+" });

/**
 * The GRANDFATHER list: `(migration, table)` column facets that carry no `MAIL_SCHEMA_MARKERS`
 * entry today, each with the reason it is deliberately unprobed. Measured 2026-09-14 against the
 * 0108 journal: 129 facets exist, 88 are probed (4 of them twice — see below), and these 41 are
 * the pre-existing gap. The test starts green on this list and any NEW unmarked facet reddens it,
 * so a migration author must add a marker or extend this list with a reason.
 *
 * Two shapes recur: (baseline) a pre-split facet certified as a whole by adoption
 * (`baseline.ts#missingObjects`), not by per-migration health markers; and (one-per-migration)
 * a facet whose migration IS probed through a different, sharper facet — the design's rule.
 */
export const COLUMN_FACET_ALLOWLIST: Record<string, string> = {
  // Baseline era (≤ 0016, pre-split): the baseline schema is certified by adoption, not by
  // per-migration health markers. A request path that touches one of these tables is covered by
  // the table's own key-column marker where it has one; the extra facets ride the baseline.
  "0000_wealthy_miek|audit_log": "baseline: staff audit ledger, not on a certified API read path",
  "0000_wealthy_miek|mailbox_folders": "baseline: mailbox_folders is later probed at 0083.server_exists",
  "0001_cute_black_queen|contacts": "baseline: contacts carries no health marker (not request-critical)",
  "0001_cute_black_queen|rules": "baseline: rules is probed by its later ALTER markers (0034, 0050, 0107)",
  "0002_wet_thunderball|approvals": "baseline: approvals ledger, not on a certified API read path",
  "0002_wet_thunderball|message_bodies": "baseline: message_bodies is probed at 0062.withheld_reason",
  "0002_wet_thunderball|message_states": "baseline: message_states carries no health marker",
  "0002_wet_thunderball|messages": "baseline: messages is probed by its markers (id, last_read_at, …)",
  "0002_wet_thunderball|routing_decisions": "baseline: routing_decisions ledger, no marker",
  "0002_wet_thunderball|rules": "baseline: rules is probed by its later ALTER markers",
  "0002_wet_thunderball|threads": "baseline: threads is probed at 0026.root_message_id_header",
  "0003_identity_core|devices": "baseline: devices is probed at 0064.last_synced_at",
  "0003_identity_core|sessions": "baseline: sessions is probed at 0017.scope and 0070.last_synced_at",
  "0004_graduations|graduations": "baseline: graduations (learning) carries no health marker",
  "0005_warm_black_bird|learning_signals": "baseline: learning_signals carries no health marker",
  "0007_amusing_nextwave|mailboxes": "baseline: mailboxes is probed by many later markers (id, …)",
  "0009_tracker_events|tracker_events": "baseline: tracker_events ledger carries no health marker",
  "0010_optimal_roland_deschain|away_responders": "baseline: away_responders is probed at 0052.audience",
  "0010_optimal_roland_deschain|contact_notes": "baseline: contact_notes carries no health marker",
  "0010_optimal_roland_deschain|contacts": "baseline: contacts carries no health marker",
  "0010_optimal_roland_deschain|notify_rules": "baseline: notify_rules carries no health marker",
  "0010_optimal_roland_deschain|snippets": "baseline: snippets carries no health marker",
  "0010_optimal_roland_deschain|thread_notes": "baseline: thread_notes carries no health marker",
  "0011_attachments|attachments": "baseline: attachments carries no health marker (not request-critical)",
  "0012_spicy_gravity|drafts": "baseline: drafts is probed at 0037.html / 0045.bcc / 0077.send_at",
  "0012_spicy_gravity|kb_entries": "baseline: kb_entries carries no health marker",
  "0013_outbound_sends|outbound_sends": "baseline: outbound_sends is probed at 0095.resolved_by",
  "0014_bent_lady_deathstrike|workflow_runs": "baseline: workflow_runs is probed at 0033.claimed_at",
  "0014_bent_lady_deathstrike|workflows": "baseline: workflows carries no health marker",
  "0015_workflow_step_dedup|drafts": "baseline: drafts is probed by its later ALTER markers",
  "0015_workflow_step_dedup|kb_entries": "baseline: kb_entries carries no health marker",
  "0016_workflow_proposals|workflow_proposals": "baseline: workflow_proposals carries no health marker",
  // Post-baseline: one marker per migration is the design (health.ts) — these migrations ARE
  // probed, through the sharper facet named.
  "0028_message_instances|messages": "one-per-migration: 0028 is probed at message_instances.is_primary",
  "0032_unsubscribe_records|unsubscribe_records": "unsubscribe ledger; no API path selects it (a staff read would be a delivery oracle), so no marker",
  "0058_reconcile_backoff|flag_state": "one-per-migration: 0058 is probed at folder_state.next_attempt_at (same pair added to flag_state)",
  "0069_folders_enabled_reissue|account_settings": "reissue of 0066 (REISSUED_ORIGINALS); folders_enabled_at is already probed by 0066",
  "0087_away_reply_throttle|away_replies": "away-reply ledger; worker-only, not on a certified API read path",
  "0087_away_reply_throttle|away_sender_state": "one-per-migration: 0087 is probed at away_responders.throttle; away_sender_state is later probed at 0096.undeliverable_at",
};

/**
 * The three facets the design deliberately probes TWICE — two `MAIL_SCHEMA_MARKERS` entries on one
 * `(migration, table)` — because the two columns answer different questions (see the
 * `MAIL_SCHEMA_MARKERS` docblocks). They are the difference between "88 required facets" and "92
 * column markers", and pinning them here keeps `deriveMailColumnMarkerCount()` exact without
 * reading the list under test.
 */
export const DELIBERATE_DOUBLE_PROBES: Record<string, string> = {
  "0078_inbound_quiet|mailboxes": "inbound_quiet_since (worker evidence) and inbound_quiet_dismissed_at (user dismissal)",
  "0083_organizer_role|mailboxes": "organizer_role (the gate) and organize_consented_at (the ceremony record)",
  "0083_organizer_role|account_settings": "onboarding_completed_at and screening_scope",
};

/**
 * The required number of mail COLUMN markers, from the journal and the two allow-lists above —
 * never from `MAIL_SCHEMA_MARKERS.length`. Every facet the journal creates that is not
 * grandfathered needs one marker, and the four double-probed facets need a second. A dropped
 * marker leaves this number unchanged, so the probe assertion it anchors turns red.
 */
export function deriveMailColumnMarkerCount(objects: MailJournalObjects = parseMailJournalObjects()): number {
  return deriveColumnMarkerCount(objects, COLUMN_FACET_ALLOWLIST, DELIBERATE_DOUBLE_PROBES);
}
