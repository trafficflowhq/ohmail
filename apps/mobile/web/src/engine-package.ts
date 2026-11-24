/**
 * THE PAGE'S ONE DOOR TO THE CLIENT ENGINE PACKAGE. The shell's page composes the account's one
 * client engine, as the web and the desktop window do; every page file reaches the package through
 * here, so the page names it in one place.
 */
import {
  COMPOSE_FILE_TYPE, COMPOSE_LETTER_TYPE, OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE, ROUTING_JOURNAL_TYPE,
} from "@ohmail/client-engine";

export {
  HttpAdapter, IndexedDbMirrorStore, MIRROR_ENTITY_TYPES, NOTICE_COUNT_MAX, OUTBOX_TYPE, OhmailEngine, ROUTING_JOURNAL_TYPE, SYNC_ENTITY_TYPES,
  calendarChoicesOf, flattenResponse, lost, mailChoicesOf, noticeChoicesOf, readCalendarSnapshot, parseMailto, recordKey, unsentDraftsOf,
} from "@ohmail/client-engine";

/**
 * The rows the store carries through a wipe, by the engine's own type names: what the native keeper
 * holds too. `test/shell-keeper.test.ts` holds this equal to the engine's `isCarriedLocalType`.
 */
const CARRIED: ReadonlySet<string> = new Set([
  OUTBOX_TYPE, OUTBOX_ABANDONED_TYPE, ROUTING_JOURNAL_TYPE, COMPOSE_LETTER_TYPE, COMPOSE_FILE_TYPE,
]);
export const isCarriedLocalType = (type: string): boolean => CARRIED.has(type);
export type { EmailAddress, EngineMutation } from "@ohmail/wire";
export type {
  CalendarNoticeChoices, CalendarSnapshot, IndexedDbMirrorStoreOptions, MailNotice, MailNoticeDetails, MirrorRecord, MirrorStore, Notice,
  NoticeChoices, NoticePermission, NoticeTaken, SyncChange,
} from "@ohmail/client-engine";
