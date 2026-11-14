/**
 * REASON WORDS: what a refusal is named with. A word is lower case with underscores and comes
 * from a closed list; the interface never works a reason out from a status code or from a
 * message's text, and a server never invents a word a client has no sentence for without it
 * being added here first.
 */

/**
 * EVERY WORD A SERVER REFUSES WITH — the `code` of the error envelope. The server's `ServiceError`
 * and its `errorResponse` take this type, so a misspelt or unlisted word does not compile; a
 * client's table of sentences is checked against it, so a sentence for a word no server says does
 * not compile either. In alphabetical order; what each means is said where it is thrown.
 */
export type ServiceErrorCode =
  | "account_erased" | "account_locked" | "account_suspended" | "ai_disabled" | "ai_draft_declined"
  | "ai_draft_failed" | "ai_provider_unavailable" | "ai_unavailable" | "approval_denied"
  | "approval_expired" | "approval_used" | "attachment_part_mismatch" | "auto_suggest_required"
  | "body_too_large" | "conflict" | "credential_needed" | "credential_refused"
  | "credential_screened" | "cross_site_denied" | "csrf_failed" | "cursor_expired" | "db_busy"
  | "discover_unconfigured" | "draft_changed" | "draft_sent" | "draft_too_large"
  | "drafter_unconfigured" | "duplicate_send" | "email_taken" | "email_unverified"
  | "enrollment_incomplete" | "erase_not_confirmed" | "erased" | "erasure_contended"
  | "erasure_failed" | "erasure_unconfirmed" | "folders_disabled" | "forbidden" | "forward_mismatch"
  | "forward_not_schedulable" | "forward_original_unavailable" | "forward_parts_changed"
  | "forward_source_moved" | "idempotency_in_progress" | "idempotency_key_required"
  | "idempotency_replay" | "install_key_absent" | "insufficient_credits" | "internal"
  | "internal_error" | "invalid_approval" | "invalid_challenge" | "invalid_code" | "invalid_grant"
  | "invalid_request" | "invalid_session_id" | "invalid_token" | "invite_exists" | "invite_expired"
  | "invite_invalid" | "invite_used" | "junk_body_too_large" | "junk_message_gone" | "letter_gone"
  | "letter_mismatch" | "letter_too_large" | "letter_unreadable" | "mail_server_busy"
  | "mail_server_login_refused" | "mail_server_not_secured" | "mail_server_unreachable"
  | "mail_unconfigured" | "mailbox_busy" | "mailbox_config_changed" | "mailbox_disabled"
  | "mailbox_erased" | "mailbox_exists" | "mailbox_host_refused" | "mailbox_limit_reached"
  | "mailbox_not_permitted" | "mailbox_not_signed_in" | "mailbox_port_refused"
  | "mailbox_probe_failed" | "mailbox_read_timeout" | "mailbox_reconnect_required"
  | "mailbox_signs_in_with_oauth" | "mailbox_stood_down" | "meta_folder_full" | "meta_undeletable"
  | "method_not_allowed" | "no_junk_folder" | "no_manage_surface" | "no_return_confirm"
  | "no_storage_limit" | "no_trash_folder" | "not_found" | "not_in_trash" | "not_organizer"
  | "nothing_to_sweep" | "oauth_device_state_invalid" | "oauth_device_unconfigured"
  | "oauth_exchange_failed" | "oauth_no_address" | "oauth_no_refresh_token" | "oauth_state_expired"
  | "oauth_state_invalid" | "oauth_unconfigured" | "organized_elsewhere"
  | "organizer_host_change_refused" | "organizer_unreadable" | "origin_not_allowed" | "own_address"
  | "pairing_invalid" | "pairing_mint_limit" | "payload_too_large" | "payment_required"
  | "profile_changed" | "profile_document_unreadable" | "profile_newer" | "rate_limited"
  | "read_bound_exceeded" | "refresh_expired" | "refresh_missing" | "refresh_revoked"
  | "remote_content_not_loaded" | "return_not_found" | "return_unconfirmed" | "rule_runs_here"
  | "run_in_flight" | "same_login" | "schedule_files_quota" | "schedule_files_too_far"
  | "schedule_has_files" | "search_direction_unsupported" | "search_superseded"
  | "send_again_changed" | "send_again_in_flight" | "send_again_not_held" | "send_again_unchecked"
  | "send_busy" | "send_key_draft_discarded" | "send_login_refused" | "send_not_secured"
  | "send_recorded" | "send_refused_by_server" | "send_still_running" | "send_timeout"
  | "send_unreachable" | "send_upload_dropped" | "send_withdrawn" | "sensitive_no_ai"
  | "server_error" | "session_conflict" | "shared_provider_domain" | "sign_in_slowed" | "signed_out"
  | "signup_capacity" | "signup_unavailable" | "smtp_not_settled" | "sse_capacity" | "sse_disabled"
  | "sse_too_many_streams" | "staging_quota_exceeded" | "stale_press" | "step_up_required"
  | "stored_login_not_cleared" | "subscription_required" | "suggest_unconfigured"
  | "sync_engine_absent" | "text_kept" | "trash_body_too_large" | "trash_message_gone"
  | "unauthorized" | "unavailable" | "unprocessable" | "unsubscribe_already_recorded"
  | "unsubscribe_author_failed_authentication" | "unsubscribe_budget_spent"
  | "unsubscribe_list_failed" | "unsubscribe_list_refused" | "unsubscribe_mailbox_disconnected"
  | "unsubscribe_mailto_only" | "unsubscribe_no_cutoff" | "unsubscribe_no_header"
  | "unsubscribe_no_limit" | "unsubscribe_not_actionable" | "unsubscribe_not_one_click"
  | "unsubscribe_not_person_decided" | "unsubscribe_previous_attempt_unsettled"
  | "unsubscribe_record_vanished" | "unsubscribe_sender_identity_unverified"
  | "unsubscribe_unconfigured" | "unsupported_grant_type" | "unsupported_media_type"
  | "upstream_failed" | "upstream_unavailable" | "validation_failed" | "waitlist_unconfigured"
  | "workflow_too_many_steps";

/**
 * The `ApiError` envelope: `{ error: { code, message, details?, retryable? } }`. `retryable` is
 * present only when a service stated it; a client that reads none decides by the status.
 */
export interface ErrorEnvelope {
  error: { code: ServiceErrorCode; message: string; details?: unknown; retryable?: boolean };
}

/**
 * Why a filing was refused, as a client reads it: the server's closed set of classes, and
 * `unknown` for a word this build has never heard (a newer server's), which has a sentence too.
 */
export type FilingRefusalReason =
  | "refused" | "no_such_folder" | "read_only" | "over_quota" | "stale_locator" | "unconfirmed" | "unknown";

/** The answers to a write that are not a server's verdict on it: offline, or no session to send it in. */
export type UnjudgedWriteCode = "offline_read_only" | "not_signed_in";

/** The answers that are about the app and its server, never about the write: too old, being updated. */
export type UpdateAnswerCode = "client_too_old" | "server_updating";

/** The words a refused session renewal ends a session with. Any other refusal leaves it standing. */
export type SessionRefusalCode = "refresh_missing" | "refresh_expired" | "refresh_revoked" | "unauthorized";
