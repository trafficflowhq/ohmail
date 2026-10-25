import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localRoutes, matchRoute } from "@trafficflow/api/local";
import { matchReadRoute } from "../src/cloud-read.js";
import { SUGGEST_ROUTES } from "../../desktop/src/cloud-suggest.js";

/**
 * EVERY ROUTE THE DESKTOP CLIENT CALLS, AGAINST THE TWO SURFACES THE SIDECAR SERVES.
 *
 * The desktop app runs the SAME client engine the hosted web app runs, over a pipe to this process
 * instead of over a socket. That is the whole design, and it has one failure mode: a route the
 * client asks for that this process has no handler for. It does not fail loudly — the local engine
 * answers 404, the client treats it as a refused request, and the feature behind it is simply
 * absent on the desktop while every test in both repositories stays green.
 *
 * So the client's call list is DERIVED FROM ITS SOURCE rather than written down here. Adding a
 * request to the adapter without a handler on this side fails this file instead of shipping.
 *
 * ── THE TWO SURFACES ARE NOT THE SAME, AND THE DIFFERENCE IS THE POINT ──────────────────────
 *
 *  · LOCAL mode mounts `localRoutes` — the full mail table — so the answer is a straight match.
 *  · CLOUD mode mirrors a hosted account and is READ-ONLY locally: `GET /sync` and the curated
 *    read table in `cloud-read.ts` are served from the mirror, and everything else is forwarded to
 *    the hosted account by the write-through proxy. Forwarding is correct for a write and for the
 *    byte reads the mirror never holds. It is NOT automatically correct for a read whose ANSWER is
 *    expressed in the hosted account's own sequence numbering — see the last test.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(HERE, "../../../packages/client-engine/src/adapters/http-adapter.ts");

interface Call {
  method: string;
  /** The route pattern, with every interpolation reduced to one parameter segment. */
  pattern: string;
}

/**
 * Every `this.request(...)` in the wire client, as a method and a route pattern.
 *
 * The path argument comes in three shapes — a plain string, a template, and a ternary between two
 * of those — so the parse takes EVERY path-shaped literal in the argument region rather than
 * assuming the first token is the whole answer. A template's `${…}` spans are exactly the
 * parameters, so replacing each with a placeholder segment turns the call site into the pattern a
 * router would match it against; the query string is cut, because routing does not see one.
 *
 * The count is checked against the number of call sites by the caller. A parse that quietly
 * skipped a shape it did not recognise is the failure this whole file would be blind to: the one
 * route this test most needs to see is written as a ternary, and a first version of the regex
 * missed exactly that one and reported full coverage.
 */
function clientCalls(): { calls: Call[]; sites: number } {
  const src = fs.readFileSync(ADAPTER, "utf8");
  const marker = "this.request(";
  const calls: Call[] = [];
  let sites = 0;
  for (let at = src.indexOf(marker); at >= 0; at = src.indexOf(marker, at + 1)) {
    sites++;
    const rest = src.slice(at + marker.length);
    /* The argument region ends at the options object or at the call's own close, whichever comes
       first. No interpolation in this file contains either sequence. */
    const ends = [rest.indexOf(");"), rest.indexOf(", {")].filter((i) => i >= 0);
    const region = rest.slice(0, Math.min(...ends));
    const method = /"(GET|POST|PUT|PATCH|DELETE)"/.exec(region)?.[1];
    if (!method) continue;
    for (const m of region.matchAll(/`(\/[^`]*)`|"(\/[^"]*)"/g)) {
      const raw = m[1] ?? m[2]!;
      calls.push({ method, pattern: raw.replace(/\$\{[^}]*\}/g, "x").split("?")[0]! });
    }
  }
  // Dedup: several mutations address the same route, and a ternary names one twice.
  const seen = new Set<string>();
  return {
    sites,
    calls: calls.filter((c) => {
      const key = `${c.method} ${c.pattern}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/**
 * The routes the client reaches that are NOT in `cloud-read.ts` and are not `GET /sync`.
 *
 * Written down deliberately, because every one of them is a decision rather than an oversight: a
 * mutation belongs to the hosted account and MUST be forwarded, and the attachment byte routes
 * read data the mirror does not hold. The list is asserted exactly so that a READ joining it —
 * which is the case worth looking at twice — cannot arrive unnoticed.
 */
const FORWARDED_IN_CLOUD_MODE = [
  /* THE READ THAT JOINED THE LIST ON PURPOSE — the case this census exists to make somebody look
     at twice. `GET /messages` is the reach-past door (`HttpAdapter.listMessages`): a keyset page
     of mail BEYOND what the local store kept, which is a question the local mirror cannot answer
     truthfully — served locally it re-serves its own window and then claims the mail ends there,
     and for `view=folder` the old local handler dropped `folderId` and refused outright (the
     desktop's "older mail could not be loaded" over every folder). The hosted account holds the
     mail; the ask forwards with its whole address. `cloud-local-surface.test.ts` pins the
     round trip. */
  "GET /messages",
  /* HISTORY'S PAGES BY DATE, over the whole hosted mailbox — a reach-past read like the one above.
     It sat off this list because `/messages/:id` claimed it with id "timeline"; the matcher now
     lets the relay's more specific row win (`cloud-read-relay-census.test.ts`). */
  "GET /messages/timeline",
  "POST /messages/x/unsubscribe",
  /* The Delete verb — a MUTATION (a move to the provider's Trash, never an expunge), so it
     forwards for the same reason every other write here does. It reached the wire client before
     this list learned about it, which left this census red; the entry records the decision the
     adapter had already made. */
  "DELETE /messages/x",
  "GET /messages/x/attachments",
  "GET /attachments/x",
  "POST /messages/x/attachments/download-all",
  "POST /messages/x/move",
  /* RESTORE — a move like the one above it, and it forwards for the same reason: the row belongs
     to the hosted account and the reconciler that performs the IMAP move runs there. It cannot be
     served locally even in principle, because the mirror holds no trashed row to act on. */
  "POST /messages/x/restore",
  "POST /messages/x/triage",
  "POST /screener/x",
  /* THE HELD-RELEASE PAIR. The count is read from the mirror and the press re-opens a rule's
     backlog, which the reconciler walks on the hosted side — so both forward, for the reason
     every other screener route does. */
  "GET /screener/held-releases",
  "POST /screener/held-releases",
  /* Why a sender's rows stayed: who placed a row and whether it was answered are hosted facts. */
  "GET /screener/stayed",
  /* The dismissal persists per account on the hosted side, where every device reads it back. */
  "POST /screener/held-releases/dismiss",
  /* the PAIR, on the held-release pair's reading: the set is what the ARRIVAL GATE would answer
     over the hosted account's rules and contacts, and the reconciler that carries the press to
     IMAP runs there — so both forward, like every other screener route. */
  "GET /screener/unscreened",
  "POST /screener/unscreened",
  /* THE SCREENER'S QUEUE, a read that joined the list on purpose: the waiting set and its count
     are the hosted account's own queue, which the local mirror cannot answer — it is windowed,
     and a count served from it is the window's. The route is `relay: true`. */
  "GET /screener",
  "PATCH /messages/x",
  "PATCH /messages",
  "POST /messages/x/tags",
  "POST /tags",
  "PATCH /tags/x",
  "DELETE /tags/x",
  "DELETE /rules/x",
  "PATCH /rules/x",
  "POST /rules",
  "POST /drafts",
  /* AUTOSAVE'S TWO. `PUT /drafts/:id` is the compose form writing itself to the account every
     couple of seconds, and `DELETE /drafts/:id` is Discard. Both are MUTATIONS on the hosted
     account, so they forward for the same reason every other write here does — a draft belongs
     to the account, not to whichever device happened to be typing.

     They are the one pair on this list where the frequency is worth noting: a person writing a
     long message produces a PUT per pause. That is still a forward and not a mirror read — the
     row is the server's — and it is bounded by the debounce rather than by the keystrokes. */
  "PUT /drafts/x",
  "DELETE /drafts/x",
  /* THE SECOND READ ON THIS LIST, and it is here rather than in `cloud-read.ts` because the
     hosted row is the master for a draft's text: the mirror's copy is whatever the last page
     carried, which is exactly the thing this read exists to go around. Its answer names no
     sequence number, so forwarding it cannot import the hosted account's numbering — the
     hazard the entry above `GET /messages` records. Asked once, when a draft is opened whose
     mirror row arrived without a body. */
  "GET /drafts/x",
  "POST /drafts/x/send",
  /* THE SEND'S READ HALF — what happened under this idempotency key, asked before a staged
     retry re-uploads anything. It forwards for the plainest reason on this list: the reservation
     it reads is a row on the HOSTED account, and a local mirror holds none of them. */
  "GET /drafts/x/send-attempt",
  /* A FORWARD'S CAPABILITY QUESTION, a read that joined on purpose: before a forward that names its
     kept files the client asks `GET /hello` whether the server that SENDS honours `forwardParts`
     (`HttpAdapter.forwardPartsAnnounced`). On this door the hosted deployment sends, so a local
     answer would speak for a server that does not. Its answer names no sequence number. */
  "GET /hello",
  /* THE HELD SEND'S ONE EXIT — the reader answering for a send the account could not confirm.
     A MUTATION on the hosted rows: `arrived` records the delivery and takes the draft out of
     Drafts, `not_arrived` returns it to an ordinary draft. `unverified` is a state of the HOSTED
     row and the compare-and-swap that leaves it is the hosted deployment's, so an answer served
     from the mirror would clear a held state the account still holds — and the next pull would
     put it back, in front of a reader who has just answered. The STANDALONE door serves it from
     its own table (`draftsRoutes` rides `localRoutes` whole), so both doors accept the answer. */
  "POST /drafts/x/resolve",
  /* CANCEL'S ANSWER — `POST /sends/withdraw`. It forwards for the send's own reason: the reservation
     it tombstones or reads is a row on the HOSTED account, and a local mirror holds none of them. */
  "POST /sends/withdraw",
  /* SEND LATER's two verbs (mail 0077) — MUTATIONS on the hosted account, forwarded for the
     send's own reason: the appointment lives on the hosted draft row and the hosted deployment's
     scheduled-send pass is the clock that keeps it. Served locally they would mark a mirror row
     no hosted clock will ever claim — a "Scheduled" the account does not have. The STANDALONE
     door mounts the same routes on its own table (`draftsRoutes` rides `localRoutes` whole) and
     its own drain runs the pass, so both doors keep the promise they make. */
  "POST /drafts/x/schedule",
  "DELETE /drafts/x/schedule",
  /* THE FOLDER VERBS (FOLDERS-SPEC.md §18) — four MUTATIONS on the hosted account: each records
     a `folder_ops` command the HOSTED worker executes inside the mailbox's serial cycle. The
     mirror holds no command table and rings no doorbell, so answering any of them locally would
     acknowledge an operation nobody will ever perform. The desktop's hosted door ships the same
     rail these verbs are offered from; the STANDALONE door does not — see
     {@link STANDALONE_DOOR_NEVER_ASKS} for why that is a decision and how it is licensed. */
  "POST /folders",
  "PATCH /folders/x",
  "DELETE /folders/x",
  "DELETE /folders/x/op",
  /* THE PULL DOORBELL (`EngineAdapter.requestPull`) — mutation-shaped on purpose: it writes
     `sync_requested_at` on the ACCOUNT row so the account's own organizer pulls now. In cloud
     mode that organizer is the hosted worker — the mirror cannot open IMAP, so a locally-served
     ring would report a pull nobody is going to make. In LOCAL mode `syncRoutes` serves it and
     the engine's own drain answers the bell. */
  "POST /sync/pull",
  /* THE HOSTED DOOR'S UPLOAD TICKET — relayed, and its answer rewritten so the signed grant stays
     in this process (`cloud-staged-upload.ts`); see {@link STAGING_HOSTED_DOOR_ONLY}. */
  "POST /attachments/staging",
];

/**
 * ROUTES THE WIRE CLIENT COMPOSES ON THIS APP'S HOSTED DOOR ONLY, and never on the standalone one.
 *
 * `POST /attachments/staging` mints an upload ticket so a send too large for one request body can
 * put its bytes in the account's storage instead — a property of a HOSTED transport. The hosted
 * door asks for it (relayed, its grant kept by `cloud-staged-upload.ts`), so it is a forwarded
 * route in the cloud census below. The standalone door never asks: its compose form, send handler
 * and SMTP dial are one process with no request body between them, and the engine's own route
 * table deliberately mounts no staging route (`packages/api/test/attachment-staging.test.ts`
 * asserts that over `routes/local.ts`). So it is exempt from the LOCAL census alone, and only while
 * {@link stagingIsHostedOnly} re-reads the facts that make that true.
 */
const STAGING_HOSTED_DOOR_ONLY = ["POST /attachments/staging"] as const;

/**
 * ROUTES THE CLIENT COMPOSES ON THE HOSTED DOOR ONLY — forwarded there, and deliberately NOT
 * mounted on the standalone engine's table.
 *
 * ── HOW THIS RELATES TO {@link STAGING_HOSTED_DOOR_ONLY} ───────────────────────────────────
 *
 * The same shape, licensed by different facts. These four are asked — the desktop's hosted door ships the folders rail, so they stay REQUIRED
 * entries in {@link FORWARDED_IN_CLOUD_MODE} — but only exempt from the LOCAL-serving census,
 * because the STANDALONE door structurally never composes one — FOLDERS-SPEC.md §17 puts it as no
 * folders pane there, so no verb is offered where nothing would run it. Paraphrased rather than
 * quoted: the spec's own sentence uses a word the prose gate reads in its other sense, and
 * rewording INSIDE quotation marks attributed to a named document would have left a reader
 * checking §17 for a sentence that is not in it.
 *
 * ── WHY NOT MOUNT THEM LOCALLY ──────────────────────────────────────────────────────────────
 *
 * Each verb records a `folder_ops` COMMAND and rings the account's doorbell for a worker to
 * execute inside the mailbox's serial cycle. The standalone engine cannot STORE the folders flag —
 * not "has no consent row", which is what this line said and which stopped being true when
 * `consentRoutes` were mounted on `localRoutes`: the row is there and this door reads and writes
 * its own screening window through it. The missing thing is the one FIELD, stripped by
 * `withoutFoldersFlag` precisely because no folder verb is mounted here, which is what keeps this
 * exemption honest rather than circular. So its `/sync` withholds every folder entity, its rail
 * spreads no folders group, and a mounted verb would be a handler for a request no surface in this
 * build can emit —
 * dead on this door for the same reason a staging refusal would be. A standalone build that later
 * grows the pane inherits the filtered `folders.ts` (§17 says so in as many words) and mounts the
 * verbs THEN, on purpose, by changing this list.
 *
 * ── THE LICENSE IS DERIVED, NOT DECLARED ────────────────────────────────────────────────────
 *
 * {@link standaloneDoorNeverAsks} re-measures the structural chain that makes "the client does
 * not ask" true on the standalone door, and hands back NOTHING when any link stops holding — at
 * which point the LOCAL census goes red on all four, exactly as it did the day they were added.
 */
const STANDALONE_DOOR_NEVER_ASKS = [
  "POST /folders",
  "PATCH /folders/x",
  "DELETE /folders/x",
  "DELETE /folders/x/op",
] as const;

const ADAPTER_SRC = fs.readFileSync(ADAPTER, "utf8");
const BRIDGE = path.resolve(HERE, "../../desktop/src/bridge-fetch.ts");
const SEND_SURFACE = path.resolve(HERE, "../../desktop/src/desktop-send-surface.ts");
const GATE = path.resolve(HERE, "../../desktop/src/DesktopGate.tsx");
const APP_SHELL = path.resolve(HERE, "../../webapp/app/shell/AppShell.tsx");
/* THE RAIL MOVED OUT OF THE SHELL (ARCH-022). `FoldersRailGroup` and the `consent.foldersEnabled`
   spread that gates it went to `shell-keys.tsx` with the rest of the rail; this link is about the
   MOUNT, not about which file holds it, so the reading is the pair of files and the refusal names
   the one that carried it. A file that is absent refuses — an unreadable half is not a zero. */
const RAIL_MOUNTS = ["../../webapp/app/shell/shell-keys.tsx", "../../webapp/app/shell/AppShell.tsx"]
  .map((rel) => path.resolve(HERE, rel));
const CONSENT_STATE = path.resolve(HERE, "../../webapp/app/shell/consent-state.ts");
const FOLDER_VERBS = path.resolve(HERE, "../../webapp/app/shell/folder-verbs.ts");
/** The standalone route table's own source — link four is about how it is COMPOSED. */
const LOCAL_TABLE_SRC = path.resolve(HERE, "../../../packages/api/src/routes/local.ts");

/**
 * THE CHAIN THAT KEEPS {@link STANDALONE_DOOR_NEVER_ASKS} TRUE, re-measured from source.
 *
 * Returns the exempt set only while every link holds, and the empty set otherwise.
 *
 *  1. **The verbs have ONE composing module.** Every `kind: "folder_…"` mutation in the client
 *     surfaces this window renders (`apps/webapp/app`, `apps/desktop/src`) is composed in
 *     `folder-verbs.ts` — a second composer would be a path this chain says nothing about.
 *  2. **Their one mount is gated on the flag.** `AppShell` renders `<FoldersRailGroup>` exactly
 *     once, inside the rail group spread on `consent.foldersEnabled` — a flag-off rail is
 *     byte-identical to the pre-feature rail, folders verbs included.
 *  3. **The flag RESTS false.** `consent-state.ts`'s resting block says `foldersEnabled: false`,
 *     so a door that never answers the consent read never leaves it.
 *  4. **The standalone engine cannot answer that read.** `GET /consent` does not match
 *     `localRoutes` — the same instrument the censuses below use, pointed at the route whose
 *     answer is the only thing that can raise the flag. (The desktop wires the consent transport
 *     on the hosted door alone — `accountDoorFor` in `doors.ts`; this is the route-table half of
 *     that same decision, measured where this file can reach it.)
 *
 *  5. **A departed wire cannot leave the flag behind.** The desktop's door chooser is an
 *     overlay OVER the mounted shell (review round 2's counterexample to round 1's unmount
 *     ruling: `DesktopGate` renders `DoorChooser` beside `AppShell`, and `engine_configure`
 *     runs before `onEntered`), so a hosted session with folders ON can switch doors without
 *     the shell ever unmounting. The consent hook therefore RESETS to its resting values the
 *     moment the transport is gone — measured here as the reset line in the hook's own source,
 *     pinned behaviorally by `consent-wire-loss.test.tsx`.
 */
function standaloneDoorNeverAsks(): { exempt: Set<string>; holds: Record<string, boolean> } {
  const composers = new Set<string>();
  for (const root of [
    path.resolve(HERE, "../../webapp/app"),
    path.resolve(HERE, "../../desktop/src"),
  ]) {
    for (const file of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.(ts|tsx)$/.test(file.name) || /\.test\./.test(file.name)) continue;
      const p = path.join(file.parentPath, file.name);
      if (fs.readFileSync(p, "utf8").includes('kind: "folder_')) composers.add(p);
    }
  }
  const shell = fs.readFileSync(APP_SHELL, "utf8");
  const railMounts = RAIL_MOUNTS.map((p) => fs.readFileSync(p, "utf8"));
  const railMount = railMounts.filter((src) => src.includes("<FoldersRailGroup"));
  const holds = {
    "folder-verbs.ts is the ONLY module composing folder_* mutations":
      composers.size === 1 && composers.has(FOLDER_VERBS),
    "the shell mounts FoldersRailGroup exactly once, in one file, inside the consent.foldersEnabled spread":
      railMount.length === 1 &&
      railMount[0]!.split("<FoldersRailGroup").length === 2 &&
      railMount[0]!.indexOf("...(consent.foldersEnabled") >= 0 &&
      railMount[0]!.indexOf("...(consent.foldersEnabled") < railMount[0]!.indexOf("<FoldersRailGroup"),
    "the flag's resting value is false":
      /foldersEnabled: false,/.test(fs.readFileSync(CONSENT_STATE, "utf8")),
    /* LINK FOUR, RESTATED — and the restatement is the fix rather than a relaxation.
     *
     * It read "the local table serves no consent read to raise it", measured as `GET /consent`
     * not matching. Mail 0083 mounted `consentRoutes` on that table ON PURPOSE, to give the
     * standalone install a screening window, and broke this link on the way past — at which point
     * the flag really could be raised there (`apps/desktop/src/local-consent.ts` composes
     * `PATCH /consent/settings { foldersEnabled }`) over a table that serves NO folder route at
     * all. The four verbs would have answered 404.
     *
     * The link that is true now is narrower and stronger: the consent group reaching that table
     * goes through `withoutFoldersFlag`, which strips the field from the PATCH and REMOVES
     * `foldersEnabledAt` from the GET (absent, not null: a paired client reading `null` cannot
     * tell "off" from "off and storable", and drew a switch that wrote nothing and snapped
     * back). So the read is SERVED — the window needs it — and the
     * flag still cannot leave its resting `false` on this door, which is all the exemption ever
     * needed. Measured over `local.ts`'s own source, because what is being asserted is which
     * routes that table is composed FROM. */
    "the local table serves the consent read with the folders flag stripped":
      matchRoute(localRoutes, "GET", "/consent").matched
      && /\.\.\.withoutFoldersFlag\(consentRoutes\)/.test(
        fs.readFileSync(LOCAL_TABLE_SRC, "utf8"),
      ),
    "the hook resets to RESTING when the wire is gone (the overlay door switch)":
      // Line-anchored on purpose: a commented-out reset must NOT satisfy this (watched — the
      // first spelling matched its own mutant). The bounded distance keeps the match inside
      // the `!reachable` branch rather than anywhere later in the file.
      /if \(active && !reachable\) \{[\s\S]{0,2000}?\n\s*setState\(RESTING\);/.test(
        fs.readFileSync(CONSENT_STATE, "utf8"),
      ),
  };
  const all = Object.values(holds).every(Boolean);
  return { exempt: new Set(all ? STANDALONE_DOOR_NEVER_ASKS : []), holds };
}

/**
 * THE FACTS THAT MAKE {@link STAGING_HOSTED_DOOR_ONLY} TRUE, re-measured from source. Returns the
 * exempt set only when all hold, and the empty set otherwise, so a change to any one fails the
 * LOCAL census rather than quietly widening its blind spot.
 *
 *  1. **The call is GATED** on the option, and 2. **the option is OPT-IN** (`=== true`).
 *  3. **This app asks only when told**: `bridge-fetch.ts` adds the option only through `stage`.
 *  4. **Only the hosted door tells it**: `desktop-send-surface.ts`'s `stagesAttachments` is the
 *     managed flavor alone, and `DesktopGate.tsx` builds the engine with that decision.
 */
function stagingIsHostedOnly(): { exempt: Set<string>; holds: Record<string, boolean> } {
  const bridge = fs.readFileSync(BRIDGE, "utf8");
  const surface = fs.readFileSync(SEND_SURFACE, "utf8");
  const gate = fs.readFileSync(GATE, "utf8");
  const holds = {
    "the staging call is gated on the option":
      /if\s*\(!this\.stageAttachments\s*\|\|/.test(ADAPTER_SRC),
    "the option is opt-in (`=== true`)":
      /this\.stageAttachments\s*=\s*opts\.stageAttachments\s*===\s*true/.test(ADAPTER_SRC),
    "this app adds the option only when its caller asks":
      bridge.includes("...(stage ? { stageAttachments: true } : {})")
      && (bridge.match(/stageAttachments: true/g) ?? []).length === 1,
    "only the hosted door asks":
      /export function stagesAttachments\([^)]*\): boolean \{\s*return flavorOf\(status\) === "managed";\s*\}/.test(surface)
      && /createLocalEngine\(mount\.key, \{ stageAttachments: stage \}\)/.test(gate),
  };
  const all = Object.values(holds).every(Boolean);
  return { exempt: new Set(all ? STAGING_HOSTED_DOOR_ONLY : []), holds };
}

describe("the client's route list against the local engine", () => {
  const { calls: allCalls, sites } = clientCalls();
  const { exempt: stagingOnly } = stagingIsHostedOnly();
  const calls = allCalls;
  const named = allCalls.map((c) => `${c.method} ${c.pattern}`);

  it("reads every call site in the wire client", () => {
    // The harness bites only if it read something, and only if it read ALL of it. A call site the
    // parse cannot see is a route this file silently stops covering.
    expect(sites).toBeGreaterThanOrEqual(20);
    const parsed = new Set(calls.map((c) => c.method));
    expect(parsed.size).toBeGreaterThan(1);
    expect(named).toContain("GET /sync");
    expect(named).toContain("GET /sync/snapshot");
  });

  it("the staging exemption is EARNED — all four structural facts still hold", () => {
    // One by one, so a failure names WHICH fact stopped being true. Negating any single one
    // empties the exempt set and turns the LOCAL census below red on `POST /attachments/staging`.
    const { holds, exempt } = stagingIsHostedOnly();
    for (const [fact, ok] of Object.entries(holds)) {
      expect(ok, `no longer true: ${fact} — the exemption below is not licensed`).toBe(true);
    }
    expect([...exempt]).toEqual([...STAGING_HOSTED_DOOR_ONLY]);
  });

  it("the exempted route IS one the client can compose — this file is not skipping a ghost", () => {
    // The other direction, and the one that stops the list outliving its subject. If the staging
    // call were deleted from the wire client, the name below would be an exemption for nothing —
    // decorative, and the first thing to mislead somebody reading this list.
    for (const name of STAGING_HOSTED_DOOR_ONLY) {
      expect(named, `${name} is exempted but the wire client never composes it`).toContain(name);
      expect(FORWARDED_IN_CLOUD_MODE, `${name} must stay a forwarded route`).toContain(name);
    }
  });

  it("is NOT served by the local engine, and that is the intended answer", () => {
    // Stated as a positive assertion rather than left as a hole in the census above. The desktop
    // engine's route table deliberately has no staging route — see `STAGING_HOSTED_DOOR_ONLY` —
    // and a future mounting of it is a decision that has to change this line on purpose.
    for (const name of STAGING_HOSTED_DOOR_ONLY) {
      const [method, pattern] = name.split(" ") as [string, string];
      expect(matchRoute(localRoutes, method, pattern).matched).toBe(false);
    }
  });

  it("serves every one of them in LOCAL mode", () => {
    // Minus the hosted-door-only verbs, whose absence from the local table is the decision
    // `STANDALONE_DOOR_NEVER_ASKS` documents — and only while its measured chain still licenses it.
    const { exempt: hostedOnly } = standaloneDoorNeverAsks();
    const missing = calls
      .filter((c) => !hostedOnly.has(`${c.method} ${c.pattern}`))
      .filter((c) => !stagingOnly.has(`${c.method} ${c.pattern}`))
      .filter((c) => !matchRoute(localRoutes, c.method, c.pattern).matched);
    expect(missing.map((c) => `${c.method} ${c.pattern}`)).toEqual([]);
  });

  it("the standalone exemption is EARNED — every link of the measured chain still holds", () => {
    // Named one by one, like the staging exemption's facts: a failure says WHICH link broke.
    // Each was watched: breaking any single one empties the exempt set and turns the LOCAL
    // census red on all four folder verbs.
    const { holds, exempt } = standaloneDoorNeverAsks();
    for (const [fact, ok] of Object.entries(holds)) {
      expect(ok, `no longer true: ${fact} — the standalone exemption is not licensed`).toBe(true);
    }
    expect([...exempt].sort()).toEqual([...STANDALONE_DOOR_NEVER_ASKS].sort());
  });

  it("the standalone-exempt verbs ARE composed by the client and DO forward on the hosted door", () => {
    // Two positive assertions so the list cannot outlive its subject: each verb is one the wire
    // client really composes (not a ghost), and each stays a REQUIRED forward in the cloud
    // census — this exemption narrows the LOCAL census only, never the hosted one.
    for (const name of STANDALONE_DOOR_NEVER_ASKS) {
      expect(named, `${name} is exempted but the wire client never composes it`).toContain(name);
      expect(FORWARDED_IN_CLOUD_MODE, `${name} must stay a forwarded route`).toContain(name);
      const [method, pattern] = name.split(" ") as [string, string];
      expect(matchRoute(localRoutes, method, pattern).matched).toBe(false);
    }
  });

  it("serves the reads it can from the mirror in CLOUD mode, and forwards exactly the rest", () => {
    const forwarded = calls
      .filter((c) => !(c.method === "GET" && c.pattern === "/sync"))
      .filter((c) => matchReadRoute(c.method, c.pattern) === null)
      .map((c) => `${c.method} ${c.pattern}`);
    expect(forwarded.sort()).toEqual([...FORWARDED_IN_CLOUD_MODE].sort());
  });

  /**
   * THE COLD-START READ IS SERVED LOCALLY IN BOTH MODES, AND MUST STAY THAT WAY.
   *
   * `GET /sync/snapshot` answers with `asOfSeq` — the point the snapshot was read at — and the
   * client writes that value as its `/sync` cursor. Forwarded, it comes back counted in the HOSTED
   * change sequence, while the very next `/sync` is answered by this process out of the LOCAL
   * change log, which is a different sequence entirely (`cloud-mirror.ts` says so in as many
   * words). A cursor from the wrong sequence does not error — it selects nothing, for ever, so the
   * mailbox bootstraps once, looks complete, and never receives another change.
   *
   * This test used to pin the opposite: the route WAS forwarded, and the desktop client
   * compensated by building its engine without a `snapshot` method at all, which is why a cold
   * start filled oldest-first out of the change log. Both halves are now the other way round, and
   * they have to move together — so this asserts the local handler exists in both tables, and
   * `apps/desktop/test/desktop-engine.test.ts` asserts the client actually takes it.
   */
  it("serves the cold-start read from the local mirror in BOTH modes", () => {
    expect(matchReadRoute("GET", "/sync/snapshot")).not.toBeNull();
    expect(matchRoute(localRoutes, "GET", "/sync/snapshot").matched).toBe(true);
  });
});

/**
 * THE ROUTES THE DESKTOP CALLS DIRECTLY, WHICH THE PARSE ABOVE STRUCTURALLY CANNOT SEE.
 *
 * The census above derives its list from the sync client, because that is how the app fetches mail.
 * Buying AI suggestions does not go through it: a suggestion is advice about mail rather than a
 * change to it, so nothing puts one in the change feed and the surface asks for them itself, over
 * the same pipe. Those calls are therefore invisible to the parse — and a route the window asks for
 * that this process has no plan for fails silently, which is the exact failure the file exists to
 * prevent.
 *
 * ── AND "FORWARDED" IS A REQUIREMENT HERE, NOT AN OBSERVATION ───────────────────────────────
 *
 * On the hosted door this process holds a READ-ONLY mirror and no ledger. Both routes below touch
 * one: the page carries the price of what is still suggestable, and the purchase moves credits and
 * reports what is left. Answering either from the mirror would quote and charge against a copy that
 * cannot know the balance — a control naming one figure while the account is debited another, which
 * is precisely what the dry run in the middle of that flow exists to make impossible. So both must
 * reach the account itself, and the way they do that is by NOT being in the local read table.
 *
 * On the standalone door the opposite is required and for the opposite reason: there is no account,
 * the model is the installer's own, and the engine answers both out of its own route table.
 */
describe("the desktop's suggest routes, on both doors", () => {
  const named = SUGGEST_ROUTES.map((r) => `${r.method} ${r.pattern}`);

  it("names the routes it actually composes its calls from", () => {
    // The list is only worth asserting over if it is the list the transport uses. Both entries are
    // read to build a request in `cloud-suggest.ts`; this pins what they are.
    expect(named).toEqual(["GET /screener", "POST /screener/suggest"]);
  });

  it("forwards both to the hosted account in CLOUD mode", () => {
    const servedLocally = SUGGEST_ROUTES.filter(
      (r) => matchReadRoute(r.method, r.pattern) !== null,
    ).map((r) => `${r.method} ${r.pattern}`);
    expect(servedLocally).toEqual([]);
  });

  it("serves both from the engine's own table in LOCAL mode", () => {
    const missing = SUGGEST_ROUTES.filter(
      (r) => !matchRoute(localRoutes, r.method, r.pattern).matched,
    ).map((r) => `${r.method} ${r.pattern}`);
    expect(missing).toEqual([]);
  });
});
