import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSidecarLog } from "../src/log.js";
/* THE MASKER MOVED to `_mask.ts` so a SECOND census could reuse it without importing this file —
   importing a test module runs its suites, and one shared helper is the point of having one. */
import { maskSource } from "./_mask.js";

/**
 * THE CENSUS GUARD — every field name this package hands a logger is on `ALLOWED_FIELDS`.
 *
 * ── SCOPE: `apps/sidecar/src` ONLY, AND THAT IS DELIBERATE ────────────────────────────────
 *
 * The right long-term shape of this guard is repo-wide: a scanner over `packages/**` and
 * `apps/**` that fails when any call site passes a name absent from
 * `packages/core/src/log.ts`'s census. The slice that hardened the logger considered exactly
 * that and did not ship it, because several packages were being edited concurrently and a
 * repo-wide scan would have gone red on work that was still in flight. That condition still holds
 * — `apps/worker` and `apps/webapp` are both being written in while this file is.
 *
 * A gate that goes red because of somebody else's unfinished edit teaches everybody to ignore it,
 * which costs more than the coverage it buys. So the scope is one package: the package where the
 * defect was, where nobody else is writing, and where the whole failure mode originated — the
 * sidecar had NO logger to grep for, because it hand-rolled `JSON.stringify` under a comment
 * claiming the worker's shape. **Widening this to the repository is owed work, not a
 * finished decision**; the extractor below is written to be lifted as-is, and the only thing
 * standing between it and `packages/**` is the concurrency, not the code.
 *
 * `src/log.ts` itself is excluded, and only it. It is the FUNNEL: its two `logger.info` /
 * `logger.error` calls forward the caller's own `event` and `detail` by construction, so there is
 * nothing there to census — that forwarding is exactly why the seam has to be checked at every
 * OTHER call site instead.
 *
 * ── HOW THIS FILE AVOIDS BEING VACUOUSLY GREEN ────────────────────────────────────────────
 *
 * Four false results were reported in one day: a stripped `PATH`, an anchor that matched a JSDoc
 * comment instead of code, a mutation that broke the test's own fixture, and a `$'` in a
 * replacement that ate a long run of lines. A scanner is the easiest of all guards to make silently useless
 * — one regex change and it finds nothing, and finding nothing is green. So:
 *
 *  · {@link EXTRACTOR_FIXTURE} is a permanent self-test. It contains a bad field in code, a bad
 *    field inside a COMMENT, a bad field inside a STRING, and a regex literal containing `//`
 *    (`client.ts:139` has one) — and asserts the extractor sees exactly the first.
 *  · the site count and the event roster are asserted, so a broken match pattern is red, not green.
 *  · the verdicts come from running each name through the REAL logger and reading the line, not
 *    from a copy of `ALLOWED_FIELDS` or of `normalizeKey` in this file. There is no second
 *    allowlist here, and no regex here duplicates one of `log.ts`'s grammars.
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** The funnel. See the header — this is the one exclusion, and it is not a convenience. */
const EXCLUDED = new Set(["log.ts"]);

interface Site {
  file: string;
  /** The literal event name, or null when the first argument is not a string literal. */
  event: string | null;
  fields: string[];
  /** A spread or computed key: the call site's field set is not knowable by reading it. */
  opaque: boolean;
}


/** `(`…`)` — the index just past the matching close paren, given the index OF the open paren. */
function matchParen(mask: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < mask.length; i++) {
    const c = mask[i]!;
    if (c in pairs) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Top-level comma offsets inside `[from, to)`. */
function topLevelCommas(mask: string, from: number, to: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = mask[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) out.push(i);
  }
  return out;
}

/** Every property name in an object literal, at every depth, plus whether anything is opaque. */
function keysIn(code: string, mask: string, from: number, to: number): { keys: string[]; opaque: boolean } {
  const keys: string[] = [];
  let opaque = false;
  const stack: string[] = [];
  let prev = "";
  let i = from;
  while (i < to) {
    const c = mask[i]!;
    if (c === "{" || c === "[" || c === "(") { stack.push(c); prev = c; i++; continue; }
    if (c === "}" || c === "]" || c === ")") { stack.pop(); prev = c; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const atProperty = stack[stack.length - 1] === "{" && (prev === "{" || prev === ",");
    if (atProperty) {
      if (code.startsWith("...", i)) { opaque = true; i += 3; prev = "."; continue; }
      if (c === "[") { opaque = true; prev = c; i++; continue; }
      if (c === '"' || c === "'") {
        const close = mask.indexOf(c, i + 1);
        keys.push(code.slice(i + 1, close));
        prev = c;
        i = close + 1;
        continue;
      }
      const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, to));
      if (name) {
        keys.push(name[0]);
        prev = "n";
        i += name[0].length;
        continue;
      }
    }
    prev = c;
    i++;
  }
  return { keys, opaque };
}

/**
 * Every diagnostic call site in one file: `log(...)` and `<x>.debug|info|warn|error(...)`.
 *
 * Exported so {@link EXTRACTOR_FIXTURE} can hold it to its own claims, which is the only reason
 * this is not a private function.
 */
/**
 * A FORWARDER IS NOT A CALL SITE, and what tells them apart is WHERE the event name is written.
 *
 * `loggerOver`'s `emit(level, event, fields)` (`src/mobile.ts`) hands its OWN PARAMETER to the
 * sink, so the name is written at each caller — which this census already reads, through the
 * `.info(`/`.warn(`/`.error(` half of its pattern. Read as a site it puts a `null` event on the
 * roster and then refuses the file for every field its callers legitimately pass: five reds from
 * one adapter, none of them about a name anybody wrote. A computed name that is NOT a parameter
 * of the enclosing function is still refused — that decoy is in the extractor fixture, and the
 * arms below watch both answers.
 */
function forwardsAParameter(code: string, mask: string, callOpen: number, arg: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(arg.trim())) return false;
  let from = callOpen;
  // Walk out through at most eight enclosing blocks: a forwarding call can sit inside an `if`.
  for (let level = 0; level < 8; level += 1) {
    let depth = 0, brace = -1;
    for (let i = from - 1; i >= 0; i -= 1) {
      const c = mask[i];
      if (c === "}") depth += 1;
      else if (c === "{") { if (depth === 0) { brace = i; break; } depth -= 1; }
    }
    if (brace === -1) return false;
    // Immediately left of that brace: optional `=>`, then the parameter list's `)`.
    let j = brace - 1;
    while (j >= 0 && /\s/.test(mask[j] as string)) j -= 1;
    if (mask.slice(j - 1, j + 1) === "=>") { j -= 2; while (j >= 0 && /\s/.test(mask[j] as string)) j -= 1; }
    // A RETURN-TYPE ANNOTATION sits between the parameter list and the body — `): void => {` is
    // the production shape in `src/mobile.ts`, and a fixture written without one is exactly why
    // this rule read as working while the real file still went red. Stop at a `=`, `;` or brace:
    // past one of those there is no parameter list to be reading.
    while (j >= 0 && mask[j] !== ")" && !";{}=".includes(mask[j] as string)) j -= 1;
    if (mask[j] === ")") {
      let d = 0, open = -1;
      for (let i = j; i >= 0; i -= 1) {
        if (mask[i] === ")") d += 1;
        else if (mask[i] === "(") { d -= 1; if (d === 0) { open = i; break; } }
      }
      if (open !== -1 && new RegExp(`(?:^|[^\\w$])${arg.trim()}(?:[^\\w$]|$)`).test(code.slice(open + 1, j))) {
        return true;
      }
    }
    from = brace;
  }
  return false;
}

export function scanCallSites(source: string, file = "fixture"): Site[] {
  const { code, mask } = maskSource(source);
  const sites: Site[] = [];
  const call = /\blog\s*\??\.?\s*\(|\.(?:debug|info|warn|error)\s*\(/g;
  for (let m = call.exec(mask); m !== null; m = call.exec(mask)) {
    const open = mask.indexOf("(", m.index);
    const close = matchParen(mask, open);
    if (close === -1) continue;
    const commas = topLevelCommas(mask, open + 1, close);
    const firstEnd = commas[0] ?? close;
    const first = /^\s*"([^"]*)"\s*$/.exec(code.slice(open + 1, firstEnd));
    const rest = commas.length === 0 ? "" : code.slice(commas[0]! + 1, close).trim();
    const site: Site = { file, event: first ? first[1]! : null, fields: [], opaque: false };
    if (site.event === null
      && forwardsAParameter(code, mask, open, code.slice(open + 1, firstEnd))) {
      // The name is written at the caller; this call carries it through. Not a site.
      continue;
    }
    if (rest !== "") {
      const objStart = code.indexOf("{", commas[0]!);
      if (objStart === -1 || objStart > close || !rest.startsWith("{")) {
        // A second argument that is not an object literal: its fields cannot be read.
        site.opaque = true;
      } else {
        const objEnd = matchParen(mask, objStart);
        const found = keysIn(code, mask, objStart, objEnd + 1);
        site.fields = found.keys;
        site.opaque = found.opaque;
      }
    }
    sites.push(site);
  }
  return sites;
}

/**
 * THE HARNESS'S OWN TEST. Every trap that has actually produced a false green in this repository,
 * in one string: a real call, a call inside a line comment, a call inside a block comment, a call
 * inside a string literal, and a regex whose last two characters are `//`.
 */
const EXTRACTOR_FIXTURE = String.raw`
const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : base + url;
log("after_a_regex", { mailboxId: id });
// log("in_a_line_comment", { badFieldInComment: 1 });
/* log("in_a_block_comment", { alsoBad: 2 }); */
const s = "log(\"in_a_string\", { stillBad: 3 })";
const t = ` + "`" + `log("in_a_template", { templateBad: 4 })` + "`" + `;
log("the_real_one_failed", { url: header.url, imapPassword: pass, mailboxId: id });
log("a_spread", { ...detail });
log(computedEventName, { mailboxId: id });
`;

const SENTINEL = "sentinel";

/**
 * What the REAL logger does with one field name. Not a reimplementation of the gate: the verdict
 * is read off the emitted line, so this cannot drift from `log.ts` and cannot be weakened without
 * weakening the logger itself.
 */
function verdict(field: string): "keep" | "redacted" | "dropped" {
  const lines: string[] = [];
  createSidecarLog({ sink: (l) => { lines.push(l); } })("field_census", { [field]: SENTINEL });
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  if (parsed[field] === SENTINEL) return "keep";
  if (parsed[field] === "[redacted]") return "redacted";
  return "dropped";
}

/** The name the emitted line ends up carrying, which is `log.ts`'s event grammar and not a copy. */
function emittedEvent(event: string): unknown {
  const lines: string[] = [];
  createSidecarLog({ sink: (l) => { lines.push(l); } })(event, {});
  return (JSON.parse(lines[0]!) as Record<string, unknown>).event;
}

/**
 * The logger's own slots. `emit` takes these three out of the payload before the census gate runs
 * — `err` becomes `errorClass` + `errorCode`, and the other two are validated identifiers — which
 * is why they are absent from `ALLOWED_FIELDS` and must be absent from the check below too.
 */
const LOGGER_OWNED = new Set(["err", "errorClass", "errorCode"]);

/** Every event this package emits, and the level the name derives. Asserted to be EXACT. */
const EXPECTED_LEVEL: Record<string, "info" | "error"> = {
  // engine.ts — the thread-join heal at the drain tail. The info line carries counters only
  // (merged/moved/skipped); the failure line is `_failed`-suffixed so the level filter files a
  // caught merge failure as the error it is, and it carries counters and no thread content.
  thread_join_heal: "info",
  thread_join_heal_failed: "error",
  // engine.ts — the correspondent retro at the drain tail (the worker's pass). The info line carries
  // the three counters only (learned/released/retired); the failure line is `_failed`-suffixed, and
  // neither names an address — the correspondents it acted on are identified by nothing on the line.
  correspondent_retro: "info",
  correspondent_retro_failed: "error",
  // engine.ts — the inbound-quiet pass (forwarding detection, mail 0078) at the drain tail. The
  // info line carries the two episode counters only (tripped/cleared); the failure line is
  // `_failed`-suffixed so the level filter files a caught judgment failure as the error it is,
  // and neither line names an address — the mailbox rows the pass judged are identified by
  // nothing on the line at all (a single-account store needs no id).
  inbound_quiet_pass: "info",
  inbound_quiet_pass_failed: "error",
  // engine.ts — MULTI-MAILBOX. The roster line carries a COUNT and a reason: how many mailboxes
  // this install runs is a fact about the install, and which ones they are is a fact about
  // somebody's mail. Its reason may NOT say the runtimes hold organizer claims — see the guard
  // below, and `engine.ts`'s own block at the call. The add/remove lines carry a verdict and a
  // reason; the refusal names its code and never the login it refused, because the pair it
  // compared is the identifying signal — a host and a username together are the mailbox.
  local_roster_attached: "info",
  /* …AND THE COMPLEMENT, which is the half the count could not carry. `local_roster_attached`
     says HOW MANY mailboxes this install runs; a row the roster read left out — `disabled`, with
     a reason (paused) or without one (removed here) — had no line at all, and since
     `ensureLocalWorld`'s lookup is wider than the roster's, that row can be the SEED whose id the
     `serving` line prints. So the boot could say `serving <id>` for the one mailbox with no
     runtime and nothing about the one it was running. `info` for `local_roster_attached`'s reason:
     nothing is wrong, and a paused mailbox is a state somebody chose. The MAILBOX ID and the
     reason word, never an address. */
  local_mailbox_not_attached: "info",
  /* The resync door's refusal: a press for a mailbox this install holds no runtime for. `info`
     because the refusal is correct and the person is told — what it replaces is a 202 the pane
     rendered as "Sync queued" over an engine that never heard of the mailbox. */
  local_mailbox_resync_unserved: "info",
  local_mailbox_added: "info",
  local_mailbox_add_refused: "info",
  local_mailbox_add_failed: "error",
  local_mailbox_add_undo_failed: "error",
  local_mailbox_reattach_failed: "error",
  /* THE SEED'S RUNTIME COULD NOT BE RE-POINTED ONTO A PASSWORD THE ROUTE HAS ALREADY STORED. The
     re-attach above is for every OTHER mailbox; the seed keeps its runtime, so it is re-read in
     place instead, and this is that act failing. `error` on its neighbour's rule — nothing is
     polling with the new login until the next re-dial — and never raised, because the store now
     says the opposite of what a 500 would tell somebody. */
  local_mailbox_repoint_failed: "error",
  // …and the mailbox that was added and stored but could not be STARTED in this launch. An error
  // because a person is looking at a mailbox that is not polling; it carries no host and no
  // address, because which mail server somebody is on is the identifying signal this package keeps
  // off a log line.
  local_mailbox_attach_failed: "error",
  // engine.ts — the two one-time repairs an in-place upgrade makes to the seed's stored login.
  // NEITHER IS NAMED AFTER THE SECRET, which is this file's own rule: the first records which
  // SERVER the login was proved against, the second COPIES the sealed bytes onto a submission row
  // without decrypting them, and both names say the act rather than the material. They carry a
  // mailbox id and a reason — never a host, because which mail server somebody is on is the
  // identifying signal this package keeps off a log line.
  seed_login_server_recorded: "info",
  seed_login_server_record_failed: "error",
  seed_submission_login_copied: "info",
  seed_submission_login_copy_failed: "error",
  // The third answer of the same repair, and INFO rather than error: an upgrade whose settings name
  // a different outgoing server than the password was saved for writes no submission row at all and
  // waits for the password to be entered again. Nothing failed — a decision was taken, and the line
  // is what makes it visible.
  seed_submission_login_unsettled: "info",
  /* The FOURTH repair of the same upgrade, and the only one about the mailbox ROW rather than
     its stored login: a pause a build older than mail 0083 recorded by switching the mailbox
     OFF is rewritten to the reader it meant, so the row runs again and a takeover asked for it
     can be spent. `info` — nothing failed, a row was corrected — and the failure line derives
     `error` from its `_failed` suffix. The MAILBOX ID and the reason it was paused for, never
     an address: which mail server somebody is on is the identifying signal this census keeps
     off a line, and the reason word is one of this repository's own closed three. */
  local_mailbox_pause_ended: "info",
  local_mailbox_pause_end_failed: "error",
  // main.ts
  shutdown: "info",
  shutdown_failed: "error",
  // The close outlived its bound and the engine left without it, as the shell's kill would have.
  // `info`, like `shutdown`: the bound is the designed end, and the next open replays the log.
  shutdown_deadline: "info",
  // How the engine left (store closed or left open) and where the quit's time went. `info`: a
  // store left open is already `shutdown_failed`.
  engine_left: "info",
  start_failed: "error",
  transport_fatal: "error",
  serving: "info",
  mailbox_start_failed: "error",
  // engine.ts / host-listener.ts — the host door (Phase 3). None names an origin: the served
  // MagicDNS origin carries the machine and tailnet names, which is the identifying signal this
  // census keeps off a line. `host_config_invalid` and `host_listener_skipped` carry a fixed
  // `reason` sentence naming the VARIABLE and the rule, never the value (an origin can embed
  // credentials in the general case); `host_listening` carries the loopback port the shell
  // itself configured; `host_listen_failed` is a bind refusal — the stdio door serves on.
  host_config_invalid: "info",
  host_listener_skipped: "info",
  host_listening: "info",
  host_listen_failed: "error",
  // The connection bound's two counted classes, shared by BOTH network doors. `info` and not
  // `error`: a bound that turned sockets away is the door working. Each carries a COUNT and a
  // fixed reason and never a peer address — who is holding the door is the identifying signal
  // this census keeps off a line, and the count is what makes a flood readable at all.
  host_conn_refused: "info",
  host_header_timeout: "info",
  // The stand-down: host mode is off and the published port is held rather than released.
  // `info` for the hold and the refused knob; `error` for a hold that could not bind, which is
  // the case where something else already has the port.
  host_stood_down: "info",
  host_stand_down_skipped: "info",
  host_stand_down_failed: "error",
  // host-lan.ts / engine.ts — the LAN fallback, same rules as the host door's
  // events: fixed `reason` sentences naming the VARIABLE and the rule, never the value, and
  // `host_lan_listening` carries the PORT only — the chosen interface address identifies the
  // operator's network, which is the signal this census keeps off a line. `error` only for the
  // bind refusal; every other state is a degradation the other doors serve through.
  host_lan_config_invalid: "info",
  host_lan_skipped: "info",
  host_lan_listening: "info",
  host_lan_listen_failed: "error",
  // `host_lan_firewall_blocked` is `info` and the level is the interesting part: NOTHING WENT
  // WRONG. The door bound, the engine is serving, and a rule on this machine — which the app has
  // no business changing — is not admitting the port. It carries the same PORT-only discipline as
  // the listening line, and its `reason` embeds the remedy command, which names a port and
  // nothing about the operator's network.
  host_lan_firewall_blocked: "info",
  // ── host-lan-tls.ts — THE SAME-NETWORK IDENTITY. Rostered 2026-09-01, three events. ─────────
  //
  // These shipped without joining this roster, which is what the census is for and why it went red
  // on a clean tree rather than being noticed by a reader. Each was audited at its call site before
  // being written down here, and what the audit was looking for is the one thing that matters on
  // this path: the private key.
  //
  // IT NEVER REACHES A FIELD. `host_lan_identity_created` carries `reason` and NOTHING else — not
  // the key, not the certificate, and not even the SPKI fingerprint, though a fingerprint is public
  // and would have been defensible. The two failure events carry `err` + `reason`, and `err` is the
  // thrown value, which `createLogger`'s `emit` reduces to `errorClass` + `errorCode` with the
  // message discarded before anything is written — so an OpenSSL parse error over key bytes cannot
  // put those bytes on a line. `keyPem`/`newKeyPem` appear nowhere in a detail object.
  //
  // ── ONE THING WORTH ARGUING WITH, AND IT IS THE LEVEL ─────────────────────────────────────
  //
  // `host_lan_identity_unreadable` is `info`, and it is `info` for a REASON THAT IS NOT A JUDGEMENT
  // ABOUT SEVERITY: the level is derived from the event name by `ERROR_EVENT`, which is
  // `/_(?:failed|fatal|unavailable)$/`, and `unreadable` is not in that vocabulary. The condition it
  // reports is that this computer's same-network key exists and cannot be used, so same-network
  // access is OFF for the launch and every paired device is unreachable until a human fixes a file.
  // Its closest sibling in this roster, `stored_login_unavailable`, is `error` for a comparable
  // state.
  //
  // Rostered at the level the logger actually emits, because this file's job is to say what the
  // events ARE — an entry written as `error` here would simply fail the derivation test below and
  // prove nothing. The near-miss is a real finding and is ledgered rather than fixed in passing:
  // the fix is either a rename (an operator-visible contract another lane just shipped) or widening
  // `ERROR_EVENT` (a shared logger's derivation, which also reclassifies every other `_unreadable`
  // event in the tree). Neither belongs in a roster edit.
  host_lan_identity_created: "info",
  host_lan_identity_unreadable: "info",
  host_lan_identity_failed: "error",
  // ── host-pin-probe.ts — THE CLIENT DOOR'S TRUST. Four events, and the rule for all four is
  //    that WHICH machine and WHICH key are never on the line.
  //
  // A fingerprint identifies a computer on somebody's network at least as sharply as an address
  // does, and it is also a value a person could then be tempted to compare by eye against a
  // screen — a ceremony this module deliberately does not invite. So the mismatch line carries
  // `changed: true` and nothing else, exactly as `cloud_mirror_reset_on_owner_change` carries the
  // fact without the two addresses. `_failed` puts the probe at error by derivation; the other
  // three are ordinary facts about a household's own machines.
  host_pin_probe_failed: "error",
  host_pin_mismatch: "info",
  host_pin_accepted: "info",
  host_leaf_stale: "info",
  // ── cloud-engine.ts / cloud-signin.ts — PAIRING WITH ANOTHER MACHINE'S DESKTOP. Four events,
  //    and the rule is the sign-in's: a STEP and a STATUS, never a code, a token or an account.
  //
  // `cloud_pair_account_mismatch` carries `changed: true` alone, exactly as
  // `cloud_signin_owner_mismatch` does and for the same reason — which account this directory
  // holds is the identifying fact, and an operator needs to know a pairing was refused, not whose
  // mail is on the machine. `_failed` puts the transport at error by derivation.
  cloud_pair_redeem_failed: "error",
  cloud_pair_redeem_refused: "info",
  cloud_pair_account_mismatch: "info",
  // The pairing's OTHER refusal: the host sent no account header and this directory's mail is
  // bound to one. `changed: true` alone, for the mismatch line's reason — an operator needs to
  // know a pairing was refused and which refusal it was, never whose mail is on the machine.
  cloud_pair_account_unnamed: "info",
  // A pairing undone while its redeem was in flight: nothing kept, `changed: true` alone.
  cloud_pair_undone: "info",
  // ── engine.ts — THE SIGN-OUT DOOR OPENING ON AN EXPIRED LAUNCH BEARER. One event, `route` +
  //    `reason`, no token and no id: WHICH door and WHY, which is what an operator needs when a
  //    person says sign out did nothing for a day. Rostered with the fix that admits it.
  local_sign_out_on_expired_launch: "info",
  // launch-bearer.ts — the window's session renewing itself on both doors. A `reason` and the
  // thrown value only, never the token: that the renewal failed, or that the row was revoked.
  launch_bearer_renew_failed: "error",
  launch_bearer_revoked: "info",
  cloud_paired: "info",
  // The mailbox a paired launch serves, named when its first mailbox list lands (`ready` had
  // none), and the one way that naming can fail. The id and nothing else; the error its class.
  cloud_serving_mailbox: "info",
  cloud_serving_mailbox_failed: "error",
  // Each renewal that minted, and what started it (`kind`): `request` is the 401 belt, so a run of
  // them where the door named a window is the schedule not running. No token, no window, no id.
  cloud_session_renewed: "info",
  // The way OUT of that mismatch, taken only on an explicit instruction. `changed: true` and
  // nothing else, for the mismatch line's reason: an operator needs to know the previous
  // account's mail is being discarded, never whose it was.
  cloud_pair_started_over: "info",
  // ── engine.ts — THE STANDALONE REMOVE-MAILBOX ROUTE. Rostered 2026-09-02, two events. ──────
  //
  // Same story as the three above and it is the third time: the route shipped, the roster did not
  // move, and this file was RED ON A CLEAN TREE — which is the census doing its job and nobody
  // reading it. Both were audited at the call site rather than assumed.
  //
  // `local_mailbox_removed` carries `verdict` + `reason` and no address, no host and no id: WHICH
  // mailbox was removed on a single-mailbox install is the install itself, and the sentence is the
  // part an operator needs. `local_mailbox_remove_failed` carries `err` alone — the thrown value,
  // which `createLogger` reduces to `errorClass` + `errorCode` before anything is written, so the
  // service's own message (which quotes a mail server) cannot reach the line.
  local_mailbox_removed: "info",
  local_mailbox_remove_failed: "error",
  // ── engine.ts — THE ACTION DOORS' RECEIPT AND THEIR SHARED REFUSAL ────────────────────────
  //
  // These doors logged their verdict and never their arrival, so "the press never reached the
  // engine" and "the engine took it and dropped it" were byte-identical in the log — measured on
  // a released build, on the takeover. `local_action_received` is written before any branch,
  // including the credential read, because that read is the block's first branch and the refusal
  // below it is the one that needed separating.
  //
  // Both are `info` and both are right at that level: an arrival is not an outcome, and a refused
  // action is an answer rather than a fault — `local_mailbox_add_refused`'s reading exactly. They
  // carry the ROUTE PATTERN (a literal from this file's own table, never the request's path), the
  // method, the row id where the PATH carries one, and a status on the refusal. No address and no
  // host: which mail server somebody is on is the identifying signal this census keeps off a line.
  local_action_received: "info",
  local_action_refused: "info",
  // The shell's network-return relay reached the retry door: how many mailboxes this install runs
  // and how many dead connections dialled now. Counts only; an answer, not a fault.
  local_network_returned: "info",
  // ── engine.ts — THE STANDALONE DOOR'S CONSENT, ITS SEAL, AND WHAT A REMOVAL NOW ALSO DOES ──
  //
  // Seven events, rostered 2026-09-02. Two of them (`local_mailbox_organize_*`) had been shipping
  // un-rostered and were this file's standing red on a clean tree — the FOURTH time that has
  // happened, so it is worth saying plainly: a red census is not noise, it is a route that landed
  // without its roster line, and reading it as background is how five accumulate.
  //
  // `local_mailbox_organize_consented` is the consent write's own record — the stamp, the
  // baseline, the window and the scope, written in one transaction. `err`-free by construction.
  // `local_mailbox_organize_failed` and `local_mailbox_seal_failed` carry `err` ALONE: both
  // handlers sit ahead of the route table, so they map the service's own error by hand, and the
  // service's message quotes a mail server and (on the seal) a login. `err` is the one shape the
  // logger reduces to `errorClass` + `errorCode` before anything is written, which is why neither
  // line carries the message it renders to the person.
  //
  // `organizer_claim_released` carries `claims` — a COUNT, which is the whole of what an operator
  // needs about somebody else's mailbox — and its failure twin carries `err` + `reason`, because
  // the cost of that failure (another install stands itself down against a claim nothing holds,
  // for a staleness window) is not deducible from the error class.
  //
  // `local_mirror_wipe_failed` records the wipe that could not run; `ensure_folders_failed` is the
  // promotion's best-effort half. Both `error` by the naming rule and both correct at that level:
  // the first now REFUSES the removal — the mail is still on disk, so the mailbox keeps its
  // runtime and its place on the roster and the person is asked to remove it again — and the
  // second leaves an organizer with nowhere to route.
  local_mailbox_organize_consented: "info",
  local_mailbox_organize_failed: "error",
  // `local_mailbox_organize_refused` — a consent press that did not ask to take the mailbox over,
  // refused because the row shows another install renewing its claim. `verdict` + `reason`, no
  // holder name: the name is a machine's own, read off a mail server.
  local_mailbox_organize_refused: "info",
  // `local_mailbox_probe_failed` — the TEST-CONNECTION dial's refusal, on the local twin of
  // `POST /mailboxes/probe`. `err` ALONE, on `local_mailbox_seal_failed`'s rule and for the
  // sharper version of its reason: this handler's whole input is a host, a username and a
  // password somebody just typed, and the service's message quotes the first two back. `err` is
  // the one shape the logger reduces to `errorClass` + `errorCode` before anything is written, so
  // the line records THAT a dial was refused and never which server refused it.
  //
  // `error` by the naming rule, and correct at that level even though a wrong password is an
  // ordinary event: a refused probe is also how a blocked port, a mis-set TLS mode and an
  // unreachable host arrive, and those are the ones an operator reading a customer's log is
  // looking for.
  local_mailbox_probe_failed: "error",
  /* The roster route saying it ANSWERED, with counts. `info`: an ordinary read, and the reading
     is the trail rather than any one line. Counts only — never an id, an address or a server
     name. */
  local_mailbox_connections_answered: "info",
  // `local_mailbox_smtp_unsettled` — the connect kept its INCOMING credential and recorded the
  // outgoing half as unsettled, because an outgoing server is not a reason to stop receiving.
  // `info`, not `error`, and the level is the claim: nothing failed that the person needs to act
  // on right now — the mailbox connects, syncs and organizes, and the sending half is reported on
  // the row and refused honestly at the send. `verdict` carries the probe's reason code, which is
  // a member of a fixed taxonomy and never a server's own words; `reason` says what was kept.
  local_mailbox_smtp_unsettled: "info",
  local_mailbox_seal_failed: "error",
  // `local_mailbox_seal_discarded` — a credential this door wrote was removed again because a
  // sign-out overtook it (`signout-fence.ts`). `info` and not `error`: nothing is wrong, the
  // person asked for exactly this; it is the receipt that the write which raced the sign-out did
  // not survive it, and without it the 409 the door answers has no counterpart in the log.
  local_mailbox_seal_discarded: "info",
  organizer_claim_released: "info",
  organizer_claim_release_failed: "error",
  // `organizer_claim_release_refused_sibling` — the release arm's fourth answer (mail 0121):
  // the server holds a FRESH claim under this install's id and a nonce it never wrote — a
  // restored image or clone — so the release accomplished nothing and may delete nothing. `info`
  // by the naming rule: nothing failed, the refusal is the protocol working, and the row records
  // `release_refusal = 'sibling_lapse'` so the pane says the sentence. `mailboxId` + `reason`,
  // on `organizer_claim_released`'s rule.
  organizer_claim_release_refused_sibling: "info",
  // `organizer_claim_release_unconfirmed` — the poll's release arm, on the one answer that is
  // neither a count nor an absence: the server would not say whether this install's record is out
  // of the mailbox. `info` by the naming rule and correct at that level, because the twin above
  // is the `error`: the search's own refusal is already recorded there, and this line's content is
  // what that refusal MEANT here — nothing was written down, the mailbox stays organized by this
  // install with the request standing, and the next poll asks again. `mailboxId` + `reason`, on
  // `organizer_claim_released`'s rule: which mailbox, and the consequence, which is not deducible
  // from an error class.
  organizer_claim_release_unconfirmed: "info",
  // `organizer_claim_release_yielded_to_press` — the release arm again, on the outcome where the
  // person countermanded it while it was asking the server: the compare-and-set found the stamp or
  // the request moved and the whole write yielded. `info` by the naming rule and right at that
  // level — nothing failed, two instructions arrived in the wrong order and the later one stands.
  // `mailboxId` + `reason`, on `organizer_claim_released`'s rule.
  organizer_claim_release_yielded_to_press: "info",
  // `organizer_released_by_lapse` — the release arm's bounded end: the server refused to confirm
  // the record's removal for a whole staleness window, after which every reader of the folder
  // already treats the claim as stale and the row records the organizing as ended. `info` on the
  // yielded event's rule: nothing failed HERE — each refusal was logged by the `error` twin as it
  // happened — and this line is the consequence, which is not deducible from any of them.
  // `mailboxId` + `reason`, on `organizer_claim_released`'s rule.
  organizer_released_by_lapse: "info",
  local_mirror_wipe_failed: "error",
  // `local_mirror_wipe_finished` — the start finishing a removal a close, a crash or an older
  // build left with mail under its tombstone. `info`: nothing failed, the mail was taken off as the
  // removal promised. `mailboxId` + `reason`, the same pair as its `_failed` twin above, which the
  // start writes when it cannot.
  local_mirror_wipe_finished: "info",
  // `inherited_sends_read_failed` — the open's read of the send reservations the last run left
  // pending. `err` + `reason`: nothing is decided early and the rows keep the ten-minute window.
  inherited_sends_read_failed: "error",
  // `inherited_sends_forgotten` — the open forgetting the last run's reservations that offered
  // nothing (mail 0162); `count` only. Its `_failed` twin: `err` + `reason`, the drain decides them.
  inherited_sends_forgotten: "info",
  inherited_sends_forget_failed: "error",
  ensure_folders_failed: "error",
  // `organizer_peek_failed` — the APPEND-less look a pre-consent install takes so its own consent
  // screen can name the holder. `err` + `reason`, no holder and no mailbox: the whole content of a
  // FAILED look is that there was one, and the sentence says what the row keeps in the meantime.
  organizer_peek_failed: "error",
  // `organizer_gap_read_failed` — the release arm's read of where the gap began, before the
  // settings flush (RULING-026 lane A). `err` + `reason`: the release goes ahead and the settings
  // leave without the key, so the next install opens its window at its own look.
  organizer_gap_read_failed: "error",
  // ── engine.ts — THE TAKEOVER STAMP'S PER-CYCLE RE-READ. Rostered with the line. ────────────
  //
  // `err` + `reason` and nothing else: the read is one indexed lookup by mailbox id against this
  // install's own store, so there is no third fact worth carrying and no fact about the mailbox
  // at all. `error` by the naming rule, and it is the right level — a takeover the person asked
  // for is deferred to the next cycle, and if the row stays unreadable it is deferred for ever.
  organizer_takeover_reread_failed: "error",
  // host-static.ts — the served browser client. A fixed `reason` sentence naming
  // OHMAIL_HOST_ASSETS and the rule, never the configured value: a filesystem path carries the
  // OS account name, which is the identifying signal this census keeps off a line. `info`, not
  // error — the door serves its API and degrades the pages, exactly as a skipped listener does.
  host_assets_missing: "info",
  // db.ts — the store's own checkpoint. Nothing else in a PGlite database ever takes one (no
  // postmaster, so no checkpointer). The line is emitted when it reclaimed something or held the
  // store past CHECKPOINT_SLOW_MS, with its `kind`, a segment count and a duration.
  local_db_checkpointed: "info",
  local_db_checkpoint_failed: "error",
  // db.ts — the timed log flush (the walwriter PGlite lacks) failed one write; it is tried again
  // at the next deadline.
  local_db_flush_failed: "error",
  // db.ts — the store's database ended under it (a failed fsync PANICs Postgres and PGlite's WASM
  // aborts). Said once, `err` + `reason`: every later statement is refused, and the engine ends its
  // process so the next start recovers from the log. `error` by the `_fatal` suffix.
  local_db_fatal: "error",
  // db.ts — the close door. A call that reached the store after its close began is refused unrun,
  // said once with the `method` it used; and a close whose admitted calls outran the bound left the
  // store open for the next launch, `err` carrying how many and how long.
  local_db_refused_closing: "info",
  local_db_close_failed: "error",
  // local-retention.ts — the drain's hourly retention pass on this store: change-log rows it
  // compacted (`pruned`) and audit rows it aged out (`removed`), written only when it took any.
  local_retention_pruned: "info",
  local_retention_failed: "error",
  // db.ts — a data-directory lock whose recorded owner is provably gone (a crash or power loss)
  // is reclaimed on start, with this one sentence and none for the person. `kind` says which
  // evidence decided (owner-gone / owner-replaced / hold-released); no pid, no path. `info`, not
  // error: the recovery IS the ordinary path after a power cut, and the refusal case throws instead.
  data_dir_lock_reclaimed: "info",
  // db.ts — the OS-held lock (macOS, Windows) could not be taken on this directory, so a lock left
  // in it is judged by identity alone, as before. `kind` is the open's errno code or `not-exclusive`;
  // no path, no pid. `info`, and named so: an `error` line here would become the shell's quoted first
  // error for a start that fails later for another reason.
  data_dir_hold_skipped: "info",
  // db.ts — a store a start never finished making, set aside (kept) before a new one is made.
  // `kind` says which evidence decided (unfinished / holds-nothing); no path. `info`: the store
  // held nothing, and making it again is the recovery, not a failure.
  store_set_aside: "info",
  // db.ts — a new store could not be made in memory (`fresh-store.ts`), so it was made on disk as
  // before. `err` and a reason, no path. `error`: the start still serves, seconds slower.
  fresh_store_copy_failed: "error",
  // db.ts — the boot-time bloat compaction (`reclaimBodyBloat`). Emitted only when the gate
  // decides a rewrite is worth minutes (measured pathology: a table many times the size of its
  // data), carrying catalog byte counts and a duration — no mailbox, no message, no path. The
  // failure arm is `error` by the same reading the checkpoint's takes: nothing is lost and the
  // next launch retries, but a store that can never compact stays slow for ever.
  store_compacting: "info",
  store_compacted: "info",
  // The gate DECLINED because it could not measure how much of the table is live (an empty page
  // sample and an empty bounded read). Info, not warn: nothing is wrong with the store, and the
  // next launch measures again — see `db.ts`, where reading an absent average as zero used to
  // rewrite a healthy table.
  store_compact_unmeasurable: "info",
  store_compact_failed: "error",
  // db.ts — one line per migration a person actually waited for (the SLOW_MIGRATION_MS floor), so
  // a launch that spent minutes on a schema upgrade names WHICH migration spent them. Info, and
  // silent on an ordinary upgrade: a whole pass is 25–43 ms there, and a line per migration would
  // be hundreds of lines nobody reads. The fields are a journal tag and a duration — this repository's own
  // filename, no mailbox and no row.
  migration_applied: "info",
  // main.ts / cloud-engine.ts / cloud-mirror.ts / cloud-auth.ts / cloud-proxy.ts — the Cloud-mirror
  // mode. None names the token it is about (the `ephemeral_kek` rule at the bottom of this file):
  // the events say WHAT happened — the process is serving, a pull applied N entities, a pull or a
  // token refresh failed, a write could not be forwarded, the write echo did not land in time —
  // never the credential.
  cloud_serving: "info",
  cloud_start_failed: "error",
  cloud_pull_applied: "info",
  cloud_pull_failed: "error",
  // The quarantine's own three lines plus its cap notice — the released 0.20.0 wedge's instrument.
  // Each carries `constraint`/`table` (our schema's identifiers, on ALLOWED_FIELDS with the fix)
  // and never a row's content; `kind` is the entity type, the counts are the mirror's own.
  // `info` by the suffix derivation: the pull itself did not fail — the page landed minus the
  // held rows, which is the whole point — and `cloud_pull_failed` above stays the error line.
  cloud_page_integrity_refused: "info",
  cloud_row_quarantined: "info",
  cloud_row_quarantine_full: "info",
  cloud_quarantine_retry: "info",
  // A pull that left early because the mirror was asked to stop. `info` and not `failed`: nothing
  // went wrong, the app is quitting — and the line is what tells a slow quit apart from a stuck one.
  cloud_pull_stopped: "info",
  cloud_cursor_expired: "info",
  // The hosted account was DELETED (a `410 account_erased` from any hosted read), so the mirror
  // stopped for good. `info` and not an error by the same rule as the stop above: nothing went
  // wrong — the account is gone, and the line is what tells a stopped mirror apart from an
  // offline one. `…_discarded` is the removal of that account's copy from this computer, with the
  // mailbox COUNT; `…_discard_failed` says the next launch removes the database instead.
  cloud_account_erased: "info",
  cloud_account_erased_discarded: "info",
  cloud_account_erased_discard_failed: "error",
  cloud_mirror_swept: "info",
  // The account's mailboxes, mirrored ahead of every drain. `cloud_mailboxes_refreshed` is emitted
  // only when the refresh CHANGED the local set, and carries three counts and the reason, never an
  // address: `count` is how many mailboxes the account has, `pruned` how many local rows it no
  // longer names, `dropped` how many of those were removed rather than left as tombstones. All
  // three are already on `ALLOWED_FIELDS`; an address here would be exactly the identifying signal
  // this census exists to keep off a line.
  //
  // `cloud_mirror_unattributable` is the honest note that mail arrived for a mailbox the account
  // did not list and was skipped rather than filed under a different sender. A count and the
  // reason — naming the mailbox id would be naming the mail.
  cloud_mailboxes_refreshed: "info",
  cloud_mirror_unattributable: "info",
  // A mirror whose rows predate the mailbox attribution being the account's own is replayed from
  // the start of the feed, once. The event NAME is the whole fact, so the line carries only the
  // reason rather than two format numbers and two new allowlist entries to print them with.
  cloud_mirror_rekey: "info",
  // An interrupted bootstrap (the re-key included) continued from its committed cursor against
  // the same persisted generation, instead of replaying the feed from zero. The event name is
  // the whole fact; the line carries only the reason — no cursor value, no counts.
  cloud_bootstrap_resumed: "info",
  // The bootstrap's opening window (`cloud-mirror.ts`, NEWEST FIRST): `restarted` is the hosted
  // snapshot refusing the window's persisted page cursor (re-read from page 1, same generation);
  // `skipped` is a server with no snapshot route at all, so the bootstrap fills oldest-first from
  // the feed alone. Both carry only the reason — no cursor value, no counts — and both are
  // postponements of an ordering, never a failure of the mirror, so neither is an error level.
  cloud_window_restarted: "info",
  cloud_window_skipped: "info",
  // The window's first-screenful body ask failed; the walk still owes every body — a deferral,
  // never a fault, so the replay proceeds and the line says why the newest mail may open blank.
  cloud_window_bodies_deferred: "info",
  // The stale-resume freshen (INSTANT-ARCH stage 2): a WARM mirror resuming past the staleness
  // threshold lands snapshot page 1 before its oldest-first replay. `applied` carries one count
  // and the reason; `deferred` is the window-skip's shape — freshness is an optimization and the
  // replay is the contract, so a snapshot that will not answer is a postponement, never an error
  // (`status` or the class-reduced `err`, plus the reason; no cursor value, no address). The
  // bodies deferral is `cloud_window_bodies_deferred`'s twin for the freshened screenful.
  cloud_freshen_applied: "info",
  cloud_freshen_deferred: "info",
  cloud_freshen_bodies_deferred: "info",
  // The mid-bootstrap rules pass a queue answer owes (`askRulesRefresh`): `refreshed` carries one
  // count; `refresh_deferred` the class-reduced `err` and the reason. A failure is a postponement
  // (the replay still carries the rules and the next answer asks again), so neither is an error.
  cloud_rules_refreshed: "info",
  cloud_rules_refresh_deferred: "info",
  // The mirror belongs to exactly one hosted account; a change of served address discards it whole
  // and re-bootstraps clean (`cloud-engine.ts`'s `enforceMirrorOwner`). The line names NEITHER
  // address — the prior and served mailboxes are the identifying signal this census exists to keep
  // off it — and carries only `changed: true`, the one non-identifying fact that a reset happened.
  cloud_mirror_reset_on_owner_change: "info",
  // `operator-ca-fetch.ts` — a certificate authority file is in the data folder and cannot be read
  // as a certificate, so the candidate probe dials without it and refuses on trust. NAMED
  // `_unavailable` deliberately: `ERROR_EVENT` is `/_(?:failed|fatal|unavailable)$/`, and this is a
  // state only a human can clear, so the name and the level are chosen together rather than leaving
  // another near-miss for the roster to explain. The line carries the reason and nothing else; the
  // reason names the file's PATH in the app's own data folder, never its bytes or a name from it.
  cloud_operator_ca_unavailable: "error",
  // The same file found in the folder earlier versions read, said once per path with both paths in
  // the reason: which one was used, and where it belongs. A move a person can make, so `info`.
  cloud_operator_ca_old_folder: "info",
  // The one-time stale-mirror tag repair. `deferred` and not `failed`: the probe not answering
  // leaves a working mirror working, so it is a postponement rather than an error — and the level
  // says so. Neither names a tag; they carry two counts and the reason.
  cloud_tag_backfill_applied: "info",
  cloud_tag_backfill_deferred: "info",
  // The one-time folder repair, the tag repair's shape verbatim (the folders foundation): folder
  // entities that drained before the apply loop stored that type sat below the cursor for ever.
  // `deferred` and not `failed` for the tag repair's reason — a snapshot that does not answer
  // leaves a working mirror working, and the flag stays unset so the next pull retries. The
  // applied line carries one count (`folders`) and the reason; the deferred line the `err` —
  // reduced by the logger to class+code — and the reason. Neither names a folder: a folder's
  // NAME is the user's own filing vocabulary, the identifying signal this census keeps off the
  // line.
  cloud_folder_backfill_applied: "info",
  cloud_folder_backfill_deferred: "info",
  // The one-time rule-instant repair, the folder repair's shape: rules mirrored without
  // their creation instant resolved a sender's twins in the wrong order. The applied line carries
  // one count (`rules`) and the reason; the deferred line the `err` and the reason. Neither names
  // a rule's match — an address or a domain, the signal this census keeps off the line.
  cloud_rule_instant_repair_applied: "info",
  cloud_rule_instant_repair_deferred: "info",
  cloud_auto_reply_repair_applied: "info",
  cloud_auto_reply_repair_deferred: "info",
  // The one-time cap-marker repair, on the tag repair's shape and for the same reason: an old
  // sidecar's empty body row cannot be told from an empty message until this pass offers it once.
  // `deferred` and not `failed` — a page that fails leaves the mirror exactly as correct as it
  // was, and the flag stays unset so the next launch resumes. Neither line names a message: two
  // counts and the reason, on the logger's own allowed vocabulary.
  cloud_cap_marker_repair_done: "info",
  cloud_cap_marker_repair_deferred: "info",
  cloud_refresh_failed: "error",
  // The hosted API DEFINITIVELY refused to renew the session (401/403 — revoked or rotated-past
  // family). `error`, because a person must act (sign in again) — the measured alternative was a
  // desktop that retried into 401s every five minutes for a day while its window showed week-old
  // mail. The line carries only the reason: never the token, never the address.
  cloud_session_renewal_failed: "error",
  // Where the hosted session stands (`cloud-auth.ts`): live, renewing, unreachable, refused or
  // seal_failed, with a vocabulary code, the fault count and the next retry. `info`, because every
  // state but `refused` is the session surviving a fault — and `refused` has its own error line
  // above. Never a token, a body or an address: the code is our envelope's word or a status.
  cloud_session_state: "info",
  cloud_forward_failed: "error",
  cloud_write_echo: "info",
  // cloud-proxy.ts — one line per write this door forwards, and the account's refusal of
  // one with its code. `info`: a forwarded write is the ordinary case, and a refusal is the
  // account's answer, not this install failing. The route pattern and a key hash, never a body.
  cloud_write_forwarded: "info",
  cloud_write_refused: "info",
  // cloud-staged-upload.ts — one staged file's bytes carried to the account's storage: the
  // storage's status, the byte count and the round trip; or the failure to reach it. Never the
  // signed URL, which is a credential.
  cloud_staged_upload: "info",
  cloud_staged_upload_failed: "error",
  // cloud-mirror.ts — the one-time arrangement repair: deferred when the snapshot could not be
  // read (the next pull retries), applied with how many mailboxes it filled. Both `info`.
  cloud_profile_repair_deferred: "info",
  cloud_profile_repair_applied: "info",
  // The relay refused a request: the route is not on the allowlist. `info`, because it is the
  // ordinary answer to a route this install does not forward — but it has to be SAID, or a route
  // added without a relay verdict is a 404 indistinguishable from a server that lacks the route.
  // The line carries the method, the first path segment (id-shaped, else `other`) and the reason.
  cloud_relay_refused: "info",
  // cloud-account-first.ts — the mirror answered a search, or refused a page, because the account
  // could not be reached. `info`: the door is working as designed. The status and the reason only.
  cloud_search_from_mirror: "info",
  // cloud-account-first.ts — one timed line per relayed search: the part asked, who answered, the
  // account's round trip and its own ms, the door's total and the arrival instant. `info`.
  search_relayed: "info",
  // cloud-wake.ts — the push subscription that kicks the mirror per hosted commit. BOTH levels
  // are `info` on purpose: a refused or never-established stream leaves a fully working door on
  // its poll (the hosted flag ships off, so refusal is the expected first-run state), and an
  // established one is the fact a deploy verification reads. Neither carries an address, a
  // token or a frame — a `status`, an `err` and the reason are the whole vocabulary.
  cloud_wake_connected: "info",
  cloud_wake_off: "info",
  // The hosted account answered 402: the wake is parked until the mirror is served again. `info`:
  // the door keeps its poll, and the account's own wall says the refusal. Only the reason rides.
  cloud_wake_walled: "info",
  // The hosted stream said 429 — LATER, not never. `info` on the same argument as `off`: the
  // door keeps working on its poll while the dial repeats on a slow cadence. Only the reason
  // rides the line; the Retry-After value would be a new field for a fact the redial itself acts on.
  cloud_wake_throttled: "info",
  // cloud-engine.ts / cloud-signin.ts — the pre-auth door. Same rule as every event above: they
  // say WHAT happened and never who or with what. `cloud_signin_refused` carries the hosted
  // service's HTTP status and no part of the address, the password or the code, which is what an
  // operator needs to tell "the password was wrong" apart from "the service was not reachable".
  cloud_pre_auth: "info",
  // A browser handoff was started: this install minted a PKCE pair and is holding the verifier.
  // The line carries the mailbox and nothing about the pair — not the verifier, which is a secret
  // this process never writes anywhere, and not the challenge either, which is merely public
  // rather than useful. `challenge` is not on `ALLOWED_FIELDS`, so a field carrying it would be
  // dropped rather than emitted; the event's existence is the whole of the signal an operator
  // needs to tell a handoff that was never started apart from one that was refused.
  cloud_link_challenge_minted: "info",
  // The one-confirm sign-in: a request was made (the engine holds its id and verifier) and later
  // claimed. The mailbox and nothing else — never the request id, the verifier or the hostname.
  cloud_approval_requested: "info",
  cloud_approval_claimed: "info",
  // The window's Back, Cancel or "Type a code instead" ended the wait: states only, `{mailboxId}`.
  cloud_approval_stopped: "info",
  cloud_signed_in: "info",
  cloud_signed_out: "info",
  // What the server said when a sign-out asked it to end the session: `changed` and a fixed
  // sentence, never a token, an address or the server's name.
  cloud_signed_out_at_server: "info",
  // A sign-out that left the window's changes on this computer for their account: the count only.
  cloud_sign_out_deferred_writes: "info",
  cloud_signin_failed: "error",
  cloud_signin_refused: "info",
  // A sign-in whose hosted account is NOT the one this mirror was bootstrapped for, turned away
  // before the pair was sealed or activated. The line names NEITHER address, for the reason
  // `cloud_mirror_reset_on_owner_change` names neither: which account a machine holds mail for and
  // which one somebody just tried to sign in as are the identifying signal this census exists to
  // keep off it. `changed: true` — a mismatch happened — is the whole of the payload.
  cloud_signin_owner_mismatch: "info",
  // The pending door's first claim adopted the hosted account: its door file was created and the
  // mirror's owner recorded. `changed: true` and nothing else — never the address it adopted.
  cloud_identity_adopted: "info",
  // …or could not: the door file was there already (a door chosen during the wait) or would not be
  // written. `err` and a fixed reason; the path is under somebody's home and is not a field.
  cloud_door_write_failed: "error",
  // The hosted service would not say whose account a freshly minted pair belongs to, so the
  // sign-in was refused rather than admitted on an unchecked identity. `info` and not `error`
  // because the ordinary cause is a network that dropped between two requests; the consequence is
  // a sign-in the person can simply retry. Carries a status or an `err` and the reason, never the
  // address it was trying to establish.
  cloud_identity_unresolved: "info",
  cloud_seal_removal_failed: "error",
  // engine.ts
  stale_sessions_revoked: "info",
  install_key_absent: "info",
  // The stored mailbox login (the per-install key made a credential persistable). None of the
  // three names the secret they are about — see the `ephemeral_kek` case at the bottom of this
  // file, which is the rule they are obeying.
  stored_login_sealed: "info",
  stored_login_absent: "info",
  stored_login_cleared: "info",
  // The sign-out fence's own two lines. `stored_login_fence_raised` is written the moment the
  // epoch moves and names how many credential writes the sign-out is waiting for;
  // `stored_login_seal_discarded` is the launch's seal removed again because a sign-out landed
  // inside it. Both `info` for `local_mailbox_seal_discarded`'s reason: this is the product
  // working, and a sign-out with no line for what it fenced is one nobody can read afterwards.
  stored_login_fence_raised: "info",
  stored_login_seal_discarded: "info",
  stored_login_unavailable: "error",
  // The boot contract refused a credential proved against a different server than this launch is
  // configured for. `info`, with `stored_login_absent` and NOT with `stored_login_unavailable` —
  // which is the level the naming rule gives it (`ERROR_EVENT` is `_failed|_fatal|_unavailable`)
  // and also the right one. The discriminator this package uses is whether something is WRONG, not
  // whether somebody has to act: `unreadable` is `error` because the install is damaged — a key
  // that will not open its own row — whereas here the credential is intact, the key works, the
  // mirror is whole, and the engine did exactly what it should. Two settings disagree and it
  // declined to guess. That is a prompt, like `absent`, not a fault. (Written down because the
  // first draft of this row said `error` by analogy with "a mailbox that is not syncing", which is
  // equally true of `absent`; the census is what caught it.)
  //
  // It names NEITHER host — which server a mailbox is on is the identifying signal this census
  // keeps off a line, and the pair of them is more identifying than either half.
  stored_login_foreign_host: "info",
  // ── THE LAUNCH THAT COULD NOT USE ITS STORED PASSWORD, AND THE ONE THAT COULD AGAIN ───────
  //
  // `mailbox_login_unavailable` is the OUTAGE: this install holds a sealed password it could not
  // dial with, so the mailbox is not syncing, and the connection record says so rather than
  // reporting a reachable mailbox that is up to date. `error` by the naming rule (`ERROR_EVENT`
  // is `_failed|_fatal|_unavailable`) and right at that level for `stored_login_unavailable`'s
  // reason — a mailbox has stopped and the install cannot fix it on its own. Two call sites, one
  // literal name: the launch's first reading and the second read that confirms it, told apart by
  // `verdict`. `state` carries the credential state, which is a closed set and never a server.
  //
  // `mailbox_login_restored` is the other end: a later read opened the row, so the mailbox dials
  // now rather than at the next launch. `info` — this is the product healing.
  mailbox_login_unavailable: "error",
  mailbox_login_restored: "info",
  organizer_stand_down: "info",
  organizer_stand_down_write_failed: "error",
  // ── THE HANDOVER THE STAND-DOWN OWES (0.16.1) ────────────────────────────────────────────
  //
  // A stand-down hands the moves recorded in the takeover window to the install that holds the
  // mailbox now. The line is `info` for `organizer_stand_down`'s own reason — nothing is wrong,
  // this install did what the lease told it. It names the MAILBOX ID and nothing else about the
  // mailbox: no address and no holder, and the counts are of OUR own request rows with a `reason`
  // sentence this repository wrote.
  //
  // THE FAILURE LINE IS GONE, and its absence is the fix rather than a gap. It was
  // `organizer_stand_down_moves_handover_failed`, written by a handover that had its own
  // transaction and swallowed its own error — the demotion was recorded anyway and every
  // not-yet-exported move stayed on a reader. The handover now rides the demotion's transaction,
  // so a failure of either is one event, `organizer_stand_down_write_failed`, and there is nothing
  // left for a second name to report.
  organizer_stand_down_moves_handed_over: "info",
  /* RENAMED FROM `organizer_takeover_clear_failed`, because the statement it reports does two
     things and the name told you about the lesser one. It writes the ROLE and spends the press
     stamp together, so a failure leaves the row saying `reader` for the install the lease just
     made the organizer — not "one more spendable cycle". `_failed`, so `error` by the naming
     rule, and it names the mailbox and a constant sentence. The worker keeps the old name for
     its own line; this census reads `apps/sidecar/src` only. */
  organizer_promotion_failed: "error",
  /* AND THE HALF THAT WORKED, which had no line at all until the ORDER needed measuring. The
     promotion's success is ordinary, so `info`; it names the mailbox, the state it wrote and a
     constant sentence, and nothing read off the mailbox. Its pair is the worker's
     `lease_permit_granted`, and the two together are what `phone-stop-then-start.test.ts` reads
     instead of a fixture's invocation. That pair is in `apps/worker/src`, which this census does
     not scan — the same split the `_failed` line above records. */
  organizer_row_promoted: "info",
  // The agree's sweep after that promotion (`agreeSweepPass`): what it did, or the failure that leaves
  // the counted letters to the Screener's offer.
  organizer_agree_sweep: "info",
  organizer_agree_sweep_failed: "error",
  // ── THE RELEASE, AND THE THREE LINES IT ADDS (mail 0088) ──────────────────────────────────
  //
  // "Stop organizing this mailbox, keep my mail" is an ordinary transition and its success line is
  // `info` for `organizer_stand_down`'s reason exactly: nothing is wrong. The install did what a
  // person asked, keeps its login, its credentials and its mirror, and reads the mailbox from here.
  //
  // Each names the OUTCOME and no mailbox: the `reason` sentence is a constant this repository
  // wrote, and there is no address, no host, no holder name and no count of anything a person
  // owns. `organizer_claim_released` carries one integer (`claims`) which is a count of our OWN
  // bookkeeping messages in a folder we wrote them to.
  organizer_released: "info",
  organizer_release_write_failed: "error",
  // ── AND THE ONE THAT IS NOT A FAILURE BUT SAYS SOMETHING IS WRONG ────────────────────────
  //
  // `info`, and the level is the interesting decision. The naming rule would make it `error`
  // (`ERROR_EVENT` is `_failed|_fatal|_unavailable`) and the name does not end in one of those on
  // purpose: nothing FAILED. A single point-read of the local store did not answer this pass, so
  // the gate declined to claim anything and the next poll asks again — the same shape as
  // `organizer_takeover_reread_failed` beside it, which is `error` because it can silently spend a
  // person's press, where this one can only cost a poll.
  //
  // It is worth a line at all because the gate's SILENCE is what it produces: an install that is
  // the organizer and stops renewing looks, from outside, exactly like one that is quietly
  // working. If this line repeats, the store is the thing to look at.
  organizer_row_unreadable: "info",
  // ── THE APPOINTMENTS A STAND-DOWN CLOSES, AND WHY THE INFO LINE IS THE INTERESTING ONE ────
  //
  // A stand-down ends every pending send-later appointment on this mailbox, because the pass that
  // would have kept them is behind the gate that just said no. Both arms carry `closed` (an
  // integer) and `disabledReason` (a `MAILBOX_DISABLED_REASONS` member — three literals this
  // repository wrote) and NOTHING about the messages: WHICH message was scheduled, to whom and
  // when are all facts about somebody's mail, and the count is not.
  //
  // The info line is emitted only when something closed, so the overwhelming case — an install
  // handing a mailbox over with no appointment standing — stays silent. When it is NOT silent it
  // is the only record anywhere that a message the person expected to send did not: the row is
  // the durable half, and this line is what makes it findable afterwards.
  //
  // The failure arm is `error` on `resurface_pass_failed`'s exact reading: a close that does not
  // happen leaves a promise the UI already made with a real wall-clock date on it, and here it is
  // worse than a resurface — no pass on this install will ever run again to keep or retract it,
  // so the launch catch-up is the only thing left and this line is the reason to look.
  scheduled_sends_stood_down: "info",
  scheduled_sends_stand_down_failed: "error",
  // A person pressed "Organize from this machine" (`POST /local/organizer/takeover`). `info`: the
  // request was recorded and the LEASE still decides on the next launch, so this line is a
  // decision by a human and never an outcome about the mailbox. It carries the `outcome` — one of
  // four literals this repository wrote — under `verdict`, and the previous stand-down reason;
  // it names no address, which is the identifying signal this census keeps off a line.
  organizer_takeover_authorized: "info",
  // ── THE PHONE'S OWN DOOR, AND THE TWO VERBS BEHIND IT (fix-018) ───────────────────────────
  //
  // `apps/sidecar/src/mobile.ts` is the phone's composition root and it interposes on BOTH
  // consent paths (`/mailboxes/:id/organize` and the `/local/` spelling): this build has no
  // takeover verb, so a live foreign claim is a 409 whoever pressed, the verb that takes a mailbox
  // outright is not served at all, and the press that is forwarded carries `join` so the mail
  // server decides it too. Seven lines, and none of them names an address, a holder or a count of
  // anything a person owns — the two that carry `mailboxId` carry the row id the caller already
  // holds, exactly as `organizer_stand_down` does.
  //
  // `organizer_consent_refused_elsewhere` is `info` and NOT a failure: another machine organizing
  // the mailbox is the ordinary state of a stood-down phone, the refusal is the invariant holding,
  // and the claim watch reaches it once a cadence for as long as that lasts. It carries `verdict`
  // for `organizer_takeover_authorized`'s reason.
  organizer_consent_refused_elsewhere: "info",
  // The route that makes THIS install the organizer whoever holds the mailbox — a desktop verb,
  // refused here rather than forwarded. `info`: it is the invariant holding at a door, the same
  // class as the 409 above, and it says nothing about anybody's mail.
  organizer_takeover_verb_absent: "info",
  // The SHARED consent route is not served on this door — it is `stepUp: true`, and a standalone
  // install's launch session stamps its second factor once at boot, so from five minutes in it
  // answers 403 for the life of the process. `info`: nothing went wrong, the door is stating what
  // it serves, and a caller that reaches it is a caller aimed at the wrong spelling. It carries a
  // fixed reason and no id — which mailbox was asked for adds nothing to "that path is not here".
  organizer_consent_route_absent: "info",
  // A single point-read of the local row did not answer, so no consent was recorded. NAMED to
  // earn `error` rather than pinned to it — the level is derived from the name, and unlike
  // `organizer_row_unreadable` beside it this one refuses a PRESS a person made, so the sentence
  // they get is about a retry rather than a wait.
  organizer_consent_row_read_failed: "error",
  // The row could not say who holds the mailbox — `organizer_state` NULL is "we have not looked" —
  // and the look this press paid for did not land either, so no consent was recorded. `error` for
  // `organizer_consent_row_read_failed`'s reason: it refuses a PRESS a person made. The two are
  // separate because they send an operator to different places — the local store, or the mail
  // server — and the op on this one names which lease operation could not be performed.
  organizer_consent_lease_read_failed: "error",
  // The same refusal as `organizer_consent_refused_elsewhere` and NOT the same fact: that one is
  // read off the row's holder columns, this one off a live look at the claim folder, taken because
  // the row had never been written. A phone relaunching beside a machine that claimed the mailbox
  // meanwhile takes this arm. `info` for the same reason its twin is: the invariant holding at a
  // door, and nothing about anybody's mail.
  organizer_consent_refused_by_lease: "info",
  // THE LOOK ITSELF, one line per press that paid for one — `landed`, `timeout` or `failed` under
  // `outcome`, with `latencyMs`. `info` and DERIVED, like every name here: the door's refusal has
  // its own `_failed` line beside this one, and a look that answered slowly is not a fault. It is
  // the only thing that tells a slow door apart from a door that never asked, which is device run
  // 4's defect through a different await. No line on the fast path: a `held` row costs no look.
  organizer_consent_look: "info",
  // THE WAY BACK, and it is the only one of the six that is a becoming. `info`: the consent was
  // recorded and the gate still decides, so this is a decision by a human (or, for the claim
  // watch, by the app being open over a mailbox nothing holds) and never an outcome about mail.
  organizer_reclaimed: "info",
  // The door could not be reached at all, or the forced cycle behind the press did not run. Both
  // are `error` on `organizer_takeover_reread_failed`'s reading: they can silently cost a press a
  // person made and leave the screen saying the opposite of what happened.
  organizer_claim_here_failed: "error",
  organizer_claim_here_cycle_failed: "error",
  // The person's STOP, in its two failure arms. The stop is recorded on the row and the cycle is
  // what takes the claim out of the folder, so a failure of either leaves a claim standing over an
  // install that has been told to stop — the state every other install reads as a live organizer.
  organizer_stop_here_failed: "error",
  organizer_stop_here_cycle_failed: "error",
  // …and the third arm, which carries no error because nothing threw: the route accepted the stop
  // and the cycle could not confirm the claim left the mailbox. `info`, like the row-removed line
  // below and for its reason — this is a state, not a fault, and the state is the honest one: the
  // mailbox is still organized here, the request stands, and the next poll asks the server again.
  // It is also the line that says why the notification is still up.
  organizer_stop_here_unconfirmed: "info",
  // THE CLAIM'S SAME ARM, and the pair is the point: the press was admitted, the consent is on the
  // row, and the forced cycle did not take the claim — so this install is not organizing the
  // mailbox and the door may not report a start. `info` for its twin's reason: nothing threw, and
  // the state is the honest one. It is also the only line that says why a Start the person watched
  // came back as "could not read"; the cycle settles through `allSettled`, so the `error` line
  // above it cannot fire and this is what an operator actually reads.
  organizer_claim_here_unconfirmed: "info",
  // The two verbs' REFUSING exits, which had no line at all — so a press a person made and
  // watched fail left nothing anywhere. `info` and not `error`: nothing threw, the door answered,
  // and the answer is a state (no sole mailbox, or a route that said no). They carry the mailbox
  // id where there is one, the door's own status, and the reason; never an address.
  organizer_claim_here_refused: "info",
  organizer_stop_here_refused: "info",
  // The STOP's own decision line, written where the decision is made rather than where the forced
  // cycle ends — the claim's `organizer_reclaimed` twin. `info`: the request is on the row and the
  // gate has been asked; the gate's own lines say what became of it.
  organizer_stop_here_recorded: "info",
  // ── WHAT THE PHONE'S DOOR ANSWERED, when it answered a no ─────────────────────────────────
  //
  // `GET /mailboxes` over this door answers a row under Node and was refused on a device, twice,
  // with nothing anywhere to read: the app's roster read folds a non-200 and a throw into one
  // "could not ask". `phone_door_refused` is `info` — a door refusing a reader is the ordinary
  // answer for a phone whose mailbox another machine organizes — and `phone_door_failed` is the
  // throw. `route` and `method` come from this file's own describers: the query string is dropped
  // before the grammar runs, and a route pattern takes at most an opaque `:id`, so neither can
  // carry a person's words.
  phone_door_refused: "info",
  phone_door_failed: "error",
  // The mailbox was REMOVED while the organizer lease was being read, so the grant that would
  // have ended this install's stand-down found a tombstone instead and this launch organizes
  // nothing. `info`, and the level is the interesting part: NOTHING WENT WRONG — a person
  // removed a mailbox and the removal held. It carries a fixed `reason` sentence and no id, no
  // address and no verdict: which mailbox is the identifying signal this census keeps off a
  // line, and a single-account store needs no id to say this happened.
  organizer_takeover_row_removed: "info",
  // ── THE ORGANIZER'S REQUEST DRAIN, AND THE READER'S OWN CYCLE (0.14.1) ────────────────────
  //
  // Five names, all `info` except the wrapper's failure arm, and the levels are the argument:
  //
  //  · `organizer_request_key_unreadable` — this install could not read the account's request
  //    key, so its claim advertises no `requests` capability and readers are refused at their own
  //    door. `info` and not `warn`: for a local install that is the ORDINARY state (nothing
  //    delivers the key to this side yet), so a louder level would page on the designed case.
  //  · `organizer_requests_drained` / `outstanding_requests_driven` — the two "a pass did
  //    something" lines, carrying only counters. Silent when there was nothing to do.
  //    `standing` on the first is records this build deliberately left alone (a future protocol,
  //    or a kind it has no applier for): nonzero is normal, unlike `refused`.
  //  · `organizer_requests_note` — everything else the drain reports (a refusal, a failed
  //    expunge, an unreadable folder), with the drain's own event name as the `outcome` VALUE
  //    rather than as this line's name. That translation is deliberate and the file it happens
  //    in says why: a forwarded event name is a name this census cannot enumerate.
  //  · `organizer_requests_drain_failed` — the wrapper. `error`, on `adapter_close_failed`'s
  //    reading: the pass that would have applied a decision did not run at all.
  organizer_requests_drained: "info",
  outstanding_requests_driven: "info",
  organizer_requests_note: "info",
  organizer_requests_drain_failed: "error",
  // `meta_shrink` — the lease-refused arm swept a `_meta` too full to read: whether it ran and
  // how many records it took. `info`: it is the cure running, once per refused pass.
  meta_shrink: "info",
  adapter_close_failed: "error",
  // THE CONNECTION DIED WITH THE PROCESS STILL UP — a lid closed past the provider's idle
  // timeout, a Wi-Fi change, a VPN flap, a server `BYE`. `error`, on `sync_cycle_failed`'s
  // reading rather than on "something broke": a desktop that stops organizing silently is the
  // failure this line exists to make findable, and the level is what makes one search find it.
  // It carries the `err`, the `mailboxId` and `detectedBy` — never the server, never the
  // address: which provider somebody's mailbox is on is the identifying signal this package's
  // census keeps off a log line, and it is on screen where the person who can act on it is.
  mailbox_connection_unavailable: "error",
  /* THE SERVER ANSWERED THE PASS'S FETCH AND REFUSED IT — a mailbox over quota, a corrupted
     backend, a provider throttling body fetches. `error`, on the line above's own reading and for
     the same reason: no mail was read, and a desktop that stops mirroring silently is what one
     search has to find. It is a SEPARATE line because it is a separate fact — the login stands
     and the server is answering, so filing it under the connection is the sentence that sent
     somebody to look at their network. Named `_unavailable` rather than `_refused` because this
     file's rule is that a level a line wants is bought with its name, and `_refused` derives
     `info`. One line per SETTLED ATTEMPT, so a mailbox nothing can be read from says so every
     pass rather than once. It carries `status`, our own two-member read of the driver's
     `responseStatus`; the server's response text and `[…]` code are not carried at all. */
  mailbox_fetch_unavailable: "error",
  /* The heartbeat has nothing to ask with: an adapter that implements no NOOP, so a half-open
     link is detected only when the socket deadline fires. `error` by the naming rule, and right
     at that level — every production dial is an `ImapAdapter`, which has the command. */
  mailbox_heartbeat_unavailable: "error",
  /* THE PROBE'S WINDOW ELAPSED AND THE SERVER WAS HEARD FROM ANYWAY — a NOOP queued behind a
     command that is still running. `info`, and the level is the argument: NOTHING WENT WRONG,
     and the line exists so that "the heartbeat never fired" and "the heartbeat declined to
     blame a busy connection" are different readings rather than the same silence. */
  mailbox_heartbeat_deferred: "info",
  /* THE ENGINE'S OWN MEMORY, on a timer beside `boot_phases`. `info`, and it must stay `info`:
     it is a MEASUREMENT and not a judgement. Nothing in this repository had ever called
     `memoryUsage`, so there is no bar for these numbers to be above or below, and attaching a
     level that implies one would be inventing the bar in the severity column. */
  engine_vitals: "info",
  // THE HEAL'S TWO ARMS. `mailbox_reconnected` is `info` because a connection that came back is
  // the ordinary, designed outcome — the line exists to say WHEN, and how long the mailbox went
  // unorganized (`totalMs`, measured from the FIRST observation of death and never from the
  // latest attempt). Its failure arm carries the `_failed` suffix, so the name classifies itself
  // and the level below is a record of that rather than a second decision.
  mailbox_reconnected: "info",
  mailbox_reconnect_failed: "error",
  /* A CYCLE THAT DID NOT DRAIN A CONNECTION A READ BOUND RETIRED. `info` by its suffix: the
     breach is filed under `mailbox_connection_unavailable`, and this line says the cycle waited
     for the ladder rather than failing over the stale breach. */
  mailbox_redial_deferred: "info",
  /* A RE-DIAL WHOSE GATE SET A MESSAGE ASIDE. `info`: progress, not a failure — the retirement is
     filed under `mailbox_connection_unavailable`, and this line says the ladder did not climb. */
  mailbox_redial_after_set_aside: "info",
  /* A STOP THAT GAVE UP WAITING FOR ITS CYCLE AND DESTROYED THE SOCKET. `info`, and the NAME is
     why: "forced" and not "failed", because the stop WORKED — this is the bound doing its job on
     a link that answers nothing. The link's own deadness is already filed under
     `mailbox_connection_unavailable`/`mailbox_heartbeat_unavailable`, so raising this one would
     count one condition twice. Written here as `error` first, and the derivation refused it: this
     file's rule is that a level a line wants is bought with its name, and nothing about a
     completed stop earns `_failed`. */
  mailbox_detach_forced: "info",
  /* THE REMOVAL WAITING FOR THE PASS THAT WAS STILL READING MAIL, and the arm where the bound
     ran out. Both `info`, on `mailbox_detach_forced`'s argument and for its reason: nothing went
     wrong in either. The first exists so that "the removal was instant" and "the removal waited
     for a pass" are different readings — what an operator needs when somebody reports a slow
     Remove. The second says the pass was not waited out, which is the bound doing its job on a
     link that answers nothing; the pass's own writes then meet the refusal at the commit rather
     than landing behind the tombstone, so no mail is lost and nobody is asked to act. Neither
     name carries a failure suffix, and neither should: the removal happened. */
  local_mailbox_pass_awaited: "info",
  local_mailbox_pass_not_awaited: "info",
  /* THE RE-DIAL THAT REACHED A LIVE SERVER AND AN UNREADABLE LEASE. `error` by its name, and the
     name was chosen for it: the socket is back and the mailbox is still not being organized, so
     it is not a success and must not be filed as one. */
  mailbox_reconnect_lease_unavailable: "error",
  /* A CONNECTION WE HAVE ALREADY REPLACED REPORTING ITS OWN DEATH. `info`, and deliberately not
     a failure: the real adapter's `error` listener is unguarded, so a socket we closed on purpose
     during a re-dial is entitled to say so afterwards. The line exists to make that visible
     rather than to raise it — what would be a defect is ACTING on it. */
  mailbox_connection_stale_report: "info",
  /* THE SERVER ANSWERED AND REJECTED THE SIGN-IN. `error` by its name, and the name was chosen
     for the level: this is the one connection outcome a person must act on, and it stops the
     automatic re-dial entirely, so it has to be findable by the same search that finds the rest. */
  mailbox_sign_in_failed: "error",
  /* THIS DEVICE REFUSED THE SERVER'S CERTIFICATE. `error` by its name: like the refused sign-in it
     stops the automatic re-dial, so it has to be findable by the same search. */
  mailbox_certificate_check_failed: "error",
  /* A RULE'S RETRO WALK on this door: `info` when it moved or finished something, `error` when the
     pass threw — the rule stays owed either way. */
  rule_retro_pass: "info",
  rule_retro_failed: "error",
  /* THE ONE CYCLE A REPLACED PASSWORD ASKS FOR, having failed. `error` by its name and by what it
     is: the dial before it succeeded, so a person who has just re-supplied a password is owed the
     reason the pass that followed did not land. */
  mailbox_relogin_cycle_failed: "error",
  /* …AND THAT CYCLE NOT RUN, BY NAME: the password was stored on a runtime that never dialled (it
     started without one), so there is no login to re-open and the launch that opens the mailbox
     dials it. `info`: nothing failed, and on the first connect the door starts that launch next. */
  mailbox_relogin_skipped: "info",
  /* …AND ON A "SIGN IN AGAIN" PRESS THE LAUNCH RUN INSTEAD: nothing starts an engine behind that
     press, so the runtime that never dialled is started now. `info`: a decision, not a failure;
     the launch's own lines say how it went. */
  mailbox_launch_on_press: "info",
  /* THE LAUNCH THAT PRESS STARTED WAS REFUSED BY THE SERVER, and the password the press stored was
     removed again. `info` on `mailbox_open_refused`'s rule: the refusal itself is filed under
     `mailbox_sign_in_failed`, and this line records the consequence — nothing kept, press refused. */
  local_mailbox_launch_refused: "info",
  /* "SIGN IN AGAIN" ON A MAILBOX NOTHING PLACES — an earlier build's sign-out kept no server. Refused
     by name with what is known, nothing dialled. `info`: a state the window acts on, not a fault. */
  local_mailbox_server_unknown: "info",
  /* A PHONE'S NEW INCOMING HOST, refused while this install holds the claim (the lease counts it
     another mailbox), and the SAME mailbox's port or TLS mode followed in place with the claim
     kept. Both `info`: a decision recorded, nothing failed. */
  local_mailbox_host_change_refused: "info",
  mailbox_dial_moved: "info",
  /* THE MOVE A CLAIMED MAILBOX MAKES TO A NEW INCOMING SERVER — claimed, refused, kept, abandoned.
     `info`: each is a decision. The candidate that could not be claimed at all is `error` by name. */
  organizer_host_change: "info",
  organizer_host_change_failed: "error",
  /* THE OUTGOING PASSWORD AN EARLIER BUILD'S SIGN-OUT LEFT, removed at the boot with its server
     kept. `info`: the repair ran. Its failure is `error` by its name — the password is still stored. */
  signed_out_residue_removed: "info",
  signed_out_residue_remove_failed: "error",
  /* THE LAUNCH THE MAIL SERVER ANSWERED WITH A NO, refused rather than handed back as an engine
     (`mobile.ts`). `info` by its name, and the level is right rather than merely derived: the
     failure itself is already filed under `mailbox_start_failed`/`mailbox_sign_in_failed`, and
     this line records the CONSEQUENCE — the engine was stopped and the caller told why. */
  mailbox_open_refused: "info",
  /* A REFUSED LAUNCH DISCARDED THE PASSWORD IT HAD JUST SEALED (`mobile.ts`). `attachLocal` seals
     at attach, before anything dials, so a refused first press left a row the next press could not
     get past — the wrong password won over the form, or a corrected host made the row FOREIGN and
     the launch dialled nothing at all. `info` on `mailbox_open_refused`'s rule: the refusal itself
     is already filed, and this records the consequence. `reason` only — no host and no mailbox. */
  mailbox_open_seal_discarded: "info",
  /* THE STORE ANSWERED WITH A CREDENTIAL THIS LAUNCH COULD NOT DIAL, on a start that supplied a
     password of its own (`mobile.ts`). Named `login` and not after the row itself, which the
     name rule below refuses for its own reason. `info` by its name and by its meaning: nothing failed at a
     server — the row names another one, or this install's key does not open it — and the honest
     outcome is that no engine is handed back. It carries the STATE and nothing else. */
  mailbox_open_no_login: "info",
  /* THE OUTGOING SERVER REFUSED THE CONNECT (`mobile.ts`): its greeting and AUTH are asked beside
     the incoming dial. `info` on `mailbox_open_refused`'s rule — the consequence, recorded; the
     verdict word and nothing else. Its probe THROWING is `error` by its name: the connect is then
     judged on no answer at all. */
  mailbox_open_submission_refused: "info",
  mailbox_open_submission_probe_failed: "error",
  /* THE INCOMING SERVER WAS NOT SIGNED IN TO AT CONNECT (`mobile.ts`): a dial that
     failed but not on a refused password or encryption, or no login inside the bound. `info` on
     `mailbox_open_refused`'s rule — the consequence; the dial's failure is `mailbox_start_failed`.
     The verdict word and the error's class, nothing else. */
  mailbox_open_unreachable: "info",
  /* AND THE CLEARING ITSELF COULD NOT BE DONE. `error` by its name and rightly: the next press
     dials the refused credential again, which is a mailbox that cannot be opened until the person
     enters the password once more. `err` + `reason`, no host and no mailbox. */
  stored_login_clear_failed: "error",
  /* THE CREDENTIAL CHANGED, so the stored refusal is no longer evidence and the automatic dial is
     armed again. `info`: this is the designed recovery, not a fault — and it exists because the
     refusal is NOT cleared by construction on every credential path, whatever the comment beside
     it used to claim (`forgetStoredLogin` does not detach, and the seal route excludes the seed). */
  mailbox_sign_in_retry_armed: "info",
  /* A CLAIM GIVEN BACK BECAUSE THE MAILBOX WENT WHILE THE LEASE WAS BEING READ. `info`: it is
     the tidy outcome of a race, not a fault — the alternative was leaving a claim nobody honours
     to age out under the next install. Its failure arm names itself. */
  organizer_claim_released_on_detach: "info",
  /* THE CLAIM GIVEN BACK BECAUSE THIS INSTALL IS SHUTTING DOWN — the ordinary quit, and `info` on
     the two rules above: nothing failed, and it is the row that says the mailbox is free NOW
     rather than after the staleness window. The organizer row is untouched, so the next launch
     claims it again. `mailboxId` + `claims` + `reason`; its failure arm is the shared
     `organizer_claim_release_failed`, rostered once above. */
  organizer_claim_released_on_stop: "info",
  /* THE CLAIM KEPT BECAUSE THE SHELL MARKED THIS STOP AS A RESTART. `info`: nothing failed, and the
     relaunch continues the claim under the same install id. `mailboxId` + `staleAfterMs` + `reason`. */
  organizer_claim_kept_for_restart: "info",
  /* A PERSON'S CONSENT ON A REFUSED PRESS COULD NOT BE WRITTEN. `error`: it carries `err`, and the
     consent the person gave is lost until they press again. `err` + `mailboxId` + `reason`. */
  organizer_consent_record_failed: "error",
  /* THE SETTINGS DOORBELL AFTER A CONSENT COMMITTED COULD NOT BE WRITTEN (`organize-here.ts`). `error`:
     it carries `err`, and an open window reads the new window only at the next settings change or
     consent read. The consent itself stands. `err` + `mailboxId` + `reason`, never an address. */
  organizer_consent_doorbell_failed: "error",
  /* THE GAP CATCH-UP FILED MAIL THAT ARRIVED WHILE NOTHING ORGANIZED THE MAILBOX, or closed its
     window. `info`, the retro pass's twin: counts only. Its failure arm carries `err` + `reason`. */
  gap_catchup_pass: "info",
  gap_catchup_failed: "error",
  /* THE CLAIM HANDED BACK BECAUSE THE APP IS LEAVING THE FOREGROUND. `info` on
     `organizer_claim_released`'s rule: nothing failed, and the consequence is not deducible from
     any other row — the organizer row is deliberately UNTOUCHED, so this install is still the
     organizer of record and the next gated cycle claims the mailbox again unless another install
     took it. `mailboxId` + `claims` + `reason`. Its failure arm is the shared
     `organizer_claim_release_failed`, rostered once above. */
  organizer_claim_handed_back: "info",
  /* THE SETTINGS AN EXIT WITHOUT A PRESS COULD NOT LEAVE — the app quitting or the phone leaving the
     foreground (RULING-026 lane A, as amended). `error` on the derivation: the write was
     refused or held, so the instant this install let go is not in the mailbox, and the claim went
     back without it. Said once per exit. `mailboxId` + `phase` (`quit`/`background`) + `outcome` +
     `reason`. */
  organizer_settings_leave_failed: "error",
  /* A DRAIN STOPPED AT ITS CYCLE EDGE FOR A HAND-BACK. `info`: nothing failed, and it is the line a
     device log reads between the app leaving and the release. `mailboxId` + `cycles`. */
  organizer_hand_back_at_cycle_edge: "info",
  /* THE FORCED CYCLE A RESUME RAN AND DID NOT COMPLETE. `error` on this roster's derivation — it
     carries `err` — and it deserves it: a resume is a person opening the app, so a cycle that
     could not run there is the one a device diagnosis starts from. What it does NOT mean is that
     the mailbox was given up: the poll is armed and holds what this install holds. `mailboxId` +
     `err` + `reason`. */
  organizer_resume_cycle_failed: "error",
  /* Its failure arm is `organizer_claim_release_failed`, which is listed ONCE, above, beside the
     release it shares. All three release sites on this door report a failure through the same
     event — one helper owns the throw — so the roster names it once however many callers there
     are. It was written here a second time as well; a duplicate key in an object literal is the
     LAST of them silently winning, and nothing could see it: the two values agreed, the runtime
     object has no trace of the first, and this file is not typechecked. The guard below reads the
     SOURCE for exactly that reason. */
  // The connect-time \Junk/\Trash discovery could not run for this attach (mail 0065's local
  // half). It carries the `err`, so it classifies as `error` — rightly: the fallbacks are safe
  // (spam verdicts keep filing to ohmail/Quarantine, deletes are refused up front) but a
  // discovery that keeps failing is a mailbox whose junk+delete surface never arrives, and
  // that should be findable by the same one search the hosted worker's copy answers to.
  special_folder_discovery_failed: "error",
  // The Ohbox posture and bar could not be read for this pass. `error` and not `warn`: it means a
  // drain filed on the lenient default while the mailbox may have asked for something stricter,
  // which is mail in the wrong pile — the same name the hosted worker logs, so one search covers
  // both hosts. It carries no bar and no posture, only that the read failed.
  screening_pref_read_failed: "error",
  sync_cycle_failed: "error",
  // The scheduled-resurface flip, once per drain. `resurface_flipped` carries ONE integer — how
  // many message_states came due (`flipped`; the old `rescued` counter left with the
  // reconciliation pass when resurfacing stopped forcing read state, 2026-08-26) — and is
  // emitted only when it is non-zero, so a mailbox with nothing scheduled stays silent. It names
  // no message and no date: WHICH row resurfaced is a fact about somebody's mail, and the count
  // is not. The failure arm is `error` because a resurface that does not happen is a promise the
  // UI already made to the user with a real wall-clock date on it, and the pass is the only
  // thing that can keep it.
  resurface_flipped: "info",
  resurface_pass_failed: "error",
  // Send later's local pass (mail 0077), on the drain cadence beside the resurface flip. The
  // summary carries only the pass's own counters (claimed/sent/unverified/failed/deferred —
  // `packages/core`'s field census admits them and drops anything else); the failure line's
  // `reason` says what stands and what retries, the sibling passes' grammar.
  scheduled_send_pass: "info",
  scheduled_send_pass_failed: "error",
  /* AND THE ABSENCE OF THAT PASS, said once per runtime on a composition that keeps no
     appointments (`composition-passes.ts` — a phone). `info` and not `error`: nothing failed, the
     composition is doing what it was built to do, and this line exists because "a send that never
     happened is visible by that line's absence" cuts both ways — a reader looking for
     `scheduled_send_pass` on a phone needs to find the reason it is missing. */
  scheduled_send_pass_not_composed: "info",
  // The AWAY RESPONDER's local pass (mail 0087), directly after the appointment clock and gated the
  // same way. The summary carries counters only — accounts / examined / sent / unverified /
  // throttled / suppressed / deferred* / capped — and deliberately NOT the correspondent's address:
  // `away_replies.sender` is somebody else's personal data, and a line naming who wrote to a person
  // while they were away is a disclosure about both of them. The failure line's `reason` says what
  // stands and what retries, the sibling passes' grammar.
  away_responder_pass: "info",
  away_responder_pass_failed: "error",
  // The away responder's STAND-DOWN, written once when the lease moved while the pass was running:
  // the reply in hand was refused at the send boundary and the pass ended. `info` and not `error` —
  // leaving anytime is the product, and the install that now holds the mailbox answers the same
  // message from its own pass. The mailbox id and a sentence, no account, no correspondent.
  away_responder_stood_down: "info",
  // The SEND RECONCILER's local pass, the third and last of the drain's outbound hooks and the
  // only one of them that is NOT gated on organizing — the subject is this install's own stranded
  // reservation and the work is a read, so a reader must still settle its own. Emitted only when a
  // row was actually claimed, so an install with nothing stranded — which is every install almost
  // every drain — stays silent. Six counters, no draft subject, no recipient, no body.
  send_reconcile_pass: "info",
  send_reconcile_pass_failed: "error",
  // The auto-suggest pass at the drain tail — "suggest for new senders as they arrive", on a door
  // whose only "always" is "while the window is open". Three integers (`examined`, `bought`,
  // `capped`) and emitted only when something was bought, so an install that has not opted in — and
  // one whose queue is already answered for — stays silent every drain. It names no sender, no
  // subject and no verdict: WHICH sender was asked about is a fact about somebody's mail and the
  // counts are not. The failure arm is `error` rather than `warn` because on this door the model is
  // one the person is paying for out of their own pocket, so a pass that threw after the model was
  // called is a cost with nothing to show for it, and the local AI's own `ai_call_failed` covers
  // only the calls that failed AT the model.
  screener_auto_suggest: "info",
  screener_auto_suggest_failed: "error",
  // Acting on what those suggestions say, when the account asked for that. Three integers
  // (`applied`, `failed`, `capped`) and emitted only when a sender was filed or a file was
  // refused, so an install that has not opted in stays silent every drain. It names no sender and
  // no message: WHICH sender was filed is a fact about somebody's mail, the counts are not. The
  // failure arm is `error` — the person's setting promised an action that did not happen.
  screener_auto_act: "info",
  screener_auto_act_failed: "error",
  // The historical-name repair at the drain tail — filling `from_name` and the recipient columns on
  // messages stored before those columns existed. Three integers (`scanned`, `fillable`, `written`)
  // and emitted only when a visit WROTE, so a store with nothing to repair, and one this launch has
  // already finished, stay silent every drain. It names no message, no sender and no address: WHICH
  // message got its sender's name back is a fact about somebody's mail, and how many did is not —
  // and the field NAMES are counted for too, because a key called `fromName` on a log line is one
  // refactor away from carrying the name instead of the count of them. The failure arm is `error`
  // rather than `warn` on the same reading the two above take: nothing is lost and the next drain
  // asks again, but a repair that never succeeds leaves the app showing bare addresses for mail the
  // user can see the sender of in any other client, which is a defect and not a diagnosis.
  sender_names_backfilled: "info",
  sender_names_backfill_failed: "error",
  // The identity backfill (mail 0148): a count of rows checked and marked, and its contained failure.
  sender_check_backfill: "info",
  sender_check_backfill_failed: "error",
  // The list-address backfill (mail 0150), once per store: two counts (`scanned` List-Post values,
  // `written` addresses), never an address; its failure is `error` on the identity backfill's reading.
  list_address_backfill: "info",
  list_address_backfill_failed: "error",
  // engine.ts — the 0.25.9 press repair, once per launch: counts only, and only when it wrote.
  // The failure is `error` on the name repair's reading: the next drain asks again.
  inferred_presses_repaired: "info",
  inferred_presses_repair_failed: "error",
  // db.ts and search-backfill.ts — the local store's search. A setup that failed is `error`: the
  // store searches through the unindexed arms until a later launch builds the indexes. The
  // backfill writes one `info` line when it finishes; a failed round is `error` by the suffix rule,
  // and the next idle tick tries again.
  search_setup_failed: "error",
  search_index_backfill_finished: "info",
  search_index_backfill_failed: "error",
  // search-warmup.ts — the launch's one warm-up search: `info` with its ms when it ran or when a
  // person came first and it was skipped, `error` by the suffix rule when it failed (not retried).
  search_warmed: "info",
  search_warm_skipped: "info",
  search_warm_failed: "error",
  // One line per drain, carrying the wall-clock shape of the pass (cycle count, total and slowest
  // cycle ms, whether it settled) — the read that attributes desktop CPU and quit lag to the
  // pipeline. `info`: a slow drain is a diagnosis, not a fault. It names no mailbox and no message.
  sync_drain: "info",
  /* And the drain's TAIL, while it runs. The drain line is written at the end so the tail's own
     checkpoint is counted, which leaves the first tail after an import — the name repair and the
     join heal over a whole mailbox, measured at fifteen minutes and a third of a core — writing
     nothing at all, and silence at a third of a core reads as a hang. Emitted only by a tail that
     outlives the interval, so a settled mailbox is still silent. `info`: two integers and a pass
     name, no mailbox and no message. */
  sync_drain_tail_running: "info",
  // The idle ladder's one line, emitted only when the delay actually MOVES — so a settled mailbox
  // writes three of them on the way to the ceiling and then nothing, rather than one per poll.
  // `info`: resting is the designed behaviour, not a fault. Two integers, no mailbox, no message.
  sync_idle_backoff: "info",
  // Why this mailbox will NOT rest — the server advertises no IDLE, or the watch could not be
  // armed. `info` because the app is correct either way and merely slower; it is the line that
  // tells a reader the ladder's absence was measured rather than forgotten. The re-arm's failure
  // is `error` by the naming rule and right there: a dead push channel looks exactly like a slow
  // one, which is the mistake the worker already made once.
  local_wake_unarmed: "info",
  local_wake_rearm_failed: "error",
  // first-sync.ts — HOW LONG A FIRST IMPORT TOOK, from both doors. `info` on `sync_drain`'s
  // reading: a measurement, not a judgement, and there is no bar for the numbers to be above.
  // Three counts and a duration; no address, no folder, no message — WHICH mail arrived is a
  // fact about somebody's mailbox and how much of it there is is not. The failure arm is `error`
  // by the naming rule and right at that level for the reason the pass twins beside it are: the
  // import itself is unaffected, and a repair that never records leaves a question that has been
  // asked twice unanswerable from a log.
  first_sync_started: "info",
  /* The boot drain yielding to the window's bootstrap page, and the bound firing when no window
     asked. Two events rather than one with a field: a rig telling the arms apart greps an event. */
  /* One line per bootstrap page: the cold-start path logged nothing at all, so page count, page
     size and the server's time per page were unreadable on a shipped build. */
  snapshot_page: "info",
  first_page_before_drain: "info",
  first_page_grace_expired: "info",
  first_sync_finished: "info",
  first_sync_report_failed: "error",
  /* WHAT THE FIRST SYNC PRODUCED, once per CHANGE — the state the connection record carries and
     no log line reported. `info`: a settled install emits one line per mailbox per launch, and
     the `produced_nothing_readable` transition is the whole reason it exists. */
  mailbox_first_sync_state: "info",
  /* And the probe behind it, refusing to answer. `error` for `first_sync_report_failed`'s reason:
     an instrument that cannot read leaves a state unarmed, and a silent one is the silence the
     module exists to end. */
  first_sync_probe_failed: "error",
  // engine.ts / cloud-engine.ts — one line per launch, from whichever door came up, carrying the
  // wall-clock shape of the constructor the window waits on. `info`: a slow boot is a diagnosis,
  // not a fault. Six `Date.now()` deltas and nothing else — no data directory (the reason
  // `serving` dropped `dataDir`), no address, no mailbox. `boot-phases.test.ts` is the guard.
  boot_phases: "info",
  start_lease_unavailable: "error",
  // host.ts
  frame_stream_fatal: "error",
  request_failed: "error",
  /* AN ANSWERED 4xx/5xx, beside the thrown one: a window whose pull was refused on every attempt
     left this log clean for a whole session (2026-09-21). Status and route only; `info`, because
     one refusal is the door working — the incident is the rate of them. */
  request_refused: "info",
  /* Every single-body read, whatever it answered — a read the window never drew left this log
     silent. Pattern, status and latency only; `info` like the refusal beside it. */
  body_read: "info",
  // window-report.ts — the window's own failed pull, carried to this log through a bounded door.
  // `error` by the suffix rule: the window is retrying, and the line is what a reader correlates
  // the strip's warning with. The refused report is `info`: a body this door does not take.
  window_sync_failed: "error",
  window_sync_report_refused: "info",
  // window-report.ts — a Search's timings as the window measured them, and the refusal of a body
  // that is not the closed record. Both `info`: a timing is a reading, a refusal names its shape.
  window_search_phases: "info",
  window_search_report_refused: "info",
  // The window's failed consent read (FIX-025): `error` by the suffix rule — the Ohbox's Screener
  // and History wait on it. The refused report is `info`, as above.
  consent_read_failed: "error",
  window_consent_report_refused: "info",
  // window-outbox.ts — the window's queued changes on this machine. A write or a read of the file
  // that failed is `error`: a change the window could not record, or a saved set it could not
  // read and set aside. A refused body is `info`, as above.
  window_outbox_write_failed: "error",
  window_outbox_read_failed: "error",
  window_outbox_refused: "info",
  // The accepted write, with how many changes are queued: `info`, the ordinary case.
  window_outbox_recorded: "info",
  // An earlier build's ownerless file whose owner the record cannot establish: kept unread, `info`.
  window_outbox_unowned: "info",
  input_ended_mid_frame: "info",
  // ai-provider.ts — this install's own model, and the states it can be in. None of these names
  // the secret it is about, which is the `ephemeral_kek` rule at the bottom of this file: the
  // settings events say WHAT changed, and `state: "key_stored"` says only that one is now held.
  ai_settings_load_failed: "error",
  ai_settings_saved: "info",
  ai_settings_cleared: "info",
  ai_provider_verified: "info",
  ai_call_failed: "error",
  ai_routing_unavailable: "error",
  // mobile.ts — a transaction that held the phone store past a waiter's wait, and its end: `info`,
  // the waiter's own refusal is the error. Closed fields only (handle kind, two numbers).
  store_turn_held: "info",
  store_turn_released: "info",
};

function sidecarSites(): Site[] {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !EXCLUDED.has(f));
  expect(files.length, "no source files were scanned at all").toBeGreaterThanOrEqual(8);
  return files.flatMap((f) => scanCallSites(readFileSync(join(SRC, f), "utf8"), f));
}

describe("the extractor bites — the self-test that keeps this guard from being vacuous", () => {
  const sites = scanCallSites(EXTRACTOR_FIXTURE);

  it("finds the calls in CODE and none of the four decoys", () => {
    expect(sites.map((s) => s.event)).toEqual([
      "after_a_regex", "the_real_one_failed", "a_spread", null,
    ]);
  });

  it("reports the bad fields on the real call — this is the shape a planted field takes", () => {
    const real = sites.find((s) => s.event === "the_real_one_failed")!;
    expect(real.fields).toEqual(["url", "imapPassword", "mailboxId"]);
    expect(verdict("url")).toBe("redacted");
    expect(verdict("imapPassword")).toBe("redacted");
    expect(verdict("mailboxId")).toBe("keep");
  });

  it("refuses a spread and a computed event name, because neither can be read", () => {
    expect(sites.find((s) => s.event === "a_spread")!.opaque).toBe(true);
    expect(sites.find((s) => s.event === null)).toBeDefined();
  });

  /**
   * BOTH ANSWERS OF THE FORWARDER RULE, watched on one fixture — because a rule that only ever
   * skips is indistinguishable from deleting the refusal it was carved out of.
   */
  it("skips a call that forwards its own parameter, and still refuses one that does not", () => {
    const FIXTURE = String.raw`
const chosen = pick();
log("a_literal_site", { mailboxId: id });
export function loggerOver(log, bound = {}) {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    log(event, { ...bound, ...fields, level });
  };
}
function guarded(log, event) {
  if (event !== "") { log(event, { mailboxId: id }); }
}
function notAParameter(log) {
  log(chosen, { mailboxId: id });
}
`;

    const found = scanCallSites(FIXTURE);
    // Two forwards are gone: the arrow's — WITH the `): void =>` annotation the real file carries —
    // and the one inside an `if` block, which the walk has to climb out of. The literal site stays,
    // and `log(chosen, …)` closes over a const rather than taking a parameter, so it survives as
    // the refusal it should be.
    expect(found.map((f) => f.event)).toEqual(["a_literal_site", null]);
    expect(found.filter((f) => f.event === null),
      "a name that is not a parameter must survive as a refusal").toHaveLength(1);
    const bare = scanCallSites(String.raw`
function forwarder(log, event) { log(event, { mailboxId: id }); }
`);
    expect(bare, "a forward and nothing else leaves no site at all").toEqual([]);
  });

  it("survives the regex whose last two characters are `//` — client.ts:139's shape", () => {
    // Without regex tracking the `//` reads as a line comment, the rest of the line is blanked,
    // and the call on the NEXT line is still found — so the give-away is the first site's fields.
    expect(sites[0]!.fields).toEqual(["mailboxId"]);
  });
});

describe("apps/sidecar — the census", () => {
  const sites = sidecarSites();

  it("scans the whole package, and the roster is the one the code has", () => {
    // A broken match pattern finds nothing, and nothing is green. This is the assertion that makes
    // every other one in this file mean something.
    expect(sites.length).toBeGreaterThanOrEqual(16);
    const events = [...new Set(sites.map((s) => s.event))].sort();
    expect(events).toEqual(Object.keys(EXPECTED_LEVEL).sort());
  });

  it("every field name a call site passes is on ALLOWED_FIELDS — the whole point", () => {
    for (const site of sites) {
      for (const field of site.fields) {
        if (LOGGER_OWNED.has(field)) continue;
        expect(verdict(field), `${site.file} → ${String(site.event)} passes \`${field}\``).toBe("keep");
      }
    }
  });

  it("no call site is opaque: no spread, no computed key, no non-literal detail", () => {
    // `log.ts`'s census claims "82 with a literal fields object, ZERO with a computed one". A
    // computed field set is a call site this guard cannot see, which is how the next one arrives.
    for (const site of sites) {
      expect(site.opaque, `${site.file} → ${String(site.event)} has an unreadable field set`).toBe(false);
    }
  });

  it("every event name survives the logger's grammar unchanged", () => {
    for (const site of sites) {
      expect(site.event, `${site.file} has a non-literal event name`).not.toBeNull();
      expect(emittedEvent(site.event!), `${site.event!} was refused by EVENT_RE`).toBe(site.event);
    }
  });

  it("no event name NAMES a secret — `ephemeral_kek` is the reason this exists", () => {
    // Renaming that event was necessary and not sufficient; the fields were the risk, and the
    // census above is what covers them. This is the other half: an event named after key material
    // invites a field carrying it, so the name is refused as well. `key` is deliberately NOT in
    // this pattern — `install_key_absent` is the correct name and says exactly what happened.
    for (const site of sites) {
      expect(site.event, site.file)
        .not.toMatch(/kek|password|passphrase|secret|token|credential|apikey|privatekey/i);
    }
  });

  it("main.ts builds the hardened logger, and no file writes a JSON line to stderr itself", () => {
    // The defect was not a bad field, it was a SECOND IMPLEMENTATION — so the census above, which only
    // reads field names, could not have found it. This is the guard for the wiring: the production
    // entry point constructs `createSidecarLog`, and nothing in this package composes a log line of
    // its own. `main.ts`'s `claimStdout` legitimately forwards raw chunks to stderr, which is why
    // the pattern is specifically a `JSON.stringify` handed to a stderr write.
    //
    // Its honest limit: it does not prove `main.ts` passes THAT logger to `createSidecar` and
    // `serveOverStdio` rather than some other function. It proves a hand-rolled JSON sink cannot
    // be written in this package without going red, which is the regression that happened.
    const main = maskSource(readFileSync(join(SRC, "main.ts"), "utf8")).code;
    expect(main).toMatch(/\bcreateSidecarLog\s*\(/);
    // ── AND THE HALF THAT LIMIT NAMED, FOR THE ONE CONSUMER WHERE IT WENT WRONG ────────────
    //
    // The local engine composes `@trafficflow/worker/sync`, which speaks `Logger` rather than
    // this package's two-argument seam, and `engine.ts` built its `syncDeps` with no `log` at
    // all — so every diagnostic the reconcile passes emit went nowhere on the standalone door.
    // Nothing could see it: the sink was correct, the census was green, and the lines simply had
    // no logger to be written through. Both faces come from ONE `createSidecarLogger()` here, and
    // the engine is handed the structured one by name.
    expect(main, "main.ts must build the Logger, not only the diagnostic seam")
      .toMatch(/\bconst\s+logger\s*=\s*createSidecarLogger\s*\(/);
    expect(main, "the diagnostic seam must be DERIVED from that logger, never built beside it")
      .toMatch(/\bconst\s+log\s*=\s*diagnosticFor\s*\(\s*logger\s*\)/);
    expect(main, "the local engine must be handed the logger, or the sync loop is mute")
      .toMatch(/createSidecar\s*\(\s*\{[^}]*\blogger\b/);
    for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
      const { code } = maskSource(readFileSync(join(SRC, f), "utf8"));
      expect(code, `${f} composes its own log line`)
        .not.toMatch(/stderr\s*\.\s*write\s*\([^;]*JSON\s*\.\s*stringify/);
    }
  });

  it("EXPECTED_LEVEL classifies exactly the events that exist, and the derivation agrees", () => {
    for (const [event, level] of Object.entries(EXPECTED_LEVEL)) {
      const lines: string[] = [];
      createSidecarLog({ sink: (l) => { lines.push(l); } })(event, {});
      expect((JSON.parse(lines[0]!) as { level: string }).level, event).toBe(level);
    }
  });

  /**
   * NO EVENT IS CLASSIFIED TWICE — AND THIS HAS TO READ THE SOURCE.
   *
   * `EXPECTED_LEVEL` is an object literal, so a name written twice is not an error and not a
   * conflict: the LAST one wins and the first leaves no trace. `Object.entries` sees one entry,
   * `Object.keys().length` counts one, and the test above passes — so every runtime check in this
   * file is blind to it by construction. TypeScript would object, and this package does not
   * typecheck its tests, which is the second half of why one sat here unnoticed.
   *
   * The one that did was `organizer_claim_release_failed`, written beside the release AND beside
   * the detach release. Both said `error`, so it cost nothing — until somebody corrected one of
   * them and the other went on deciding, hundreds of lines away and invisible to every
   * assertion. That is the shape worth a guard: not the wrong value, the SILENTLY DISCARDED edit.
   *
   * Reading the source is the whole mechanism, so the count is asserted too — a regex that
   * matched nothing would report a clean census of an empty set, which is the failure this file's
   * own header spends a paragraph on.
   */
  it("no event is classified twice — read off the source, because the literal cannot say", () => {
    const src = readFileSync(fileURLToPath(new URL("./log-census.test.ts", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("const EXPECTED_LEVEL"));
    const keys = [...body.slice(0, body.indexOf("\n};")).matchAll(/^ {2}([a-z0-9_]+):\s*"(?:info|error)"/gm)]
      .map((m) => m[1]!);

    /* THE GUARD'S OWN PREMISE. The roster is hundreds of entries; a pattern that drifted out of step
       with the file would find a handful, or none, and report every one of them unique. */
    expect(keys.length, "the key scan found nothing like a roster — the pattern has drifted")
      .toBeGreaterThan(100);

    /* THE DUPLICATE FIRST, so the failure NAMES the defect. The count comparison below catches
       the same fault, but it reports it as `153 !== 152` — an arithmetic complaint that says
       nothing about which event was written twice, and sends the next reader to the scan rather
       than to the roster. Both assertions stay: this one identifies, that one bounds. */
    const seen = new Map<string, number>();
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
    const twice = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} (${n}x)`);
    expect(twice, "an event is classified twice; the later line silently wins").toEqual([]);

    /* AND THE SCAN AGREES WITH THE OBJECT. With no duplicates the two counts must match, so a
       divergence here means the pattern is reading something the literal is not — the guard
       measuring its own regex instead of the roster. */
    expect(keys.length, "the scan disagrees with the object the file actually built")
      .toBe(Object.keys(EXPECTED_LEVEL).length);
  });
});

/**
 * ── A LOG LINE MAY NOT ASSERT A CLAIM THE INSTALL MAY BE FORBIDDEN TO MAKE ────────────────────
 *
 * The census above guards field NAMES and LEVELS, which is what stops a line carrying somebody's
 * address. It says nothing about whether a `reason` sentence is TRUE, and one of them was not:
 * `local_roster_attached` ended "…and its own organizer claim" while counting runtimes, and
 * attaching does not dial. So the sentence was printed for a mailbox this install is a READER of —
 * no claim in `ohmail/_meta`, and none coming while the row says `reader`.
 *
 * It cost a release investigation: an empty `ohmail/_meta` beside `count: 1` was read as the
 * install believing it held a claim, because the line said so, and the search went looking for a
 * gate that had refused to write instead of for the row that decides who organizes.
 *
 * Whether this install organizes a mailbox is the lease's answer, per mailbox, and it has its own
 * events. This asserts the roster line does not answer it — the narrowest guard that makes the
 * correction watchable rather than a sentence somebody can undo without anything going red.
 */
describe("the roster line does not claim an organizer claim", () => {
  const engine = readFileSync(join(SRC, "engine.ts"), "utf8");

  it("finds the call at all — the anti-vacuity case", () => {
    // A guard that cannot locate its subject passes for the wrong reason for ever.
    expect(engine, "the roster line is not in engine.ts under that name any more")
      .toContain('log("local_roster_attached"');
  });

  it("does not say the runtimes hold claims", () => {
    const at = engine.indexOf('log("local_roster_attached"');
    // The call's own argument object, bounded by the `});` that closes it, so a neighbouring
    // event's reason cannot satisfy or fail this.
    const call = engine.slice(at, engine.indexOf("});", at));
    const reason = call.slice(call.indexOf("reason:"));
    expect(
      /claim/i.test(reason),
      "the roster line's reason says `claim`: it counts RUNTIMES, and attaching does not dial, so "
      + "this sentence is printed for a reader that holds no claim and never will",
    ).toBe(false);
  });
});

/**
 * ══ WHAT A CALL SITE HANDS THE `err` CHANNEL — the value, not the key ═════════════════════════
 *
 * `err` is the ONE key with a contract: the logger takes a THROWN value and reduces it to
 * `errorClass` + `errorCode`, plus the text where the throw was a string
 * (`packages/core/src/log.ts`). Every control it has lives on the thrown value's own shape — a
 * `name`, a `code`, a `cause` chain — and every one of them is gone the moment a call site hands
 * over a STRING instead. `err: String(e)` and `err: e.message` both compile, both read fine, and
 * both publish a line that says `errorClass: "String"` and nothing about which error it was; the
 * second also puts a driver's message, which quotes connection strings, into the one channel that
 * was built to keep them out. `packages/api/src/routes/internal.ts` carries the note from the time
 * that happened; this is the same fact as a refusal.
 *
 * Measured here rather than repo-wide because this is the engine a phone runs: the stand-down's
 * `organizer_stand_down_write_failed` is the line two device runs and a node twin could not read,
 * and `apps/sidecar/src` is the closure it and every other phone-side refusal is written in.
 */
describe("apps/sidecar — the `err` channel is handed a thrown value, never its text", () => {
  /** A stringifying form in an `err:` value. Each one was reachable; none is hypothetical. */
  const STRINGIFIES: readonly { re: RegExp; why: string }[] = [
    { re: /\bString\s*\(/, why: "String(err) — every line reads `errorClass: \"String\"`" },
    { re: /\bJSON\s*\.\s*stringify\s*\(/, why: "JSON.stringify(err) — an Error serialises to `{}`" },
    { re: /\.\s*message\b/, why: "err.message — a driver's prose in the channel built to refuse it" },
    { re: /\.\s*stack\b/, why: "err.stack — never logged; the class and code are the record" },
    { re: /\.\s*toString\s*\(/, why: "err.toString() — the same loss as String(err)" },
    { re: /^`/, why: "a template literal — the thrown value has already become text" },
  ];

  /** Every `err:` value written at a `log(...)`-shaped call, with the file it is in. */
  function errValues(source: string, file: string): { file: string; value: string }[] {
    const { code, mask } = maskSource(source);
    const out: { file: string; value: string }[] = [];
    const call = /\blog\s*\??\.?\s*\(|\.(?:debug|info|warn|error)\s*\(/g;
    for (let m = call.exec(mask); m !== null; m = call.exec(mask)) {
      const open = mask.indexOf("(", m.index);
      const close = matchParen(mask, open);
      if (close === -1) continue;
      const commas = topLevelCommas(mask, open + 1, close);
      if (commas.length === 0) continue;
      const objStart = code.indexOf("{", commas[0]!);
      if (objStart === -1 || objStart > close) continue;
      const objEnd = matchParen(mask, objStart);
      if (objEnd === -1) continue;
      /* THE MASK decides where the key is, so an `err:` inside a `reason:` sentence — and there
         are several — cannot be read as a call site's own field. BOTH spellings: `err: value` and
         the shorthand `err`, which is the form the contract asks for and therefore the form most
         sites are written in — a census blind to it would scan a tenth of them. */
      const key = /(?:^|[{,\s])err\s*(?=[:,}\n])/g;
      /* THE CLOSING BRACE IS IN THE SLICE. Without it the key's lookahead — which needs a `:`,
         `,` or `}` after the name — ran off the end for `{ err }`, the spelling where `err` is
         the LAST field, and matched nothing: 17 of this package's 98 sites were never read, and
         a stringified throw written in that shape would have passed in silence. Found from
         `packages/api`, which is written the same way and where 31 of 37 were invisible. */
      const within = mask.slice(objStart, objEnd + 1);
      for (let k = key.exec(within); k !== null; k = key.exec(within)) {
        const at = objStart + k.index + k[0].length;
        /* Depth 1 only: an `err:` nested in a sub-object is that object's business and the
           logger never reads it as the thrown value. */
        let depth = 0;
        for (let i = objStart + 1; i < at; i += 1) {
          const c = mask[i]!;
          if (c === "{" || c === "(" || c === "[") depth += 1;
          else if (c === "}" || c === ")" || c === "]") depth -= 1;
        }
        if (depth !== 0) continue;
        /* SHORTHAND is the thrown value by construction — there is no expression to read. */
        const colon = /^\s*:/.exec(mask.slice(at, objEnd));
        if (colon === null) { out.push({ file, value: "err" }); continue; }
        const from = at + colon[0].length;
        const ends = topLevelCommas(mask, from, objEnd);
        const end = ends[0] ?? objEnd;
        out.push({ file, value: code.slice(from, end).trim() });
      }
    }
    return out;
  }

  const FIXTURE = String.raw`
    log("a_bare_throw_failed", { err, reason: "the shape every site must have" });
    log("a_renamed_throw_failed", { err: caught, reason: "an identifier is still the value" });
    log("a_stringified_failed", { err: String(caught), reason: "refused" });
    log("a_messaged_failed", { err: caught.message, reason: "refused" });
    log("a_nested_one", { detail: { err: String(x) }, reason: "not the logger's channel" });
    log("a_last_field_throw_failed", { mailboxId, err });
    log("a_last_field_stringified", { mailboxId, err: String(caught) });
    log("a_sentence", { reason: "the err: prefix inside prose is not a field" });
  `;

  it("the extractor bites — it reads the VALUE, at depth 1, and not a sentence", () => {
    const found = errValues(FIXTURE, "fixture");
    expect(found.map((f) => f.value),
      "the extractor lost a site, or invented one out of prose").toEqual([
      "err", "caught", "String(caught)", "caught.message", "err", "String(caught)",
    ]);
  });

  it("refuses every stringifying form — the positive control for the refusal itself", () => {
    const refused = errValues(FIXTURE, "fixture")
      .filter((f) => STRINGIFIES.some((s) => s.re.test(f.value)));
    expect(refused.map((f) => f.value), "the refusal admits a pre-stringified throw")
      .toEqual(["String(caught)", "caught.message", "String(caught)"]);
  });

  it("no site in apps/sidecar/src hands the channel anything but the thrown value", () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !EXCLUDED.has(f));
    expect(files.length, "no source files were scanned at all").toBeGreaterThanOrEqual(8);
    const sites = files.flatMap((f) => errValues(readFileSync(join(SRC, f), "utf8"), f));
    /* ANTI-VACUITY: a scan that found no `err:` at all would pass this for the wrong reason for
       ever, and the engine alone writes dozens. */
    expect(sites.length, "the scan found no `err` channel anywhere — it is measuring nothing")
      .toBeGreaterThan(20);
    const bad = sites.flatMap((s) => STRINGIFIES
      .filter((rule) => rule.re.test(s.value))
      .map((rule) => `${s.file}: err: ${s.value} — ${rule.why}`));
    expect(bad, "a log site pre-stringified its thrown value").toEqual([]);
  });
});
