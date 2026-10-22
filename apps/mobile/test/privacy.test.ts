/**
 * PRIVACY AND CONFINEMENT as a gate over this app's own source.
 *
 * Three promises the README makes, checked rather than asserted:
 *
 *  1. **Zero real identity, zero real brands.** The banned terms are the privacy
 *     guard's own list, read through `guardFrom`: the private list where the
 *     run names it (OHMAIL_GUARD_LIST), else the synthetic set in `packages/fixtures/src/privacy.ts`
 *     — never a second list kept here that could quietly diverge.
 *  2. **Network access is CONFINED to the engine seam** — the files enumerated
 *     below as {@link ENGINE_SEAM}. Everything else — every screen, the theme —
 *     fetches nothing, opens no socket and names no endpoint. A new file that
 *     wants the network has to join the list here, in a reviewed diff, or the
 *     scan fails it.
 *  3. **No demo data ships** (owner ruling, 2026-08-20: demo data lives on the
 *     product's website alone; every app opens empty and connects). The shipped
 *     source imports nothing from `@ohmail/fixtures` — the scan below fails the
 *     first file that reaches for the demo corpus again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guardFrom, PUBLIC_GUARD, type GuardLists } from "@ohmail/fixtures";
import { maskEntries, privateGuardText, privateModeIt } from "../../../test/support/guard-list.js";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "ios", "android", "assets"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".json", ".md"]);

/**
 * THE ONE GENERATED DIRECTORY — scanned by a census of its own, not by the rules below.
 *
 * `generated/` holds the phone's pre-bundled mail engine: 6 MiB written by
 * `scripts/bundle-engine.mjs`, ignored by git, rebuilt by every phone build. The rules in this
 * file are about SOURCE somebody wrote, and every one of them answers wrongly over a bundle of the
 * whole engine — it names mail providers because the provider table is product data, it opens
 * sockets because it IS the engine, and it would fail the seam list by not being on it. A scan that
 * cannot tell generated output from source gets an inline suppression bolted on within a week,
 * which is how scans stop meaning anything.
 *
 * So it is skipped here and censused there, and the pair is asserted in both directions:
 *
 *   · what shipped inside it is measured by `test/engine-packaging.test.ts` — the absolute-path
 *     census (no build machine's home directory), the size ceiling, and the boot;
 *   · what is in its GRAPH is measured over the metafile by `test/no-node-builtins.test.ts` and
 *     the dialect census, which is the reading a text scan could not give;
 *   · and the case below refuses this skip if that census stops naming the directory, so the hole
 *     cannot be widened by deleting the thing that covers it.
 *
 * Skipped BY PATH rather than by name: a hand-written `src/generated/` would not inherit this.
 */
const GENERATED_DIR = join(APP_DIR, "generated");

function files(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (full === GENERATED_DIR) continue;
    if (statSync(full).isDirectory()) files(full, acc);
    else if (SOURCE_EXT.has(extname(entry))) acc.push(full);
  }
  return acc;
}

const sources = files(APP_DIR).map((path) => ({
  path: path.replace(APP_DIR, ""),
  body: readFileSync(path, "utf8"),
}));

/**
 * What Metro actually bundles: no tests, no Markdown.
 *
 * The distinction is not an exemption, it is the scan's subject. A test that
 * *names* `fetch(` in order to forbid it, and a README that *documents* the
 * ban, are prose about network calls, not network calls; a scan that cannot
 * tell the difference gets an inline `// eslint-disable` bolted on within a
 * week, which is how scans stop meaning anything. The privacy scan below
 * deliberately keeps the wider set — a real brand in a test file is still a
 * real brand in this repository.
 */
const shipped = sources.filter(
  (f) => !f.path.startsWith("test/") && extname(f.path) !== ".md",
);

describe("the source tree is scanned at all", () => {
  it("found the screens, the theme, the state and the readme", () => {
    const paths = sources.map((f) => f.path);
    expect(shipped.length).toBeGreaterThan(15);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain("app/(tabs)/index.tsx");
    expect(paths).toContain("src/theme/palette.ts");
    expect(paths).toContain("src/state/model.ts");
    expect(paths).toContain("README.md");
  });

  it("skipped the generated engine, and nothing else", () => {
    // Both halves. The bundle is out of THIS scan (it would fail every rule for reasons that are
    // not defects), and the skip reaches exactly one directory — the app's own source under
    // `src/` and `app/` is all still here, including the two files the packaging half added.
    const paths = sources.map((f) => f.path);
    expect(paths.filter((p) => p.startsWith("generated/"))).toEqual([]);
    expect(paths).toContain("src/engine/engine-bundle-native.ts");
    expect(paths).toContain("src/engine/artifact-present.js");
    expect(paths).toContain("metro.config.js");
  });

  it("the generated engine is covered by a census that names it — the skip is not a hole", () => {
    /**
     * The other direction. Skipping `generated/` here is only defensible while something else
     * measures what shipped in it, so this reads that file and refuses if it stops naming the
     * directory or the artifact. Watched failing by renaming `PACKAGED_DIR` in the packaging test.
     */
    const packaging = readFileSync(join(APP_DIR, "test/engine-packaging.test.ts"), "utf8");
    expect(packaging).toContain("MACHINE_PATH_PREFIXES");
    expect(packaging).toContain("generated/phone-engine.js");
  });

});

/**
 * The banlist keeps real brands out of the DEMO WORLD — fixture mail must never name one.
 * The README documenting where this repository's own CI and releases live is a different kind
 * of sentence: "the APK is attached to the release" names the project's forge as a fact about
 * the project, not fixture content. One term, one file, stated here so the exemption is a
 * reviewed diff rather than a silent hole; the same term anywhere else — a screen, a fixture,
 * the copy deck — still fails. The term comes from the private list by its role (`forge`),
 * because this file scans itself and must not restate what it bans.
 */
const guard = guardFrom(privateGuardText());
const role = (name: string): readonly string[] => guard.roles[name] ?? [];
/**
 * The second exempt file, and the same kind of sentence one flight further: `src/net/account.ts`
 * holds the address of THIS PROJECT'S OWN self-hosting guide, which the wall offers to somebody
 * whose managed account has closed and who is taking their mailbox somewhere else. The guide is
 * on the project's forge, under the project's organisation, so the address spells both terms —
 * a fact about the project, not fixture content, and the browser's wall spells the very same one.
 *
 * Narrow on purpose: two terms, ONE file, and that file is the network seam, which is already the
 * only place an address may be written down. A screen that spelled it would still fail here.
 */
const EXEMPT: ReadonlyArray<{ path: string; term: string }> = [
  ...role("forge").map((term) => ({ path: "README.md", term })),
  ...role("forge").map((term) => ({ path: "src/net/account.ts", term })),
  ...role("org").map((term) => ({ path: "src/net/account.ts", term })),
];

/*
 * IDENTIFIERS OF OURS THAT SPELL A BANNED TERM INSIDE THEMSELVES. The scan is a substring
 * scan and must stay one — a brand glued into a name (`<brand>Adapter`) is exactly what it is
 * for. But `sendingMailboxId`, the engine's own compose-from selector, contains one of the
 * banned words across its own word boundary. So the SPELLING is blanked before the scan, not
 * the term and not the file: any other occurrence in the same file still hits, which the
 * companion case below drives.
 */
const OURS = ["sending", "Mailbox", "Id"].join("");
const scrub = (body: string): string => body.split(OURS).join("");

/**
 * Every banned hit in `files` as `<path>: entry #<i>`: the entry by its index, and the path masked,
 * because a file can be named after what it must not say. A red names no entry.
 */
function bannedHits(files: ReadonlyArray<{ path: string; body: string }>, lists: GuardLists): string[] {
  const hits: string[] = [];
  for (const { path, body } of files) {
    const lower = scrub(body).toLowerCase();
    lists.shared.forEach((term, i) => {
      if (EXEMPT.some((e) => e.path === path && e.term === term)) return;
      if (lower.includes(term)) hits.push(`${maskEntries(path, lists)}: entry #${i}`);
    });
  }
  return hits;
}

/** The entries the scan MISSED when each was planted alone, upper-cased, in a new screen: indices. */
function missedWhenPlanted(lists: GuardLists): number[] {
  expect(lists.shared.length).toBeGreaterThan(0);
  return lists.shared.flatMap((term, i) => {
    const planted = { path: "app/planted.tsx", body: `export const label = "${term.toUpperCase()}";` };
    return bannedHits([planted], lists).includes(`app/planted.tsx: entry #${i}`) ? [] : [i];
  });
}

/**
 * The entries a red would QUOTE: each planted alone, upper-cased, in the NAME of a file whose body
 * carries the first shared entry (so a corpus-only plant reds too). The red quotes no entry at all.
 */
function quotedInRed(lists: GuardLists): number[] {
  const all = [...lists.shared, ...lists.corpusOnly];
  expect(lists.shared.length).toBeGreaterThan(0);
  return all.flatMap((term, i) => {
    const red = bannedHits([{ path: `src/zz-${term.toUpperCase()}.ts`, body: lists.shared[0]! }], lists).join("\n");
    return red !== "" && !all.some((t) => red.toLowerCase().includes(t)) ? [] : [i];
  });
}

describe("privacy: no real identity, no real brands", () => {
  it("carries none of the banned terms, anywhere", () => {
    expect(bannedHits(sources, guard)).toEqual([]);
  });

  privateModeIt(
    "PRIVATE MODE — every private entry planted in a screen is caught",
    () => {
      expect(guard.mode, "the run names the private list, and this scan reads it").toBe("private");
      expect(missedWhenPlanted(guard), "private entries missed, by index").toEqual([]);
    },
  );

  it("PUBLIC SET — every synthetic entry planted in a screen is caught", () => {
    expect(missedWhenPlanted(PUBLIC_GUARD), "synthetic entries missed, by index").toEqual([]);
  });

  privateModeIt(
    "PRIVATE MODE — a red masks a private entry in a file's name and quotes none",
    () => {
      expect(guard.mode, "the run names the private list, and this scan reads it").toBe("private");
      expect(quotedInRed(guard), "private entries quoted, by index").toEqual([]);
    },
  );

  it("PUBLIC SET — a red masks a synthetic entry in a file's name and quotes none", () => {
    expect(quotedInRed(PUBLIC_GUARD), "synthetic entries quoted, by index").toEqual([]);
  });

  it("blanking our own identifier hides nothing else — the scan still reads its file", () => {
    // The identifier is really there (a dead scrub would pass this file for the wrong reason)…
    expect(sources.some((f) => f.body.includes(OURS))).toBe(true);
    // …with the private list it spells exactly one banned term (the public set spells none)…
    const spelt = guard.shared.flatMap((t, i) => (OURS.toLowerCase().includes(t) ? [i] : []));
    expect(spelt.length).toBe(guard.mode === "private" ? 1 : 0);
    // …and a file carrying BOTH the identifier and a genuine mention still hits on the mention.
    const i = spelt[0] ?? 0;
    const genuine = { path: "app/planted.tsx", body: `${OURS} // a real mention: ${guard.shared[i]}` };
    expect(bannedHits([genuine], guard)).toContain(`app/planted.tsx: entry #${i}`);
  });

  it("no exemption is a dead rule — every term is really in the file that claims it", () => {
    /**
     * Both directions, for every row: the file is in the scanned set, and the term it is excused
     * for is actually there. An exemption whose term has since left is a hole standing open over
     * nothing, and it would excuse the term's RETURN in silence — which is the only way a list
     * like this fails.
     */
    expect(EXEMPT.length).toBe(guard.mode === "private" ? 3 : 0);
    for (const { path, term } of EXEMPT) {
      const file = sources.find((f) => f.path === path);
      expect(file, `exempt but not in the scanned set: ${path}`).toBeDefined();
      expect(file!.body.toLowerCase().includes(term), `exempt for a term it does not carry: ${path}`)
        .toBe(true);
    }
  });

  it("uses the shared list, and the shared list is not empty", () => {
    // Deliberately does NOT restate any banned term: this file is inside the scanned tree, so
    // re-listing them here would be the leak it is checking for. The private list is the one place
    // they live; a public checkout runs the synthetic set, which is never empty either.
    expect(guard.shared.length).toBeGreaterThan(guard.mode === "private" ? 20 : 0);
    expect(new Set(guard.shared).size).toBe(guard.shared.length);
  });
});

/**
 * THE FILES ALLOWED TO REACH A NETWORK — the engine seam plus the
 * connection layer. Exact paths, not a directory prefix: a file placed beside
 * them does not inherit the licence, it fails the scan until it is added here
 * on review. What joined in that change, and why each:
 *   · src/net/bearer.ts     — the BearerManager's rotation/logout requests;
 *   · src/net/pairing.ts    — /hello negotiation, the pair redeem, the
 *                             account-id resolution, and the one URL constant
 *                             (the managed origin) the picker negotiates with;
 *   · src/net/connection.tsx — the provider composing the two above with the
 *                             engine boot.
 * `app/connect.tsx` LEFT the seam in the same change: the manual screen now
 * drives the connection layer and holds no fetch and no endpoint of its own.
 * The screens (servers/scan/connect) stay outside — they render sentences and
 * call the seam; the scan below keeps them incapable of a network call.
 */
const ENGINE_SEAM = new Set([
  "src/engine/boot.ts",
  "src/engine/native.ts",
  "src/net/bearer.ts",
  "src/net/pairing.ts",
  "src/net/connection.tsx",
  /**
   * the wake registration, widened in that change to THREE authenticated calls — `GET /push/vapid-key`
   * and `POST`/`DELETE /push/subscriptions`. It joins the seam on the narrowest terms available: it
   * holds NO origin of its own. Every request is
   * `session.bearer.fetch(`${session.profile.origin}/…`)`, so the only server it can reach is the
   * profile the user is currently paired with, and "the endpoint goes to the active profile's
   * server, never anywhere else" is structural rather than promised. The endpoint-shaped string it
   * handles comes FROM the device's distributor and is sent TO that one origin; it is never dialled
   * from here.
   */
  "src/net/push.ts",
  /**
   * The folders wave's consent read/write — `GET /consent` and `PATCH /consent/settings` on
   * the ACTIVE profile's server, `push.ts`'s exact terms: it holds NO origin of its own, every
   * request is `session.bearer.fetch(`${session.profile.origin}/…`)`, so the only server it
   * can ask is the one the user paired with. It reads three fields (`foldersEnabledAt`; the
   * `signatures` map the composer's block renders from — mail 0075; and `themeFace`, the
   * account's appearance face — OHMARCHY-PLAN.md §3a) and writes two, one axis per call:
   * `foldersEnabled` (the "Use folders" switch, FOLDERS-SPEC.md §6) and `themeFace`
   * ("apply on all devices" for the face).
   */
  "src/net/consent.ts",
  /**
   * The away responder's read/write — `GET /away-responder` and `PUT /away-responder` on the
   * ACTIVE profile's server, `consent.ts`'s exact terms: it holds NO origin of its own, every
   * request is composed off `requestBase(session)` and issued through `session.fetch`, so the
   * only server it can ask is the one the user paired with. It reads one row and writes it back
   * WHOLE — the route is a full replace (`away-form.ts`'s header) — and a read it could not make
   * answers `null` rather than a default row, which is what keeps a save from writing the
   * route's defaults over an audience and a pile scope set somewhere else.
   */
  "src/net/away.ts",
  /**
   * What the Screener filed on its own, and Put back — `GET /screener/auto-filed` and
   * `POST /screener/auto-filed/undo`, `away.ts`'s exact terms: no origin of its own, every request
   * composed off `requestBase(session)` through `session.fetch`, and a read it could not make
   * answers `null`, never an empty list.
   */
  "src/net/auto-filed.ts",
  /**
   * THE FOUND-SETTINGS QUESTION — `GET /mailboxes/:id/profile-import` and its three answers
   * (`POST` apply, `/decline`, `/replace`) on the ACTIVE session's door, `away.ts`'s exact terms:
   * no origin of its own, every request composed off `requestBase(session)` and issued through
   * `session.fetch`, which on the standalone door is the engine in this app. It writes only the
   * person's answer; a read it could not make answers `null`, never `none`.
   */
  "src/net/profile-import.ts",
  /**
   * The folder verbs' one read beside the engine — `GET /folders/:id/summary`, the delete
   * confirm's server-truth counts (FOLDERS-SPEC.md §18). `consent.ts`'s exact terms: no
   * origin of its own, every request is `session.bearer.fetch(`${session.profile.origin}/…`)`,
   * and a failed count answers `null` (the uncounted sentence), never a guess.
   */
  "src/net/folder-ops.ts",
  /**
   * WHERE A SERVER'S MAIL API IS — two credential-free probes, `push.ts`'s exact terms plus one.
   *
   * It holds NO origin of its own and opens no socket of its own: the transport arrives as a
   * parameter and the address arrives as a parameter, so the only server it can reach is the one
   * the caller — the pairing ceremony, or the door screen through `connection.tsx#probeBase` —
   * already decided to talk to. What it composes is `<that origin>/sync` and `<that origin>/api/sync`
   * and nothing else, with no headers at all.
   *
   * The one addition to `push.ts`'s terms is that it names ADDRESSES in its prose — the measured
   * answers from the hosted service and from a self-host stack that the whole derivation rests on.
   * That is the reason a URL pattern is in this scan at all working as intended: a measurement is
   * evidence and belongs beside the code it justifies, and the seam is where an address is allowed
   * to be written down. Nothing outside this list may name one, in a comment or otherwise, which is
   * what keeps a dev-server URL from being pasted into a screen.
   *
   * Its two imports are both single-definition rules rather than machinery: the address parse comes
   * from `apps/sidecar/src/cloud-origin.ts`, which is import-free by construction so the desktop and
   * the phone cannot hold two different rules about which addresses are acceptable; and
   * `originNeedsPin` comes from the engine package, which is what the pairing seam already refuses a
   * pinless numeric address by — the door must not come to disagree with the seam that enforces it.
   * The engine import means this file is inside {@link ENGINE_IMPORTERS} too, which it gets for free
   * by being in this set; that is correct rather than incidental, since being allowed a transport is
   * strictly the broader licence.
   */
  "src/net/server-base.ts",
  /**
   * THE MAILBOX READ — `GET /mailboxes` on the ACTIVE profile's server, `consent.ts`'s exact
   * terms and nothing wider: it holds NO origin of its own, its single request is
   * `session.bearer.fetch(`${session.profile.origin}/mailboxes`)`, and it writes nothing at all.
   * A READ-ONLY member of this seam, which is the narrowest a file that touches the network can be.
   *
   * WHY THE PHONE NEEDED ONE AT ALL, since it had gone this far without: two surfaces were
   * degraded by its absence and said so in their own comments (`state/live.ts`) — the reader could
   * not be told apart from the other recipients in a To/Cc list, and the onboarding deck's
   * `phoneBanner` had no consumer, because naming who organizes a mailbox with no source would be
   * an invented claim. What it brings back is the account's own mailbox addresses and the holder's
   * machine name; no message content, no counts (`?counts=1` is deliberately not sent). The
   * self-check (`GET /mailboxes/:id/self-check`) is a second read of the same server on the same terms.
   */
  "src/net/mailboxes.ts",
  /**
   * THE WAITING QUEUE READ — `GET /screener` on the ACTIVE profile's server, on `mailboxes.ts`'s
   * exact terms: no origin of its own, one request shape built from `session.profile.origin`,
   * `session.fetch` as the only transport, and it writes nothing. A READ-ONLY member.
   *
   * WHY THE PHONE NEEDED IT. The queue is the server's own derivation over mail held in
   * `ohmail/Screener` and it consults no rules; the client partition re-homes a RULED sender's
   * held mail for display, so that sender left the phone's queue while the server was still
   * asking about them — nine waiting on the server, four on the phone, measured on a device. The
   * answer it brings back is a list of senders and the one message representing each: the same
   * mail this mirror already holds, named by the end that is holding it.
   */
  "src/net/screener.ts",
  /**
   * THE ACCOUNT DOOR'S TWO READS — `GET /account/access` and the `GET` whose path the SERVER
   * named (`exportPath`), on `mailboxes.ts`'s exact terms: no origin of its own, every request
   * composed from `requestBase(session)` — the active profile's origin or its `apiBase` — and
   * `session.fetch` as the only transport. READ-ONLY: it writes nothing, and on the standalone
   * door, which has no plane, both reads answer `null` before a socket exists.
   *
   * WHY THE PHONE NEEDED IT. A managed account the service has closed refuses every other door
   * with a 402, and a phone that could only hear the refusal could say what happened but not what
   * to do about it: the lifecycle, the account page and the settings export all come back here,
   * and the catch-up strip after a reopening needs a read that is not behind the 60 s cache.
   *
   * The one addition to `mailboxes.ts`'s terms is `server-base.ts`'s: it NAMES an address, the
   * self-hosting guide the wall offers next to somebody's exported settings. That is the licence
   * this seam exists to grant — an address is written down here, and nowhere else, which is what
   * keeps one out of a screen.
   */
  "src/net/account.ts",
  /**
   * THE CONSENTED REMOTE-IMAGE FETCH, on the person's "Show images" press. On a paired door it
   * asks the ACTIVE profile's server (`requestBase(session)`, `session.fetch`) for `/img`, the
   * proxy the web uses. On the standalone door it is the ONE member of this seam that dials a
   * host the profile does not name, because the READER named it — no credentials, no headers of
   * ours — and the notice says the sender sees this phone's address. Either way the bytes
   * re-enter only as a gated `data:` URI; the frame's `img-src data:` never widens.
   */
  "src/mail/remote-images.ts",
]);

/**
 * ── THE DISTRIBUTOR CONNECTOR — a NATIVE-module seam, and deliberately not a network one ──────
 *
 * `src/net/unified-push.ts` is admitted to a list of its own rather than to {@link ENGINE_SEAM},
 * because what it is allowed to do is different in kind. It opens NO socket and names NO endpoint:
 * it calls into `expo-unified-push` and receives an endpoint URL that the DEVICE's distributor
 * minted, which `push.ts` then sends to the paired server. So it must still satisfy every network
 * pattern below — no `fetch`, no URL literal, nothing — and the scan keeps holding it to that.
 *
 * What it needs is an exemption from the module ban instead: `expo-unified-push` is a native module
 * import, and the ban list below is what keeps `expo-notifications` out permanently. Naming this
 * one file, rather than allowing the module everywhere, is what makes a second importer a reviewed
 * diff.
 *
 * `src/state/wake.ts` imports it and holds React state; it makes no request of its own (every
 * server call goes through `push.ts`), which is why it is NOT in the network seam and the scan
 * below still forbids it a fetch.
 */
const NATIVE_PUSH_SEAM = new Set(["src/net/unified-push.ts"]);

/**
 * THE FILES ALLOWED TO IMPORT `@ohmail/client-engine` — the seam, plus the live-world
 * module. `src/state/live.ts` is the one place the screens' live arm reads the shared
 * selectors and dispatches `engine.mutate`; it holds NO transport of its own (the engine is
 * handed in through the connection), so it joins the IMPORT allow-list and deliberately NOT
 * the network seam above — the pattern scan below still forbids it a fetch, a socket or an
 * endpoint, which is exactly the property that makes it safe to widen this list by.
 */
const ENGINE_IMPORTERS = new Set([
  ...ENGINE_SEAM,
  "src/state/live.ts",
  /**
   * THE MIRROR'S WRITE QUEUE — a NAMED consumer, not a widening.
   *
   * `src/engine/sql-queue.ts` holds the rule that only one operation at a time may run against a
   * mirror file, because expo's `withExclusiveTransactionAsync` runs on a second connection and
   * two overlapping writes abort one of them. It takes four TYPES from the engine package
   * (`SqlExecutor`, `SqlRow`, `SqlStatement`, `SqlValue`) — the seam's own vocabulary, which is
   * the only way to implement that seam without restating it.
   *
   * It is admitted HERE and deliberately NOT to {@link ENGINE_SEAM}: this list is "may name the
   * engine's types", the other is "may open a connection". The file does neither `fetch` nor URL,
   * and the network scan above still holds it to that — which is the whole point of the two lists
   * being separate rather than one.
   */
  "src/engine/sql-queue.ts",
  /**
   * THE DIAGNOSTIC FILE'S BUILDER — a NAMED consumer on the queue's terms. `src/engine/diagnostics.ts`
   * takes the one builder the desktop shares (`buildDiagnosticBundle` and its constants) and the
   * mirror's entity list; it writes through a door it is handed and opens no connection, which the
   * pattern scan above holds it to. Its native half imports it rather than the package, so the
   * path keeps one importer.
   */
  "src/engine/diagnostics.ts",
  /**
   * THE ROUTING WINDOW'S BINDING — a NAMED consumer on the same terms as the queue above.
   *
   * `src/state/held-routing.ts` holds a Move press's rules for the undo window, and the window,
   * the record's shape and the projection overlay are the ENGINE's so the phone and the desktop
   * make one promise about one press. It touches no transport: `createRoutingWindow` takes the
   * plan and the dispatch as parameters and this file supplies neither — `state/live.ts`, which
   * is already in this set, does. The provider reaches the overlay through this file's own
   * `routingReader` rather than importing the package, so the path keeps ONE importer.
   */
  "src/state/held-routing.ts",
  /**
   * THE HELD WINDOWS' ONE JOURNAL DOOR (FIX-026 row 91) — lifted out of the routing binding above
   * so the delete window keeps its presses through the same door, on the same terms: it names the
   * engine's journal row type and the outbox horizon, touches no transport, and the pattern scan
   * above holds it to that. The delete window reaches both through this file, not the package.
   */
  "src/state/held-journal.ts",
  /**
   * THE SENDER SHEET'S WHY-STAYED ASK — pure functions over the engine's rule twins and the
   * consent index (which rows a finished pass left, and their lines), plus the batched move over a
   * dispatch `state/live.ts` supplies. No transport; the sheet's words take its type from here.
   */
  "src/state/sender-stayed.ts",
  /**
   * THE STANDALONE DOOR'S TWO FILES — named consumers of the PROVIDER TABLE, and nothing else.
   *
   * Both take pure functions over `packages/client-engine/src/providers.ts`: `serverGuessFor` and
   * `portMeansImplicitTls`. That table is data plus four pure functions — no transport, no origin,
   * no socket — and it lives in the engine package for a reason this census enforces from the other
   * side: the privacy guard forbids the brand names below anywhere under `apps/mobile`, so the labels
   * and hosts CANNOT be written here. Importing them is the compliant route, not a widening of it.
   *
   * Admitted HERE and deliberately NOT to {@link ENGINE_SEAM}: neither file may open a connection,
   * and the pattern scan above still holds both to that. `standalone-door.ts` hands an IMAP config
   * to the engine artifact — the artifact dials, this file does not, and it names no host of its
   * own beyond the one the person typed.
   */
  "src/engine/standalone-door.ts",
  "src/ui/standalone-form.ts",
  /**
   * WHO ORGANIZES A MAILBOX, SAID ONCE — `src/ui/not-organizing.ts` names two pure functions of the
   * shared organizing situation (`gateKept`, `nothingOrganizesWhy`, core's `reader-refusal`), the
   * derivation the web's Screener and Ohbox read. It reads rows it is handed and opens no connection;
   * admitted here on {@link "src/state/surface.ts"}'s terms, and the pattern scan above holds it to that.
   */
  "src/ui/not-organizing.ts",
  /**
   * THE UNKNOWN≠EMPTY READING — a re-export, and the narrowest member of this list.
   *
   * `listSurface` was born here and moved to the engine package, because the web enforced the same
   * rule by hand per view and its Ohbox missed one half of it. `src/state/surface.ts` is now four
   * export lines over `@ohmail/client-engine` and holds nothing else: the screens keep saying
   * `from "./surface"` and the rule has one home rather than two copies that can drift.
   *
   * Admitted HERE and deliberately NOT to {@link ENGINE_SEAM}: it may name pure functions, never
   * open a connection, and the pattern scan above still holds it to that.
   */
  "src/state/surface.ts",
  /**
   * `src/state/search-count.ts` names ONE pure function from the engine package, `substringOpen`
   * (the shared search-rank rule, re-exported there): the stores' inside-a-word rule, which the
   * service opens its arm with and the phone says the reach of. Admitted here, NOT to
   * {@link ENGINE_SEAM}, on {@link "src/state/surface.ts"}'s terms: it opens no connection.
   */
  "src/state/search-count.ts",
  /**
   * THE MAIL RENDERER'S RULE SET — three pure consumers of `mail-render-rules` (the allow-lists,
   * URI gates, pixel classification and CSS neutraliser the web reader also executes; the
   * webapp's `MessageBody.tsx` is the reference). Vocabulary, not transport: none of them may
   * `fetch`, open a socket or name an endpoint, and the pattern scan above still holds them to
   * that — the sanitizer builds a document whose every remote reference is REFUSED, the
   * navigation rule refuses everything but its own indexed link tokens, and the length reading
   * takes the mint's URI gate to leave out exactly the pictures the sanitizer leaves out.
   */
  "src/mail/sanitize.ts",
  "src/mail/frame-nav.ts",
  "src/mail/frame-length.ts",
  /**
   * THE FRAME'S TREE COUNT — a named consumer of `@ohmail/client-engine/html-tree-budget` alone, the
   * counter the web reader runs too. It parses a string it is handed and opens no connection; the
   * pattern scan above holds it to that.
   */
  "src/mail/frame-tree.ts",
  /**
   * THE COMPOSER'S ATTACH RULES — a named consumer of the ONE SHARED ATTACH BOUND, nothing else.
   *
   * It takes `composeAttachCap` (a pure function over two numbers — the same rule the webapp
   * form renders, the fix) and the `ComposeAttachment` type. No transport, no origin, no
   * socket; the pattern scan above still holds it to that. The pickers live in its `-native`
   * twin, which imports expo and not the engine.
   */
  "src/compose/attach.ts",
  /**
   * THE MAILTO ADAPTER — a named consumer of the one mailto parser (`parseMailto`, pure, the
   * desktop's own). It reads a string it is handed; the pattern scan above holds it to that.
   */
  "src/ui/mailto.ts",
  /**
   * THE THREAD-READ RULE'S DOOR — a named consumer of the shared rule (`createThreadRead`, its
   * `ThreadRead` record, the dwell, the top's line count and the fade constants), the rule the web
   * reader runs too, which it re-exports to the reader and its visit records. Pure arithmetic over
   * line boxes it is handed; no connection, and the pattern scan above holds it to that.
   */
  "src/ui/reader-seen.ts",
]);

describe("network: confined to the engine seam", () => {
  /**
   * Every pattern that could open a connection. `localhost` is not exempted:
   * a dev-server URL hard-coded in shipped source would still be a URL.
   */
  const PATTERNS: [string, RegExp][] = [
    ["fetch(", /\bfetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /\bWebSocket\b/],
    ["EventSource", /\bEventSource\b/],
    ["navigator.sendBeacon", /sendBeacon/],
    ["axios", /\baxios\b/],
    /*
     * THE ONE HOST THIS PATTERN DOES NOT COUNT, AND WHY IT IS NOT A HOLE.
     *
     * `example.com` and `example.org` are reserved by RFC 2606 precisely so that documentation can
     * name an address that can never resolve to anybody's server. The copy deck spells one — "for
     * example https://ohmail.example.com" — in the sentence that tells somebody what a server
     * address looks like, and that sentence has to carry the scheme because the refusal above it is
     * about a MISSING scheme.
     *
     * It reached this census by moving: the sentence used to sit in `net/server-base.ts`, which is
     * inside the engine seam, and it moved into `src/copy.en.ts` and `src/copy.de.ts` when the phone
     * gained a second language, because prose that a reader sees is translated. Exempting the whole
     * deck would have been the weakening; this exempts a domain that cannot be an endpoint, and
     * every other host — including `localhost` and every ohmail domain — still fails here.
     */
    ["http(s) URL", /https?:\/\/(?!(?:[a-z0-9-]+\.)*example\.(?:com|org)\b)[^\s"'`)]+/],
  ];

  it("the seam files all exist — a stale allow-list is itself a failure", () => {
    const paths = new Set(shipped.map((f) => f.path));
    for (const p of ENGINE_IMPORTERS) expect(paths, `allow-listed but missing: ${p}`).toContain(p);
  });

  it("has no networking call and no endpoint in any shipped source outside the seam", () => {
    const hits: string[] = [];
    for (const { path, body } of shipped) {
      if (ENGINE_SEAM.has(path)) continue;
      for (const [label, re] of PATTERNS) {
        for (const [i, line] of body.split("\n").entries()) {
          if (re.test(line)) hits.push(`${path}:${i + 1} [${label}] ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("imports the engine only through its allow-list; wake/update machinery not at all", () => {
    // The engine package is the allow-list's licence alone (the seam + the live-world
    // module). The other three are banned EVERYWHERE, the seam included: no self-update
    // channel, no reaching under RN's public networking surface, and — still, after that change — no
    // `expo-notifications`.
    //
    // That last one is worth stating precisely now that the wake is REAL and a connector is in the
    // graph, because the reason it stays banned is not "push has not been built yet" and never was.
    // `expo-notifications` is the FCM/APNs client: registering with it means a Google or Apple push
    // service holding a token for this device and standing between a person's mailbox and their
    // phone. The wake goes through a distributor the USER chose, carries a fifteen-byte constant
    // sealed to this device's own key, and needs none of that. So the ban is permanent by ruling —
    // and now that `expo-unified-push` delivers the whole feature without it, the ban is PROVEN to
    // cost nothing rather than merely asserted to.
    //
    // `expo-unified-push` itself is allowed in exactly one file (see NATIVE_PUSH_SEAM). The same
    // argument applies to it as to the engine: one importer, named, so a second is a reviewed diff.
    const seamOnly = ["@ohmail/client-engine"];
    const bannedEverywhere = ["expo-updates", "expo-notifications", "react-native/Libraries/Network"];
    const hits: string[] = [];
    for (const { path, body } of shipped) {
      for (const mod of seamOnly) {
        if (new RegExp(`from ["']${mod}`).test(body) && !ENGINE_IMPORTERS.has(path)) hits.push(`${path}: ${mod}`);
      }
      for (const mod of bannedEverywhere) {
        if (new RegExp(`from ["']${mod}`).test(body)) hits.push(`${path}: ${mod}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("`expo-unified-push` is reachable from exactly ONE file, and that file is named", () => {
    /**
     * The native module is the only new capability this app gained, so its blast radius is pinned.
     * A `require` counts as much as an `import`: the adapter loads it lazily (the module does not
     * exist on iOS), and a lazy require elsewhere would evade an import-only scan.
     */
    const importers = shipped
      .filter((f) => /(?:from\s+["']|require\(\s*["']|import\(\s*["'])expo-unified-push/.test(f.body))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual([...NATIVE_PUSH_SEAM].sort());
  });

  it("the native-push seam file exists and still holds NO endpoint of its own", () => {
    // Its admission is to the MODULE ban, not to the network. It receives an endpoint from the
    // device and never dials one, so every network pattern above still applies to it — asserted
    // here explicitly because the scan above skips only ENGINE_SEAM, and it would be easy to
    // assume this file was skipped too.
    const paths = new Set(shipped.map((f) => f.path));
    for (const p of NATIVE_PUSH_SEAM) {
      expect(paths, `allow-listed but missing: ${p}`).toContain(p);
      expect(ENGINE_SEAM.has(p), `${p} must NOT be in the network seam`).toBe(false);
    }
  });

  it("the screens never touch the seam directly — the connection layer is the one door", () => {
    // The structural half of the confinement: no screen or state module imports the engine
    // composition; everything reaches the network through the connection provider. (Screens
    // ROUTE to /connect by name; routing is a string, not an import, and this scan would
    // catch the import form.)
    const hits: string[] = [];
    for (const { path, body } of shipped) {
      if (ENGINE_SEAM.has(path)) continue;
      if (/from ["'][^"']*\/engine\/(boot|native)["']/.test(body)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });
});

describe("no demo data ships (owner ruling 2026-08-20)", () => {
  it("no shipped source imports @ohmail/fixtures — the demo corpus stays out of the app", () => {
    // The ruling's structural half: demo data is the website's alone. Type-only imports are
    // banned with the rest — a type pulled from the corpus package is one refactor away from
    // a value, and the app's own row types live in src/state/model.ts. (package.json is
    // covered by the dependency test below; this one scans for the import/require forms.)
    const hits: string[] = [];
    for (const { path, body } of shipped) {
      if (/(?:from\s+["']|require\(\s*["']|import\(\s*["'])@ohmail\/fixtures/.test(body)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });

  it("the app's package.json does not depend on the fixtures at runtime", () => {
    const pkg = JSON.parse(sources.find((f) => f.path === "package.json")!.body) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@ohmail/fixtures");
  });

  it("the state layer holds no sample mail — no inline corpus replaced the import", () => {
    // The lazy regression: someone deletes the import and pastes the fixture mail inline.
    // Sample mail needs sender addresses; the state layer (types + selectors over the
    // engine) legitimately contains no email-address literal at all.
    const stateFiles = shipped.filter((f) => f.path.startsWith("src/state/"));
    expect(stateFiles.length).toBeGreaterThan(3);
    const hits: string[] = [];
    for (const { path, body } of stateFiles) {
      for (const [i, line] of body.split("\n").entries()) {
        if (/["'][A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}["']/.test(line)) {
          hits.push(`${path}:${i + 1} ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
