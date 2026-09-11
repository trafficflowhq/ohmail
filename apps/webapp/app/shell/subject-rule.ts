"use client";

/**
 * Splitting one sender by subject — the detection and the plan. `info@sichersatt.ch` sends the
 * invoice AND the nightly `[NinjaFirewall]` alert, and a sender rule can only say one thing about
 * that address; pressing a message's title offers a rule with two terms — from this address AND with
 * this in the subject — and the sheet must guess the second term well enough that the answer is one
 * press. The token is detected, not typed: a free-text box gets `Alert` typed into it, which also
 * catches `Alert: your invoice is overdue`; the repeating token is already in the data. Detection is
 * conservative — `null` is a good answer and the sheet says so ({@link detectSubjectToken}). Pure:
 * the reader is passed in, never captured — `SubjectRuleSheet` renders, `AppShell` dispatches.
 */
import {
  FOLDER_OF_VIEW,
  rulesList,
  senderKey,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type RuleDTO,
} from "@ohmail/client-engine";
import type { DecisionDestination } from "@ohmail/ui";
import { RETRO_DEFAULT_ON, RETRO_VISIBLE_MOVES, type ScreeningDest } from "./sender-screening";

/**
 * The reply/forward decorations a subject accumulates, stripped before anything is extracted.
 *
 * `Re: [NinjaFirewall] Alert` and `[NinjaFirewall] Alert` must yield the SAME token, or a thread the
 * user has answered offers a different rule from the one beside it. German (`AW:`, `WG:`) and French
 * (`TR:`, `RE:`) are here because the measured corpus has them; the list is a prefix loop rather than
 * one regex so `Re: Fwd: Re:` collapses in full.
 */
const REPLY_PREFIX = /^\s*(re|aw|fwd|fw|wg|tr|antw)\s*(\[\d+\])?\s*:\s*/i;

/** Strip every leading reply/forward decoration. Bounded, so a hostile subject cannot spin here. */
export function stripReplyPrefixes(subject: string): string {
  let out = subject;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(REPLY_PREFIX, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * The shortest token worth ruling on. Two characters is `[x]`-shaped noise and a one-character token
 * would match nearly every subject the sender ever sends — a rule that reads as narrow and behaves
 * as the bare sender rule it was meant to refine.
 */
export const MIN_SUBJECT_TOKEN_CHARS = 3;

/**
 * The longest subject term the SERVER accepts — `RulesService`'s own
 * `MAX_SUBJECT_CONTAINS_CHARS` (rules-service.ts), mirrored because the client bundle cannot
 * import the services package. A fragment over this is a 400 on the wire, and a sheet that let
 * it through closed itself, lost the edit, and (with retro on) had already dispatched the
 * visible moves for a rule that was then refused. The sheet refuses the commit instead.
 */
export const MAX_SUBJECT_TERM_CHARS = 200;

/**
 * The candidate tokens a single subject offers, best first. Two shapes only: a bracketed run
 * (`[NinjaFirewall]`, `(Ticket #4)` — how machines tag their own mail; brackets INCLUDED, a far more
 * specific test than the bare word) and a leading label (everything before the first `:`, `-`, `–`,
 * `|` or `»`, taken only from the front — a separator mid-sentence is punctuation). Class ranks
 * first, length only within a class: pure length offered the label `[NinjaFirewall] Alert` ahead of
 * the bracketed tag, and a rule keyed on it silently leaves `[NinjaFirewall] Notice:` in the Ohbox.
 * A bracketed run is the sender's own deliberate tag; a label is an inference from punctuation. The
 * subject is sliced to {@link MAX_SUBJECT_SCAN} and nothing backtracks: a stranger wrote the string.
 */
export const MAX_SUBJECT_SCAN = 300;

export function subjectCandidates(subject: string): string[] {
  const line = stripReplyPrefixes(subject).slice(0, MAX_SUBJECT_SCAN);
  /** `0` = a bracketed tag the sender wrote, `1` = a label inferred from punctuation. */
  const out: Array<{ token: string; rank: 0 | 1 }> = [];

  // Bracketed runs, in order of appearance. The inner class excludes the openers so a nested or
  // unclosed bracket cannot make one token swallow the rest of the line.
  for (const m of line.matchAll(/\[([^[\]]{1,80})\]|\(([^()]{1,80})\)|\{([^{}]{1,80})\}/g)) {
    const token = m[0]!.trim();
    if (token.length >= MIN_SUBJECT_TOKEN_CHARS) out.push({ token, rank: 0 });
  }

  // The leading label, if the line opens with one.
  const sep = line.search(/[:–—|»-]/);
  if (sep > 0) {
    const label = line.slice(0, sep).trim();
    if (label.length >= MIN_SUBJECT_TOKEN_CHARS && label.length <= 80) {
      out.push({ token: label, rank: 1 });
    }
  }

  // Brackets before labels; longest first within a class. Duplicates collapsed case-insensitively,
  // keeping the sender's own capitalisation of the FIRST occurrence — the user reads the token off
  // their mail and must recognise it.
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.rank - b.rank || b.token.length - a.token.length)
    .filter(({ token }) => {
      const k = token.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(({ token }) => token);
}

/**
 * The repeating token this sender puts on this kind of message — or `null`. `focus` is the pressed
 * message's subject; `others` is every other subject the mirror holds from the sender. Three
 * refusals, each a bad rule avoided: (1) a candidate must appear in at least one OTHER subject — a
 * token that occurs once is this message's wording, and a rule keyed on it files exactly one message
 * for ever; it also makes the sheet's "this sender uses it on N messages" honest. (2) It must not
 * BE the whole subject — that rule is "this exact message". (3) The sender's own tag wins, from
 * {@link subjectCandidates}' ordering. Comparison is case-folded, matching the server
 * (`core/src/rules.ts#subjectSatisfies`); the returned token keeps its case — stored verbatim.
 */
export function detectSubjectToken(focus: string, others: readonly string[]): string | null {
  const stripped = stripReplyPrefixes(focus);
  const haystacks = others.map((s) => stripReplyPrefixes(s).toLowerCase());
  for (const token of subjectCandidates(focus)) {
    if (token.toLowerCase() === stripped.toLowerCase()) continue;   // refusal 2
    const needle = token.toLowerCase();
    if (haystacks.some((h) => h.includes(needle))) return token;    // refusal 1
  }
  return null;
}

/** How many of this sender's messages a term would match, by the SERVER's test. */
export function subjectMatchCount(messages: readonly EngineMessage[], term: string): number {
  const needle = term.trim().toLowerCase();
  if (needle === "") return 0;
  return messages.filter((m) => (m.subject ?? "").toLowerCase().includes(needle)).length;
}

/**
 * The text the mirror holds for a message — the full body where mirrored or hydrated, the snippet
 * otherwise, `""` for neither. One accessor because the content detection, the match count and the
 * audit panel all ask "what does the client know about this message's text" and must agree. The
 * answer is a floor, never the server's haystack: the server matches `body_contains` against the
 * full stored text, so a term visible in a snippet is genuinely a match while a term deeper in an
 * unhydrated body is a match the client cannot see — counts are stated as "here", and the audit
 * names a rule only when the conjunct verifiably holds.
 */
export function bodyTextOf(m: EngineMessage): string {
  return m.body ?? m.snippet ?? "";
}

/** How many of this sender's messages VISIBLY carry the term — a floor, see {@link bodyTextOf}. */
export function bodyMatchCount(messages: readonly EngineMessage[], term: string): number {
  const needle = term.trim().toLowerCase();
  if (needle === "") return 0;
  return messages.filter((m) => bodyTextOf(m).toLowerCase().includes(needle)).length;
}

/** How much of a body the content detection scans — the head, where machines put their tags. */
export const MAX_BODY_SCAN = 600;

/**
 * The repeating token in this kind of message's TEXT — or `null`. {@link detectSubjectToken}'s
 * contract against the body (mail 0052), for the sender whose subjects are all alike and whose
 * distinguishing text is in the body. `focusText`/`othersTexts` are what the mirror holds
 * ({@link bodyTextOf}), a floor of the real corpus: a found token is real, a missed one is `null`,
 * already a normal outcome. One candidate class — bracketed runs only: the leading-label heuristic
 * does not survive prose (a body's first colon is a greeting, not a label), and a wrong token that
 * moves mail retroactively is far worse than none. Same refusals as the subject detection; scanning
 * stops at {@link MAX_BODY_SCAN} — machine tags live in the head, and a stranger wrote the text.
 */
export function detectBodyToken(focusText: string, othersTexts: readonly string[]): string | null {
  const head = focusText.slice(0, MAX_BODY_SCAN);
  const stripped = head.trim();
  const haystacks = othersTexts.map((t) => t.slice(0, MAX_BODY_SCAN).toLowerCase());
  // Longest first — the subject detection's within-class tie-break, for its reason: the longer
  // bracketed run is the more specific tag. Duplicates collapse case-insensitively, keeping the
  // sender's own capitalisation of the first occurrence.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const m of head.matchAll(/\[([^[\]]{1,80})\]|\(([^()]{1,80})\)|\{([^{}]{1,80})\}/g)) {
    const token = m[0]!.trim();
    if (token.length < MIN_SUBJECT_TOKEN_CHARS) continue;
    const k = token.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(token);
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const token of candidates) {
    if (token.toLowerCase() === stripped.toLowerCase()) continue;   // the whole visible text
    const needle = token.toLowerCase();
    if (haystacks.some((h) => h.includes(needle))) return token;    // repeats, so it is a tag
  }
  return null;
}

/** Everything the sheet renders, read out of the mirror in one pass. */
export interface SubjectRuleContext {
  /** The message the title was pressed on. */
  messageId: string;
  subject: string;
  address: string;
  name: string | null;
  /** Where this message sits today, as a view id — so the sheet can mark the current pile. */
  current: ScreeningDest | null;
  /** Every message the mirror holds from this sender, newest first. */
  messages: EngineMessage[];
  /** The detected repeating token, or `null` when nothing repeats. */
  token: string | null;
  /**
   * The repeating token in this sender's message TEXT, or `null` — the content flavour of
   * `token` (mail 0052), detected over what the mirror holds ({@link detectBodyToken}). `null`
   * whenever bodies are not mirrored deeply enough to see a repeat, which the sheet treats
   * exactly as it treats a subject detection miss: a normal outcome, said out loud.
   */
  bodyToken: string | null;
  /**
   * The enabled rules that ALREADY carry a subject or body term for this address, so the sheet
   * can say "you already have one of these" instead of minting a second row nobody can tell from
   * the first.
   */
  existing: RuleDTO[];
}

const DEST_OF_FOLDER = new Map<string, ScreeningDest>([
  [FOLDER_OF_VIEW.ohbox, "ohbox"],
  [FOLDER_OF_VIEW.reads, "reads"],
  [FOLDER_OF_VIEW.receipts, "receipts"],
  [FOLDER_OF_VIEW.screened, "screened"],
  [FOLDER_OF_VIEW.spam, "spam"],
]);

const byDateDesc = (a: EngineMessage, b: EngineMessage) =>
  String(b.date ?? "").localeCompare(String(a.date ?? ""));

/**
 * Read the sheet's whole world out of the mirror, from ONE message id.
 *
 * One pass over the messages for the sender's set, exactly as `senderScreening` does and for the
 * same reason: this is called on every render of an open sheet, and two `.filter()` calls would walk
 * every message in the account twice per keystroke.
 */
export function subjectRuleContext(
  reader: EntityReader, messageId: string,
): SubjectRuleContext | null {
  const seed = reader.get<EngineMessage>("message", messageId);
  if (!seed) return null;
  const key = senderKey(seed.from.address);

  const mine: EngineMessage[] = [];
  for (const m of reader.list<EngineMessage>("message")) {
    if (senderKey(m.from.address) === key) mine.push(m);
  }
  mine.sort(byDateDesc);

  const address = seed.from.address.trim().toLowerCase();
  const rest = mine.filter((m) => m.id !== messageId);
  const others = rest.map((m) => m.subject ?? "");

  return {
    messageId,
    subject: seed.subject ?? "",
    address: seed.from.address,
    name: seed.from.name,
    current: DEST_OF_FOLDER.get(seed.folder) ?? null,
    messages: mine,
    token: detectSubjectToken(seed.subject ?? "", others),
    bodyToken: detectBodyToken(bodyTextOf(seed), rest.map(bodyTextOf)),
    // Exact address match AND a term present: those are the rows a second rule would be
    // indistinguishable from. A BARE sender rule is deliberately not here — it is the rule this
    // sheet exists to refine, not one it collides with. Either term counts (mail 0052): a body
    // rule is just as much "one of these" as a subject rule.
    existing: rulesList(reader).filter(
      (r) => r.enabled
        && r.kind === "sender"
        && r.match.trim().toLowerCase() === address
        && ((r.subjectContains ?? "").trim() !== "" || (r.bodyContains ?? "").trim() !== ""),
    ),
  };
}

/**
 * WHICH FIELD THE SECOND TERM READS — the subject line, or the message text (mail 0052). The
 * sheet's choice control decides it; everything downstream (the mutation's field, the match
 * count, the confirm sentence) derives from it so the four cannot disagree.
 */
export type TermField = "subject" | "body";

/** What the sheet is about to do, in the shape the confirm row reads from. */
export interface SubjectRulePlan {
  /** The wire, in dispatch order: the rule first, then the visible moves. */
  mutations: EngineMutation[];
  /** The rule mutation alone — the one the caller awaits before claiming anything. */
  ruleMutations: EngineMutation[];
  /** The two terms, as they will be stored. */
  match: string;
  term: string;
  /** Which field `term` reads. */
  field: TermField;
  destination: ScreeningDest;
  /**
   * How much of this sender's mail the rule NAMES. The number the confirm row shows.
   *
   * A statement about MATCHING MAIL, never a promise about what will move: the server pass
   * re-evaluates each message through `evaluateRules`, so a higher-priority deny rule keeps its mail
   * where it is, and a message the user has already acted on is not the pass's to move.
   */
  matched: number;
  /** Of those, how many are not already in the destination — what the pass has work to do on. */
  outOfPlace: number;
  /** Whether an identical rule (same address, same term, same destination) already exists. */
  already: boolean;
}

/**
 * The rule, and the moves for the mail the user can see. One `rule_create`; the moves are the
 * optimistic half only — `applyRetro` rides the mutation, so the server owns the backlog
 * (`RulesService` stamps `rules.retro_requested_at`, the worker's `ruleRetroPass` walks it in bounded
 * pages). Moves here are capped at {@link RETRO_VISIBLE_MOVES} (an uncapped fan-out is one
 * `POST /messages/:id/move` per message, each taking the account's write lock) and exist only so rows
 * on screen move now. Nothing is retargeted: an exactly identical rule is answered by writing nothing
 * and saying so; a different term is a different rule; same term with a different destination is left
 * as a second row on purpose — the rules surface is where a person resolves it with both texts shown.
 */
export function planSubjectRule(
  ctx: SubjectRuleContext,
  term: string,
  destination: ScreeningDest,
  field: TermField = "subject",
  applyRetro = RETRO_DEFAULT_ON,
): SubjectRulePlan {
  const wanted = FOLDER_OF_VIEW[destination];
  const match = ctx.address.trim().toLowerCase();
  const clean = term.trim();

  // "Identical" means identical in the SAME field: a subject rule and a body rule carrying the
  // same token are two different statements about two different slices of the sender's mail.
  const termOf = (r: RuleDTO): string =>
    ((field === "subject" ? r.subjectContains : r.bodyContains) ?? "").trim();
  // An EMPTY term is never `already`: a body-only rule's absent `subjectContains` normalizes to
  // "" too, so without this clause an emptied field compared equal to it, the confirm's go
  // stayed pressable, and the press closed the sheet claiming an existing rule.
  const already = clean !== "" && ctx.existing.some(
    (r) => termOf(r).toLowerCase() === clean.toLowerCase() && r.destination === wanted,
  );

  // For the body field this counts over what the mirror HOLDS (`bodyTextOf`), which is a floor
  // of the server's own count — see the accessor. The sheet's copy is written for that.
  const matching = ctx.messages.filter(
    (m) => clean !== "" && (field === "subject" ? (m.subject ?? "") : bodyTextOf(m))
      .toLowerCase().includes(clean.toLowerCase()),
  );
  const misplaced = matching.filter((m) => m.folder !== wanted);

  // A term the SERVER would refuse writes NOTHING — no rule and no moves. The moves exist only
  // as the optimistic half of a rule that is about to hold (or, on an `already` press, the
  // deliberate re-file of the visible mail the standing rule names); dispatching them beside a
  // 400 would re-file mail for a rule that was never written. `MAX_SUBJECT_TERM_CHARS` mirrors
  // the server's own cap (both term fields share the same 200).
  const invalid = clean === "" || clean.length > MAX_SUBJECT_TERM_CHARS;
  const ruleMutations: EngineMutation[] = already || invalid ? [] : [{
    kind: "rule_create",
    ruleKind: "sender",
    match,
    destination: wanted,
    ...(field === "subject" ? { subjectContains: clean } : { bodyContains: clean }),
    applyRetro,
  }];

  const mutations: EngineMutation[] = [...ruleMutations];
  // Newest first (the context is sorted), so the slice is the mail the user is looking at.
  // An `already` press keeps its moves — "File these to …" files the visible matching mail the
  // standing rule names; only an INVALID term moves nothing, because there is no rule behind it.
  if (!invalid) {
    for (const m of misplaced.slice(0, RETRO_VISIBLE_MOVES)) {
      mutations.push({ kind: "move", messageId: m.id, folder: wanted });
    }
  }

  return {
    mutations,
    ruleMutations,
    match,
    term: clean,
    field,
    destination,
    matched: matching.length,
    outOfPlace: misplaced.length,
    already,
  };
}

/**
 * WHICH SENTENCE THE SHELL MAY SAY, GIVEN WHAT THE SERVER ANSWERED.
 *
 * The same three-outcome discipline `screeningToast` documents, for the same reason: this claims
 * something about FUTURE mail, which is exactly the kind of claim a refusal falsifies, and the
 * fixtures adapter never refuses — so a toast fired on click would be green in every test and wrong
 * on a live account. `queued` is not folded into success: the overlay stands, so the rule is
 * correctly on screen, but the server has not been told.
 */
export type SubjectRuleToastKey =
  | "subjectRuled" | "subjectRuleQueued" | "subjectRuleFailed" | "subjectAlready";

export function subjectRuleToast(
  plan: SubjectRulePlan, status: "confirmed" | "queued" | "rolled_back" | null,
): SubjectRuleToastKey {
  if (plan.already || plan.ruleMutations.length === 0) return "subjectAlready";
  if (status === "rolled_back") return "subjectRuleFailed";
  if (status === "queued") return "subjectRuleQueued";
  return "subjectRuled";
}

/** The five piles a subject rule may file into — the DecisionBar's own vocabulary, unchanged. */
export const SUBJECT_RULE_DESTS: DecisionDestination[] =
  ["ohbox", "reads", "receipts", "screened", "spam"];
