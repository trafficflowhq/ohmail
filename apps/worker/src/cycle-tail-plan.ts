/**
 * THE CYCLE TAIL'S SECTIONS, in the order the tail walks them, and the registry passes each runs.
 * `index.ts` builds its table from this list (a missing or extra implementation does not compile),
 * and `test/cycle-tail-census.test.ts` holds it equal to the registry's `cycle-tail` rows. The walk
 * is section-major, so the per-account auto-apply → suggest → act order holds within one tail.
 */
export const TAIL_SECTION_PLAN = [
  { name: "screener_suggest_owed", passes: ["screener_auto_apply", "screener_auto_suggest", "screener_auto_act"] },
  { name: "bubble_up", passes: ["bubble_up"] },
  { name: "workflow", passes: ["workflow_time_scan", "workflow_drain"] },
  { name: "gate_release", passes: ["gate_release"] },
  { name: "sender_check_backfill", passes: ["sender_check_backfill"] },
  // Before the correspondent retro, which asks these rows before it releases a claim (mail 0150).
  { name: "list_address_backfill", passes: ["list_address_backfill"] },
  { name: "rule_retro", passes: ["rule_retro"] },
  { name: "gap_catchup", passes: ["gap_catchup"] },
  { name: "ohbox_tidy", passes: ["ohbox_tidy"] },
  { name: "thread_join_heal", passes: ["thread_join_heal"] },
  { name: "inbound_quiet", passes: ["inbound_quiet"] },
  { name: "away_reply_flag_redeliver", passes: ["away_reply_flag_redeliver"] },
  { name: "storage_evict", passes: ["storage_evict"] },
  { name: "screener_correspondent_retro", passes: ["screener_correspondent_retro"] },
  { name: "screener_auto_apply", passes: ["screener_auto_apply"] },
  { name: "screener_auto_suggest", passes: ["screener_auto_suggest"] },
  { name: "screener_auto_act", passes: ["screener_auto_act"] },
  // Before the search backfill: a letter it fills gets its document in the same transaction.
  { name: "html_words_backfill", passes: ["html_words_backfill"] },
  { name: "search_index_backfill", passes: ["search_index_backfill"] },
  { name: "search_dates_fill", passes: ["search_dates_fill"] },
  { name: "mailbox_erasure", passes: ["mailbox_erasure"] },
  { name: "global_maintenance", passes: ["global_maintenance"] },
] as const;

export type TailSectionName = (typeof TAIL_SECTION_PLAN)[number]["name"];
