import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enforceMirrorOwner, MIRROR_OWNER_FILE, readMirrorBase, readMirrorOwner } from "../src/cloud-engine.js";
import { accountAnswer, accountIsForeign, decodeMirrorRecord, encodeMirrorRecord } from "../src/cloud-origin.js";

/**
 * ONE MIRROR, ONE ACCOUNT — AND ONE ACCOUNT IS AN ADDRESS **ON A SERVER**.
 *
 * The cloud mirror directory is keyed by MODE and never by account (`src-tauri/src/config.rs`), and
 * `ensureLocalWorld` reuses the single local `accounts` row for every address — so re-pointing the
 * cloud door at a different hosted address would otherwise reopen a database still holding the
 * previous account's mail and read it under the new session's account id — one account's window
 * showing another account's mail. {@link enforceMirrorOwner} is the guard: on a change of owner it
 * discards the cache whole — the hosted account is master and the mirror re-bootstraps clean.
 *
 * ── THE SERVER HALF, WHICH THE THIRD DOOR CREATED ─────────────────────────────────────────────
 *
 * With a self-hosted door the SAME ADDRESS can name two different accounts: `me@example.com` on the
 * hosted service and `me@example.com` on a server the operator runs are different people's rows in
 * different databases, spelled identically. An owner check that compared addresses alone read them
 * as the same owner and kept the mirror — the exact leak above, reached by moving a different
 * field. It also kept `cloud-tokens.seal`, so the next launch would have offered one server's
 * bearer token to the other machine.
 *
 * These assertions are behavioural, not structural: they set a mirror down on real disk and prove
 * the files the guard must remove are gone after an owner change and present after a matching
 * relaunch. Neuter the `rmSync` loop in `enforceMirrorOwner` and the "wipes a foreign mirror" case
 * goes red — the previous account's `pgdata` survives into the new account. Drop `|| serverChanged`
 * from the same function and the two SERVER cases go red while every address case stays green,
 * which is the point of keeping them separate.
 */

const HOSTED = "https://api.ohmail.app";
const OPERATOR = "https://ohmail.example.com/api";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-mirror-owner-"));
  dirs.push(d);
  return d;
}

/**
 * Lay down a plausible cloud mirror for `owner`: a populated pgdata, a cursor, a sealed session.
 *
 * `base` absent writes the LEGACY one-line marker — the shape every install written before the
 * server joined the record has on disk, and the shape the adoption case is about.
 */
function seedMirror(dir: string, owner: string, base?: string): void {
  mkdirSync(join(dir, "pgdata"), { recursive: true });
  writeFileSync(join(dir, "pgdata", "PG_VERSION"), "17\n");
  writeFileSync(join(dir, "cloud-cursor.json"), JSON.stringify({ sync: "abc" }));
  writeFileSync(join(dir, "cloud-tokens.seal"), "sealed-session-for-" + owner);
  writeFileSync(
    join(dir, MIRROR_OWNER_FILE),
    // The LEGACY shape when no base is given: a bare address, which is what every install written
    // before the server joined the record holds. Not `encodeMirrorRecord`, because a fixture built
    // from the code under test cannot show that the code reads what is actually on disk.
    base === undefined ? owner : JSON.stringify({ address: owner, base }),
  );
}

const mirrorExists = (dir: string): boolean =>
  existsSync(join(dir, "pgdata")) ||
  existsSync(join(dir, "cloud-cursor.json")) ||
  existsSync(join(dir, "cloud-tokens.seal"));

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("enforceMirrorOwner", () => {
  it("adopts an empty directory as the served account and writes the marker", () => {
    const dir = tempDir();
    const foreign = enforceMirrorOwner(dir, "first@account.example", HOSTED);
    expect(foreign).toBe(false);
    expect(readMirrorOwner(dir)).toBe("first@account.example");
    // BOTH facts, from the very first launch — the record is never written half-complete.
    expect(readMirrorBase(dir)).toBe(HOSTED);
  });

  it("leaves a matching mirror untouched on an ordinary relaunch", () => {
    const dir = tempDir();
    seedMirror(dir, "mila@account.example", HOSTED);
    const foreign = enforceMirrorOwner(dir, "mila@account.example", HOSTED);
    expect(foreign).toBe(false);
    // Every part of the cache survives — a relaunch must never cost a re-bootstrap.
    expect(existsSync(join(dir, "pgdata", "PG_VERSION"))).toBe(true);
    expect(existsSync(join(dir, "cloud-cursor.json"))).toBe(true);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(true);
    expect(readMirrorOwner(dir)).toBe("mila@account.example");
  });

  it("DISCARDS a mirror built for a different account, cursor and sealed session included", () => {
    const dir = tempDir();
    // A mirror bootstrapped for one account, then the door re-pointed at another — the leak's shape.
    seedMirror(dir, "previous@account.example", HOSTED);
    const events: string[] = [];
    const foreign = enforceMirrorOwner(dir, "different@account.example", HOSTED, (e) => events.push(e));
    expect(foreign).toBe(true);
    // The previous account's mail, cursor and session are gone — nothing of it can render.
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
    expect(existsSync(join(dir, "cloud-cursor.json"))).toBe(false);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(false);
    // The marker now names the account actually being served.
    expect(readMirrorOwner(dir)).toBe("different@account.example");
    expect(events).toContain("cloud_mirror_reset_on_owner_change");
  });

  it("does not wipe on a cosmetic difference — owner is compared case- and space-insensitively", () => {
    const dir = tempDir();
    seedMirror(dir, "mila@account.example", HOSTED);
    const foreign = enforceMirrorOwner(dir, "  Mila@Account.Example  ", HOSTED);
    expect(foreign).toBe(false);
    expect(mirrorExists(dir)).toBe(true);
    expect(readMirrorOwner(dir)).toBe("mila@account.example");
  });

  /**
   * ── THE SERVER HALF ─────────────────────────────────────────────────────────────────────────
   */

  it("DISCARDS a mirror whose SERVER changed, even though the address is identical", () => {
    const dir = tempDir();
    // The install was mirroring this address on the hosted service…
    seedMirror(dir, "me@example.com", HOSTED);
    const events: string[] = [];
    // …and is now pointed at an address that is the same STRING on somebody else's machine.
    const foreign = enforceMirrorOwner(dir, "me@example.com", OPERATOR, (e) => events.push(e));
    expect(foreign).toBe(true);
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
    expect(existsSync(join(dir, "cloud-cursor.json"))).toBe(false);
    expect(events).toContain("cloud_mirror_reset_on_owner_change");
    expect(readMirrorBase(dir)).toBe(OPERATOR);
  });

  it("takes the SEALED SESSION with it: one server's bearer never reaches another server", () => {
    const dir = tempDir();
    seedMirror(dir, "me@example.com", HOSTED);
    // The seal holds a token minted by the hosted service. The next launch dials the operator's
    // machine, and a seal that survived would be sent there with the first request.
    enforceMirrorOwner(dir, "me@example.com", OPERATOR);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(false);
  });

  it("keeps a pre-upgrade mirror when the server is still the hosted one", () => {
    const dir = tempDir();
    // Every install that predates the server half has exactly this on disk: one line, an address.
    seedMirror(dir, "mila@account.example");
    const foreign = enforceMirrorOwner(dir, "mila@account.example", HOSTED);
    // The recorded server is absent, and absent means "the one server older builds could dial",
    // which is the one being served. Nothing is foreign, so a working, fully-synced mailbox
    // survives the first launch after an update.
    expect(foreign).toBe(false);
    expect(existsSync(join(dir, "pgdata", "PG_VERSION"))).toBe(true);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(true);
    // …and the record is rewritten complete.
    expect(readMirrorBase(dir)).toBe(HOSTED);
  });

  /**
   * ── THE MIGRATION-LAUNCH LEAK, WHICH THE FIRST VERSION OF THIS FILE SHIPPED ─────────────────
   *
   * `null` was read as "cannot compare, so not a change of server" — `credentialIsForeign`'s
   * one-sided default, applied where it does not belong. A credential whose host was never recorded
   * is genuinely unknown; a Cloud mirror written by an earlier build is not, because the address was
   * a constant in the shell and there was no way to configure another.
   *
   * So the sequence below was the one launch the adoption rule was supposed to protect, and it
   * handed the hosted session to whichever server the door was pointed at. Reverse
   * `mirrorIsForeign` to compare against `record.base` and this case goes red with the seal still on disk.
   */
  it("DISCARDS a pre-upgrade mirror the moment the door is pointed at another server", () => {
    const dir = tempDir();
    // An existing install: a hosted mirror, a session minted by the hosted service, and the
    // one-line marker every build before the self-hosted door wrote.
    seedMirror(dir, "victim@example.com");
    expect(readMirrorBase(dir)).toBeNull();

    // The person updates and immediately points the door at another server, at the same address.
    const foreign = enforceMirrorOwner(dir, "victim@example.com", OPERATOR);

    expect(foreign).toBe(true);
    // The hosted session is gone BEFORE the new server is dialled for anything. Without this it
    // would be sent there in an Authorization header on the first mirrored request, and a 401 from
    // that server would collect the refresh token too.
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(false);
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
    expect(readMirrorBase(dir)).toBe(OPERATOR);
  });

  it("does not wipe on a cosmetic difference in the SERVER either", () => {
    const dir = tempDir();
    seedMirror(dir, "me@example.com", "https://ohmail.example.com/api");
    // A trailing slash and a spelled-out default port are the SAME URL by the standard's own
    // definition. A discard here would cost a full re-bootstrap for a character.
    const foreign = enforceMirrorOwner(dir, "me@example.com", "https://OHMAIL.example.com:443/api/");
    expect(foreign).toBe(false);
    expect(mirrorExists(dir)).toBe(true);
  });

  /**
   * THE FRAMING MUST NOT DEPEND ON THE VALUES.
   *
   * The record was two lines. Both fields arrive from the engine's environment, and an environment
   * variable may contain a line break — one in the ADDRESS pushed the real base off the line the
   * reader looked at, so the server read as ABSENT, and an absent server is adopted. That is the
   * one answer that silently switches this whole protection off, reached by a character.
   */
  /**
   * ── THE SAME LEAK, ONE STEP FURTHER OUT: A PROFILE WITH NO MARKER AT ALL ────────────────────
   *
   * The seal predates the marker in this repository's own history, so a Cloud profile holding
   * `cloud-tokens.seal` and `pgdata` with NO `mirror-owner` is a real upgrade state. Gating the
   * server comparison on the record existing meant that profile reported no change of anything,
   * kept its seal, and had the hosted bearer activated against whatever server the door was pointed
   * at. Found by the second review round, after the one-line case was fixed.
   */
  it("DISCARDS a profile that has STATE but no marker at all when the server changes", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "pgdata", "PG_VERSION"), "17\n");
    writeFileSync(join(dir, "cloud-tokens.seal"), "a-session-minted-by-the-hosted-service");
    expect(existsSync(join(dir, MIRROR_OWNER_FILE))).toBe(false);

    const foreign = enforceMirrorOwner(dir, "victim@example.com", OPERATOR);

    expect(foreign).toBe(true);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(false);
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
  });

  it("still adopts a genuinely EMPTY directory — there is nothing to lose", () => {
    const dir = tempDir();
    // No marker AND no state: a fresh install. Wiping nothing, comparing nothing.
    expect(enforceMirrorOwner(dir, "new@example.com", OPERATOR)).toBe(false);
    expect(readMirrorBase(dir)).toBe(OPERATOR);
  });

  it("records a server even when the ADDRESS contains a line break", () => {
    const dir = tempDir();
    const awkward = "me@example.com\nhttps://api.ohmail.app";
    enforceMirrorOwner(dir, awkward, OPERATOR);
    // The server is recorded, so the NEXT launch can still see a change of server.
    expect(readMirrorBase(dir)).toBe(OPERATOR);
    // …and it DOES see one. A mirror and a session have to exist for there to be anything to
    // discard, so they are put there: with an empty directory the honest answer is "nothing to
    // lose", which is what the case above pins.
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "cloud-tokens.seal"), "a-session-minted-by-the-operator's-server");
    expect(enforceMirrorOwner(dir, awkward, HOSTED)).toBe(true);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(false);
  });

  /**
   * ── AND THE MIRROR IMAGE OF THE MIGRATION FIX, WHICH THAT FIX CREATED ───────────────────────
   *
   * Reading "no recorded server" as the hosted service is right for a record an OLD build wrote —
   * it could dial nothing else. It is wrong for a record a NEW build wrote and left without one,
   * because that build CAN dial anything: its holder could have been a self-hosted server, and
   * relabelling it managed would activate that server's session against ours. Raised by the third
   * review round, against the second round's fix.
   *
   * The two are told apart by SHAPE — legacy records are a bare address, modern ones are JSON — and
   * a modern record naming no server is foreign to everything while there is state to protect.
   */
  it("DISCARDS when a MODERN record names no server — its owner cannot be established", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "cloud-tokens.seal"), "a-session-minted-by-somebody's-own-server");
    // The JSON shape, with the server missing: a build that records servers failed to record one.
    writeFileSync(join(dir, MIRROR_OWNER_FILE), JSON.stringify({ address: "me@example.com", base: null }));

    // Launching against the HOSTED service at the same address must not adopt that seal.
    expect(enforceMirrorOwner(dir, "me@example.com", HOSTED)).toBe(true);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(false);
  });

  /**
   * A NON-EMPTY STRING THAT IS NOT A BASE is the same fact as a missing one — nobody can say which
   * server the state belongs to — and it was the one spelling that slipped through, because
   * `baseIsForeign` answers "not foreign" when either side fails to normalise. That default is
   * right for a comparison and wrong as the last word. Found by the fourth review round.
   */
  it("DISCARDS when a modern record's server is a string that does not parse", () => {
    for (const base of ["garbage", "ohmail.example.com", "://x", "ftp://h.example"]) {
      const dir = tempDir();
      writeFileSync(join(dir, "cloud-tokens.seal"), "a-session-of-unestablishable-provenance");
      writeFileSync(join(dir, MIRROR_OWNER_FILE), JSON.stringify({ address: "me@example.com", base }));
      expect(enforceMirrorOwner(dir, "me@example.com", HOSTED), base).toBe(true);
      expect(existsSync(join(dir, "cloud-tokens.seal")), base).toBe(false);
    }
  });

  it("DISCARDS when a modern record's server is not a string at all", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "cloud-tokens.seal"), "a-session-of-unknown-provenance");
    writeFileSync(join(dir, MIRROR_OWNER_FILE), JSON.stringify({ address: "me@example.com", base: 42 }));
    expect(enforceMirrorOwner(dir, "me@example.com", HOSTED)).toBe(true);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(false);
  });

  it("but a LEGACY record with no server is still the hosted one, and survives", () => {
    const dir = tempDir();
    // The shape distinction is the whole mechanism: same missing server, opposite answer, because
    // this one was written by a build that could reach only the hosted service.
    seedMirror(dir, "mila@account.example");
    expect(enforceMirrorOwner(dir, "mila@account.example", HOSTED)).toBe(false);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(true);
  });

  it("records NO server when the configured base is not a URL, rather than a raw string", () => {
    const dir = tempDir();
    enforceMirrorOwner(dir, "mila@account.example", "not-a-url");
    // "We cannot say" — `baseIsForeign`'s one-sided default — and never an arbitrary string that
    // no comparison could ever use.
    expect(readMirrorBase(dir)).toBeNull();
    expect(readMirrorOwner(dir)).toBe("mila@account.example");
  });

  it("keeps an EMPTY marker unmatched — a torn write is never read as agreement", () => {
    const dir = tempDir();
    seedMirror(dir, "mila@account.example", HOSTED);
    // A crash between the discard and the rewrite leaves the file present and empty. An owner that
    // cannot be established must never match the one being served.
    writeFileSync(join(dir, MIRROR_OWNER_FILE), "");
    expect(readMirrorOwner(dir)).toBe("");
    const foreign = enforceMirrorOwner(dir, "mila@account.example", HOSTED);
    expect(foreign).toBe(true);
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
  });
});

/**
 * THE PAIRED DOOR HAS NO ADDRESS, AND THAT MUST NOT COST IT ITS MIRROR.
 *
 * A pairing link names a COMPUTER, not a mailbox: which mailboxes the install reads is the host's
 * answer to the redeem, and nothing knows it when the door is written. So this door is configured
 * with `address: null`, and the address half of the comparison has nothing to compare.
 *
 * The failure this pins is the one that would have shipped: `sameOwner("")` matches nothing, so a
 * door recorded with an empty address disagrees with itself on the very next launch and the mirror
 * is thrown away — every relaunch, for ever, looking exactly like a sync that will not settle.
 *
 * What still protects this door is the SERVER half, untouched: `cloudUrl` is the host's own origin
 * and is unique per machine. The account the pairing redeem records is the third guard and the only
 * one that can see a host reinstalled at the same address.
 */
describe("enforceMirrorOwner — a door configured with no address", () => {
  it("KEEPS a paired mirror across a relaunch, and records the absence as null", () => {
    const dir = tempDir();
    // First launch: nothing here yet, so the door is adopted and the record written.
    expect(enforceMirrorOwner(dir, null, "https://desk.tail1234.ts.net")).toBe(false);
    expect(decodeMirrorRecord(readFileSync(join(dir, MIRROR_OWNER_FILE), "utf8")).address).toBeNull();

    // Now it holds mail. THE RELAUNCH IS THE CASE: same door, same absent address.
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "pgdata", "PG_VERSION"), "17\n");
    writeFileSync(join(dir, "cloud-cursor.json"), JSON.stringify({ sync: "abc" }));
    writeFileSync(join(dir, "cloud-tokens.seal"), "sealed-session-for-the-paired-host");

    expect(enforceMirrorOwner(dir, null, "https://desk.tail1234.ts.net")).toBe(false);
    expect(mirrorExists(dir), "a relaunch of the paired door threw its own mirror away").toBe(true);
  });

  it("still discards when the paired door is re-pointed at a DIFFERENT computer", () => {
    // The address half is silent here, so this is the guard that is actually load-bearing for this
    // door. Without it, pointing an install at a second machine would read that machine's mail
    // through the first one's database.
    const dir = tempDir();
    enforceMirrorOwner(dir, null, "https://desk-one.tail1234.ts.net");
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "pgdata", "PG_VERSION"), "17\n");
    writeFileSync(join(dir, "cloud-tokens.seal"), "sealed-for-desk-one");

    expect(enforceMirrorOwner(dir, null, "https://desk-two.tail1234.ts.net")).toBe(true);
    expect(mirrorExists(dir), "the previous computer's mirror survived a change of computer").toBe(false);
  });

  it("does not adopt a mirror that names an address just because THIS launch names none", () => {
    /* THE OTHER DIRECTION, and the one a careless "skip when either side is absent" would open: a
       hosted mirror is on disk, and a launch with no address must not read the absence as
       agreement and inherit somebody's mail. The comparison is skipped, and the SERVER half is
       what refuses — which is why this is a change of base rather than of address. */
    const dir = tempDir();
    seedMirror(dir, "someone@ohmail.app", "https://api.ohmail.app");

    expect(enforceMirrorOwner(dir, null, "https://desk.tail1234.ts.net")).toBe(true);
    expect(mirrorExists(dir), "a hosted mirror survived a relaunch as a paired door").toBe(false);
  });

  it("a recorded address is preserved for a door that still carries one", () => {
    // The ordinary hosted case, asserted beside the new one so "null is written" cannot quietly
    // become "null is always written".
    const dir = tempDir();
    enforceMirrorOwner(dir, "someone@ohmail.app", "https://api.ohmail.app");
    expect(readMirrorOwner(dir)).toBe("someone@ohmail.app");
    expect(readMirrorBase(dir)).toBe("https://api.ohmail.app");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  AN ABSENT ACCOUNT HEADER IS NOT A MATCH — three answers where there were two
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * An optional value's `null` collapsed "not answered yet" and "the same", on an isolation
 * boundary: a directory whose mail is bound to an account was paired with a host that named
 * none, the check answered "not foreign", and this install served one world's session over
 * another world's mail. Nothing RECORDED still admits — there is nothing to disagree with, and
 * refusing would make a composition that names no accounts unpairable for ever.
 *
 * WATCH THEM FAIL: return `"admitted"` from the `named` arm → the unnamed case reddens, which is
 * the defect; return `"unnamed"` from the `recorded` arm above it → the first-pairing case
 * reddens and every such install is refused.
 */
describe("accountAnswer — the three things two ids can say", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("ADMITS a match, verbatim", () => {
    expect(accountAnswer(A, A)).toBe("admitted");
    expect(accountIsForeign(A, A)).toBe(false);
  });

  it("REFUSES a different id — the reinstalled host neither address nor base can see", () => {
    expect(accountAnswer(A, B)).toBe("mismatch");
    expect(accountIsForeign(A, B)).toBe(true);
  });

  it("REFUSES an ABSENT answer over a recorded binding — absence is not a match", () => {
    /* Every shape an absence arrives in. A blank string is one of them: the record's own decoder
       trims, so "the field was there and empty" reaches here as "". */
    for (const named of [null, undefined, ""]) {
      expect(accountAnswer(A, named), "an absent account header was read as agreement")
        .toBe("unnamed");
      expect(accountIsForeign(A, named)).toBe(true);
    }
  });

  it("POSITIVE CONTROL — nothing RECORDED has nothing to disagree with", () => {
    /* A record predating the field, and a first pairing against a host that names no accounts.
       Refusing here would make both unpairable, which is the opposite defect. */
    for (const recorded of [null, undefined, ""]) {
      expect(accountAnswer(recorded, B)).toBe("admitted");
      expect(accountAnswer(recorded, null)).toBe("admitted");
      expect(accountIsForeign(recorded, B)).toBe(false);
    }
  });
});

/**
 * A REVOKED SESSION'S OWED REMOVAL, in the record: only the exact boolean, omitted when false, so
 * every record without it is byte-identical to what earlier builds wrote, and the shell's reader
 * of `erased` is unaffected.
 */
describe("the record's revoked flag", () => {
  it("is written only when set, and read only as the exact boolean", () => {
    expect(encodeMirrorRecord("me@ohmail.test", HOSTED, null)).toBe(`{"address":"me@ohmail.test","base":"${HOSTED}","account":null}`);
    const set = encodeMirrorRecord("me@ohmail.test", HOSTED, null, false, false, true);
    expect(set).toBe(`{"address":"me@ohmail.test","base":"${HOSTED}","account":null,"revoked":true}`);
    expect(decodeMirrorRecord(set)).toMatchObject({ revoked: true, erased: false, discardPending: false });
    for (const near of ['"true"', "1", "null"]) {
      expect(decodeMirrorRecord(`{"address":"me@ohmail.test","base":"${HOSTED}","revoked":${near}}`).revoked, near).toBe(false);
    }
    expect(decodeMirrorRecord("me@ohmail.test").revoked, "a legacy record").toBe(false);
  });
});

/**
 * THE COPY A REVOKED SESSION STILL OWES goes before the database opens: when the record says so (a
 * run that removed the mail and stopped short of its files), or when the kept refusal is a revoke and
 * no seal stands beside it (a crash before the discard, an older build that heard it). Once: the
 * database the launch makes is the next launch's. The seal, the window's changes and the record's
 * address stay.
 */
describe("enforceMirrorOwner — the copy a revoked session owes", () => {
  const REFUSED = "cloud-session-refused.json";
  const OUTBOX = "window-outbox.0123456789abcdef01234567.json";
  const refused = (dir: string, code: string): void =>
    writeFileSync(join(dir, REFUSED), JSON.stringify({ code, since: new Date().toISOString() }));
  const holdsCopy = (dir: string): boolean =>
    existsSync(join(dir, "pgdata", "PG_VERSION")) || existsSync(join(dir, "cloud-cursor.json"));

  it("the record's flag: the database and the cursor go; the seal, the window's changes and the address stay", () => {
    const dir = tempDir();
    seedMirror(dir, "me@ohmail.test", HOSTED);
    writeFileSync(join(dir, MIRROR_OWNER_FILE), encodeMirrorRecord("me@ohmail.test", HOSTED, null, false, false, true));
    writeFileSync(join(dir, OUTBOX), "{}");
    expect(enforceMirrorOwner(dir, "me@ohmail.test", HOSTED), "not a change of owner").toBe(false);
    expect(holdsCopy(dir), "the copy outlived the launch").toBe(false);
    expect(existsSync(join(dir, "cloud-tokens.seal"))).toBe(true);
    expect(existsSync(join(dir, OUTBOX))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, MIRROR_OWNER_FILE), "utf8"))).toEqual({ address: "me@ohmail.test", base: HOSTED, account: null });
  });

  it("a kept revoke with no seal: the copy goes, and the launch after keeps the database the first made", () => {
    const dir = tempDir();
    seedMirror(dir, "me@ohmail.test", HOSTED);
    rmSync(join(dir, "cloud-tokens.seal"));
    refused(dir, "refresh_revoked");
    enforceMirrorOwner(dir, "me@ohmail.test", HOSTED);
    expect(holdsCopy(dir), "an older build's revoke left the copy").toBe(false);
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "pgdata", "PG_VERSION"), "17\n");
    enforceMirrorOwner(dir, "me@ohmail.test", HOSTED);
    expect(existsSync(join(dir, "pgdata", "PG_VERSION")), "removed again at the next launch").toBe(true);
    expect(JSON.parse(readFileSync(join(dir, REFUSED), "utf8")), "the sign-in no longer says why").toMatchObject({ code: "refresh_revoked" });
  });

  it("CONTROL — a revoke beside a seal (a later sign-in), a lapse and the legacy code keep the copy", () => {
    for (const [code, sealed] of [["refresh_revoked", true], ["refresh_expired", false], ["unauthorized", false]] as const) {
      const dir = tempDir();
      seedMirror(dir, "me@ohmail.test", HOSTED);
      if (!sealed) rmSync(join(dir, "cloud-tokens.seal"));
      refused(dir, code);
      enforceMirrorOwner(dir, "me@ohmail.test", HOSTED);
      expect(holdsCopy(dir), `${code}${sealed ? " beside a seal" : ""}`).toBe(true);
    }
  });
});
