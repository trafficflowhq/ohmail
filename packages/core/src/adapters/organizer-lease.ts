import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { WATCHED_FOLDERS, type ImapAuth } from "./imap-types.js";

/**
 * THE ORGANIZER LEASE — how two databases that can never see each other agree on who organizes
 * a mailbox.
 *
 * A LOCAL desktop install runs on its own on-disk PGlite and structurally cannot query the hosted
 * cloud database; Cloud runs on that database and cannot see the desktop's PGlite. The mailbox is
 * the only medium they share, so the claim lives **in the mailbox**: one message per organizer in
 * an unsubscribed `ohmail/_meta` folder.
 *
 * ── IT IS A LEASE, NOT A MUTEX, AND THAT IS NOT A HEDGE ───────────────────────────────────
 *
 * IMAP has no compare-and-swap. Two installs can APPEND in the same instant and both succeed.
 * What this buys is conflict DETECTION with every-cycle re-verification, and that is enough for
 * the actual requirement: a transient one-cycle overlap is idempotent-safe, while steady-state dual
 * organizing becomes impossible because the loser's next gate refuses. Do not upgrade the naming or
 * the comments to "lock" — the word would be a claim the mechanism cannot make.
 *
 * **The REASON for that idempotence changed under this comment.** It used
 * to read "the pipeline dedups by Message-ID"; that is no longer true — `dedup_key` is
 * `fp1:<sha256>` over every field a sender chooses, and the Message-ID is one input among ten. The
 * conclusion survives for a BETTER reason: the fingerprint is a strictly finer identity, so two
 * engines ingesting the same bytes still resolve to the same row, and the second engine's
 * observation of a locator the first already recorded is now an `external_copy` — which writes one
 * instance row and changes no placement — rather than an adoption. A transient overlap therefore
 * costs a duplicate fetch, not a fought-over `desired_folder`.
 *
 * Why two organizers must never coexist, concretely: `runSyncCycle` ingests *through* the
 * pipeline, so syncing and organizing are one loop. Two organizers means two engines classifying
 * the same new message and issuing competing moves — and `adopt_external` ("reality changed in a
 * way we did not cause, so the user wins") was written for a HUMAN in another mail client, not
 * for a second ohmail fighting the first. `adopt_external` is explicitly
 * NOT load-bearing here.
 *
 * ── THE WIRE FORMAT, IN ONE PLACE ────────────────────────────────────────────────────────
 *
 * `ohmail/_meta` is a protocol between builds that update on completely different clocks: the
 * hosted service in minutes, a desktop install in days, a phone in months. Every one of them reads
 * and writes this one folder, so the format is the compatibility surface and it is defined HERE
 * rather than inferred from four parsers.
 *
 * **Every record is HEADERS-ONLY.** One `X-Ohmail-*` header names the kind; the rest of the record
 * is that kind's fields; the body is one sentence for a human who opens the folder in another mail
 * client. Nothing reads the body. Records are APPENDED with `\Seen` and are removed only by the
 * install that wrote them or by the organizer that has handled them.
 *
 * ### The four kinds, and the ONE header that tells them apart
 *
 * | discriminator          | kind      | written by | parsed by                                  |
 * | ---------------------- | --------- | ---------- | ------------------------------------------ |
 * | `X-Ohmail-Lease: 1`    | claim     | organizer  | {@link parseClaim}                         |
 * | `X-Ohmail-Request: 1`  | request   | reader     | {@link parseRequestEnvelope}               |
 * | `X-Ohmail-Ack: 1`      | ack       | organizer  | {@link parseAck}                           |
 * | `X-Ohmail-Profile`     | profile   | organizer  | `organizer-profile.ts`                     |
 *
 * {@link META_RECORD_KINDS} is that table as data, and {@link classifyMetaRecord} is the only
 * function that reads a discriminator. **A fifth kind is one entry in that array** plus its own
 * parser — not a fourth predicate that four call sites must remember to consult.
 *
 * A record carrying no discriminator this build knows is `null`: not ours, not touched, not
 * counted. Somebody else's mail client may keep something in this folder and it is not ours to
 * destroy.
 *
 * ### Two protocol numbers, and they move independently
 *
 * {@link CLAIM_PROTOCOL} versions the claim; {@link REQUEST_PROTOCOL} versions the request and its
 * acknowledgement. They are separate because the election and the decision channel change for
 * unrelated reasons, and a shared number would force a fleet-wide step for either.
 *
 * ### What a build does with a record it was not built for — BOTH directions
 *
 * | | an OLDER build meets a NEWER record | a NEWER build meets an OLDER record |
 * | --- | --- | --- |
 * | **claim** | ranks it as `kind: "unknown"` and treats it as LIVE — an unrankable fresh claim refuses even an authorized takeover, so the mailbox is left to whoever holds it rather than contested by a build that cannot read the holder. Never expunged. | ranks it normally. Fields it does not carry read as absent, and absence has a defined meaning at every one of them (`authorizedAt: null` is "nobody pressed for this install", which is the resting state). |
 * | **request** | LEAVES IT STANDING — `protocol > REQUEST_PROTOCOL`, or a kind with no applier here, is neither applied nor expunged, and the record waits for a build that understands it. **This courtesy is extended only to records that VERIFY**, because an unauthenticated record that could reach a permanent disposition is a denial of service anyone with folder rights can mount. | applies it. New fields are additive and optional; the signature is over a canonical form that names its own fields, so an older record hashes the older list. |
 * | **ack** | leaves it standing, same rule and the same verification-first ordering. | reads it. **The ack's signed field list is FIXED at protocol 1** — see {@link REQUEST_PROTOCOL} for why adding a field there is a breaking change that needs a bump and a tolerant, protocol-keyed canonicalization. |
 * | **profile** | ignores a document version it cannot read, and does not overwrite it. | reads it; `organizer-profile.ts` carries that half. |
 *
 * The rule underneath all eight cells: **an unreadable record is evidence, never permission.** A
 * build that cannot understand something in this folder must leave both the record and the mailbox
 * alone, because "I do not understand this" and "there is nothing here" have to stay
 * distinguishable.
 *
 * ── AND THE FOLDER-LEVEL RULE IS NOT THE SAME AT EVERY READER — a DECISION, not an oversight ─
 *
 * One record this build cannot read is one record. A folder too full to read in one window is a
 * different question, and the three readers of `ohmail/_meta` deliberately answer it differently.
 * This paragraph is here rather than buried at the implementation because it is the kind of thing a
 * later reader "tidies" into consistency, and consistency is the wrong answer.
 *
 * | reader | a truncated read | why |
 * | --- | --- | --- |
 * | the read-only PEEK | REFUSES — reports the mailbox unknown, never unheld | it exists to tell a person who holds their mailbox; being wrong prints a false sentence and invites a takeover of a mailbox somebody is actively organizing |
 * | both record DRAINS | REFUSE — skip the cycle, expunge nothing, append nothing | the reader's state machine reads "my record is not in the folder" as "the organizer took it", so a partial view tells a person a decision nobody ever saw was applied. Refusing costs one cycle |
 * | the lease GATE | ELECTS over the CLAIM SET, asked of the server by header search, and logs the count; refuses (`meta_folder_full`) only when the server cannot be asked or the claim set itself exceeds the ceiling | an organize verdict needs proof that no live claim is hidden, and a window cannot give it; a header search can, at the cost of one round trip, and only on the cycles where the folder is over the ceiling |
 *
 * ── AND IT APPLIES AGAIN INSIDE THE GATE, BETWEEN ITS OWN THREE READS ───────────────────────
 *
 * The gate reads this folder three times, and "acts on the window" is right for only one of them.
 *
 * | the gate's read | a truncated read | why |
 * | --- | --- | --- |
 * | the ELECTION | never on the window: on a truncated read it elects over the server-side claim set, or refuses | the window drops old records, and a live claim renewed under a burst is exactly an old record |
 * | the VERIFY after a renew | acts — safely | every claim it could NEWLY need to see was appended AFTER the election (our own, and a rival that renewed in the gap), and anything appended after the election is inside a newest-first window by construction. An older rival is the election's own documented residual, not a gap in this read |
 * | the handover CONFIRM | acts only where the window COVERS the ref, and not at all across a UIDVALIDITY change | it asks whether specific OLD refs are gone, and old is exactly what a newest-first window drops — while a renumbering makes the two reads' refs incomparable outright |
 *
 * The distinction is between choosing and CUSTODY. An election over a partial folder picks the best
 * of what it can see and is bounded by the next cycle. A custody check asks "is the claim I
 * displaced really gone", and a ref outside the window is absent from the read for the same reason
 * a successfully expunged one is — so reading that absence as success confirms a handover that
 * never landed, spending the caller's one-shot authorization while the beaten claim stands to win
 * the next election. UIDs ascend with arrival, so the window covers the highest of them and a ref
 * below its floor is one the read could not have seen; such a ref is treated exactly as a survivor
 * is, because "still there" and "I could not look" have the same correct answer here.
 *
 * **The asymmetry follows from what being wrong COSTS at each reader, not from tidiness.** The peek
 * and the drains fail into a false sentence, which a person acts on; the gate fails into lost mail,
 * which is the product. Where the two conflict, mail wins.
 *
 * A forged claim yields one organizer; a flood over a live incumbent yields two. The second
 * outcome is not available directly, which is why hiding a claim is the attack worth closing and
 * why the election reads the claim set rather than the folder.
 *
 * ── THREE LAYERS, AND THE SPLIT IS THE POINT ──────────────────────────────────────────────
 *
 *   1. FORMAT  — {@link formatClaim} / {@link parseClaim}. Pure string work.
 *   2. DECISION — {@link decideLease}. A pure function over parsed claims, so the whole table is
 *      unit-testable without a server and every arm can be watched fail.
 *   3. IO — {@link LeaseIo} and {@link runLeaseGate}. The only part that needs a connection.
 *
 * The decision layer never touches IO and the IO layer never decides. That is what makes the
 * priority table checkable at all: a decision function that could also fail to read is a
 * function whose "stand down" and "could not look" are the same code path, and §3.4 exists
 * because those two must never be reachable from one another.
 */

/**
 * The folder holding the claims. **No leading dot**, so it survives both `/` and `.` hierarchy
 * delimiters when mapped through the adapter's `toServerPath`.
 *
 * It must stay OUT of {@link WATCHED_FOLDERS} — that constant is the input to `changesSince`, so
 * a watched `_meta` would ingest the lease's own bookkeeping as mail, classify it, and file it.
 * {@link META_FOLDER_IS_UNWATCHED} is that assertion rather than a comment, and it is evaluated
 * at module load so the two constants cannot drift apart unnoticed.
 */
export const META_FOLDER = "ohmail/_meta";

/** `true` iff {@link META_FOLDER} is absent from the watched set. Asserted by the suite. */
export const META_FOLDER_IS_UNWATCHED: boolean = !(WATCHED_FOLDERS as readonly string[]).includes(META_FOLDER);

/* ══ WHERE `ohmail/_meta` ACTUALLY LIVES ON THIS SERVER ═══════════════════════════════════════
 *
 * `toServerPath(META_FOLDER)` answers what the folder is CALLED — `ohmail._meta` on a
 * dot-delimited server, `ohmail/_meta` on a slash-delimited one. It does not answer where it
 * IS, and on a server with a personal-namespace prefix those are different strings.
 *
 * ── THE FAILURE, MEASURED LIVE ──────────────────────────────────────────────────────────────
 *
 * Dovecot with `NAMESPACE` personal prefix `INBOX.` and delimiter `.` — the shape both live
 * mailboxes this project has ever run against report — files a root-named CREATE under the
 * prefix and then LISTS it there. So the folder Cloud has been writing its claim into for
 * months is `INBOX.ohmail._meta`, while `toServerPath(META_FOLDER)` says `ohmail._meta`, and
 * every read that asked `list.some((f) => f.path === p)` answered NO on a mailbox holding a
 * live claim with a heartbeat minutes old.
 *
 * That answer was load-bearing in the worst possible place. The pre-consent peek reports "no
 * holder" from it, the guided flow's "somebody else organizes this mailbox" step never renders,
 * and a person connecting a mailbox their other machine is actively organizing is shown the
 * plain consent statement and agrees to take it without ever being told. The single-organizer
 * invariant rests on this read.
 *
 * ── SO THE RESOLUTION IS ONE FUNCTION, USED BY BOTH SIDES ──────────────────────────────────
 *
 * The consented path and the APPEND-less peek go through {@link makeMetaFolderRef} and nothing
 * else. Two spellings of "where is `_meta`" is precisely how a reader and a writer end up
 * pointed at different folders — the reader seeing nobody while the writer renews beside it —
 * so there is one, and `meta-folder.test.ts` censuses the source to keep it that way.
 */

/**
 * A LIST row, as much of one as the meta-folder resolution reads.
 *
 * `delimiter` is optional because it is a client-library convenience rather than something every
 * fake carries. It is read the way {@link LeaseImapClient.mailbox} is read: absence means
 * "unknown", never a value.
 */
export interface MetaFolderRow {
  readonly path: string;
  readonly subscribed?: boolean;
  readonly delimiter?: string;
}

/** One personal namespace, as RFC 2342's NAMESPACE response describes it. */
export interface MetaNamespaceEntry {
  /** Already delimiter-terminated by the client library — `INBOX.`, not `INBOX`. */
  readonly prefix?: string;
  /** NIL for a namespace with no hierarchy, which RFC 2342 §5 allows. */
  readonly delimiter?: string | null;
}

/**
 * The NAMESPACE half of a client, read structurally and defensively.
 *
 * `ImapFlow` sets both fields during `connect()` — and sets them even on a server without the
 * NAMESPACE extension, by falling back to `LIST "" ""`, which is why the authoritative branch
 * below is the one that runs in production rather than the derived one. A client that exposes
 * neither is not an error; it takes the derived branch.
 */
export interface MetaNamespaceSource {
  readonly namespace?: MetaNamespaceEntry | null | undefined;
  readonly namespaces?: { readonly personal?: readonly MetaNamespaceEntry[] | false | null } | null | undefined;
}

/** Where `ohmail/_meta` is — or, when nothing holds it yet, where it should be created. */
export interface MetaFolderLocation {
  /** The server path to CREATE, SELECT, APPEND and EXPUNGE at. */
  readonly path: string;
  /** The LIST row that matched, or `null` when no such folder exists on this server. */
  readonly row: MetaFolderRow | null;
}

/**
 * TWO FOLDERS BOTH LOOK LIKE `ohmail/_meta`, AND PICKING ONE IS THE THING THIS MUST NOT DO.
 *
 * Reachable on a server offering both a root namespace and a prefixed one, where an older build
 * created `ohmail._meta` at the root and a newer one created `INBOX.ohmail._meta`. Choosing
 * either would put the reader and the writer in different folders for as long as both exist,
 * which is the dual-organizer bug with a longer fuse: each install renews a claim the other
 * cannot see, and both organize.
 *
 * It THROWS, and every caller's wrapper turns that into {@link LeaseUnavailableError} — "I could
 * not look", which §3.4 requires be unreachable from "nobody holds it". A mailbox in this state
 * needs a person to delete one of the two folders; nothing here can know which.
 */
export class AmbiguousMetaFolderError extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(
      `${META_FOLDER} resolves to more than one folder on this server (${paths.join(", ")}), so which `
      + `one carries the organizer lease is unknown; nothing was read and nothing was written`,
    );
    this.name = "AmbiguousMetaFolderError";
    this.paths = paths;
  }
}

/** `META_FOLDER` is exactly two segments, and both halves are needed to read a mapped spelling. */

/**
 * The personal namespaces a client learned at login, most-preferred first.
 *
 * `namespaces.personal` before `namespace` because the first is the whole list and the second is
 * only its head — a server declaring two personal namespaces would otherwise have one of them
 * silently invisible to the match below.
 */
export function personalNamespacesOf(client: MetaNamespaceSource | undefined): readonly MetaNamespaceEntry[] {
  if (client === undefined || client === null) return [];
  const declared = client.namespaces?.personal;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  const one = client.namespace;
  return one ? [one] : [];
}

/**
 * ONE ALPHABET FOR THE WHOLE RESOLUTION — the delimiter, and `ohmail/_meta` re-spelled in it.
 *
 * A namespace prefix is CONCATENATED onto the mapped name, so the two must be spelled the same
 * way. When they are not, the result is a folder name in two alphabets — and it is not
 * hypothetical: `ImapAdapter.connect` falls back to `delimiter = "/"` when the LIST carries no
 * INBOX row and no delimiter of its own, while NAMESPACE still reports `.`, which produced
 * `INBOX./ohmail/_meta` — a name `ensureMetaFolder` would then CREATE.
 *
 * So the FIRST personal namespace's delimiter wins, because it is the one the prefix is written
 * in and the prefix is the half that cannot be re-spelled. `bare` can be, and is:
 * {@link META_FOLDER} is exactly two segments, so re-joining them costs nothing and leaves the
 * comparison and the concatenation in the same alphabet.
 *
 * Below that, THE LIST ROW'S OWN DELIMITER — the server's statement about its own hierarchy —
 * and only then `bare`'s separator.
 *
 * ── THAT ORDER IS A FIX, AND THE OLD ONE HAD A FALSE PREMISE IN IT ────────────────────────
 *
 * `bare`'s separator used to outrank the LIST row, justified here in these words: "`toServerPath`
 * IS the live connection's delimiter mapping, so whatever it put between the two segments is this
 * server's delimiter, discovered rather than guessed."
 *
 * It is not, and the exception is not exotic. `ImapAdapter` initialises `delimiter = "/"` BEFORE
 * it connects (`imap.ts`), and `toServerPath` short-circuits on `"/"` and returns the canonical
 * name UNCHANGED. So on any adapter that has not learned its delimiter — or has learned `"/"` as
 * the fallback when the LIST carried none — `between` is the CANONICAL's own separator, a default
 * wearing the costume of a discovery, and it was being trusted over the server's own answer.
 *
 * The consequence was a wrong ANSWER rather than a refusal, which is the one direction this file
 * exists to prevent: on a prefixed server with no NAMESPACE reply, `bare` stayed `ohmail/_meta`,
 * no LIST row ends in that, and the resolution returned "absent" — which `makeLeasePeekIo` reads
 * as ZERO CLAIMS and the peek reports as `state=none`. A mailbox another install was actively
 * organizing looked free. Measured: of the four combinations of {delimiter learned, NAMESPACE
 * answered}, exactly one failed — unlearned delimiter AND no namespaces — and neither half failed
 * alone, which is why it survived a resolver written to fix this very family.
 *
 * A LIST row's delimiter is the server saying what its hierarchy separator is. An adapter's
 * spelling of a name it was asked to map is, at best, a report of the same fact and, at worst,
 * the absence of one. So the server's own statement goes first of the two. `between` remains
 * below it for the case the LIST answers nothing at all.
 */
function metaAlphabet(
  bare: string,
  list: readonly MetaFolderRow[],
  ns: readonly MetaNamespaceEntry[],
  canonical: string,
): { delimiter: string; bare: string } {
  /* The two segments of THIS canonical name, not `ohmail/_meta`'s. Every folder this resolution
     serves is exactly two segments (`WATCHED_FOLDERS`), and reading the split off the canonical
     rather than off two module constants is what lets the watched folders share the rule — with
     `ohmail/_meta` still passing its own name and getting exactly what it got before. Deriving a
     FIXED tail length here was the bug in waiting: `_meta` is five characters, so slicing by it
     found the right separator for `ohmail.Reads` by coincidence and garbage for
     `ohmail.Screener`. */
  const one = (d: unknown): string | undefined => (typeof d === "string" && d.length === 1 ? d : undefined);
  const cut = canonical.indexOf("/");
  if (cut === -1) {
    /* A SINGLE-SEGMENT NAME has no separator to discover and nothing to re-spell — `INBOX` is
       one `WATCHED_FOLDERS` entry away from arriving here now that this is a general export.
       Without this the slice arithmetic below is nonsense rather than merely wrong: `head` drops
       the name's last character (`slice(0, -1)`), `tail` is the whole name, and the re-spelling
       builds a folder path out of the overlap. */
    const only = list.find((f) => f.path.toUpperCase() === "INBOX") ?? list[0];
    return { delimiter: one(ns[0]?.delimiter) ?? one(only?.delimiter) ?? "/", bare };
  }
  const head = canonical.slice(0, cut);
  const tail = canonical.slice(cut + 1);
  const between = one(bare.slice(head.length, bare.length - tail.length));
  const row = list.find((f) => f.path.toUpperCase() === "INBOX") ?? list[0];
  const delimiter = one(ns[0]?.delimiter) ?? one(row?.delimiter) ?? between ?? "/";
  return {
    delimiter,
    bare: between !== undefined && between !== delimiter ? `${head}${delimiter}${tail}` : bare,
  };
}

/**
 * FIND `ohmail/_meta` ON THIS SERVER, OR SAY WHERE TO PUT IT. Pure — a LIST and a NAMESPACE in,
 * a path out.
 *
 * ── HOW A PREFIX IS ACCEPTED, AND WHY NOT ANY SUFFIX MATCH ─────────────────────────────────
 *
 * Matching every row that merely ENDS in `ohmail._meta` would adopt a customer's own
 * `Backup.ohmail._meta` as the organizer lease. So a prefix has to be credible:
 *
 *  · **When the client reports personal namespaces, only those prefixes count.** This is the
 *    authoritative branch and the one that runs against any real connection.
 *  · **Otherwise a prefix counts when the server LISTS the mailbox it names** — `INBOX.` because
 *    `INBOX` is a mailbox on that server. Derived from the LIST rather than hardcoded, so a
 *    server whose personal namespace is not spelled `INBOX` is found on the same rule.
 *
 * The root spelling is always a candidate, whatever NAMESPACE says. The reason is the flat
 * server — most of them: `personal[0].prefix` is empty, and the root IS where the folder lives.
 * It also covers a client that hands back the server's paths unaltered. It does NOT, on a
 * prefixed server reached through `ImapFlow`, catch a folder an older build left at the root:
 * that client normalizes LIST output by prepending the namespace prefix, so a genuinely
 * root-level `ohmail._meta` is reported as `INBOX.ohmail._meta` and is indistinguishable here
 * from the prefixed one. Which also makes {@link AmbiguousMetaFolderError} close to unreachable
 * through that client — it is the honest answer where two really are visible, not a case anyone
 * should expect to meet. Two matches is that error, never a choice.
 *
 * When nothing matches, the path returned is the FIRST declared personal prefix plus the mapped
 * name: the server would file a root-named CREATE there anyway, and creating at the name LIST
 * will report is what stops the next reader from having to guess at all.
 */
export function resolveMetaFolder(input: {
  list: readonly MetaFolderRow[];
  /** `toServerPath(META_FOLDER)` — the mapped name, without a namespace prefix. */
  bare: string;
  namespaces?: readonly MetaNamespaceEntry[];
}): MetaFolderLocation {
  return resolveOhmailFolder({ ...input, canonical: META_FOLDER });
}

/**
 * THE SAME RESOLUTION, FOR ANY ONE OF OUR FOLDERS — `ohmail/_meta` is just the caller with the
 * strictest need.
 *
 * Generalised from one canonical name to the set because `ImapAdapter.ensureFolders` had the
 * defect this function was written to fix, in the same shape and for the same reason: it matched
 * `OHMAIL_FOLDERS` against the LIST by string equality, so on a server with a personal-namespace
 * prefix NONE of the five watched folders was ever recognised and all five were re-CREATEd on
 * every connect. Every CREATE was caught as "already exists", so it cost round trips and nothing
 * else — which is why it is a generalisation rather than an incident.
 *
 * Read {@link resolveMetaFolder}'s docstring for the rule itself; the prefix-credibility argument
 * is identical and is not restated here. The only difference is which name is being looked for.
 */
export function resolveOhmailFolder(input: {
  list: readonly MetaFolderRow[];
  /** `toServerPath(canonical)` — the mapped name, without a namespace prefix. */
  bare: string;
  namespaces?: readonly MetaNamespaceEntry[];
  /** The canonical, slash-spelled name `bare` is the server mapping of. Exactly two segments. */
  canonical: string;
}): MetaFolderLocation {
  const { list } = input;
  const ns = input.namespaces ?? [];
  const { delimiter, bare } = metaAlphabet(input.bare, list, ns, input.canonical);
  // A CLIENT THAT ANSWERED IS AUTHORITATIVE EVEN WHEN ITS ANSWER IS "no prefix", and reading
  // this off "are there any NON-EMPTY prefixes" instead would be a hole in exactly the servers
  // most people use. Gmail and Fastmail declare ONE personal namespace whose prefix is empty;
  // that is a positive statement that mailboxes live at the root, so the only candidate is the
  // root. Falling through to the derived branch there would let a customer's own
  // `Archive/ohmail/_meta` — any folder under any listed parent — be adopted as the lease.
  const authoritative = ns.length > 0;

  // ── THE FIRST PERSONAL NAMESPACE, AND ONLY IT ─────────────────────────────────────────────
  //
  // A server may declare several personal namespaces. `ImapFlow` uses exactly one — it sets
  // `namespace = namespaces.personal[0]` and `tools.normalizePath` prepends THAT prefix to
  // every path it sends and to every path LIST hands back — so a folder under a SECOND declared
  // namespace is not where this connection's own organizer would ever write, and treating it as
  // the lease would read a claim out of somewhere the writer will never renew. On a server
  // declaring personal = (("" "/") ("Shared/" "/")) that is a customer's — or another
  // account's — `Shared/ohmail/_meta` adopted as this mailbox's organizer lease.
  //
  // It is also the create path, for the same reason and with the same spelling: the earlier
  // version filtered empty prefixes out before taking the first, which on that same server
  // skipped the empty personal[0] and created the folder under `Shared/`.
  const head = authoritative ? (ns[0]?.prefix ?? "") : "";
  const primary = head === "" || head.endsWith(delimiter) ? head : `${head}${delimiter}`;

  const credible = (prefix: string): boolean => {
    if (prefix === "" || !prefix.endsWith(delimiter)) return false;
    if (authoritative) return prefix === primary;
    // ── NO NAMESPACE TO ASK, AND THIS BRANCH TRADES A RISK FOR AN ANSWER ────────────────────
    //
    // Reachable in production, not only against a fake: `ImapFlow`'s NAMESPACE handler assigns
    // `namespaces.personal[0] = …` when the server answers NIL for the personal list, and
    // `personal` is `false` there — assigning a property to a boolean throws under strict mode,
    // the handler's own catch swallows it, and the connection ends up with no namespace at all.
    //
    // Here a prefix counts when the server LISTS the mailbox it names. That is weaker than the
    // authoritative branch and it is weaker in a direction that matters: a customer's
    // `Backup/ohmail/_meta` IS adopted when `Backup` is a listed folder. The alternative is
    // refusing to resolve at all on a connection that cannot say where its own mail lives,
    // which makes the lease unreadable rather than occasionally wrong. The root candidate is
    // always in play beside this, so an ordinary install still resolves; and two matches are
    // refused rather than picked. The trade is recorded rather than hidden.
    const parent = prefix.slice(0, prefix.length - delimiter.length);
    return list.some((f) => f.path === parent);
  };

  const hits = list.filter((f) => f.path === bare
    || (f.path.endsWith(bare) && credible(f.path.slice(0, f.path.length - bare.length))));

  if (hits.length > 1) throw new AmbiguousMetaFolderError(hits.map((f) => f.path));
  const hit = hits[0];
  if (hit !== undefined) return { path: hit.path, row: hit };
  return { path: `${primary}${bare}`, row: null };
}

/** The minimum a client has to be for {@link makeMetaFolderRef} to resolve against it. */
export interface MetaFolderClient extends MetaNamespaceSource {
  list(): Promise<MetaFolderRow[]>;
}

/**
 * `ohmail/_meta` on ONE connection: resolve it once, then address it.
 *
 * The memo is per REF, and every IO factory builds a fresh one per call, so it lives exactly as
 * long as one gate cycle or one peek — long enough that `ensureMetaFolder` → `listClaims` →
 * `appendClaim` costs one LIST rather than three, and short enough that a folder created or
 * moved between cycles is seen on the next one.
 */
export interface MetaFolderRef {
  /** LIST and resolve, fresh. Also warms {@link MetaFolderRef.path}. */
  locate(): Promise<MetaFolderLocation>;
  /** The path to address, resolving on first use and remembered after. */
  path(): Promise<string>;
  /** Remember a path the SERVER named — a CREATE's landed path is truer than any derivation. */
  adopt(path: string): void;
}

export function makeMetaFolderRef(
  client: MetaFolderClient,
  toServerPath: (canonical: string) => string,
): MetaFolderRef {
  let known: string | null = null;

  const locate = async (): Promise<MetaFolderLocation> => {
    const at = resolveMetaFolder({
      list: await client.list(),
      bare: toServerPath(META_FOLDER),
      namespaces: personalNamespacesOf(client),
    });
    known = at.path;
    return at;
  };

  return {
    locate,
    async path(): Promise<string> {
      return known ?? (await locate()).path;
    },
    adopt(path: string): void {
      known = path;
    },
  };
}

/** The claim format this build writes and understands. */
export const CLAIM_PROTOCOL = 1;

/**
 * How long a claim stays fresh without a renew.
 *
 * Generous relative to plausible clock skew between two machines, and generous relative to a
 * poll interval measured in seconds. The failure this window guards is a real one in both
 * directions: too short and a laptop that slept through a renew is treated as gone while it is
 * still organizing; too long and a genuinely dead install holds a mailbox hostage. Ten minutes
 * against a renew every cycle means roughly forty missed renews before anyone is declared stale.
 */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

/** Who is holding a claim. A closed set — an unrecognised value is foreign-and-unknown. */
export type OrganizerKind = "local" | "cloud";

/**
 * A HUMAN ASKED FOR THIS INSTALL, AND WHEN.
 *
 * ── IT USED TO BE THE STRING `"authorized"`, AND THE INSTANT IS THE WHOLE 0.14.1 CHANGE ──────
 *
 * A boolean-shaped authorization can answer "may I take this mailbox" and nothing else, so the
 * only way to rank two installs that had BOTH been pressed was to rank something else — which is
 * what `kind` was doing, and why a local install had no path over a live Cloud however recently
 * its owner had asked. The instant makes the press itself rankable, so the election orders by the
 * thing a person actually did, and a stale press loses to a fresh one on both doors from the same
 * folder contents.
 *
 * It is an object rather than a bare `Date | null` so that the type CANNOT accept the old string:
 * `takeover: "authorized"` compiles nowhere now, which is the point. A union that still admitted a
 * string would leave a call site nobody updated reading as "pressed at the epoch" — the lowest
 * rank there is — so every authorized takeover in the fleet would be stale, silently, with the
 * suite green.
 */
export interface TakeoverAuthorization {
  /** The instant the press was recorded, as the row holds it. */
  authorizedAt: Date;
}

/** A claim message, parsed. */
export interface OrganizerClaim {
  installId: string;
  kind: OrganizerKind | "unknown";
  protocol: number;
  /** ISO instant of the last renew. NOT IMAP INTERNALDATE — that is the server's clock. */
  heartbeat: Date;
  /** ISO instant this install BECAME organizer, as distinct from last seen. */
  claimedAt: Date;
  displayName: string;
  /** Per-write nonce. See the clone defence on {@link LeaseSelf}. */
  nonce: string;
  /**
   * THE INSTANT OF THE PRESS THIS TENURE RESTS ON — what {@link compareStrength} ranks first.
   *
   * `null` for three populations and they are not the same thing, though the election treats them
   * alike (lowest): a claim written on an empty folder, where there was nobody to take over from;
   * a claim written by an install that predates this field; and a renewal descended from either.
   * All three mean "nobody pressed for this", which is the honest thing to rank below a press.
   */
  authorizedAt: Date | null;
  /**
   * WHAT THIS ORGANIZER OFFERS A READER, as the claim advertises it. Empty means none — which is
   * what every pre-0.14.1 claim says, and it is a true statement about those installs rather than
   * a gap in the parse.
   */
  capabilities: readonly string[];
  /** Whatever the IO layer needs to expunge this exact message. */
  ref?: unknown;
}

/**
 * A message that says it is a claim and then is not parseable as one.
 *
 * Distinct from "not a claim" on purpose. A message in `ohmail/_meta` WITHOUT
 * `X-Ohmail-Lease: 1` is a stray or a future meta record type and is invisible to this module —
 * that is what makes the discriminator header worth having. A message WITH it whose fields are
 * unreadable is EVIDENCE THAT SOMEBODY CLAIMED, and evidence is not nothing: it produces
 * `available`, never `organize`. Reading it as "no claim, so organize" is the dual-organizer bug
 * through the back door.
 */
export interface MalformedClaim {
  malformed: true;
  /** Why, for the log. Never surfaced to a user. */
  reason: string;
  ref?: unknown;
}

export type ClaimRecord = OrganizerClaim | MalformedClaim;

export function isMalformed(c: ClaimRecord): c is MalformedClaim {
  return (c as MalformedClaim).malformed === true;
}

/**
 * Who we are, for the gate.
 *
 * ── THE CLONE DEFENCE, AND WHY `lastNonce` IS MEMORY-ONLY ─────────────────────────────────
 *
 * Restore-from-backup clones the install id. Two machines then both believe every claim carrying
 * that id is their own, and identity matching — which is what makes own-role resumption work —
 * silently permits exactly the dual organizing it was written to prevent.
 *
 * So every write carries a fresh nonce and the writer remembers the last one it wrote. An "own"
 * claim whose nonce is NOT the one we wrote, and whose heartbeat is NEWER than ours, is somebody
 * else with our id: treat it as foreign.
 *
 * `lastNonce` is held IN MEMORY ONLY and deliberately forgotten on restart. Persisting it would
 * break own-role resumption — after a crash we would not recognise our own claim and would stand
 * down from a mailbox nobody else wants. Forgetting it means a fresh process trusts any claim
 * bearing its id exactly once, which is the correct trade: the clone case needs two LIVE writers
 * to be dangerous, and two live writers is exactly the case a null nonce cannot reach.
 */
export interface LeaseSelf {
  installId: string;
  kind: OrganizerKind;
  displayName: string;
  /** The nonce of our last write this process, or `null` on a fresh start. */
  lastNonce: string | null;
  protocol?: number;
}

export type StandDownReason =
  | "organized_elsewhere:cloud"
  | "organized_elsewhere:local"
  | "organized_elsewhere:unknown";

/** Organize this mailbox, and renew our claim while doing so. */
export interface OrganizeVerdict {
  verdict: "organize";
  renew: true;
  /**
   * REFS OF THE FOREIGN CLAIMS THIS WIN DISPLACED, for the IO layer to expunge.
   *
   * ── WHY A TAKEOVER MUST CHANGE THE FOLDER, AND NOT JUST OUR MIND ───────────────────────────
   *
   * Populated only on an AUTHORIZED takeover — never on an ordinary renew, and never on
   * own-role resumption. It is the mechanism that makes a handover converge, and without it the
   * whole arbitration below is undone one cycle after it runs.
   *
   * The sequence it closes, measured rather than imagined: a human authorizes install B over
   * install A's claim. B wins and appends. On the NEXT cycle both sides election over `{A, B}`
   * and A wins on incumbency — so B stands down again, and the takeover the user asked for is
   * quietly reversed. A permanent state, because nothing else ever changes.
   *
   * The folder is the only medium the two installs share, so the decision has to be recorded
   * THERE. Once A's claim is gone, A's own next read finds its claim missing and another live
   * claim present, and A stands down — which is the correct outcome reached from the shared
   * medium rather than from either side's opinion about the other's clock.
   *
   * Expunging somebody else's bookkeeping is a real side effect and it is deliberately narrow:
   * it happens only when a human explicitly asked this install to take this mailbox, and its
   * worst case if the peer is alive is that the peer stands down — the SAFE direction, fewer
   * organizers and never more.
   */
  displace: readonly unknown[];
  /**
   * DID THIS WIN COME FROM THE PRESS, or from continuation? (0.14.1)
   *
   * `true` only on rule 6 — a human asked for this install and its press outranked every live
   * claim. `false` on rules 3 and 4, which are continuation and an empty folder, and which are
   * reached with a press outstanding often enough that "was a press present" is not the same
   * question.
   *
   * The gate needs the distinction to decide what STAMP to write onto the renewed claim: an
   * authorized win writes the press this decision rested on, and everything else carries forward
   * whatever the install's own prior claim held. Deriving it from `displace.length > 0` would be
   * true today by accident — every ref the IO layer hands over is defined — and would silently
   * become wrong for a rule-6 win whose beaten claims had no refs, which is the case where the
   * gate would then write no stamp at all and hand the mailbox straight back on the next election.
   */
  authorized: boolean;
}

/** Somebody else is organizing this mailbox right now. Stop, and release our own claim. */
export interface StandDownVerdict {
  verdict: "stand_down";
  reason: StandDownReason;
  /** The winning claim, so a UI can name the machine. `null` when it was malformed. */
  by: OrganizerClaim | null;
}

/**
 * Nobody is organizing this mailbox, but somebody WAS.
 *
 * The third verdict, and the one a two-verdict table gets wrong. "No fresh foreign claim ⇒
 * organize" is precisely §4's forbidden auto-resume: a Cloud subscription lapses, and a
 * forgotten install on an office machine silently becomes the thing that moves someone's mail,
 * triggered by a billing event, with a rules store frozen at stand-down.
 *
 * §4's governing principle is that **ceasing to organize is always automatic; BECOMING an
 * organizer always requires an explicit human action** — including for Cloud. `available` is
 * that principle with a name. It converts to `organize` only when the caller passes
 * `takeover: "authorized"`, which means a human clicked something.
 *
 * Zero claims is NOT this. A mailbox nobody has ever organized has nobody to take over from.
 */
export interface AvailableVerdict {
  verdict: "available";
  /** The stale claim we would be taking over from, or `null` if it was malformed. */
  by: OrganizerClaim | null;
}

export type LeaseVerdict = OrganizeVerdict | StandDownVerdict | AvailableVerdict;

// ── LAYER 1: FORMAT ─────────────────────────────────────────────────────────────────────────

const H = {
  lease: "X-Ohmail-Lease",
  kind: "X-Ohmail-Organizer-Kind",
  installId: "X-Ohmail-Install-Id",
  protocol: "X-Ohmail-Protocol",
  heartbeat: "X-Ohmail-Heartbeat",
  claimedAt: "X-Ohmail-Claimed-At",
  displayName: "X-Ohmail-Display-Name",
  nonce: "X-Ohmail-Nonce",
  /**
   * THE INSTANT OF THE PRESS THAT CREATED THIS TENURE — the field the election now ranks on.
   *
   * Additive at protocol 1, deliberately: an install one release older parses every field it knows
   * and ignores this one, which is exactly the behaviour a cross-version handover needs. What it
   * costs is stated where the ranking is (see {@link compareStrength}) — an older install ranks by
   * incumbency alone and can therefore win an election a newer one would give to the press.
   */
  authorizedAt: "X-Ohmail-Authorized-At",
  /**
   * WHAT THIS ORGANIZER CAN DO FOR A READER — a comma-separated set; absent means none.
   *
   * It exists so a reader can tell "the organizer will take my decisions" from "the organizer is
   * an older build that will never look", and say so instead of leaving somebody waiting for ever
   * on a machine that is never going to answer.
   */
  capabilities: "X-Ohmail-Capabilities",
} as const;

/**
 * The one capability there is today: this organizer drains decision records out of the meta
 * folder. Re-exported here because both writers and the reader's door name the same string, and
 * two spellings of a capability are a capability that is never detected.
 *
 * ── IT WAS TWO LITERALS UNTIL 0090, HELD EQUAL BY A TEST ────────────────────────────────────
 *
 * The argument for duplicating it was a dependency direction: `@trafficflow/db` must never import
 * `@trafficflow/core`, so `organizer-role.ts` could not reach a constant defined here. That half
 * is true and still is. The half that was wrong is the conclusion — the edge runs the OTHER way
 * and always has (`packages/core/package.json` names `@trafficflow/db`, and
 * `drizzle-repo.ts`, `pipeline.ts`, `husk-restore.ts` and `organizer-profile-store.ts` all import
 * from it), so THIS module can import the constant from THERE. One definition, in the package that
 * cannot reach the other, and the equality test it used to need is deleted along with the second
 * literal: there is nothing left for it to compare.
 */
export { CAPABILITY_REQUESTS } from "@trafficflow/db";

/** Strip CR/LF so a display name can never inject a header. */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

export interface ClaimInput {
  installId: string;
  kind: OrganizerKind;
  displayName: string;
  heartbeat: Date;
  claimedAt: Date;
  nonce: string;
  protocol?: number;
  /**
   * THE PRESS THIS TENURE RESTS ON, or `null` for a tenure nobody pressed for.
   *
   * ── REQUIRED, AND NOT OPTIONAL, AND THE DIFFERENCE IS THE WHOLE FIELD ─────────────────────
   *
   * `authorizedAt?: Date` would compile at every existing call site and write NOTHING at all of
   * them — so every claim this build wrote would rank as an unpressed one, every authorized
   * takeover would read as stale to the next election, and the feature would be off in production
   * with a green suite behind it. Making it required means a caller has to decide, once, per
   * write site, and the compiler names the sites.
   *
   * `null` is a real answer and the common one: a claim on an empty folder is arm 4's
   * "nobody has ever organized this mailbox", which is not a press and must not rank as one.
   */
  authorizedAt: Date | null;
  /**
   * WHAT THIS ORGANIZER OFFERS A READER. Required for {@link authorizedAt}'s reason exactly: an
   * optional field left off every call site would advertise nothing from every organizer, and a
   * reader reading that would tell its user the holder is too old to take decisions — on a fleet
   * where every holder is this build.
   *
   * Empty is legal and means "none"; the header is then omitted, which is what an older reader
   * sees anyway.
   */
  capabilities: readonly string[];
}

/**
 * One RFC822 message per organizer.
 *
 * The body is a sentence for a human who opens `ohmail/_meta` in Apple Mail and wonders what
 * this is. It carries no information the headers do not — a reader that parses the body would be
 * a second format.
 */
export function formatClaim(c: ClaimInput): string {
  const protocol = c.protocol ?? CLAIM_PROTOCOL;
  // ── AN ABSENT HEADER IS THE ONLY SPELLING OF "NONE" ─────────────────────────────────────
  //
  // Neither field is ever written empty. `X-Ohmail-Authorized-At:` with nothing after it would
  // parse to an unreadable date, which is a MALFORMED claim — evidence somebody claimed that
  // cannot be read, and the strongest refusal in this module. `X-Ohmail-Capabilities:` empty would
  // be a set containing one empty string. Both are the same mistake: a field that means "nothing"
  // has to be absent, because a reader one release older cannot tell an empty value from a value
  // it does not understand.
  const capabilities = c.capabilities.map(headerSafe).filter((v) => v !== "");
  const lines = [
    `${H.lease}: 1`,
    `${H.kind}: ${c.kind}`,
    `${H.installId}: ${headerSafe(c.installId)}`,
    `${H.protocol}: ${protocol}`,
    `${H.heartbeat}: ${c.heartbeat.toISOString()}`,
    `${H.claimedAt}: ${c.claimedAt.toISOString()}`,
    ...(c.authorizedAt ? [`${H.authorizedAt}: ${c.authorizedAt.toISOString()}`] : []),
    ...(capabilities.length > 0 ? [`${H.capabilities}: ${capabilities.join(", ")}`] : []),
    `${H.displayName}: ${headerSafe(c.displayName)}`,
    `${H.nonce}: ${headerSafe(c.nonce)}`,
    `Subject: ohmail organizer claim`,
    `Date: ${c.heartbeat.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    `ohmail is organizing this mailbox from ${headerSafe(c.displayName)}.`,
    "This message is bookkeeping. Deleting it is safe; ohmail writes a new one on its next cycle.",
    "",
  ];
  return lines.join("\r\n");
}

/** Read the headers of one message. Returns `null` when it is not a claim at all. */
export function parseClaim(raw: string, ref?: unknown): ClaimRecord | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  // Unfold continuation lines before splitting: a long display name may be wrapped by the
  // server, and a folded header read line-by-line loses everything after the first line.
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    headers.set(name, line.slice(at + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }

  const get = (k: string): string | undefined => headers.get(k.toLowerCase());
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;

  const malformed = (reason: string): MalformedClaim =>
    ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };

  // ── A RECORD THAT SAYS `X-Ohmail-Lease: 1` ANYWHERE IS NEVER INVISIBLE ────────────────────
  //
  // The discriminator used to be read with last-value-wins, so a record whose headers were
  // `X-Ohmail-Lease: 1` … `X-Ohmail-Lease: 0` parsed as NOT A CLAIM AT ALL — `null`, which the
  // gate drops entirely. An incumbent's only claim could therefore be erased from every reader's
  // view by one duplicated header, and the next install to look would find an empty folder and
  // start organizing beside it. Reproduced against the parser, not inferred.
  //
  // So the DUPLICATE is what is refused, and it is refused as `malformed` rather than as `null`:
  // "a message that announces itself and cannot be read" is evidence somebody claimed, and
  // evidence produces `available` at worst. `null` is reserved for a record that never claimed
  // anything — a stray note, or a future meta record type this build does not know.
  if (count(H.lease) > 1) return malformed("duplicate lease header");
  if (get(H.lease) !== "1") return null; // not a claim — a stray, or a future meta record type
  // Every field the decision reads gets the same treatment, for the same reason: a duplicated
  // `X-Ohmail-Install-Id` or `X-Ohmail-Heartbeat` would let a crafted record present one identity
  // to a reader that takes the first value and another to one that takes the last.
  //
  // `X-Ohmail-Authorized-At` joins that list because the ELECTION reads it first, so a duplicate
  // is the same attack one field over: a crafted record could rank as a fresh press to a reader
  // that takes the last value and as an unpressed claim to one that takes the first, and the two
  // readers would elect different organizers off the same folder. `X-Ohmail-Capabilities` joins it
  // because a reader DECIDES on it — whether to hand this organizer a decision or to tell its user
  // nobody will take one — and a record that answers that question twice has not answered it.
  for (const field of [
    H.kind, H.installId, H.protocol, H.heartbeat, H.claimedAt, H.nonce,
    H.authorizedAt, H.capabilities,
  ]) {
    if (count(field) > 1) return malformed(`duplicate ${field}`);
  }

  const installId = get(H.installId);
  if (!installId) return malformed("no install id");

  const protocolRaw = get(H.protocol);
  const protocol = Number(protocolRaw);
  if (!protocolRaw || !Number.isFinite(protocol) || protocol < 1) return malformed("unreadable protocol");

  const heartbeat = new Date(get(H.heartbeat) ?? "");
  if (Number.isNaN(heartbeat.getTime())) return malformed("unreadable heartbeat");

  // A claim with no `claimedAt` is still a claim; it just cannot win the local-vs-local
  // incumbent comparison. Defaulting to the heartbeat makes it the NEWEST possible incumbent,
  // which is the losing side of §3.2 rule 4 — the fail-safe direction.
  const claimedAtRaw = get(H.claimedAt);
  const claimedAt = claimedAtRaw ? new Date(claimedAtRaw) : heartbeat;

  const kindRaw = (get(H.kind) ?? "").toLowerCase();
  const kind: OrganizerKind | "unknown" = kindRaw === "local" || kindRaw === "cloud" ? kindRaw : "unknown";

  /* ── AN ABSENT PRESS IS `null`; AN UNREADABLE ONE IS MALFORMED ──────────────────────────────
   *
   * The two are deliberately not folded together, and the direction matters. Absent is the common
   * case — every pre-0.14.1 claim and every arm-4 claim — and it means "nobody pressed", which is
   * a fact the election ranks lowest and carries on with. A header that is PRESENT and unreadable
   * is a record that tried to say something about its own authority and failed, and reading that
   * as "nobody pressed" would let a corrupted or crafted stamp quietly demote a real press to the
   * bottom of the order. `heartbeat` above takes the same line for the same reason.
   */
  const authorizedAtRaw = get(H.authorizedAt);
  let authorizedAt: Date | null = null;
  if (authorizedAtRaw !== undefined) {
    const parsed = new Date(authorizedAtRaw);
    if (Number.isNaN(parsed.getTime())) return malformed("unreadable authorized-at");
    authorizedAt = parsed;
  }

  /* A SET, ORDER-FREE AND CASE-FOLDED, and an unknown member is KEPT rather than dropped: this
     build cannot know what a later one advertises, and a reader that silently discarded the
     members it did not recognise would be unable to say "that organizer offers something I do not
     understand" — which is a different sentence from "that organizer offers nothing". Empty
     members are dropped, so `a, , b` is two capabilities and not three. */
  const capabilities = (get(H.capabilities) ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");

  const claim: OrganizerClaim = {
    installId,
    kind,
    protocol,
    heartbeat,
    claimedAt: Number.isNaN(claimedAt.getTime()) ? heartbeat : claimedAt,
    displayName: get(H.displayName) ?? "",
    nonce: get(H.nonce) ?? "",
    authorizedAt,
    capabilities,
  };
  return ref === undefined ? claim : { ...claim, ref };
}

// ── LAYER 2: THE DECISION ───────────────────────────────────────────────────────────────────

export interface DecideLeaseInput {
  self: LeaseSelf;
  claims: readonly ClaimRecord[];
  now: Date;
  staleAfterMs?: number;
  /**
   * The press this install is acting on, or `null` when nobody has asked for it.
   *
   * Carrying the INSTANT rather than a flag is what lets rule 6 ask the only question that
   * matters between two pressed installs: whose press is newer. See {@link TakeoverAuthorization}.
   */
  takeover?: TakeoverAuthorization | null;
}

/**
 * A heartbeat in the FUTURE counts as fresh.
 *
 * Two machines, two wall clocks. A peer whose clock runs ahead is still alive, and the fail-safe
 * direction is to believe it — treating a skewed peer as stale is how both sides decide they are
 * the organizer.
 */
function isFresh(heartbeat: Date, now: Date, staleAfterMs: number): boolean {
  return now.getTime() - heartbeat.getTime() < staleAfterMs;
}

/**
 * Coalesce to one claim per install id, newest heartbeat wins.
 *
 * §3.3: renewing is append-then-expunge, because IMAP has no in-place update. A crash between
 * the two steps therefore leaves TWO of our own claims in the folder, and that is a state to
 * handle rather than to hope against. Readers coalesce; the writer cleans up the extras on its
 * next renew.
 */
function coalesce(claims: readonly ClaimRecord[]): { valid: OrganizerClaim[]; malformed: MalformedClaim[] } {
  const malformed: MalformedClaim[] = [];
  const newest = new Map<string, OrganizerClaim>();
  for (const c of claims) {
    if (isMalformed(c)) {
      malformed.push(c);
      continue;
    }
    const prior = newest.get(c.installId);
    // ── ORDER-INDEPENDENT, AND THE TIE-BREAK IS NOT COSMETIC ────────────────────────────────
    //
    // `>` alone left equal heartbeats resolved by INPUT ORDER, and IMAP does not promise one. Two
    // restored clones sharing an install id and renewing in the same millisecond therefore each
    // selected the record whose nonce happened to arrive first — which each then recognised as its
    // own, so both organized. Measured against the decision function with the two orderings.
    //
    // The nonce is a per-write random, so comparing it gives every reader the same answer from the
    // same set regardless of the order the server hands it over.
    if (!prior || compareRecency(c, prior) < 0) newest.set(c.installId, c);
  }
  return { valid: [...newest.values()], malformed };
}

/** Newest heartbeat first; equal heartbeats break on the nonce, so the result is order-free. */
function compareRecency(a: OrganizerClaim, b: OrganizerClaim): number {
  const d = b.heartbeat.getTime() - a.heartbeat.getTime();
  if (d !== 0) return d;
  return a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
}

/**
 * HOW FAR INTO THE FUTURE A PEER'S CLOCK IS BELIEVED.
 *
 * A heartbeat later than our own clock is normal and must be tolerated — two machines have two
 * clocks, and treating a slightly-ahead peer as gone is how both sides conclude they are the
 * organizer. But the tolerance has to have an END, and it did not: a claim dated 2099 by a machine
 * with a dead clock battery stayed "fresh" for seventy-three years, and no authorization could
 * take the mailbox back from it. Measured against the decision function, not inferred: a `cloud`
 * claim dated `2099-01-01` produced `stand_down` for an authorized local, indefinitely.
 *
 * One staleness window, so a peer may be believed up to twice the window ahead of reality and no
 * further. Beyond that the heartbeat is CLAMPED rather than rejected — the claim still counts as a
 * claim, it simply stops being able to look newer than now.
 */
export const MAX_FUTURE_SKEW_MS = DEFAULT_STALE_AFTER_MS;

/**
 * THE ELECTION. **A pure function of the folder's contents — never of the reader's clock.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE THAT MATTERS, AND THE FAMILY OF BUGS IT REPLACES
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The previous table asked "is this peer's claim fresh?" as `now(mine) - heartbeat(theirs) <
 * staleAfterMs`. That question mixes two clocks, and **two readers of the same folder could answer
 * it differently** — which is the whole bug family, because two readers that disagree about the
 * candidate set can each conclude they won.
 *
 * Three split-brains were reproduced by execution against the old function, and every one of them
 * is this single mistake:
 *
 *  · **A laptop that slept.** NO CLOCK SKEW REQUIRED, and this is the most reachable of the
 *    three. Install A sleeps past the window; B is active. B sees A as stale, so A is not in B's
 *    candidate set and B continues on its own claim. A wakes, sees B as fresh, and beats B on
 *    incumbency because A's `claimedAt` is older — so A organizes too. Both write, indefinitely.
 *  · **Five minutes of clock skew.** B's clock runs ahead, so A's claim reads as stale to B and
 *    the surface actively OFFERS a takeover. B takes it; A then reads B's future-dated claim as
 *    fresh (correctly) but wins incumbency, so A keeps organizing. No convergence: A is stale to B
 *    forever.
 *  · **Two clouds.** `freshCloud` was computed and then consulted only when `self.kind ===
 *    "local"`, so two cloud organizers each fell through to "I hold a fresh claim, therefore
 *    organize" for ever. The leader lock masks it in one deployment; the lease provided no
 *    protection at all, and the leader lock is not the lease.
 *
 * So freshness is redefined **relative to the folder**: the newest heartbeat present is the
 * reference, and a claim more than one window older than it has LAPSED. Every reader computes the
 * same reference from the same messages, so every reader computes the same candidate set and the
 * same winner. Agreement is now structural rather than probable.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHERE THE READER'S CLOCK IS STILL USED, AND WHY NEITHER USE IS THE ARBITER
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  1. **As a CEILING on a future heartbeat** ({@link MAX_FUTURE_SKEW_MS}). An upper bound cannot
 *     change the order of two honestly-clocked claims; it can only stop a broken clock from
 *     outranking everything for ever.
 *  2. **To decide whether the whole folder has gone QUIET** — `now - newest >= staleAfterMs`, which
 *     is what makes a mailbox OFFERABLE for takeover. This is single-sided and can only ever lead
 *     to a human being asked a question. Getting it wrong in the permissive direction produces an
 *     authorized takeover that displaces a live install, which is one organizer — the safe
 *     direction — and is exactly what an authorized takeover is defined to do.
 *
 * Nothing else. **A reader's clock can no longer decide who organizes a mailbox.**
 */
interface Election {
  /** Claims present in the folder, coalesced, with a clamped heartbeat. */
  candidates: readonly OrganizerClaim[];
  /** Not lapsed relative to the newest heartbeat in the folder. */
  live: readonly OrganizerClaim[];
  /** The strongest live candidate, or `null` when the folder holds no readable claim. */
  winner: OrganizerClaim | null;
  /**
   * Claims whose heartbeat is NOT implausibly far in the future, keyed by the object identity of
   * the clamped candidate.
   *
   * A claim dated 2099 by a machine with a dead clock battery is a claim, and it must still be
   * RANKED (or two readers would disagree about the candidate set and both organize — see
   * {@link runElection}). What it must not do is grant its writer the protections reserved for an
   * organizer that is demonstrably alive. So implausibility is tracked separately from the
   * election rather than by removing the claim from it.
   */
  plausible: ReadonlySet<OrganizerClaim>;
  /**
   * Claims whose PRESS is not implausibly far in the future — the same idea as {@link plausible},
   * one field over, and it exists because 0.14.1 moved the election onto a field the heartbeat's
   * ceiling does not cover.
   *
   * ── WHY THE CLAMP ALONE IS NOT ENOUGH HERE, AND IT IS FOR THE HEARTBEAT ────────────────────
   *
   * Measured, not reasoned: a claim stamped `2099-01-01` clamps to `now + MAX_FUTURE_SKEW_MS`, and
   * an honest press is made AT `now` — so the clamped value is always strictly greater and the
   * honest press can never win rule 6. The seventy-three-year lockout, reproduced on the field that
   * now decides the election. The heartbeat does not have this shape because liveness is a
   * comparison of DIFFERENCES against the newest claim in the folder, so a clamped outlier stops
   * being able to look newer than everything else; "is my press newer than theirs" is a comparison
   * against a value, and clamping only moves the value.
   *
   * So the clamp is kept (it bounds the RANKING, which every reader must compute identically) and
   * an implausible press additionally loses the one protection it must not have: the ability to
   * REFUSE a human's takeover. Rule 6's maximum is taken over this set.
   *
   * ── THE CLOCK DEPENDENCE IS THE ONE THE MODULE ALREADY ACCEPTS ─────────────────────────────
   *
   * This is the reader's own clock deciding something, which the header's rule confines to two
   * uses. It is the SECOND of them exactly: single-sided, and it can only ever let a human's
   * takeover displace a live install — one organizer, the safe direction, and precisely what an
   * authorized takeover is defined to do. It cannot make two readers both organize, because the
   * winner is displaced from the folder in the same gate and its own next read finds its claim gone.
   */
  plausiblePress: ReadonlySet<OrganizerClaim>;
  /** Nothing PLAUSIBLE in the folder has been renewed within one window of the READER's now. */
  quiet: boolean;
  /** Claims that announce themselves and cannot be read. Evidence, never nothing. */
  malformed: readonly MalformedClaim[];
}

/**
 * `min(t, now + MAX_FUTURE_SKEW_MS)` for BOTH instants a broken clock can inflate — the heartbeat
 * and the press. See {@link MAX_FUTURE_SKEW_MS}.
 *
 * The press needs the same ceiling as the heartbeat and for a sharper reason. `authorizedAt` is
 * now the FIRST term of the order, so an install whose clock reads 2099 would write a press that
 * outranks every honest one for seventy-three years — the exact seventy-three-year failure the
 * heartbeat ceiling exists to end, moved to the field that decides the election rather than the
 * field that decides liveness. Clamped rather than rejected, on the same argument: a press with a
 * silly clock is still a press, it simply stops being able to look newer than now.
 */
function clampFuture(c: OrganizerClaim, now: Date): OrganizerClaim {
  const ceiling = now.getTime() + MAX_FUTURE_SKEW_MS;
  const hbOver = c.heartbeat.getTime() > ceiling;
  const azOver = c.authorizedAt !== null && c.authorizedAt.getTime() > ceiling;
  if (!hbOver && !azOver) return c;
  return {
    ...c,
    ...(hbOver ? { heartbeat: new Date(ceiling) } : {}),
    ...(azOver ? { authorizedAt: new Date(ceiling) } : {}),
  };
}

/**
 * Strongest first.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A PRESS RANKS. KIND DOES NOT. (0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The first term used to be `kind`: `cloud` outranked `local`, on the older reading of the
 * dual-mode rule that "a fresh cloud lease outranks local for CONTINUING coverage". **That term is
 * deleted**, and with it rule 5, whose whole content was refusing an authorized local install over
 * a live cloud one.
 *
 * The case it was wrong about is the ordinary one rather than an exotic one: somebody loses access
 * to the machine their hosted organizer runs on — a VPS they can no longer reach, a subscription
 * on an address they cannot log into — and wants the mailbox organized from the laptop in front of
 * them. Under the kind rule there was no path. The honest action offered was to give the mailbox
 * up on the side they had just lost access to, which is the side that cannot act. A rule whose
 * remedy requires the party that has disappeared is not a rule about continuation; it is a lockout.
 *
 * What replaces it says the same thing the kind rule was reaching for, without the asymmetry:
 * **liveness is not authority, and an explicit press outranks both.** Presence in the folder still
 * protects an incumbent against anything that merely ARRIVES — an install with no press ranks
 * below an incumbent with none, on `claimedAt` — so nobody self-promotes. What presence no longer
 * does is outrank a human who deliberately asked for a different machine.
 *
 * The order, and each term is load-bearing:
 *
 *  1. **The PRESS, newest first**, clamped by {@link clampFuture} so a dead clock battery cannot
 *     mint an unbeatable authorization. `null` — nobody pressed for this tenure — ranks LOWEST,
 *     which is what makes an ordinary renewal lose to any press at all and is the whole mechanism
 *     of a takeover.
 *  2. **Then INCUMBENCY**: the oldest `claimedAt`. Unchanged, and it is what decides between two
 *     unpressed claims (the common steady state) and between two claims pressed in the same
 *     millisecond. Nobody self-promotes by arriving.
 *  3. **Then `installId`, then `nonce`** — a TOTAL order, so no two readers can break a tie
 *     differently. The nonce is what closes the restored-clone case, where two live processes
 *     share an install id AND a `claimedAt`: `compareIncumbency` returned 0, `Array.sort` is not
 *     required to be stable across differing input orders, and two clones reading the same folder
 *     in different orders each elected themselves. Measured, not theorised.
 *
 * `kind` survives on the claim and is still read — `reasonFor` composes the stand-down reason from
 * it and every banner names it — it simply no longer decides anything.
 *
 * ── THE CROSS-VERSION CASE, STATED RATHER THAN DISCOVERED ─────────────────────────────────────
 *
 * An install one release older runs this function without term 1, so it ranks by incumbency alone.
 * Two builds therefore CAN elect differently off one folder for one cycle — and the outcome is
 * bounded and safe in the direction that matters: the older install's own rule 5 still refuses it
 * a live cloud claim, and where it does win, it wins by being the incumbent, which is a claim that
 * is already in the folder. The convergence cases are enumerated as decide-table tests rather than
 * argued here.
 */
function compareStrength(a: OrganizerClaim, b: OrganizerClaim): number {
  // Newest press first, and a claim with no press is `-Infinity` — below every real instant, and
  // below another unpressed claim only by the terms after this one.
  const press = (c: OrganizerClaim): number => c.authorizedAt?.getTime() ?? -Infinity;
  const byPress = press(b) - press(a);
  // `-Infinity - -Infinity` is NaN, and `NaN !== 0` is TRUE — so an unguarded subtraction here
  // would return NaN for the ordinary two-unpressed-claims case, which `Array.sort` treats as
  // "leave them where they are" and which is exactly the order-dependent tie the total order below
  // exists to make impossible. Both-null is the steady state of every mailbox nobody has pressed
  // on, so this is the common path rather than an edge.
  if (byPress !== 0 && !Number.isNaN(byPress)) return byPress;
  const byClaimed = a.claimedAt.getTime() - b.claimedAt.getTime();
  if (byClaimed !== 0) return byClaimed;
  if (a.installId !== b.installId) return a.installId < b.installId ? -1 : 1;
  return a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
}

function runElection(claims: readonly ClaimRecord[], now: Date, staleAfterMs: number): Election {
  const { valid, malformed } = coalesce(claims);
  const ceiling = now.getTime() + MAX_FUTURE_SKEW_MS;
  const plausible = new Set<OrganizerClaim>();
  const plausiblePress = new Set<OrganizerClaim>();
  const candidates = valid.map((raw) => {
    const c = clampFuture(raw, now);
    if (raw.heartbeat.getTime() <= ceiling) plausible.add(c);
    // A claim with NO press is plausible about its press by construction: there is nothing to
    // disbelieve. Only a stamp beyond the ceiling is excluded — see `Election.plausiblePress`.
    if (raw.authorizedAt === null || raw.authorizedAt.getTime() <= ceiling) plausiblePress.add(c);
    return c;
  });

  // THE REFERENCE IS IN THE FOLDER, not on this machine. Clamped, so a broken clock cannot lapse
  // every honest claim in the folder by more than one window.
  const newest = candidates.reduce<number>((m, c) => Math.max(m, c.heartbeat.getTime()), -Infinity);
  const live = candidates.filter((c) => newest - c.heartbeat.getTime() < staleAfterMs);
  const winner = [...live].sort(compareStrength)[0] ?? null;

  // The one place the reader's clock decides anything, and it decides only whether to ASK a human.
  // Computed over PLAUSIBLE heartbeats only: a folder holding nothing but a claim dated 2099 has
  // gone quiet, and reading it as busy is what let one dead machine hold a mailbox for seventy-three
  // years with no way out short of a person deleting the message by hand.
  const newestPlausible = candidates
    .filter((c) => plausible.has(c))
    .reduce<number>((m, c) => Math.max(m, c.heartbeat.getTime()), -Infinity);
  const quiet = !Number.isFinite(newestPlausible) || now.getTime() - newestPlausible >= staleAfterMs;

  return { candidates, live, winner, plausible, plausiblePress, quiet, malformed };
}

/**
 * WHO MAY ORGANIZE THIS MAILBOX. Pure — no clock of its own, no IO, no side effects.
 *
 * The order below is the order of the reasons, and each traces to a ruling rather than a
 * preference:
 *
 *  1. **A live claim in a protocol we do not understand ⇒ stand down.** Never "unparseable, so
 *     ignore": a future format that older installs skipped would silently re-enable dual
 *     organizing against every one of them. No authorization overrides this — we cannot rank what
 *     we cannot read.
 *  2. **A live claim of an unrecognised KIND ⇒ stand down.** Same reasoning. The one thing we know
 *     is that something is organizing this mailbox and we cannot place it.
 *  3. **We hold the strongest live claim ⇒ organize.** This is continuation, and it covers
 *     own-role resumption after a crash, a restore or a long sleep: if the folder holds only our
 *     own claims, however old, we are the newest thing in it and we win. §4: "Continuing is not
 *     becoming."
 *  4. **The folder holds no readable claim at all ⇒ organize.** Nobody has ever organized this
 *     mailbox, so there is nobody to take over from. A transient double-append here is the
 *     designed handover window, and {@link runLeaseGate}'s append-then-verify is what bounds it to
 *     the cycle in which it happens.
 *  5. **DELETED IN 0.14.1, and the deletion is the release.** It read: *"we lost, and the winner
 *     is a LIVE claim of a kind that outranks ours ⇒ stand down, even with authorization"*, on the
 *     older reading that a local install has no path over a live Cloud and that the honest action
 *     is to give the mailbox up on the Cloud side. That remedy requires the side the person has
 *     just lost access to, which is exactly the population it stranded: a VPS nobody can reach any
 *     more, a hosted organizer on an address its owner cannot log into. The asymmetry was recorded
 *     here as deliberate, and it was — it is now ruled wrong. Kind no longer ranks anywhere; see
 *     {@link compareStrength}. The numbering is kept so that the rules below keep the names every
 *     test, log line and neighbouring comment uses for them.
 *  6. **We lost, and a human pressed for THIS install more recently than for any live rival ⇒
 *     organize, and DISPLACE what we beat.** STRICT: an equal instant is not newer, and breaks on
 *     `installId` like every other tie. A press that is NOT newer is STALE — it falls through to
 *     7/8 and the caller voids it there, which is the whole replay protection and is the reason
 *     there is deliberately no "the stamp is older than the holder's claimedAt" check: that check
 *     breaks the two-press race, where the second presser's stamp is legitimately older than the
 *     first presser's tenure.
 *     The displacement is what records the handover in the shared medium; see {@link OrganizeVerdict}.
 *  7. **We lost, and the folder is still being renewed ⇒ stand down.** Somebody is organizing it.
 *  8. **We lost, and the folder has gone quiet ⇒ `available`.** Somebody WAS organizing and
 *     nothing has renewed since. Offerable, never taken: BECOMING an organizer always requires an
 *     explicit human action, including for Cloud.
 */
export function decideLease(input: DecideLeaseInput): LeaseVerdict {
  const { self, now } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const takeover = input.takeover ?? null;
  const ourProtocol = self.protocol ?? CLAIM_PROTOCOL;

  const election = runElection(input.claims, now, staleAfterMs);

  /**
   * Is this claim OURS? The clone defence, unchanged in substance.
   *
   * A claim bearing our install id whose nonce is not the one we wrote, and which is live, is
   * somebody else running a restored copy of us. `lastNonce` is memory-only, so a fresh process
   * trusts its own id exactly once — which is what keeps own-role resumption working after a
   * crash. The residual case of two clones starting simultaneously (both with a null nonce) is now
   * caught one cycle later by `compareStrength`'s total order, where it used to be a coin toss.
   */
  const isOurs = (c: OrganizerClaim): boolean => {
    if (c.installId !== self.installId) return false;
    const clonedUs =
      self.lastNonce !== null &&
      c.nonce !== self.lastNonce &&
      election.live.includes(c);
    return !clonedUs;
  };

  // Folder-relative liveness for a RAW record, exactly as `runElection` computes it for the
  // coalesced candidates: clamped against implausible future skew, measured from the newest
  // heartbeat present. Needed below because coalesce keeps ONE record per install — and both
  // rule 1/2 and an authorized displacement have to see the records coalesce dropped.
  const newestHeartbeat = election.candidates
    .reduce<number>((m, c) => Math.max(m, c.heartbeat.getTime()), -Infinity);
  const rawIsLive = (c: OrganizerClaim): boolean => {
    const clamped = Math.min(c.heartbeat.getTime(), now.getTime() + MAX_FUTURE_SKEW_MS);
    return newestHeartbeat - clamped < staleAfterMs;
  };
  /** Unambiguously this process's current claim, by VALUE — the raw list's `isOurs`. */
  const rawOurs = (c: OrganizerClaim): boolean =>
    c.installId === self.installId && (self.lastNonce === null || c.nonce === self.lastNonce);

  // 1 / 2 — a live peer we cannot rank. Checked first, no authorization overrides them, and
  // checked over the RAW list: coalesce keeps the newest record per install, so an unrankable
  // OLDER record hidden behind a rankable newer sibling would otherwise never trip this arm —
  // and every downstream consumer of this verdict (the takeover's displacement above all)
  // would treat a live claim in a format we cannot read as beatable residue.
  const unrankable = input.claims.find((c): c is OrganizerClaim =>
    !isMalformed(c) && !rawOurs(c) && (c.protocol > ourProtocol || c.kind === "unknown") && rawIsLive(c));
  if (unrankable) return { verdict: "stand_down", reason: "organized_elsewhere:unknown", by: unrankable };

  const { winner } = election;

  // 3 — we hold the strongest live claim. Continuation.
  if (winner && isOurs(winner)) return { verdict: "organize", renew: true, displace: [], authorized: false };

  // 4 — an EMPTY folder. Nobody has ever organized this mailbox, so there is nobody to take over
  // from. Emptiness is the whole condition, and "no winner" is deliberately not the test: a folder
  // that holds only unreadable claims, or only a claim dated 2099, has evidence in it and belongs
  // to the arms below.
  if (election.candidates.length === 0 && election.malformed.length === 0) {
    /* ── AND IT STAMPS THE PRESS WHEN THERE IS ONE, WHICH IS NOT OBVIOUS ──────────────────────
     *
     * There is nothing to DISPLACE here — an empty folder has no handover to record — so the
     * tempting answer is `authorized: false`, and it was, for exactly as long as it took to write
     * down what the caller does next: it SPENDS the row's stamp on this win. That pair is an
     * inversion, and the sequence is ordinary rather than exotic:
     *
     *   FIRST   somebody presses "Organize here" on a laptop that is asleep. The stamp sits on its
     *           row, unspent — no gate has run.
     *   SECOND  they change their mind and press on Cloud. `ohmail/_meta` is empty (nobody has ever
     *           organized this mailbox, or the last organizer released cleanly), so Cloud takes
     *           arm 4. An unstamped claim means Cloud's tenure ranks at minus infinity.
     *   THIRD   the laptop wakes, offers its earlier press against Cloud's unpressed claim, and
     *           wins rule 6.
     *
     * The OLDER decision reverses the newer one, and both installs agree it should — which is the
     * one failure mode ranking by the press exists to make impossible.
     *
     * So the flag says what the FIELD says: this tenure rests on that press. It is false on rule 3
     * because a continuation rests on the prior tenure (whose stamp is carried forward), and false
     * here when nobody pressed, which is the common arm-4 case — a consented organizer meeting an
     * empty folder.
     */
    return { verdict: "organize", renew: true, displace: [], authorized: takeover !== null };
  }

  /* -- 5 IS GONE (0.14.1). The paragraph that stood here is preserved in the header's rule 5,
   * because the argument it made was not careless — it was a considered asymmetry, and it is the
   * asymmetry that is now ruled wrong. Nothing takes its place: with `kind` out of
   * `compareStrength`, a live cloud claim and a live local claim are ranked by the same two
   * questions as any other pair, and the press is the first of them.
   *
   * What is NOT lost with it: `election.quiet` and `election.plausible`, which rule 5 also
   * consulted, are still computed and still used — `quiet` decides arm 8 (offerable vs held) and
   * `plausible` keeps a 2099 claim from being treated as a live organizer. Only the kind
   * comparison is deleted. */

  // 6 — a human asked for this mailbox MORE RECENTLY than for anything alive in it. Take it, and
  // record the handover in the folder.
  //
  // ── STRICTLY NEWER THAN THE LIVE MAXIMUM, AND THAT COMPARISON IS THE REPLAY PROTECTION ─────
  //
  // A stamp is a one-shot on the row, spent by the gate that succeeds — but the row and the folder
  // are two stores, and the case this arm has to survive is the one where they disagree: a press
  // that already won, was already recorded in `ohmail/_meta` as this install's tenure, and is then
  // offered again by a caller that failed to void it. Ranking it against the LIVE MAXIMUM answers
  // that without needing to know anything about the row: our own winning claim carries that very
  // instant, so `>` is false against ourselves and the replay decides nothing.
  //
  // STRICT, so an equal instant is not a win. Two presses recorded in the same millisecond break on
  // `installId` inside `compareStrength` instead, which every reader of the folder computes the
  // same way — as opposed to `>=`, under which BOTH installs would displace each other's claim in
  // the same cycle and the mailbox would end with no claim at all.
  //
  // AND DELIBERATELY NOT "the stamp must be newer than the holder's `claimedAt`". That check reads
  // as an obvious tightening and it breaks the two-press race, which is the ordinary case rather
  // than an exotic one: A presses and wins, B presses eight seconds later, and B's stamp is older
  // than A's tenure by construction because A's tenure began when A won. Under that check B — the
  // person's LATER decision — could never take the mailbox.
  //
  // OVER THE LIVE **AND PLAUSIBLY-PRESSED** CLAIMS. The second filter is what keeps this arm from
  // reproducing the seventy-three-year lockout on the field the election now turns on: a stamp
  // dated 2099 clamps to `now + MAX_FUTURE_SKEW_MS`, which is strictly greater than any press a
  // human can make at `now`, so without it one machine with a dead clock battery could refuse every
  // takeover for ever and the only cure would be a person deleting the bookkeeping message by hand.
  // See `Election.plausiblePress` for why the clamp alone answers this for the heartbeat and not
  // for the press. Such a claim is still RANKED — `compareStrength` sees its clamped value, so no
  // two readers disagree about the winner — it simply loses the power to veto a human.
  const livePress = election.live
    .filter((c) => election.plausiblePress.has(c))
    .reduce<number>((m, c) => Math.max(m, c.authorizedAt?.getTime() ?? -Infinity), -Infinity);
  const ourPress = takeover === null
    ? -Infinity
    // Clamped exactly as a claim's own stamp is, and for the same reason: a machine whose clock
    // reads 2099 must not be able to press its way past every honest organizer for ever. The row
    // is not a more trustworthy clock than the folder — it is the SAME machine's clock.
    : Math.min(takeover.authorizedAt.getTime(), now.getTime() + MAX_FUTURE_SKEW_MS);
  if (takeover !== null && ourPress > livePress) {
    // EVERY ref the read held for the beaten organizers — the RAW claim list, deliberately not
    // the election's candidates: coalesce keeps one claim per install, but the folder
    // legitimately holds duplicates (append-then-expunge's own crash residue), and a
    // displacement built from the coalesced set misses the residue copy — which then wins the
    // gate's verify on incumbency, and the authorized takeover loses to a message the incumbent
    // itself was going to clean up. Malformed claims displace too.
    //
    // "Ours" is decided here by VALUE — install id plus nonce — never through `isOurs`, whose
    // clone defence keys on the election's own object identity (`election.live.includes`), which
    // a raw record that coalesce dropped or clampHeartbeat copied can never satisfy. Kept out of
    // the displacement is exactly the claim that is unambiguously this process's current one
    // (and, on a fresh start with no armed nonce, anything bearing our id — own-role resumption
    // must not displace its own history). A same-id claim with a DIFFERENT nonce while ours is
    // armed is a restored clone's, and it is displaced like any other beaten organizer.
    //
    // AND RULES 1/2 HOLD OVER THE RAW LIST TOO — rule 1's own raw scan above already refused a
    // takeover while a LIVE unrankable record stands, so this arm is unreachable for one today;
    // the exclusion stays as the belt to that braces, because an authorized expunge of a record
    // we cannot read must be impossible by construction, not by the ordering of two checks. A
    // STALE unrankable record is residue and displaces normally.
    const displaced = input.claims
      .filter((c) => (isMalformed(c)
        ? true
        : !(c.installId === self.installId && (self.lastNonce === null || c.nonce === self.lastNonce))
          && !((c.protocol > ourProtocol || c.kind === "unknown") && rawIsLive(c))))
      .map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined);
    return { verdict: "organize", renew: true, displace: displaced, authorized: true };
  }

  // 7 / 8 — we lost. Whether it is offerable is the only thing left to say.
  //
  // A STALE PRESS ARRIVES HERE, and that is where it is meant to arrive. It is not an error and it
  // gets no arm of its own: the caller's stand-down path already voids the stamp it just offered,
  // so the request is consumed by the pass that considered and refused it rather than left on the
  // row to be re-offered every cycle against an organizer it can never beat.
  if (!election.quiet && winner !== null) {
    return { verdict: "stand_down", reason: reasonFor(winner), by: winner };
  }
  return { verdict: "available", by: winner };
}

/** The winning claim's kind, as the closed reason set spells it. */
function reasonFor(c: OrganizerClaim): StandDownReason {
  return c.kind === "cloud" ? "organized_elsewhere:cloud"
    : c.kind === "local" ? "organized_elsewhere:local"
      : "organized_elsewhere:unknown";
}



// ── LAYER 2b: LOOKING WITHOUT DECIDING ──────────────────────────────────────────────────────

/**
 * WHO HOLDS THIS MAILBOX, REPORTED RATHER THAN RULED ON.
 *
 * ── WHY THIS IS NOT `decideLease` WITH THE WRITES TURNED OFF ────────────────────────────────
 *
 * A caller that wants to SHOW a person who is organizing their mailbox — before asking them
 * whether to take it over — needs a different thing from what the gate produces. The gate answers
 * "may *I* organize?", and to answer it needs an identity: {@link LeaseSelf}, with an install id
 * and a nonce. A surface that merely reports has no such identity, and giving it a fabricated one
 * is how a read becomes a write. Two concrete failures, both reachable from one fabricated id:
 *
 *  · Against an EMPTY `ohmail/_meta`, arm 7 answers `organize`, and {@link runLeaseGate} then
 *    APPENDS a claim. A preview would have made the previewer the organizer, and every other
 *    install would stand down for the whole staleness window on the strength of somebody opening
 *    a settings pane.
 *  · Against a live claim carrying the same id, {@link runLeaseGate}'s renew expunges the older
 *    claims matching that id — so a preview sharing the worker's id can delete the worker's own
 *    fresh claim out from under it.
 *
 * So this layer takes no `self`, returns no verdict, and cannot write: {@link LeasePeekIo} has
 * exactly one method and it is a read. The confirm step that follows a preview does not consult
 * this result — it stamps an authorization, and the GATE decides, later, in the process that is
 * actually going to do the organizing. A preview that decided would be a second decision site,
 * and §3.4's "exactly one path to stand-down" is the same argument in the other direction.
 */
export interface LeaseHolder {
  kind: OrganizerKind | "unknown";
  /** `X-Ohmail-Display-Name` — the machine, for a human. May be empty. */
  displayName: string;
  /** Last renew, by the WRITER's clock. */
  heartbeat: Date;
  /** When this organizer became the organizer, as distinct from last seen. */
  claimedAt: Date;
  /** Still being renewed, judged against the same window the gate judges against. */
  fresh: boolean;
  /**
   * WHAT THIS HOLDER OFFERS A READER, off its claim (0.14.1). Empty means none, which is the true
   * answer for every install older than this field rather than a gap in the read.
   *
   * It is on the PREVIEW and not only in the gate because the surface that needs it is a reader's,
   * and a reader never runs the gate. Without it a reader would have to choose between offering a
   * decision to an organizer that will never look at it and refusing every organizer on principle.
   */
  capabilities: readonly string[];
}

/**
 * `none` — nobody has ever organized this mailbox.
 * `held` — at least one claim is still being renewed.
 * `stopped` — somebody WAS organizing and is not now.
 *
 * The three map exactly onto the gate's three verdicts for a FOREIGN claim (`organize` on an
 * empty folder, `stand_down`, `available`), which is what makes a preview and the gate that runs
 * afterwards agree about the world rather than merely tend to.
 */
export type LeaseOccupancy = "none" | "held" | "stopped";

export interface LeasePeek {
  state: LeaseOccupancy;
  /** Freshest first. One entry per install id, the same coalescing the gate does. */
  holders: LeaseHolder[];
  /**
   * Claims that say they are claims and are not readable as one.
   *
   * Counted rather than dropped, for {@link MalformedClaim}'s reason: evidence that somebody
   * claimed is not nothing. A folder holding only unreadable claims is `stopped`, never `none` —
   * reporting "nobody has ever organized this" about a mailbox with a claim in it is the
   * dual-organizer bug wearing a UI.
   */
  unreadable: number;
}

export interface PeekLeaseInput {
  claims: readonly ClaimRecord[];
  now: Date;
  staleAfterMs?: number;
}

/** Pure. No IO, no identity, no side effects — the whole table is unit-testable. */
export function peekLease(input: PeekLeaseInput): LeasePeek {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const { valid, malformed } = coalesce(input.claims);

  /**
   * ── THE PREVIEW SEES WHAT THE GATE SEES, RAW DUPLICATES INCLUDED ──────────────────────────
   *
   * `decideLease`'s rule 1/2 scans the RAW list: a fresh record in a format this build cannot
   * rank — a higher protocol, an unrecognised kind — refuses even an authorized takeover, and
   * coalescing keeps only the newest record per install, so such a record can hide behind a
   * rankable sibling. A preview built from the coalesced list alone would then show an ordinary
   * holder and offer a takeover the gate is going to refuse for ever — a button that no-ops, on
   * exactly the surface that exists to tell a person the truth about who holds their mailbox.
   * So an install with a fresh unrankable record among its raw duplicates is REPORTED as
   * `unknown` and fresh, which is the same sentence the gate's `organized_elsewhere:unknown`
   * verdict would write.
   */
  // Liveness for the unrankable scan is FOLDER-RELATIVE and clamped, exactly as the gate
  // computes it — the preview's per-holder `fresh` keeps its reader-clock idiom, but this set
  // must agree with `decideLease`'s refusal or the two answer differently about the same folder
  // (a record the gate reads as live-unknown reported here as an ordinary stopped holder, with
  // a takeover on offer that every authorized gate then refuses).
  const rawValid = input.claims.filter((c): c is OrganizerClaim => !isMalformed(c));
  const ceiling = input.now.getTime() + MAX_FUTURE_SKEW_MS;
  const clampedHb = (c: OrganizerClaim): number => Math.min(c.heartbeat.getTime(), ceiling);
  const newestHeartbeat = rawValid.reduce<number>((m, c) => Math.max(m, clampedHb(c)), -Infinity);
  const unrankableInstalls = new Set(
    rawValid
      .filter((c) => (c.protocol > CLAIM_PROTOCOL || c.kind === "unknown")
        && newestHeartbeat - clampedHb(c) < staleAfterMs)
      .map((c) => c.installId),
  );

  const holders: LeaseHolder[] = valid
    .map((c) => ({
      kind: unrankableInstalls.has(c.installId) ? ("unknown" as const) : c.kind,
      displayName: c.displayName,
      heartbeat: c.heartbeat,
      claimedAt: c.claimedAt,
      fresh: isFresh(c.heartbeat, input.now, staleAfterMs) || unrankableInstalls.has(c.installId),
      /* Reported for the holder the coalesce KEPT — the newest claim per install — because that is
         the build currently running there. An older duplicate advertising less is residue of a
         renew this same install is about to expunge, and reporting the weaker set would tell a
         reader its live organizer had gone backwards. */
      capabilities: c.capabilities,
    }))
    .sort((a, b) => b.heartbeat.getTime() - a.heartbeat.getTime());

  const state: LeaseOccupancy =
    holders.some((h) => h.fresh) ? "held"
      : holders.length > 0 || malformed.length > 0 ? "stopped"
        : "none";

  return { state, holders, unreadable: malformed.length };
}

/**
 * The read-only half of {@link LeaseIo}, and the narrowness is the enforcement.
 *
 * It is a separate interface rather than `Pick<LeaseIo, "listClaims">` so that a caller cannot
 * pass a full {@link LeaseIo} where this is expected and quietly regain APPEND: structurally
 * `LeaseIo` DOES satisfy this type, so the guard cannot live in the type system alone — it lives
 * in {@link makeLeasePeekIo}, whose returned object has no other method to reach for, and in the
 * adapter accessor that hands one out.
 */
export interface LeasePeekIo {
  listClaims(): Promise<RawClaimMessage[]>;
}

/**
 * A {@link LeasePeekIo} bound to a live connection. LIST, SELECT, FETCH. Nothing else.
 *
 * **It does not create `ohmail/_meta`.** {@link makeLeaseIo} does, because an organizer that is
 * about to write a claim needs somewhere to write it. A reader does not, and creating a folder in
 * somebody's mailbox to answer a question about it is a side effect no read should have — it also
 * changes the answer for the next reader, from "no folder" to "empty folder". An absent folder is
 * reported as zero claims, which is the truth: nobody has ever organized this mailbox.
 *
 * It finds the folder through {@link makeMetaFolderRef}, the same resolution {@link makeLeaseIo}
 * writes through. That sharing is the fix for the defect described there: this read used to
 * compare LIST paths against `toServerPath(META_FOLDER)` for EQUALITY, so on every server with a
 * personal-namespace prefix it reported "nobody organizes this mailbox" while the claim sat one
 * prefix away, renewing.
 */
export function makeLeasePeekIo(client: LeaseImapClient, toServerPath: (canonical: string) => string): LeasePeekIo {
  const meta = makeMetaFolderRef(client, toServerPath);
  return {
    async listClaims(): Promise<RawClaimMessage[]> {
      const at = await meta.locate();
      // An ABSENT folder is zero claims — the truth, and the semantics this object's docblock
      // promises. A folder that could not be RESOLVED is a throw, which `readLeasePeek` turns
      // into `LeaseUnavailableError`: "I could not look" and "nobody holds it" must stay
      // unreachable from one another.
      if (at.row === null) return [];

      const lock = await client.getMailboxLock(at.path);
      try {
        // The shared bounded read — see {@link readMetaFolderWindow}. A folder too full to read in
        // one window is reported as a read that FAILED, which {@link readLeasePeek} turns into
        // {@link LeaseUnavailableError}: this surface exists to tell a person who holds their
        // mailbox, and "I could not see all of it" must render as unknown rather than as nobody.
        const read = await readMetaFolderWindow(client, at.path);
        if (!read.truncated) return read.records;
        /* ── A FULL FOLDER MUST NOT RENDER AS "NOBODY HOLDS THIS MAILBOX" ────────────────────
         *
         * This surface exists to tell a person WHO organizes their mailbox, so the claims are asked
         * for by header exactly as the election asks for them — the answer is complete for claims
         * and independent of position, and the person is shown the real holder instead of an
         * apology. Read-only: SEARCH and FETCH, never an APPEND.
         *
         * The refusal survives for the case where the server cannot be asked, because "I could not
         * see all of it" must still render as unknown rather than as nobody. */
        const claims = await searchHeaders(client, { header: { [H.lease]: true } });
        if (claims !== null) return claims;
        throw new MetaFolderTruncatedError(read.records.length, read.total, read.records);
      } finally {
        lock.release();
      }
    },
  };
}

export interface ReadLeasePeekInput {
  io: LeasePeekIo;
  now: Date;
  staleAfterMs?: number;
  /**
   * Optional, because it reports rather than guards: a peek with no logger answers exactly as it
   * did before. What it carries is the one fault here that does not clear on its own — see the
   * call below.
   */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * READ `ohmail/_meta` AND SAY WHO IS IN IT.
 *
 * An IO failure is {@link LeaseUnavailableError}, exactly as it is for the gate, and for §3.4's
 * reason restated as copy: "could not look" must never render as "nobody holds it". A surface
 * that showed an empty organizer panel because a FETCH timed out would invite a takeover of a
 * mailbox somebody is actively organizing.
 */
export async function readLeasePeek(input: ReadLeasePeekInput): Promise<LeasePeek> {
  let messages: RawClaimMessage[];
  try {
    messages = await input.io.listClaims();
  } catch (err) {
    /* A FULL FOLDER GETS ITS OWN LINE HERE TOO, and not only its own sentence.
     *
     * The counts survive into the message for {@link MetaFolderTruncatedError}'s own reason: of
     * everything that lands here, a folder too full to read is the only one that does not clear on
     * its own, and folding it into the generic wording sends whoever reads it to the mail server
     * for a fault that is a full folder.
     *
     * But a thrown message reaches somebody only if the caller renders it, and this refusal is
     * usually rendered as "we could not check" — a sentence a person reads as a blip. The gate emits
     * `lease_meta_truncated` on the same condition; the peek was silent, so the same mailbox
     * reported the fault from one door and not from the other. Same event name, same fields,
     * because it is the same fact. */
    if (err instanceof MetaFolderTruncatedError) {
      input.log?.("lease_meta_truncated", { read: err.read, limit: err.limit, total: err.total });
    }
    throw new LeaseUnavailableError(
      err instanceof MetaFolderTruncatedError
        ? err.message
        : `the organizer lease in ${META_FOLDER} could not be read`,
      { op: "list_claims", cause: err },
    );
  }
  const claims = messages
    .map((m) => parseClaim(m.raw, m.ref))
    .filter((c): c is ClaimRecord => c !== null);
  return peekLease({
    claims,
    now: input.now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
  });
}

// ── LAYER 3: IO ─────────────────────────────────────────────────────────────────────────────

/**
 * A LEASE IO FAILURE IS A MAILBOX FAULT, NEVER A STAND-DOWN.
 *
 * §3.4: a mailbox whose `_meta` cannot be read is a mailbox we cannot safely organize, and
 * reading that as "no claim, so organize" is the dual-organizer bug through the back door.
 * Reading it as "stand down" would be almost as wrong in the other direction: stand-down is
 * sticky caller-side, so a transient network error would permanently disable a mailbox nobody
 * else wants.
 *
 * So it is its own class, and callers exempt it BY CLASS — the pattern the worker's sync loop
 * already uses for `ClassifierFaultError`, where exempting by class
 * rather than by threshold arithmetic is what keeps "a model outage can never quarantine a
 * mailbox" true at every tuning of `maxSyncFailures`.
 */
/**
 * WHICH LEASE OPERATION FAILED. A closed set of literals, chosen at COMPILE TIME.
 *
 * ── THE GENERAL RULE THIS EXISTS TO STATE ──────────────────────────────────────────────────
 *
 * **A catch that wraps more than one operation must name which one threw.** `runLeaseGate` used to
 * wrap `ensureMetaFolder()` and `listClaims()` in ONE try and report neither, and that once
 * cost half an hour of diagnosis: "the organizer lease could not be read" is the same sentence whether the
 * folder could not be CREATED (a permissions or namespace problem — our path is wrong) or could not
 * be LISTED (the folder exists and the FETCH was refused — which is what actually happened, a
 * `FETCH 1:*` against an empty mailbox that Dovecot rejects and GreenMail tolerates). One literal
 * collapses that ambiguity to one line.
 *
 * ── AND WHY IT COSTS NOTHING TO LOG ────────────────────────────────────────────────────────
 *
 * Every member is a string WE wrote in THIS file. No server, no mailbox and no user chooses it,
 * so it carries exactly zero privacy cost — which is what makes it emittable where the thing an
 * operator actually wants (`err.message`, `responseText`) is not. The same rule governs
 * `serverResponseCode` in the worker's mailbox-error classifier: a value the server chose is a
 * value the server chose, whatever grammar it happens to satisfy.
 */
export type LeaseOp =
  /** CREATE + UNSUBSCRIBE `ohmail/_meta`. */
  | "ensure_meta"
  /** FETCH the claim messages out of it. */
  | "list_claims"
  /** APPEND our renewed claim. */
  | "renew_claim"
  /** STORE `\Deleted` + EXPUNGE our older claims. */
  | "remove_claims"
  /** The adapter has no `leaseIo()` at all, so no operation was even attempted. */
  | "no_lease_io"
  /**
   * The adapter has no `leasePeekIo()` — the READ-ONLY accessor — so a caller that only wanted to
   * LOOK could not, and no operation was attempted.
   *
   * Distinct from {@link no_lease_io} and added 2026-09-01 rather than folded into it, because the
   * two send an operator to different missing methods and an adapter can genuinely have one and not
   * the other. It was folded in briefly, and a review round caught the telemetry lying about which
   * capability was absent — which is the whole reason this union is a closed set of literals rather
   * than a free string.
   */
  | "no_lease_peek_io"
  /* The folder is over the ceiling AND the claim set could not be read, or itself exceeds it.
   * Same CLASS as every other lease IO fault on purpose: the hosts' exemptions and the LOCAL/Cloud
   * exclusions are all by class, so a new class would fall into `maxSyncFailures` and quarantine a
   * customer's mailbox over a folder that is not its fault. */
  | "meta_folder_full"
  /** STORE `\Deleted` + EXPUNGE the acknowledgements past their life — see {@link RequestOp}. */
  | "sweep_acks";

export class LeaseUnavailableError extends Error {
  /**
   * Which operation threw. REQUIRED, so a construction site cannot forget it — the alternative
   * (an optional field) is a field that is absent at the one call site nobody thought about, which
   * is the call site that fires during the incident.
   */
  readonly op: LeaseOp;
  constructor(message: string, options: { op: LeaseOp; cause?: unknown }) {
    super(message, options);
    this.name = "LeaseUnavailableError";
    this.op = options.op;
  }
}

/** One message in the meta folder, as the IO layer sees it. */
export interface RawClaimMessage {
  /** Whatever the implementation needs to delete this exact message. */
  ref: unknown;
  /** The headers (a full source is fine too — only the header block is read). */
  raw: string;
}

/**
 * The narrow IO the lease needs, and nothing else.
 *
 * None of these operations is on `MailboxAdapter` — the lease needs APPEND, SEARCH,
 * FETCH-headers, STORE `\Deleted` + EXPUNGE, CREATE and UNSUBSCRIBE, and that interface has none
 * of them. Rather than widening the adapter surface every caller sees, `ImapAdapter.leaseIo()`
 * hands back this object bound to the LIVE login. A lease that opened its own connection would
 * mean a second login per mailbox per cycle, which is how a provider decides to throttle a user.
 */
export interface LeaseIo {
  /** Create `ohmail/_meta` if absent and unsubscribe it. Idempotent. */
  ensureMetaFolder(): Promise<void>;
  /** Every message in the meta folder. */
  listClaims(): Promise<RawClaimMessage[]>;
  /** APPEND one claim. */
  appendClaim(raw: string): Promise<void>;
  /** STORE `\Deleted` + EXPUNGE the given messages. */
  removeClaims(refs: readonly unknown[]): Promise<void>;
  /**
   * EVERY record in the folder bearing this install id, however far back it sits — asked of the
   * SERVER, not filtered out of a window.
   *
   * Optional for `uidValidity`'s reason, and the absence resolves the same safe way: a caller that
   * cannot ask falls back to the bounded window and reports that it could not see the whole folder,
   * which is what it did before this existed.
   *
   * It exists because RELEASE and ELECTION ask different questions of one folder. The election asks
   * "who holds this mailbox", which a partial read cannot answer, so it refuses. A release asks
   * "which of these are MINE" — answerable per record, but only over records it can SEE, and the
   * newest-first window does not cover crash residue or a claim buried by later arrivals. Searching
   * by the id answers it completely and returns a handful of records rather than a folder.
   *
   * The result is CANDIDATES, not claims: the settings document carries the same install-id header,
   * so the caller must still parse each one and keep only the claims. Returning them unparsed keeps
   * one parser in this module rather than two.
   */
  findOwnRecords?(installId: string): Promise<RawClaimMessage[] | null>;
  /**
   * EVERY CLAIM IN THE FOLDER, asked of the SERVER by header rather than read out of a window.
   *
   * This is what an ELECTION reads when the bounded window could not cover the folder. A window is
   * newest-first, and a live incumbent renewed just before a burst of five hundred appends is
   * exactly an old record — so electing on the window can report "nobody organizes this mailbox"
   * about a mailbox somebody is actively organizing, and a second install then claims it. Two
   * organizers is the one outcome the lease exists to make impossible, so the election may not rest
   * on a read that cannot prove a claim is absent.
   *
   * Only claims carry `X-Ohmail-Lease`, so the set is complete for claims and independent of
   * position, and it is a handful of records rather than a folder.
   *
   * Optional for `uidValidity`'s reason, and the absence resolves the same safe way: `null` means
   * the connection cannot ask, and the gate REFUSES rather than guessing.
   */
  listClaimRecords?(): Promise<RawClaimMessage[] | null>;
  /**
   * THE SELECTED FOLDER'S UID GENERATION, where the server reports one.
   *
   * OPTIONAL, and this is the one place in this module where an optional capability is the right
   * shape rather than the trap the rest of it avoids. Absence means "this connection cannot tell
   * me", which resolves to `null` on BOTH of the reads that are compared — so the comparison finds
   * no change and the gate behaves exactly as it did before this existed. The capability can only
   * ADD a refusal, never remove one, so a fake that omits it is not weaker than today; it is today.
   */
  uidValidity?(): number | bigint | null;
}

/**
 * The minimum an IMAP client has to be for {@link makeLeaseIo} to drive it.
 *
 * Structural, not `ImapFlow`, so the whole IO layer is testable against a fake without a server
 * and so this module does not import the client library at all — `organizer-lease.ts` needs only
 * `imap-types.ts`, which is what keeps `imap.ts → organizer-lease.ts` a one-way edge with no
 * cycle.
 */
export interface LeaseImapClient extends MetaFolderClient {
  /**
   * The SELECTED mailbox, which `getMailboxLock` sets, and whose `exists` is its message count.
   *
   * Optional, and read defensively in {@link makeLeaseIo}, because it is the one field here that
   * is a client-library convenience rather than a command: a fake that omits it must behave
   * exactly as before, so absence means "unknown", never "empty".
   */
  readonly mailbox?: { exists?: number; uidValidity?: number | bigint } | false;
  /**
   * A NOOP, which is how a long-lived connection LEARNS what changed under it.
   *
   * Optional, so every existing fake is unaffected and behaves exactly as it did. Where it IS
   * present, {@link selectedCount} calls it before trusting a zero — see that function for the
   * measurement that made it necessary.
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
  /**
   * SEARCH the selected folder by HEADER. Optional. Not the count probe — that asks STATUS for a
   * scalar; this asks the server WHICH messages carry an id, so a release can find its own records
   * without reading the folder.
   */
  search?(
    query: { header?: Record<string, string | boolean>; before?: Date },
    options?: { uid?: boolean },
  ): Promise<number[] | false | undefined>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxUnsubscribe(path: string): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(
    range: string,
    query: { uid?: boolean; headers?: boolean | string[] },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{ uid: number; seq?: number; headers?: Buffer }>;
  append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<unknown>;
}

/**
 * A {@link LeaseIo} bound to a LIVE connection.
 *
 * `toServerPath` is passed in rather than recomputed, because the delimiter is discovered at
 * login and is private to the adapter. `ohmail/_meta` has to survive a server whose delimiter is
 * `.` (GreenMail) as well as one whose delimiter is `/` (Dovecot), and hand-writing that mapping
 * a second time here is how the two spellings drift.
 *
 * The claim is APPENDED with `\Seen` so a user who does subscribe to the folder in another
 * client is not shown an unread count for our bookkeeping.
 */
/**
 * THE SELECTED FOLDER'S MESSAGE COUNT — and why it is not simply `client.mailbox.exists`.
 *
 * Three reads in this module skip their `FETCH 1:*` when the selected mailbox holds zero
 * messages, because `1:*` is not a valid messageset against an empty mailbox and Dovecot refuses
 * the command outright. Each documented the rule as *"only a POSITIVELY KNOWN zero skips the
 * fetch"*. The value they consulted does not meet that bar.
 *
 * ── WHAT WAS MEASURED, against a real Dovecot, 2026-09-04 ───────────────────────────────────
 *
 * `client.mailbox.exists` is a CACHE that a connection updates only from untagged responses. Two
 * connections, one `ohmail/_meta`: B empties the folder (its cache reaches a true 0), then A
 * appends a claim. B's cache stays 0 — and `getMailboxLock` does NOT re-SELECT a mailbox that is
 * already selected, so taking the lock does not refresh it either. Observed still 0 after gaps of
 * 1.5 s, 3 s, 6 s and 10 s; only by 20 s had imapflow's IDLE delivered the EXISTS. A forced
 * `FETCH 1:*` in that window does not merely return nothing — the server refuses it outright.
 *
 * So a STALE zero was indistinguishable from a true one, and the consequences differed by caller:
 *
 *   · {@link makeLeaseIo}.listClaims — the gate reads an EMPTY folder while a live claim stands,
 *     takes {@link decideLease}'s arm 4 ("nobody has ever organized this mailbox"), and claims it
 *     with an EMPTY displacement. Two live claims, two organizers: the single-organizer invariant
 *     this whole module exists to hold. It also spends the caller's one-shot takeover
 *     authorization while leaving the beaten claim standing to win the next election — the exact
 *     failure `removeClaims` already refuses to let a silently-failed EXPUNGE cause.
 *   · the peek — a reader is told nobody organizes a mailbox that is held.
 *   · the request read — the organizer's drain finds no requests, so a reader's decision is never
 *     applied; and the reader's already-in-folder set comes back empty, so it appends duplicates.
 *
 * The window is bounded by an IDLE this module does not control, which is what made it look like
 * flakiness rather than a defect. One NOOP removes the timing dependence entirely.
 *
 * A NOOP that FAILS leaves the cached value standing, which is exactly where the caller was
 * before — so the failure is swallowed rather than turned into a lease fault.
 */
async function selectedCount(client: LeaseImapClient): Promise<number | undefined> {
  /* ── THERE IS NO SUCH THING AS A REFRESHED CACHE HERE, AND THE FLAG THAT SAID SO WAS A LIE ──
   *
   * This used to NOOP and report `refreshed: true` when the call resolved. The library makes that
   * unknowable (`imap-flow.js` 1.5.0):
   *
   *     async noop() { await this.run('NOOP'); }
   *
   * The command's own result is DISCARDED. A server that REFUSES the NOOP produces a `run` that
   * resolves `false`, and `noop()` resolves normally regardless — so "the NOOP succeeded" was
   * inferred from the absence of a throw, which is not evidence of anything. Every caller then
   * trusted a cached count on the strength of it.
   *
   * The consequence was the worst one available. A connection holding a cached `exists = 0` from
   * before another install appended its claim would refuse the NOOP, be recorded as refreshed,
   * return the stale zero, and the gate would elect over an EMPTY folder and append a second live
   * claim. Two organizers on one mailbox, from a boolean.
   *
   * A refresh must be proven by the thing it is meant to refresh. So the count is asked for
   * outright — {@link lastSequence} issues a STATUS naming the folder, which the library passes
   * through and the server answers with a number — and the connection's own cache is consulted
   * only where that is impossible.
   */
  const selected = client.mailbox;
  return typeof selected === "object" && selected !== null ? selected.exists : undefined;
}

/**
 * The narrowest client this probe needs. Structural rather than {@link LeaseImapClient} so the
 * PROFILE read of the same folder calls the same function: the two clients ask for different things
 * (headers against sources) and agree about exactly this, and one folder should not have two
 * implementations of "how many messages are in it".
 */
export interface SequenceProbeClient {
  /**
   * STATUS by folder name. Optional, because a client that does not offer it simply falls back to
   * reading the folder whole — see {@link lastSequence} for why this is the only form of the
   * question this module asks.
   */
  status?(
    path: string,
    query: { messages?: boolean },
  ): Promise<{ messages?: number } | false | undefined>;
}

/**
 * ASK THE SERVER HOW MANY MESSAGES THE FOLDER HOLDS — and ask it in a form the CLIENT cannot
 * answer out of its own cache.
 *
 * ── WHY NOT `FETCH *`, WHICH IS WHAT THIS USED TO DO ─────────────────────────────────────────
 *
 * `*` is the highest existing sequence number, so fetching exactly that message should carry the
 * folder's true count in its own `seq`. Against a real server that is true. It never reached a
 * real server. ImapFlow rewrites the range BEFORE issuing the command (`imap-flow.js`, 1.5.0):
 *
 *     if (range === '*') {
 *         if (!this.mailbox.exists) { return false; }
 *         range = this.mailbox.exists.toString();
 *     }
 *
 * — so the probe was answered with `mailbox.exists`, WHICH IS THE CACHED COUNT IT EXISTS TO
 * DISTRUST. It returned the stale number with extra steps, and on a cached zero it returned
 * `false` rather than an async iterable, which the loop then threw on. The whole mechanism was a
 * no-op wearing a round trip's clothes, and the fake hid it by resolving `*` server-side the way
 * a server does rather than the way THIS CLIENT does.
 *
 * SEARCH is not rewritten. It is issued against the selected folder and answered by the server,
 * and `ALL` returns every sequence number in it — so the highest is the count, and an empty
 * answer is an empty folder rather than an unknown one. It carries no message data, only
 * integers.
 *
 * `undefined` on anything unexpected — no `search` at all, a server that will not answer, a
 * non-array reply. The caller then falls back to the sliding window, which is bounded in memory
 * and correct about WHICH records it keeps and merely costs the whole folder over the wire. Never
 * a throw: this is an optimisation of a read that already works without it.
 */
export async function lastSequence(
  client: SequenceProbeClient,
  path: string | undefined,
): Promise<number | undefined> {
  if (path === undefined || typeof client.status !== "function") return undefined;
  try {
    const st = await client.status(path, { messages: true });
    // `false` is a real answer here, not a missing one: the library returns it when the command's
    // preconditions are not met or it fails, so this cannot optional-chain through `st`. Both that
    // and a reply without the field mean the same thing to the caller — the count is unknown, use
    // the whole-folder fallback.
    const messages = typeof st === "object" && st !== null ? st.messages : undefined;
    return typeof messages === "number" ? messages : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ONE BOUNDED READ OF `ohmail/_meta`, NEWEST FIRST — the only `FETCH` in this module
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three reads used to run their own `FETCH 1:*` against this one folder — the lease gate, the
 * read-only peek, and the shared record list. They are one loop now. The module header has claimed
 * since the record channel shipped that the folder's kinds come off "the same headers FETCH", and
 * three copies of a loop is three places for the ceiling, the ordering and the empty-folder
 * defence to drift apart. `client.fetch(` appears exactly twice IN THIS MODULE — the WINDOW itself
 * and the one-message `*` probe that learns the folder's true count — and a census test pins both;
 * the per-kind parsing stays with each caller. (Not "below": the probe is declared above this
 * docblock, and a spatial claim in a file that gets reordered is a claim that quietly stops being
 * true.)
 *
 * ── WHY NEWEST FIRST, AND WHY IT IS NOT A PREFERENCE ────────────────────────────────────────
 *
 * `FETCH 1:*` returns the LOWEST sequence numbers first — arrival order, oldest first. A ceiling
 * applied by breaking out of that loop therefore keeps the OLDEST records and silently drops every
 * later one. In this folder that is backwards in the only case that matters: a claim is renewed by
 * APPENDING, a decision is APPENDED, an acknowledgement is APPENDED. Everything live is at the
 * END of the folder, and everything an ordinary mailbox accumulates is at the start.
 *
 * So five hundred harmless messages — which anyone with APPEND rights on the folder can put there,
 * and which is well inside what a shared folder, a filing rule or another mail client can produce
 * without anybody intending harm — would hide every claim, every decision and every acknowledgement
 * written after them, for good. The drain would find no decisions; the peek would report that
 * nobody organizes a mailbox somebody is actively organizing; and the gate would read an empty
 * election and claim a mailbox that is already held. **A truncated read was indistinguishable from
 * a complete one at every call site**, which is the property that turns a full folder into a
 * silent, permanent fault rather than a visible one.
 *
 * The window therefore runs from the END: with `exists` known and above the ceiling, the FETCH asks
 * for `exists - ceiling + 1 : *`. Where the count is not known — a client that does not expose one
 * — the range stays `1:*` and the ceiling is enforced by counting, which is the older behaviour and
 * is why nothing that fits inside the ceiling reads any differently than it did.
 *
 * ── AND A TRUNCATED READ SAYS SO ────────────────────────────────────────────────────────────
 *
 * `truncated` is the whole point of returning a record rather than an array — and the three callers
 * do NOT all answer it the same way, which took a review round to get right.
 *
 * The PEEK and both DRAINS treat it as "I could not look", never as "there is nothing there": the
 * peek reports the mailbox as unknown rather than unheld, and a drain skips its cycle and expunges
 * nothing. Their cost of being wrong is telling a person something FALSE — that nobody organizes
 * their mailbox, or that a decision nobody ever saw was applied — and their cost of refusing is a
 * cycle's delay. So they refuse.
 *
 * **The GATE acts on the window, and the first cut of this had it refuse.** That was wrong, and the
 * way it was wrong is worth keeping: refusing at the gate raises `LeaseUnavailableError`, which the
 * sync loop exempts by class and answers by not syncing the mailbox at all — so a folder holding one
 * record more than the ceiling would have stopped a customer's MAIL, for readers as well as
 * organizers, with no
 * self-healing path, because the folder never shrinks on its own. That is the very failure this
 * bound was written to remove, reached at a far lower threshold than the timeout it replaced.
 *
 * A forged claim yields one organizer; a flood over a live incumbent yields two. The second
 * outcome is not available directly, which is why hiding a claim is the attack worth closing and
 * why the election reads the claim set rather than the folder.
 *
 * One message beyond the ceiling is read and discarded rather than kept, so "the folder holds more
 * than the window" is a fact off the wire instead of an inference from a full window: a folder
 * holding EXACTLY the ceiling is complete, and reporting it as truncated would stop a mailbox for
 * no reason.
 */
export interface MetaFolderRead {
  /** The records the window covered, in the server's own order (oldest first WITHIN the window). */
  records: RawMetaMessage[];
  /** The folder holds more than {@link META_RECORDS_MAX_PER_FETCH}; older records were not read. */
  truncated: boolean;
  /** The folder's message count as the server reported it, or `null` when it did not say. */
  total: number | null;
}

/**
 * THE FOLDER HOLDS MORE THAN ONE READ MAY TAKE.
 *
 * Its own class so that each caller can convert it into the refusal its own layer already has —
 * {@link LeaseUnavailableError} for the lease, {@link RequestUnavailableError} for the records —
 * rather than every caller re-deriving "a full folder is a look that failed" from a boolean it
 * might forget to check. Carrying the counts is what lets the refusal say how full the folder is,
 * which is the one thing that tells somebody reading a log what to do about it.
 */
export class MetaFolderTruncatedError extends Error {
  /** How many records the window covered. */
  readonly read: number;
  /** The ceiling that bounded it. */
  readonly limit: number;
  /** The folder's message count, where the server reported one. */
  readonly total: number | null;
  /**
   * THE NEWEST RECORDS THE WINDOW DID COVER — carried so a caller that can act on a partial view
   * may, without a second round trip.
   *
   * An error carrying a payload is a smell and this one is deliberate: exactly one caller can act
   * on a partial view of this folder and it is the ELECTION, for the reason written at the gate's
   * own catch. The peek and both drains cannot, do not, and never touch this field.
   */
  readonly records: readonly RawMetaMessage[];
  /**
   * REQUIRED, with no default. A default of `[]` is the shape where a construction site that forgot
   * the window silently hands the gate an EMPTY election — which is `decideLease`'s "nobody has
   * ever organized this mailbox" arm, over a folder that is demonstrably full. The one field whose
   * absence would be worst is the one an optional parameter makes easiest to omit.
   */
  constructor(read: number, total: number | null, records: readonly RawMetaMessage[]) {
    super(
      `${META_FOLDER} holds more than the ${META_RECORDS_MAX_PER_FETCH} records one read may take` +
      `${total === null ? "" : ` (${total} present)`}, so what is in it is not fully known and ` +
      `nothing was decided from it`,
    );
    this.name = "MetaFolderTruncatedError";
    this.read = read;
    this.limit = META_RECORDS_MAX_PER_FETCH;
    this.total = total;
    this.records = records;
  }
}

/**
 * The shared read itself. The folder must already be SELECTED — every caller takes the lock, and
 * taking it here would mean this function had to know the path, which is the one thing the three
 * callers legitimately resolve for themselves.
 *
 * Exported so the window is testable as the mechanism it is. Its callers all convert `truncated`
 * into a refusal, so a test driving them can only ever observe the refusal — which would leave
 * "the window runs from the END of the folder" asserted nowhere, and a ceiling that quietly went
 * back to keeping the oldest records would pass every guard above it.
 */
export async function readMetaFolderWindow(
  client: LeaseImapClient,
  path?: string,
): Promise<MetaFolderRead> {
  // AN EMPTY `_meta` IS THE NORMAL STATE OF A FRESH MAILBOX, AND `1:*` IS NOT A VALID MESSAGESET
  // WHEN A MAILBOX HOLDS NOTHING.
  //
  // The failure this defends: every genuinely fresh mailbox was unorganizable and the product
  // showed "waiting for first sync" for ever. The folder is created one call earlier, so on a first
  // attach this FETCH always ran against zero messages. Some servers tolerate that and answer an
  // empty set; Dovecot refuses the command outright — measured against a real one:
  //
  //     Error in IMAP command FETCH: Invalid messageset
  //
  // which becomes a lease that "could not be read", which the sync loop exempts BY CLASS from its
  // failure counter — so it retried every thirty seconds for ever, wrote nothing and quarantined
  // nothing. Correct behaviour at every layer, composing into a mailbox that can never be adopted.
  //
  // Read DEFENSIVELY: only a POSITIVELY KNOWN zero skips the fetch. A count we cannot see means
  // "unknown", so the fetch still runs.
  const cached = await selectedCount(client);
  /* ── ASK THE SERVER, THEN FALL BACK — NOT THE OTHER WAY ROUND ────────────────────────────
   *
   * The probe is a STATUS naming the folder, so it costs one scalar round trip and, unlike the
   * FETCH this used to be, it is answered on an EMPTY folder as readily as a full one. That is why
   * the zero check now comes AFTER it rather than guarding it: the reason to skip the probe on a
   * cached zero was that `*` against an empty mailbox is refused by the same servers that refuse
   * `1:*`, and STATUS is refused by neither.
   *
   * The connection's cached `exists` is consulted only where the server cannot be asked at all —
   * a client with no STATUS. It is not a fast path any more, because there is no way to know
   * whether it is current: see {@link selectedCount}.
   */
  const probed = await lastSequence(client, path);

  /* A CACHED COUNT MAY END THE READ, BUT MAY NEVER BE COUNTED BACK FROM ────────────────────
   *
   * Those are different amounts of trust and they were conflated. Skipping an empty folder is safe
   * to get wrong in only one direction — a stale zero costs a read that finds nothing — while
   * counting BACK from a wrong number puts the window in the wrong place, which is how a live
   * claim disappears. Nothing now confirms a cached value (see {@link selectedCount}), so it keeps
   * the cheap job and loses the load-bearing one.
   *
   * `null` therefore means "unknown", and unknown reads the folder whole with the sliding eviction
   * behind it — bounded in what it RETAINS, and correct about which records those are. */
  if (probed === 0) return { records: [], truncated: false, total: 0 };
  if (probed === undefined && cached === 0) return { records: [], truncated: false, total: 0 };
  const total = probed ?? null;

  // The window's start. Above the ceiling this deliberately skips the oldest records — see the
  // header: in this folder the oldest are the ones that have been superseded or were never ours.
  const from = total !== null && total > META_RECORDS_MAX_PER_FETCH
    ? total - META_RECORDS_MAX_PER_FETCH + 1
    : 1;
  // HEADERS ONLY. A claim's body is one sentence for a human, a decision's payload rides in its
  // headers, and fetching sources here would make every cycle's cost scale with whatever else ends
  // up in this folder.
  //
  // A function rather than a loop in place, because the shift check below has to be able to run it
  // AGAIN with a wider range.
  const readFrom = async (start: number): Promise<{ records: RawMetaMessage[]; evicted: boolean }> => {
  const records: RawMetaMessage[] = [];
  let evicted = false;
  for await (const m of client.fetch(`${start}:*`, { uid: true, headers: true }, { uid: false })) {
    if (!m.headers) continue;
    records.push({ ref: m.uid, raw: m.headers.toString("utf8") });
    // ── PAST THE CEILING, DROP FROM THE FRONT — NEVER STOP AT IT ─────────────────────────────
    //
    // This used to `break`, and on the `1:*` path — an `exists` the client will not report — that
    // silently INVERTED the newest-first guarantee this whole read is built on: the range starts at
    // the oldest record, so stopping at the ceiling keeps the OLDEST window, which is the defect
    // being fixed wearing the fix's own clothes. Nothing announced it, because the count that would
    // have revealed it is exactly the count that was missing.
    //
    // Shifting keeps memory bounded at the ceiling either way. It does read the whole folder over
    // the wire on that path, and that is the honest cost of a server that will not say how many
    // messages it holds — a real connection reports `exists`, so the range is computed and this
    // branch never runs. Correctness first: a bound that quietly returns the wrong half is worse
    // than a bound that costs a round trip.
    //
    // Nothing is deleted on the way past. This folder is the customer's, and a message this build
    // does not recognise is not its to destroy.
    if (records.length > META_RECORDS_MAX_PER_FETCH) {
      records.shift();
      evicted = true;
    }
  }
    return { records, evicted };
  };

  const first = await readFrom(from);

  /* ── THE NUMBERING CAN SHIFT BETWEEN THE COUNT AND THE FETCH, AND EXPUNGE DOES IT SILENTLY ──
   *
   * `from` is a SEQUENCE number computed from a count taken one round trip earlier. Sequence
   * numbers are not stable: when another connection expunges a message, every message above it is
   * renumbered DOWNWARD immediately. So between the count and this FETCH the window can slide out
   * from under the range, and the range is the only thing that did not move.
   *
   * The renumbering guard the gate already carries does not see this. That one compares
   * UIDVALIDITY, and **an EXPUNGE does not change UIDVALIDITY** — it is not a renumbering of uids
   * at all, only of sequence numbers, which is precisely the coordinate this range is written in.
   *
   * Mild case: enough messages go that the window covers fewer records than it asked for, and the
   * read quietly returns a shorter tail than the ceiling it is entitled to. Severe case: enough go
   * that `from` is now past the end, and the unordered-range rule turns `501:*` into `400:501` —
   * ONE record, still flagged truncated, and the gate elects on it. That is the same one-record
   * election window the unconfirmed-count fix closed, reached by a race instead of a stale cache.
   *
   * Both are visible in one number. A capped window asks for exactly the ceiling; anything less
   * means the folder moved while we were reading it, so the answer is thrown away and the folder
   * read whole. `1:*` needs no such check — it is anchored at both ends and cannot slide.
   *
   * Appends are the other direction and are already safe: they only make `*` larger, and the
   * eviction below keeps the newest.
   */
  if (from > 1 && first.records.length < META_RECORDS_MAX_PER_FETCH) {
    const wide = await readFrom(1);
    // The count that produced `from` is now known to be wrong, so it is not reported. When the
    // wide read evicted nothing it counted the folder itself, which is a better answer than the
    // one the server gave a round trip ago.
    return {
      records: wide.records,
      truncated: wide.evicted,
      total: wide.evicted ? null : wide.records.length,
    };
  }

  return { records: first.records, truncated: from > 1 || first.evicted, total };
}

/**
 * EVERY RECORD IN THE FOLDER MATCHING A HEADER, ASKED OF THE SERVER — the one place this module
 * turns a header into a set of messages, and the reason the fetch census stays countable.
 *
 * Three callers route through it: the lease IO's own-records read, the CLAIM SET the election needs
 * when the window could not cover the folder, and the read-only peek. A second copy would be
 * another `client.fetch(` and a second answer to "which messages carry this header", which is how
 * two readers of one folder come to disagree.
 *
 * `null`, never `[]`, when the connection cannot ask or the server refuses. "Could not look" and
 * "there are none" are different answers and every caller acts on them differently — the election
 * refuses on the first and may elect on the second.
 *
 * `true` as a header value compiles to `HEADER <name> ""`, which RFC 3501 defines as
 * header-PRESENT. MEASURED on both IMAP servers this repository tests against before this
 * landed, rather than taken on the RFC's word: from a folder holding a claim, a settings
 * document and an ack, exactly the claim's uid comes back on GreenMail and on Dovecot, the field
 * name is matched case-insensitively, and a header no message carries yields an empty set.
 *
 * The CALLER holds the folder's lock. This issues no APPEND and no STORE: it is a read.
 */
/**
 * ── AN EXPUNGE THAT RESOLVED `true` IS NOT A REMOVAL, AND THIS IS THE ONLY PLACE THAT SAYS SO ──
 *
 * `messageDelete` is `resolveRange` followed by `run('EXPUNGE', …)`. The STORE that marks
 * `\Deleted` is internal to it and its result is NOT propagated, so a refused STORE under an
 * accepted EXPUNGE resolves `true` having removed nothing. The only way to tell that from a real
 * removal is to ask the folder for the uids again and be told they are gone.
 *
 * TWO OUTCOMES ARE FAILURES HERE, and conflating them was round nine's finding 1:
 *
 *   · the uids are still there — the expunge did nothing;
 *   · the read could not RUN — nothing was established in either direction.
 *
 * The second is the one that reads as success if it is allowed to return normally, because every
 * caller treats a normal return as "removed" and reports a count from it. The expunge is still
 * allowed to have worked; what is refused is REPORTING that it did.
 *
 * One implementation for all three deletion paths — claims, settings documents and stale
 * acknowledgements — because three copies of a rule this fiddly is how two of them come to
 * disagree about what `true` meant.
 */
async function proveGone(
  client: Pick<LeaseImapClient, "fetch">,
  uids: readonly number[],
  what: string,
  op: LeaseOp,
): Promise<void> {
  if (typeof client.fetch !== "function") return;
  const still: number[] = [];
  try {
    for await (const m of client.fetch(uids.join(","), { uid: true }, { uid: true })) {
      if (typeof m.uid === "number") still.push(m.uid);
    }
  } catch (err) {
    throw new LeaseUnavailableError(
      `the expunge of ${uids.length} ${what} from ${META_FOLDER} could not be verified: `
      + `${err instanceof Error ? err.message : String(err)}`,
      { op },
    );
  }
  if (still.length > 0) {
    throw new LeaseUnavailableError(
      `${still.length} ${what} survived the expunge in ${META_FOLDER} — the server accepted the `
      + "command and removed nothing",
      { op },
    );
  }
}

/**
 * The most uids a header search will carry forward, one PAST the largest ceiling any caller
 * applies to the result — so "exactly at the ceiling" stays distinguishable from "over it", which
 * is what the claim-set refusal turns on. A server that answers with more than this is answering
 * about a folder no caller here will act on anyway.
 */
const SEARCH_UIDS_MAX = 501;

/**
 * How many uids go into one FETCH command. Keeps the command line and the in-flight reply bounded
 * regardless of what the server said, which the single-command form could not.
 */
const SEARCH_FETCH_BATCH = 100;

async function searchHeaders(
  client: Pick<LeaseImapClient, "search" | "fetch">,
  query: { header: Record<string, string | boolean>; before?: Date },
): Promise<RawClaimMessage[] | null> {
  if (typeof client.search !== "function") return null;
  const found = await client.search(query, { uid: true });
  if (!Array.isArray(found)) return null;
  if (found.length === 0) return [];
  /* ── THE REPLY IS BOUNDED BEFORE IT IS SPENT, NOT AFTER ────────────────────────────────────
   *
   * The uid list comes from a SERVER, and every ceiling that acts on it — the claim-set ceiling,
   * the caller's own limits — is applied to the RESULT of this function. Between the two sat an
   * unbounded array turned into ONE comma-separated FETCH: a server answering with a million uids
   * got a megabytes-long command line built for it and the whole reply materialised in memory,
   * before anything was in a position to say the set was too large. The check that refuses an
   * oversized claim set cannot run if the process is already gone.
   *
   * So the set is cut to one past the largest ceiling any caller applies — one PAST, so a caller
   * can still tell "exactly at the ceiling" from "over it", which is the distinction its refusal
   * is built on — and fetched in batches rather than as a single command. Bounded work for an
   * unbounded answer, which is the property this seam needed and did not have.
   */
  const capped = found.length > SEARCH_UIDS_MAX
    ? found.slice(0, SEARCH_UIDS_MAX)
    : found;
  const out: RawClaimMessage[] = [];
  for (let i = 0; i < capped.length; i += SEARCH_FETCH_BATCH) {
    const batch = capped.slice(i, i + SEARCH_FETCH_BATCH);
    for await (const m of client.fetch(batch.join(","), { uid: true, headers: true }, { uid: true })) {
      if (!m.headers) continue;
      out.push({ ref: m.uid, raw: m.headers.toString("utf8") });
    }
  }
  return out;
}

export function makeLeaseIo(client: LeaseImapClient, toServerPath: (canonical: string) => string): LeaseIo {
  // ONE resolution, shared with the APPEND-less peek. A writer and a reader that spell "where is
  // `_meta`" differently is exactly how each ends up renewing a claim the other cannot see.
  const meta = makeMetaFolderRef(client, toServerPath);

  /**
   * THE UID GENERATION AS OF THE LAST READ, SAMPLED UNDER THAT READ'S OWN LOCK.
   *
   * The gate compares refs between two reads and refuses when the folder was renumbered between
   * them. Reading `client.mailbox.uidValidity` when the gate ASKS — after the lock is released —
   * would sample a generation that is not the one the records came from, so a renumbering landing in
   * that gap would be attributed to the wrong read and the check would look at two values that
   * matched while the refs it is guarding did not. Sampled beside the records instead, which is the
   * only moment the two are known to belong together.
   */
  let generationAtLastRead: number | bigint | null = null;
  const sampleGeneration = (): void => {
    const selected = client.mailbox;
    const v = typeof selected === "object" && selected !== null ? selected.uidValidity : undefined;
    generationAtLastRead = typeof v === "number" || typeof v === "bigint" ? v : null;
  };


  return {
    async ensureMetaFolder(): Promise<void> {
      const at = await meta.locate();
      const found = at.row;
      if (!found) {
        try {
          const info = await client.mailboxCreate(at.path);
          // THE SERVER'S OWN ANSWER, where it gives one — `ImapAdapter.createFolder` follows the
          // same rule for the same measured reason: a root-named CREATE lands under the personal
          // namespace on some servers, and the path the server reports is the one LIST will show.
          const landed = (info as { path?: string } | undefined)?.path;
          if (typeof landed === "string" && landed !== "") meta.adopt(landed);
        } catch (err) {
          if (!/already exists/i.test(String((err as Error).message))) throw err;
        }
      }
      // UNSUBSCRIBED, always — a subscribed `_meta` shows up in every other mail client the user
      // owns, as a folder of machine bookkeeping they did not ask for. `ListResponse.subscribed`
      // means this is assertable against a real server rather than merely requested.
      if (!found || found.subscribed) await client.mailboxUnsubscribe(await meta.path());
    },

    async listClaims(): Promise<RawClaimMessage[]> {
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        // THE GATE'S READ IS BOUNDED, AND THIS IS THE READ THAT MOST NEEDED IT.
        //
        // It had no ceiling at all, so a folder anyone with APPEND rights can write to decided how
        // much work every election did, on every host, for ever. At a large enough count the FETCH
        // itself times out, and the gate reads that as "the lease could not be read" — exempted
        // from the sync failure counter and retried indefinitely, so the mailbox's MAIL stops
        // moving, not merely its record channel.
        //
        // A TRUNCATED READ IS REFUSED RATHER THAN DECIDED ON. The election below would otherwise
        // run over a partial folder, and its "nobody has ever organized this mailbox" arm is
        // reached by seeing no claim — which is exactly what a hidden claim looks like. Claiming a
        // mailbox on that reading is the two-organizer fault the whole module exists to prevent, so
        // this refuses in the same voice an unreadable folder does. No claim is appended and
        // nothing is expunged, and the install keeps whatever role it already had. (`ensureMetaFolder`
        // has already run by the time this is called — it is idempotent, and a folder full enough to
        // reach here plainly exists — so "no claim is appended, nothing is expunged" is the exact
        // guarantee rather than "no command is sent".)
        const read = await readMetaFolderWindow(client, metaPath);
        // BESIDE THE RECORDS, INSIDE THE LOCK — see `generationAtLastRead`. Sampled before the
        // truncation throw as well, because the gate acts on that window too.
        sampleGeneration();
        if (read.truncated) throw new MetaFolderTruncatedError(read.records.length, read.total, read.records);
        return read.records;
      } finally {
        lock.release();
      }
    },

    uidValidity(): number | bigint | null {
      return generationAtLastRead;
    },

    async appendClaim(raw: string): Promise<void> {
      await client.append(await meta.path(), raw, ["\\Seen"]);
    },

    async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
      // The settings document carries this header too, so these are CANDIDATES: the caller parses
      // each and keeps only claims. Expunging a profile here would delete the mailbox's settings.
      const lock = await client.getMailboxLock(await meta.path());
      try {
        return await searchHeaders(client, { header: { [H.installId]: installId } });
      } finally {
        lock.release();
      }
    },

    /**
     * EVERY CLAIM IN THE FOLDER, wherever it sits — what the election reads when the window could
     * not cover the folder.
     *
     * Only claims carry `X-Ohmail-Lease`: a settings document carries `X-Ohmail-Profile`, a request
     * `X-Ohmail-Request`, an ack `X-Ohmail-Ack`. A MALFORMED claim still carries the discriminator
     * and still matches, which is deliberate — arm 4 distinguishes "nobody has ever organized this"
     * from "there is evidence here I cannot read", and that evidence must survive the search.
     */
    async listClaimRecords(): Promise<RawClaimMessage[] | null> {
      const lock = await client.getMailboxLock(await meta.path());
      try {
        return await searchHeaders(client, { header: { [H.lease]: true } });
      } finally {
        lock.release();
      }
    },

    async removeClaims(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      if (uids.length === 0) return;
      const lock = await client.getMailboxLock(await meta.path());
      try {
        // imapflow's `messageDelete` RESOLVES `false` when the server refuses the STORE/EXPUNGE
        // — it does not reject. Swallowing that made a refused removal indistinguishable from a
        // done one, and the gate's takeover path is now load-bearing on the difference: a
        // handover whose displacement silently did not land returns `organize`, spends the
        // caller's one-shot authorization, and leaves the beaten claim standing to win the next
        // election. A refusal is a failure here, exactly as a rejection is.
        const done = await client.messageDelete(uids, { uid: true });
        if (done === false) {
          throw new Error(`the server refused to expunge ${uids.length} claim message(s) from ${META_FOLDER}`);
        }
        /* ── AND A `true` PROVES ONLY THAT AN EXPUNGE RAN, NOT THAT THESE MESSAGES WENT ──────
         *
         * `messageDelete` is `resolveRange` followed by `run('EXPUNGE', …)` (`imap-flow.js` 1.5.0).
         * The STORE that marks `\Deleted` is internal to it and its result is not propagated, so a
         * REFUSED store followed by an accepted EXPUNGE — which then deletes nothing — resolves
         * `true`. The refusal check above cannot see that.
         *
         * Custody is read back instead: the uids must be GONE. On the release path this is the
         * difference between reporting a claim removed and leaving it live while saying otherwise,
         * which is the whole reason a caller is allowed to trust the count.
         *
         * {@link proveGone} holds the rule for all three deletion paths — claims, settings
         * documents and stale acknowledgements — including the half this file learned late: a read
         * that could not RUN establishes nothing and must not return normally. */
        await proveGone(client, uids, "claim message(s)", "remove_claims");
      } finally {
        lock.release();
      }
    },
  };
}

export interface LeaseGateInput {
  io: LeaseIo;
  self: LeaseSelf;
  now: Date;
  staleAfterMs?: number;
  takeover?: TakeoverAuthorization | null;
  /**
   * WHAT THIS ORGANIZER ADVERTISES TO READERS — written onto every claim this gate renews.
   *
   * Required, on {@link ClaimInput.capabilities}'s reasoning: an optional field defaulted to empty
   * would make every organizer in the fleet look like a build too old to take a reader's decision,
   * with nothing failing anywhere.
   */
  capabilities: readonly string[];
  /** Injected for tests; production uses `crypto.randomUUID()`. */
  newNonce?: () => string;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface LeaseGateResult {
  verdict: LeaseVerdict;
  /** The nonce written this cycle, to be held in memory as the next `self.lastNonce`. */
  nonce: string | null;
}

/**
 * READ, DECIDE, THEN WRITE — the whole gate, in that order.
 *
 * Reconnect is learn-then-act: the LOCAL sidecar reads the organizer lease BEFORE its
 * first move. Reconnect-after-sleep is exactly when a mailbox is
 * most likely to have changed hands, so writing first — even a renew — would be self-promotion
 * dressed as bookkeeping.
 *
 * On `organize` it renews: append the new claim, then expunge our older ones. **That order is
 * load-bearing.** IMAP has no in-place update, and expunging first means a crash in between
 * leaves the mailbox with NO claim of ours at all — which reads to every other install as a
 * mailbox that became available. Appending first leaves two, which is the harmless direction
 * and which {@link decideLease} coalesces.
 *
 * On `stand_down` it RELEASES: our own claims are expunged. Otherwise the winner has to wait out
 * the whole staleness window before its own gate is clean, and a released claim is what makes
 * "Cloud lapsed" legible to a desktop install at all.
 *
 * Every IO failure becomes {@link LeaseUnavailableError}. There is exactly one place a
 * `stand_down` can be constructed and it is {@link decideLease}, from a parsed fresh foreign
 * claim — §3.4's "exactly one path to stand-down".
 */
/** One of the gate's three reads of the folder, and whether it covered the whole of it. */
interface GateRead {
  records: RawClaimMessage[];
  truncated: boolean;
  /**
   * THE FOLDER'S UID GENERATION AT THE MOMENT OF THE READ, where the server reports one.
   *
   * Refs are UIDs, and a UID means nothing across a UIDVALIDITY change: the server has renumbered
   * everything, so a ref from an earlier read names a different message or none at all. The confirm
   * compares refs between two reads, so a change between them makes its whole comparison
   * meaningless — see there.
   */
  uidValidity: number | bigint | null;
}

export async function runLeaseGate(input: LeaseGateInput): Promise<LeaseGateResult> {
  const { io, self, now } = input;
  const log = input.log ?? ((): void => undefined);
  const newNonce = input.newNonce ?? ((): string => crypto.randomUUID());

  // ── ONE OPERATION PER TRY, AND THAT IS THE RULE RATHER THAN A STYLE ────────────────────────
  //
  // These two used to share a single try that reported neither. They fail for completely different
  // reasons — CREATE against a namespace we have no rights in, versus a FETCH the server refuses —
  // and telling them apart is the difference between "our folder path is wrong for this provider"
  // and "the folder is there and empty and this server will not FETCH an empty mailbox", which is
  // that bug exactly. Splitting the try is what makes `op` a fact instead of a guess:
  // there is no arithmetic deciding which literal to use, only two blocks that each know.
  try {
    await io.ensureMetaFolder();
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer lease folder ${META_FOLDER} could not be created; this mailbox cannot be ` +
      `organized safely`,
      { op: "ensure_meta", cause: err },
    );
  }
  /**
   * ── A FOLDER TOO FULL TO READ IS REPORTED AND THEN WORKED WITH, NOT REFUSED ────────────────
   *
   * The gate is the one reader of `ohmail/_meta` that must not answer a full folder by refusing.
   * `LeaseUnavailableError` is exempted by class in the sync loop and answered by NOT SYNCING THE
   * MAILBOX — so a gate that refused here would let one record more than the ceiling, in a folder
   * anyone with APPEND rights can write to, stop a customer's mail, readers as well as organizers,
   * with no
   * self-healing path. That is the failure this bound exists to remove, reached at a far lower
   * threshold than the FETCH timeout it replaced. {@link readMetaFolderWindow}'s header carries the
   * whole argument, including what acting on a partial election costs.
   *
   * So the truncation is LOGGED — once per read, with the counts, because it is the one fault in
   * this family that does not clear on its own and somebody has to be able to find the folder — and
   * the newest records it did cover are used. Every OTHER failure still refuses.
   */
  const readClaims = async (op: () => Promise<RawClaimMessage[]>): Promise<GateRead> => {
    try {
      const records = await op();
      return { records, truncated: false, uidValidity: io.uidValidity?.() ?? null };
    } catch (err) {
      if (err instanceof MetaFolderTruncatedError) {
        log("lease_meta_truncated", { read: err.read, limit: err.limit, total: err.total });
        return { records: [...err.records], truncated: true, uidValidity: io.uidValidity?.() ?? null };
      }
      throw err;
    }
  };

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE ELECTION'S READ — NEITHER THE WINDOW NOR A REFUSAL
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Both of the obvious answers to a folder too full to read are wrong, and each is wrong in a way
   * the other is not.
   *
   * ACTING on the window — what this did — reads a newest-first slice as if it were the folder. A
   * live incumbent that renewed just before five hundred later appends is exactly an old record, so
   * the election sees no claim, takes arm 4, and appends its own. TWO ORGANIZERS on one mailbox,
   * which is the single outcome this whole mechanism exists to make impossible.
   *
   * REFUSING outright — what it did before that — is `LeaseUnavailableError` on every cycle, which
   * the sync loop exempts BY CLASS from its failure counter: the mailbox is retried for ever, its
   * mail stops moving, and nothing is quarantined. A folder anyone with append rights can write to
   * would then be a way to stop somebody's mail.
   *
   * So the election asks a different question. Only claims carry `X-Ohmail-Lease`, so the SERVER
   * can return every claim in the folder regardless of position, in a reply that is a handful of
   * records rather than a folder. That set is complete for claims by construction — which is
   * exactly the property an `organize` verdict needs and a window can never supply.
   *
   * It refuses only when it genuinely cannot know: the connection cannot search, the server refused
   * it, or the claim set ITSELF is over the ceiling. The refusal carries a new `op` and the same
   * CLASS as every other lease IO fault, so every host's exemption keeps working unchanged.
   *
   * `err.records` is never read here again. It stays on the error for the release path, which is
   * now its only consumer.
   */
  const electionRead = async (windowed: GateRead): Promise<GateRead> => {
    if (!windowed.truncated) return windowed;

    const set = await io.listClaimRecords?.();
    if (set === null || set === undefined) {
      throw new LeaseUnavailableError(
        `${META_FOLDER} holds more records than one read may take, and the claims in it could not `
        + "be asked for by header — this install cannot prove no other organizer holds this mailbox",
        { op: "meta_folder_full" },
      );
    }

    if (set.length > META_RECORDS_MAX_PER_FETCH) {
      /* A claim set over the ceiling is not something an honest folder produces by itself: the only
       * install that can legitimately have hundreds of claims here is THIS one, left by a writer
       * whose expunge kept failing (a refused STORE with an accepted EXPUNGE resolves `true`). The
       * protocol licenses an install to remove what it wrote, so its own residue is pruned to the
       * newest and the cycle refuses; next cycle the set is smaller. Nothing another install wrote
       * is touched — the folder is the customer's. */
      const ours = set
        .map((m) => ({ ref: m.ref, claim: parseClaim(m.raw, m.ref) }))
        .filter((c): c is { ref: unknown; claim: OrganizerClaim } =>
          c.claim !== null && !isMalformed(c.claim) && c.claim.installId === self.installId);
      /* ── "NEWEST" MEANS WHAT `coalesce` MEANS BY IT, AND THIS USED TO MEAN SOMETHING ELSE ──
       *
       * This compared heartbeats alone with a strict `>`, so among copies sharing an instant it
       * kept whichever the read happened to yield first — input order deciding which of this
       * install's own records survives. `coalesce` breaks that tie on the NONCE, and the two
       * disagreeing is not cosmetic: the record this prune keeps is the one the NEXT gate reads
       * back as ours. Drop the copy carrying `self.lastNonce` and keep a sibling, and the next
       * cycle finds a live claim under our own install id that we cannot account for — which is
       * the clone defence's exact trigger, aimed at ourselves.
       *
       * Equal heartbeats are not a curiosity here: a renew and its residue are written in the same
       * pass, and a claim is stamped to the millisecond. */
      const newest = ours.reduce<{ ref: unknown; claim: OrganizerClaim } | null>(
        (best, c) => (best === null || compareRecency(c.claim, best.claim) < 0 ? c : best),
        null);
      const residue = ours
        .filter((c) => c !== newest)
        .map((c) => c.ref)
        .filter((r): r is unknown => r !== undefined);
      log("lease_claim_set_overflow", { claims: set.length, pruning: residue.length });
      if (residue.length > 0) {
        // Best effort: a refusal to prune is not a reason to fail differently. The cycle refuses
        // either way, and the next one tries again.
        await io.removeClaims(residue).catch(() => undefined);
      }
      throw new LeaseUnavailableError(
        `${META_FOLDER} holds ${set.length} claims, more than one read may take`,
        { op: "meta_folder_full" },
      );
    }

    log("lease_claim_set_searched", { claims: set.length });
    return { records: set, truncated: false, uidValidity: windowed.uidValidity };
  };

  let messages: RawClaimMessage[];
  /** The UID generation the ELECTION saw — the confirm compares refs against this. See there. */
  let electionUidValidity: number | bigint | null = null;
  try {
    const first = await electionRead(await readClaims(() => io.listClaims()));
    messages = first.records;
    electionUidValidity = first.uidValidity;
  } catch (err) {
    /* A REFUSAL THAT ALREADY SAYS WHY KEEPS ITS OWN WORDS. The election's `meta_folder_full` names a
     * condition this wrapper cannot: the folder is over the ceiling AND the claims in it could not
     * be asked for. Re-wrapping it as `list_claims` would erase the one field that tells an operator
     * which provider refused the header search, which is what the `op` is carried for. Same CLASS
     * either way, so every host's exemption is unaffected. */
    if (err instanceof LeaseUnavailableError) throw err;
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be read; this mailbox cannot be organized safely`,
      { op: "list_claims", cause: err },
    );
  }

  const claims = messages
    .map((m) => parseClaim(m.raw, m.ref))
    .filter((c): c is ClaimRecord => c !== null);

  const verdict = decideLease({
    self,
    claims,
    now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    ...(input.takeover !== undefined ? { takeover: input.takeover } : {}),
  });

  const ourRefs = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .map((c) => c.ref)
    .filter((r): r is unknown => r !== undefined);

  if (verdict.verdict !== "organize") {
    /* ── THE LOSER RELEASES ITS OWN CLAIMS AND NEVER THE WINNER'S ────────────────────────────
     *
     * `ourRefs` matches on INSTALL ID ALONE, while the verdict decides ours-ness by install id
     * AND nonce (`rawOurs` / `isOurs` in `decideLease`). Against a CLONE — two deployments sharing
     * one install id, which is the hazard the per-write nonce exists for — those two disagree by
     * construction: the peer's claim carries our id, so the release below treated the claim that
     * had just BEATEN us as ours and expunged it.
     *
     * The folder then read empty, `decideLease`'s "nobody has ever organized this mailbox" arm
     * said organize, and the loser re-seized on its very next pass — two live deployments taking
     * one mailbox from each other indefinitely, produced by the defence that exists to stop it.
     *
     * This was harmless while a loser DETACHED: there was no next pass. A loser is now a reader
     * that keeps polling, so the same expunge became a live re-seize loop, and the bound is one
     * poll interval rather than a staleness window.
     *
     * `ourRefs` itself is deliberately not narrowed — the renew below reuses it to expunge our
     * own superseded claims, and those carry older nonces by design, so a nonce-narrowed
     * `ourRefs` would leak a claim per cycle. The exclusion belongs to this branch alone, and it
     * is stated as the invariant rather than as a nonce comparison: whoever won, we do not touch
     * their claim. On an `available` verdict there is no winner to protect — the residue is stale
     * or malformed and clearing our own id out of it is the point — so the guard is `stand_down`.
     */
    const winner = verdict.verdict === "stand_down" ? verdict.by?.ref : undefined;
    const toRelease = winner === undefined ? ourRefs : ourRefs.filter((r) => r !== winner);
    if (toRelease.length > 0) {
      try {
        await io.removeClaims(toRelease);
      } catch (err) {
        // Failing to release is not failing to stand down. We are already not organizing; the
        // only cost is that the winner waits out the staleness window. Logged, never thrown —
        // throwing here would turn a clean stand-down into a mailbox fault.
        //
        // ── A BARE STRING UNDER `err` IS SAFE HERE, AND NOT BY ACCIDENT. DO NOT "FIX" IT. ──
        //
        // `log` is an injected `(event, detail) => void`, and the worker routes it into
        // `packages/core/src/log.ts`, whose redactor SPECIAL-CASES the `err` key: it hands the
        // value to `describeError` and emits only `errorClass` + `errorCode`. `describeError`
        // reads `name` and `code`, and a `string` has neither — so this reduces to
        // `errorClass: "String"` and the message is DISCARDED before anything is written. That
        // is the same guarantee an `Error` gets, reached by the same code path.
        //
        // The tempting edit is to pass `err` whole "so the class survives". It does not survive
        // any better, and it costs the one property this line has: an IMAP driver's error object
        // carries the failing command and, on a login path, the credential — `log.ts`'s header
        // records a driver message with `host=…&user=…` reaching a log drain. Reducing to a
        // string HERE means there is no object for a future redactor bug to walk.
        //
        // `op` rides along for the reason the throwing sites carry it: this catch wraps ONE
        // operation today, and the literal is what keeps that true — a second call added inside
        // this try would have to choose between two ops and the choice would be visible.
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log("lease_stand_down", { verdict: verdict.verdict });
    return { verdict, nonce: null };
  }

  // The incumbency clock. Renewing must NOT restart it, or two installs that both renew every
  // cycle would each keep looking like the newest arrival and the election would never settle.
  const priorOwn = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())[0];
  const claimedAt = priorOwn?.claimedAt ?? now;

  /* ── THE PRESS TRAVELS WITH THE TENURE, EXACTLY AS `claimedAt` DOES (0.14.1) ────────────────
   *
   * A tenure has two facts a renewal must carry rather than re-derive: when it began, and what
   * authorized it. `claimedAt` has always been carried — restarting it on every renew would make
   * every install look like the newest arrival for ever. The press is the same shape of fact and
   * needs the same treatment, and it fails in a sharper way if it is not carried:
   *
   *   an authorized takeover writes a claim stamped with the press; sixty seconds later the same
   *   install renews, this time on rule 3 with no press outstanding; a renewal that wrote no stamp
   *   would replace the winning claim with an UNPRESSED one — and the very next election would
   *   rank it below the incumbent it had just displaced, if that incumbent were still around, or
   *   below the next arrival with any press at all. The takeover would undo itself one minute
   *   later, which is the same class of self-reversal `OrganizeVerdict.displace` exists to close.
   *
   * So: an AUTHORIZED win writes the press it rested on; every other win carries forward whatever
   * this install's own prior claim held. The `authorized` flag comes off the verdict rather than
   * from `input.takeover !== null`, because a press can be outstanding while the win comes from
   * rules 3 or 4 — and in those two cases nothing was taken over, so nothing should be stamped.
   */
  /* ── AND IT IS THE NEWEST OWN CLAIM THAT CARRIES IT, NOT `priorOwn` ──────────────────────
   *
   * `priorOwn` is the OLDEST of our claims by `claimedAt`, which is right for the incumbency clock
   * and wrong for this. `claimedAt` is itself carried forward, so a pre-press claim and the
   * post-press claim share an identical one, the sort is a tie, and array order — IMAP uid
   * ascending, i.e. the older residue first — decides which one is read.
   *
   * That is reachable through a partial expunge, which is the failure this module already refuses
   * to infer from a driver's return value: an install wins rule 6, `removeClaims` applies the
   * STORE for the displaced ref and is refused for ours, and the handover verification checks only
   * that the DISPLACED refs are gone and that our new nonce survived — it never asks about our own
   * older refs. One cycle later the residue is `priorOwn`, the renewal writes `authorizedAt: null`,
   * and the tenure a person authorized ranks as unpressed: it then loses rule 6 to any rival with
   * any stamp at all. Precisely the self-reversal the block above exists to prevent, reached
   * through the field that was added to prevent it.
   *
   * Newest heartbeat wins, with the nonce as the tie-break, so the answer is order-free for the
   * same reason `coalesce`'s is.
   */
  const newestOwn = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .sort(compareRecency)[0];
  const authorizedAt = verdict.authorized
    ? (input.takeover?.authorizedAt ?? null)
    : (newestOwn?.authorizedAt ?? null);

  const nonce = newNonce();
  try {
    await io.appendClaim(
      formatClaim({
        installId: self.installId,
        kind: self.kind,
        displayName: self.displayName,
        heartbeat: now,
        claimedAt,
        nonce,
        protocol: self.protocol ?? CLAIM_PROTOCOL,
        authorizedAt,
        capabilities: input.capabilities,
      }),
    );
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer claim in ${META_FOLDER} could not be renewed`,
      { op: "renew_claim", cause: err },
    );
  }

  /**
   * ── APPEND, THEN LOOK AGAIN BEFORE TOUCHING ANY MAIL ────────────────────────────────────────
   *
   * IMAP has no compare-and-swap, so two installs reading the same folder in the same instant can
   * both decide to organize and both append. The election above makes that impossible to SUSTAIN —
   * one cycle later both compute the same winner — but "one cycle" was an unbounded promise: the
   * gate returned `organize` the moment its own APPEND succeeded and never looked at what else had
   * landed. Every simultaneous start was therefore a real dual-write window a full poll interval
   * wide, and it was the missing ceiling under every split-brain reproduced above.
   *
   * So the claim we just wrote is read back WITH ITS NEIGHBOURS, and the election is re-run over
   * what is actually in the folder. Three things make this the right shape rather than a retry loop:
   *
   *  · `takeover` is deliberately NOT passed. The authorization was spent on the first decision;
   *    re-offering it here would let one click win an unbounded number of contests.
   *  · `lastNonce` is set to the nonce we just wrote, so our own new claim is recognised as ours
   *    and the clone defence is armed against anything else bearing our id.
   *  · The claims the authorized decision DISPLACED are excluded — by ref, so only the exact
   *    messages that were ranked and beaten are out of the verify's election. They are not
   *    rivals: they are the handover's outgoing side, slated for expunge the moment this verify
   *    passes. Re-counting them re-elects the incumbent on incumbency whenever the two sides are
   *    of equal kind — a self-hosted server taking a mailbox over from the hosted service, or
   *    handing it back — so the authorized takeover would lose ITS OWN confirm, release, and
   *    re-disable the mailbox: the one-click verb that appears to do nothing, at exactly the
   *    moment somebody chose to leave. By REF and never by install
   *    id: an incumbent that RENEWED between our read and this verify wrote a message the
   *    decision never ranked, and that message is proof of an actively live peer — it stays in
   *    the election and wins, so the press retries rather than steamrolling a live renewal.
   *
   * If we lost, we release and report the stand-down — the mailbox has changed hands between our
   * read and our write, which is exactly the case this exists to catch. A verify that cannot be
   * READ is not a loss: it is a mailbox fault, and it throws like every other one, because
   * "somebody else holds this" and "I could not look" must never be reachable from one another.
   */
  let verifyClaims: readonly ClaimRecord[];
  try {
    /* Through `readClaims` for the same reason as the election above: a full folder must not turn a
     * renew that already landed into a mailbox that stops syncing.
     *
     * ── AND THE ABSENCE THIS BLOCK TESTS IS SAFE UNDER A TRUNCATED WINDOW, WHICH THE CONFIRM'S
     *    IS NOT ─────────────────────────────────────────────────────────────────────────────
     *
     * ── THE ARGUMENT THAT USED TO STAND HERE WAS FALSE, AND IT FAILED IN THE ONE DIRECTION
     *    THAT COSTS TWO ORGANIZERS ──────────────────────────────────────────────────────────
     *
     * It read: every claim this verify could NEWLY need to see was appended AFTER the election,
     * and anything appended after the election is inside a newest-first window BY CONSTRUCTION.
     * The second half does not follow. A window is bounded by COUNT, not by time, so "appended
     * later" only implies "inside the window" while fewer than a ceiling's worth of messages
     * arrive after it. Order the three events the other way and the invariant is simply untrue:
     *
     *   1. a rival renews its claim — appended, newest, and at this instant inside any window;
     *   2. a ceiling's worth of ordinary messages arrive, which anyone with APPEND rights to the
     *      folder can cause and which a shared mailbox can produce without anybody intending it;
     *   3. this gate appends its own claim and verifies.
     *
     * The rival's renewal is now more than a ceiling back. Our own claim is the newest record, so
     * `ownSurvived` passes and nothing looks wrong — the window contains this install and nobody
     * else, the confirm reads `organize`, and the rival goes on organizing the same mailbox from
     * the other side until its next gate. TWO ORGANIZERS, reached without a single lost write.
     *
     * So a verify over a TRUNCATED folder asks the server for the claim set, exactly as the
     * election does, through the same helper: completeness for claims is the property this check
     * needs and a window cannot supply it. Below the ceiling nothing changes and no search is
     * issued. If the set cannot be obtained the gate refuses rather than confirming — our claim is
     * already in the folder, so the next cycle re-decides with it present, which is the safe
     * direction.
     *
     * The confirm below tests the absence of OLD refs, which a newest-first window genuinely can
     * miss, and carries its own coverage check for that reason. */
    const after = (await electionRead(await readClaims(() => io.listClaims()))).records;
    verifyClaims = after
      .map((m) => parseClaim(m.raw, m.ref))
      .filter((c): c is ClaimRecord => c !== null);
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be re-read after the claim was renewed, so ` +
      `this mailbox cannot be organized safely`,
      { op: "list_claims", cause: err },
    );
  }

  // ── THE CLAIM WE JUST WROTE MUST BE IN WHAT WE READ BACK ──────────────────────────────────
  //
  // If it is not, something with delete rights acted on the folder between the append and this
  // read — a restored clone releasing every claim under our id, a takeover racing ours — and we
  // do not hold custody. Without this guard the displaced-ref exclusion below could hand the
  // election an EMPTY set, whose verdict is `organize`: the gate would then expunge the
  // incumbent and proceed WITH NO STANDING CLAIM AT ALL, which is unleased organizing — the
  // exact thing every line of this module exists to prevent. Reported as a lost race, not a
  // mailbox fault: the folder was readable, we simply did not win it.
  const ownSurvived = verifyClaims.some(
    (c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId && c.nonce === nonce,
  );
  if (!ownSurvived) {
    log("lease_lost_race", { verdict: "own_claim_missing" });
    // The verdict is still derived from WHAT THE FOLDER HOLDS — with the caller's OWN identity,
    // not one armed with the vanished nonce: on an ordinary renew the folder still holds our
    // PRIOR claim (its nonce IS `self.lastNonce`), and arming the clone defence with the nonce
    // that vanished would classify that prior claim as a live clone of ourselves — a stand-down
    // naming us, written durably, while our own claim keeps every peer out. Sticky
    // self-stand-down, the worst of both worlds.
    //
    //  · A live FOREIGN winner among the survivors is a genuine lost race: return the
    //    stand-down naming them, so the row the caller writes says who actually holds it.
    //  · Anything else — the survivors elect ourselves (the lost write was just a renewal),
    //    or the folder is empty or stale — is a WRITE THAT WAS LOST, not a loss and not a win:
    //    retryable, like every other IO fault, and the next gate re-enters with our prior
    //    claim (or an empty folder) exactly as the election expects.
    const survivors = decideLease({
      self,
      claims: verifyClaims,
      now,
      ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    });
    if (survivors.verdict === "stand_down") {
      // A stand-down RELEASES, here as on the ordinary path: our prior claims are still in the
      // folder (only the new append vanished), and left behind they obstruct the winner for the
      // whole staleness window. Best effort, as every release is.
      const ownRemaining = verifyClaims
        .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
        .map((c) => c.ref)
        .filter((r): r is unknown => r !== undefined);
      if (ownRemaining.length > 0) {
        try {
          await io.removeClaims(ownRemaining);
        } catch (err) {
          log("lease_release_failed", {
            op: "remove_claims" satisfies LeaseOp,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { verdict: survivors, nonce: null };
    }
    throw new LeaseUnavailableError(
      `the claim this gate just appended to ${META_FOLDER} is no longer there and no live rival ` +
      `stands — the write was lost, and the gate will retry`,
      { op: "renew_claim" },
    );
  }

  // The header's third rule: the displaced are not rivals. `ref` is compared by value identity
  // (a uid, or a fake harness's int); a claim with no ref cannot have been displaced.
  const displacedRefs = new Set(verdict.displace);
  const confirmed = decideLease({
    self: { ...self, lastNonce: nonce },
    claims: verifyClaims.filter((c) => c.ref === undefined || !displacedRefs.has(c.ref)),
    now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
  });

  if (confirmed.verdict !== "organize") {
    const ours = verifyClaims
      .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
      .map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined);
    if (ours.length > 0) {
      try {
        await io.removeClaims(ours);
      } catch (err) {
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log("lease_lost_race", { verdict: confirmed.verdict });
    return { verdict: confirmed, nonce: null };
  }

  // WHAT THIS WIN DISPLACED, plus our own older copies. One expunge, so a takeover cannot land
  // half-applied — leaving the beaten claim behind is what made a takeover reverse itself on the
  // next cycle, and leaving our own older copies behind is the append-then-expunge residue readers
  // coalesce away.
  // A best-effort release of a set of refs — the failure mode of every release: logged, never
  // thrown, because a cleanup must not convert the state it is cleaning into a fault.
  const releaseRefs = async (refs: readonly unknown[]): Promise<void> => {
    if (refs.length === 0) return;
    try {
      await io.removeClaims(refs);
    } catch (releaseErr) {
      log("lease_release_failed", {
        op: "remove_claims" satisfies LeaseOp,
        err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
  };

  const toRemove = [...ourRefs, ...verdict.displace];
  if (toRemove.length > 0) {
    let removalErr: unknown = null;
    try {
      await io.removeClaims(toRemove);
    } catch (err) {
      if (verdict.displace.length === 0) {
        // An ORDINARY renew's failed cleanup is harmless: the folder holds our new claim plus
        // our own older copies, and readers coalesce by newest heartbeat. The next renew tries
        // again.
        //
        // The bare string under `err` is deliberate, for the reason spelled out at
        // `lease_release_failed` above: `log.ts` special-cases `err` into `describeError`, a
        // string has no `name`/`code`, so this emits `errorClass: "String"` and nothing else.
        // Passing the error object instead would hand a redactor an IMAP driver error that can
        // carry the failing command and the credential.
        log("lease_cleanup_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
        });
      } else {
        // A TAKEOVER's removal is judged by the re-read below, not by what the driver reported:
        // a removal can fail after PARTIALLY landing (the STORE applied, the EXPUNGE refused),
        // so "it threw" proves neither that the incumbent stands nor that it fell. Held, not
        // thrown, until the folder has been looked at.
        removalErr = err;
      }
    }

    // ── THE HANDOVER IS VERIFIED BY CUSTODY, NOT ASSUMED FROM THE DRIVER ─────────────────────
    //
    // Takeovers only (a non-empty displace list): the folder is re-read and BOTH halves of the
    // handover must hold — every displaced ref actually absent, and our own appended claim
    // actually present. Neither follows from the removal's outcome. imapflow's `messageDelete`
    // is STORE-then-EXPUNGE and returns the EXPUNGE's verdict, so a refused STORE under a no-op
    // EXPUNGE resolves `true` with the message still there; the reverse partial (STORE applied,
    // EXPUNGE refused) rejects with the message already doomed; and a shared EXPUNGE on a
    // non-UIDPLUS server can take flagged messages this gate never named — including, through a
    // racing clone's release, the claim this gate just wrote. An ordinary renew's cleanup keeps
    // trusting the resolve: its leftovers are our own duplicates, which readers coalesce and
    // the next renew retries — not worth a FETCH per cycle per mailbox.
    //
    // The re-read has its OWN failure path, deliberately: a FETCH that rejects after a removal
    // that may well have landed is a read fault, not a failed expunge — rolling our claim back
    // on it could leave the folder with NO claim at all after a fully successful displacement,
    // handing the mailbox back to whoever returns first. So a read failure here throws
    // `list_claims`, rolls nothing back, and the next gate's election sorts the folder out from
    // whatever actually survived.
    if (verdict.displace.length > 0) {
      let read: GateRead;
      try {
        read = await readClaims(() => io.listClaims());
      } catch (err) {
        throw new LeaseUnavailableError(
          `the organizer lease in ${META_FOLDER} could not be re-read after the handover was ` +
          `recorded, so the takeover cannot be confirmed this cycle`,
          { op: "list_claims", cause: err },
        );
      }
      const after = read.records;
      const afterClaims = after
        .map((m) => parseClaim(m.raw, m.ref))
        .filter((c): c is ClaimRecord => c !== null);
      const ownStanding = afterClaims
        .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId && c.nonce === nonce);
      const stillRefs = new Set(after.map((m) => m.ref));
      /* ── AN ABSENCE IS ONLY EVIDENCE FOR A REF THE WINDOW ACTUALLY COVERED ──────────────────
       *
       * This is a CUSTODY check — "is the claim I displaced really gone" — and it is the one place
       * in the gate where a truncated read cannot simply be worked with. The election can act on the
       * newest N because it is choosing between what it can see. This is asking about SPECIFIC OLD
       * REFS, and old is exactly what a newest-first window drops: a displaced claim outside the
       * window is absent from `stillRefs` for the same reason a successfully expunged one is, and
       * reading that as success would confirm a handover that never landed — spending the caller's
       * one-shot authorization while the beaten claim stands to win the next election.
       *
       * UIDs ascend with arrival, so the newest-N window covers the HIGHEST uids: a ref below the
       * window's own floor is one this read could not have seen. Such a ref is treated exactly as a
       * SURVIVOR is — the handover is not confirmed this cycle — because "still there" and "I could
       * not look" have the same correct answer here, even though they are different facts. */
      /* ── AND A UIDVALIDITY CHANGE MAKES THE COMPARISON MEANINGLESS ALTOGETHER ─────────────
       *
       * Refs are UIDs, and a UID means nothing across a UIDVALIDITY change: the server has
       * renumbered the folder, so a ref the election recorded names a different message now, or
       * none. `stillRefs.has(r)` is then a comparison between two different numbering schemes —
       * it can answer "gone" for a claim that is sitting there under a new uid, which is the same
       * false confirmation the coverage rule exists to prevent, arrived at by another route.
       *
       * Treated exactly as a truncated read is, because it is the same fact: this read cannot
       * speak about those refs. `null` on either side means the connection does not report the
       * generation, which resolves to "no change detected" and leaves the gate as it was. */
      const renumbered = read.uidValidity !== null
        && electionUidValidity !== null
        && read.uidValidity !== electionUidValidity;
      /* An absence is only evidence for a ref the window COVERED — and the check is gated on
       * `truncated` so the floor is a real observation rather than a sentinel doing the work. On a
       * complete read there is nothing to prove: every ref that exists is in `after`. */
      const unprovable = read.truncated || renumbered
        ? verdict.displace.find((r) => {
          if (stillRefs.has(r)) return false;
          if (renumbered) return true;
          const floor = after.reduce<number>(
            (lo, m) => (typeof m.ref === "number" && m.ref < lo ? m.ref : lo), Infinity,
          );
          return !(typeof r === "number" && Number.isFinite(floor) && r >= floor);
        })
        : undefined;
      const survivor = verdict.displace.find((r) => stillRefs.has(r)) ?? unprovable;

      if (ownStanding.length === 0) {
        // Our claim did not survive the cleanup — a racing release under our id, or the shared
        // EXPUNGE taking more than the named refs. A live foreign winner is reported as the
        // loss it is, anything else is a lost write to retry — the same two arms as the
        // verify's own vanished-claim guard, and the same release: any OLDER claim of ours the
        // partial cleanup left behind goes too, or the stopped install's residue obstructs the
        // winner for the whole staleness window.
        log("lease_lost_race", { verdict: "own_claim_missing" });
        const survivors = decideLease({
          self,
          claims: afterClaims,
          now,
          ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
        });
        if (survivors.verdict === "stand_down") {
          await releaseRefs(afterClaims
            .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
            .map((c) => c.ref)
            .filter((r): r is unknown => r !== undefined));
          return { verdict: survivors, nonce: null };
        }
        throw new LeaseUnavailableError(
          `the claim this gate appended to ${META_FOLDER} did not survive the handover's ` +
          `cleanup and no live rival stands — the write was lost, and the gate will retry`,
          { op: "remove_claims", ...(removalErr !== null ? { cause: removalErr } : {}) },
        );
      }

      if (survivor !== undefined) {
        // The beaten claim still stands while ours does too. Confirming would spend the
        // caller's one-shot authorization on a win the next election reverses on incumbency —
        // the one-click verb that appears to do nothing, again. Our own appended claim is
        // rolled back, best effort, so the retry re-enters the folder as it found it: left
        // standing, our fresh claim wins the NEXT gate outright wherever the beaten claim is
        // weaker — continuation, with an empty displace list — and the displacement this cycle
        // still owes is never attempted again while the authorization is spent on the
        // continuation.
        await releaseRefs(ownStanding.map((c) => c.ref).filter((r): r is unknown => r !== undefined));
        throw new LeaseUnavailableError(
          `the organizer handover in ${META_FOLDER} could not be recorded (a displaced claim ` +
          `survived the expunge), so the takeover did not complete`,
          { op: "remove_claims", ...(removalErr !== null ? { cause: removalErr } : {}) },
        );
      }

      // ── AND THE ELECTION IS RE-RUN OVER WHAT ACTUALLY STANDS ─────────────────────────────
      //
      // The displaced refs being gone is necessary, not sufficient: an incumbent that RENEWED
      // between the verify read and the cleanup wrote a NEW message the displace list never
      // named — its old uid is gone (we expunged it), its renewal is live, and confirming over
      // uid absence alone would spend the authorization on a win the very next election
      // reverses on incumbency. The renewal is proof of an actively live peer, so it wins here
      // exactly as it wins in the verify: our claim is released and the loss is reported as
      // held-by-them, and the press retries rather than steamrolling a live renewal.
      const finalElection = decideLease({
        self: { ...self, lastNonce: nonce },
        claims: afterClaims,
        now,
        ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
      });
      if (finalElection.verdict !== "organize") {
        await releaseRefs(afterClaims
          .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
          .map((c) => c.ref)
          .filter((r): r is unknown => r !== undefined));
        log("lease_lost_race", { verdict: finalElection.verdict });
        return { verdict: finalElection, nonce: null };
      }

      // Custody holds: the displaced are gone and our claim stands — the handover landed,
      // whatever the driver reported on the way. A held removal error is downgraded to the
      // renew-cleanup log line: it described a write whose effect the re-read has now seen.
      if (removalErr !== null) {
        log("lease_cleanup_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: removalErr instanceof Error ? removalErr.message : String(removalErr),
        });
      }
    }
  }
  return { verdict, nonce };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  LAYER 4: REQUESTS — A READER'S DECISION, WAITING FOR THE ORGANIZER (0.14.1)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The claim answers "who organizes this mailbox". A request answers a narrower question: "what
// did a READER decide, and has the organizer taken it yet". Both live in `ohmail/_meta` — it is
// the only medium two installs share — and both FETCH in the same round trip a cycle already
// pays for the claim, because the discriminator (`X-Ohmail-Request: 1` vs `X-Ohmail-Lease: 1`) is
// read off the SAME header block {@link parseClaim} already ignores a request record on (it
// returns `null` for any message without `X-Ohmail-Lease: 1`, and a request record never carries
// that header).
//
// A request record is HEADERS-ONLY, like a claim, and for the same reason: the payload is a
// customer's own screener decision — bounded, validated by the same function the organizer's own
// door validates with — never free text a stranger's mail client could inject into. It travels
// base64url-encoded in `X-Ohmail-Request-Payload` so a value containing a colon, a CRLF or a
// header-folding space cannot be misread as a second header.

/** The one capability a request record needs from the organizer. See {@link CAPABILITY_REQUESTS}. */
const RH = {
  request: "X-Ohmail-Request",
  requestId: "X-Ohmail-Request-Id",
  requestKind: "X-Ohmail-Request-Kind",
  /**
   * WHICH MAILBOX THE DECISION IS ABOUT, and it is inside the signed body deliberately. An
   * organizer applies a record only when this equals the mailbox whose folder it
   * read the record FROM — so a record lifted out of one mailbox's `_meta` and appended to
   * another's is refused rather than applied to whichever mailbox happened to be draining.
   */
  mailboxId: "X-Ohmail-Request-Mailbox",
  installId: "X-Ohmail-Install-Id",
  organizerKind: "X-Ohmail-Organizer-Kind",
  decidedAt: "X-Ohmail-Decided-At",
  protocol: "X-Ohmail-Protocol",
  payload: "X-Ohmail-Request-Payload",
  /** HMAC-SHA256 over {@link canonicalRequest}, base64url. The whole of the record's authenticity. */
  sig: "X-Ohmail-Request-Sig",
} as const;

/**
 * The request record's own protocol — independent of {@link CLAIM_PROTOCOL}, additive the same way.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A CONSTRAINT ON WHOEVER RAISES THIS NUMBER, WRITTEN DOWN WHILE IT IS STILL FREE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **"Additive the same way" does not extend to the ACKNOWLEDGEMENT's fields.** {@link parseAck}
 * hard-requires `X-Ohmail-Request-Mailbox` and folds it into {@link canonicalAck} unconditionally,
 * so the acknowledgement's signed shape is fixed at this protocol number. Two consequences follow,
 * and neither is visible from the parser alone:
 *
 *  · **An ack field added later is a BREAKING change, not an additive one.** Fold a new field into
 *    the canonical bytes and every acknowledgement written by a build that predates it fails
 *    verification — not "is ignored", fails — because the two sides hash different strings. Both
 *    installs in a pair are then telling each other that genuine records are unauthenticated.
 *  · So the field goes in behind a protocol BUMP, and the parser that ships with the bump has to
 *    read the OLDER shape tolerantly: canonicalize by the ack's own declared protocol, so a
 *    protocol-1 ack keeps hashing the protocol-1 field list. A build that verifies only the newest
 *    shape cannot be deployed to one side of a pair at a time, which is the only way it ever gets
 *    deployed.
 *
 * This costs nothing today: the field has been required since the acknowledgement existed, and no
 * released build writes an ack without it, so there is no older shape in the wild to be tolerant of
 * yet. That is precisely why it is recorded now rather than discovered by the first build that
 * needs a second field.
 */
export const REQUEST_PROTOCOL = 1;

/**
 * THE WIRE CEILING ON `X-Ohmail-Request-Payload`, once base64url-encoded.
 *
 * A customer's own screener decision is small (a scope, a decision, an address or a domain, a
 * destination folder) and this is generous against it — the ceiling exists to keep a malformed or
 * hostile payload from growing an RFC822 header without bound, not to accommodate a legitimate
 * decision that is close to it. `formatRequest` refuses to write past it rather than truncate,
 * because a truncated payload is a payload that decodes to something the sender never decided.
 */
export const REQUEST_PAYLOAD_MAX_BYTES = 4096;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ORIGIN AUTHENTICATION — the signature, and the canonical bytes it is taken over
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A request record is a message in a shared IMAP folder. Anyone with APPEND rights on the mailbox
 * can write one; nothing in the wire format distinguishes this account's own reader from a
 * stranger, because a forger writes the wire format too. The ONLY thing that distinguishes them is
 * a secret the two installs share and a forger does not — and it is DERIVED, never stored and
 * never delivered: see {@link deriveRequestKey}. Every install that can open the mailbox already
 * holds the one secret that draws exactly the right boundary, because the attacker in this threat
 * model — a shared-folder grantee, a filing rule, another mail client — has folder rights and no
 * password.
 *
 * **This paragraph described a stored `account_settings.request_key` handed to an install that
 * proved it held an account session. That design was REFUSED and is not what ships.** It cannot
 * work here: a single install is either session-bearing or IMAP-bearing and never both, so the
 * process that appends or verifies a record has no session to fetch a key with, and handing one to
 * a local install would mean adding a session to the sealed local artifact. The column, the route
 * and the delivery step are all gone; only this sentence survived them, which is why it is
 * corrected in place rather than deleted — a reader who finds the old design elsewhere should find
 * out here that it was withdrawn.
 *
 * ── THE CANONICAL FORM IS LENGTH-PREFIXED, AND THAT IS NOT FUSSINESS ────────────────────────
 *
 * The obvious canonical form is `fields.join("|")`. It is forgeable. `installId` and `kind` are
 * attacker-influenced strings, so a joined form lets one field's content impersonate the boundary
 * between two others: a record with `installId = "a|screener.decide"` and an empty next field can
 * produce the SAME joined string as a different, legitimate record — and one signature then
 * verifies both. The attack needs no key, only a collision in the encoding.
 *
 * Each field is therefore written as `<byte length>:<field>`, concatenated. That mapping is
 * INJECTIVE for arbitrary field content — the length prefix says exactly how far the field runs,
 * so no content can be read as a delimiter — which is the property "canonical" has to mean here.
 *
 * ── IT SIGNS THE ENCODED PAYLOAD, NOT THE DECODED OBJECT ────────────────────────────────────
 *
 * The payload component is the base64url TEXT exactly as it appears in the header, never the
 * parsed JSON. That is what makes "verify before you decode" possible at all: the organizer
 * checks the signature over bytes it has only read, and reaches `JSON.parse` on a hostile string
 * only after the record has proved it came from a holder of the key. Signing the decoded object
 * would invert that order and require parsing untrusted input to decide whether to trust it.
 */
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE KEY IS DERIVED FROM THE MAILBOX CREDENTIAL, NOT DISTRIBUTED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two installs need the same secret to sign and verify a record, and they cannot ask each other
 * for one: a LOCAL install talks only to the mail server, never to the hosted service, and that
 * seal is the product rather than an implementation detail. Handing the key out over the hosted
 * API would have meant giving the local install a session it deliberately does not have.
 *
 * They already share exactly one secret, and it is the right one: **the mailbox password**. Every
 * install that organizes or reads the mailbox holds it — it is how they open IMAP at all — and the
 * attacker this signature exists to stop does NOT: somebody with APPEND rights through a
 * shared-folder ACL, a sieve `fileinto`, or a stray client session can write to the folder without
 * ever knowing the password. The trust boundary the derivation draws is therefore the exact one
 * the threat model asks for.
 *
 * ── ROTATION IS THE PASSWORD CHANGE ITSELF ──────────────────────────────────────────────────
 *
 * There is no key id, no rotation record and no revocation call, because there is nothing stored
 * to revoke: change the password and every install derives a different key on its next cycle,
 * records signed under the old one stop verifying, and the reader expires them. A leaked password
 * yields the signing key — and it already yielded the mailbox, so nothing new is lost.
 *
 * ── NEVER STORED, DERIVED AT USE ────────────────────────────────────────────────────────────
 *
 * The result is a value in memory for the length of one cycle. Persisting it would create a second
 * copy of a credential-equivalent secret in a place the credential store does not protect, for no
 * gain: deriving costs one HKDF.
 *
 * ── AND OAUTH MAILBOXES HAVE NO KEY, WHICH IS AN HONEST ANSWER RATHER THAN A GAP ────────────
 *
 * With OAuth there is no shared secret to derive from: each install holds its own short-lived
 * token, issued to it alone. So this returns `null`, the organizer advertises no `requests`
 * capability, and a reader is refused at its own door naming the holder. Decisions on such a
 * mailbox are made on the install that organizes it.
 */
const REQUEST_KEY_INFO = "ohmail request key v1";

/**
 * THE ACCOUNT-SHARED SIGNING KEY FOR ONE MAILBOX, or `null` when there is no shared secret.
 *
 * The salt is the mailbox address, lower-cased — public and stable, which is all a salt has to be
 * here. Its job is domain separation between mailboxes: two mailboxes that happen to share a
 * password must not share a signing key, or a record from one would verify against the other.
 */
export function deriveRequestKey(o: { auth: ImapAuth; address: string }): string | null {
  const pass = (o.auth as { pass?: unknown }).pass;
  if (typeof pass !== "string" || pass === "") return null;
  const salt = o.address.trim().toLowerCase();
  if (salt === "") return null;
  return Buffer.from(hkdfSync("sha256", pass, salt, REQUEST_KEY_INFO, 32)).toString("base64url");
}

function canonicalField(v: string): string {
  return `${Buffer.byteLength(v, "utf8")}:${v}`;
}

/** The exact fields a signature covers. `payload` is the ENCODED text — see the header above. */
export interface RequestSignatureFields {
  requestId: string;
  kind: string;
  mailboxId: string;
  installId: string;
  /** ISO-8601, exactly as the header carries it — the string, never a re-formatted `Date`. */
  decidedAt: string;
  protocol: number;
  /** base64url, exactly as `X-Ohmail-Request-Payload` carries it. */
  encodedPayload: string;
}

/**
 * THE BYTES THE HMAC IS TAKEN OVER. Injective in every field (see the header): a change to any
 * one of them, including a change that only moves a character from one field into the next,
 * produces different bytes and therefore a different signature.
 */
export function canonicalRequest(f: RequestSignatureFields): string {
  return [
    f.requestId, f.kind, f.mailboxId, f.installId,
    f.decidedAt, String(f.protocol), f.encodedPayload,
  ].map(canonicalField).join("");
}

/** HMAC-SHA256 of {@link canonicalRequest} under the account's request key, base64url. */
export function signRequest(key: string, f: RequestSignatureFields): string {
  return createHmac("sha256", key).update(canonicalRequest(f), "utf8").digest("base64url");
}

/**
 * DOES THIS SIGNATURE BELONG TO THESE FIELDS UNDER THIS KEY?
 *
 * Constant-time in the comparison, through `timingSafeEqual` — a byte-at-a-time `===` on an HMAC
 * leaks how much of a guess was right, and an attacker who can append records to the folder can
 * measure the drain's response by watching which records survive a cycle. The length check before
 * it is not a leak: `timingSafeEqual` THROWS on unequal lengths rather than returning false, so
 * the guard is required for correctness, and an HMAC-SHA256's length is a constant that carries no
 * information about the key.
 *
 * Returns FALSE for every failure — a bad signature, a malformed one, an empty key — and never
 * throws. A caller must not be able to turn "this record is forged" into an exception that some
 * enclosing `catch` treats as a transient IO fault and retries.
 */
export function verifyRequestSignature(key: string, f: RequestSignatureFields, sig: string): boolean {
  if (key === "" || sig === "") return false;
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = Buffer.from(signRequest(key, f), "base64url");
    given = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== given.length || expected.length === 0) return false;
  return timingSafeEqual(expected, given);
}

/**
 * WHAT AN ORGANIZER DRAINS. Closed by `organizer_requests_kind_closed` in Postgres — the same
 * four members. `rule.*` is shaped and validated here (0.14.1's migration already carries the
 * CHECK) but has no applier until the rules-pane lane lands; a drain that meets one today refuses
 * it exactly as it refuses a kind it has never heard of. See {@link isRequestKind}.
 */
export const REQUEST_KINDS = ["screener.decide", "rule.create", "rule.update", "rule.delete"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export function isRequestKind(v: unknown): v is RequestKind {
  return typeof v === "string" && (REQUEST_KINDS as readonly string[]).includes(v);
}

export interface RequestInput {
  /** Also the row id in `organizer_requests` — the two identities are one, by design. */
  requestId: string;
  kind: RequestKind;
  /** THE MAILBOX THIS DECISION IS ABOUT. Signed, and checked against the folder it is read from. */
  mailboxId: string;
  installId: string;
  /** This install's own kind, so the organizer's drain can log who asked without a second lookup. */
  organizerKind: OrganizerKind;
  /** WHEN THE PERSON DECIDED, by the deciding door's clock — the drain applies in this order. */
  decidedAt: Date;
  protocol?: number;
  /** The decision itself. Bounded and encoded by this function; never trust it unvalidated. */
  payload: unknown;
  /**
   * THE ACCOUNT'S REQUEST KEY — required, with no unsigned path past it.
   *
   * A caller that has no key has no business writing a record: the organizer would refuse it
   * `unauthenticated`, and a reader that appends one anyway has put an unverifiable message into
   * a shared folder for nothing. `ScreenerService` and the reader's cycle both check for the key
   * BEFORE they get here — this type is what makes forgetting that a compile error rather than a
   * silent downgrade to the pre-0090 behaviour.
   */
  key: string;
}

/**
 * A REQUEST RECORD'S HEADERS, READ AND BOUNDED, WITH THE PAYLOAD STILL ENCODED.
 *
 * This is the halfway state that makes "verify before you decode" expressible. Every field here
 * has been length-checked, but NOTHING has been base64-decoded and no JSON has been parsed — so an
 * organizer can compute the signature over {@link encodedPayload} and refuse a forgery having
 * spent nothing on it but a header read.
 *
 * `kind` is NOT narrowed to {@link RequestKind}: an unrecognised kind is a record for a FUTURE
 * build, and the disposition for one is to leave it standing rather than refuse or destroy it,
 * which requires reading it far enough to know that is what it is.
 */
export interface RequestEnvelope {
  requestId: string;
  kind: string;
  /** The mailbox the decision names, from inside the signed body. */
  mailboxId: string;
  installId: string;
  organizerKind: OrganizerKind | "unknown";
  decidedAt: Date;
  /**
   * The `X-Ohmail-Decided-At` header VERBATIM. The signature covers this string, not
   * `decidedAt.toISOString()` — a `Date` round-trip normalises (`+00:00` becomes `Z`, fractional
   * seconds are re-rendered), and a normalised re-render is different bytes and therefore a
   * different HMAC. Verifying against the parsed date would refuse records this codebase wrote.
   */
  decidedAtRaw: string;
  protocol: number;
  /** base64url, UNDECODED and bounded. The signature is taken over exactly this text. */
  encodedPayload: string;
  /** `X-Ohmail-Request-Sig`, base64url. Absent reads as `""`, which never verifies. */
  sig: string;
  ref?: unknown;
}

/** A request record, envelope plus the decoded payload. See {@link decodeRequestPayload}. */
export interface RequestRecord extends RequestEnvelope {
  /** Decoded JSON. STILL UNTRUSTED — the organizer's drain validates it before applying anything. */
  payload: unknown;
}

/** A message that says it is a request and then is not parseable as one. See {@link MalformedClaim}. */
export interface MalformedRequestRecord {
  malformed: true;
  reason: string;
  ref?: unknown;
}

/** What {@link parseRequestEnvelope} answers: headers read and bounded, or evidence of a broken record. */
export type RequestEnvelopeRecord = RequestEnvelope | MalformedRequestRecord;

/** What {@link decodeRequestPayload} answers: a whole record, or a payload that would not decode. */
export type RequestMessageRecord = RequestRecord | MalformedRequestRecord;

export function isMalformedRequest(
  r: RequestEnvelopeRecord | RequestMessageRecord,
): r is MalformedRequestRecord {
  return (r as MalformedRequestRecord).malformed === true;
}

function b64urlEncode(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}
function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/**
 * One RFC822 message per outstanding decision. Mirrors {@link formatClaim}'s shape and its rule:
 * the body is a sentence for a human who opens `ohmail/_meta`, and carries no information the
 * headers do not.
 *
 * ── A UNIT TEST PINS THAT THIS NEVER COLLIDES WITH A CLAIM OR A PROFILE RECORD ─────────────
 *
 * `organizer-request.test.ts` asserts the output of this function never contains
 * `X-Ohmail-Lease` or `X-Ohmail-Profile` — the two other record types this folder holds. A
 * request record that accidentally carried either header would be read as evidence of a DIFFERENT
 * kind of record by a reader that checks discriminators in a different order than this file does.
 */
export function formatRequest(r: RequestInput): string {
  const protocol = r.protocol ?? REQUEST_PROTOCOL;
  const encoded = b64urlEncode(JSON.stringify(r.payload ?? null));
  if (encoded.length > REQUEST_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `request payload for ${r.requestId} is ${encoded.length} bytes encoded, over the `
      + `${REQUEST_PAYLOAD_MAX_BYTES}-byte ceiling — refused rather than truncated`,
    );
  }
  if (r.key === "") {
    throw new Error(
      `request ${r.requestId} cannot be written without the account's request key — an unsigned `
      + `record is refused by every organizer, so writing one would leave an unverifiable message `
      + `in a shared folder for nothing`,
    );
  }
  // SIGNED OVER THE HEADER-SAFE VALUES, not the raw inputs. `headerSafe` strips CR/LF and trims,
  // so a value that changes under it would be signed as one string and READ as another, and the
  // organizer would refuse a record this install itself wrote. The two must see identical bytes,
  // so the transformation happens once, here, and both the signature and the header use its output.
  const requestId = headerSafe(r.requestId);
  const kind = headerSafe(r.kind);
  const mailboxId = headerSafe(r.mailboxId);
  const installId = headerSafe(r.installId);
  const decidedAt = r.decidedAt.toISOString();
  const sig = signRequest(r.key, {
    requestId, kind, mailboxId, installId, decidedAt, protocol, encodedPayload: encoded,
  });
  const lines = [
    `${RH.request}: 1`,
    `${RH.requestId}: ${requestId}`,
    `${RH.requestKind}: ${kind}`,
    `${RH.mailboxId}: ${mailboxId}`,
    `${RH.installId}: ${installId}`,
    `${RH.organizerKind}: ${r.organizerKind}`,
    `${RH.decidedAt}: ${decidedAt}`,
    `${RH.protocol}: ${protocol}`,
    `${RH.payload}: ${encoded}`,
    `${RH.sig}: ${sig}`,
    `Subject: ohmail organizer request`,
    `Date: ${r.decidedAt.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    "A reader made a decision on this mailbox and is waiting for the install that organizes it to",
    "apply it. This message is bookkeeping — deleting it before that happens loses the decision.",
    "",
  ];
  return lines.join("\r\n");
}

/**
 * Read the headers of one message as a request record. Returns `null` when it is not a request at
 * all (a claim, a profile record, or a stray) — mirrors {@link parseClaim}'s discriminator rule
 * exactly, including the duplicate-header refusal: a record that announces itself twice and
 * disagrees with itself is evidence of a request that cannot be trusted, not an absent one.
 */
/**
 * Does this message CLAIM to be a request record? A header test, and deliberately nothing more.
 *
 * `ohmail/_meta` is shared with the lease's claims and the portable profile, so a caller that
 * counts messages is not counting requests. This is the negative {@link requestEnvelopesIn} uses
 * to sort one shared read into its kinds; {@link parseRequestEnvelope} — which re-reads the same
 * header and returns `null` for anything that is not a request — stays the authority on whether
 * one is WELL FORMED. A record this returns `true` for can still be malformed, and must still be
 * parsed.
 */
export function isRequestRecord(raw: string): boolean {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  let seen = 0;
  let anyIsOne = false;
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    if (line.slice(0, at).trim().toLowerCase() !== RH.request.toLowerCase()) continue;
    seen += 1;
    if (line.slice(at + 1).trim() === "1") anyIsOne = true;
  }
  // ── IT MUST NOT DISAGREE WITH THE PARSER ABOUT WHAT IS A REQUEST ─────────────────────────
  //
  // This returned on the FIRST occurrence while {@link parseRequestEnvelope} refuses DUPLICATES
  // outright. So `X-Ohmail-Request: 0` followed by `X-Ohmail-Request: 1` answered `false` here,
  // the message never reached the parser, and the `malformed` disposition — the only thing that
  // would have put its ref on the removal list — was unreachable. One APPEND bought a message
  // that every drain, every reader cycle and both lease reads re-fetch and re-parse for ever,
  // with no log line and no way to get rid of it.
  //
  // A REPEATED header is therefore always handed on, whatever its values, so the parser can
  // refuse it and the drain can remove it. A single occurrence still has to say `1`.
  return seen > 1 || anyIsOne;
}

export function parseRequestEnvelope(raw: string, ref?: unknown): RequestEnvelopeRecord | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    headers.set(name, line.slice(at + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const get = (k: string): string | undefined => headers.get(k.toLowerCase());
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;
  const malformed = (reason: string): MalformedRequestRecord =>
    ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };

  if (count(RH.request) > 1) return malformed("duplicate request header");
  if (get(RH.request) !== "1") return null; // not a request — a claim, a profile record, or a stray

  for (const field of [
    RH.requestId, RH.requestKind, RH.mailboxId, RH.installId, RH.organizerKind, RH.decidedAt,
    RH.protocol, RH.payload, RH.sig,
  ]) {
    if (count(field) > 1) return malformed(`duplicate ${field}`);
  }

  /**
   * BOUNDED BEFORE ANYTHING ELSE READS THEM. A record is another install's input — or, until the
   * request channel is authenticated, the input of ANYONE with APPEND rights on this folder — so
   * every field gets a length ceiling before it is used for anything, including as a component of
   * the idempotency key downstream.
   */
  const requestId = get(RH.requestId);
  if (!requestId || requestId.length > 128) return malformed("no or oversized request id");

  const kind = get(RH.requestKind);
  if (!kind || kind.length > 64) return malformed("no or oversized request kind");

  // Bounded like its neighbours even though a legitimate value is always a 36-character uuid: this
  // is a stranger's input until the signature says otherwise, and the comparison the drain makes
  // against its own mailbox id must not be handed an unbounded string to walk.
  const mailboxId = get(RH.mailboxId);
  if (!mailboxId || mailboxId.length > 128) return malformed("no or oversized mailbox id");

  const installId = get(RH.installId);
  if (!installId || installId.length > 256) return malformed("no or oversized install id");

  const organizerKindRaw = (get(RH.organizerKind) ?? "").toLowerCase();
  const organizerKind: OrganizerKind | "unknown" =
    organizerKindRaw === "local" || organizerKindRaw === "cloud" ? organizerKindRaw : "unknown";

  const protocolRaw = get(RH.protocol);
  const protocol = Number(protocolRaw);
  if (!protocolRaw || !Number.isFinite(protocol) || protocol < 1) return malformed("unreadable protocol");

  const decidedAtRaw = get(RH.decidedAt) ?? "";
  const decidedAt = new Date(decidedAtRaw);
  if (Number.isNaN(decidedAt.getTime())) return malformed("unreadable decided-at");

  const encoded = get(RH.payload);
  if (!encoded) return malformed("no payload");
  // BOUNDED BEFORE DECODING, and the rule is stated as a size test on the ENCODED text: "encoded.length >
  // REQUEST_PAYLOAD_MAX_BYTES refused before decoding". A record whose header claims a payload
  // past the write side's own ceiling is refused on the length ALONE, so a hostile record cannot
  // spend a base64 decode plus a `JSON.parse` over an attacker-chosen number of bytes — the read
  // side must not trust that every writer honours `formatRequest`'s own refusal to write past it.
  if (encoded.length > REQUEST_PAYLOAD_MAX_BYTES) return malformed("payload exceeds the byte ceiling");

  // ── AND THIS IS WHERE THE READ STOPS ────────────────────────────────────────────────────────
  //
  // No `b64urlDecode`, no `JSON.parse`. The payload is still exactly the text the header carried,
  // which is the text the signature covers, and the caller's next move is to VERIFY — see
  // {@link decodeRequestPayload}, which is the only way past this point and takes a verified
  // envelope to get there. An absent signature reads as `""` rather than as a malformation,
  // because "no signature" is not a broken record: it is an UNAUTHENTICATED one, and the refusal
  // it earns says so by name.
  const sig = get(RH.sig) ?? "";
  const envelope: RequestEnvelope = {
    requestId, kind, mailboxId, installId, organizerKind,
    decidedAt, decidedAtRaw, protocol, encodedPayload: encoded, sig,
  };
  return ref === undefined ? envelope : { ...envelope, ref };
}

/**
 * IS THIS ENVELOPE SIGNED BY A HOLDER OF THE ACCOUNT'S KEY? The one question that stands between
 * a message in a shared folder and somebody's mail being filed.
 *
 * Split from {@link parseRequestEnvelope} rather than folded into it because the two have
 * different inputs and different failure meanings: parsing needs only the message, verification
 * needs the account's secret, and a record that parses but does not verify is a FORGERY rather
 * than a malformation. Keeping them apart is also what lets the reader's own cycle read a folder
 * without ever being handed a decode of someone else's payload.
 */
export function verifyRequestEnvelope(e: RequestEnvelope, key: string): boolean {
  return verifyRequestSignature(key, {
    requestId: e.requestId, kind: e.kind, mailboxId: e.mailboxId, installId: e.installId,
    decidedAt: e.decidedAtRaw, protocol: e.protocol, encodedPayload: e.encodedPayload,
  }, e.sig);
}

/**
 * DECODE THE PAYLOAD OF AN ENVELOPE THAT HAS ALREADY BEEN VERIFIED.
 *
 * **The caller owes the verification; this function cannot check it and does not pretend to.** It
 * is separate so that the ORDER is visible at the call site — an organizer's drain reads
 * `verify… then decode…` in sequence, and a future edit that removes the first line leaves an
 * obviously unguarded second one rather than a silently weakened single call.
 *
 * The result is STILL UNTRUSTED CONTENT. A verified signature proves the record came from a
 * holder of this account's key; it proves nothing about whether the decoded object is a decision
 * this build knows how to apply. `validateRequestPayload` is what answers that, after this.
 */
export function decodeRequestPayload(e: RequestEnvelope): RequestMessageRecord {
  const malformed = (reason: string): MalformedRequestRecord =>
    e.ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref: e.ref };
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(e.encodedPayload));
  } catch {
    return malformed("unreadable payload");
  }
  return { ...e, payload };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  LAYER 4b: ACKS — WHAT THE ORGANIZER SAID, CARRIED BACK (0.14.1)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// ── ABSENCE WAS THE BUG, AND IT WAS A BUG ABOUT TRUTH RATHER THAN ABOUT PLUMBING ─────────────
//
// 0088's reader inferred `applied` from a record's ABSENCE from the folder. But an organizer
// removes a record for two opposite reasons — it applied it, or it REFUSED it — and expunges in
// both cases. So a person who screened a sender out was told "done" whether their decision had
// been carried out or thrown away for being malformed, stale, or about the wrong mailbox. Absence
// is not evidence, and no amount of care on the reader's side could make it into evidence.
//
// An ack is the evidence. The organizer appends one naming the request and the OUTCOME, and the
// reader moves its row only on an ack it can read: `applied`, or `refused` with a reason it can
// show the person. A `sent` row with no ack at all stays `sent` until the stale window expires it.
//
// ── THE ACK IS SIGNED, FOR THE SAME REASON THE REQUEST IS ────────────────────────────────────
//
// A forged ack is not a harmless lie. `applied` on a decision nobody applied tells a person their
// Screener rule exists when it does not, and the mail keeps arriving where they told it not to;
// `refused` on one that WAS applied invites them to press again. Both installs already hold the
// account's key, so signing this direction too costs one HMAC and closes the return path.

const AH = {
  ack: "X-Ohmail-Ack",
  requestId: "X-Ohmail-Request-Id",
  mailboxId: "X-Ohmail-Request-Mailbox",
  outcome: "X-Ohmail-Ack-Outcome",
  reason: "X-Ohmail-Ack-Reason",
  ackedAt: "X-Ohmail-Ack-At",
  protocol: "X-Ohmail-Protocol",
  sig: "X-Ohmail-Ack-Sig",
} as const;

/**
 * WHY AN ORGANIZER SAID NO — a CLOSED set this codebase defines, never a sentence a payload
 * supplied. It reaches a person's screen through `pendingDecisions[]`, so an open vocabulary here
 * would be a stranger's text rendered in the product's own voice.
 */
export const REQUEST_REFUSAL_REASONS = [
  /** No signature, or one that does not verify under this account's key. A forgery, or a rotation. */
  "unauthenticated",
  /** The id is already spent by a record with DIFFERENT content — a reused id never applies. */
  "conflict",
  /** The record names a mailbox other than the one whose folder it was read from. */
  "wrong_mailbox",
  /** Verified, decoded, and not a decision this build can apply. */
  "invalid_payload",
  /** The wire format itself is broken — it says it is a request and then is not one. */
  "malformed",
  /** A kind with no applier here. Distinct from `malformed`: the record is well formed. */
  "unhandled_kind",
  /** Older than the window a reader would itself have expired it at. */
  "stale",
  /** The account has been erased; there is nothing left to apply it to. */
  "account_erased",
] as const;
export type RequestRefusalReason = (typeof REQUEST_REFUSAL_REASONS)[number];

export function isRequestRefusalReason(v: unknown): v is RequestRefusalReason {
  return typeof v === "string" && (REQUEST_REFUSAL_REASONS as readonly string[]).includes(v);
}

export const ACK_OUTCOMES = ["applied", "refused"] as const;
export type AckOutcome = (typeof ACK_OUTCOMES)[number];

export interface AckInput {
  requestId: string;
  /** The mailbox this answer belongs to. Signed, so an ack cannot be moved between mailboxes. */
  mailboxId: string;
  outcome: AckOutcome;
  /** Required for `refused`, and meaningless for `applied` — the formatter writes `""` for it. */
  reason?: RequestRefusalReason;
  ackedAt: Date;
  protocol?: number;
  key: string;
}

export interface AckRecord {
  requestId: string;
  mailboxId: string;
  outcome: AckOutcome;
  /** `null` on an `applied` ack, and on a `refused` one whose reason this build does not know. */
  reason: RequestRefusalReason | null;
  ackedAt: Date;
  protocol: number;
  ref?: unknown;
}

/** Does this message CLAIM to be an ack? The cheap negative, mirroring {@link isRequestRecord}. */
export function isAckRecord(raw: string): boolean {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    if (line.slice(0, at).trim().toLowerCase() !== AH.ack.toLowerCase()) continue;
    return line.slice(at + 1).trim() === "1";
  }
  return false;
}

/**
 * THE ACK COVERS ITS MAILBOX TOO, for the reason the request does.
 *
 * Without it an acknowledgement was portable between an account's mailboxes: copy a genuine record
 * for request X into mailbox A, let A's organizer refuse it `wrong_mailbox` and sign an ack for X,
 * then copy that ack into mailbox B's folder — where it verifies (same account key) and, arriving
 * at a lower uid than B's own answer, wins the reader's first-wins match. The person is shown a
 * refusal for a decision that WAS applied, presses again, and a second rule is written.
 */
function canonicalAck(f: {
  requestId: string; mailboxId: string; outcome: string; reason: string;
  ackedAt: string; protocol: number;
}): string {
  return [f.requestId, f.mailboxId, f.outcome, f.reason, f.ackedAt, String(f.protocol)]
    .map(canonicalField).join("");
}

/**
 * ONE RFC822 MESSAGE SAYING WHAT BECAME OF ONE REQUEST. Carries no payload and no copy of the
 * decision: a reader looking one up already holds the row, and repeating the decision here would
 * put a second copy of a customer's content in the folder for no reader that needs it.
 */
export function formatAck(a: AckInput): string {
  if (a.key === "") {
    throw new Error(
      `ack for ${a.requestId} cannot be written without the account's request key — an unsigned `
      + `ack is refused by every reader, so writing one would tell nobody anything`,
    );
  }
  const protocol = a.protocol ?? REQUEST_PROTOCOL;
  const requestId = headerSafe(a.requestId);
  const mailboxId = headerSafe(a.mailboxId);
  const reason = a.outcome === "refused" ? (a.reason ?? "malformed") : "";
  const ackedAt = a.ackedAt.toISOString();
  const sig = createHmac("sha256", a.key)
    .update(canonicalAck({ requestId, mailboxId, outcome: a.outcome, reason, ackedAt, protocol }), "utf8")
    .digest("base64url");
  const lines = [
    `${AH.ack}: 1`,
    `${AH.requestId}: ${requestId}`,
    `${AH.mailboxId}: ${mailboxId}`,
    `${AH.outcome}: ${a.outcome}`,
    `${AH.reason}: ${reason}`,
    `${AH.ackedAt}: ${ackedAt}`,
    `${AH.protocol}: ${protocol}`,
    `${AH.sig}: ${sig}`,
    `Subject: ohmail organizer acknowledgement`,
    `Date: ${a.ackedAt.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    "The install that organizes this mailbox has answered a decision another install made. This",
    "message is bookkeeping and is cleaned up automatically.",
    "",
  ];
  return lines.join("\r\n");
}

/**
 * READ AND VERIFY AN ACK IN ONE STEP — deliberately unlike the request path, and the asymmetry is
 * the point.
 *
 * A request is split into parse-then-verify because the ORGANIZER must not decode a hostile
 * payload before it trusts the record. An ack carries no payload: there is nothing to decode and
 * therefore no expensive or dangerous second half to protect. Folding verification in means the
 * reader's state machine cannot be handed an unverified ack at all — the type it receives has
 * already been checked, so there is no order for a later edit to get wrong.
 *
 * Returns `null` for "not an ack" and for "an ack that does not verify" alike. A reader treats
 * both as silence, which is the correct disposition: an unverifiable ack is not evidence, and the
 * `sent` row it names simply waits for a real one or for the stale window.
 */
export function parseAck(raw: string, key: string, ref?: unknown): AckRecord | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    headers.set(name, line.slice(at + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const get = (k: string): string => headers.get(k.toLowerCase()) ?? "";
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;

  // DUPLICATES FIRST, then the discriminator — the order `parseClaim` and
  // `parseRequestEnvelope` both use. Reading the discriminator first meant a message carrying two
  // `X-Ohmail-Ack` headers resolved last-wins instead of being refused, so a record that
  // contradicts itself could still be read as an outcome.
  for (const f of [AH.ack, AH.requestId, AH.mailboxId, AH.outcome, AH.reason, AH.ackedAt, AH.protocol, AH.sig]) {
    if (count(f) > 1) return null;
  }
  if (get(AH.ack) !== "1") return null;

  const requestId = get(AH.requestId);
  if (!requestId || requestId.length > 128) return null;
  const mailboxId = get(AH.mailboxId);
  if (!mailboxId || mailboxId.length > 128) return null;
  const outcome = get(AH.outcome);
  if (outcome !== "applied" && outcome !== "refused") return null;
  const reason = get(AH.reason);
  if (reason.length > 64) return null;
  const ackedAtRaw = get(AH.ackedAt);
  const ackedAt = new Date(ackedAtRaw);
  if (Number.isNaN(ackedAt.getTime())) return null;
  const protocolRaw = get(AH.protocol);
  const protocol = Number(protocolRaw);
  if (!protocolRaw || !Number.isFinite(protocol) || protocol < 1) return null;

  const sig = get(AH.sig);
  if (key === "" || sig === "") return null;
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = Buffer.from(
      createHmac("sha256", key)
        .update(canonicalAck({ requestId, mailboxId, outcome, reason, ackedAt: ackedAtRaw, protocol }), "utf8")
        .digest("base64url"),
      "base64url",
    );
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== given.length || expected.length === 0) return null;
  if (!timingSafeEqual(expected, given)) return null;

  const record: AckRecord = {
    requestId,
    mailboxId,
    outcome,
    // An unrecognised reason becomes `null` rather than being carried through as a string: it
    // would otherwise reach a person's screen, and this vocabulary is the product's own.
    reason: isRequestRefusalReason(reason) ? reason : null,
    ackedAt,
    protocol,
  };
  return ref === undefined ? record : { ...record, ref };
}

/**
 * WHICH REQUEST OPERATION FAILED. Mirrors {@link LeaseOp} and for the same reason: a catch that
 * wraps more than one IMAP command must name which one threw.
 */
export type RequestOp =
  | "list_requests"
  | "append_request"
  | "remove_requests"
  /**
   * SEARCH + EXPUNGE the acknowledgements past their life. Its own op rather than
   * {@link remove_requests} because the two fail for different reasons and an operator reading
   * "requests could not be removed" would go looking at the drain: this is the COMPACTOR, the only
   * thing that ever makes `ohmail/_meta` smaller, and a folder that stops shrinking is the fault
   * worth naming on its own.
   */
  | "sweep_acks"
  | "no_request_io";

export class RequestUnavailableError extends Error {
  readonly op: RequestOp;
  constructor(message: string, options: { op: RequestOp; cause?: unknown }) {
    super(message, options);
    this.name = "RequestUnavailableError";
    this.op = options.op;
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE FOLDER, READ ONCE — and the two ROLES that read it
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── ONE FETCH, THREE PARSERS ────────────────────────────────────────────────────────────────
 *
 * `ohmail/_meta` holds three kinds of record — claims, requests and acks — and the module header
 * has claimed since the channel shipped that they come off "the same headers FETCH in one round
 * trip". {@link listMetaRecords} sorts one read into its kinds, and the claim, request and ack
 * parsers all run over ITS output, so a fourth record type costs no round trip at all.
 *
 * **The loop underneath is shared too, and saying so is a correction.** This block used to say the
 * sentence above was "now true rather than aspirational" while three separate `FETCH 1:*` loops —
 * this one, the lease gate's and the read-only peek's — still stood in the module, each with its
 * own copy of the ceiling and the empty-folder defence, and two of the three keeping the OLDEST
 * records when the ceiling bit. They are one function now ({@link readMetaFolderWindow}), and a
 * census test pins the two `client.fetch(` calls that remain — the window and the `*` count probe,
 * both inside the shared read — to keep the claim honest.
 *
 * ── AND TWO OBJECTS, BECAUSE A READER MUST NOT BE ABLE TO EXPUNGE ───────────────────────────
 *
 * The IMAP verbs split cleanly by role: a READER appends its own decisions and never removes
 * anything (its whole write surface on this folder is one APPEND); an ORGANIZER removes what it
 * has handled and appends acks, and never writes a request. Holding both sets on one object made
 * the organizer's expunge reachable from the reader's own accessor — separated only by which
 * function the caller happened to call, which is not a boundary. These are two types, so a
 * reader's object does not HAVE a remove to reach for and the compiler says so.
 */
export interface RawMetaMessage {
  ref: unknown;
  raw: string;
}

/**
 * THE CEILING ON ONE FOLDER READ.
 *
 * Every legitimate population of `ohmail/_meta` is tiny: one claim per install, one acknowledgement
 * per decision still in flight, and the decisions themselves — which the drain removes as it
 * handles them. This is far above all of that, because its job is to stop anyone with APPEND rights
 * on the folder choosing how much work a cycle does, not to be tight.
 *
 * It bounds ONE READ, and it is not a filter: passing it does not drop records, it makes the read
 * REFUSE. {@link readMetaFolderWindow} explains why — a ceiling that silently keeps a subset makes
 * a partial view of this folder indistinguishable from a complete one, and every decision taken
 * from this folder is wrong on a partial view.
 */
export const META_RECORDS_MAX_PER_FETCH = 500;

/* `SEARCH_UIDS_MAX` is declared far above, beside the search it bounds, and must stay one past
 * this ceiling. Spelled as a literal there because this constant is declared later in the file;
 * pinned here so the two cannot drift apart silently — a cap BELOW the ceiling would make an
 * exactly-at-the-ceiling claim set look oversized, and one far above would put the bound back
 * where it cannot do its job. */
const _searchCapMatchesCeiling: SEARCH_UIDS_MAX_IS_CEILING_PLUS_ONE = true;
type SEARCH_UIDS_MAX_IS_CEILING_PLUS_ONE = typeof SEARCH_UIDS_MAX extends 501 ? true : never;
void _searchCapMatchesCeiling;

/** The shared read: the folder's headers, unfiltered and bounded — the parsers sort it out. */
export interface MetaRecordsIo {
  listMetaRecords(): Promise<RawMetaMessage[]>;
}

/** WHAT A READER MAY DO to `ohmail/_meta`: look, and append its own decisions. Nothing else. */
export interface RequestReaderIo extends MetaRecordsIo {
  /** APPEND one decision. Does NOT create `ohmail/_meta` — see {@link makeRequestReaderIo}. */
  append(raw: string): Promise<void>;
}

/** WHAT AN ORGANIZER MAY DO: look, acknowledge what it handled, and remove what it is done with. */
export interface RequestOrganizerIo extends MetaRecordsIo {
  /** APPEND one ack record saying what became of one request. */
  ack(raw: string): Promise<void>;
  /** STORE `\Deleted` + EXPUNGE the given messages, in ONE round trip. */
  remove(refs: readonly unknown[]): Promise<void>;
  /**
   * EXPUNGE every ack older than `before`, WITHOUT reading the folder first.
   *
   * The organizer's ack sweep is the only thing that ever makes `ohmail/_meta` smaller, and it sat
   * behind the bounded read — which refuses a folder over the ceiling. So a folder that crossed the
   * ceiling BY ACKS could never come back down: the read refuses, the sweep never runs, the acks
   * stay, and every drain refuses for ever. The compactor was locked behind the thing it exists to
   * fix.
   *
   * Asked of the server by header and date, so it is integers in and an expunge out — no FETCH, no
   * window, bounded by construction. The sweep was already "by AGE alone", and INTERNALDATE of an
   * ack this organizer appended is its `ackedAt` to the day.
   *
   * Optional: a client that cannot search simply does not sweep, which is where it was before.
   * Returns how many were removed, for the log.
   */
  sweepStaleAcks?(before: Date): Promise<number>;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PARSER REGISTRY — one discriminator per kind, in one place
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The module header's table, as data. It exists so that adding a fifth record type to
 * `ohmail/_meta` is ONE ENTRY here plus a parser, rather than a fourth hand-written predicate that
 * every reader of the folder has to remember to consult — which is how the third one went wrong:
 * `isRequestRecord` answered on the FIRST occurrence of its header while the parser refused
 * duplicates outright, so a class of message was permanently unremovable and nothing said so.
 *
 * The `match` functions are the EXISTING predicates rather than a new uniform one, deliberately.
 * They differ in what they do with a repeated discriminator, and each difference is a decision that
 * was argued at the parser it belongs to — replacing them with one generic reader here would quietly
 * re-decide all three.
 *
 * `profile` is listed and has no matcher: its records live in this folder and are parsed by
 * `organizer-profile.ts`, which owns the document format. Listing it is what makes the count four
 * everywhere instead of three here and four in the header.
 */
export type MetaRecordKind = "claim" | "request" | "ack" | "profile";

export interface MetaRecordKindSpec {
  kind: MetaRecordKind;
  /** The header whose presence declares the kind. */
  header: string;
  /** Does this raw record declare this kind? `null` for a kind another module owns. */
  match: ((raw: string) => boolean) | null;
}

export const META_RECORD_KINDS: readonly MetaRecordKindSpec[] = [
  // A claim's matcher is the PARSER, which is the strongest form this table can take: `parseClaim`
  // answers `null` for "not a claim" and a MALFORMED claim for "says it is one and cannot be read",
  // so the two cannot disagree about a duplicated discriminator by construction. The other two
  // reached that same rule the long way, through a defect each.
  { kind: "claim", header: H.lease, match: (raw: string): boolean => parseClaim(raw) !== null },
  { kind: "request", header: RH.request, match: isRequestRecord },
  { kind: "ack", header: AH.ack, match: isAckRecord },
  // Owned by `organizer-profile.ts` — see the registry's docblock.
  { kind: "profile", header: "X-Ohmail-Profile", match: null },
];

/**
 * WHICH KIND IS THIS RECORD, or `null` for one this build does not recognise.
 *
 * `null` is a real answer and the common one: somebody else's mail client may keep something in
 * this folder, and a record we cannot name is not ours to parse, count or destroy.
 */
export function classifyMetaRecord(raw: string): MetaRecordKind | null {
  for (const spec of META_RECORD_KINDS) {
    if (spec.match !== null && spec.match(raw)) return spec.kind;
  }
  return null;
}

/** Every message in the folder that says it is a request, envelope-parsed. */
export function requestEnvelopesIn(
  records: readonly RawMetaMessage[],
): RequestEnvelopeRecord[] {
  const out: RequestEnvelopeRecord[] = [];
  for (const m of records) {
    if (classifyMetaRecord(m.raw) !== "request") continue;
    const parsed = parseRequestEnvelope(m.raw, m.ref);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** Every message in the folder that says it is an ack AND verifies under this account's key. */
export function acksIn(records: readonly RawMetaMessage[], key: string): AckRecord[] {
  const out: AckRecord[] = [];
  for (const m of records) {
    if (classifyMetaRecord(m.raw) !== "ack") continue;
    const parsed = parseAck(m.raw, key, m.ref);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * THE SHARED READ — one `FETCH 1:*` of `ohmail/_meta`'s headers, unfiltered.
 *
 * Unfiltered on purpose: the folder's three record types (claims, requests, acks) are told apart
 * by a header the caller's own parser reads, and filtering here would mean a second round trip the
 * moment a caller wants two of them. {@link requestEnvelopesIn} and {@link acksIn} are the cheap
 * negatives that sort one read into its kinds.
 *
 * ── AN ABSENT FOLDER THROWS, AND THAT IS A CORRECTNESS FIX RATHER THAN STRICTNESS ────────────
 *
 * The version this replaces answered `[]` when `ohmail/_meta` did not exist. For the organizer's
 * drain that was harmless — nothing to drain. For the READER it was not: its state machine reads
 * "my record is not in the folder" as "the organizer took it", so an absent folder told a person
 * that every decision they had made was applied, at the exact moment the evidence was that nobody
 * was organizing the mailbox at all. "I could not look" and "there is nothing there" must not be
 * reachable from one another, so this raises {@link RequestUnavailableError} and the reader
 * transitions nothing.
 */
function makeMetaRecordsList(
  client: LeaseImapClient,
  meta: MetaFolderRef,
  op: RequestOp,
): () => Promise<RawMetaMessage[]> {
  return async (): Promise<RawMetaMessage[]> => {
    let at: MetaFolderLocation;
    try {
      at = await meta.locate();
    } catch (err) {
      throw new RequestUnavailableError(
        `${META_FOLDER} could not be located`, { op, cause: err },
      );
    }
    if (at.row === null) {
      throw new RequestUnavailableError(
        `${META_FOLDER} does not exist, so nothing in it can be read`, { op },
      );
    }
    try {
      const lock = await client.getMailboxLock(at.path);
      try {
        // The shared bounded read — see {@link readMetaFolderWindow}. An empty folder is a real
        // answer and comes back as one; a folder too full for a single window is not, and falls
        // into the refusal below for the same reason an ABSENT folder does.
        const read = await readMetaFolderWindow(client, at.path);
        if (read.truncated) throw new MetaFolderTruncatedError(read.records.length, read.total, read.records);
        return read.records;
      } finally {
        lock.release();
      }
    } catch (err) {
      if (err instanceof RequestUnavailableError) throw err;
      // NAMED, not folded into the generic sentence: the count is the only thing that tells whoever
      // reads the line what is wrong, and the two drains log this message verbatim. A caller that
      // saw only "could not be read" would go looking at the mail server for a fault that is a full
      // folder.
      if (err instanceof MetaFolderTruncatedError) {
        throw new RequestUnavailableError(err.message, { op, cause: err });
      }
      throw new RequestUnavailableError(
        `the records in ${META_FOLDER} could not be read`, { op, cause: err },
      );
    }
  };
}

/**
 * THE READER'S HALF — look, and append its own decisions.
 *
 * ── IT NEVER CREATES `ohmail/_meta` ─────────────────────────────────────────────────────────
 *
 * A request is offered to a reader ONLY while a holder's claim advertises
 * {@link CAPABILITY_REQUESTS} and `organizer_state='held'` (the HTTP door's own gate, in
 * `packages/db`) — which is only ever true once an organizer has already run `ensureMetaFolder()`
 * at least once. So by the time `append` is ever called, the folder is guaranteed to exist, and
 * creating it here — the way {@link makeLeaseIo} does for a claim — would be a write this object
 * has no standing to make: a reader that could conjure the organizer's own folder into existence
 * is a reader one step from conjuring a claim into it.
 *
 * **There is no `remove` on this object and that is the point.** See {@link RequestReaderIo}.
 */
export function makeRequestReaderIo(
  client: LeaseImapClient, toServerPath: (canonical: string) => string,
): RequestReaderIo {
  const meta = makeMetaFolderRef(client, toServerPath);
  return {
    listMetaRecords: makeMetaRecordsList(client, meta, "list_requests"),
    async append(raw: string): Promise<void> {
      try {
        await client.append(await meta.path(), raw, ["\\Seen"]);
      } catch (err) {
        throw new RequestUnavailableError(
          `a decision could not be appended to ${META_FOLDER}`,
          { op: "append_request", cause: err },
        );
      }
    },
  };
}

/**
 * THE ORGANIZER'S HALF — look, acknowledge, and remove what it has handled.
 *
 * `ack` and `append` are the same IMAP verb on the same folder and are deliberately NOT one
 * method: what may be written differs by role, and a single `append(raw)` shared by both objects
 * would make a reader's accessor capable of writing an organizer's acknowledgement. The name is
 * the boundary the type system can actually hold.
 */
export function makeRequestOrganizerIo(
  client: LeaseImapClient, toServerPath: (canonical: string) => string,
): RequestOrganizerIo {
  const meta = makeMetaFolderRef(client, toServerPath);
  return {
    listMetaRecords: makeMetaRecordsList(client, meta, "list_requests"),

    /**
     * See {@link RequestOrganizerIo.sweepStaleAcks}. Only acks match — a request carries
     * `X-Ohmail-Request` and a claim `X-Ohmail-Lease` — so nothing else can be caught by it, and
     * `before` is compared against INTERNALDATE by the server rather than by a parse here.
     */
    async sweepStaleAcks(before: Date): Promise<number> {
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        if (typeof client.search !== "function") {
          throw new RequestUnavailableError(
            `${META_FOLDER} cannot be searched by this connection, so stale acknowledgements `
            + "cannot be identified and none were removed",
            { op: "sweep_acks" },
          );
        }
        /* ── THE CUTOFF IS FLOORED TO A DAY BOUNDARY, AND THAT IS NOT ROUNDING ───────────────
         *
         * IMAP's SEARCH BEFORE takes a DATE, not an instant. Where the server does not advertise
         * `WITHIN`, the library turns a `before` carrying a time of day into a date-only term and
         * ADVANCES it by one day, so that a caller asking for "older than this instant" is never
         * given less than it asked for. That is the right direction for a READER and exactly the
         * wrong one here: this call DELETES, so the widened term reaches records filed on the
         * cutoff's own day — an acknowledgement barely half a day old, removed as though it were
         * a day past its life.
         *
         * Flooring to midnight makes the term one the library sends unchanged, and moves the only
         * remaining error to the safe side: acknowledgements may survive up to a day longer than
         * the nominal life, and none younger than it is ever removed. Keeping a record too long
         * costs one row in a folder that gets swept again next cycle; removing a live one loses
         * an answer somebody is waiting for. */
        const floored = new Date(Date.UTC(
          before.getUTCFullYear(), before.getUTCMonth(), before.getUTCDate(),
        ));
        const found = await client.search(
          { header: { [AH.ack]: true }, before: floored }, { uid: true },
        );
        /* A REFUSED SEARCH IS NOT AN EMPTY FOLDER — the library resolves `false` rather than
         * rejecting. Returning 0 for it reported a sweep that had not happened, and the sweep is
         * the only thing that ever makes this folder smaller: a caller told "0 stale" concludes
         * there is nothing to compact. The drain already logs a failed sweep and carries on, which
         * is what it should do with this. */
        if (!Array.isArray(found)) {
          throw new RequestUnavailableError(
            `the search for stale acknowledgements in ${META_FOLDER} was refused, so none were `
            + "removed and the folder was not compacted",
            { op: "sweep_acks" },
          );
        }
        if (found.length === 0) return 0;
        const done = await client.messageDelete(found, { uid: true });
        if (done === false) {
          throw new RequestUnavailableError(
            `the server refused to expunge ${found.length} stale acknowledgement(s) from `
            + META_FOLDER,
            { op: "sweep_acks" },
          );
        }
        /* And a `true` proves only that a command ran — the claim path's rule, for the same
         * reason. Reporting a sweep that removed nothing is how a permanently full folder gets
         * mistaken for one that is being kept in trim. */
        await proveGone(client, found, "stale acknowledgement(s)", "sweep_acks");
        return found.length;
      } finally {
        lock.release();
      }
    },

    async ack(raw: string): Promise<void> {
      try {
        await client.append(await meta.path(), raw, ["\\Seen"]);
      } catch (err) {
        throw new RequestUnavailableError(
          `an acknowledgement could not be appended to ${META_FOLDER}`,
          { op: "append_request", cause: err },
        );
      }
    },

    async remove(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      // A ref this cannot address is NOT a no-op to report as done. The caller reads a clean
      // resolve as "expunged" and counts the record handled; the record is still in the folder,
      // so the next cycle refuses it again, and the cycle after that, for ever — a permanent log
      // line from a drain whose every counter says it is working. Refusing loudly is the only
      // answer that reaches anyone.
      if (uids.length !== refs.length) {
        throw new RequestUnavailableError(
          `${refs.length - uids.length} record(s) in ${META_FOLDER} have no addressable ref`,
          { op: "remove_requests" },
        );
      }
      if (uids.length === 0) return;
      try {
        const lock = await client.getMailboxLock(await meta.path());
        try {
          // See `makeLeaseIo.removeClaims` for why a `false` resolve is treated as a failure
          // rather than swallowed: a refused expunge here is exactly what the idempotency key at
          // `meta-request:<id>` exists to make safe to retry, and swallowing it would leave a
          // request applied AND still sitting in the folder, re-read (and re-refused-to-reapply,
          // harmlessly) on every cycle for ever.
          //
          // ONE round trip for the whole batch: refusals are collected and removed in a single
          // STORE+EXPUNGE, so a flooded folder cannot become one IMAP command per hostile record.
          const done = await client.messageDelete(uids, { uid: true });
          if (done === false) {
            throw new Error(`the server refused to expunge ${uids.length} message(s) from ${META_FOLDER}`);
          }
          /* AND A `true` IS NOT A REMOVAL — the same proof the claim and settings paths take, for
           * the reason the comment above already gives and could not enforce. The refusal check
           * sees an explicit `false`; it cannot see a refused STORE under an accepted EXPUNGE,
           * which resolves `true` and removes nothing. Without the read-back the drain counted the
           * request settled while it sat in the folder, so every later cycle re-read it — and the
           * counters said the drain was working. */
          await proveGone(client, uids, "settled request record(s)", "remove_claims");
        } finally {
          lock.release();
        }
      } catch (err) {
        throw new RequestUnavailableError(
          `${uids.length} message(s) in ${META_FOLDER} could not be removed`,
          { op: "remove_requests", cause: err },
        );
      }
    },
  };
}
