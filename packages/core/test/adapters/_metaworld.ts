import type { LeaseImapClient } from "../../src/adapters/organizer-lease.js";
import type { ProfileImapClient } from "../../src/adapters/organizer-profile.js";

/**
 * ═══ AN IN-PROCESS IMAP SERVER WITH A PERSONAL-NAMESPACE PREFIX ════════════════════════════
 *
 * The fakes in `organizer-lease.test.ts` model a server whose folder tree is exactly what the
 * client asked for. Every server this project has ever run against in production does something
 * else: Dovecot with `NAMESPACE` personal prefix `INBOX.` files a root-named CREATE **under the
 * prefix** and then LISTS it there, so `ohmail._meta` is created and `INBOX.ohmail._meta` comes
 * back — and a read that compared LIST paths for equality against `ohmail._meta` found nothing
 * on a mailbox holding a live claim.
 *
 * The realism that matters, and the reason a simpler fake could not have caught this:
 *
 *  · **AN UNPREFIXED NAME REACHES THE PREFIXED FOLDER, AND LIST REPORTS THE PREFIXED PATH.**
 *    That asymmetry is the whole defect: the write path worked, the read path did not, and
 *    nothing failed loudly anywhere. Modelled here as the SERVER resolving the name; in the real
 *    stack it is the CLIENT — `ImapFlow.tools.normalizePath` prepends `namespace.prefix` to every
 *    path it sends AND to every path LIST hands back, so the server never sees the unprefixed
 *    name at all. Behaviourally the same from this module's side, which is the level this fake
 *    is written at, and the distinction is recorded because it changes who to blame.
 *  · **`strictPrefix` turns that resolution off**, so a guard can tell "the fix resolves the
 *    folder" apart from "some layer below happened to fix it for us".
 *  · **An empty mailbox refuses `1:*`**, the way Dovecot does and GreenMail does not — the
 *    defence in `makeLeaseIo.listClaims` stays under test here too.
 */

export interface MemoryImapOptions {
  /** Personal-namespace prefix, delimiter included — `"INBOX."`. Empty means a flat server. */
  prefix?: string;
  /** Hierarchy delimiter the server reports on every LIST row. */
  delimiter?: string;
  /** Whether the server answers NAMESPACE. When false the prefix must be derived from the LIST. */
  announceNamespace?: boolean;
  /** Folders present before the test starts, as SERVER paths (already prefixed). */
  folders?: readonly string[];
  /**
   * REFUSE an unprefixed name instead of resolving it. A server that does not forgive is what
   * tells a real resolution apart from a lucky one.
   */
  strictPrefix?: boolean;
  /**
   * MODEL THE CLIENT'S CACHE, not just the server's truth.
   *
   * By default `mailbox.exists` is computed live from the tree, so this fake describes a
   * connection that is always perfectly current — the one property a real long-lived connection
   * does not have, and the reason no existing guard here could see the hazard below.
   *
   * With this on, `exists` is a CACHE refreshed only by a fresh SELECT (a `getMailboxLock` for a
   * DIFFERENT folder) or by an explicit `noop()` — measured against a real Dovecot on
   * 2026-09-04: after another connection appended, the cached count stayed 0 across gaps of
   * 1.5 s, 3 s, 6 s and 10 s, `getMailboxLock` on the already-selected folder did not refresh it,
   * and one NOOP corrected it.
   */
  staleExists?: boolean;
  /**
   * The server REFUSES SEARCH: the library resolves `false` rather than rejecting. Modelled because
   * a refusal read as "no matching messages" is what lets an election decide a folder is unclaimed
   * and a release report success having removed nothing.
   */
  refuseSearch?: boolean;
  /**
   * STATUS answers everything EXCEPT the message count — the shape of a server that offers the
   * command and not that item. Modelled because a count is the licence for a whole-folder read:
   * a caller that guessed one where none was answered would be writing an unbounded read by
   * accident, and a caller that read a missing count as a small folder would prove an absence
   * nobody measured.
   */
  refuseMessagesCount?: boolean;
  /**
   * The server COPIES and does not say where the copies landed — no `COPYUID`, which is what a
   * connection without UIDPLUS gives. Modelled because the compaction's read-back is its only
   * proof that a record survived the move, and a caller that expunged anyway would be deleting
   * records on the strength of a command having run.
   */
  copyWithoutUidMap?: boolean;
  /**
   * How a `HEADER <name> <value>` term is answered. `rfc` (default, GreenMail and Dovecot): the
   * empty value means PRESENT, any other value a substring. `empty-matches-nothing`: an empty
   * value answers nothing, the shape Infomaniak answered on 2026-09-26 (0 of 9 records, while the
   * value `1` answered 9). `whole-word`: presence honoured, a value matches whole words only, the
   * way a search index answers (the Gmail-like double).
   */
  headerSearch?: "rfc" | "empty-matches-nothing" | "whole-word" | "blind" | "refused";
  /** STORE applies and EXPUNGE answers `false`: the refused removal a custody read-back must catch. */
  expungeRefused?: boolean;
  /**
   * A server without UIDPLUS: APPEND answers no uid, and a removal is STORE `\Deleted` plus a plain
   * EXPUNGE, which also takes anything else in the folder that carries `\Deleted`.
   */
  noUidplus?: boolean;
  /** Every FETCH yields at most this many rows: the listing that comes back short of STATUS. */
  fetchTruncatesAt?: number;
  /** These uids answer a header FETCH with an empty header block. */
  headersBlankFor?: readonly number[];
  /**
   * PERMANENTFLAGS per SERVER path. The client drops an APPEND flag the SELECTED folder does not
   * permit (imapflow's `canUseFlag`), so a folder listed here with `[]` selected at append time loses
   * `\Seen`. Absent means every flag is permanent.
   */
  permanentFlags?: Record<string, readonly string[]>;
  /** A server that alters what it stores on APPEND: the long-line rewrap, a changed value. */
  transformOnAppend?: (raw: string) => string;
  /** Runs after each APPEND lands, for a message that arrives between an append and its read-back. */
  afterAppend?: (server: MemoryImapServer, path: string, raw: string) => void;
  /** The first `answers` STATUS MESSAGES replies count `by` more messages than the folder holds. */
  statusOvercount?: { by: number; answers: number };
  /**
   * Runs after each whole-folder FETCH (a range ending in `*`) has yielded its last row, with the
   * 1-based number of that read: a case changes the folder between the gate's reads.
   */
  onBetweenReads?: (server: MemoryImapServer, read: number) => void;
}

/** The HEADER searches in a command log: a SEARCH whose header term names at least one field. */
export function headerSearchesIn(log: readonly string[]): string[] {
  return log.filter((l) => /^search \S+ \{"[^"]/.test(l));
}

/**
 * A MESSAGE AS A SERVER THAT RE-ENCODES STORED BODIES SERVES IT: the body's UTF-8 bytes as
 * quoted-printable (`=XX`, soft breaks under 76 columns) or base64 (76-column lines), and the
 * transfer header saying so.
 */
export function reencodeBody(raw: string, cte: "quoted-printable" | "base64"): string {
  const at = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, at).replace(/^Content-Transfer-Encoding:.*$/im, `Content-Transfer-Encoding: ${cte}`);
  const bytes = Buffer.from(raw.slice(at + 4), "utf8");
  if (cte === "base64") return `${head}\r\n\r\n${bytes.toString("base64").replace(/.{76}/g, "$&\r\n")}`;
  const lines = bytes.toString("latin1").split("\r\n").map((line) => {
    let out = "";
    let width = 0;
    for (const c of line) {
      const unit = c === "=" || c > "~" ? `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : c;
      if (width + unit.length > 75) { out += "=\r\n"; width = 0; }
      out += unit;
      width += unit.length;
    }
    return out;
  });
  return `${head}\r\n\r\n${lines.join("\r\n")}`;
}

interface Folder {
  subscribed: boolean;
  messages: Array<{ uid: number; raw: string; internalDate: Date; flags: Set<string> }>;
  nextUid: number;
  /**
   * THE GENERATION OF THIS FOLDER'S UID NUMBERING, which this fixture did not have at all.
   *
   * Every real server reports UIDVALIDITY on SELECT, and it is the only thing that says whether a
   * remembered uid still means what it meant. Omitting it here made every uid look eternally
   * comparable, so a remembered anchor could never be seen to go stale and the code that trusts
   * one could not be tested against the case where it must not.
   */
  uidValidity: number;
}

export interface MemoryImapServer extends LeaseImapClient, ProfileImapClient {
  /** Both clients' selected mailbox: the lease reads the counters, the settings read the flags. */
  readonly mailbox?: {
    exists?: number; uidValidity?: number | bigint; uidNext?: number; permanentFlags?: Set<string>;
  } | false;
  /** Both clients' STATUS: the lease also asks UIDVALIDITY for its folder stamp. */
  status?(
    path: string,
    query: { messages?: boolean; uidNext?: boolean; uidValidity?: boolean },
  ): Promise<{ messages?: number; uidNext?: number; uidValidity?: number | bigint } | false | undefined>;
  /** Both clients' FETCH at once: the lease asks headers, the settings read asks sources. */
  fetch(
    range: string,
    query: {
      uid?: boolean; headers?: boolean | string[]; internalDate?: boolean; flags?: boolean;
      source?: boolean | { start?: number; maxLength?: number }; size?: boolean;
    },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{
    uid: number; seq?: number; headers?: Buffer; internalDate?: Date; flags?: Set<string>; source?: Buffer; size?: number;
  }>;
  /** Every command this client issued, in order — `create INBOX.ohmail._meta`, `select …`. */
  readonly log: string[];
  /** The server's folder tree, by true server path. */
  readonly tree: Map<string, Folder>;
  /** Put a message in a folder without going through the client — a fixture, not a write path. */
  seed(serverPath: string, raw: string, internalDate?: Date, flags?: readonly string[]): number;
  /** The true server path a name resolves to, for a test that wants to assert on it. */
  resolve(name: string): string;
  /**
   * Simulate the server RENUMBERING a folder: its UIDVALIDITY moves and its uids start again.
   *
   * The double has done this since it was written; it was missing from this interface, so the one
   * behaviour that can tell a stale locator from a live one was unreachable through the type and a
   * test calling it did not compile.
   */
  renumber(name: string): void;
  /**
   * Make every later EXPUNGE resolve `true` and remove nothing — the shape a refused STORE under
   * an accepted EXPUNGE produces in the real library, and the one a custody read-back exists to
   * catch. Opt-in, because a double that lied by default would break every honest deletion.
   */
  startLyingAboutDeletes(): void;
  /** The provider's fix for the lying delete: later EXPUNGEs remove what they name again. */
  stopLyingAboutDeletes(): void;
  /** Turn a misbehaving mode off. */
  heal(mode: "expungeRefused" | "headerSearch" | "fetchTruncatesAt" | "headersBlankFor"): void;
  /** Turn a misbehaving mode ON after the fixture is built — a provider changing under a folder. */
  misbehave(patch: Partial<MemoryImapOptions>): void;
}

class MailboxMissingError extends Error {
  constructor(name: string) {
    super(`Mailbox doesn't exist: ${name}`);
  }
}

/**
 * ── `BEFORE` IS A DATE, NOT AN INSTANT, AND THE LIBRARY WIDENS IT ─────────────────────────────
 *
 * IMAP's SEARCH BEFORE takes a DATE. Where the server does not advertise `WITHIN`, ImapFlow
 * converts a `before` carrying a time of day into a date-only term — and ADVANCES it by a day, so
 * that a caller asking for "older than this instant" is not silently given less than it asked for.
 * The consequence runs the other way for a caller that is DELETING: the term matches everything
 * filed on the cutoff's own day, which can be a full day younger than intended.
 *
 * This fake compared exact timestamps, which is the one thing a server never does, so a sweep that
 * deletes records up to a day too young looked exactly like a correct one here.
 *
 * Modelled as the pessimistic case because it is the one deployed servers produce; a fake that
 * assumed `WITHIN` would be flattering the code again.
 */
/**
 * WHAT A SERVER STAMPS WHEN NOBODY SAYS — the appended record's OWN heartbeat, not this process's
 * wall clock.
 *
 * A real server writes its own clock, and the ordinary case is a writer whose clock agrees with
 * it: heartbeat and INTERNALDATE name one instant. Defaulting to `new Date()` here modelled a
 * writer days out of step with its server, because every fixture drives a fixed clock — and the
 * writer-side skew check then fired on all of them. So the default IS the agreement, which makes
 * the check inert for an honest fixture; a skew case states an explicit `internalDate` and creates
 * the divergence on purpose.
 */
function stampedAt(raw: string, given: Date | undefined): Date {
  if (given !== undefined) return given;
  const m = /^X-Ohmail-Heartbeat:[ \t]*(.+)$/mi.exec(raw);
  const at = m ? Date.parse(m[1]!.trim()) : NaN;
  return Number.isFinite(at) ? new Date(at) : new Date();
}

function matchesBefore(internalDate: Date, before: Date): boolean {
  const midnight = Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), before.getUTCDate());
  const hasTimeOfDay = before.getTime() !== midnight;
  // The advance ImapFlow applies, in whole days.
  const cutoff = hasTimeOfDay ? midnight + 86_400_000 : midnight;
  return internalDate.getTime() < cutoff;
}

export function memoryImapServer(given: MemoryImapOptions = {}): MemoryImapServer {
  // A copy, so `heal` changes this server and never the caller's options object.
  const opts: MemoryImapOptions = { ...given };
  const delimiter = opts.delimiter ?? ".";
  const prefix = opts.prefix ?? "";
  const announce = opts.announceNamespace ?? true;
  const log: string[] = [];
  const tree = new Map<string, Folder>();

  const blank = (): Folder => ({ subscribed: false, messages: [], nextUid: 1, uidValidity: 1_000 });
  tree.set("INBOX", blank());
  for (const f of opts.folders ?? []) tree.set(f, blank());

  /**
   * What a NAME means to this server. `INBOX` is special-cased by RFC 3501 and every server;
   * anything else outside the prefix is either filed inside it or refused.
   */
  const resolve = (name: string): string => {
    if (name.toUpperCase() === "INBOX") return "INBOX";
    if (prefix === "" || name.startsWith(prefix)) return name;
    if (opts.strictPrefix) throw new MailboxMissingError(name);
    return `${prefix}${name}`;
  };

  let selected: string | null = null;
  let lyingDelete = false;
  let overcounted = 0;
  let wholeReads = 0;
  /** What the CLIENT believes the selected folder holds — see {@link MemoryImapOptions.staleExists}. */
  let cachedExists: number | null = null;
  const trueCount = (): number => (selected === null ? 0 : tree.get(selected)?.messages.length ?? 0);

  const server: MemoryImapServer = {
    log,
    tree,

    seed(serverPath: string, raw: string, internalDate?: Date, flags: readonly string[] = ["\\Seen"]): number {
      const f = tree.get(serverPath);
      if (!f) throw new MailboxMissingError(serverPath);
      const uid = f.nextUid++;
      f.messages.push({ uid, raw, internalDate: stampedAt(raw, internalDate), flags: new Set(flags) });
      return uid;
    },

    resolve,

    get mailbox(): { exists?: number; uidValidity?: number; permanentFlags?: Set<string> } | false {
      if (selected === null) return false;
      const uidValidity = tree.get(selected)?.uidValidity;
      const perm = opts.permanentFlags?.[selected];
      const permanentFlags = perm === undefined ? {} : { permanentFlags: new Set(perm) };
      if (!opts.staleExists) return { exists: trueCount(), uidValidity, ...permanentFlags };
      return { exists: cachedExists ?? trueCount(), uidValidity, ...permanentFlags };
    },

    /**
     * RENUMBER THE FOLDER, as a server does when a mailbox is deleted and recreated under the same
     * name. Uids start again from 1 and every uid anybody remembered now refers to nothing, or
     * worse, to a different message.
     */
    renumber(name: string): void {
      const f = tree.get(resolve(name));
      if (!f) throw new MailboxMissingError(name);
      f.uidValidity += 1;
      f.nextUid = 1;
      f.messages = [];
    },

    /**
     * A NOOP, which is how a real connection learns what changed under it. Modelled as the one
     * command that refreshes the cache, because that is what RFC 3501 requires of it and what the
     * live measurement showed (0 → 1 on the first NOOP after another connection's APPEND).
     */
    async noop(): Promise<unknown> {
      log.push(`noop ${selected ?? "<none>"}`);
      cachedExists = trueCount();
      return true;
    },

    /**
     * STATUS, answered from the SERVER's truth and by FOLDER NAME. Two properties matter and the
     * fake has to have both: ImapFlow does not rewrite it from the connection's cache, so a stale
     * `exists` cannot reach the answer; and it replies with ONE NUMBER, so asking cannot cost
     * memory proportional to the folder the way a list of every message number does.
     */
    /**
     * SEARCH, MODELLED ON WHAT THE SERVERS ACTUALLY DO — measured, not assumed.
     *
     * A header value of `true` is compiled by the library to `HEADER <name> ""`, which RFC 3501
     * defines as "this header is PRESENT". Both servers in the estate were asked directly before
     * this was written (the project's design notes risk 1): from a folder holding a
     * claim, a settings document and an ack, `X-Ohmail-Lease` returns exactly the claim's uid on
     * GreenMail and on Dovecot, the field name matches case-insensitively, and a header no message
     * carries returns the EMPTY set.
     *
     * THIS DOUBLE MUST NOT BE KINDER THAN THAT. The failure it exists to catch is a fake that
     * matches a header the message lacks, or matches `X-Ohmail-Lease` on a settings document —
     * either would hide a real miss and let an election read a folder it never actually searched.
     * So the match is on the HEADER BLOCK only, by field name, and nothing else.
     */
    async search(
      query: { header?: Record<string, string | boolean>; before?: Date; uid?: string },
      _options?: { uid?: boolean },
    ): Promise<number[] | false> {
      /* The RANGE is part of what was asked, so it is part of what the log says. Without it a
       * caller that searched the whole folder and one that searched a window read identically
       * here, and "this proof cost ONE complete search" could not be measured at all. */
      log.push(
        `search ${selected ?? "<none>"} ${JSON.stringify(query.header ?? {})}`
        + (query.uid === undefined ? "" : ` uid:${query.uid}`),
      );
      if (opts.refuseSearch) return false;
      // A HEADER term refused outright; a UID-only search (`{ header: {} }`) is still answered.
      if (opts.headerSearch === "refused" && Object.keys(query.header ?? {}).length > 0) return false;
      if (selected === null) return [];
      const f = tree.get(selected);
      if (!f) return [];
      const headerBlockOf = (raw: string): string => {
        const sep = /\r?\n\r?\n/.exec(raw);
        return (sep ? raw.slice(0, sep.index) : raw).toLowerCase();
      };
      return f.messages
        .filter((m) => {
          const head = headerBlockOf(m.raw);
          for (const [name, want] of Object.entries(query.header ?? {})) {
            const field = `${name.toLowerCase()}:`;
            const line = head.split(/\r?\n/).find((l) => l.startsWith(field));
            // ABSENT is a miss, always — the property the real servers have and the one a
            // permissive double would quietly drop.
            if (line === undefined) return false;
            // `true` is what the library sends as `""`: presence, unless this server answers an
            // empty value with nothing. A string is a substring (a whole word on `whole-word`).
            const value = line.slice(field.length);
            const mode = opts.headerSearch ?? "rfc";
            if (mode === "blind") return false;
            if (want === true || want === "") {
              if (mode === "empty-matches-nothing") return false;
            } else if (mode === "whole-word") {
              const w = String(want).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              if (!new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`).test(value)) return false;
            } else if (!value.includes(String(want).toLowerCase())) {
              return false;
            }
          }
          if (query.before !== undefined && !matchesBefore(m.internalDate, query.before)) return false;
          /* ── THE `UID` TERM IS A FILTER, AND IGNORING IT MADE EVERY WINDOW THE WHOLE FOLDER ──
           *
           * `UID <lo>:<hi>` narrows a SEARCH to a range of uids. This fake dropped it, so a
           * caller walking the folder in descending windows was handed every matching record on
           * EVERY window — the records came back many times over, and a walk could
           * not be told from a repeat. A double that answers a narrowed question with the whole
           * answer is the same defect as one that answers a bounded fetch with the whole folder,
           * which this file has already had once. */
          if (query.uid !== undefined) {
            const r = /^(\d+|\*):(\d+|\*)$/.exec(query.uid);
            if (r === null) return false;
            /* ── `*` IS THE HIGHEST UID IN THE FOLDER, ANSWERED BY THE SERVER ──────────────
             *
             * RFC 3501's `*`, and the reason a complete search is written `1:*` rather than
             * `1:<UIDNEXT-1>`: the server resolves it against what the folder actually holds, so
             * the range is complete even when the caller's ceiling is stale. imapflow passes the
             * SEARCH `UID` term through verbatim as a SEQUENCE attribute (`search-compiler.js`,
             * the `UID` case) — unlike FETCH, where it rewrites `*` from the cached `exists`, the
             * rewrite this fake models elsewhere. A fake that dropped `1:*` on the floor would
             * answer a complete search with the EMPTY SET, which reads as a proved absence: the
             * one wrong answer this range exists to make impossible. */
            const star = f.messages.reduce((hi2, x) => (x.uid > hi2 ? x.uid : hi2), 0);
            const lo = r[1] === "*" ? star : Number(r[1]);
            const hi = r[2] === "*" ? star : Number(r[2]);
            if (m.uid < Math.min(lo, hi) || m.uid > Math.max(lo, hi)) return false;
          }
          return true;
        })
        .map((m) => m.uid);
    },

    async status(
      path: string,
      query: { messages?: boolean; uidNext?: boolean; uidValidity?: boolean },
    ): Promise<{ messages?: number; uidNext?: number; uidValidity?: number }> {
      const asked = [
        query.messages ? "messages" : null,
        query.uidNext ? "uidnext" : null,
        query.uidValidity ? "uidvalidity" : null,
      ].filter((x): x is string => x !== null);
      log.push(`status ${resolve(path)} ${asked.length > 0 ? asked.join(",") : "?"}`);
      const f = tree.get(resolve(path));
      // ONLY WHAT WAS ASKED FOR. A real STATUS returns the items the command named and nothing
      // else, so a caller that forgets to ask for MESSAGES must not be handed the count anyway.
      // Returning it regardless is the permissive shape that let the previous probe keep passing
      // here after it had stopped being able to work.
      const out: { messages?: number; uidNext?: number; uidValidity?: number } = {};
      if (query.messages && !opts.refuseMessagesCount) {
        out.messages = f ? f.messages.length : 0;
        const over = opts.statusOvercount;
        if (over !== undefined && overcounted < over.answers) { overcounted += 1; out.messages += over.by; }
      }
      /* UIDNEXT, which a real server answers and this fake did not — so the descending search,
       * which walks DOWN from it, had nothing to start from and refused every claim set. The
       * folder's own next uid is the truth here, exactly as the count is. */
      if (query.uidNext) out.uidNext = f ? f.nextUid : 1;
      // The generation, on the same reasoning: every real server answers it and the folder stamp
      // compares it, so a fake that stayed silent would make a renumbering unobservable here.
      if (query.uidValidity && f) out.uidValidity = f.uidValidity;
      return out;
    },

    get namespace(): { prefix?: string; delimiter?: string | null } | undefined {
      return announce ? { prefix, delimiter } : undefined;
    },

    get namespaces(): { personal?: Array<{ prefix?: string; delimiter?: string | null }> | false } | undefined {
      return announce ? { personal: [{ prefix, delimiter }] } : undefined;
    },

    async list() {
      log.push("list");
      return [...tree.entries()].map(([path, f]) => ({ path, subscribed: f.subscribed, delimiter }));
    },

    async mailboxCreate(name: string) {
      const path = resolve(name);
      log.push(`create ${path}`);
      const created = !tree.has(path);
      if (!created) throw new Error(`Mailbox already exists: ${name}`);
      tree.set(path, blank());
      // The SERVER names the folder it made. This is the field `makeLeaseIo` adopts, and the
      // reason it can address a prefixed folder on the very connection that created it.
      return { path, created };
    },

    async mailboxUnsubscribe(name: string) {
      const path = resolve(name);
      log.push(`unsubscribe ${path}`);
      const f = tree.get(path);
      if (f) f.subscribed = false;
      return true;
    },

    async getMailboxLock(name: string) {
      const path = resolve(name);
      if (!tree.has(path)) throw new MailboxMissingError(name);
      // A real client re-SELECTs only when the folder CHANGES; taking the lock on the folder that
      // is already selected issues no command and refreshes nothing. Measured, and it is the half
      // that makes a stale count survive `getMailboxLock`.
      // The LOG stays `select` either way — existing guards read it, and this is a cache model,
      // not a re-spelling of the command trace.
      const reselected = path !== selected;
      log.push(`select ${path}`);
      selected = path;
      if (reselected) cachedExists = trueCount();
      return { release(): void { /* the selection survives, as it does on a real client */ } };
    },

    fetch(
      range: string,
      query: {
        headers?: boolean | string[];
        source?: boolean | { start?: number; maxLength?: number };
        size?: boolean;
        flags?: boolean;
        /* The SERVER's clock, which the writer-side skew check reads. Honoured the way a real
           server honours it: yielded only when asked for, and it is the stored stamp, never
           `new Date()` — a fake that answered its own clock could not tell a skewed install
           from a healthy one. */
        internalDate?: boolean;
      },
      // The THIRD argument every caller passes and this fake used to ignore. Without it
      // `options?.uid` resolved to an outer binding and a UID-addressed fetch was answered
      // by sequence number — a double silently answering a different question.
      options?: { uid?: boolean },
    ) {
      const path = selected;
      /* The RANGE is in the log line when one was asked for, so a test can assert on the command
       * the adapter sent rather than on the bytes that came back — the only shape that can see a
       * transport bound at all. */
      const partial = typeof query.source === "object" && query.source !== null
        ? `<${query.source.start ?? 0}.${String(query.source.maxLength ?? "")}>`
        : "";
      log.push(`fetch ${path ?? "<none>"} ${range}${partial}`);
      const f = path === null ? undefined : tree.get(path);
      const all = f?.messages ?? [];
      /* Dovecot's refusal, verbatim in shape: `1:*` is not a valid messageset against an empty
       * mailbox. The positively-known-zero defence in the shared read is what keeps this from
       * firing.
       *
       * ONLY FOR A `*`-RELATIVE RANGE, and the difference is not pedantry. `UID FETCH 7,8` against
       * an empty mailbox is a VALID command that simply matches nothing; it is `*` that cannot be
       * resolved when there is no last message. Refusing both made this fake reject every custody
       * read-back taken after the last message was deleted — which is precisely the read that
       * proves an expunge worked. Every ordinary custody test therefore exercised the
       * COULD-NOT-LOOK path instead of the proved-empty one, and a release that swallowed a failed
       * read looked identical to one that verified custody. The defect this fake was hiding is
       * round nine's finding 1. */
      if (all.length === 0 && range.includes("*")) {
        throw new Error("Error in IMAP command FETCH: Invalid messageset");
      }
      /**
       * ── THE MESSAGESET IS HONOURED, AND IT HAS TO BE ────────────────────────────────────────
       *
       * This used to ignore `range` and yield the whole folder, which made every assertion about
       * WHICH messages a bounded read takes vacuously true: a read asking for the newest window and
       * a read asking for `1:*` were indistinguishable here, so a ceiling that kept the OLDEST
       * records would have passed a test written to prove it kept the newest.
       *
       * Sequence numbers, not uids — the reads under test pass `{ uid: false }`.
       *
       * RANGES ARE ORDER-INSENSITIVE, and the first version of this comment got that wrong. RFC 3501
       * §9 defines a range as the two numbers and everything between them REGARDLESS OF ORDER, and
       * `*` is the highest existing sequence number — so `N:*` against a folder holding fewer than N messages is
       * `N:last`, which is `last:N`, and a real server answers with the last message. It does NOT
       * answer empty. That case is reachable here: `exists` is a cache, so a stale-HIGH count makes
       * the bounded read ask for a start beyond the true end.
       *
       * It changes no outcome under test today — a start above 1 already forces `truncated`,
       * whatever comes back — but a fake that models a real server backwards is how the next
       * assertion about a real server passes for the wrong reason.
       */
      const star = all.length;
      const picked = ((): Array<{ i: number; m: (typeof all)[number] }> => {
        const indexed = all.map((m, i) => ({ i, m }));
        /* ── A BARE `*` IS RESOLVED BY THE CLIENT, NOT BY THE SERVER — MODEL THE CLIENT ────────
         *
         * This used to answer `*` the way a SERVER does: the highest existing sequence number,
         * one message, the last one. That is correct about IMAP and wrong about the library this
         * code actually runs on, and the difference hid a defect for a whole release.
         *
         * ImapFlow rewrites the range before issuing the command (`imap-flow.js`, 1.5.0):
         *
         *     if (range === '*') {
         *         if (!this.mailbox.exists) { return false; }
         *         range = this.mailbox.exists.toString();
         *     }
         *
         * So `*` never reaches the server. It is answered from `mailbox.exists` — the CACHED
         * count — which made a probe written specifically to bypass that cache return it instead,
         * and return `false` rather than an iterable when the cache read zero.
         *
         * The fake models the CLIENT so that a probe which cannot work cannot pass here either.
         * Nothing in this module asks for `*` any more; the count is asked for with SEARCH. */
        if (range.trim() === "*") {
          const cached = !opts.staleExists ? trueCount() : (cachedExists ?? trueCount());
          if (!cached) throw new Error("ImapFlow returns false, not an iterable, for `*` with no cached exists");
          return indexed.slice(Math.max(0, cached - 1), cached);
        }
        /* ── A COMMA-SEPARATED SET IS A REAL MESSAGESET, AND FALLING THROUGH TO "EVERYTHING" IS
         *    THE MOST DANGEROUS ANSWER THIS FAKE CAN GIVE ────────────────────────────────────
         *
         * `1,7,42` is what a UID-addressed fetch of a search result looks like, and this used to
         * fail the range regex and `return indexed` — every message in the folder. That is a double
         * being enormously kinder than a server: a caller that asked for one claim received the
         * whole folder and could not tell. It was caught by the election reporting 511 claims in a
         * folder holding one, which is the good outcome; the bad one is a test that passes because
         * the fake handed back more than was asked for.
         *
         * With `{ uid: true }` the numbers are UIDs, which is how every caller of `searchHeaders`
         * addresses them; otherwise they are sequence numbers. */
        if (/^\d+(,\d+)*$/.test(range.trim())) {
          const wanted = new Set(range.trim().split(",").map(Number));
          return options?.uid === true
            ? indexed.filter(({ m }) => wanted.has(m.uid))
            : indexed.filter(({ i }) => wanted.has(i + 1));
        }
        const m = /^(\d+):(\*|\d+)$/.exec(range);
        // Anything this fake cannot parse is a REFUSAL, never "everything". A messageset it does not
        // understand must not silently become the widest possible answer.
        if (!m) throw new Error(`the fake cannot parse the messageset ${JSON.stringify(range)}`);
        const a = Number(m[1]);
        const b = m[2] === "*" ? star : Number(m[2]);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return indexed.slice(Math.max(0, lo - 1), hi);
      })();
      const shown = opts.fetchTruncatesAt === undefined ? picked : picked.slice(0, opts.fetchTruncatesAt);
      /* BODY.PEEK[HEADER] is the header block and its blank line, never the body: a double that
         answered the whole message would charge a header read for every body in the folder. */
      const headerOf = (raw: string): Buffer => {
        const sep = /\r?\n\r?\n/.exec(raw);
        return Buffer.from(sep ? raw.slice(0, sep.index + sep[0].length) : raw, "utf8");
      };
      const whole = range.trim().endsWith("*");
      return (async function* () {
        for (const { i, m } of shown) {
          yield {
            uid: m.uid,
            // THE SEQUENCE NUMBER, which a real client reports and which is the only way to learn
            // the folder's true message count without trusting the connection's cache. 1-based.
            seq: i + 1,
            ...(query.headers
              ? { headers: opts.headersBlankFor?.includes(m.uid) ? Buffer.alloc(0) : headerOf(m.raw) }
              : {}),
            ...(query.flags ? { flags: new Set(m.flags) } : {}),
            ...(query.internalDate ? { internalDate: m.internalDate } : {}),
            /* ── A BYTE RANGE ON `source` IS HONOURED, BECAUSE THAT IS THE WHOLE POINT OF IT ──
             *
             * `{ start, maxLength }` compiles to `BODY.PEEK[]<start.maxLength>` and the server
             * sends AT MOST that many bytes. A double that returns the whole message regardless
             * cannot tell a bounded read from an unbounded one — which is exactly the difference
             * a transport bound exists to make, so it would be flattering the code again. */
            ...(query.source
              ? {
                source: ((): Buffer => {
                  const whole = Buffer.from(m.raw, "utf8");
                  if (typeof query.source !== "object") return whole;
                  const start = query.source.start ?? 0;
                  const max = query.source.maxLength;
                  return max === undefined
                    ? whole.subarray(start)
                    : whole.subarray(start, start + max);
                })(),
              }
              : {}),
            /* RFC822.SIZE, which a server answers WITHOUT sending the message — the whole point of
             * asking for it. This fake did not implement it, so a read that bounds transport by
             * size measured every record as absent and the byte ceilings went inert without a
             * single test objecting. */
            ...(query.size ? { size: Buffer.byteLength(m.raw, "utf8") } : {}),
          };
        }
        if (whole && opts.onBetweenReads !== undefined) { wholeReads += 1; opts.onBetweenReads(server, wholeReads); }
      })();
    },

    /* The PRODUCTION shape: flags third, as imapflow takes them. The object form is kept for the
       fixtures that stamp an INTERNALDATE. Flags go through the SELECTED folder's PERMANENTFLAGS,
       the filter the client applies before the command is sent. */
    async append(name: string, content: string | Buffer, flagsOrOpts?: string[] | { internalDate?: Date }, idate?: Date) {
      const path = resolve(name);
      log.push(`append ${path}`);
      const f = tree.get(path);
      if (!f) throw new MailboxMissingError(name);
      const asked = Array.isArray(flagsOrOpts) ? flagsOrOpts : [];
      const at = Array.isArray(flagsOrOpts) ? idate : flagsOrOpts?.internalDate;
      const perm = selected === null ? undefined : opts.permanentFlags?.[selected];
      const flags = new Set(asked.filter((fl) => perm === undefined || perm.includes("\\*") || perm.includes(fl)));
      const text = opts.transformOnAppend
        ? opts.transformOnAppend(typeof content === "string" ? content : content.toString("utf8"))
        : (typeof content === "string" ? content : content.toString("utf8"));
      const uid = f.nextUid++;
      /* INTERNALDATE, which this omitted. Every message a server holds has one, and a `before`
       * search is answered against it — so an APPENDED record compared as `undefined < Date` was
       * never matched by one, and the ack sweep could not see the very records it appends. The
       * field is required on the message type; nothing caught the omission because this package's
       * tests are not typechecked. */
      f.messages.push({ uid, raw: text, internalDate: stampedAt(text, at), flags });
      opts.afterAppend?.(server, path, text);
      // UIDPLUS reports the generation alongside the uid; a uid without one cannot be checked
      // for staleness later, which is the whole point of remembering it.
      if (opts.noUidplus) return { destination: path };
      return { uid, uidValidity: f.uidValidity };
    },

    /** STORE +FLAGS, logged as `store <path> <uids> <flags>` so a case can count them. */
    async messageFlagsAdd(range: number[], flags: string[], _options?: { uid?: boolean; silent?: boolean }) {
      const f = selected === null ? undefined : tree.get(selected);
      log.push(`store ${selected ?? "<none>"} ${range.join(",")} +${flags.join(" ")}`);
      if (!f) return false;
      for (const m of f.messages) if (range.includes(m.uid)) for (const fl of flags) m.flags.add(fl);
      return true;
    },

    /**
     * COPY, MODELLED ON WHAT THE SERVERS ACTUALLY DO — measured on GreenMail 2.1.3 before this was
     * written: `UIDPLUS` is advertised, a folder may be copied INTO ITSELF, `COPYUID` comes back as
     * the old-to-new map, and both the INTERNALDATE and the flags of the copy equal the original's.
     *
     * The realism that decides a test here: a copy that RESTAMPED the message would make the
     * compaction unsound in a way no assertion in this file could see — a stale claim would read as
     * freshly live and stand a running install down. So the stamp is carried, and
     * {@link MemoryImapOptions.copyWithoutUidMap} exists to model the other server, the one that
     * copies and will not say where, because nothing may be expunged on that answer.
     */
    async messageCopy(range: number[], destination: string, _options?: { uid?: boolean }) {
      const from = selected === null ? undefined : tree.get(selected);
      const to = tree.get(resolve(destination));
      log.push(`copy ${selected ?? "<none>"} ${range.join(",")} → ${resolve(destination)}`);
      if (!from || !to) return false;
      const uidMap = new Map<number, number>();
      /* ASCENDING, because COPYUID pairs the two sets in order and every caller here is moving a
         run of records whose relative order is the only thing carrying "newest". */
      for (const uid of [...range].sort((a, b) => a - b)) {
        const m = from.messages.find((x) => x.uid === uid);
        if (m === undefined) continue;
        const landed = to.nextUid++;
        to.messages.push({ uid: landed, raw: m.raw, internalDate: m.internalDate, flags: new Set(m.flags) });
        uidMap.set(uid, landed);
      }
      if (opts.copyWithoutUidMap) return { uidValidity: to.uidValidity };
      return { uidValidity: to.uidValidity, uidMap };
    },

    async messageDelete(range: number[]) {
      const f = selected === null ? undefined : tree.get(selected);
      log.push(`delete ${selected ?? "<none>"} ${range.join(",")}`);
      if (!f) return false;
      /* ── A `true` THAT REMOVED NOTHING IS A SHAPE THE LIBRARY REALLY PRODUCES ────────────
       *
       * `messageDelete` is `resolveRange` then `run('EXPUNGE', …)`; the STORE that marks
       * `\Deleted` is internal and its result is not propagated, so a REFUSED store followed by
       * an accepted EXPUNGE resolves `true` and deletes nothing. This fake could only ever
       * return `true` when it really had deleted, so every caller's custody read-back was
       * tested against a double that made the failure unreachable — each test had to hand-roll
       * the lying server, and any caller nobody hand-rolled it for was simply never tested.
       *
       * Opt-in rather than the default: a fake that silently lied would break every test that
       * legitimately expects a deletion, and the point is to make the shape REACHABLE, not to
       * make the double dishonest. */
      if (lyingDelete) return true;
      // The STORE lands first, whatever the EXPUNGE then answers.
      for (const m of f.messages) if (range.includes(m.uid)) m.flags.add("\\Deleted");
      if (opts.expungeRefused) return false;
      const before = f.messages.length;
      // UID EXPUNGE takes the range; a plain EXPUNGE takes everything flagged `\Deleted`.
      f.messages = f.messages.filter((m) => (opts.noUidplus ? !m.flags.has("\\Deleted") : !range.includes(m.uid)));
      return f.messages.length !== before;
    },
    /** Make every later EXPUNGE resolve `true` and remove nothing — see `messageDelete`. */
    startLyingAboutDeletes(): void { lyingDelete = true; },
    stopLyingAboutDeletes(): void { lyingDelete = false; },
    /** Heal a misbehaving mode, the way a provider's fix reaches a folder that is already full. */
    heal(mode: "expungeRefused" | "headerSearch" | "fetchTruncatesAt" | "headersBlankFor"): void {
      if (mode === "headerSearch") opts.headerSearch = "rfc";
      else delete opts[mode];
    },
    misbehave(patch: Partial<MemoryImapOptions>): void { Object.assign(opts, patch); },
  };

  return server;
}
