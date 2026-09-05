import { createHash } from "node:crypto";
import { META_FOLDER, makeMetaFolderRef, lastSequence, type MetaFolderClient } from "./organizer-lease.js";

/**
 * THE PORTABLE ORGANIZER PROFILE — how a mailbox carries its own organizer configuration.
 *
 * The organizer lease beside this module answers "WHO organizes this mailbox"; this document
 * answers "HOW this mailbox wants to be organized". Both live in the same unsubscribed
 * `ohmail/_meta` folder, because the mailbox is the only medium every deployment shares: a
 * desktop install, the hosted service and a self-hosted server can never query each other's
 * databases, but they all read the same folder. Connect the same mailbox from any of them and
 * the configuration is waiting — no export step, no transfer flow, no account linkage.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE DOCUMENT FORMAT — public, versioned, and FROZEN at v1
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * This section is the format's specification. The format is deliberately public: the point of
 * storing configuration in the user's own mailbox is that it stays THEIRS — move between ohmail
 * deployments and it travels; stop using ohmail entirely and it is still there, in the mailbox,
 * as JSON anything can parse.
 *
 * One RFC822 message in `ohmail/_meta`:
 *
 *   · Header `X-Ohmail-Profile: 1` — the discriminator. A message WITHOUT it is not a profile
 *     and is invisible to this module (the organizer lease's claim messages live in the same
 *     folder and carry `X-Ohmail-Lease: 1` instead; each module ignores the other's records).
 *   · Header `X-Ohmail-Install-Id` — WHICH organizer wrote this copy. Transport bookkeeping,
 *     not configuration: it lets an organizer recognise its own previous write, and it is
 *     deliberately a header rather than a JSON field so the document itself stays free of
 *     anything install-specific.
 *   · A plain-text body: a short human preamble (for whoever finds the message in an ordinary
 *     mail client), then the JSON document. A reader takes the substring from the body's first
 *     `{` to its last `}` — the preamble is guaranteed not to contain `{`.
 *
 * The JSON document, version 1:
 *
 *   {
 *     "v": 1,                          // format version. REQUIRED. See versioning below.
 *     "updatedAt": "<ISO 8601>",       // when this copy was written, by the writer's clock
 *     "producer": {                    // which kind of organizer wrote it — provenance, not identity
 *       "kind": "local" | "cloud" | …, // an open set; readers must tolerate unknown kinds
 *       "version": "<build label>"
 *     },
 *     "screener": [                    // senders this mailbox has SCREENED IN (admitted)
 *       { "address": "<sender email, lowercased>", "name": "<display name, optional>" }
 *     ],
 *     "rules": [                       // where mail from matched senders is filed
 *       {
 *         "kind": "sender" | "domain" | "header",
 *         "match": "<address | domain | header spec>",
 *         "destination": "<canonical folder NAME, e.g. ohmail/Reads>",
 *         "priority": 0,
 *         "enabled": true,
 *         "provenance": "manual" | "migrated" | "promoted" | "seeded-from-sent",
 *         "subjectContains": "<optional narrowing term>",
 *         "bodyContains": "<optional narrowing term>"
 *       }
 *     ],
 *     "notifyRules": [                 // senders/threads opted back INTO notifications
 *       { "kind": "sender" | …, "target": "<spec>" }
 *     ],
 *     "awayResponder": {               // the single per-mailbox autoresponder, or null
 *       "enabled": false,
 *       "body": "<string or null>",
 *       "startsAt": "<ISO 8601 or null>",
 *       "endsAt": "<ISO 8601 or null>",
 *       "audience": "screened_in" | "everyone",
 *       "throttle": "per_day" | …      // absent in a document written before 0087
 *     },
 *     "tagNames": ["<tag name>", …]    // the names of this mailbox's tags
 *   }
 *
 * ── NATURAL KEYS ONLY, AND THAT IS A RULE, NOT A STYLE ─────────────────────────────────────
 *
 * Every entry is keyed by what it MEANS — a sender address, a folder name, a tag name — never by
 * an internal row id. A row id names a row in one deployment's database; the document has to be
 * readable by a deployment that has never seen that database, and by software that is not ohmail
 * at all. Screened-OUT senders are not a separate section: a screen-out is recorded as a rule
 * whose destination is `ohmail/Screened`, because that is what the decision durably IS.
 *
 * ── VERSIONING: TOLERANT FORWARD, HONEST ABOUT NEWER ───────────────────────────────────────
 *
 *  · A reader IGNORES unknown fields at every level. A v1 reader handed a v1 document that a
 *    later build decorated with extra fields reads the fields it knows and drops the rest —
 *    that is what lets a 0.9.x desktop and a HEAD server read each other's documents.
 *  · A reader REFUSES only a document whose `v` is greater than the version it implements, and
 *    the refusal is a typed `newer` result, never an error: the caller says "written by a newer
 *    ohmail" and leaves the document alone. {@link writeOrganizerProfile} enforces the leaving-
 *    alone: an organizer that finds a newer document in the folder will not overwrite it, because
 *    it cannot represent fields it does not know and a rewrite would silently drop them.
 *  · Absence of the document ⇒ defaults. A missing profile is a mailbox that has not stored one,
 *    never an error, and deleting the message only resets ohmail's settings for the mailbox.
 *
 * ── NEVER SECRETS ───────────────────────────────────────────────────────────────────────────
 *
 * No credential, token or key of any kind is ever part of this document — not the mailbox
 * password (the organizer holds it, the document does not), not API keys, not KEK material.
 * The serializers in the composition layer read ONLY the configuration columns named above, and
 * the suite pins the document's exact key census so a new field is a reviewed decision, not a
 * drive-by. The document also carries no adaptive state (learning signals, graduations) — v1 is
 * the human-made configuration and nothing inferred.
 *
 * ── UPDATE = APPEND NEW + EXPUNGE OLD — THE LEASE'S DANCE, FOR THE LEASE'S REASON ───────────
 *
 * IMAP has no in-place update. The new copy is APPENDED FIRST and the old copies expunged after,
 * so a crash between the two steps leaves TWO documents rather than none; readers coalesce by
 * `updatedAt` (newest wins) and the writer's next update cleans up the extras. Exactly one
 * current profile message is the steady state.
 *
 * Only the ACTIVE organizer writes — the organizer lease already serializes writers, so
 * last-incumbent-wins and no merge algorithm exists. This module does not check the lease; the
 * compositions call it only from inside a cycle the lease gate has already admitted, which is the
 * same single-writer discipline every other organizer-side write rides.
 */

/** The profile format version this build writes and fully understands. */
export const PROFILE_VERSION = 1;

/**
 * How many uids go into one FETCH command when the settings records are addressed by uid. Keeps
 * both the command line and the in-flight reply bounded regardless of how many the server named.
 */
const PROFILE_FETCH_BATCH = 100;

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
  // The header block ends at the first blank line; a mention in the BODY is not a discriminator.
  const sep = /\r?\n\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : raw;
  return head.toLowerCase().includes(`${H.profile.toLowerCase()}:`);
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
 * The single per-mailbox autoresponder. Timestamps are ISO 8601 strings or null.
 *
 * `subject` is GONE (mail 0087): the responder is reply-only and derives `Re: <what they wrote>`,
 * so there is no subject to travel. A document written by an older ohmail still carries the field
 * and the parser simply does not read it — an unknown key is not an error in this format, which is
 * what makes the removal safe in both directions. `throttle` is new and defaults to `'per_day'` for
 * a document that predates it, which is the rate every row migrated by 0087 carries.
 *
 * `PROFILE_VERSION` deliberately does NOT move for this. The envelope's version is about what a
 * reader must UNDERSTAND to apply a document safely, and both changes are backward- and
 * forward-compatible at the field level: an old reader ignores `throttle` and applies the rest
 * correctly, a new reader defaults it. Bumping would make every older install refuse a document it
 * can read perfectly well, which is the opposite of what the version is for.
 */
export interface ProfileAwayResponder {
  enabled: boolean;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  audience: string;
  throttle: string;
}

/** The configuration itself — everything that travels, and nothing else. */
export interface OrganizerProfilePayload {
  screener: ProfileScreenerEntry[];
  rules: ProfileRuleEntry[];
  notifyRules: ProfileNotifyRuleEntry[];
  awayResponder: ProfileAwayResponder | null;
  tagNames: string[];
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
    && p.awayResponder === null && p.tagNames.length === 0;
}

/**
 * ONE CANONICAL ORDER, so equality is content equality.
 *
 * The dirty check that drives write-behind is a fingerprint comparison, and a fingerprint over an
 * unordered serialization would report "changed" whenever a database happened to return rows in a
 * different order — which is a rewrite of the document per poll interval on some drivers. Sorting
 * by the natural keys makes the fingerprint a function of the configuration and of nothing else.
 */
export function canonicalizeProfilePayload(p: OrganizerProfilePayload): OrganizerProfilePayload {
  const str = (v: string | undefined | null): string => v ?? "";
  return {
    screener: [...p.screener]
      .map((s) => (s.name === undefined || s.name === null ? { address: s.address } : { address: s.address, name: s.name }))
      .sort((a, b) => a.address.localeCompare(b.address)),
    rules: [...p.rules]
      .map((r) => ({
        kind: r.kind, match: r.match, destination: r.destination,
        priority: r.priority, enabled: r.enabled, provenance: r.provenance,
        ...(r.subjectContains === undefined || r.subjectContains === null ? {} : { subjectContains: r.subjectContains }),
        ...(r.bodyContains === undefined || r.bodyContains === null ? {} : { bodyContains: r.bodyContains }),
      }))
      .sort((a, b) =>
        a.kind.localeCompare(b.kind)
        || a.match.localeCompare(b.match)
        || str(a.subjectContains).localeCompare(str(b.subjectContains))
        || str(a.bodyContains).localeCompare(str(b.bodyContains))
        || a.destination.localeCompare(b.destination)
        || a.priority - b.priority
        || a.provenance.localeCompare(b.provenance)
        || Number(a.enabled) - Number(b.enabled)),
    notifyRules: [...p.notifyRules]
      .map((n) => ({ kind: n.kind, target: n.target }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target)),
    awayResponder: p.awayResponder === null ? null : {
      enabled: p.awayResponder.enabled,
      body: p.awayResponder.body,
      startsAt: p.awayResponder.startsAt,
      endsAt: p.awayResponder.endsAt,
      audience: p.awayResponder.audience,
      throttle: p.awayResponder.throttle,
    },
    tagNames: [...p.tagNames].sort((a, b) => a.localeCompare(b)),
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
    };
  }
  const tagNames: string[] = Array.isArray(raw.tagNames)
    ? raw.tagNames.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  return { screener, rules, notifyRules, awayResponder, tagNames };
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
export class ProfileUnavailableError extends Error {
  readonly op: ProfileOp;
  constructor(message: string, options: { op: ProfileOp; cause?: unknown }) {
    super(message, options);
    this.name = "ProfileUnavailableError";
    this.op = options.op;
  }
}

/** One message in the meta folder, as the IO layer sees it — the FULL source, not headers. */
export interface RawProfileMessage {
  ref: unknown;
  raw: string;
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
  readonly mailbox?: { exists?: number } | false;
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
    query: { messages?: boolean },
  ): Promise<{ messages?: number } | false | undefined>;
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
    query: { header?: Record<string, string | boolean> },
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
  limits?: { maxBytes?: number },
): ProfileIo {
  const maxBytes = limits?.maxBytes ?? PROFILE_BYTES_MAX_PER_FETCH;
  // The lease's resolution, not a second one. The profile and the claim share a folder, so a
  // second spelling of where that folder is would put the settings document and the lease in
  // different places on exactly the servers where it matters.
  const meta = makeMetaFolderRef(client, toServerPath);

  return {
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
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *  THE SAME FOLDER, THE SAME BOUND — and this read is the expensive one
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * `ohmail/_meta` is shared with the lease, whose own read is bounded newest-first
     * (`organizer-lease.ts#readMetaFolderWindow`). This one was NOT, and it is the costlier of the
     * two on both axes: it asks for FULL SOURCES rather than headers, buffers them into an array,
     * and runs on the organizer's hot paths — once per attach for the hold, once per cycle for the
     * routing question. So a folder anyone with APPEND rights can write to decided how much work
     * every cycle did AND how much memory it took, which is precisely the defect the lease's bound
     * removed, with bodies instead of headers. The per-document ceiling is checked by the PARSER,
     * after the bytes are already in hand, so it never bounded this.
     *
     * It is a second loop rather than a call to the shared one because the shared one fetches
     * HEADERS and this needs SOURCES — the two ask the server for different things. What is shared
     * is the rule, and it is spelled the same way on purpose: newest-first, one ceiling, and the
     * empty-folder defence.
     *
     * NEWEST-FIRST is not a preference here either. The profile is a document the organizer
     * APPENDS, newest wins, so everything this read is about is at the END of the folder — a
     * ceiling that kept the oldest records would hide the current document behind whatever else
     * accumulated after it, and the caller would read "no settings have been published" for a
     * mailbox that has some.
     *
     * TRUNCATION IS NOT REFUSED HERE, unlike the record drains. The question this read answers is
     * "what is the newest document", and the newest-first window answers it by construction
     * whenever the document is inside the window. The residual is the lease's: a document older
     * than the last {@link PROFILE_MESSAGES_MAX_PER_FETCH} appends is not seen.
     *
     * ── AND A CACHED ZERO IS NOT A KNOWN ZERO ────────────────────────────────────────────────
     *
     * This read consulted `client.mailbox.exists` directly. That is a CACHE a connection updates
     * only from untagged responses, and `getMailboxLock` does not re-SELECT a folder that is
     * already selected — measured against a real server, it stayed 0 for ten seconds after another
     * connection appended. Three reads in the lease were corrected for this; this was the fourth
     * and was missed. A stale zero here reads as "nobody has published settings for this mailbox".
     */
    async listProfileMessages(opts?: { complete?: boolean }): Promise<RawProfileMessage[]> {
      // Resolved ONCE and reused for both the lock and the count probe, so the two can never name
      // different folders.
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        const out: RawProfileMessage[] = [];
        /* ── A NOOP CANNOT PROVE A REFRESH, SO NOTHING HERE RESTS ON ONE ────────────────────
         *
         * This NOOP'd and treated the call resolving as proof the cached count was current. The
         * library discards the command's own result (`imap-flow.js` 1.5.0: `async noop() { await
         * this.run('NOOP'); }`), so a REFUSED noop resolves exactly like an accepted one and
         * "refreshed" was inferred from the absence of a throw.
         *
         * Here that meant a stale cached zero could be trusted and the read return "no settings
         * have been published" for a mailbox that has some. The count is asked for outright
         * instead: {@link lastSequence} issues a STATUS naming the folder, which is answered on an
         * empty folder as readily as a full one — so unlike the FETCH probe this replaced, it needs
         * no zero check in front of it. The connection's cached `exists` is consulted only where
         * the server cannot be asked at all. */
        const selected = client.mailbox;
        const cached = typeof selected === "object" && selected !== null ? selected.exists : undefined;
        const probed = await lastSequence(client, metaPath);
        /* The lease's rule, for the same reason: a cached count may END this read (an empty folder
         * is cheap to be wrong about in one direction only) but may never be COUNTED BACK from,
         * because nothing confirms it and a window in the wrong place loses the document. */
        if (probed === 0) return out;
        if (probed === undefined && cached === 0) return out;
        const total = probed;
        /* `lastSequence` is imported rather than reimplemented. One folder should not have two
         * answers to "how many messages are in it", and a copy here with a comment pointing at the
         * original is exactly how the two come to disagree. */
        const from = typeof total === "number" && total > PROFILE_MESSAGES_MAX_PER_FETCH
          ? total - PROFILE_MESSAGES_MAX_PER_FETCH + 1
          : 1;
        /* ── BOTH AXES, AND BOTH EVICT FROM THE FRONT ──────────────────────────────────────
         *
         * `bytes` is not a second thought about the same bound: the count ceiling stops many small
         * messages and the byte one stops a few enormous ones, and whoever can append picks
         * whichever is cheaper.
         *
         * NEITHER MAY `break`. The window arrives oldest-first within its range, so stopping on a
         * ceiling keeps the OLDEST records — the exact inversion this read was bounded to remove,
         * reintroduced by the bound itself. The count ceiling could not reach it on the
         * known-count path (the range already starts at the right place), but the BYTE ceiling
         * could, and cheaply: one large append early in the window and the read returns everything
         * except the current document, reporting "no settings have been published" for a mailbox
         * that has some.
         *
         * So each message is pushed and then the oldest are dropped until both ceilings hold, with
         * the evicted bytes subtracted — a sliding window rather than a stopping point.
         *
         * `win.length > 1` on the byte arm keeps the newest message even when it ALONE is over the
         * ceiling: a document too large to be worth reading is the PARSER's refusal to make
         * ({@link PROFILE_DOC_MAX_BYTES}), and silently returning nothing for it would be the same
         * "no settings published" lie by another route. */
        /* ── THE CEILINGS ARE SPENT ON PROFILE RECORDS, NOT ON WHATEVER SHARES THE FOLDER ─────
         *
         * `ohmail/_meta` also holds the lease's claims, and anyone with APPEND rights can put
         * anything else in it. Counting those against these ceilings meant five hundred later
         * newsletters could evict the current document — and this list is not only what a READ
         * returns. {@link writeOrganizerProfile} makes its `newer` and `foreign` refusals from it,
         * and those refusals are the whole reason a build that cannot represent a v2 document will
         * not overwrite one. An evicted v2 is not a document missing from a read; it is an older
         * organizer appending v1 over settings it never saw, with every later read then agreeing
         * that the rollback is current. Silent, durable, and in the customer's own mailbox.
         *
         * So the retention test is applied AFTER the discriminator. A flood of non-profile messages
         * now costs transfer and nothing else. */
        const complete = opts?.complete === true;

        /**
         * ── EVERY SOURCE THIS ADAPTER READS COMES THROUGH HERE, AND IT ALWAYS RANGES ────────
         *
         * ONE reply, asked for as `BODY.PEEK[]<0.N>`, so the server sends at most N bytes
         * whatever the message weighs. Three separate places used to fetch source and only one
         * of them was bounded, which is why the transport bound was reported closed twice while
         * two routes to an unbounded transfer stayed open.
         *
         * THE SERVER'S SIZE CLAIM IS UNTRUSTED INPUT. The size pass is a PREFILTER — it lets an
         * obviously huge record be skipped without asking for it at all — and it is not a bound,
         * because a server free to answer `RFC822.SIZE: 1` is free to then send ten megabytes.
         * Anything that decides what to transfer from a number the same server supplied is
         * trusting the thing it is defending against. So measured and unmeasured are fetched the
         * same way, and the reported size never decides the range.
         *
         * N IS THE REMAINING BUDGET PLUS ONE, which makes the answer exact rather than merely
         * cautious: a reply SHORTER than N is the whole document and safe to parse, and a reply
         * of exactly N means the message did not fit and is refused unparsed. Asking for exactly
         * the budget cannot tell a document that fits precisely from one that overruns.
         *
         * ONE AT A TIME, because the caller must charge each reply to the budget BEFORE the next
         * range is computed. Fetching a batch together hands every message in it the same nearly
         * full range, so a hundred individually-legal replies transfer a hundred times the
         * budget — the aggregate defeated by the very bound that was supposed to hold it.
         */
        const fetchSourceBounded = async (
          messageset: string,
          byUid: boolean,
          budget: number,
        ): Promise<{ uid: number; source: Buffer } | "over" | null> => {
          const cap = Math.max(1, budget) + 1;
          for await (const m of client.fetch(
            messageset, { uid: true, source: { start: 0, maxLength: cap } }, { uid: byUid },
          )) {
            if (!m.source) continue;
            if (m.source.byteLength >= cap) return "over";
            return { uid: m.uid, source: m.source };
          }
          return null;
        };

        /**
         * The uids of every settings record in the folder, newest last, or `null` when the
         * connection cannot be asked or the server REFUSED — which is not the same answer as
         * "there are none" and must never be read as one.
         */
        const profileUids = async (c: ProfileImapClient): Promise<number[] | null> => {
          if (typeof c.search !== "function") return null;
          const found = await c.search({ header: { [H.profile]: true } }, { uid: true });
          if (!Array.isArray(found)) return null;
          return [...found].sort((a, b) => a - b);
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
          /* Newest first while choosing, so the document that matters is the one kept — then the
           * result is put back in folder order, which is what every caller reads. */
          const chosen: number[] = [];
          let bytes = 0;
          for (const uid of [...capped].reverse()) {
            const size = sizes.get(uid) ?? 0;
            if (chosen.length >= PROFILE_MESSAGES_MAX_PER_FETCH || bytes + size > maxBytes) {
              if (complete) {
                throw new ProfileUnavailableError(
                  `the settings in ${META_FOLDER} could not be read completely: the folder holds `
                  + `more than ${PROFILE_MESSAGES_MAX_PER_FETCH} settings records or ${maxBytes} `
                  + "bytes of them, and a write must see every one before it may replace any",
                  { op: "list_profiles" },
                );
              }
              /* The newest record is kept even when it alone is over the ceiling: a document too
               * large to read is the PARSER's refusal to make, and returning nothing for it is the
               * "no settings published" lie by another route. */
              if (chosen.length > 0) break;
            }
            chosen.push(uid);
            bytes += size;
          }
          const order = chosen.slice().reverse();
          const win: Array<{ rec: RawProfileMessage; size: number }> = [];
          let held = 0;
          let oversized = 0;
          for (const uid of order) {
            const got = await fetchSourceBounded(String(uid), true, maxBytes - held);
            if (got === null) continue;   // expunged in the gap; not evidence about any other
            if (got === "over") {
              if (complete) {
                throw new ProfileUnavailableError(
                  `a settings record in ${META_FOLDER} is larger than the ${maxBytes}-byte budget `
                  + "this read may spend, and a write must see every document whole before it may "
                  + "replace any",
                  { op: "list_profiles" },
                );
              }
            /* ── SKIPPED, BUT NEVER SILENTLY: SEE THE REFUSAL AFTER THE LOOP ──────────────
             *
             * An over-budget record cannot be parsed, because it was never fully transferred —
             * that is the point of the range. On a READ, skipping one is right when there is
             * something else to answer with: an old enormous document would have been evicted by
             * the ceiling anyway, and the newest one is what a read wants.
             *
             * What must not happen is a read that skips the ONLY candidate and returns an empty
             * list, because every caller reads that as "no settings have been published" and
             * routes a person's mail by local defaults. The old contract kept such a record so the
             * PARSER could refuse it out loud; once the document is deliberately never transferred
             * whole, that is no longer available, and the honest equivalent is a refusal from
             * here. Counted, and acted on below. */
            oversized += 1;
              continue;
            }
            const raw = got.source.toString("utf8");
            if (!looksLikeProfile(raw)) continue;
            const size = got.source.byteLength;
            win.push({ rec: { ref: got.uid, raw }, size });
            held += size;
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

        const readFrom = async (start: number): Promise<{
          win: Array<{ rec: RawProfileMessage; size: number }>; seen: number;
        }> => {
          const win: Array<{ rec: RawProfileMessage; size: number }> = [];
          let bytes = 0;
          let seen = 0;
          /* ── THE FALLBACK RANGES TOO, AND IT USED TO BE THE HOLE ────────────────────────
           *
           * This is the path for a connection that cannot SEARCH, and it asked for the whole
           * source of every message in the range. That made the transport bound conditional on a
           * capability the server chooses: on a server without SEARCH, one oversized message in
           * the window exhausted the process before any ceiling was consulted — the same defect
           * the ranged fetch closed on the other path, still open on this one.
           *
           * Two passes now. The first asks only for uids and sequence numbers, which costs
           * nothing to transfer whatever the folder holds; the second asks for each source
           * through the one bounded function, charging the budget after every reply. Slower than
           * one command, and this is the path that runs when the server cannot answer the cheap
           * question — correctness first, and it is the fallback rather than the common case. */
          const addrs: Array<{ uid: number; seq: number }> = [];
          for await (const m of client.fetch(`${start}:*`, { uid: true }, { uid: false })) {
            addrs.push({ uid: m.uid, seq: m.seq ?? 0 });
          }
          for (const at of addrs) {
            seen++;
            const got = await fetchSourceBounded(String(at.seq || at.uid), false, maxBytes - bytes);
            if (got === null) continue;
            if (got === "over") {
              if (complete) {
                throw new ProfileUnavailableError(
                  `a settings record in ${META_FOLDER} is larger than the ${maxBytes}-byte budget `
                  + "this read may spend, and a write must see every document whole before it may "
                  + "replace any",
                  { op: "list_profiles" },
                );
              }
              continue;
            }
            const raw = got.source.toString("utf8");
            if (!looksLikeProfile(raw)) continue;
            const size = got.source.byteLength;
            win.push({ rec: { ref: got.uid, raw }, size });
            bytes += size;
            while (
              win.length > PROFILE_MESSAGES_MAX_PER_FETCH
              // `win.length > 1` keeps the newest record even when it ALONE is over the ceiling, so
              // a document too large to read is the PARSER's refusal to make rather than a silent
              // absence. On a COMPLETE scan that exemption is a hole: the write path parses this
              // list directly, without the reader's per-document guard in front of it, so a single
              // oversized profile-shaped message becomes an unbounded parse on the settings-write
              // path. A complete scan refuses on either ceiling, singleton included.
              || (bytes > maxBytes && (complete || win.length > 1))
            ) {
              /* ── ON A COMPLETE SCAN, EVICTING IS NOT AN OPTION — REFUSE INSTEAD ───────────
               *
               * Reading the whole folder fixed the RANGE; this is the other half. The ceilings
               * still evict, and on the complete path evicting is the same defect wearing the
               * fix's clothes: enough profile-looking records — 500 of them, or 128 MiB of
               * retained source — and the protected document is dropped from the very list the
               * refusal is computed from, so the write proceeds and appends over it. Anyone able
               * to add messages to the folder can produce that, and it costs them only the
               * discriminator header.
               *
               * A caller that must not be wrong is given an ERROR rather than a short list. This
               * is the reader-asymmetry rule at its sharpest: what the write does with "I could
               * not see all of it" is refuse, and a refusal it can act on is worth incomparably
               * more than a plausible answer it cannot check. The read path keeps evicting,
               * because for a read the newest document IS the answer.
               */
              if (complete) {
                throw new ProfileUnavailableError(
                  `the settings in ${META_FOLDER} could not be read completely: the folder holds more `
                  + `than ${PROFILE_MESSAGES_MAX_PER_FETCH} settings records or ${maxBytes} `
                  + "bytes of them, and a write must see every one before it may replace any",
                  { op: "list_profiles" },
                );
              }
              bytes -= win.shift()!.size;
            }
          }
          return { win, seen };
        };

        /* ── A REFUSAL CANNOT BE MADE FROM A WINDOW ───────────────────────────────────────────
         *
         * Filtering the ceilings to profile records keeps a flood from EVICTING the document, but
         * it cannot put back one the RANGE never delivered. A newest-first window starts partway
         * down the folder, so a document with more than a ceiling's worth of messages appended
         * after it is not merely dropped — it is never fetched, and no amount of retention policy
         * changes that.
         *
         * For a read that is fine: the newest document is the current one, and that is what a read
         * wants. For {@link writeOrganizerProfile} it is not, because its `newer` and `foreign`
         * checks are refusals — they must be made against EVERY document in the folder, and a
         * refusal that silently did not look is indistinguishable from one that looked and found
         * nothing. That is the difference between "we did not overwrite the v2 settings" and "we
         * overwrote settings we never saw".
         *
         * So the write asks for a complete scan. The cost is transfer of one folder on a settings
         * write — rare, and never on the per-cycle path the bound was introduced to protect —
         * while retention stays bounded by the ceilings above, which is where the memory risk was.
         */
        /* ── ASK THE SERVER WHICH MESSAGES ARE SETTINGS, RATHER THAN WHERE THEY MIGHT BE ────
         *
         * The retention below spends its ceilings on profile records, which stops a flood from
         * EVICTING the current document. It cannot put back one the RANGE never asked for, and
         * the range was computed over ALL messages: `total - PROFILE_MESSAGES_MAX_PER_FETCH + 1`
         * counts backwards through claims, acknowledgements and whatever else shares the folder.
         * A settings document with a ceiling's worth of later messages on top of it therefore sat
         * outside the window entirely — and the read reported "no settings have been published"
         * for a mailbox that has some. The organizer taking the mailbox over then routes mail by
         * local defaults until the next complete write refuses, which is a person's rules silently
         * not applied rather than an error anybody sees.
         *
         * Only settings records carry the discriminator, so a header SEARCH answers the question
         * the window was approximating: complete for profiles by construction and independent of
         * position. The same medicine as the lease's claim set, for the same reason.
         *
         * ── AND THE BYTES ARE BOUNDED BEFORE THEY ARE DELIVERED, NOT AFTER ─────────────────
         *
         * The byte ceiling was applied to `m.source` — which the library has already buffered in
         * full by the time it is measured. Measuring afterwards bounds what is RETAINED and
         * nothing about what is transferred, so a single hostile literal could exhaust the process
         * before any ceiling was consulted; and every non-profile message in the range was
         * converted to a string and discarded without ever entering the counter. Sizes come first
         * now, in their own cheap pass, and source is fetched only for the records that survive
         * both ceilings.
         */
        const searched = await profileUids(client);
        let read = searched !== null
          ? await readByUid(searched)
          : await readFrom(complete ? 1 : from);

        /* ── AND THE SEQUENCE WINDOW CAN SLIDE OUT FROM UNDER THE RANGE ───────────────────────
         *
         * The same hazard as the lease's read, for the same reason: `from` is a SEQUENCE number
         * from a count taken a round trip ago, and an EXPUNGE on another connection renumbers
         * everything above it downward without touching UIDVALIDITY. A capped window asks for
         * exactly the ceiling's worth of MESSAGES, so `seen` short of it means the folder moved
         * while it was being read — and far enough, `from` lands past the end and the unordered
         * range returns a single message. Throw that away and read the folder whole; `1:*` is
         * anchored at both ends and cannot slide. */
        if (searched === null && !complete && from > 1 && read.seen < PROFILE_MESSAGES_MAX_PER_FETCH) {
          read = await readFrom(1);
        }

        for (const w of read.win) out.push(w.rec);
        return out;
      } finally {
        lock.release();
      }
    },

    async appendProfile(raw: string): Promise<void> {
      await client.append(await meta.path(), raw, ["\\Seen"]);
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
}

// ── READ ────────────────────────────────────────────────────────────────────────────────────

/**
 * What a read of the folder found. The caller's vocabulary for the whole feature:
 *
 *   `found`      — a readable document. `doc` is it; `installId` is who wrote it (or null).
 *   `none`       — no profile message at all. Defaults apply; never an error.
 *   `newer`      — the newest thing in the folder was written by a later format. The caller
 *                  must not overwrite it and cannot import from it; the honest surface is
 *                  "written by a newer ohmail".
 *   `unreadable` — only corrupt profile message(s). Reported, and replaceable by the next
 *                  write: a corrupt copy of our own bookkeeping carries nothing recoverable.
 */
export type ProfileReadResult =
  | {
    state: "found"; doc: OrganizerProfileDoc; installId: string | null; ref: unknown;
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
 * THE LARGEST PROFILE MESSAGE THIS BUILD WILL PARSE.
 *
 * The document is the message BODY, fetched as a full source, and `parseProfileMessage` hands it
 * to `JSON.parse`. Nothing bounded that: a mailbox is a medium anybody with the credentials can
 * write to, and a 500 MB message in `ohmail/_meta` was a 500 MB string, a parse of it, and then
 * a canonical sort and re-serialization of the result — all inside one `GET
 * /mailboxes/:id/profile-import`. The per-list COUNT ceilings (`PROFILE_IMPORT_MAX`) run after
 * the parse and so bound the transaction and not the read, which is this slice's own shape one
 * layer up: the ceiling is applied to the RESULT and not to the READ.
 *
 * ── WHY IT IS GENEROUS AND NOT TIGHT ─────────────────────────────────────────────────────
 *
 * ohmail writes this message itself. A ceiling under what the product emits would turn a heavy
 * user's own saved settings into `unreadable` — the mistake this slice made four separate times
 * in its first attempts, always by writing the bound from a comment instead of from the code
 * that produces the value. So the number is not an estimate of a typical profile; it is a
 * multiple of the largest document the import would ever ACCEPT, which is what
 * `PROFILE_IMPORT_MAX` describes — its four per-list ceilings, at a generous 512 bytes an entry,
 * come to roughly 15 MB in total, and a document larger than the import's own ceiling is one
 * `apply` refuses anyway.
 *
 * 64 MiB is therefore >4x the largest useful document and still FINITE, which is the whole
 * property being bought. It is not a claim that 64 MiB is reasonable to hold — it is the
 * statement that an unbounded read is not, and per-entry string ceilings (which would let this
 * be tight rather than generous) are still owed by the unbounded-read work this does not close.
 */
export const PROFILE_DOC_MAX_BYTES = 64 * 1024 * 1024;

/**
 * THE CEILING ON ONE READ OF `ohmail/_meta` FOR PROFILE DOCUMENTS — a different bound from the one
 * above, and the difference is the whole reason both exist.
 *
 * {@link PROFILE_DOC_MAX_BYTES} bounds ONE DOCUMENT and is checked by the parser, after the bytes
 * are in hand. It therefore says nothing about how many messages are fetched and buffered, which is
 * what an attacker with APPEND rights on the folder actually chooses. This bounds that.
 *
 * Deliberately the same number as the lease's own ceiling: it is one folder, the legitimate
 * population is the same handful of records, and two different ceilings on one folder is two
 * numbers to keep in step for no benefit.
 */
export const PROFILE_MESSAGES_MAX_PER_FETCH = 500;

/**
 * THE OTHER AXIS OF THE SAME READ — and a count ceiling alone does not bound it.
 *
 * This read asks for FULL SOURCES. A ceiling on the NUMBER of messages therefore bounds the count
 * and says nothing about the bytes: at {@link PROFILE_DOC_MAX_BYTES} apiece, a window's worth of
 * documents is measured in gigabytes, all of it buffered into one array before any of it is parsed.
 * Whoever can append to the folder chooses which of the two ceilings to spend, so both have to
 * exist — the count stops many small messages, this stops a few enormous ones.
 *
 * Generous against the legitimate population, which is ONE current document plus whatever has not
 * been collected yet, and far below anything that threatens the process.
 *
 * **It is a bound on what is KEPT, not a point at which the read stops** — and the difference is
 * the whole of it. The window arrives OLDEST FIRST within its range (a sequence range always does),
 * so stopping the loop on either ceiling keeps the oldest records and drops the newest — which is
 * the current document. One large append early in the window would have been enough to make the
 * read report "no settings have been published" for a mailbox that has some. So a message past
 * either ceiling EVICTS FROM THE FRONT instead.
 */
export const PROFILE_BYTES_MAX_PER_FETCH = 128 * 1024 * 1024;

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
      { op: "list_profiles", cause: err },
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
    return JSON.stringify(b.doc).localeCompare(JSON.stringify(a.doc));
  })[0]!;

  return {
    state: "found", doc: newest.doc!, installId: newest.installId, ref: newest.ref,
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
 * WRITE THE CURRENT PROFILE — append the new copy, then expunge the old ones.
 *
 * **That order is load-bearing**, exactly as it is for the claim: expunging first means a crash
 * in between leaves the mailbox with NO profile, which reads to every later connect as "this
 * mailbox stored no settings". Appending first leaves two, which readers coalesce and the next
 * write cleans up.
 *
 * What is expunged: every OTHER message that parses as a profile record — our older copies,
 * previous organizers' copies (last-incumbent-wins: the lease has already serialized writers,
 * so the incumbent's document is the mailbox's truth), and corrupt copies. What is NEVER
 * touched: any message that is not a profile record — the organizer lease's claims live in this
 * same folder and `parseProfileMessage` returns `null` for them, so they cannot enter the
 * removal set by construction.
 *
 * The one refusal: a document from a NEWER format anywhere in the folder. This build cannot
 * represent what it cannot read, so overwriting would silently drop the fields a newer producer
 * wrote. The caller surfaces "written by a newer ohmail" and keeps its local state; nothing is
 * lost in either direction.
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
      { op: "list_profiles", cause: err },
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
