import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCloudSidecar, readMirrorAccount, type CloudSidecar } from "../../src/cloud-engine.js";
import { decodeMirrorRecord, encodeMirrorRecord } from "../../src/cloud-origin.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { freshCloudDataDir } from "../_datadir.js";

/**
 * PAIRING WITH ANOTHER MACHINE'S DESKTOP — the third way a Cloud-mode install gets a session.
 *
 * The code is spent HERE, in the one process allowed to hold a credential for the configured
 * server, exactly where the hosted password is spent. What this file pins is the three things that
 * are NOT the sign-in's:
 *
 *  · the platform declaration is REQUIRED rather than preferred, because an absent one makes the
 *    other machine's Devices pane say "Web" about a desktop;
 *  · the account the host names is RECORDED, and a later answer naming a different one is refused
 *    — the reinstalled-host case, which neither the address comparison nor the base comparison can
 *    see because neither of those changed;
 *  · and a host that names NO account is not the same state as one naming a different account.
 */

const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADDRESS = "me@ohmail.test";
const MAILBOX = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* With the record a first launch at this server writes, or every boot discards the copied database. */
const freshDir = async (): Promise<string> => {
  const d = await freshCloudDataDir("ohmail-pair-redeem-", { address: ADDRESS, cloudUrl: "https://desk.test" });
  dirs.push(d);
  return d;
};
/**
 * ONE KEY RING PER DATA DIRECTORY, kept across relaunches — which is what a real install has.
 *
 * A fresh key per boot is the fixture defect this replaced, and it fails in a way that looks
 * exactly like the product being wrong: the sealed session is written correctly, survives the
 * discard correctly, and then cannot be OPENED, so the relaunch reports itself signed out. The
 * shell derives this install's key ring from the keychain once and hands the same one to every
 * launch; a test that minted a new one was asserting against a machine that forgets its own key.
 */
const keks = new Map<string, Record<number, Buffer>>();
const aKek = (dir: string): Record<number, Buffer> => {
  const existing = keks.get(dir);
  if (existing) return existing;
  const minted = { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) };
  keks.set(dir, minted);
  return minted;
};
const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

interface Host {
  fetchImpl: typeof fetch;
  /** What the host answers the redeem with. */
  redeem: { status: number; account: string | null; body?: unknown };
  /** Every redeem body the host received — the evidence for what was declared. */
  seen: Array<{ grant?: unknown; token?: unknown; kind?: unknown }>;
}

/** A desktop acting as a host: the pairing redeem, and just enough mirror surface to boot. */
function desktopHost(): Host {
  const redeem: Host["redeem"] = { status: 200, account: ACCOUNT_A };
  const seen: Host["seen"] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/pair/redeem") {
      seen.push(JSON.parse(String(init?.body ?? "{}")));
      if (redeem.status !== 200) {
        return json(redeem.body ?? { error: { code: "pairing_invalid", message: "no" } }, redeem.status);
      }
      /* THE HEADER IS THE HOST'S OWN ANSWER about which account the pair opens, exactly as the
         real route attaches it — and it is omitted, not blanked, when there is none. */
      return json(
        { grant: "device-pair", tokens: { accessToken: "access-1", refreshToken: "refresh-1" } },
        200,
        redeem.account === null ? {} : { "x-ohmail-account": redeem.account },
      );
    }
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox(MAILBOX, ADDRESS)]));
    if (url.pathname === "/sync") {
      return json({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "c1", hasMore: false, serverTime: new Date().toISOString(),
      });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, redeem, seen };
}

async function boot(dataDir: string, host: Host): Promise<CloudSidecar> {
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://desk.test",
    address: ADDRESS,
    keks: aKek(dataDir),
    fetchImpl: host.fetchImpl,
    pollIntervalMs: 3_600_000,
  });
  sidecars.push(sidecar);
  return sidecar;
}

/**
 * A DIRECTORY THAT HAS ALREADY PAIRED, written the way the redeem writes it.
 *
 * Seeded rather than produced by pairing twice, and the reason is not convenience: two sidecars
 * over one data directory means opening the same embedded database twice, which fails on the lock
 * rather than on anything under test — a red that says nothing about the account rule. Seeding is
 * also the shape being tested, because this is exactly what a RETURNING install finds on disk.
 *
 * It doubles as the carry-forward control: `enforceMirrorOwner` rewrites this record on every
 * launch, so a boot that dropped the field would leave `readMirrorAccount` null and every case
 * below would pass for the wrong reason.
 */
function seedPaired(dir: string, account: string): void {
  writeFileSync(join(dir, "mirror-owner"), encodeMirrorRecord(ADDRESS, "https://desk.test", account), { mode: 0o600 });
}

const pair = (s: CloudSidecar, token: string, startOver?: unknown): Promise<Response> =>
  s.handle(new Request("http://sidecar/cloud/pair-redeem", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.sessionToken}` },
    body: JSON.stringify(startOver === undefined ? { token } : { token, startOver }),
  }));

describe("POST /cloud/pair-redeem", () => {
  it("ADMITS a code, and the proof is a session where there was none", async () => {
    const host = desktopHost();
    const s = await boot(await freshDir(), host);
    expect(s.signedIn(), "the fixture started already signed in").toBe(false);

    const res = await pair(s, "tok-abc");

    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).status).toBe("paired");
    // THE EFFECT, not the answer: reads were `409 not_signed_in` a moment ago and are not now.
    expect(s.signedIn()).toBe(true);
  });

  it("DECLARES what kind of machine this is — an omitted kind makes the other pane say Web", async () => {
    const host = desktopHost();
    const s = await boot(await freshDir(), host);

    await pair(s, "tok-abc");

    expect(host.seen).toHaveLength(1);
    expect(host.seen[0]!.grant).toBe("device-pair");
    expect(host.seen[0]!.token).toBe("tok-abc");
    // FROM THE PROCESS, never from the body — the caller over the bridge names the code and
    // nothing about what this machine is.
    expect(String(host.seen[0]!.kind)).toMatch(/^desktop-(linux|macos|windows)$/);
  });

  it("RECORDS the account the host named, so a later answer can be compared with it", async () => {
    const host = desktopHost();
    const dir = await freshDir();
    const s = await boot(dir, host);

    await pair(s, "tok-abc");

    expect(readMirrorAccount(dir)).toBe(ACCOUNT_A);
    // …and the rest of the record is intact. A rewrite that composed only the new field would
    // drop the address and the base this directory was bootstrapped for.
    const raw = readFileSync(join(dir, "mirror-owner"), "utf8");
    const record = decodeMirrorRecord(raw);
    expect(record.address).toBe(ADDRESS);
    expect(record.base).toBe("https://desk.test");
  });

  it("REFUSES a host that names a DIFFERENT account, and seals nothing", async () => {
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);
    // THE CARRY-FORWARD CONTROL: the launch rewrites this record, and a rewrite that composed only
    // what the launch knows would drop the binding — every case below would then pass vacuously.
    expect(readMirrorAccount(dir), "the launch dropped the recorded account").toBe(ACCOUNT_A);

    // THE REINSTALLED HOST: same address, same base, new world. Neither of the two comparisons
    // that already exist can see this — which is why the account is recorded at all.
    host.redeem.account = ACCOUNT_B;
    const res = await pair(s, "tok-def");

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("pair_account_mismatch");
    expect(s.signedIn(), "a refused pairing left a live session").toBe(false);
    // THE BINDING IS UNCHANGED — a refused attempt must not re-point the directory at the world
    // it just refused.
    expect(readMirrorAccount(dir)).toBe(ACCOUNT_A);
  });

  it("names NEITHER account in the refusal", async () => {
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);

    host.redeem.account = ACCOUNT_B;
    const message = (await (await pair(s, "tok-def")).json()).error.message as string;

    // Somebody pairing with their own computer must not be told whose mail is on this one.
    expect(message).not.toContain(ACCOUNT_A);
    expect(message).not.toContain(ACCOUNT_B);
  });

  it("ADMITS the SAME account again — the binding is a comparison, not a one-shot", async () => {
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);

    const res = await pair(s, "tok-def");

    expect(res.status, await res.clone().text()).toBe(200);
    expect(s.signedIn()).toBe(true);
    expect(readMirrorAccount(dir)).toBe(ACCOUNT_A);
  });

  it("REFUSES a host that names NO account over a recorded binding, and says so", async () => {
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);

    /* AN ABSENT HEADER IS NOT A MATCH. It was admitted, because the check answered only on a
       positive disagreement — so a host that said nothing about the account got one world's
       session activated over another world's mail, which is the failure this binding exists for.
       Nobody can say whose this is, so it is refused, and the sentence names the thing that did
       not arrive rather than leaving somebody to guess at a 409. */
    host.redeem.account = null;
    const res = await pair(s, "tok-def");

    expect(res.status, await res.clone().text()).toBe(409);
    const err = (await res.json()).error as { code: string; message: string };
    expect(err.code).toBe("pair_account_unnamed");
    expect(err.message, "the refusal does not say what the other computer did not send")
      .toMatch(/did not say which account/);
    expect(err.message, "the refusal named an account").not.toContain(ACCOUNT_A);
    expect(s.signedIn(), "a refused pairing left a live session").toBe(false);
    /* AND THE BINDING IS UNCHANGED — a refused attempt must not re-point the directory, and
       stamping null over the recorded id would throw away the only thing that sees a
       reinstalled host. */
    expect(readMirrorAccount(dir), "a refused pairing erased the binding").toBe(ACCOUNT_A);
  });

  it("a FIRST pairing against a host that names no account records none, and still works", async () => {
    const host = desktopHost();
    host.redeem.account = null;
    const dir = await freshDir();
    const s = await boot(dir, host);

    const res = await pair(s, "tok-abc");

    expect(res.status, await res.clone().text()).toBe(200);
    expect(s.signedIn()).toBe(true);
    expect(readMirrorAccount(dir)).toBeNull();
  });

  it("refuses a second pairing while a session is already held", async () => {
    const host = desktopHost();
    const s = await boot(await freshDir(), host);
    await pair(s, "tok-abc");

    const again = await pair(s, "tok-def");
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("already_signed_in");
  });

  it("passes the host's own refusals through, and 409 is not a bad code", async () => {
    const host = desktopHost();
    const s = await boot(await freshDir(), host);

    host.redeem.status = 400;
    const bad = await pair(s, "tok-spent");
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("invalid_pair_code");
    expect(s.signedIn()).toBe(false);

    // A CROSS-ACCOUNT REFUSAL FROM THE HOST is its own answer: telling somebody to ask for a fresh
    // code would send them round a loop that cannot end, because the code was never the problem.
    host.redeem.status = 409;
    const conflict = await pair(s, "tok-other");
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("pair_refused");
  });

  it("a body with no code is a 400, not a redeem of the empty string", async () => {
    const host = desktopHost();
    const s = await boot(await freshDir(), host);

    const res = await s.handle(new Request("http://sidecar/cloud/pair-redeem", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.sessionToken}` },
      body: JSON.stringify({}),
    }));

    expect(res.status).toBe(400);
    expect(host.seen, "an absent code was sent to the host anyway").toHaveLength(0);
  });
});

/**
 * STARTING OVER — the way out of the account refusal, taken only on purpose.
 *
 * Without it the refusal is a dead end. The constructor discards a mirror on a change of ADDRESS or
 * of SERVER, and a host reinstalled at the same address changes neither, so an install refused once
 * would go on being refused with nothing a person could press.
 *
 * The discard is STAGED rather than performed: at the moment a redeem runs, `pgdata` is an open
 * embedded database and removing it under the process holding it corrupts that process. The
 * constructor already does the discard correctly, before anything is opened.
 */
describe("POST /cloud/pair-redeem — startOver", () => {
  it("stages the discard, keeps the new session, and asks for a relaunch", async () => {
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);
    host.redeem.account = ACCOUNT_B;

    const res = await pair(s, "tok-def", true);

    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.clone().json();
    expect(body.status).toBe("paired");
    // THE RELAUNCH IS THE POINT: the discard cannot happen in this process, so the answer says so
    // rather than pretending the mirror is already gone.
    expect(body.restartRequired).toBe(true);
    // NOTHING IS ACTIVATED. Reads stay refused until the relaunch, so there is no window in which
    // this session reaches the previous world's rows — the refusal is not weakened by the way out.
    expect(s.signedIn(), "a start-over pairing activated over the previous world's mirror").toBe(false);

    const record = decodeMirrorRecord(readFileSync(join(dir, "mirror-owner"), "utf8"));
    expect(record.discardPending).toBe(true);
    // The record already names the NEW world, so the relaunch binds to it rather than re-refusing.
    expect(record.account).toBe(ACCOUNT_B);
  });

  it("/health names the waiting-for-relaunch state, and does NOT call it an expired session", async () => {
    /* THE STATE A WINDOW HAS NO OTHER WAY TO NAME. Between a start-over's answer and the relaunch
       there is no session, and both readings a shell could otherwise reach are false statements
       about a pairing that just worked: `signedIn: false` alone is the pre-auth state, which
       renders the hosted PASSWORD FORM — asking for a Cloud password for an account that does not
       exist; and `sessionExpired` means the server ended the session, whose surface says this
       machine is no longer paired, the precise opposite of what happened.

       Raised by the window lane, which traced both renderings before either shipped. */
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);
    host.redeem.account = ACCOUNT_B;

    const before = await (await s.handle(new Request("http://sidecar/health"))).json();
    expect(before.restartRequired, "a fresh engine already claimed to need a relaunch").toBe(false);

    await pair(s, "tok-def", true);

    const after = await (await s.handle(new Request("http://sidecar/health"))).json();
    expect(after.signedIn).toBe(false);
    expect(after.restartRequired, "the waiting-for-relaunch state is indistinguishable from signed out").toBe(true);
    expect(after.sessionExpired, "a successful pairing was reported as an ended session").toBe(false);
  }, 90_000);

  it("an ORDINARY pairing never asks for a relaunch", async () => {
    // The control for the flag: it is set by one arm, and the arm everybody takes is not it.
    const host = desktopHost();
    const s = await boot(await freshDir(), host);
    await pair(s, "tok-abc");
    const health = await (await s.handle(new Request("http://sidecar/health"))).json();
    expect(health.signedIn).toBe(true);
    expect(health.restartRequired).toBe(false);
  }, 90_000);

  it("the session sealed by a start-over SURVIVES the discard it asked for", async () => {
    /* The asymmetry that makes this usable. A start-over has already spent a single-use pairing
       code and sealed what it bought; a discard that removed the seal would leave somebody at a
       sign-in screen holding a code that no longer works. */
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const first = await boot(dir, host);
    host.redeem.account = ACCOUNT_B;
    await pair(first, "tok-def", true);
    await first.stop();
    sidecars.length = 0;
    expect(existsSync(join(dir, "cloud-tokens.seal")), "the pairing sealed nothing").toBe(true);

    // THE RELAUNCH performs the staged discard.
    const second = await boot(dir, host);

    // The previous world's mail is gone, the new world's credential is not, and the flag is
    // cleared — a staged discard that survived its own launch would wipe the mirror on every
    // launch afterwards, which is a mailbox that never finishes syncing and no message saying why.
    expect(existsSync(join(dir, "cloud-cursor.json")), "the previous world's cursor survived").toBe(false);
    expect(existsSync(join(dir, "cloud-tokens.seal")), "the newly paired session was discarded").toBe(true);
    const record = decodeMirrorRecord(readFileSync(join(dir, "mirror-owner"), "utf8"));
    expect(record.discardPending).toBe(false);
    expect(record.account, "the relaunch un-bound the account the pairing had just bound").toBe(ACCOUNT_B);
    expect(second.signedIn(), "the relaunch did not resume the newly paired session").toBe(true);
    }, 90_000);

  it("REFUSES an ordinary redeem during the pending window, before the token is spent", async () => {
    /* THE HOLE THE ACCOUNT COMPARISON CANNOT SEE, and the reason this control exists at all.
       A start-over stamps the record with the NEW account, so from that moment `accountIsForeign`
       compares B against B and answers no. An ordinary redeem in that window therefore fell
       straight through to `activate()` — and served B's session over A's `pgdata`, which is still
       on disk because the discard has not run yet. Every other guard in this file was looking
       somewhere else. Found by review, not by me. */
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);

    // Stage the discard: B's world is now named in the record, A's mail is still on the disk.
    host.redeem.account = ACCOUNT_B;
    expect((await pair(s, "tok-def", true)).status).toBe(200);
    const cursor = join(dir, "cloud-cursor.json");
    writeFileSync(cursor, JSON.stringify({ sync: "account-A" }));
    const spentBefore = host.seen.length;

    // …and now the ordinary pairing that used to be admitted.
    const res = await pair(s, "tok-ghi");

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("restart_required");
    // NOTHING ACTIVATED — this is the assertion that matters, because a session here is a session
    // dispatching through the local account id over the previous world's rows.
    expect(s.signedIn(), "an ordinary redeem activated over the previous account's mirror").toBe(false);
    // A'S DATA IS UNTOUCHED: the discard has not run, so what the relaunch will remove is still here.
    expect(existsSync(cursor), "the previous account's cursor was removed early").toBe(true);
    expect(existsSync(join(dir, "pgdata")), "the previous account's database was removed early").toBe(true);
    // AND THE TOKEN WAS NOT SPENT. Refusing after the redeem would burn a single-use code to say
    // "restart", leaving somebody needing a fresh one from the other machine to do what they were
    // already doing. Zero new requests reached the host.
    expect(host.seen.length - spentBefore, "the pairing code was spent on a refusal").toBe(0);
  }, 90_000);

  it("a startOver is still admitted during its own window — re-stamping is a no-op", async () => {
    // The exemption, and why it is not a hole: a start-over is not asking to JOIN this directory's
    // world, it is asking to replace it, and the record already says so. Refusing it would trap
    // somebody who pressed the button twice.
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);
    host.redeem.account = ACCOUNT_B;
    expect((await pair(s, "tok-def", true)).status).toBe(200);

    const cursor = join(dir, "cloud-cursor.json");
    writeFileSync(cursor, JSON.stringify({ sync: "account-A" }));

    const again = await pair(s, "tok-ghi", true);

    expect(again.status, await again.clone().text()).toBe(200);
    expect((await again.clone().json()).restartRequired).toBe(true);
    expect(decodeMirrorRecord(readFileSync(join(dir, "mirror-owner"), "utf8")).account).toBe(ACCOUNT_B);
    /* AND NOTHING WAS ACTIVATED, which is what the hole actually was rather than a missing field.
       `accountIsForeign` compares the RECORD against the answer, and the first start-over already
       wrote B there — so a second press compared B against B, answered no, missed the staging arm
       and fell through to seal-and-activate over the PREVIOUS world's database, which is still on
       disk because the discard has not run. A test that asserted only the 200 would have passed
       while that shipped. */
    expect(s.signedIn(), "a second start-over activated over the previous account's mirror").toBe(false);
    expect(existsSync(cursor), "the previous account's cursor was removed early").toBe(true);
    expect(existsSync(join(dir, "pgdata")), "the previous account's database was removed early").toBe(true);
  }, 90_000);

  it("REFUSES without startOver — the way out is never inferred from the mismatch", async () => {
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);
    host.redeem.account = ACCOUNT_B;

    const res = await pair(s, "tok-def");

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("pair_account_mismatch");
    expect(decodeMirrorRecord(readFileSync(join(dir, "mirror-owner"), "utf8")).discardPending).toBe(false);
  });

  it("a truthy value that is not the boolean does NOT discard anything", async () => {
    // This flag deletes mail. A string, a number, or the word "false" arriving from a caller that
    // meant nothing by it must not select the branch that throws a mailbox away.
    for (const value of ["true", 1, {}, "false"]) {
      const host = desktopHost();
      const dir = await freshDir();
      seedPaired(dir, ACCOUNT_A);
      const s = await boot(dir, host);
      host.redeem.account = ACCOUNT_B;

      const res = await pair(s, "tok-def", value);

      expect(res.status, `startOver: ${JSON.stringify(value)} was taken as a yes`).toBe(409);
      expect(decodeMirrorRecord(readFileSync(join(dir, "mirror-owner"), "utf8")).discardPending).toBe(false);
      await s.stop();
      sidecars.length = 0;
    }
  }, 90_000);

  it("startOver on a matching account is an ordinary pairing, and discards nothing", async () => {
    // The flag says "this may be a different world", not "throw my mail away". When the account
    // agrees there is nothing foreign here, and a mirror the person is still using must survive.
    const host = desktopHost();
    const dir = await freshDir();
    seedPaired(dir, ACCOUNT_A);
    const s = await boot(dir, host);

    const res = await pair(s, "tok-def", true);

    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.clone().json()).restartRequired).toBeUndefined();
    expect(s.signedIn()).toBe(true);
    expect(decodeMirrorRecord(readFileSync(join(dir, "mirror-owner"), "utf8")).discardPending).toBe(false);
  });
});

describe("the directory every case here boots on", () => {
  it("a never-paired directory on the same server keeps its database across the launch", async () => {
    const dir = await freshDir();
    const before = statSync(join(dir, "pgdata", "PG_VERSION")).ino;
    await boot(dir, desktopHost());
    expect(statSync(join(dir, "pgdata", "PG_VERSION")).ino,
      "the launch discarded the copied database and ran initdb").toBe(before);
  });
});
