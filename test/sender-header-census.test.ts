import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * ═══ EVERY READ OF A SENDER-WRITTEN HEADER, CLASSIFIED ═══════════════════════════════════════
 *
 * Identity is `(account, mailbox, uidvalidity, uid)` or the content fingerprint. A header the
 * SENDER writes — Message-ID, In-Reply-To, References, To, Cc — may GROUP or RANK only when
 * something the sender does not control corroborates it (`packages/core/src/sender-headers.ts`).
 * Three shipped defects were one root: the Ohbox collapsed distinct messages on a shared
 * Message-ID, the thread-join heal took a stranger's `Cc` as evidence of a shared correspondent,
 * and the address book ranked by a count any sender can produce. Fixing them one at a time leaves
 * the fourth site nobody looked at, so this census is the list.
 *
 * A file that reads one of these names and is not in {@link CLASSIFIED} fails. The classes are
 * per FILE and a file may carry several; every one of them has to be named.
 */

const ROOT = join(import.meta.dirname, "..");

/** The roots that decide anything with these values. The webapp reads the DTO, it does not key on it. */
const SCANNED_ROOTS = [
  "packages/core/src",
  "packages/services/src",
  "apps/worker/src",
  "packages/client-engine/src",
];

/**
 * FILES OUTSIDE THE SCANNED ROOTS THAT ARE SCANNED ANYWAY, each because a read MOVED there.
 *
 * `packages/db/src` is not a root: its schema modules declare every one of these names as a
 * COLUMN, so scanning it whole would classify the declarations rather than the decisions. But a
 * shared SQL predicate that lives there and READS one of them is exactly what this census is for
 * — `ohbox-tidy` and `rule-retro` each carried the own-sent engagement read until it collapsed
 * into one fragment, and without this list the read would have left the census by moving house.
 */
const EXTRA_SCANNED = [
  "packages/db/src/auto-reply-by-us.ts",
  // The contact-only held set, which the gate release's own-sent engagement read moved into.
  "packages/db/src/contact-only-held.ts",
  "packages/db/src/we-answered.ts",
];

/**
 * The names, as the code spells them: the stored column and DTO field names, the client's own
 * normaliser, and the two raw header keys as STRING literals — which is what keeps `.references(…)`
 * (drizzle's foreign key) and the English word in a docblock out of the count.
 *
 * `threadId` is deliberately NOT here. It is the header chain's own proxy and reading it would
 * pull in every projection that merely carries a thread id; the two sites that ACT on a thread
 * are pinned by {@link MUST_CONSULT} instead.
 */
const TERMS = new Set([
  "messageIdHeader",
  "messageIdKey",
  "inReplyTo",
  "toAddresses",
  "ccAddresses",
  "references",
  "in-reply-to",
  "message-id",
]);

/**
 * `display`            carried, projected, logged or stored; decides nothing.
 * `dedup-content`      feeds the content fingerprint, or an identity comparison that requires the
 *                      CONTENT to agree before two rows may be treated as one.
 * `threading-corroborated`  groups or ranks, and the grouping is corroborated by something the
 *                      sender does not control — our own sent record, or the server's locator.
 * `thread-key-at-ingest`  the header chain forms the thread KEY at ingest, account-scoped and
 *                      corroborated by nothing else. That is the shipped design (`threading.ts`'s
 *                      module header) and it is why the two sites that ACT on a thread — the join
 *                      heal and the consent cutline — require corroboration of their own. Its
 *                      membership is CLOSED: a new reader of the ingest key has to be argued for
 *                      here rather than self-classified into it.
 * `refused`            reads the value in order NOT to treat it as identity.
 */
const CLASSES = new Set([
  "display",
  "dedup-content",
  "threading-corroborated",
  "thread-key-at-ingest",
  "refused",
  // Looked for among the messages the server holds, where a match only KEEPS a row: removal also
  // needs the server's own locator gone, which no sender controls, so a forged id keeps a letter
  // and never takes one.
  "presence-keeps",
]);

interface Row {
  /** Every term this file reads, sorted. A new term in a classified file fails too. */
  terms: string[];
  classes: string[];
  why: string;
}

const CLASSIFIED: Record<string, Row> = {
  // ── the rule itself, and the identity it defends ────────────────────────────────────────
  "packages/core/src/sender-headers.ts": {
    terms: ["messageIdHeader"], classes: ["refused"],
    why: "the rule: a Message-ID may key a grouping only on our own outbound copies",
  },
  "packages/core/src/identity.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content"],
    why: "the fingerprint hashes the id as ONE length-prefixed field beside from/to/cc/subject/body",
  },
  "packages/core/src/pipeline.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content", "thread-key-at-ingest"],
    why: "the dual-key lookup verifies stored CONTENT before collapsing; the own-authored twin arm is gated on `Change.ownAuthored` and adopts only a row with a Sent instance; a copy dated apart joins only when every other fingerprinted field agrees and the arrival or the row is from Sent; the same value goes to `resolveThread`; a delivery report is lifted only by `citesOwnWriting`",
  },
  "packages/core/src/message-search.ts": {
    terms: ["ccAddresses", "toAddresses"], classes: ["display"],
    why: "the recipients as WORDS in the message's search document (mail 0125) — found by, never keyed on",
  },
  "packages/core/src/ports.ts": {
    terms: ["messageIdHeader", "references"], classes: ["display", "dedup-content", "threading-corroborated"],
    why: "`StoredMessage`'s field, the `findByMessageIdHeader` port step 3 calls (candidates only: a row with a Sent instance, or one whose content agrees but for the Date), and `isCorrespondent`'s references — answered only against a copy in our own Sent folder, `named` when its To/Cc names that sender",
  },
  "packages/core/src/types.ts": {
    terms: ["messageIdHeader"], classes: ["display"],
    why: "`CanonicalId`'s field declaration",
  },
  "packages/core/src/mime-parse.ts": {
    terms: ["in-reply-to", "message-id", "references"], classes: ["display"],
    why: "the parse door copies the parser's header values onto the parsed mail, as `simpleParser` does; it decides nothing",
  },
  "packages/core/src/husk-restore.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content"],
    why: "a husk may only be rewritten by bytes whose id AND body match what was stored",
  },
  "packages/core/src/threading.ts": {
    terms: ["in-reply-to", "inReplyTo", "messageIdHeader", "references"],
    classes: ["thread-key-at-ingest", "threading-corroborated", "refused"],
    why: "`threadKeyOf` reads the chain (and drops the message's own id and over-long tokens); `conversationJoinVerdict` admits only corroborated counterparties",
  },
  "packages/core/src/rules.ts": {
    terms: ["in-reply-to", "messageIdHeader", "references"], classes: ["threading-corroborated"],
    why: "`dsnVerdict` collects candidate ids for a bounce; the caller matches them against the account's own post-consent Sent copies only (`citesOwnWriting`), and the report's own id is dropped",
  },
  "packages/core/src/adapters/imap.ts": {
    terms: ["inReplyTo", "message-id", "messageIdHeader", "messageIdKey", "references"], classes: ["display", "presence-keeps"],
    why: "the adapter reads the headers off the wire and hands them on parsed; a UIDVALIDITY reset proves a remembered letter gone only when its old locator is gone AND no held message carries its id",
  },
  "packages/core/src/adapters/imap-types.ts": {
    terms: ["inReplyTo", "references"], classes: ["display"],
    why: "the envelope shape the adapter fills",
  },
  "packages/core/src/adapters/drizzle-repo.ts": {
    terms: ["ccAddresses", "messageIdHeader", "references", "toAddresses"],
    classes: ["display", "dedup-content", "threading-corroborated"],
    why: "the store: writes the columns, serves `findByMessageIdHeader` account- and mailbox-scoped with each row's Date and Sent instance, and hands `isCorrespondent`'s and `citesOwnWriting`'s ids to the one predicate",
  },
  "packages/core/src/adapters/blank-rows.ts": {
    terms: ["messageIdHeader", "toAddresses"], classes: ["dedup-content"],
    why: "the blank repair's store read: a row whose dedup key is an EMPTY source's and whose id and recipients are absent; no header value is compared, and the bytes on the server decide every action",
  },
  // ── the correspondent predicate (FIX-023) and the passes that ask it ────────────────────
  "packages/core/src/correspondent.ts": {
    terms: ["ccAddresses", "in-reply-to", "inReplyTo", "messageIdHeader", "references", "toAddresses"],
    classes: ["threading-corroborated"],
    why: "a sender is a correspondent only against a copy in the mailbox's own Sent folder — the server's locator: its To/Cc (our writing), or its id named by their references, for that message, and taught only when its To/Cc names them; never their From",
  },
  "apps/worker/src/screener-auto-act.ts": {
    terms: ["references"], classes: ["threading-corroborated"],
    why: "asks the correspondent predicate over the held mail's references before filing anybody",
  },
  "apps/worker/src/screener-auto-suggest.ts": {
    terms: ["references"], classes: ["threading-corroborated"],
    why: "asks the correspondent predicate over the held mail's references before buying advice",
  },
  "apps/worker/src/screener-correspondent-retro.ts": {
    terms: ["references"], classes: ["threading-corroborated"],
    why: "the retro releases a held sender only on the correspondent predicate's answer, and for an answer the cited copy does not name only the messages that themselves cite it",
  },
  "packages/services/src/screener-service.ts": {
    terms: ["references"], classes: ["threading-corroborated"],
    why: "the pressed suggestion's correspondent signal, from the one predicate",
  },

  // ── the server's projections and passes ────────────────────────────────────────────────
  "packages/services/src/dto/types.ts": {
    terms: ["messageIdHeader"], classes: ["display"],
    why: "`MessageDTO`'s field declaration",
  },
  "packages/services/src/dto/materialize.ts": {
    terms: ["ccAddresses", "messageIdHeader", "toAddresses"], classes: ["display"],
    why: "the projection copies the columns onto the DTO",
  },
  "packages/services/src/send-service.ts": {
    terms: ["inReplyTo", "messageIdHeader", "references"], classes: ["display"],
    why: "a reply's outgoing chain is written from the parent WE hold, and the minted id is recorded",
  },
  "packages/services/src/away-responder-pass.ts": {
    terms: ["inReplyTo", "messageIdHeader", "references"], classes: ["display"],
    why: "the reply's own outgoing headers, plus RFC 3834 loop markers read off the incoming message",
  },
  "packages/services/src/sensitive-rescreen.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content"],
    why: "re-screening re-reads the message and verifies the stored id and body before rewriting",
  },
  "packages/core/src/unscreened-set.ts": {
    terms: ["messageIdHeader"], classes: ["threading-corroborated"],
    why: "the same own-sent engagement read as `ohbox-tidy.ts`: `autoReplyByUsWhere` reads the id of OUR OWN sent row to tell a person's reply from the responder's; "
      + "and the letter's own id for the gate's reply arm (`pipeline.ts#correspondentAtGate`), which `threadKeyOf` leaves out of what it asks",
  },

  // ── the worker ────────────────────────────────────────────────────────────────────────
  "apps/worker/src/gap-catchup.ts": {
    terms: ["messageIdHeader"], classes: ["threading-corroborated"],
    why: "the gap's stranger class asks `gateHoldsSender` with the letter's own id for the gate's reply arm "
      + "(`pipeline.ts#correspondentAtGate`), so an answer to the person's own writing is never screened",
  },
  "apps/worker/src/thread-join-heal.ts": {
    terms: ["ccAddresses", "toAddresses"], classes: ["threading-corroborated"],
    why: "`counterpartyEvidence` says WHO put each address on the thread; a To/Cc a sender wrote is not evidence",
  },
  "apps/worker/src/known-set.ts": {
    terms: ["messageIdHeader"], classes: ["display"],
    why: "the known-set memo carries the column `listKnownLocators` projects, so what it holds equals a fresh read — the value is copied, never compared, keyed on or ranked by",
  },
  "apps/worker/src/thread-backfill.ts": {
    terms: ["messageIdHeader"], classes: ["thread-key-at-ingest"],
    why: "threads rows the ingest left unthreaded, through the same `resolveThread`",
  },
  "apps/worker/src/away-reply-flag-redeliver.ts": {
    terms: ["messageIdHeader"], classes: ["display"],
    why: "selects the column into the away-reply projection",
  },
  "apps/worker/src/junk-restore.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content"],
    why: "a junk husk is restored only by bytes whose id and dedup key match the stored husk",
  },
  "apps/worker/src/redacted-restore.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content"],
    why: "the stored id is compared with the re-read message's before a body is rewritten",
  },
  "apps/worker/src/storage-refill.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content"],
    why: "a letter emptied for space gets its text back only from bytes whose id and dedup key match the stored row",
  },
  "apps/worker/src/sensitive-backfill.ts": {
    terms: ["messageIdHeader"], classes: ["dedup-content"],
    why: "same verification before a backfilled row's body is rewritten",
  },
  "packages/db/src/contact-only-held.ts": {
    terms: ["messageIdHeader"], classes: ["threading-corroborated"],
    why: "the same own-sent engagement read — the contact-only held set the gate release and the held-release offer share carries the retro pass's own exclusion",
  },
  // `ohbox-tidy.ts` and `rule-retro.ts` had a row each for the own-sent engagement read. Both
  // copies collapsed into `packages/db/src/we-answered.ts`, classified below.
  "apps/worker/src/rule-pass.ts": {
    terms: ["messageIdHeader"], classes: ["threading-corroborated"],
    why: "the same own-sent engagement read, in the projection the three passes now share — it "
      + "moved here from `screener-auto.ts` with the rest of the shared row shape",
  },
  "apps/worker/src/sender-name-backfill.ts": {
    terms: ["ccAddresses", "toAddresses"], classes: ["display"],
    why: "fills the recipient columns on rows ingested before they were written",
  },
  "apps/worker/src/run-sender-name-backfill.ts": {
    terms: ["ccAddresses", "toAddresses"], classes: ["display"],
    why: "prints that pass's counters",
  },

  // ── the client engine ─────────────────────────────────────────────────────────────────
  "packages/client-engine/src/selectors.ts": {
    terms: ["messageIdHeader", "messageIdKey"], classes: ["threading-corroborated"],
    why: "`twinKeyOf` asks `mayGroupByMessageId`, so only our own outbound copies collapse",
  },
  "packages/client-engine/src/mutations.ts": {
    terms: ["inReplyTo", "messageIdHeader", "messageIdKey"], classes: ["display"],
    why: "the optimistic Sent overlay carries the id the send answered with, and the reply names its parent",
  },
  "packages/client-engine/src/engine.ts": {
    terms: ["inReplyTo", "messageIdHeader", "messageIdKey"], classes: ["threading-corroborated"],
    why: "the reconcile retires the engine's OWN optimistic copy when the row it minted arrives",
  },
  "packages/client-engine/src/types.ts": {
    terms: ["inReplyTo", "messageIdHeader"], classes: ["display"],
    why: "the mirror's row and draft shapes",
  },
  "packages/client-engine/src/send-fingerprint.ts": {
    terms: ["inReplyTo"], classes: ["dedup-content"],
    why: "a press's parent id is one field of the send fingerprint, which tells two presses' CONTENT apart and keys nothing",
  },
  "packages/client-engine/src/adapters/http-adapter.ts": {
    terms: ["inReplyTo"], classes: ["display"],
    why: "a draft's parent id crosses the wire as written",
  },
  "packages/client-engine/src/adapters/fixtures-adapter.ts": {
    terms: ["messageIdHeader"], classes: ["display"],
    why: "the demo world mints rows with no id",
  },
};

/**
 * THE SITES THAT MUST CONSULT THE RULE.
 *
 * The three client decision sites read the same headers under the DTO's own names — `to`, `cc`,
 * `threadId` — which are far too common to census by name, so they are pinned here instead: each
 * one imports `sender-headers`, and deleting that import fails this file rather than quietly
 * restoring a count or a header chain as the whole answer.
 */
/** The two shared SQL predicates that live in `packages/db/src` — see {@link EXTRA_SCANNED}. */
const CLASSIFIED_DB: Record<string, { terms: string[]; classes: string[]; why: string }> = {
  "packages/db/src/auto-reply-by-us.ts": {
    terms: ["messageIdHeader"], classes: ["threading-corroborated"],
    why: "correlates OUR OWN sent row's id against the away ledger's minted id — our writing about our own act, never a stranger's header",
  },
  "packages/db/src/we-answered.ts": {
    terms: ["in-reply-to", "messageIdHeader", "references"], classes: ["threading-corroborated"],
    why: "did the person answer THIS sender: the reference headers of OUR OWN outbound against the id of a message this sender wrote — corroborated on both ends by rows the sender did not write",
  },
};

const MUST_CONSULT = [
  "packages/core/src/threading.ts",
  "apps/worker/src/thread-join-heal.ts",
  "packages/client-engine/src/selectors.ts",
  "packages/client-engine/src/address-book.ts",
  "packages/client-engine/src/consent-cutline.ts",
];

/**
 * The rule's exported names. Consulting it means CALLING one of these, and the call has to be
 * somewhere other than the import: the first spelling of this check accepted a mention anywhere
 * in the file, and a mutation that replaced the call with an empty Map — leaving the import — kept
 * it green. Names rather than the module path, because the worker reaches them through
 * `@trafficflow/core/mail`, which re-exports the leaf, and the client imports the leaf directly.
 */
const RULE_NAMES = [
  "counterpartyEvidence",
  "corroboratedCounterparties",
  "isCorroboratedCounterparty",
  "mergeCounterpartyEvidence",
  "mayGroupByMessageId",
];

/**
 * WHO MAY ASK WHICH LOOKUP, by CALL — `file#function` and how often, parsed, never by mention. Each
 * turns an id or a reference a stranger writes into an answer about the account, and each is safe
 * only where it is bounded: `findThreadParent` (any row of the account) groups a thread and decides
 * no consent; `findByMessageIdHeader` adopts only a copy the Sent folder vouches for; `citesOwnWriting` is
 * the bounce arm's own question; `messagesCitingOwnWriting` is the retro's, message by message, and
 * `sendersAnsweringOwnWriting` asks every held message for the act and the retro; the correspondent
 * predicate answers the gate, the retro, the act, the suggestions and the press's signal. A new
 * caller is argued for here, or this fails.
 */
const CALL_SITES: Record<string, Record<string, number>> = {
  findThreadParent: { "packages/core/src/threading.ts#resolveThread": 1 },
  findByMessageIdHeader: { "packages/core/src/pipeline.ts#resolveExisting": 1 },
  citesOwnWriting: { "packages/core/src/pipeline.ts#planFromRaw": 1 },
  messagesCitingOwnWriting: {
    "apps/worker/src/screener-correspondent-retro.ts#release": 1,
    "packages/core/src/correspondent.ts#sendersAnsweringOwnWriting": 1,
  },
  sendersAnsweringOwnWriting: {
    "apps/worker/src/screener-auto-act.ts#screenerAutoActPass": 1,
    "apps/worker/src/screener-correspondent-retro.ts#screenerCorrespondentRetroPass": 1,
  },
  ownSentCopies: {
    "packages/core/src/adapters/drizzle-repo.ts#citesOwnWriting": 1,
    "packages/core/src/correspondent.ts#messagesCitingOwnWriting": 1,
  },
  isCorrespondent: { "packages/core/src/pipeline.ts#correspondentAtGate": 1 },
  // `List-Post`'s parser and its write (mail 0150): ingest and the one-time backfill, a fact that
  // only ever takes consent away.
  listPostAddresses: {
    "packages/core/src/pipeline.ts#listAddressesOf": 1,
    "apps/worker/src/list-address-backfill.ts#listAddressBackfillPass": 1,
  },
  recordListAddresses: {
    "packages/core/src/pipeline.ts#commitChange": 2,
    "apps/worker/src/list-address-backfill.ts#listAddressBackfillPass": 1,
  },
  correspondentsAmong: {
    "packages/core/src/adapters/drizzle-repo.ts#isCorrespondent": 1,
    "apps/worker/src/screener-auto-act.ts#screenerAutoActPass": 1,
    "apps/worker/src/screener-auto-suggest.ts#screenerAutoSuggestPass": 1,
    "apps/worker/src/screener-correspondent-retro.ts#screenerCorrespondentRetroPass": 1,
    "apps/worker/src/screener-correspondent-retro.ts#retireAutoActRules": 1,
    "packages/services/src/screener-service.ts#markCorrespondents": 1,
  },
};

/** The nearest NAMED function around a node: a declaration, a method, or a binding of an arrow. */
function enclosingFunction(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)
      && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return "<module>";
}

/** Every CALL of a {@link CALL_SITES} name in one file — a call expression, so a declaration or a mention is none. */
function callSitesIn(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name !== null && name in CALL_SITES) out.push(`${name} ${file}#${enclosingFunction(n)}`);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** `name → { site: count }` over every app's and package's own `src`, wider than the term scan's roots. */
function callMap(files: ReadonlyArray<{ file: string; text: string }>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { file, text } of files) {
    if (!Object.keys(CALL_SITES).some((name) => text.includes(name))) continue;
    for (const hit of callSitesIn(file, text)) {
      const [name, site] = hit.split(" ") as [string, string];
      (out[name] ??= {})[site] = (out[name]![site] ?? 0) + 1;
    }
  }
  return out;
}

function everySource(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        out.push({ file: p.split(sep).join("/"), text: readFileSync(join(ROOT, p), "utf8") });
      }
    }
  };
  for (const top of ["apps", "packages"]) {
    for (const e of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(ROOT, top, e.name, "src"))) walk(join(top, e.name, "src"));
    }
  }
  return out;
}

/** Files allowed to read the ingest thread key — closed, so a new reader cannot self-classify. */
const THREAD_KEY_READERS = [
  "apps/worker/src/thread-backfill.ts",
  "packages/core/src/pipeline.ts",
  "packages/core/src/threading.ts",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * A REAL PARSE, never a token scan.
 *
 * `ts.createScanner` mis-nests a `sql` template with substitutions and swallows the code after it:
 * measured on this tree, the scanner read 659 tokens of a 28 KB file and missed four files' worth
 * of real reads — the shape `box-files.mjs` was fixed for. To a parser a template literal is one
 * node, so identifier and string tokens are the file's own.
 */
function termsIn(file: string): string[] {
  const sf = ts.createSourceFile(
    file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && TERMS.has(n.text)) found.add(n.text);
    else if (ts.isStringLiteral(n) && TERMS.has(n.text)) found.add(n.text);
    else if (ts.isPropertyAccessExpression(n) && TERMS.has(n.name.text)) found.add(n.name.text);
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
  return [...found].sort();
}

const scan = new Map<string, string[]>();
for (const root of SCANNED_ROOTS) {
  for (const file of sourceFiles(join(ROOT, root))) {
    const terms = termsIn(file);
    if (terms.length > 0) scan.set(relative(ROOT, file).split(sep).join("/"), terms);
  }
}
for (const named of EXTRA_SCANNED) {
  const terms = termsIn(join(ROOT, named));
  if (terms.length > 0) scan.set(named, terms);
}

const ALL_CLASSIFIED = { ...CLASSIFIED, ...CLASSIFIED_DB };

describe("a header the sender writes is never an identity or a ranking key", () => {
  it("classifies every read — an unclassified one is a new identity use", () => {
    const unclassified = [...scan.keys()].filter((f) => !(f in ALL_CLASSIFIED)).sort();
    expect(unclassified, "sender-header reads with no class: add a row saying what this site does")
      .toEqual([]);
  });

  it("carries no stale row — a class for a read that is gone says nothing", () => {
    const gone = Object.keys(ALL_CLASSIFIED).filter((f) => !scan.has(f)).sort();
    expect(gone, "classified files that no longer read any of these names").toEqual([]);
  });

  it("names every term a classified file reads — a new read in an old file counts", () => {
    const drifted: string[] = [];
    for (const [file, row] of Object.entries(ALL_CLASSIFIED)) {
      const terms = scan.get(file);
      if (!terms) continue;                             // the stale case, above
      if (terms.join(",") !== row.terms.join(",")) {
        drifted.push(`${file}: reads [${terms.join(", ")}], classified for [${row.terms.join(", ")}]`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it("uses only the named classes, and every row says why", () => {
    for (const [file, row] of Object.entries(ALL_CLASSIFIED)) {
      expect(row.classes.length, `${file} has no class`).toBeGreaterThan(0);
      for (const c of row.classes) expect(CLASSES, `${file}: ${c}`).toContain(c);
      expect(row.why.length, `${file} has no reason`).toBeGreaterThan(20);
    }
  });

  it("keeps the ingest thread key's readers closed", () => {
    const readers = Object.entries(CLASSIFIED)
      .filter(([, row]) => row.classes.includes("thread-key-at-ingest"))
      .map(([file]) => file).sort();
    expect(readers).toEqual([...THREAD_KEY_READERS].sort());
  });

  it("each lookup is called only where it is bounded — by file, function and count", () => {
    const sources = everySource();
    expect(sources.length, "the walk read the tree").toBeGreaterThan(500);
    expect(callMap(sources), "a new caller of a sender-header lookup: argue for it in CALL_SITES").toEqual(CALL_SITES);
  });

  it("CONTROL: a planted call outside its sites is refused, and a declaration or a mention is no call", () => {
    const planted = [
      "export async function planFromRaw(repo: RepoPort, ids: string[]) {",
      "  const parent = await repo.findThreadParent(accountId, ids);",
      "}",
    ].join("\n");
    const refused = callMap([...everySource(), { file: "packages/core/src/pipeline.ts", text: planted }]);
    expect(refused, "the bounce arm back on any row of the account is refused").not.toEqual(CALL_SITES);
    expect(refused.findThreadParent)
      .toEqual({ ...CALL_SITES.findThreadParent, "packages/core/src/pipeline.ts#planFromRaw": 1 });
    const quiet = [
      "export interface RepoPort { findThreadParent(a: string, c: readonly string[]): Promise<null>; }",
      "export class Repo { async findThreadParent(a: string) { return null; } }",
      "// repo.findThreadParent(accountId, ids) in a comment",
      "const words = \"repo.citesOwnWriting(accountId, ids)\";",
    ].join("\n");
    expect(callMap([{ file: "packages/core/src/ports.ts", text: quiet }])).toEqual({});
  });

  it("every deciding site consults the rule", () => {
    const missing: string[] = [];
    for (const file of MUST_CONSULT) {
      // Import statements out first, so an import nothing calls cannot answer for a call.
      const body = readFileSync(join(ROOT, file), "utf8")
        .split("\n").filter((line) => !/^\s*(import\b|\}?\s*from\s+")/.test(line)).join("\n");
      if (!RULE_NAMES.some((name) => body.includes(`${name}(`))) missing.push(file);
    }
    expect(missing, "these group or rank on a sender-written header and must ask the rule")
      .toEqual([]);
  });
});
