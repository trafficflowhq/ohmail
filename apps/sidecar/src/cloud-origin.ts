/**
 * The server contract — which hosted server a mirror, session and settings belong to, and the
 * derivation that turns a typed address into the base the engine dials. Letting an operator point
 * `mode: "cloud"` at their OWN server makes two facts the care here: the mirror directory is keyed
 * by MODE, not server (`config.rs`), so the hosted and a self-hosted account share one database and
 * `accountId` and an ADDRESS comparison cannot tell them apart (the worst failure shape this has);
 * and the sealed session is a fact about ONE server, so keeping it across a re-point hands one
 * server's bearer to another. Both close at the discard `enforceMirrorOwner` already performs. Its
 * own file with NO imports, published with both programs, so one definition reddens BOTH guards.
 */

/**
 * The file an operator puts their own certificate authority's root in, inside the app's data folder
 * — named once so the three places that must spell it identically cannot drift: the shell composes
 * `NODE_EXTRA_CA_CERTS` from it (`config.rs`), the engine's probe names it in the refusal, and the
 * door's address step names it first. A self-host stack on a private name issues its own certs
 * (correct — no public authority validates `ohmail.test`), and Node verifies against compiled-in
 * roots, so the truthful ways forward are a cert Node already trusts or telling Node about theirs.
 * `NODE_EXTRA_CA_CERTS` ADDS a root, never relaxing verification, and there is no switch to turn
 * checking off. Measured: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` by default, `authorized` with it.
 */
export const OPERATOR_CA_FILE = "cloud-ca.pem";

/**
 * The one server every build before the self-hosted door could dial — not a default or fallback
 * destination (nothing is CONFIGURED from it). It answers one question: what server does a
 * mirror-owner record that names no server belong to? Treating a recorded base of `null` as "cannot
 * compare, so not a change of server" was WRONG: that absence is not unknown — a Cloud mirror
 * written by any earlier build was built against THIS address, the only one the shell could dial.
 * Reading it as unknown created a credential leak on the migration launch (the seal and mirror
 * survive and the engine puts this service's bearer in a header addressed to another server).
 * Reading the absence as this base makes that a positive disagreement, discarded before dialling.
 */
export const MANAGED_CLOUD_BASE = "https://api.ohmail.app";


/**
 * The `/api` suffix is not cosmetic and is the one thing a self-host door cannot guess. The hosted
 * service has a whole hostname (`https://api.ohmail.app/sync` IS the API); a self-host stack serves
 * ONE origin behind one Caddy site routing `/api/*` to the API and everything else to the web app,
 * so `https://<origin>/sync` reaches Next and answers 404 HTML (measured: `/sync` → 404 html,
 * `/api/sync` → 401). A bare-origin door would sign in (`/auth/*` is routed at the root) then sync
 * nothing for ever. `<origin>/api` works against BOTH (the API canonicalizes one leading `/api` off
 * itself), so the self-host door composes it and the hosted keeps its constant. The exception is a
 * DESKTOP host serving its API at the ROOT, so the flavor is a PARAMETER from the greeting.
 */
export function apiBaseFor(origin: string, flavor?: string | null): string {
  const root = origin.replace(/\/+$/, "");
  return flavor === "desktop-host" ? root : `${root}/api`;
}

/**
 * What a person may type into "your server's address", reduced to an origin — or null. The caller
 * owns the sentence (a returned reason would be a quieter copy of the door's). A bare host gets
 * `https://` — the only value this invents, always the SAFE direction. Refused rather than repaired:
 * a scheme that is not http/https; `http:` on anything but LOOPBACK (cleartext would post the
 * password and TOTP to any on-path peer while the door promises TLS; loopback never leaves the
 * machine); a PATH (`…/api` composed with {@link apiBaseFor} is `…/api/api`); a query or fragment (a
 * pasted URL); and embedded credentials (a password must never reach a settings file). An explicit
 * non-default port is kept; host case is folded, nothing else.
 */
export function normalizeOrigin(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.hostname === "") return null;
  /* `url.host` already carries the port only when it is not the scheme's default, and already
     lower-cases the hostname. `url.origin` is the same value for these two schemes and is used in
     preference to composing one, so this cannot drift from the platform's own definition. */
  return url.origin;
}

/**
 * Is this hostname this machine, so a cleartext connection never leaves it? The set is exactly what
 * cannot be reached from another host: `localhost` and any name under it (the URL standard treats
 * `*.localhost` as loopback), all of `127.0.0.0/8`, and IPv6 `::1` (`new URL` brackets an IPv6
 * literal, hence two spellings). DELIBERATELY NOT "private" or "link-local": `10.x`, `192.168.x` and
 * `169.254.x` are reachable from every other machine on that network — where an on-path peer would
 * be — and treating a LAN as a trust boundary is how a password ends up on somebody's wifi.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A base URL reduced to what a comparison may look at — or null when it is not one. `normalizeHost`
 * folds whitespace and case and nothing else; the same conservatism applies with one addition that
 * is a spelling, not an invention: a trailing slash and the default port are the SAME URL, so `new
 * URL` is asked rather than a regexp. The PATH is kept and compared — it tells `https://ohmail.test/
 * api` from `https://ohmail.test`. A query, fragment or userinfo is REFUSED, not dropped: dropping
 * makes two DIFFERENT bases compare EQUAL (letting a sealed session survive a move between them) and
 * silently voids a configured component. Refusing is right for both jobs — a comparison cannot erase
 * a difference, and a canonicalizer fails a base carrying anything below it cannot represent.
 */
export function normalizeBase(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/**
 * Is this mirror's recorded server a different server than the engine is configured for?
 * `credentialIsForeign`'s rule, restated because it must hold identically: `false` — not a change of
 * server — whenever the comparison cannot be made. THE MARKER RECORDS NO SERVER for every install
 * predating this file, and reading that as a change would discard a working mailbox to close a case
 * it cannot be in (its only door is the one constant) — so it is ADOPTED, the record rewritten and
 * the guarantee forward. EITHER SIDE UNPARSEABLE has nothing to disagree with. `true` is returned
 * only on a POSITIVE disagreement — both named a base, both parsed, and they differ — the only case
 * where discarding a mirror and session is certainly right, and exactly the one the third door creates.
 */
export function baseIsForeign(recorded: string | null | undefined, configured: string | null | undefined): boolean {
  if (typeof recorded !== "string" || typeof configured !== "string") return false;
  const left = normalizeBase(recorded);
  const right = normalizeBase(configured);
  if (left === null || right === null) return false;
  return left !== right;
}

/**
 * The mirror-owner record, as it is written to disk. ONE file and therefore ONE write: two files
 * would be two writes with a tear between them, and the marker makes a torn write unmistakable — an
 * EMPTY file reads as an owner that cannot be established and matches nothing, rather than as an
 * absent marker (which is adopted). JSON, not two lines, so the framing does not depend on the
 * values: this was `address + "\n" + base`, and a line break in the ADDRESS (both fields come from
 * the environment or a hand-edited file) would push the base off the reader's line and make the
 * server read as absent — the one answer that silently switches this protection off. JSON is also
 * self-describing, which lets the legacy shape be told apart with no version field.
 */
export function encodeMirrorRecord(
  address: string | null,
  base: string | null,
  account: string | null = null,
  discardPending = false,
): string {
  /* THE FLAG IS OMITTED WHEN FALSE, so an ordinary record is byte-identical to what every build
     before this wrote and a reader that has never heard of it is unaffected. */
  return JSON.stringify(discardPending ? { address, base, account, discardPending } : { address, base, account });
}

/**
 * The record as its two facts. Never throws; every unreadable shape degrades to "no server".
 *
 * `address` is preserved VERBATIM apart from trimming, the empty string included — see
 * `readMirrorOwner` for why an empty owner must never be collapsed into an absent one. A file that
 * is not JSON is the LEGACY shape and its whole trimmed content is the address, which is what makes
 * an install written before this parse correctly rather than as an owner of "".
 */
export function decodeMirrorRecord(raw: string): MirrorRecord {
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as {
        address?: unknown; base?: unknown; account?: unknown; discardPending?: unknown;
      };
      /* `null` AND NOT `""`, and the difference decides whether a mirror survives. An empty
         string is an address that WAS configured and is blank, which `sameOwner` matches against
         nothing — a record written that way is discarded on every launch. `null` says the record
         names no address, which is the paired door's ordinary state and is compared with nothing.
         A non-string (a number, an object, a JSON `null`) is the same absence and reads the same. */
      const address = typeof parsed.address === "string" && parsed.address.trim() !== ""
        ? parsed.address.trim()
        : null;
      const base = typeof parsed.base === "string" && parsed.base.trim() !== "" ? parsed.base.trim() : null;
      const account = typeof parsed.account === "string" && parsed.account.trim() !== ""
        ? parsed.account.trim()
        : null;
      /* TRUE ONLY FOR THE EXACT BOOLEAN. Anything else — absent, a string, a number — is the
         ordinary state, because this flag causes a DELETION and a value nobody deliberately wrote
         must never select that branch. */
      return { address, base, account, discardPending: parsed.discardPending === true, legacy: false };
    } catch {
      /* A torn or truncated write. Falls through to the legacy read, which yields an address that
         matches nothing — the same answer an empty file gives, and the safe one. */
    }
  }
  return { address: text, base: null, account: null, discardPending: false, legacy: true };
}

export interface MirrorRecord {
  /**
   * The mailbox this directory's mirror was bootstrapped for, or `null` when the record names
   * none — a paired door, whose mailboxes are the host's answer rather than a configured value.
   *
   * On a LEGACY record (not JSON) this is the file's whole trimmed content, which may be the empty
   * string: that shape is a torn write, and an owner that cannot be established must match nothing
   * rather than be adopted. The distinction is the reason this is not simply "falsy means absent".
   */
  address: string | null;
  /** The server, or null when the record does not establish one. */
  base: string | null;
  /**
   * The account this directory's mail belongs to, as the server named it — or null when no server
   * has. Written by the pairing redeem from the account header and compared on every later redeem,
   * so a host REINSTALLED at the same address cannot merge its mail into this one: same address,
   * different world, two accounts in one database — the failure `enforceMirrorOwner` calls the worst
   * this product has, invisible to an address comparison. NULL IS A DISTINCT STATE, not a value to
   * fill in — every record predating the field and every composition that does not name accounts.
   * Collapsing it into "matches anything" reads "never told" as agreement; into "matches nothing"
   * refuses every such pairing. So it is kept HERE — an absent record is admitted, which is what
   * keeps such a composition pairable — and {@link accountAnswer} tells the two absences apart:
   * nothing RECORDED has nothing to disagree with, nothing NAMED over a recorded id does.
   */
  account: string | null;
  /**
   * The previous world's mail is still here and must go before anything reads it. Written by a
   * pairing told, explicitly, to start over — a host reinstalled at the same address is a different
   * world, and merging it into this one is the worst thing this program can do with someone's mail.
   * STAGED rather than done on the spot, a fact about the database not a preference: at redeem time
   * `pgdata` is an OPEN embedded database, and removing those files under it corrupts the process.
   * The constructor already does the discard correctly before anything opens, and this flag is how a
   * redeem asks it to. The SEAL is deliberately not part of what a pending discard removes — see
   * `enforceMirrorOwner`.
   */
  discardPending: boolean;
  /**
   * True when this record is the ONE-ADDRESS shape an earlier build wrote — load-bearing, not
   * informational. A `null` base means two different things by shape, and collapsing them leaks a
   * credential either way: a LEGACY (non-JSON) record came from a build that could dial exactly one
   * address, so the absence is knowable ({@link MANAGED_CLOUD_BASE}) and reading it as "unknown"
   * would wipe every hosted install on first launch; a MODERN (JSON) record with NO base came from a
   * build that DOES record the server and could not establish one, so the server could be anything —
   * a self-hosted one included — and reading THAT as managed activates someone's own session against
   * ours. So the two are told apart here, and {@link mirrorIsForeign} decides from the difference.
   */
  legacy: boolean;
}

/**
 * Must the state in this directory be thrown away because it belongs to a different server? The
 * whole server-half decision in one place — it has four inputs and every pair has been got wrong
 * once. `holdsCloudState` is whether there is a mirror, cursor or sealed session at all. NOTHING
 * HERE — never foreign. A LEGACY record or NONE — compared against the managed service. A MODERN
 * record naming a server — compared with it. A MODERN record whose server cannot be established —
 * FOREIGN always: missing, blank, non-string or NON-EMPTY-BUT-UNPARSEABLE (the case `baseIsForeign`
 * missed) all mean "nobody can say which server this belongs to". Discarding costs a re-sync;
 * keeping risks handing one server's session to another.
 */
export function mirrorIsForeign(
  record: MirrorRecord | null,
  holdsCloudState: boolean,
  configuredBase: string,
): boolean {
  if (!holdsCloudState) return false;
  /* LEGACY OR ABSENT: the one server the build that wrote it could reach. */
  if (record === null || record.legacy) return baseIsForeign(MANAGED_CLOUD_BASE, configuredBase);
  /* MODERN: which server this state belongs to must be ESTABLISHABLE, not merely present. */
  const owner = record.base === null ? null : normalizeBase(record.base);
  if (owner === null) return true;
  return baseIsForeign(owner, configuredBase);
}

/**
 * WHAT THE TWO SIDES SAID ABOUT THE ACCOUNT — three answers, because two of them are not one.
 *
 * `accountIsForeign` used to fold the last two together and answer `false` for both, which put an
 * ABSENT header on the admitting side of an isolation boundary: a directory bound to an account
 * was paired with a host that named none, and this install then served one world's session over
 * another world's mail. An optional value's absence is "not answered", never "the same".
 */
export type AccountVerdict =
  /** They agree, or nothing is recorded here — a record predating the field, or a first pairing. */
  | "admitted"
  /** Both sides named one and the two differ — the reinstalled host. */
  | "mismatch"
  /** Mail here is bound to an account and the answer named none: nobody can say whose this is. */
  | "unnamed";

/**
 * Whose account does this directory's mail belong to, compared with whose the answer named.
 *
 * NOTHING RECORDED is `admitted` and stays so: there is nothing to disagree with, and refusing
 * would make this install unpairable with a composition that does not name accounts at all.
 * NOTHING NAMED NOW is `unnamed` — the caller refuses it and says which header was missing,
 * because the cost of admitting it is two accounts in one database, the worst thing this program
 * can do with someone's mail, and the cost of refusing it is a re-pair against a host that says
 * who it is. Ids are compared verbatim — folding case or whitespace would invent an equivalence
 * between values a server considers distinct.
 */
export function accountAnswer(
  recorded: string | null | undefined, named: string | null | undefined,
): AccountVerdict {
  if (typeof recorded !== "string" || recorded === "") return "admitted";
  if (typeof named !== "string" || named === "") return "unnamed";
  return recorded === named ? "admitted" : "mismatch";
}

/** Is this directory's mail somebody else's, or unattributable? See {@link accountAnswer}. */
export function accountIsForeign(recorded: string | null | undefined, named: string | null | undefined): boolean {
  return accountAnswer(recorded, named) !== "admitted";
}
