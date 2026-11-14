/**
 * The DTO vocabulary of the services, declared once in `@ohmail/wire` and re-exported here under
 * the path this package has always imported it from. Nothing is declared in this file.
 */
export type { EntityType, ChangeOp } from "@trafficflow/db";
export type { MailboxDisabledReason, MailboxErrorCode, MailboxSyncBlockReason, OrganizerKind } from "@trafficflow/db";
export type {
  ApprovalDTO, AwayResponderDTO, ContactDTO, Cursor, DraftDTO, DraftStatus, Folder, FolderDTO, ISODateTime, KbEntryDTO,
  MailboxDTO, MailboxFolderSummary, MailboxProfileDTO, MessageBodyBatchItem, MessageBodyDTO, MessageDTO, MessageStateDTO,
  NoteDTO, NoteTarget, NotifyRuleDTO, Page, RoutingDecisionDTO, RuleDTO, ScreenerItem, ScreenerSuggestionDTO,
  SenderCheckDTO, SensitivityFlags, SettingsDTO, SnapshotResponse, SnapshotWindow, SnippetDTO, SyncChange, SyncResponse,
  TagDTO, ThreadDTO, TrackerEventDTO, TrashRowDTO, TriageState, WithheldMarker, WorkflowDTO, WorkflowProposalDTO,
  WorkflowProposalStatus, WorkflowProvenance, WorkflowRunDTO, WorkflowRunStatus,
} from "@ohmail/wire";
