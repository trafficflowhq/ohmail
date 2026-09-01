/**
 * ═══ THE SERVER CONTRACT ═══════════════════════════════════════════════════════════════════════
 *
 * Which hosted server a mirror, a session and a set of settings belong to — and the derivation
 * that turns the address a person types into the base the engine dials.
 *
 * Until there was a third door this file had nothing to say: `mode: "cloud"` meant exactly one
 * server, named by a constant, and "the configured origin" was not a variable anybody could move.
 * A door that lets an operator point the same mode at their OWN server makes it one, and two
 * facts that were previously harmless become the whole of the care needed here:
 *
 *   1. THE MIRROR DIRECTORY IS KEYED BY MODE, NOT BY SERVER. `src-tauri/src/config.rs` derives
 *      `engine-cloud/` from the door alone. So the hosted account and a self-hosted account share
 *      one directory, and `enforceMirrorOwner` — which compared ADDRESSES — could not tell
 *      `me@example.com` on our service from `me@example.com` on the operator's, because they are
 *      the same string. Two different accounts, one database, one `accountId` every read scopes
 *      by: the previous server's mail rendering under the new server's session, which is the
 *      failure shape that function's own header calls the worst this product has.
 *   2. THE SEALED SESSION IS A FACT ABOUT ONE SERVER. `cloud-tokens.seal` holds a bearer minted
 *      by whichever server signed this install in. Re-pointing the door at another server and
 *      keeping that seal means the next launch sends our service's bearer to a machine somebody
 *      else runs — a credential handed to a third party by a settings change. It is the cloud
 *      door's spelling of the boot contract `credential-host.ts` states for the mail password:
 *      *a credential is not a secret in the abstract, it is a secret proved against one server.*
 *
 * Both close at one point, because the discard `enforceMirrorOwner` already performs removes
 * `pgdata`, the cursor AND the seal together. All this file has to do is make that function able
 * to SEE a change of server. It does not add an enforcement point; it widens the one that exists.
 *
 * ── WHY THIS IS ITS OWN FILE, WITH NO IMPORTS ──────────────────────────────────────────────────
 *
 * `credential-host.ts`'s reason, unchanged and for the same two programs. The engine decides;
 * `apps/desktop` composes the value the engine will decide about, and deliberately declares no
 * `@trafficflow/*` dependency — its manifest is published and licence-audited, and every entry in
 * it is a package a stranger's `npm install` must resolve. So the predicate travels as a FILE: no
 * imports, no runtime, importable by relative path from either side, published to the mirror with
 * both of them. One definition means ONE mutation reddens BOTH guards.
 */

/**
 * THE FILE AN OPERATOR PUTS THEIR OWN CERTIFICATE AUTHORITY'S ROOT IN, inside the app's data
 * folder — the whole of the private-CA story, named once so the three places that must spell it
 * identically cannot drift: the shell composes `NODE_EXTRA_CA_CERTS` from it
 * (`src-tauri/src/config.rs`), the engine's probe names it in the refusal an operator reads, and
 * the door's address step names it before they ever hit that refusal.
 *
 * ── WHY A FILE, AND WHY THIS IS THE HONEST ANSWER RATHER THAN THE CONVENIENT ONE ───────────────
 *
 * A self-host stack on a private name issues its own certificates, and that is CORRECT — no public
 * authority can validate `ohmail.test` or `mail.lan`, and the shipped compose stack selects Caddy's
 * local CA for exactly that case. Node does not read the operating system's trust store; it
 * verifies against its own compiled-in roots. So the engine cannot see such a certificate as valid
 * no matter what the operator has installed on their machine, and the only two truthful ways
 * forward are a certificate from an authority Node already trusts, or telling Node about theirs.
 *
 * `NODE_EXTRA_CA_CERTS` is the second, and it ADDS a root — it never replaces the built-in set and
 * never relaxes verification. There is deliberately no third option: nothing in this app can turn
 * certificate checking off, because a switch for that would end up on, and a self-hoster's whole
 * mailbox flows over that connection.
 *
 * Measured against the running self-host stack: a default TLS handshake to it threw
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, and the same handshake with this variable pointed at the
 * stack's exported root came back `authorized`.
 */
export const OPERATOR_CA_FILE = "cloud-ca.pem";

/**
 * THE ONE SERVER EVERY BUILD BEFORE THE SELF-HOSTED DOOR COULD DIAL.
 *
 * Not a default and not a fallback destination — nothing is ever CONFIGURED from this value. It
 * answers exactly one question: *what server does a mirror-owner record that names no server
 * belong to?*
 *
 * ── WHY "ADOPT IT" WAS THE WRONG ANSWER, WHICH IS WORTH WRITING DOWN BECAUSE IT WAS WRITTEN ───
 *
 * The first version of this file treated a recorded base of `null` as "cannot compare, so not a
 * change of server", by analogy with `credential-host.ts`'s one-sided default. That analogy holds
 * for a credential whose host was never recorded — there is genuinely nothing to compare. It does
 * NOT hold here, and the difference is that this absence is not unknown: a Cloud mirror written by
 * any earlier build was built against this address, because it was a constant in the shell and
 * there was no way to configure another.
 *
 * Treating it as unknown created a credential leak on the MIGRATION LAUNCH — the one launch this
 * reasoning was supposed to protect:
 *
 *   1. an existing install holds `cloud-tokens.seal` minted by this service, and a one-line marker;
 *   2. the person updates and immediately points the door at another server at the same address;
 *   3. the address is unchanged and the recorded base is absent, so nothing looks foreign — the
 *      mirror and the sealed session both survive, and the marker is rewritten as if the new server
 *      had always owned them;
 *   4. the engine boots and puts this service's bearer in an `Authorization` header addressed to
 *      that server, which can then answer 401 and collect the refresh token too.
 *
 * Reading the absence as THIS BASE makes step 3 a positive disagreement, so the seal and the mirror
 * are discarded before anything is dialled. It costs nothing in the ordinary case: an existing
 * hosted install relaunching against this same address compares equal and keeps its mirror.
 */
export const MANAGED_CLOUD_BASE = "https://api.ohmail.app";

/**
 * The base a mirror-owner record belongs to: what it says, or — when it says nothing — the one
 * server the build that wrote it could have been talking to. See {@link MANAGED_CLOUD_BASE}.
 *
 * `null` in, `MANAGED_CLOUD_BASE` out. The caller must only ask this of a record that EXISTS; a
 * missing record is a fresh directory with nothing to compare and is adopted, which is a different
 * question and deliberately not this function's.
 */
export function recordedBaseOfExisting(base: string | null): string {
  return base ?? MANAGED_CLOUD_BASE;
}

/**
 * ── THE `/api` SUFFIX IS NOT COSMETIC, AND IT IS THE ONE THING A SELF-HOST DOOR CANNOT GUESS ───
 *
 * The two deployments do not present the API at the same place, and the difference is invisible
 * until a request that is not `/health` is made:
 *
 *  · THE HOSTED SERVICE has a whole hostname to itself. `https://api.ohmail.app/sync` is the API.
 *  · A SELF-HOST STACK serves ONE origin — the browser client, the landing pages and the API all
 *    behind one Caddy site (`deploy/selfhost/Caddyfile`), which routes `/api/*` to the API
 *    container and everything else to the web container. `https://<origin>/sync` therefore
 *    reaches the NEXT APP, which answers `404` as an HTML error page.
 *
 * Measured against the running stack rather than read off the config: `https://ohmail.test/sync`
 * answered `404 text/html` from Next, and `https://ohmail.test/api/sync` answered
 * `401 {"error":{"code":"unauthorized"}}` from the API. A door that used the typed origin as the
 * base would have produced a mirror that signed in (`/auth/*` IS routed at the bare path) and then
 * synced nothing, for ever, with an HTML 404 as the only clue.
 *
 * `<origin>/api` is the base that works against BOTH, which is why the derivation is this and not
 * a per-flavor branch: the API canonicalizes ONE leading `/api` off itself (the Caddyfile says so,
 * and the reason is idempotency hashing — a strip in the proxy would double-strip `/api/api/…`).
 * Measured on the hosted service too: `https://api.ohmail.app/api/hello` → `200`, and
 * `https://api.ohmail.app/api/sync` → `401`, exactly as the un-prefixed paths answer.
 *
 * So the SELF-HOST door composes `<origin>/api` and the hosted door keeps its own constant
 * untouched. Nothing about the working door moves to accommodate the new one.
 */
export function apiBaseFor(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api`;
}

/**
 * WHAT A PERSON MAY TYPE INTO "your server's address", REDUCED TO AN ORIGIN — or null.
 *
 * Null for every input this cannot turn into an unambiguous origin. The caller owns the sentence,
 * because the sentence has to name what was rejected and this function deliberately does not
 * classify: a returned reason would be a second, quieter copy of the door's copy.
 *
 * ── WHAT IS ACCEPTED, AND THE ONE THING THAT IS ADDED ──────────────────────────────────────────
 *
 * A bare host — `ohmail.example.com` — gets `https://`. That is the only value this function ever
 * invents, and it can only ever be the SAFE direction: an operator who meant plain HTTP has to say
 * so, and one who typed a host and meant HTTPS is not silently downgraded. An operator on
 * `http://localhost` (a shape the stack supports and documents) types the scheme, and their probe
 * either answers or names what was tried.
 *
 * ── WHAT IS REFUSED, AND WHY EACH REFUSAL IS BETTER THAN A REPAIR ──────────────────────────────
 *
 *  · A SCHEME THAT IS NOT `http`/`https`. Nothing else is an origin this app can dial.
 *  · **`http:` ON ANYTHING BUT LOOPBACK.** This accepted cleartext for every hostname, and that
 *    made the door's own promise false: the address step says ohmail verifies certificates and has
 *    no way to skip that, while `http://ohmail.example.com` skips TLS entirely — there is no
 *    certificate and no server authentication at all. An on-path peer answers the probe with
 *    `{"product":"ohmail"}`, the door advances, and the account password and the authenticator code
 *    are posted to whoever is listening. Loopback is the one exception and it is not a loophole:
 *    `http://localhost` is a deployment the self-host stack documents and supports, and a
 *    connection that never leaves the machine has no path for anyone to be on.
 *  · A PATH. `https://ohmail.example.com/api` composed with {@link apiBaseFor} is `…/api/api`,
 *    which the API canonicalizes exactly one `/api` off and then 404s. Silently stripping the path
 *    would be guessing which half the operator meant; the stack's own `OHMAIL_ORIGIN` is scheme +
 *    host and nothing else, so a path is a mistake with a server-side definition behind it.
 *  · A QUERY OR FRAGMENT. Same class: a pasted URL from somewhere it did not belong.
 *  · EMBEDDED CREDENTIALS (`https://user:pass@host`). A password typed into an address field must
 *    never be quietly carried into a settings file the shell writes to disk.
 *
 * The port is kept when it is explicit and not the scheme's default, because a self-host stack on
 * `:8443` is an ordinary thing and dropping it would dial the wrong socket. Host case is folded;
 * nothing else is.
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
 * IS THIS HOSTNAME THIS MACHINE, so that a cleartext connection never leaves it?
 *
 * The set is exactly what cannot be reached from another host: the name `localhost` and any name
 * under it (browsers and the URL standard treat `*.localhost` as loopback), the whole of
 * `127.0.0.0/8`, and IPv6 `::1`. `new URL` normalises an IPv6 literal into brackets, hence the
 * two spellings.
 *
 * DELIBERATELY NOT "private" or "link-local". `10.x`, `192.168.x` and `169.254.x` are reachable
 * from every other machine on that network, which is where an on-path peer would be — a LAN is not
 * a trust boundary, and treating it as one is how a password ends up on somebody's wifi.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A base URL reduced to what a comparison may look at — or null when it is not one.
 *
 * `normalizeHost` in `credential-host.ts` folds whitespace and case and NOTHING else, for the
 * reason stated there: inventing an equivalence would silently admit a credential across a
 * difference somebody deliberately typed. The same conservatism applies here with one addition
 * that is not an invention but a spelling: a trailing slash and the scheme's default port are the
 * SAME URL by the standard's own definition, so `new URL` is asked rather than a regexp guessed.
 *
 * The PATH is kept and compared. It is what tells `https://ohmail.test/api` from
 * `https://ohmail.test`, and those two are genuinely different bases — one reaches the API and one
 * reaches the web app.
 *
 * ── A QUERY, A FRAGMENT OR USERINFO IS REFUSED, NOT DROPPED ───────────────────────────────────
 *
 * This used to strip them, which is wrong in both directions and review named both. Dropping makes
 * two DIFFERENT bases compare EQUAL: `https://gateway/api` and `https://gateway/api?upstream=b` are
 * plausibly two backends behind one gateway, and reading them as the same server is exactly the
 * comparison that lets a sealed session survive a move between them. And a dropped component is a
 * value the caller believed it had configured, silently not in effect.
 *
 * Refusing is the only reading that is right for both jobs this function has. As a COMPARISON it
 * can no longer erase a difference; as a CANONICALIZER it fails a base that carries anything the
 * composition below it cannot represent, and the caller (`createCloudSidecar`) refuses the launch
 * rather than dialling something other than what it was given.
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
 * IS THIS MIRROR'S RECORDED SERVER A DIFFERENT SERVER THAN THE ENGINE IS CONFIGURED FOR?
 *
 * ── THE ONE-SIDED DEFAULT, WHICH IS THE WHOLE OF THE CARE THIS NEEDS ───────────────────────────
 *
 * `credentialIsForeign`'s rule, restated because it has to hold identically here: `false` —
 * "not a change of server" — whenever the comparison cannot be made.
 *
 *  · THE MARKER RECORDS NO SERVER. Every install that predates this file is in that state: its
 *    marker holds an address on one line and nothing else. Reading "no server recorded" as a
 *    change would discard the mirror of every existing hosted install on its first launch after
 *    the update — throwing away a working, fully-synced mailbox to close a case that install
 *    cannot be in, since the only door it has ever had is the one constant. It is ADOPTED, exactly
 *    as an install predating the address marker is adopted, and the record is rewritten complete;
 *    the guarantee is forward, and nothing can reach a second server without passing this again.
 *  · EITHER SIDE IS UNPARSEABLE. There is nothing to disagree with, and a launch in that state has
 *    a larger problem than this one.
 *
 * `true` is therefore only ever returned on a POSITIVE disagreement: both sides named a base, both
 * parsed, and they are not the same base. That is the only case in which throwing a mirror and a
 * sealed session away is certainly right — and it is exactly the case the third door creates.
 */
export function baseIsForeign(recorded: string | null | undefined, configured: string | null | undefined): boolean {
  if (typeof recorded !== "string" || typeof configured !== "string") return false;
  const left = normalizeBase(recorded);
  const right = normalizeBase(configured);
  if (left === null || right === null) return false;
  return left !== right;
}

/**
 * THE MIRROR-OWNER RECORD, AS IT IS WRITTEN TO DISK.
 *
 * ONE file and therefore ONE write. Two files would be two writes with a tear between them, and the
 * marker goes to some trouble to make a torn write unmistakable — an EMPTY file reads as an owner
 * that cannot be established and matches nothing, rather than as an absent marker, which is
 * adopted. A second file would reintroduce exactly the state that distinction exists to refuse.
 *
 * ── JSON, AND NOT TWO LINES, BECAUSE THE FRAMING MUST NOT DEPEND ON THE VALUES ────────────────
 *
 * This was `address + "\n" + base`, which is fine for every value either field can hold today and
 * is a latent hazard rather than a bug: both arrive from the engine's environment
 * (`OHMAIL_MAILBOX_ADDRESS`, `OHMAIL_CLOUD_URL`) or from a hand-edited settings file, and an
 * environment variable may contain a line break. One in the ADDRESS pushes the real base off the
 * line the reader looks at, so the recorded server reads as absent — and an absent server is
 * ADOPTED, which is the one answer that silently switches this protection off. A delimiter a value
 * can contain is a delimiter the value can move.
 *
 * JSON has no such property, so nothing about the framing depends on what the fields hold. It is
 * also self-describing, which is what lets the legacy shape be told apart without a version field:
 * anything that is not a JSON object is a marker written before the server joined the record — one
 * bare address, no server, adopted.
 */
export function encodeMirrorRecord(address: string, base: string | null): string {
  return JSON.stringify({ address, base });
}

/**
 * The record as its two facts. Never throws; every unreadable shape degrades to "no server".
 *
 * `address` is preserved VERBATIM apart from trimming, the empty string included — see
 * `readMirrorOwner` for why an empty owner must never be collapsed into an absent one. A file that
 * is not JSON is the LEGACY shape and its whole trimmed content is the address, which is what makes
 * an install written before this parse correctly rather than as an owner of "".
 */
export function decodeMirrorRecord(raw: string): { address: string; base: string | null } {
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { address?: unknown; base?: unknown };
      const address = typeof parsed.address === "string" ? parsed.address.trim() : "";
      const base = typeof parsed.base === "string" && parsed.base.trim() !== "" ? parsed.base.trim() : null;
      return { address, base };
    } catch {
      /* A torn or truncated write. Falls through to the legacy read, which yields an address that
         matches nothing — the same answer an empty file gives, and the safe one. */
    }
  }
  return { address: text, base: null };
}
