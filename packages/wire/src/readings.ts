/**
 * A DEVICE'S READING OF A SERVER'S RECORD, HELD TO THE RECORD.
 *
 * The feed carries a record as `unknown`, so no route's answer ties what the server builds to
 * what a device copy reads of it. Where this package declares both (the server's `…DTO` and the
 * device's reading of it, which is more lenient: a row written by an earlier build, or sent by an
 * earlier server, lacks the later fields), the two are tied here. A reading may name no field the
 * record does not have, and must take each field as the record sends it. A field renamed on the
 * server alone, or one a reading invents, does not compile.
 */
import type { Assert } from "./complete.js";
import type { MessageDTO } from "./mail.js";
import type { EngineMessage, EngineMessageExtras } from "./mirror.js";
import type { MessageBodyBatchItem, MessageBodyBatchWire, MessageBodyDTO, MessageBodyWire } from "./bodies.js";
import type { DraftDTO, EngineDraft } from "./drafts.js";
import type {
  FolderDTO, FolderEntity, MailboxProfileDTO, MailboxProfileEntity, RuleDTO, RuleEntity, TagDTO, TagEntity,
} from "./organizing.js";
import type { ScreenerSuggestionDTO, ScreenerSuggestionEntity } from "./screener.js";

/**
 * `true` while `Reading` reads `Server`: every field of the reading, but for the device's `Own`,
 * is a field of the server's record, and the record fits what the reading expects of it.
 * Otherwise a type that names what broke.
 */
export type Reads<Server, Reading, Own extends keyof Reading = never> =
  [Exclude<keyof Reading, keyof Server | Own>] extends [never]
    ? [Server] extends [Omit<Reading, Own>]
      ? true
      : { "the server's record does not fit the reading": Omit<Reading, Own> }
    : { "the reading names what the server's record does not have": Exclude<keyof Reading, keyof Server | Own> };

type _Message = Assert<Reads<MessageDTO, EngineMessage, keyof EngineMessageExtras>>;
type _Body = Assert<Reads<MessageBodyDTO, MessageBodyWire>>;
/** A reader asks for bodies by id, and on that read the server states the unsubscribe posture of every row. */
type _BodyOfABatch = Assert<Reads<
  MessageBodyBatchItem & Required<Pick<MessageBodyBatchItem, "unsubscribe" | "unsubscribeUrl">>, MessageBodyBatchWire
>>;
type _Draft = Assert<Reads<DraftDTO, EngineDraft, "accepted" | "pendingCreate">>;
type _Folder = Assert<Reads<FolderDTO, FolderEntity>>;
type _Tag = Assert<Reads<TagDTO, TagEntity, "className">>;
type _Rule = Assert<Reads<RuleDTO, RuleEntity>>;
type _MailboxProfile = Assert<Reads<MailboxProfileDTO, MailboxProfileEntity>>;
type _ScreenerSuggestion = Assert<Reads<ScreenerSuggestionDTO, ScreenerSuggestionEntity>>;
