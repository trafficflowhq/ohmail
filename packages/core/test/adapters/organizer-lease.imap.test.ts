import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter, WATCHED_FOLDERS } from "../../src/adapters/imap.js";
import {
  DEFAULT_STALE_AFTER_MS,
  META_FOLDER,
  answerLeasePeek,
  formatClaim,
  parseClaim,
  runLeaseGate,
  type LeaseSelf,
  type OrganizerClaim,
  type TakeoverAuthorization,
} from "../../src/adapters/organizer-lease.js";
import { greenmailConfig, eml } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * THE BITING TEST — `ORGANIZER-LEASE-RESUME.md` §3.5, against a real IMAP server.
 *
 * Two organizer "worlds": two independently constructed adapters and gates with distinct install
 * ids, against ONE GreenMail mailbox. Each world's organize step is instrumented and does real
 * work, so what is asserted is what is on the server rather than what a mock was told.
 *
 * GreenMail and not PGlite, deliberately: this is protocol behaviour — APPEND, EXPUNGE, the
 * hierarchy delimiter, and whether a folder is subscribed — and PGlite green has meant nothing
 * for three production bugs in this repository.
 *
 * The negative control is IN THIS FILE and is the reason the rest of it is evidence. Without it,
 * "exactly one organizer" cannot be told apart from an assertion that never had two organizers to
 * begin with.
 */

type Cfg = ReturnType<typeof greenmailConfig>;

async function rawClient(cfg: Cfg): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

/** One organizer: its own login, its own adapter, its own identity. */
interface World {
  adapter: ImapAdapter;
  self: LeaseSelf;
  /** How many times this world's organize step actually ran. */
  organized: number;
  /** Set when this world's move lost a race with another organizer. */
  moveError: string | null;
}

async function makeWorld(cfg: Cfg, installId: string, kind: "local" | "cloud" | "mobile"): Promise<World> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  await adapter.ensureFolders(FIXTURE_DOOR);
  return {
    adapter,
    self: { installId, kind, displayName: `${installId}'s machine`, lastNonce: null },
    organized: 0,
    moveError: null,
  };
}

/**
 * One gated cycle: read the lease, and organize ONLY if it says so.
 *
 * The source LOCATOR is resolved by the CALLER, before either world acts, because that is how two organizers
 * actually collide: both poll INBOX, both see the same new message, and both then act on it.
 * Resolving it inside the cycle would model them as strictly sequential, and a strictly
 * sequential pair never fights — which would make the negative control below prove nothing.
 *
 * `bypassGate` is the control's ONLY difference from the real path.
 */
async function gatedCycle(
  world: World,
  now: Date,
  opts: { bypassGate?: boolean; takeover?: TakeoverAuthorization; ref: string; dest: string },
): Promise<string> {
  let verdict = "organize";
  if (!opts.bypassGate) {
    const res = await runLeaseGate({
      capabilities: [],
      io: world.adapter.leaseIo(TEST_META_ID),
      self: world.self,
      now,
      ...(opts.takeover ? { takeover: opts.takeover } : {}),
    });
    verdict = res.verdict.verdict;
    world.self = { ...world.self, lastNonce: res.nonce };
    if (verdict !== "organize") return verdict;
  }
  world.organized++;
  try {
    await world.adapter.move({ folder: "INBOX", ref: opts.ref }, opts.dest, FIXTURE_DOOR);
  } catch (err) {
    world.moveError = `${(err as Error).name}|${(err as Error).message}`;
  }
  return verdict;
}

/**
 * The locator a real cycle would hold for this message: `<uidValidity>:<uid>`, BOTH HALVES READ
 * FROM THE SERVER. This returned the bare UID and the caller pasted it into `` `1:${uid}` ``,
 * which is an epoch GreenMail never issued (it stamps the container's start time), so both
 * organizers' moves died in `assertLocatorEpoch` and the file could not tell a lease refusal
 * from a locator the adapter would have refused anyway.
 */
async function findRef(cfg: Cfg, serverPath: string, messageId: string): Promise<string> {
  const c = await rawClient(cfg);
  try {
    const lock = await c.getMailboxLock(serverPath);
    try {
      const found = await c.search({ header: { "message-id": messageId } }, { uid: true });
      if (!Array.isArray(found) || found.length === 0) throw new Error(`${messageId} not found in ${serverPath}`);
      const epoch = c.mailbox && c.mailbox.uidValidity != null ? String(c.mailbox.uidValidity) : "0";
      return `${epoch}:${Math.max(...found)}`;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/** Count messages carrying this Message-ID in a folder, read by an INDEPENDENT client. */
async function countIn(cfg: Cfg, serverPath: string, messageId: string): Promise<number> {
  const c = await rawClient(cfg);
  try {
    const lock = await c.getMailboxLock(serverPath);
    try {
      const found = await c.search({ header: { "message-id": messageId } }, { uid: true });
      return Array.isArray(found) ? found.length : 0;
    } catch {
      return 0;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function seedInbox(cfg: Cfg, messageId: string): Promise<void> {
  const c = await rawClient(cfg);
  try {
    await c.append("INBOX", eml({ from: "stranger@example.com", subject: "first contact", messageId }));
  } finally {
    await c.logout();
  }
}

async function listFolders(cfg: Cfg): Promise<Array<{ path: string; subscribed?: boolean }>> {
  const c = await rawClient(cfg);
  try {
    return (await c.list()).map((f) => ({ path: f.path, subscribed: f.subscribed }));
  } finally {
    await c.logout();
  }
}

/**
 * THIS FILE'S CLOCK IS THE REAL ONE, and against a REAL server it has to be.
 *
 * It was a fixed literal, which made every install in here weeks behind GreenMail's own clock —
 * and the gate now reads that pair (the claim's heartbeat against its INTERNALDATE) to refuse an
 * install whose clock is wrong. Three cases that renew TWICE therefore refused with "this
 * computer's clock is 39 days behind the mail server's", correctly: a fixed literal beside a live
 * server is exactly the writer the check exists to stop.
 *
 * So the base instant is now, and every offset below stays relative to it — which is what the
 * cases were ever about. A literal is still right for the memory-server files, where the fake
 * stamps the record's own heartbeat and the two clocks agree by construction.
 */
const NOW = new Date();
const STALE_LATER = new Date(NOW.getTime() + DEFAULT_STALE_AFTER_MS + 60_000);

// Two installs' sessions on GreenMail per case, no wait of its own: 0.8-2.8 s each on the CI VMs.
describe("the organizer lease, against GreenMail", { timeout: 30_000 }, () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });
  const track = (w: World): World => {
    open.push(w.adapter);
    return w;
  };

  it("creates ohmail/_meta unsubscribed, under the server's own delimiter", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "solo", "local"));
    await runLeaseGate({ capabilities: [], io: w.adapter.leaseIo(TEST_META_ID), self: w.self, now: NOW });

    const folders = await listFolders(cfg);
    // GreenMail's delimiter is `.`, so a lease that spelled the folder literally would have made
    // a TOP-LEVEL folder called `ohmail/_meta` that the other install never finds.
    const meta = folders.find((f) => f.path === "ohmail._meta");
    expect(meta, `no ohmail._meta among ${folders.map((f) => f.path).join(", ")}`).toBeDefined();
    expect(meta!.subscribed).toBeFalsy();
    expect(folders.some((f) => f.path === "ohmail/_meta")).toBe(false);
  });

  /**
   * The claim messages must not be ingested as mail. `WATCHED_FOLDERS` is the input to
   * `changesSince`, so a watched `_meta` would classify and file the lease's own bookkeeping.
   */
  it("produces zero changes for its own claim messages", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "solo", "local"));
    await runLeaseGate({ capabilities: [], io: w.adapter.leaseIo(TEST_META_ID), self: w.self, now: NOW });

    const batch = await w.adapter.changesSince({ folders: {} });
    const everything = [...batch.creates, ...batch.moves, ...batch.flagChanges, ...batch.deletes];
    expect(everything).toHaveLength(0);
    expect(Object.keys(batch.newCursor.folders)).not.toContain(META_FOLDER);
    expect(WATCHED_FOLDERS as readonly string[]).not.toContain(META_FOLDER);
  });

  /**
   * THE INVARIANT: exactly one active organizer per mailbox.
   *
   * Two worlds, one mailbox, one message. The loser must refuse STRUCTURALLY — its organize
   * callback never runs, a counter that stays at 0 — rather than its move happening to fail.
   */
  it("lets exactly one of two local installs organize, and the loser never runs", async () => {
    const cfg = greenmailConfig();
    const a = track(await makeWorld(cfg, "aaa-install", "local"));
    const b = track(await makeWorld(cfg, "bbb-install", "local"));
    await seedInbox(cfg, "one-decision@x");
    // Both organizers see the same new message, as two live pollers would.
    const ref = await findRef(cfg, "INBOX", "one-decision@x");

    // A claims first, so A is the incumbent.
    const va = await gatedCycle(a, NOW, { ref, dest: "ohmail/Screener" });
    const vb = await gatedCycle(b, new Date(NOW.getTime() + 1_000), { ref, dest: "ohmail/News" });

    expect(va).toBe("organize");
    expect(vb).toBe("stand_down");
    expect(a.organized).toBe(1);
    expect(b.organized).toBe(0); // structural refusal: the callback never ran
    expect(a.moveError).toBeNull();

    // …and the server agrees. One move, into A's destination and not B's.
    expect(await countIn(cfg, "ohmail.Screener", "one-decision@x")).toBe(1);
    expect(await countIn(cfg, "ohmail.News", "one-decision@x")).toBe(0);
    expect(await countIn(cfg, "INBOX", "one-decision@x")).toBe(0);
  });

  /**
   * THE NEGATIVE CONTROL, in the same file and against the same server.
   *
   * The identical scenario with the gate bypassed produces TWO decisions on one message. Without
   * this, the assertion above cannot be distinguished from a scenario that never had two
   * organizers in it. This repository has already shipped a guard that printed a violation and
   * reported success in the same run.
   */
  it("NEGATIVE CONTROL: with the gate bypassed, both installs decide the same message", async () => {
    const cfg = greenmailConfig();
    const a = track(await makeWorld(cfg, "aaa-install", "local"));
    const b = track(await makeWorld(cfg, "bbb-install", "local"));
    await seedInbox(cfg, "two-decisions@x");
    const ref = await findRef(cfg, "INBOX", "two-decisions@x");

    await gatedCycle(a, NOW, { bypassGate: true, ref, dest: "ohmail/Screener" });
    await gatedCycle(b, NOW, { bypassGate: true, ref, dest: "ohmail/News" });

    // TWO routing decisions about ONE message — the thing the gate makes impossible.
    expect(a.organized).toBe(1);
    expect(b.organized).toBe(1);
    expect(a.organized + b.organized).toBe(2);

    // And the collision is visible ON THE SERVER, not only in the counters: the first organizer
    // filed the message, and the second went looking for it in an INBOX it had already left.
    // That is the concrete shape of the defect — a second engine issuing competing moves against
    // a folder tree the first one is already changing.
    expect(a.moveError).toBeNull();
    // `ImapAdapter.move`'s source check, verbatim — the second organizer reached for a UID that
    // the first had already moved out from under it. Asserted on the exact string rather than on
    // "some error", because "the move failed" is also what a broken test looks like.
    /* Both halves of this string were stale and both came from that change, which made the epoch
     * guard unconditional AND gave the error a `name` — and could not run this file, because
     * nothing had a mail server. `Error|` was the class before it was named; `INBOX#1:1` was a
     * locator with a fabricated epoch. The locator is now built from the ref this test actually
     * moved, so it stays an EXACT string (a broken test still fails here) without pretending to
     * know a UIDVALIDITY the server chooses. */
    expect(b.moveError).toBe(`MessageGoneError|message not at source locator INBOX#${ref}`);
    expect(await countIn(cfg, "ohmail.Screener", "two-decisions@x")).toBe(1);
  });

  /** A live Cloud outranks a local install for CONTINUING coverage — §4. */
  it("stands a local install down for a fresh cloud claim", async () => {
    const cfg = greenmailConfig();
    const local = track(await makeWorld(cfg, "this-mac", "local"));
    const cloud = track(await makeWorld(cfg, "cloud-eu-1", "cloud"));

    await runLeaseGate({ capabilities: [], io: cloud.adapter.leaseIo(TEST_META_ID), self: cloud.self, now: NOW });
    const res = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: new Date(NOW.getTime() + 1_000) });

    expect(res.verdict).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:cloud" });
    // The UI row `ohmail on <machine> organizes this mailbox` needs the name, so it travels.
    expect((res.verdict as { by: { displayName: string } }).by.displayName).toBe("cloud-eu-1's machine");
  });

  /**
   * TAKEOVER, THEN STAND-DOWN — §4's "Local mailbox added to Cloud". Adding it to Cloud IS the
   * explicit human action, so the connect flow informs and proceeds; the desktop stands down on
   * its next cycle.
   */
  it("an authorized cloud takeover stands the incumbent local install down on its next cycle", async () => {
    const cfg = greenmailConfig();
    const local = track(await makeWorld(cfg, "this-mac", "local"));
    const cloud = track(await makeWorld(cfg, "cloud-eu-1", "cloud"));

    const first = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: NOW });
    expect(first.verdict.verdict).toBe("organize");
    local.self = { ...local.self, lastNonce: first.nonce };

    const seized = await runLeaseGate({
      capabilities: [],
      io: cloud.adapter.leaseIo(TEST_META_ID), self: cloud.self, now: new Date(NOW.getTime() + 1_000), takeover: { authorizedAt: NOW, intent: "takeover" },
    });
    expect(seized.verdict.verdict).toBe("organize");

    const after = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: new Date(NOW.getTime() + 2_000) });
    expect(after.verdict).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:cloud" });
  });

  /**
   * NO SEIZE-BACK. The same sequence WITHOUT authorization must not let Cloud resume over a
   * mailbox somebody deliberately moved local. This is the arm that keeps determination from
   * becoming a billing side effect.
   */
  it("an UNAUTHORIZED cloud attempt stands down instead, and the local install keeps organizing", async () => {
    const cfg = greenmailConfig();
    const local = track(await makeWorld(cfg, "this-mac", "local"));
    const cloud = track(await makeWorld(cfg, "cloud-eu-1", "cloud"));

    const first = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: NOW });
    local.self = { ...local.self, lastNonce: first.nonce };

    const refused = await runLeaseGate({ capabilities: [], io: cloud.adapter.leaseIo(TEST_META_ID), self: cloud.self, now: new Date(NOW.getTime() + 1_000) });
    expect(refused.verdict).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:local" });

    const still = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: new Date(NOW.getTime() + 2_000) });
    expect(still.verdict.verdict).toBe("organize");
  });

  /**
   * A STAND-DOWN RELEASES. Otherwise the winner waits out the whole staleness window before its
   * own gate is clean, and a released claim is what makes "Cloud lapsed" legible to a desktop.
   */
  it("expunges the loser's own claim from the server when it stands down", async () => {
    const cfg = greenmailConfig();
    const local = track(await makeWorld(cfg, "this-mac", "local"));
    const cloud = track(await makeWorld(cfg, "cloud-eu-1", "cloud"));

    const mine = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: NOW });
    local.self = { ...local.self, lastNonce: mine.nonce };
    await runLeaseGate({ capabilities: [], io: cloud.adapter.leaseIo(TEST_META_ID), self: cloud.self, now: new Date(NOW.getTime() + 1_000), takeover: { authorizedAt: NOW, intent: "takeover" } });
    await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: new Date(NOW.getTime() + 2_000) });

    const claims = await local.adapter.leaseIo(TEST_META_ID).listClaims();
    const ids = claims.map((c) => /X-Ohmail-Install-Id:\s*(\S+)/i.exec(c.raw)?.[1]);
    expect(ids).not.toContain("this-mac");
    expect(ids).toContain("cloud-eu-1");
  });

  /**
   * CLOUD LAPSES ⇒ `available`, NEVER auto-resume. §4: a forgotten install on an office machine
   * must not silently become the thing that moves somebody's mail because a billing event fired.
   */
  it("reports available — not organize — once a cloud claim has gone stale", async () => {
    const cfg = greenmailConfig();
    const cloud = track(await makeWorld(cfg, "cloud-eu-1", "cloud"));
    const local = track(await makeWorld(cfg, "this-mac", "local"));

    await runLeaseGate({ capabilities: [], io: cloud.adapter.leaseIo(TEST_META_ID), self: cloud.self, now: NOW });
    const res = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: STALE_LATER });

    expect(res.verdict.verdict).toBe("available");
    expect(res.nonce).toBeNull();
    // Nothing was written: `available` is a report, not a claim.
    const claims = await local.adapter.leaseIo(TEST_META_ID).listClaims();
    expect(claims.map((c) => /X-Ohmail-Install-Id:\s*(\S+)/i.exec(c.raw)?.[1])).not.toContain("this-mac");
  });

  it("converts that to organize when the user explicitly asks", async () => {
    const cfg = greenmailConfig();
    const cloud = track(await makeWorld(cfg, "cloud-eu-1", "cloud"));
    const local = track(await makeWorld(cfg, "this-mac", "local"));

    await runLeaseGate({ capabilities: [], io: cloud.adapter.leaseIo(TEST_META_ID), self: cloud.self, now: NOW });
    const res = await runLeaseGate({ capabilities: [], io: local.adapter.leaseIo(TEST_META_ID), self: local.self, now: STALE_LATER, takeover: { authorizedAt: NOW, intent: "takeover" } });
    expect(res.verdict.verdict).toBe("organize");
  });

  /** Own-role resumption: a restart re-claims its own stale lease with no ceremony. §4. */
  it("resumes its own stale claim after a restart", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "this-mac", "local"));
    await runLeaseGate({ capabilities: [], io: w.adapter.leaseIo(TEST_META_ID), self: w.self, now: NOW });

    // A restart: the process forgets its nonce, and only its nonce.
    const restarted: LeaseSelf = { ...w.self, lastNonce: null };
    const res = await runLeaseGate({ capabilities: [], io: w.adapter.leaseIo(TEST_META_ID), self: restarted, now: STALE_LATER });
    expect(res.verdict.verdict).toBe("organize");
  });

  /**
   * §3.3 — a crash between the append and the expunge leaves TWO of our own claims. Readers
   * coalesce to the newest heartbeat, and the next renew cleans the extras up.
   */
  it("tolerates a duplicate own claim left by a crash mid-renew, and cleans it up", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "this-mac", "local"));
    const io = w.adapter.leaseIo(TEST_META_ID);
    await io.ensureMetaFolder();

    for (const heartbeat of [new Date(NOW.getTime() - 5_000), new Date(NOW.getTime() - 1_000)]) {
      await io.appendClaim(formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "this-mac", kind: "local", displayName: "This Mac",
        heartbeat, claimedAt: new Date(NOW.getTime() - 600_000), nonce: "crashed",
      }));
    }
    expect(await io.listClaims()).toHaveLength(2);

    const res = await runLeaseGate({ capabilities: [], io, self: w.self, now: NOW });
    expect(res.verdict.verdict).toBe("organize");
    // Both stale copies removed, exactly one fresh claim left.
    const after = await io.listClaims();
    expect(after).toHaveLength(1);
    expect(after[0]!.raw).toContain(`X-Ohmail-Nonce: ${res.nonce!}`);
  });

  /**
   * ── A CLAIM THIS BUILD CANNOT RANK, AGAINST A REAL FOLDER: REFUSED WHILE LIVE, YIELDING ONCE
   *    STALE ────────────────────────────────────────────────────────────────────────────────────
   *
   * `decideLease`'s rules 1 and 2 refuse a press — including an authorized one — while a claim in a
   * format this release cannot rank is live. `ORGANIZER-LEASE-RESUME.md` and
   * `PHONE-SQLITE-RULING.md` §1.4 bound that refusal the same way: until the claim is stale or
   * released. The decision table pins the boundary in
   * `organizer-lease-lone-claim.test.ts`; what THIS pair adds is the two things a pure decision
   * test cannot reach, and both are about the mailbox rather than about the function:
   *
   *   · the claim is a REAL message that went through `formatClaim` onto a real server and came
   *     back through `parseClaim` off a real FETCH, so the kind header a later release writes is
   *     folded to `unknown` by the shipped parse rather than by a fixture's own spelling;
   *   · the record's FATE is observed — still in `ohmail/_meta` after the refusal, and gone after
   *     the takeover. A verdict of `organize` whose displacement missed the record it beat leaves
   *     two claims in the folder, which is the two-organizer state wearing a green assertion.
   *
   * The kind written here is `tablet`, which no release writes yet. It used to be `mobile`, a
   * standalone phone's — and mail 0103 made `mobile` a member of this release's set, so the fixture
   * stopped having the property under test: a control is chosen from a subject that HAS it.
   * `organizer-lease-lone-claim.test.ts` moved the same fixture for the same reason. The cast is
   * the position a newer install is genuinely in: `ClaimInput.kind` is this release's closed set.
   */
  const futureClaimRaw = (heartbeat: Date): string => formatClaim({
    authorizedAt: null, capabilities: [],
    installId: "future-install", kind: "tablet", displayName: "Something newer",
    heartbeat, claimedAt: new Date(NOW.getTime() - 2 * DEFAULT_STALE_AFTER_MS), nonce: "n-future",
  } as unknown as Parameters<typeof formatClaim>[0]);

  /** Every claim in `_meta`, read back through the shipped parse. */
  const claimsIn = async (w: World): Promise<OrganizerClaim[]> =>
    (await w.adapter.leaseIo(TEST_META_ID).listClaims())
      .map((m) => parseClaim(m.raw, m.ref))
      .filter((c): c is OrganizerClaim => c !== null && !("malformed" in c));

  it("refuses an authorized press while an unrankable live claim is the only record", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "this-mac", "local"));
    const io = w.adapter.leaseIo(TEST_META_ID);
    await io.ensureMetaFolder();
    await io.appendClaim(futureClaimRaw(new Date(NOW.getTime() - 5_000)));

    // THE PREMISE, off a real FETCH rather than a fixture's own spelling: without the parser's
    // fold there is no unrankable claim here at all, and this case would be about an ordinary
    // holder that an authorized press is entitled to displace.
    expect((await claimsIn(w)).map((c) => c.kind),
      "the record must arrive as a kind this build cannot place").toEqual(["unknown"]);

    const res = await runLeaseGate({
      capabilities: [], io, self: w.self, now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" },
    });

    expect(res.verdict.verdict).toBe("stand_down");
    expect(res.verdict.verdict === "stand_down" ? res.verdict.reason : null)
      .toBe("organized_elsewhere:unknown");
    // The record we cannot read is untouched, and ours was never appended: no authorization
    // expunges a claim in a format we cannot rank, and the gate did not claim beside it.
    const after = await claimsIn(w);
    expect(after.map((c) => c.installId)).toEqual(["future-install"]);
  });

  it("lets the press through once that same claim has gone stale, and takes the record out", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "this-mac", "local"));
    const io = w.adapter.leaseIo(TEST_META_ID);
    await io.ensureMetaFolder();
    await io.appendClaim(futureClaimRaw(new Date(NOW.getTime() - 5_000)));

    // The phone stopped: nothing renews the record, and the reader's clock moves past the window.
    const res = await runLeaseGate({
      capabilities: [], io, self: w.self, now: STALE_LATER, takeover: { authorizedAt: STALE_LATER, intent: "takeover" },
    });

    expect(res.verdict.verdict).toBe("organize");
    // EXACTLY ONE claim, and it is ours. Two would be two organizers; zero would mean the renew
    // never landed and the next reader would see an unclaimed mailbox.
    const after = await claimsIn(w);
    expect(after.map((c) => c.installId)).toEqual(["this-mac"]);
    expect(after[0]!.nonce).toBe(res.nonce);
  });

  /**
   * A stray message in `_meta` — a human dragged something in, or a future meta record type — is
   * not a claim and must not make a mailbox look contended.
   */
  it("ignores a non-claim message sitting in the meta folder", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "this-mac", "local"));
    const io = w.adapter.leaseIo(TEST_META_ID);
    await io.ensureMetaFolder();

    const c = await rawClient(cfg);
    try {
      await c.append("ohmail._meta", eml({ from: "a@b.c", subject: "dragged here by hand", messageId: "stray@x" }));
    } finally {
      await c.logout();
    }

    const res = await runLeaseGate({ capabilities: [], io, self: w.self, now: NOW });
    expect(res.verdict.verdict).toBe("organize");
  });
});


/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PEEK'S THREE ANSWERS, THROUGH A REAL `ImapAdapter` — not a double of one
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `LEASE-PEEK-ENGINE-ADAPTER-BLIND`'s own sentence: *"the guard has to be the ENGINE's adapter and
 * not a fresh one, because a fresh one already passes — a test that builds its own adapter would go
 * green over this defect."* The unit cases beside these drive doubles, which is where the three
 * answers are DECIDED; these drive the accessor a real adapter hands out, against a real server,
 * so `free` and `held` are facts about IMAP rather than about a fixture.
 *
 * The `unreadable` arm is NOT here and cannot be: GreenMail cannot be made hostile, and an adapter
 * that dialled a real server always has the accessor. Its two reachable shapes — the missing
 * accessor and a refused FETCH — are proved at the fake-server seam, which is the same split every
 * bounds guard in this package makes.
 */
describe("the peek's three answers, through a real adapter", () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });
  const track = (w: World): World => { open.push(w.adapter); return w; };

  it("answers `free` for a mailbox nobody has ever organized — no folder, no claim", async () => {
    /* And the folder is NOT created by looking. A reader that created `ohmail/_meta` to answer a
       question about it would change the answer for the next reader from "no folder" to "empty
       folder", so the absence is asserted on the server after the peek. */
    const cfg = greenmailConfig();
    const adapter = new ImapAdapter(cfg);
    open.push(adapter);
    await adapter.connect();
    const answered = await answerLeasePeek({ io: adapter.leasePeekIo(), now: new Date() });
    expect(answered.answer).toBe("free");
    const folders = await listFolders(cfg);
    expect(folders.some((f) => f.path === "ohmail._meta"), "the peek created the folder").toBe(false);
  });

  it("answers `free` once the folder exists and holds no live claim", async () => {
    const cfg = greenmailConfig();
    const w = track(await makeWorld(cfg, "solo-peek-free", "local"));
    await w.adapter.leaseIo(TEST_META_ID).ensureMetaFolder();
    const answered = await answerLeasePeek({ io: w.adapter.leasePeekIo(), now: new Date() });
    expect(answered.answer).toBe("free");
  });

  it("answers `held` and NAMES the machine while a claim is being renewed", async () => {
    /* A second adapter against the SAME mailbox, which is the shape a phone beside a laptop has.
       The claim is written by a real gate through a real APPEND, and read back by the OTHER
       adapter's own read-only accessor. */
    const cfg = greenmailConfig();
    const holder = track(await makeWorld(cfg, "the-laptop", "local"));
    const res = await runLeaseGate({
      capabilities: [], io: holder.adapter.leaseIo(TEST_META_ID), self: holder.self, now: new Date(),
    });
    expect(res.verdict.verdict, "the premise is an install that took the mailbox").toBe("organize");

    const onlooker = track(await makeWorld(cfg, "the-phone", "mobile"));
    const answered = await answerLeasePeek({ io: onlooker.adapter.leasePeekIo(), now: new Date() });
    expect(answered.answer, "a live claim on the server read as a free mailbox").toBe("held");
    if (answered.answer !== "held") throw new Error("unreachable");
    expect(answered.holder.installId).toBe("the-laptop");
    expect(answered.holder.fresh).toBe(true);
  });

  it("answers `free` again once the holder's claim has aged out — the positive control", async () => {
    /* Without this the `held` case is satisfied by an answer that never says `free` about a folder
       with anything in it, and a person could never take back a mailbox their own dead machine
       last claimed. Same folder, same records; only the CLOCK the peek is asked at moves. */
    const cfg = greenmailConfig();
    const holder = track(await makeWorld(cfg, "gone-machine", "local"));
    const at = new Date();
    await runLeaseGate({
      capabilities: [], io: holder.adapter.leaseIo(TEST_META_ID), self: holder.self, now: at,
    });
    const later = new Date(at.getTime() + DEFAULT_STALE_AFTER_MS * 4);
    const answered = await answerLeasePeek({ io: holder.adapter.leasePeekIo(), now: later });
    expect(answered.answer).toBe("free");
    if (answered.answer !== "free") throw new Error("unreachable");
    /* `stopped`, NOT `none` — the records are still there and somebody DID organize this mailbox.
       Reporting "nobody has ever organized this" about a folder with a claim in it is the
       dual-organizer bug wearing a UI. */
    expect(answered.peek.state).toBe("stopped");
  });
});
