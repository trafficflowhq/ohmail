/**
 * A NOTICE CHANNEL'S ID AND WORD (`cal_push_channels`), as the pass that opens a channel and the
 * door that takes a notice agree on them. The id is what the provider and this service both name
 * the channel by. The word is what every notice of the channel must carry: it is handed to the
 * provider once, and only its digest is ever stored.
 */
import { createHash } from "node:crypto";

/** A channel's id: a lower-case id of 36 characters, ours where the provider takes one and the provider's own where it does not. */
export const NOTICE_CHANNEL_ID_CHARS = 36;
/** A channel's word: 32 random bytes, written as base64url. */
export const NOTICE_WORD_BYTES = 32;
export const NOTICE_WORD_CHARS = 43;

const ID = /^[0-9a-f-]{36}$/;
const WORD = /^[A-Za-z0-9_-]{43}$/;

/** Is this a channel's id as a row holds one? Decided by its shape, before any statement. */
export const isNoticeChannelId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/** Is this a channel's word as a provider repeats one? Decided by its shape, before any statement. */
export const isNoticeWord = (v: unknown): v is string => typeof v === "string" && WORD.test(v);

/** What is stored of a word: its SHA-256, as 64 lower-case hex characters. */
export const noticeWordDigest = (word: string): string => createHash("sha256").update(word, "utf8").digest("hex");
