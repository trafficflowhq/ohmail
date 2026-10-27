/**
 * THE LETTERS A HARD STOP LEFT, SETTLED AT THE NEXT LAUNCH — and the letters a flush or a sync
 * settles while the app runs. A restored letter becomes a draft; it is never reopened and never
 * sent. A letter marked as sent is left to the outbox when the outbox still holds its send (which
 * goes once), bound to the row the server holds it in, dropped when its sent copy is there, and
 * otherwise kept as a draft with the caution to check Sent first. One sentence per launch.
 */
import { refuse, type Refusal } from "../refusal";
import type { KeptRow } from "./letter-keeper";
import { keptFit, rowHoldsLetter, wordsOf, type Letter, type LetterAddress, type LetterDoor, type LetterMark } from "./letter-store";

/** A queued or in-flight mutation, as the engine holds it. */
export interface OutboxRow { key: string; mutation: { kind: string } & Record<string, unknown> }

/** A draft row the mirror holds. */
export interface MirrorDraft {
  id: string; status?: unknown; subject?: unknown; body?: unknown; to?: unknown; cc?: unknown; bcc?: unknown;
  inReplyToMessageId?: unknown; forwardOfMessageId?: unknown; updatedAt?: unknown; contentRevision?: unknown;
}

/** What a restore hands the draft keep (`LiveWorldActions.draftKeep`). */
export interface LetterKeep {
  mode: Letter["mode"];
  messageId: string | null;
  mailboxId: string | null;
  to: LetterAddress[];
  cc?: LetterAddress[];
  bcc?: LetterAddress[];
  subject: string;
  body: string;
  files: number;
  draftId: string | null;
  /** The version of `draftId` the words are based on: a row changed elsewhere since is never written over. */
  revision?: string | null;
  quiet: true;
  /** The row had changed elsewhere, so the words went to a new draft. */
  forked?: () => void;
  /** A forward's kept files (`Letter.forwardKept`). */
  forwardParts?: readonly string[];
  row: (r: KeptRow) => void;
}

export interface RestoreDeps {
  door: LetterDoor;
  owned: ReadonlySet<string>;
  outbox: () => readonly OutboxRow[];
  keep: (k: LetterKeep) => Promise<"kept" | "refused" | "tooLong">;
  hasMessage: (id: string) => boolean;
  drafts: () => readonly MirrorDraft[];
  /** The first completed sync of this launch. */
  firstSync: () => Promise<void>;
  /** The next reconnect flush's end: a letter whose row a save of this phone's is still on its way to waits for it. */
  afterFlush?: () => Promise<void>;
  /** Only these letters, by id: the ones a flush let go of ({@link settleLetters}). */
  only?: ReadonlySet<string>;
  /** The typed recipients that parse. */
  parse: (typed: string) => LetterAddress[];
  now?: () => Date;
}

export interface LetterRestore {
  /** Letters made or updated as drafts. */
  kept: number;
  /** Letters whose send never answered, with no send left and no sent copy: drafts with the caution. */
  unclear: number;
  /** The same for a send that answered but was never settled. */
  unconfirmed: number;
  /** Letters whose row another device had changed since: kept as new drafts beside it. */
  changed: number;
  /** Files past what this phone keeps with drafts, by name. */
  notKept: string[];
}

/** How far this phone's clock may stand from the server's when a row's time is read against a mark. */
const CLOCK_SLACK_MS = 10 * 60 * 1000;

const subjectOf = (l: Letter): string => l.envelope?.subject ?? l.subject.trim();

/** The body a press of this letter carried: its words, or its words with the mark's signature sealed on. */
const sameBody = (l: Letter, mark: LetterMark, body: unknown): boolean => {
  if (typeof body !== "string") return false;
  const text = l.body.trim();
  return body.trim() === text || (typeof mark.sig === "string" && body.trim() === `${text}\n\n${mark.sig}`.trim());
};

const addressesOf = (v: unknown): string | null => (Array.isArray(v)
  ? JSON.stringify(v.map((a) => String((a as { address?: unknown } | null)?.address ?? "").trim().toLowerCase()).sort())
  : v === undefined || v === null ? "[]" : null);

/** Who the letter goes to, as a row of it holds them; `null` when a reply's envelope was never known. */
function recipientsOf(l: Letter, parse: (typed: string) => LetterAddress[]): [LetterAddress[], LetterAddress[], LetterAddress[]] | null {
  if (l.mode === "new") return [parse(l.to), parse(l.cc), parse(l.bcc)];
  if (l.mode === "forward") return [parse(l.to), [], []];
  return l.envelope ? [l.envelope.to, l.envelope.cc, []] : null;
}

const sameRecipients = (l: Letter, parse: (typed: string) => LetterAddress[], to: unknown, cc: unknown, bcc: unknown): boolean => {
  const want = recipientsOf(l, parse);
  return want !== null && [to, cc, bcc].every((v, i) => addressesOf(v) === addressesOf(want[i]));
};

/** A mirror row holding this letter, written after its mark: the same parent, recipients, subject and body. */
function sameRow(l: Letter, mark: LetterMark, r: MirrorDraft, parse: (typed: string) => LetterAddress[]): boolean {
  const at = typeof r.updatedAt === "string" ? Date.parse(r.updatedAt) : NaN;
  if (!(at >= Date.parse(mark.at) - CLOCK_SLACK_MS)) return false;
  const parent = r.inReplyToMessageId ?? r.forwardOfMessageId ?? null;
  if (parent !== (l.mode === "new" ? null : l.messageId)) return false;
  return typeof r.subject === "string" && r.subject.trim() === subjectOf(l)
    && sameRecipients(l, parse, r.to, r.cc, r.bcc) && sameBody(l, mark, r.body);
}

/** The outbox row this letter's mark names: its key, else its intent, else its words. */
function heldBy(l: Letter, mark: "keep" | "send", rows: readonly OutboxRow[], parse: (typed: string) => LetterAddress[]): OutboxRow | undefined {
  const marked = l[mark]!;
  if (marked.key !== null) return rows.find((r) => r.key === marked.key);
  const kind = mark === "send" ? "mail_send" : "draft_save";
  return rows.find((r) => {
    const m = r.mutation;
    if (m.kind !== kind) return false;
    if (l.draftId !== null && m.draftId === l.draftId) return true;
    const parent = (mark === "send"
      ? (l.mode === "forward" ? m.forwardOf : m.inReplyTo)
      : (l.mode === "forward" ? m.forwardOfMessageId : m.inReplyToMessageId)) ?? null;
    if (parent !== (l.mode === "new" ? null : l.messageId)) return false;
    // A reply's envelope may be left to the engine: its parent names it.
    const stated = l.mode === "new" || m.to !== undefined;
    return sameBody(l, marked, m.body)
      && (l.mode !== "new" || (typeof m.subject === "string" && m.subject.trim() === subjectOf(l)))
      && (!stated || sameRecipients(l, parse, m.to, m.cc, m.bcc));
  });
}

export async function restoreLetters(d: RestoreDeps): Promise<LetterRestore> {
  const out: LetterRestore = { kept: 0, unclear: 0, unconfirmed: 0, changed: 0, notKept: [] };
  const now = d.now ?? (() => new Date());
  let synced: Promise<void> | null = null;
  const afterSync = (): Promise<void> => (synced ??= d.firstSync().catch(() => undefined));
  const put = (l: Letter): void => d.door.put({ ...l, updatedAt: now().toISOString() });
  const bind = (l: Letter, draftId: string, revision?: string | null): void => {
    const next = { ...l, draftId, savedAs: wordsOf(l), revision: revision ?? (draftId === l.draftId ? l.revision ?? null : null), keep: null, send: null };
    if (rowHoldsLetter(next)) d.door.drop(l.id);
    else put(next);
  };
  /** The row holds the words this phone last saved or queued to it. */
  const holdsSaved = (l: Letter, r: MirrorDraft): boolean => {
    if (l.savedAs === null) return false;
    const [to, subject, body, cc, bcc] = JSON.parse(l.savedAs) as string[];
    const saved = { ...l, to: to ?? "", subject: subject ?? "", body: body ?? "", cc: cc ?? "", bcc: bcc ?? "" };
    return typeof r.subject === "string" && r.subject.trim() === subjectOf(saved)
      && typeof r.body === "string" && r.body.trim() === saved.body.trim() && sameRecipients(saved, d.parse, r.to, r.cc, r.bcc);
  };
  /** A save of the letter's row this phone queued or sent unanswered: its answer moves the version the letter states. */
  const waits = (l: Letter): boolean => d.afterFlush !== undefined && l.draftId !== null && !!l.revision
    && d.outbox().some((r) => r.mutation.kind === "draft_save" && r.mutation.draftId === l.draftId);
  /** Make or update the letter's row, quietly; the files that do not fit are named. */
  const keep = async (l: Letter): Promise<boolean> => {
    const { fit, over } = keptFit(l.files, d.door.keptBytes(l.id));
    for (const f of over) { d.door.dropFile(f.fileId); out.notKept.push(f.filename); }
    const letter = over.length > 0 ? { ...l, files: fit } : l;
    if (over.length > 0) put(letter);
    let revision = letter.draftId !== null ? letter.revision ?? null : null;
    if (revision) {
      // This phone's own landed save moved the version without the letter being told.
      await afterSync();
      const r = d.drafts().find((x) => x.id === letter.draftId);
      if (r !== undefined && typeof r.contentRevision === "string" && r.contentRevision !== "" && holdsSaved(letter, r)) revision = r.contentRevision;
    }
    const parentHere = letter.messageId !== null && d.hasMessage(letter.messageId);
    const asNew = letter.mode !== "new" && !parentHere;
    let row: KeptRow | null = null;
    const typedTo = d.parse(letter.to);
    const answer = await d.keep({
      mode: asNew ? "new" : letter.mode,
      messageId: asNew ? null : letter.messageId,
      mailboxId: letter.mailboxId,
      to: asNew && letter.mode !== "forward" ? letter.envelope?.to ?? typedTo : typedTo,
      ...(letter.mode === "new" ? { cc: d.parse(letter.cc), bcc: d.parse(letter.bcc) }
        : asNew && letter.envelope ? { cc: letter.envelope.cc } : {}),
      subject: asNew ? subjectOf(letter) : letter.subject,
      body: letter.body,
      files: letter.files.length,
      draftId: letter.draftId,
      ...(revision ? { revision } : {}),
      quiet: true,
      forked: () => { out.changed += 1; },
      // A forward's kept files ride its row.
      ...(!asNew && letter.mode === "forward" && letter.forwardKept ? { forwardParts: letter.forwardKept } : {}),
      row: (r) => { row = r; },
    });
    if (answer !== "kept" || row === null) return false;
    const kept = row as KeptRow;
    if (kept.draftId !== null) bind(letter, kept.draftId, kept.revision);
    else put({ ...letter, keep: { at: now().toISOString(), key: kept.key } });
    return true;
  };

  let later: string[] = [];
  const restore = async (l: Letter): Promise<void> => {
    if (d.owned.has(l.id) || (d.only !== undefined && !d.only.has(l.id))) return;
    if (l.send !== null) {
      const send = l.send;
      const row = heldBy(l, "send", d.outbox(), d.parse);
      if (row !== undefined) {
        // The outbox sends it once; its flush settles this letter by key.
        if (send.key !== row.key) put({ ...l, send: { ...send, key: row.key } });
        return;
      }
      await afterSync();
      const mine = (r: MirrorDraft): boolean => (l.draftId !== null && r.id === l.draftId) || sameRow(l, send, r, d.parse);
      const rows = d.drafts();
      if (rows.some((r) => r.status === "sent" && mine(r))) {
        d.door.drop(l.id);
        return;
      }
      // The server holds the send in its row: that row is the letter, as the Drafts card shows it.
      const held = rows.find((r) => (r.status === "unverified" || r.status === "sending") && mine(r));
      if (held !== undefined) { bind(l, held.id); return; }
      if (waits(l)) { later.push(l.id); return; }
      if (await keep({ ...l, send: null })) {
        if (send.key === null) out.unclear += 1;
        else out.unconfirmed += 1;
      }
      return;
    }
    if (l.keep !== null) {
      const marked = l.keep;
      const row = heldBy(l, "keep", d.outbox(), d.parse);
      if (row !== undefined) {
        if (marked.key !== row.key) put({ ...l, keep: { ...marked, key: row.key } });
        return;
      }
      await afterSync();
      const twin = d.drafts().find((r) => r.status !== "sent" && sameRow(l, marked, r, d.parse));
      if (twin !== undefined) { bind(l, twin.id); return; }
      if (await keep({ ...l, keep: null })) out.kept += 1;
      return;
    }
    const worth = l.draftId !== null || l.body.trim() !== "" || (l.mode === "new" && l.subject.trim() !== "") || l.files.length > 0;
    if (!worth) { d.door.drop(l.id); return; }
    if (l.draftId !== null && l.savedAs === wordsOf(l)) return;
    if (waits(l)) { later.push(l.id); return; }
    if (await keep(l)) out.kept += 1;
  };
  for (const l of d.door.letters()) await restore(l);
  while (later.length > 0 && d.afterFlush) {
    await d.afterFlush();
    const again = new Set(later);
    later = [];
    for (const l of d.door.letters()) if (again.has(l.id)) await restore(l);
  }
  return out;
}

/** One sentence for a launch's restore, or none. */
export function sayLetterRestore(r: LetterRestore): Refusal | null {
  if (r.unclear > 0) return refuse("letterSendUnclear", r.unclear);
  if (r.unconfirmed > 0) return refuse("letterSendUnconfirmed", r.unconfirmed);
  if (r.kept === 0) return null;
  if (r.notKept.length > 0) return refuse("lettersKeptWithout", r.kept, r.notKept.join(", "));
  return r.changed > 0 ? refuse("lettersKeptChangedElsewhere", r.changed) : refuse("lettersKept", r.kept);
}

/** A flushed outcome, as `flushQueued` reports it. */
export interface LetterOutcome { status: string; kind: string; draftId?: string; createdDraftId?: string; changed?: boolean }

/**
 * THE FLUSH SETTLES THE LETTERS WAITING ON ITS KEYS: a queued keep binds to the row it made, a
 * confirmed send drops its letter and files, a refused or unverified send leaves them with its row.
 * A send refused over a row changed elsewhere lets go of that row, which holds the other version:
 * the letters let go of are returned, by the send's key, to be kept as new drafts.
 */
export function settleLetters(
  door: LetterDoor, owned: ReadonlySet<string>, settled: Iterable<[string, LetterOutcome]>, now: () => Date = () => new Date(),
): { key: string; letter: string }[] {
  const loose: { key: string; letter: string }[] = [];
  // An open composer settles its own letter.
  const letters = door.letters().filter((l) => !owned.has(l.id));
  for (const [key, o] of settled) {
    for (const l of letters) {
      if (l.keep?.key === key && o.kind === "draft_save") {
        if (o.status === "confirmed" && o.createdDraftId) {
          const next = { ...l, draftId: o.createdDraftId, savedAs: wordsOf(l), keep: null };
          if (rowHoldsLetter(next)) door.drop(l.id);
          else door.put({ ...next, updatedAt: now().toISOString() });
        } else if (o.status === "rolled_back") door.put({ ...l, keep: null, updatedAt: now().toISOString() });
      }
      if (l.send?.key === key && o.kind === "mail_send") {
        if (o.status === "confirmed") door.drop(l.id);
        // Unverified: the row the server holds it in keeps the files; without one the next launch looks.
        else if (o.status === "unverified" && o.draftId) {
          const next = { ...l, draftId: o.draftId, savedAs: wordsOf(l), send: null };
          if (rowHoldsLetter(next)) door.drop(l.id);
          else door.put({ ...next, updatedAt: now().toISOString() });
        }
        else if (o.status === "rolled_back" && o.changed === true) {
          door.put({ ...l, draftId: null, savedAs: null, send: null, updatedAt: now().toISOString() });
          loose.push({ key, letter: l.id });
        }
        else if (o.status === "rolled_back") {
          const next = o.draftId ? { ...l, draftId: o.draftId, savedAs: wordsOf(l), send: null } : { ...l, send: null };
          door.put({ ...next, updatedAt: now().toISOString() });
        }
      }
    }
  }
  return loose;
}

/** A kept draft sent or deleted on another device takes its files with it. */
export function sweepLetters(door: LetterDoor, owned: ReadonlySet<string>, left: (draftId: string) => "sent" | "deleted" | null): void {
  for (const l of door.letters()) {
    if (owned.has(l.id) || l.draftId === null || l.send !== null || l.keep !== null) continue;
    if (left(l.draftId) !== null) door.drop(l.id);
  }
}

/** A withdrawn send's letter follows its words (a row, a queued keep, or the discard), so no launch keeps it again. */
export function settleWithdrawn(
  door: LetterDoor, owned: ReadonlySet<string>, key: string,
  into: string | { keep: string } | "discarded", now: () => Date = () => new Date(),
): void {
  for (const l of door.letters()) {
    if (owned.has(l.id) || l.send?.key !== key) continue;
    const at = now().toISOString();
    if (into === "discarded") door.drop(l.id);
    else if (typeof into !== "string") door.put({ ...l, send: null, keep: { at, key: into.keep }, updatedAt: at });
    else {
      const next = { ...l, draftId: into, savedAs: wordsOf(l), send: null };
      if (rowHoldsLetter(next)) door.drop(l.id);
      else door.put({ ...next, updatedAt: at });
    }
  }
}
