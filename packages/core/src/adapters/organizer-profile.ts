import { createHash } from "node:crypto";
import { META_FOLDER, makeMetaFolderRef, lastSequence, type MetaFolderClient } from "./organizer-lease.js";
import { ImapDeadline, IMAP_META_DEADLINE_MS } from "./imap-bounds.js";
import {
  assertMetaIdentity, readMemo, writeMemo, forgetMemo,
  type MetaIdentity, type Generation,
} from "./meta-memo.js";

/**
 * The portable organizer profile — how a mailbox carries its own organizer configuration. The
 * lease answers WHO organizes; this document answers HOW, in the same `ohmail/_meta`. One RFC822
 * message: `X-Ohmail-Profile: 1` discriminates, `X-Ohmail-Install-Id` names the writer, the body
 * is a human preamble plus the JSON document. Format v1, public and FROZEN: natural keys only,
 * never a row id; a screen-out is a rule to `ohmail/Screened`. Unknown fields are ignored; only a
 * greater `v` is refused, as a typed `newer` result the writer will not overwrite; absence means
 * defaults. Never secrets, never adaptive state. Update = append new, THEN expunge old; readers
 * coalesce by `updatedAt`. Only the active organizer writes.
 */

/** The profile format version this build writes and fully understands. */
export const PROFILE_VERSION = 1;

/**
 * How many uids go into one FETCH command when the settings records are addressed by uid. Keeps
 * both the command line and the in-flight reply bounded regardless of how many the server named.
 */
const PROFILE_FETCH_BATCH = 100;

/** How wide one descending UID window is when searching for settings records. */
const PROFILE_SEARCH_UID_WINDOW = 500;

/** How many windows one search may walk before it reports that it could not ask. */
const PROFILE_SEARCH_WINDOW_BUDGET = 20;

/** The discriminator and bookkeeping headers. The lease's `H` table, for the profile. */
const H = {
  profile: "X-Ohmail-Profile",
  installId: "X-Ohmail-Install-Id",
} as const;

/**
 * DOES THIS MESSAGE CLAIM TO BE A PROFILE AT ALL — the cheap pre-filter the bounded read retains on.
 *
 * Deliberately OVER-inclusive and deliberately not a parser. It answers "could this be one of ours"
 * so that the read's ceilings can be spent on profile records instead of on whatever else shares the
 * folder; {@link parseProfileMessage} remains the only thing that decides what a record MEANS.
 * Retaining a message this says yes to and the parser then rejects costs one slot. Dropping one the
 * parser would have accepted would be a document lost, so the two must not disagree in that
 * direction — hence the header block only, matched case-insensitively, with no other condition.
 */
function looksLikeProfile(raw: string): boolean {
  /**
   * The header block ends at the first blank line; a mention in the BODY is not a discriminator.
   * And the name is anchored at a line start, not merely present: a substring test accepts
   * `Not-X-Ohmail-Profile:` or `X-Forwarded-X-Ohmail-Profile:`, which the parser then rejects —
   * each costing a slot in a retention window meant for real documents, until the current
   * document is evicted by messages that were never candidates: "no settings have been published"
   * about a mailbox that has some. A header name begins at a line start by definition; still
   * case-insensitive, and the parser remains the only thing that decides what a record MEANS.
   */
  const sep = /\r?\n\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : raw;
  const anchored = new RegExp(`(^|\\r?\\n)${H.profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "i");
  return anchored.test(head);
}

/** A sender this mailbox has screened IN. `address` is the natural key. */
export interface ProfileScreenerEntry {
  address: string;
  /** The display name the user gave the contact, if any. */
  name?: string;
}

/** One filing rule, by natural keys — the folder NAME, never a folder id. */
export interface ProfileRuleEntry {
  kind: string;
  match: string;
  destination: string;
  priority: number;
  enabled: boolean;
  provenance: string;
  subjectContains?: string;
  bodyContains?: string;
}

/** One notification opt-in. */
export interface ProfileNotifyRuleEntry {
  kind: string;
  target: string;
}

/**
 * The single per-mailbox autoresponder. Timestamps are ISO 8601 strings or null. `subject` is
 * GONE (mail 0087): the responder is reply-only and derives `Re: <what they wrote>`; an older
 * document still carries the field and the parser does not read it — an unknown key is not an
 * error, which makes the removal safe in both directions. `throttle` is new and defaults to
 * `'per_day'` for a document predating it, the rate every migrated row carries. `PROFILE_VERSION`
 * deliberately does NOT move: the envelope's version is about what a reader must understand to
 * apply a document safely, and both changes are field-level compatible — bumping would make older
 * installs refuse a document they can read perfectly well.
 */
export interface ProfileAwayResponder {
  enabled: boolean;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  audience: string;
  throttle: string;
  /**
   * WHICH PILES THE RESPONDER ANSWERS (mail 0096) — and OPTIONAL, which is the whole of its
   * compatibility rule.
   *
   * A document written before this field existed is not saying "answer the Ohbox"; it is saying
   * nothing about scope. Absent therefore means UNSTATED and the reader leaves what it has stored
   * alone, where a default would silently narrow every adoption from an older install. An explicit
   * empty list is a real answer — "answer nobody" — and is kept.
   */
  piles?: string[];
}

/** The configuration itself — everything that travels, and nothing else. */
export interface OrganizerProfilePayload {
  screener: ProfileScreenerEntry[];
  rules: ProfileRuleEntry[];
  notifyRules: ProfileNotifyRuleEntry[];
  awayResponder: ProfileAwayResponder | null;
  tagNames: string[];
  /**
   * The mailbox's signature (mail 0094) — `mailboxes.signature`, the text appended to outgoing
   * mail from this address. It travels for the away-responder body's reason: per-mailbox
   * configuration the ORGANIZER applies, so a read-only install must see what it currently is.
   * `null` is no signature, and ABSENT parses to `null` too — deliberately not distinguished,
   * unlike `throttle`, because a signature has no third state and "unknown" would buy nothing.
   * `PROFILE_VERSION` does not move, on mail 0087's argument: field-level compatible in both
   * directions, and a bump would make older installs refuse a document they can read.
   */
  signature: string | null;
}

/** The payload wrapped in its versioned envelope — the document as written. */
export interface OrganizerProfileDoc extends OrganizerProfilePayload {
  v: number;
  updatedAt: string;
  producer: { kind: string; version: string };
}

/** A payload with nothing in it — what a mailbox with no configuration serializes to. */
export function isEmptyProfilePayload(p: OrganizerProfilePayload): boolean {
  return p.screener.length === 0 && p.rules.length === 0 && p.notifyRules.length === 0
    && p.awayResponder === null && p.tagNames.length === 0
    /* `?? null` for `canonicalizeProfilePayload`'s reason: a payload assembled in memory without
       this key carries `undefined`, one parsed from a document carries `null`, and both mean "no
       signature". Comparing to `null` alone would call the first one non-empty — so a mailbox with
       nothing configured would publish a document instead of staying silent. */
    && (p.signature ?? null) === null;
}

/**
 * ONE CANONICAL ORDER, so equality is content equality.
 *
 * The dirty check that drives write-behind is a fingerprint comparison, and a fingerprint over an
 * unordered serialization would report "changed" whenever a database happened to return rows in a
 * different order — which is a rewrite of the document per poll interval on some drivers. Sorting
 * by the natural keys makes the fingerprint a function of the configuration and of nothing else.
 */
/**
 * Order two strings the same way on every machine. `localeCompare` is locale-dependent, and these
 * orderings feed {@link canonicalizeProfilePayload}, whose output {@link profileFingerprint}
 * hashes and compares ACROSS INSTALLS — different ICU, different fingerprint, every takeover
 * refused for ever. UTF-16 CODE UNIT order — defined by the language, not ICU. The comparators
 * are still not total orders, on purpose: a tied document's fingerprint depends on input order. A
 * final tie-break was written, measured and REVERTED: it changes the canonical form, so every
 * already-written tied document re-fingerprints and an install reads its own document as a
 * stranger's — a format migration, not a comparator change.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalizeProfilePayload(p: OrganizerProfilePayload): OrganizerProfilePayload {
  const str = (v: string | undefined | null): string => v ?? "";
  return {
    screener: [...p.screener]
      .map((s) => (s.name === undefined || s.name === null ? { address: s.address } : { address: s.address, name: s.name }))
      .sort((a, b) => byCodeUnit(a.address, b.address)),
    rules: [...p.rules]
      .map((r) => ({
        kind: r.kind, match: r.match, destination: r.destination,
        priority: r.priority, enabled: r.enabled, provenance: r.provenance,
        ...(r.subjectContains === undefined || r.subjectContains === null ? {} : { subjectContains: r.subjectContains }),
        ...(r.bodyContains === undefined || r.bodyContains === null ? {} : { bodyContains: r.bodyContains }),
      }))
      .sort((a, b) =>
        byCodeUnit(a.kind, b.kind)
        || byCodeUnit(a.match, b.match)
        || byCodeUnit(str(a.subjectContains), str(b.subjectContains))
        || byCodeUnit(str(a.bodyContains), str(b.bodyContains))
        || byCodeUnit(a.destination, b.destination)
        || a.priority - b.priority
        || byCodeUnit(a.provenance, b.provenance)
        || Number(a.enabled) - Number(b.enabled)),
    notifyRules: [...p.notifyRules]
      .map((n) => ({ kind: n.kind, target: n.target }))
      .sort((a, b) => byCodeUnit(a.kind, b.kind) || byCodeUnit(a.target, b.target)),
    awayResponder: p.awayResponder === null ? null : {
      enabled: p.awayResponder.enabled,
      body: p.awayResponder.body,
      startsAt: p.awayResponder.startsAt,
      endsAt: p.awayResponder.endsAt,
      audience: p.awayResponder.audience,
      throttle: p.awayResponder.throttle,
      /* SORTED, because the value is a SET and the endpoint does not preserve order — two
         payloads meaning the same scope must not hash differently. ABSENT WHEN ABSENT, for the
         reason the signature field spells out one key below: adding a key here for a document
         that never had one would change the fingerprint of every profile an older ohmail wrote. */
      /* `Array.isArray` AND NOT A TRUTHINESS TEST. `[...new Set("ohmail/Reads")]` spreads a STRING
         into its characters, so a malformed in-memory payload would be canonicalised into a
         plausible-looking array of single letters and published as one. A non-array is dropped
         here, which leaves the parser to refuse the document it arrives in. */
      ...(Array.isArray(p.awayResponder.piles)
        ? { piles: [...new Set(p.awayResponder.piles)].sort(byCodeUnit) }
        : {}),
    },
    tagNames: [...p.tagNames].sort(byCodeUnit),
    /* `?? null` RATHER THAN A PASS-THROUGH, and it is the fingerprint that needs it. An in-memory
       payload assembled without this key has `undefined` here; `JSON.stringify` drops an undefined
       value entirely, while a payload PARSED from a document carries an explicit `null` and
       serializes `"signature":null`. Two payloads meaning the same thing would then hash
       differently — and the fingerprint is what decides "is the held document already what I
       have", so the disagreement shows up as an import prompt that cannot be made to go away.
       Normalised here, in the one function every fingerprint goes through. */
    signature: p.signature ?? null,
  };
}

/**
 * The content identity of a payload — sha256 over the canonical serialization.
 *
 * `updatedAt` and `producer` are deliberately NOT part of it: they describe the WRITE, not the
 * configuration, and folding them in would make every copy of identical configuration look
 * different — which defeats both the dirty check and the "this found document is what I already
 * have" comparison the read-on-takeover path makes.
 */
export function profileFingerprint(p: OrganizerProfilePayload): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeProfilePayload(p)), "utf8").digest("hex");
}

/** The envelope, assembled in the spec's key order over a canonicalized payload. */
export function makeProfileDoc(
  payload: OrganizerProfilePayload,
  meta: { updatedAt: Date; producer: { kind: string; version: string } },
): OrganizerProfileDoc {
  const canonical = canonicalizeProfilePayload(payload);
  return {
    v: PROFILE_VERSION,
    updatedAt: meta.updatedAt.toISOString(),
    producer: { kind: meta.producer.kind, version: meta.producer.version },
    screener: canonical.screener,
    rules: canonical.rules,
    notifyRules: canonical.notifyRules,
    awayResponder: canonical.awayResponder,
    tagNames: canonical.tagNames,
    signature: canonical.signature,
  };
}

/** Strip CR/LF so no value can inject a header. The lease's `headerSafe`, unchanged. */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/**
 * THE PREAMBLE — for the person who finds this message in Apple Mail and wonders what it is.
 *
 * It is written for a stranger: what the message is, that deleting it is safe and what deleting
 * it does, and that the format below is documented. It must contain no `{` — the JSON extractor
 * takes the body's first `{` as the document's start, and the suite pins that property.
 */
const PREAMBLE = [
  "This message stores your ohmail settings for this mailbox: which senders",
  "you have screened in, your filing rules, notification choices, away reply",
  "and tag names. Keeping them here means they live in YOUR mailbox — they",
  "travel with it to any computer or service you connect it from, and they",
  "remain yours, readable, even if you stop using ohmail.",
  "",
  "Deleting this message is safe. It only resets ohmail's settings for this",
  "mailbox — your mail is not touched. ohmail writes a fresh copy when its",
  "settings next change.",
  "",
  "The format: versioned JSON, documented in ohmail's published source",
  "(packages/core/src/adapters/organizer-profile.ts).",
] as const;

/**
 * One RFC822 message per profile.
 *
 * The JSON is pretty-printed so the stranger reading the raw message sees structure rather than
 * one unbroken line, and so no line is longer than its longest string value.
 */
export function formatProfileMessage(doc: OrganizerProfileDoc, opts: { installId: string }): string {
  const lines = [
    `${H.profile}: 1`,
    `${H.installId}: ${headerSafe(opts.installId)}`,
    `Subject: ohmail settings for this mailbox`,
    `Date: ${new Date(doc.updatedAt).toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    ...PREAMBLE,
    "",
    JSON.stringify(doc, null, 2),
    "",
  ];
  return lines.join("\r\n");
}

/**
 * A message that says it is a profile and then cannot be read as one.
 *
 * Distinct from "not a profile" for the lease's reason restated: a message WITHOUT
 * `X-Ohmail-Profile: 1` is a claim, a stray or a future meta record type and is invisible here;
 * a message WITH it whose document is unreadable is a corrupt copy of OUR OWN bookkeeping — it
 * carries nothing recoverable, so unlike a malformed lease claim it may be replaced by the next
 * write, but it is still reported rather than silently treated as absent.
 */
export interface MalformedProfile {
  malformed: true;
  reason: string;
  ref?: unknown;
}

/** A parsed profile message: the document, plus the transport facts around it. */
export interface ParsedProfileMessage {
  /** `ok` — readable at this version. `newer` — a later format; leave it alone. */
  status: "ok" | "newer";
  /** Present when `status` is `"ok"`. */
  doc?: OrganizerProfileDoc;
  /** The document's `v`, whatever it was. */
  v: number;
  /** `X-Ohmail-Install-Id` — which organizer wrote this copy, or null if absent. */
  installId: string | null;
  ref?: unknown;
}

export type ProfileRecord = ParsedProfileMessage | MalformedProfile;

export function isMalformedProfile(r: ProfileRecord): r is MalformedProfile {
  return (r as MalformedProfile).malformed === true;
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The tolerant reader of one section entry. Drops entries missing their natural key. */
function readPayload(raw: Record<string, unknown>): OrganizerProfilePayload {
  const screener: ProfileScreenerEntry[] = [];
  if (Array.isArray(raw.screener)) {
    for (const e of raw.screener) {
      if (typeof e !== "object" || e === null) continue;
      const address = asString((e as Record<string, unknown>).address)?.trim();
      if (!address) continue;
      const name = asString((e as Record<string, unknown>).name);
      screener.push(name === null ? { address } : { address, name });
    }
  }
  const rules: ProfileRuleEntry[] = [];
  if (Array.isArray(raw.rules)) {
    for (const e of raw.rules) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      const kind = asString(o.kind);
      const match = asString(o.match);
      const destination = asString(o.destination);
      if (!kind || !match || !destination) continue;
      const subjectContains = asString(o.subjectContains);
      const bodyContains = asString(o.bodyContains);
      rules.push({
        kind, match, destination,
        priority: typeof o.priority === "number" && Number.isFinite(o.priority) ? o.priority : 0,
        enabled: typeof o.enabled === "boolean" ? o.enabled : true,
        provenance: asString(o.provenance) ?? "manual",
        ...(subjectContains === null ? {} : { subjectContains }),
        ...(bodyContains === null ? {} : { bodyContains }),
      });
    }
  }
  const notifyRules: ProfileNotifyRuleEntry[] = [];
  if (Array.isArray(raw.notifyRules)) {
    for (const e of raw.notifyRules) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      const target = asString(o.target);
      if (!target) continue;
      notifyRules.push({ kind: asString(o.kind) ?? "sender", target });
    }
  }
  /**
   * The scope a document states, deduped — or `undefined` for both "not stated" and "stated with
   * the wrong type". The caller tells those two apart by whether the key is present at all.
   */
  const pilesOf = (v: unknown): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || !v.every((m) => typeof m === "string")) return undefined;
    return [...new Set(v as string[])];
  };
  let awayResponder: ProfileAwayResponder | null = null;
  if (typeof raw.awayResponder === "object" && raw.awayResponder !== null) {
    const o = raw.awayResponder as Record<string, unknown>;
    awayResponder = {
      enabled: typeof o.enabled === "boolean" ? o.enabled : false,
      // `o.subject` is deliberately NOT read — the responder is reply-only since 0087, and a
      // document from an older ohmail carries a subject that has nowhere to go.
      body: asString(o.body),
      startsAt: asString(o.startsAt),
      endsAt: asString(o.endsAt),
      audience: asString(o.audience) ?? "screened_in",
      // `per_day` for a document that predates the field, which is the rate every row migrated by
      // 0087 carries. The importer narrows an UNRECOGNISED member to the same value; this only
      // fills in an absent one, and the two are separate on purpose (a member we do not know is a
      // newer ohmail's, and is a different fact from a field that was never written).
      throttle: asString(o.throttle) ?? "per_day",
      // ABSENT STAYS ABSENT. See the field: no default here, because "unstated" and "the Ohbox"
      // are different facts and only the importer can tell what to do with the first. DEDUPED,
      // because the value is a set at every other door and the notice renders one line per member.
      ...(pilesOf(o.piles) === undefined ? {} : { piles: pilesOf(o.piles) }),
    };
    /* A KNOWN KEY WITH THE WRONG TYPE IS NOT AN ABSENT ONE, and reading it as absent is the
       widening door: a document saying `enabled: true` with a wider `audience` and a malformed
       scope would turn the responder on and change who it answers while the one field that bounds
       its reach came from nowhere. The section is unreadable, which is the refusal an unparseable
       date already gets — applied whole or not at all. CHECKED BEFORE the object above is built,
       or the read of a non-array throws instead of refusing. */
    if (o.piles !== undefined && o.piles !== null && pilesOf(o.piles) === undefined) {
      awayResponder = null;
    }
  }
  const tagNames: string[] = Array.isArray(raw.tagNames)
    ? raw.tagNames.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  // ABSENT AND null BOTH PARSE TO null — see the field's own comment. `asString` already answers
  // undefined for a non-string, so a document carrying a number or an object here reads as "no
  // signature" rather than putting a stranger's value into an outgoing mail.
  const signature: string | null = asString(raw.signature) ?? null;
  return { screener, rules, notifyRules, awayResponder, tagNames, signature };
}

/**
 * Read one message. Returns `null` when it is not a profile at all (no discriminator) —
 * lease claims and future meta record types fall out here, exactly as profile messages fall out
 * of the lease's `parseClaim`.
 *
 * Duplicate discriminator headers are refused as `malformed` rather than resolved, for the
 * reason `parseClaim` documents at length: a record that announces itself and cannot be read
 * must never become invisible.
 */
export function parseProfileMessage(raw: string, ref?: unknown): ProfileRecord | null {
  const at = raw.search(/\r?\n\r?\n/);
  const headerBlock = at === -1 ? raw : raw.slice(0, at);
  const body = at === -1 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "");

  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, line.slice(colon + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const get = (k: string): string | undefined => headers.get(k.toLowerCase());
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;
  const malformed = (reason: string): MalformedProfile =>
    ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };

  if (count(H.profile) > 1) return malformed("duplicate profile header");
  if (get(H.profile) !== "1") return null; // not a profile — a lease claim, a stray, or a future record type
  if (count(H.installId) > 1) return malformed("duplicate install id header");

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return malformed("no document in body");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return malformed("document is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed("document is not an object");
  }
  const rawDoc = parsed as Record<string, unknown>;
  const v = rawDoc.v;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return malformed("unreadable version");

  const installId = get(H.installId) ?? null;
  if (v > PROFILE_VERSION) {
    return { status: "newer", v, installId, ...(ref === undefined ? {} : { ref }) };
  }

  const payload = readPayload(rawDoc);
  const producerRaw = typeof rawDoc.producer === "object" && rawDoc.producer !== null
    ? rawDoc.producer as Record<string, unknown> : {};
  const doc: OrganizerProfileDoc = {
    v,
    updatedAt: asString(rawDoc.updatedAt) ?? "",
    producer: {
      kind: asString(producerRaw.kind) ?? "unknown",
      version: asString(producerRaw.version) ?? "",
    },
    ...payload,
  };
  return { status: "ok", doc, v, installId, ...(ref === undefined ? {} : { ref }) };
}

// ── IO ──────────────────────────────────────────────────────────────────────────────────────

/**
 * WHICH PROFILE OPERATION FAILED — the lease's `LeaseOp` discipline: a catch that wraps more
 * than one operation must name which one threw, and every member is a literal WE wrote, so it
 * costs nothing to log.
 */
export type ProfileOp = "ensure_meta" | "list_profiles" | "append_profile" | "remove_profiles";

/**
 * A profile IO failure is a mailbox fault for the LOGS, never for the pipeline: unlike the
 * lease, nothing about organizing hinges on this document, so callers log the failure and move
 * on — a mailbox whose profile cannot be written is a mailbox whose settings do not travel this
 * cycle, and the next cycle tries again.
 */
/**
 * THE ANSWER TO "WHICH RECORDS ARE THERE", INCLUDING THE ANSWER "I COULD NOT ASK".
 *
 * These are two different facts and they were one value. A search that could not be issued, was
 * refused, had no ceiling to walk down from, or ran out of window budget all came back as `null`,
 * and so did nothing at all; the caller could not tell them apart and treated the failure as a
 * reason to read the folder another way. An empty folder is `{ kind: "uids", uids: [] }` and it is
 * the ONLY value that may be read as "there is no profile here".
 */
/**
 * The uid the server gave our own settings document when we wrote it. The settings walk has the
 * lease's problem at its own door: it covers a fixed distance below the top of the uid space, and
 * churn moves the records further from the top without limit — past the budget every window is
 * empty, and since could-not-ask now correctly refuses, the result is a mailbox whose published
 * settings are permanently unavailable. Refusing is right; never recovering is not. Keyed on the
 * connection for the lease's reasons: a folder path is identical across mailboxes, a fresh io is
 * built per call. A hint, never evidence — the document is still read from the folder and parsed
 * like any other.
 */
/**
 * THE FOLDER'S GENERATION, which is what says whether a remembered uid still means anything.
 *
 * The anchor itself now lives in `meta-memo.ts`, keyed by (install, mailbox) rather than beside
 * the connection: a reconnect changes nothing about the folder and must not cost the position,
 * and a position from a replaced numbering must not be usable at all.
 */
function generationOf(client: { readonly mailbox?: { uidValidity?: number | bigint } | false }): Generation {
  const selected = client.mailbox;
  const v = typeof selected === "object" && selected !== null ? selected.uidValidity : undefined;
  return typeof v === "number" || typeof v === "bigint" ? v : null;
}

export type ProfileUidAsk =
  | { readonly kind: "uids"; readonly uids: number[] }
  /**
   * `code` is the SAME FACT as `why`, in the alphabet a log line can carry.
   *
   * `why` is prose and a log line never carries prose: measured on a reader for nine hours,
   * `profile_mirror_read_failed` fired 47 times and named neither which refusal it was nor its
   * cause, because the only diagnosis was inside a message. The code rides to the emitted line as
   * `errorCode` through {@link ProfileUnavailableError}.
   */
  | { readonly kind: "unknown"; readonly why: string; readonly code: ProfileAskCode };

/** The named refusals {@link ProfileUidAsk} can answer with. An `errorCode`, so identifier-shaped. */
export type ProfileAskCode =
  | "profile_search_unsupported"
  | "profile_no_uidnext"
  | "profile_search_refused"
  | "profile_gap_too_deep";

export class ProfileUnavailableError extends Error {
  readonly op: ProfileOp;
  /**
   * The refusal's name, published to the log as `errorCode` — `log.ts#describeError` reads `code`
   * off the thrown value, so a code set here needs no call site to remember to extract it.
   */
  readonly code?: string;
  constructor(message: string, options: { op: ProfileOp; cause?: unknown; code?: string }) {
    super(message, options);
    this.name = "ProfileUnavailableError";
    this.op = options.op;
    if (options.code !== undefined) this.code = options.code;
  }
}

/** One message in the meta folder, as the IO layer sees it — the FULL source, not headers. */
export interface RawProfileMessage {
  ref: unknown;
  raw: string;
  /**
   * The folder's generation this message's `ref` was read under — REQUIRED, never optional. A
   * remembered uid is a fact only under its UIDVALIDITY: a renumbered folder re-issues the same
   * small integers to different messages. Required because the optional form fails silently: a
   * caller omitting it would produce a `found` result whose locator looks usable and is not,
   * indistinguishable from a genuine `null` ("the generation could not be learned", which
   * correctly reads unusable). The io stamps every message in one call from ONE
   * `generationOf(client)` taken inside the same mailbox lock as the fetch, so the pair is
   * consistent by construction.
   */
  generation: Generation;
}

/**
 * The narrow IO the profile needs. Same shape as the lease's {@link LeaseIo} with one
 * difference that is the reason this is not that interface: `listProfileMessages` fetches full
 * SOURCES, because the document is the body — the lease reads headers only, and widening ITS
 * fetch would make the gate's cost scale with this document's size on every cycle.
 */
export interface ProfileIo {
  /** Create `ohmail/_meta` if absent and unsubscribe it. Idempotent — the lease's semantics. */
  ensureMetaFolder(): Promise<void>;
  /**
   * The meta folder's PROFILE messages, full source.
   *
   * Bounded and newest-first by default, which is what a read wants: the newest document is the
   * current one. `complete` reads the whole folder instead, and exists for {@link
   * writeOrganizerProfile} — its `newer`/`foreign` results are REFUSALS, and a refusal made from a
   * window cannot tell "no such document" apart from "did not look that far back".
   */
  listProfileMessages(opts?: { complete?: boolean }): Promise<RawProfileMessage[]>;
  /** APPEND one profile message. */
  appendProfile(raw: string): Promise<void>;
  /** STORE `\Deleted` + EXPUNGE the given messages. */
  removeProfiles(refs: readonly unknown[]): Promise<void>;
}

/**
 * The minimum an IMAP client has to be for {@link makeProfileIo} to drive it. Structural, not
 * `ImapFlow`, for the lease's reason: the IO layer stays testable against a fake, and this
 * module never imports the client library.
 */
export interface ProfileImapClient extends MetaFolderClient {
  /* `uidValidity` is what says whether a remembered uid still refers to anything: a folder
   * deleted and recreated numbers from one again under a new generation. Optional because a
   * server may not have reported one yet, and an unknown generation is treated as a mismatch
   * rather than a match. */
  readonly mailbox?: { exists?: number; uidValidity?: number | bigint } | false;
  /**
   * A NOOP, which is how a long-lived connection LEARNS what changed under it. Optional, so every
   * existing fake behaves exactly as it did. See {@link listProfileMessages} for why a cached
   * `exists` of zero is not proof of an empty folder.
   */
  noop?(): Promise<unknown>;
  /**
   * STATUS on a folder BY NAME — the only form of "how many messages" this module asks, because it
   * is the only one that answers with a single number. Optional: a client without it falls back to
   * reading the folder whole, which is bounded in what it RETAINS. See {@link lastSequence}.
   */
  status?(
    path: string,
    /**
     * `uidNext` is asked of the SERVER, by name, on the folder — never read off `client.mailbox`,
     * whose fields are whatever the last untagged response left behind. See the lease adapter's
     * note where the same rule is stated: a stale ceiling sends every search window below the
     * records that matter.
     */
    query: { messages?: boolean; uidNext?: boolean },
  ): Promise<{ messages?: number; uidNext?: number } | false | undefined>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxUnsubscribe(path: string): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  /**
   * SEARCH, by header. Optional — a connection without it falls back to the bounded range read,
   * which is what this module did before and is honest about its limits.
   *
   * With it, the settings records can be found REGARDLESS OF POSITION, which a window cannot do:
   * see {@link listProfileMessages}. Resolves `false` when the server refuses, exactly as the
   * library does, and that is not the same answer as an empty folder.
   */
  search?(
    /**
     * `uid` is a UID SEQUENCE criterion (`UID <lo>:<hi>`), which is how the search is bounded to a
     * window rather than asked about the whole folder — see {@link listProfileMessages}.
     */
    query: { header?: Record<string, string | boolean>; uid?: string },
    options?: { uid?: boolean },
  ): Promise<number[] | false | undefined>;
  fetch(
    range: string,
    /**
     * `source` may be a BYTE RANGE rather than a flag. `{ start, maxLength }` compiles to
     * `BODY.PEEK[]<start.maxLength>` (imapflow 1.5.0, `lib/commands/fetch.js`), which is the only
     * way to bound what a message costs BEFORE the server sends it — read there rather than
     * assumed, because the whole point of this seam is that it reaches the wire.
     */
    query: {
      uid?: boolean;
      source?: boolean | { start?: number; maxLength?: number };
      size?: boolean;
    },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{ uid: number; seq?: number; source?: Buffer; size?: number }>;
  append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<unknown>;
}

/**
 * A {@link ProfileIo} bound to a LIVE connection — the same connection the adapter already
 * holds, for the lease's reason: a second login per mailbox per cycle is how a provider decides
 * to throttle a user.
 *
 * Appended `\Seen`, like the claim, so a subscribed `_meta` in another client shows no unread
 * count for bookkeeping.
 */
/**
 * @param limits Ceilings this IO enforces. Present so the BYTE ceiling can be observed at a size a
 * test can hold: it defaults to {@link PROFILE_BYTES_MAX_PER_FETCH}, and the only way to exercise
 * the singleton-over-ceiling path against the real constant is to allocate 128 MiB, which the test
 * runner cannot even serialise when it reports. A bound nobody can watch reject is the shape this
 * whole read was rewritten to remove, so the seam is deliberate and narrow — no caller in the
 * product passes it, asserted by the census in `organizer-profile-bounded.test.ts`.
 */
export function makeProfileIo(
  client: ProfileImapClient,
  toServerPath: (canonical: string) => string,
  identity: MetaIdentity,
  limits?: { maxBytes?: number; now?: () => number },
): ProfileIo {
  assertMetaIdentity("makeProfileIo", identity);
  const maxBytes = limits?.maxBytes ?? PROFILE_BYTES_MAX_PER_FETCH;
  const now = limits?.now ?? Date.now;
  // The lease's resolution, not a second one. The profile and the claim share a folder, so a
  // second spelling of where that folder is would put the settings document and the lease in
  // different places on exactly the servers where it matters.
  const meta = makeMetaFolderRef(client, toServerPath);

  const io: ProfileIo = {
    async ensureMetaFolder(): Promise<void> {
      const at = await meta.locate();
      const found = at.row;
      if (!found) {
        try {
          const info = await client.mailboxCreate(at.path);
          const landed = (info as { path?: string } | undefined)?.path;
          if (typeof landed === "string" && landed !== "") meta.adopt(landed);
        } catch (err) {
          if (!/already exists/i.test(String((err as Error).message))) throw err;
        }
      }
      if (!found || found.subscribed) await client.mailboxUnsubscribe(await meta.path());
    },

    /**
     * The same folder, the same bound — and this read is the expensive one: FULL SOURCES rather
     * than headers, buffered, on the organizer's hot paths; the per-document ceiling is checked
     * by the parser after the bytes are in hand, so it never bounded this. A second loop because
     * the shared one fetches HEADERS; what is shared is the rule: newest-first, one ceiling, the
     * empty-folder defence. Newest-first because the profile is appended and newest wins.
     * Truncation is NOT refused: a newest-first window answers "what is the newest document"
     * whenever it is inside. A cached zero is not a known zero: `exists` stayed 0 for ten seconds
     * after another connection appended — the missed fourth of the lease's corrected reads.
     */
    async listProfileMessages(opts?: { complete?: boolean }): Promise<RawProfileMessage[]> {
      // Resolved ONCE and reused for both the lock and the count probe, so the two can never name
      // different folders.
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        const out: RawProfileMessage[] = [];
        /* ── ONE GENERATION FOR THE WHOLE CALL, TAKEN INSIDE THE LOCK ──────────────────────
         *
         * Every message below comes from one SELECT of one folder on one connection, so they share
         * one generation by construction — and taking it here, under the same `getMailboxLock` the
         * fetches run under, is what makes that true rather than merely likely. Read at the call
         * site instead it would be a generation for whatever folder the adapter had selected by
         * then, which is the manufactured pair.
         *
         * The same `generationOf(client)` the memo read below already uses, so a document's
         * locator and the anchor written from it can never disagree about the epoch. */
        const generation = generationOf(client);
        /**
         * A NOOP cannot prove a refresh, so nothing here rests on one. imapflow discards the
         * command's own result, so a REFUSED noop resolves exactly like an accepted one, and
         * "refreshed" was inferred from the absence of a throw — a stale cached zero could be
         * trusted and the read return "no settings have been published" for a mailbox that has
         * some. The count is asked for outright instead: {@link lastSequence} issues a STATUS
         * naming the folder, answered on an empty folder as readily as a full one, so it needs no
         * zero check in front. The cached `exists` is consulted only where the server cannot be
         * asked at all.
         */
        const selected = client.mailbox;
        const cached = typeof selected === "object" && selected !== null ? selected.exists : undefined;
        const probed = await lastSequence(client, metaPath);
        /* The lease's rule, for the same reason: a cached count may END this read (an empty folder
         * is cheap to be wrong about in one direction only) but may never be COUNTED BACK from,
         * because nothing confirms it and a window in the wrong place loses the document. */
        if (probed === 0) return out;
        if (probed === undefined && cached === 0) return out;
        const total = probed;
        /**
         * Both axes, and both evict from the FRONT. The count ceiling stops many small messages,
         * the byte one a few enormous ones. Neither may `break`: the window arrives oldest-first,
         * so stopping on a ceiling keeps the OLDEST records — one large early append would return
         * everything except the current document. Each message is pushed and the oldest dropped
         * until both ceilings hold — a sliding window. `win.length > 1` on the byte arm keeps the
         * newest message even when it alone is over the ceiling: an oversized document is the
         * PARSER's refusal ({@link PROFILE_DOC_MAX_BYTES}); returning nothing would be the same
         * lie by another route.
         */
        /**
         * The ceilings are spent on PROFILE records, not on whatever shares the folder. Counting
         * the lease's claims and stranger appends meant five hundred later newsletters could
         * evict the current document — and this list also feeds {@link writeOrganizerProfile}'s
         * `newer` and `foreign` refusals, the whole reason an older build will not overwrite a v2
         * document. An evicted v2 is an older organizer appending v1 over settings it never saw,
         * every later read agreeing the rollback is current — silent, durable, in the customer's
         * own mailbox. The retention test runs AFTER the discriminator; a flood costs transfer
         * and nothing else.
         */
        const complete = opts?.complete === true;

        /**
         * Every source this adapter reads comes through here, and it always RANGES: one reply
         * asked as `BODY.PEEK[]<0.N>`, so the server sends at most N bytes whatever the message
         * weighs. The server's size claim is untrusted: the size pass is a prefilter, never a
         * bound — a server free to answer `RFC822.SIZE: 1` is free to send ten megabytes — so the
         * reported size never decides the range. N is the remaining budget PLUS ONE, making the
         * answer exact: shorter than N is the whole document; exactly N did not fit and is
         * refused unparsed. One at a time, because each reply is charged before the next range is
         * computed — a batch hands every message the same nearly-full range.
         */
        const fetchSourceBounded = async (
          messageset: string,
          byUid: boolean,
          budget: number,
        ): Promise<{ uid: number; source: Buffer } | { over: number } | null> => {
          const cap = Math.max(1, budget) + 1;
          for await (const m of client.fetch(
            messageset, { uid: true, source: { start: 0, maxLength: cap } }, { uid: byUid },
          )) {
            if (!m.source) continue;
            /* ── AN OVER-BUDGET REPLY STILL COST ITS BYTES, AND NOW SAYS SO ─────────────────
             *
             * This returned a bare marker and the callers charged nothing for it, so a record that
             * FILLED its range was free: the budget never moved, every later record was offered
             * the same room, and a folder of them could be walked for ever — the unbounded walk
             * the per-reply charge exists to stop, surviving in the one branch that never reached
             * the charge. Found by the guard written for that charge, which is what it is for. */
            if (m.source.byteLength >= cap) return { over: m.source.byteLength };
            return { uid: m.uid, source: m.source };
          }
          return null;
        };

        /**
         * The uids of every settings record in the folder, newest last, or `null` when the
         * connection cannot be asked or the server REFUSED — which is not the same answer as
         * "there are none" and must never be read as one.
         */
        /**
         * Searched in descending uid windows, like the lease's: a bare header search lands
         * however many uids the server chooses before any ceiling of ours runs. Each window is
         * bounded by construction; descending because a read wants the NEWEST settings. The top
         * comes from a STATUS, never the cached mailbox object. Could-not-ask is not
         * there-is-nothing: no search, a refused search, or a too-sparse folder all returned the
         * `null` an empty folder would, and the unbounded fallback could return nothing for a
         * folder plainly holding a document — settings lapsed silently. The ask reports which
         * happened: `unknown` refuses the cycle; only `uids` may decide anything.
         */
        const profileUids = async (c: ProfileImapClient): Promise<ProfileUidAsk> => {
          if (typeof c.search !== "function" || typeof c.status !== "function") {
            return {
              kind: "unknown", code: "profile_search_unsupported",
              why: "this server offers no way to search the folder",
            };
          }

          const top = await (async (): Promise<number | null> => {
            try {
              const st = await c.status!(metaPath, { uidNext: true });
              const next = typeof st === "object" && st !== null ? st.uidNext : undefined;
              return typeof next === "number" && next > 1 ? next - 1 : null;
            } catch {
              return null;
            }
          })();
          if (top === null) {
            return {
              kind: "unknown", code: "profile_no_uidnext",
              why: "the folder reported no usable UIDNEXT to walk down from",
            };
          }

          const out: number[] = [];
          /* ── THE STRETCH BETWEEN OUR OWN DOCUMENT AND WHERE THE WALK STOPS ──────────────────
           *
           * Read like the lease's claim gap and for the same reason. The walk still starts at the
           * top — a settings document written after ours has a higher uid, and starting at ours
           * would read past it and answer with a stale document. What the anchor buys is the
           * right to cover what the budget left beneath it. */
          const remembered = readMemo(identity, generationOf(client));
          const anchor = remembered.kind === "memo" && typeof remembered.memo.profileUid === "number"
            ? remembered.memo.profileUid
            : null;
          const bottomFor = (): number => (anchor !== null && anchor >= 1 ? anchor : 1);
          const bottom = bottomFor();
          let hi = top;
          for (let w = 0; w < PROFILE_SEARCH_WINDOW_BUDGET; w++) {
            const lo = Math.max(1, hi - PROFILE_SEARCH_UID_WINDOW + 1);
            const found = await c.search(
              { header: { [H.profile]: true }, uid: `${lo}:${hi}` }, { uid: true },
            );
            if (!Array.isArray(found)) {
              return {
                kind: "unknown", code: "profile_search_refused",
                why: `the search of UIDs ${lo}:${hi} was refused`,
              };
            }
            out.push(...found);
            if (lo === 1) return { kind: "uids", uids: out.sort((a, b) => a - b) };
            if (out.length > PROFILE_MESSAGES_MAX_PER_FETCH) {
              return { kind: "uids", uids: out.sort((a, b) => a - b) };
            }
            hi = lo - 1;
          }
          /**
           * The budget ran out, and a record in hand is already the answer: the question is "what
           * is the NEWEST document", and a walk from the top answers it the moment it holds a
           * profile record — everything above was searched. Refusing here threw that answer away,
           * and `ohmail/_meta` also carries the lease's claims, so its uid space climbs per
           * heartbeat while the folder stays small: past 10 000 uids every read of a readable
           * document refused with the document in `out`. An EMPTY `out` is still a refusal —
           * nothing was found and something may lie below. The gap walk covers what the budget
           * could not reach, down to uid 1 when there is no memo.
           */
          if (out.length > 0) return { kind: "uids", uids: out.sort((a, b) => a - b) };
          const floor = hi + 1;
          if (bottom < floor) {
            let gapHi = floor - 1;
            for (let w = 0; w < PROFILE_SEARCH_WINDOW_BUDGET; w++) {
              const lo = Math.max(bottom, gapHi - PROFILE_SEARCH_UID_WINDOW + 1);
              const found = await c.search(
                { header: { [H.profile]: true }, uid: `${lo}:${gapHi}` }, { uid: true },
              );
              if (!Array.isArray(found)) {
                return {
                  kind: "unknown", code: "profile_search_refused",
                  why: `the search of UIDs ${lo}:${gapHi} was refused`,
                };
              }
              out.push(...found);
              if (lo === bottom) return { kind: "uids", uids: out.sort((a, b) => a - b) };
              gapHi = lo - 1;
            }
          }
          // Deeper than two budgets: still a refusal, but a named one.
          return {
            kind: "unknown", code: "profile_gap_too_deep",
            why: "the settings document lies further below the top of the uid space than "
              + `${2 * PROFILE_SEARCH_WINDOW_BUDGET * PROFILE_SEARCH_UID_WINDOW} uids, so no `
              + "bounded read of this folder can reach it",
          };
        };

        /** Sizes first, then source for the survivors only — see the note at the call site. */
        const readByUid = async (uids: readonly number[]): Promise<{
          win: Array<{ rec: RawProfileMessage; size: number }>; seen: number;
        }> => {
          if (uids.length === 0) return { win: [], seen: 0 };
          /* One past the count ceiling, so "exactly at the ceiling" stays distinguishable from
           * "over it" — the distinction the complete scan's refusal turns on. */
          const capped = uids.slice(-(PROFILE_MESSAGES_MAX_PER_FETCH + 1));
          const sizes = new Map<number, number>();
          for (let i = 0; i < capped.length; i += PROFILE_FETCH_BATCH) {
            const batch = capped.slice(i, i + PROFILE_FETCH_BATCH);
            for await (const m of client.fetch(batch.join(","), { uid: true, size: true }, { uid: true })) {
              if (typeof m.size === "number") sizes.set(m.uid, m.size);
            }
          }
          /**
           * A reported size orders the work; it never decides a refusal. The prefilter used to
           * sum reported sizes and refuse a COMPLETE scan before a byte was fetched — handing the
           * decision to the server: gigabyte answers for tiny records make a readable folder
           * refuse, and a refused settings write is a person's rules not applying. The same
           * number is already untrusted the other way; it cannot be authority in one direction
           * and a lie in the other. Sizes affect only ORDER — cheap records first. Every refusal
           * is decided by bytes that arrived; the COUNT ceiling stays, being this module's own
           * arithmetic.
           */
          const chosen: number[] = [];
          for (const uid of [...capped].reverse()) {
            if (chosen.length >= PROFILE_MESSAGES_MAX_PER_FETCH) {
              if (complete) {
                throw new ProfileUnavailableError(
                  `the settings in ${META_FOLDER} could not be read completely: the folder holds `
                  + `more than ${PROFILE_MESSAGES_MAX_PER_FETCH} settings records, and a write must `
                  + "see every one before it may replace any",
                  { op: "list_profiles" },
                );
              }
              break;
            }
            chosen.push(uid);
          }
          /* ── THE BUDGET IS SPENT NEWEST FIRST, AND THAT ORDERING IS LOAD-BEARING ──────────
           *
           * This walked in FOLDER order, which was harmless while an over-budget record cost
           * nothing. Now that every reply is charged — including one that filled its range — an
           * enormous OLD record fetched first spends the budget before the current document is
           * ever asked for, and the read answers with nothing about a mailbox that has settings.
           * `chosen` is already newest-first; the result is put back in folder order at the end,
           * which is what every caller reads. */
          const order = chosen;
          const win: Array<{ rec: RawProfileMessage; size: number }> = [];
          let held = 0;
          let oversized = 0;
          for (const uid of order) {
            const got = await fetchSourceBounded(String(uid), true, maxBytes - held);
            if (got === null) continue;   // expunged in the gap; not evidence about any other
            if ("over" in got) {
              held += got.over;   // it crossed the connection; it is spent
              if (complete) {
                throw new ProfileUnavailableError(
                  `a settings record in ${META_FOLDER} is larger than the ${maxBytes}-byte budget `
                  + "this read may spend, and a write must see every document whole before it may "
                  + "replace any",
                  { op: "list_profiles" },
                );
              }
            /**
             * Skipped, but never silently — see the refusal after the loop. An over-budget record
             * cannot be parsed, because it was never fully transferred; on a read, skipping one
             * is right while something else can answer. What must not happen is skipping the ONLY
             * candidate and returning an empty list, which every caller reads as "no settings
             * have been published" and routes a person's mail by local defaults. The old contract
             * kept such a record for the parser to refuse out loud; once the document is
             * deliberately never transferred whole, the honest equivalent is a refusal from here
             * — counted, and acted on below.
             */
            oversized += 1;
              continue;
            }
            /* ── EVERY BYTE THAT ARRIVED IS CHARGED, WHETHER IT IS KEPT OR THROWN AWAY ─────
             *
             * The budget used to move only for records that turned out to BE settings. A record
             * that is not one still crossed the connection, still cost the memory to hold while it
             * was examined, and then left the budget untouched — so a folder of near-misses could
             * be walked for ever at nearly the full budget apiece. What the ceiling is defending
             * is the transfer, and a byte spent on a message that turns out to be a newsletter is
             * spent exactly the same as one spent on a document. */
            const size = got.source.byteLength;
            held += size;
            const raw = got.source.toString("utf8");
            if (!looksLikeProfile(raw)) continue;
            win.push({ rec: { ref: got.uid, raw, generation }, size });
            while (win.length > PROFILE_MESSAGES_MAX_PER_FETCH) {
              if (complete) {
                throw new ProfileUnavailableError(
                  `the settings in ${META_FOLDER} could not be read completely: the folder holds `
                  + `more than ${PROFILE_MESSAGES_MAX_PER_FETCH} settings records, and a write `
                  + "must see every one before it may replace any",
                  { op: "list_profiles" },
                );
              }
              held -= win.shift()!.size;
            }
          }
          win.sort((a, b) => Number(a.rec.ref ?? 0) - Number(b.rec.ref ?? 0));
          if (win.length === 0 && oversized > 0) {
            throw new ProfileUnavailableError(
              `the only settings record in ${META_FOLDER} is larger than the ${maxBytes}-byte `
              + "budget this read may spend, so it was not transferred and cannot be parsed — "
              + "answering with nothing here would say no settings have been published",
              { op: "list_profiles" },
            );
          }
          return { win, seen: capped.length };
        };

        /**
         * A refusal cannot be made from a window: filtering the ceilings stops a flood from
         * EVICTING the document, and cannot put back one the RANGE never delivered. Fine for a
         * read — the newest document is the current one. Not for {@link writeOrganizerProfile}:
         * its `newer` and `foreign` checks must run against EVERY document in the folder — a
         * refusal that silently did not look is indistinguishable from one that found nothing,
         * the difference between "we did not overwrite the v2 settings" and "we overwrote
         * settings we never saw". So the write asks for a complete scan: one folder's transfer on
         * a rare write; retention stays bounded, where the memory risk was.
         */
        /**
         * Ask the server which messages are settings, rather than where they might be. The range
         * counted backwards through claims and acks, so a settings document with a ceiling's
         * worth of later messages on top sat outside the window and the read reported "no
         * settings have been published" — the next organizer routes by local defaults, a person's
         * rules silently not applied. Only settings records carry the discriminator, so a header
         * SEARCH is complete for profiles by construction. And the bytes are bounded before
         * delivery: the byte ceiling was applied to `m.source`, already buffered whole; sizes
         * come first in a cheap pass, source fetched only for survivors of both ceilings.
         */
        const searched = await profileUids(client);
        /**
         * A failed ask refuses the cycle; it does not pick a different way to look. The fallback
         * read the folder by sequence range, unbounded, and returned whatever survived two
         * ceilings — for a folder holding a valid document below a flood, an EMPTY result,
         * indistinguishable from a mailbox that never published settings: the effective profile
         * lapsed silently with no fault recorded. A read that cannot be bounded is a different
         * question, and its answer was being used for this one. Settings failing is a logged
         * mailbox fault and the next cycle retries — costing a cycle rather than a person's
         * rules.
         */
        if (searched.kind === "unknown") {
          throw new ProfileUnavailableError(
            `the profile records in ${META_FOLDER} could not be enumerated: ${searched.why}`,
            { op: "list_profiles", code: searched.code },
          );
        }
        const read = await readByUid(searched.uids);


        for (const w of read.win) out.push(w.rec);
        return out;
      } finally {
        lock.release();
      }
    },

    async appendProfile(raw: string): Promise<void> {
      const reply = await client.append(await meta.path(), raw, ["\\Seen"]);
      // No UIDPLUS means no anchor rather than a guessed one; the walk then behaves as before.
      const uid = typeof reply === "object" && reply !== null
        ? (reply as { uid?: unknown }).uid
        : undefined;
      /* ── THE GENERATION COMES FROM THE APPEND'S OWN REPLY ──────────────────────────────
       *
       * Not from the connection: appending does not require a folder to be selected, so
       * `client.mailbox` may describe another folder or none at all, and a uid paired with the
       * wrong generation is exactly the stale anchor this pairing exists to prevent. UIDPLUS
       * reports the uid and the generation together, so taken from there they are consistent by
       * construction. */
      const gen = typeof reply === "object" && reply !== null
        ? (reply as { uidValidity?: unknown }).uidValidity
        : undefined;
      const generation = typeof gen === "number" || typeof gen === "bigint" ? gen : null;
      if (typeof uid === "number" && Number.isFinite(uid) && uid > 0 && generation !== null) {
        writeMemo(identity, generation, { profileUid: uid });
      } else {
        forgetMemo(identity, "profileUid");
      }
    },

    async removeProfiles(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      if (uids.length === 0) return;
      const lock = await client.getMailboxLock(await meta.path());
      try {
        /* THE RESULT IS READ, AND THEN CHECKED AGAINST THE FOLDER. `messageDelete` resolves
         * `false` when the server refuses — it does not reject — and this discarded that, so a
         * refused cleanup was reported as a completed one and every prior document stayed. Worse,
         * a `true` proves only that an EXPUNGE ran: the STORE that marks `\Deleted` is internal to
         * the library and its result is not propagated, so a refused store with an accepted expunge
         * removes nothing and still resolves `true`. Custody is read back. */
        const done = await client.messageDelete(uids, { uid: true });
        if (done === false) {
          throw new ProfileUnavailableError(
            `the server refused to expunge ${uids.length} settings message(s) from ${META_FOLDER}`,
            { op: "remove_profiles" },
          );
        }
        if (typeof client.fetch === "function") {
          const still: number[] = [];
          try {
            for await (const m of client.fetch(uids.join(","), { uid: true }, { uid: true })) {
              if (typeof m.uid === "number") still.push(m.uid);
            }
          } catch (err) {
            /* The lease's rule, and for the same reason: a custody read that could not RUN proves
             * nothing in either direction, and returning normally here reports removal to a caller
             * that counts it. `writeOrganizerProfile` sets `removed = oldRefs.length` from a normal
             * return, so the count described settings documents that may still be in the folder. */
            throw new ProfileUnavailableError(
              `the expunge of ${uids.length} settings message(s) from ${META_FOLDER} could not be `
              + `verified: ${err instanceof Error ? err.message : String(err)}`,
              { op: "remove_profiles" },
            );
          }
          if (still.length > 0) {
            throw new ProfileUnavailableError(
              `${still.length} settings message(s) survived the expunge in ${META_FOLDER}`,
              { op: "remove_profiles" },
            );
          }
        }
      } finally {
        lock.release();
      }
    },
  };

  /**
   * The read gets a wall clock; the writes deliberately do not. One budget for the whole read
   * rather than one per round trip, because this read is a walk — a STATUS, a windowed SEARCH, a
   * source fetch per record — and per-command clocks compose into a total nobody bounded; the
   * socket's timer is inactivity-based and a byte-at-a-time reply resets it for ever. A breach
   * abandons a command the driver is still running, so the connection is finished — both callers
   * close it — and an abandoned APPEND could still land, which is why the writes are not raced.
   */
  return {
    ...io,
    listProfileMessages: async (opts?: { complete?: boolean }): Promise<RawProfileMessage[]> =>
      ImapDeadline.in(IMAP_META_DEADLINE_MS, "read_deadline", now)
        .race(io.listProfileMessages(opts), META_FOLDER),
  };
}

// ── READ ────────────────────────────────────────────────────────────────────────────────────

/**
 * What a read of the folder found — the caller's vocabulary for the whole feature: `found` — a
 * readable document; `doc` is it, `installId` who wrote it (or null). `none` — no profile message
 * at all; defaults apply, never an error. `newer` — the newest thing was written by a later
 * format; the caller must not overwrite it and cannot import from it: "written by a newer
 * ohmail". `unreadable` — only corrupt profile message(s); reported, and replaceable by the next
 * write, since a corrupt copy of our own bookkeeping carries nothing recoverable.
 */
export type ProfileReadResult =
  | {
    state: "found"; doc: OrganizerProfileDoc; installId: string | null; ref: unknown;
    /**
     * The generation `ref` was read under (mail 0094's mirror writer needs it). `ref` alone is a
     * uid, and storing one without its generation is the defect this pair prevents. A caller that
     * wants to REMEMBER where this document was must store both, and this is the only source
     * actually paired with the uid: fetching one separately is the manufactured pair — the
     * adapter selects other folders between calls. This value comes from the same lock as the
     * fetch. `null` means the server did not report one — an unusable locator, never "any
     * generation will do".
     */
    generation: Generation;
    /**
     * Profile records in the folder BESIDE the chosen one — crash residue, or the loser of a
     * transient organizer overlap. Zero in the steady state; a caller that owns the mailbox
     * heals a non-zero residue by rewriting, which expunges everything but its own document.
     */
    residue: number;
  }
  | { state: "none" }
  | { state: "newer"; v: number }
  | { state: "unreadable"; reason: string };

/**
 * READ `ohmail/_meta` AND SAY WHAT PROFILE IT HOLDS.
 *
 * Coalescing, for the crash-between-append-and-expunge state: among readable documents the
 * newest `updatedAt` wins (ties broken on the serialized content, so every reader picks the
 * same one from the same set). A single `newer` document anywhere DOMINATES every readable one:
 * an older build must never conclude "the current profile is the old one I can read" while a
 * newer producer's document sits beside it — that is how a downgrade quietly becomes a data
 * loss.
 */
/**
 * The largest profile message this build will parse. The document is the body, handed to
 * `JSON.parse`, and nothing bounded that: a 500 MB message in `ohmail/_meta` was a 500 MB string,
 * a parse, and a canonical re-serialization, all inside one request; the per-list COUNT ceilings
 * run after the parse, bounding the transaction and not the read. Generous, not tight, because
 * ohmail writes this message itself and a ceiling under what the product emits would turn a heavy
 * user's own settings into `unreadable`: the number is a multiple of the largest document the
 * import would ever ACCEPT (`PROFILE_IMPORT_MAX`'s four ceilings come to roughly 15 MB). 64 MiB
 * is >4x the largest useful document and still FINITE, which is the property being bought.
 */
export const PROFILE_DOC_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The ceiling on one read of `ohmail/_meta` for profile documents — a different bound from the
 * one above, and the difference is why both exist: {@link PROFILE_DOC_MAX_BYTES} bounds ONE
 * DOCUMENT and is checked by the parser after the bytes are in hand, so it says nothing about how
 * many messages are fetched and buffered — which is what an attacker with APPEND rights actually
 * chooses. Deliberately the same number as the lease's ceiling: one folder, the same handful of
 * legitimate records, and two different ceilings on one folder is two numbers to keep in step for
 * no benefit.
 */
export const PROFILE_MESSAGES_MAX_PER_FETCH = 500;

/**
 * The other axis of the same read — a count ceiling alone does not bound it. This read asks for
 * FULL SOURCES: at {@link PROFILE_DOC_MAX_BYTES} apiece a window's worth is gigabytes, buffered
 * into one array before any parse. Whoever can append chooses which ceiling to spend, so both
 * exist — the count stops many small messages, this stops a few enormous ones. Generous against
 * the legitimate population (one current document plus uncollected residue), far below anything
 * that threatens the process. A bound on what is KEPT, not a stopping point: the window arrives
 * oldest-first, so stopping keeps the oldest and drops the current document — a message past
 * either ceiling EVICTS FROM THE FRONT instead.
 */
export const PROFILE_BYTES_MAX_PER_FETCH = 128 * 1024 * 1024;

/**
 * THE REFUSAL'S NAME, CARRIED THROUGH THE WRAPPER.
 *
 * `describeCause` walks a BOUNDED chain, so a code two wrappers down reaches no line at all —
 * measured on a reader, where the write path's line read `causeClass: "ProfileUnavailableError",
 * causeCode: null` while the root refusal had a name. Forwarding it means one field names the
 * refusal whatever wrapped it.
 */
function askCodeOf(err: unknown): string | undefined {
  return err instanceof ProfileUnavailableError ? err.code : undefined;
}

/** A `MalformedProfile`, with `ref` omitted rather than set to `undefined` (the parser's rule). */
function malformedProfile(reason: string, ref: unknown): MalformedProfile {
  return ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };
}

export async function readOrganizerProfile(io: ProfileIo): Promise<ProfileReadResult> {
  let messages: RawProfileMessage[];
  try {
    messages = await io.listProfileMessages();
  } catch (err) {
    throw new ProfileUnavailableError(
      `the organizer profile in ${META_FOLDER} could not be read`,
      { op: "list_profiles", cause: err, code: askCodeOf(err) },
    );
  }
  const records = messages
    .map((m) => (
      // BEFORE the parse — see {@link PROFILE_DOC_MAX_BYTES}. An oversized message is reported
      // as MALFORMED rather than ignored, for the reason that state already exists: a message
      // carrying `X-Ohmail-Profile: 1` is a copy of our own bookkeeping, and one this build
      // cannot read is worth saying so about. `Buffer.byteLength` is the wire size; `.length` is
      // UTF-16 units and would let a multi-byte document past a byte ceiling.
      Buffer.byteLength(m.raw, "utf8") > PROFILE_DOC_MAX_BYTES
        ? malformedProfile(
          `the saved settings message is larger than ${PROFILE_DOC_MAX_BYTES} bytes`, m.ref,
        )
        : parseProfileMessage(m.raw, m.ref)
    ))
    .filter((r): r is ProfileRecord => r !== null);

  if (records.length === 0) return { state: "none" };

  /**
   * The call's generation, and it must be ONE. Every message in one `listProfileMessages()` comes
   * from one SELECT of one folder on one connection, so they share one generation; reading it off
   * the messages rather than asking the connection again is the point — the value reaching
   * `found` is the one the uids were actually issued under. A set reporting more than one
   * distinct generation is not a folder state — it is evidence the producer is manufacturing the
   * pair, refused as unreadable rather than resolved by picking one: picking hands back a locator
   * that looks usable and is not. Anything that is not a number or bigint is `null` — "the server
   * did not say", an unusable locator, never "any generation will do".
   */
  const generations = new Set(messages.map((m) => (
    typeof m.generation === "number" || typeof m.generation === "bigint" ? m.generation : null
  )));
  if (generations.size > 1) {
    return {
      state: "unreadable",
      reason: "the settings messages disagree about the folder's generation, so no locator among "
        + "them can be trusted",
    };
  }
  const generation: Generation = [...generations][0] ?? null;

  const newer = records.filter((r): r is ParsedProfileMessage => !isMalformedProfile(r) && r.status === "newer");
  if (newer.length > 0) {
    return { state: "newer", v: Math.max(...newer.map((r) => r.v)) };
  }

  const ok = records.filter((r): r is ParsedProfileMessage => !isMalformedProfile(r) && r.status === "ok");
  if (ok.length === 0) {
    const first = records.find(isMalformedProfile);
    return { state: "unreadable", reason: first?.reason ?? "unreadable profile" };
  }

  const newest = [...ok].sort((a, b) => {
    const at = Date.parse(a.doc!.updatedAt);
    const bt = Date.parse(b.doc!.updatedAt);
    const d = (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
    if (d !== 0) return d;
    /* THE SAME RULE AS `byCodeUnit`'s header, and this one decides WHICH DOCUMENT WINS.
       Two records stamped the same instant are separated here, and under `localeCompare` two
       installs reading the same folder could pick DIFFERENT documents as the newest — after
       which each would go on believing the other's configuration was a stranger's. A tie-break
       that is not stable across machines is not a tie-break. */
    const byDoc = byCodeUnit(JSON.stringify(b.doc), JSON.stringify(a.doc));
    if (byDoc !== 0) return byDoc;
    /**
     * Identical timestamp and identical document, different records — two installs writing the
     * same configuration. The comparator returned 0, so the winner depended on folder listing
     * order, and the winner's `installId` decides whether a reader treats the document as its own
     * or a stranger's. Deterministic now, by the RIGHT key: `ref` DESCENDING — the ref is the uid
     * and the dance is append-then-expunge, so a higher uid IS a later write. An earlier
     * tie-break sorted by `installId` — deterministic and meaning nothing — and silently changed
     * which record won: a promoted reader stopped arming its import hold. `installId` stays as
     * the final tie-break, where it decides nothing observable.
     */
    const refA = Number(a.ref);
    const refB = Number(b.ref);
    if (Number.isFinite(refA) && Number.isFinite(refB) && refA !== refB) return refB - refA;
    return byCodeUnit(String(b.ref ?? ""), String(a.ref ?? ""))
      || byCodeUnit(String(a.installId ?? ""), String(b.installId ?? ""));
  })[0]!;

  return {
    state: "found", doc: newest.doc!, installId: newest.installId, ref: newest.ref,
    /* THE ONE THE UID WAS READ UNDER — see the field's own comment. Taken from the messages this
       read parsed, never from the connection at this moment, because by now the caller's adapter
       may have selected another folder entirely. */
    generation,
    residue: records.length - 1,
  };
}

// ── WRITE ───────────────────────────────────────────────────────────────────────────────────

export interface WriteProfileInput {
  io: ProfileIo;
  doc: OrganizerProfileDoc;
  /** Who is writing — recorded in the message header so the writer recognises its own copy. */
  installId: string;
  /**
   * Payload fingerprints of FOREIGN documents the caller has already accounted for — its own
   * last-written/seeded fingerprint, and any foreign document it has surfaced. A readable
   * foreign document whose fingerprint is on this list is replaceable; one that is NOT is new
   * information, and the write is refused as `foreign` so the caller can surface it first.
   * A caller that passed nothing can never silently expunge foreign content.
   */
  replaceable?: readonly string[];
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export type WriteProfileResult =
  | { written: true; removed: number }
  /** The folder holds a document from a NEWER format. Refused — see the versioning rules. */
  | { written: false; reason: "newer"; v: number }
  /**
   * The folder holds a readable FOREIGN document the caller has not seen (its fingerprint is on
   * neither the `replaceable` list nor equal to the document being written). Refused, and the
   * document is handed back so the caller can surface it — log + durable marker — before
   * deciding to supersede it on a later write. This is what makes a transient organizer overlap
   * unable to DESTROY the other side's configuration silently: content only ever leaves the
   * folder after the incumbent has recorded that it saw it.
   */
  | { written: false; reason: "foreign"; doc: OrganizerProfileDoc; installId: string | null };

/**
 * Write the current profile — append the new copy, THEN expunge the old ones. The order is
 * load-bearing, as for the claim: expunging first means a crash leaves NO profile, which reads as
 * "this mailbox stored no settings"; appending first leaves two, which readers coalesce.
 * Expunged: every other message that parses as a profile record — our older copies, previous
 * organizers' (last-incumbent-wins), corrupt copies. Never touched: anything that is not a
 * profile record — the lease's claims cannot enter the removal set by construction. The one
 * refusal: a NEWER-format document anywhere in the folder — the caller surfaces "written by a
 * newer ohmail" and keeps its local state.
 */
export async function writeOrganizerProfile(input: WriteProfileInput): Promise<WriteProfileResult> {
  const { io, doc, installId } = input;
  const log = input.log ?? ((): void => undefined);
  try {
    await io.ensureMetaFolder();
  } catch (err) {
    throw new ProfileUnavailableError(
      `the meta folder ${META_FOLDER} could not be created, so this mailbox's settings cannot travel`,
      { op: "ensure_meta", cause: err },
    );
  }
  let messages: RawProfileMessage[];
  try {
    // COMPLETE, not the bounded read. Both refusals below are made from this list, and a refusal
    // that quietly did not look far enough is the failure they exist to prevent: an older organizer
    // appending v1 over a v2 document it never fetched, with every later read then agreeing the
    // rollback is current.
    messages = await io.listProfileMessages({ complete: true });
  } catch (err) {
    throw new ProfileUnavailableError(
      `the organizer profile in ${META_FOLDER} could not be read before writing`,
      { op: "list_profiles", cause: err, code: askCodeOf(err) },
    );
  }
  const records = messages
    .map((m) => parseProfileMessage(m.raw, m.ref))
    .filter((r): r is ProfileRecord => r !== null);

  const newer = records.find((r): r is ParsedProfileMessage => !isMalformedProfile(r) && r.status === "newer");
  if (newer) return { written: false, reason: "newer", v: newer.v };

  // ── AN UNSEEN FOREIGN DOCUMENT REFUSES THE WRITE — see the result member's doc-comment ────
  //
  // Ours-by-install-id and malformed records are always replaceable (our own older copies are
  // the dance's residue; a corrupt record carries nothing recoverable). A readable FOREIGN
  // record is replaceable only when the caller has seen it: its payload fingerprint is on the
  // `replaceable` list, or it says exactly what the document being written says.
  const known = new Set(input.replaceable ?? []);
  const docFingerprint = profileFingerprint(doc);
  const unseen = records.find((r): r is ParsedProfileMessage => {
    if (isMalformedProfile(r) || r.status !== "ok") return false;
    if (r.installId === installId) return false;
    const fp = profileFingerprint(r.doc!);
    return fp !== docFingerprint && !known.has(fp);
  });
  if (unseen) return { written: false, reason: "foreign", doc: unseen.doc!, installId: unseen.installId };

  // Captured BEFORE the append, so the copy we are about to write can never be in its own
  // removal set — the crash-safety of append-then-expunge depends on that.
  const oldRefs = records.map((r) => r.ref).filter((r): r is unknown => r !== undefined);

  try {
    await io.appendProfile(formatProfileMessage(doc, { installId }));
  } catch (err) {
    throw new ProfileUnavailableError(
      `the organizer profile in ${META_FOLDER} could not be written`,
      { op: "append_profile", cause: err },
    );
  }

  let removed = 0;
  if (oldRefs.length > 0) {
    try {
      await io.removeProfiles(oldRefs);
      removed = oldRefs.length;
    } catch (err) {
      // Harmless, and deliberately NOT a throw: the new document IS in the folder, so throwing
      // here would tell the caller the write failed and make it rewrite an identical copy every
      // cycle. The folder holds the new document plus older ones, readers coalesce by
      // `updatedAt`, and the NEXT write's own list captures the leftovers. The bare string under
      // `err` is the lease's convention — `log.ts` reduces `err` to class + code, and a string
      // gives a future redactor bug no object to walk.
      log("profile_cleanup_failed", {
        op: "remove_profiles" satisfies ProfileOp,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { written: true, removed };
}
