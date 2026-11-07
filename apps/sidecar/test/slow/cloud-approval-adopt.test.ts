import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, readMirrorOwner, type CloudSidecar } from "../../src/cloud-engine.js";
import { approvalServer, FIXTURE_MAILBOX, FIXTURE_MESSAGE, type ApprovalServer } from "../../../desktop/test/fixtures/approval-server.js";
import { freshDataDir } from "../_datadir.js";

/**
 * THE FIRST CLOUD DOOR WITH NO ADDRESS, through the engine against a fake ohmail Cloud answering
 * the five approval routes. A fresh data directory boots identity-pending; the browser confirms;
 * the claim ADOPTS the account the hosted session names — it creates the door file once, records
 * the mirror's owner and seals the session — and the engine relaunched behind that door owns the
 * directory and runs the first drain. Nothing here types an address: the relaunch reads it from
 * the file the claim wrote. The refusals: another account's directory, a door chosen during the
 * wait, a denied and an expired request.
 */

const BASE = "https://cloud.test";
const KEKS = { 1: Buffer.alloc(32, 7) };

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Install { dataDir: string; doorFile: string }
async function install(): Promise<Install> {
  const dataDir = await freshDataDir("ohmail-adopt-");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-adopt-root-"));
  dirs.push(dataDir, root);
  return { dataDir, doorFile: join(root, "config.json") };
}

async function pending(at: Install, server: ApprovalServer): Promise<CloudSidecar> {
  const s = await createCloudSidecar({
    dataDir: at.dataDir, cloudUrl: BASE, handoffBase: BASE, address: null,
    identityPending: { doorFile: at.doorFile }, keks: KEKS, fetchImpl: server.fetchImpl, pollIntervalMs: 3_600_000,
  });
  sidecars.push(s);
  return s;
}

async function addressed(at: Install, server: ApprovalServer, address: string): Promise<CloudSidecar> {
  const s = await createCloudSidecar({
    dataDir: at.dataDir, cloudUrl: BASE, handoffBase: BASE, address, keks: KEKS,
    fetchImpl: server.fetchImpl, pollIntervalMs: 3_600_000,
  });
  sidecars.push(s);
  return s;
}

const call = (s: CloudSidecar, path: string, body?: unknown): Promise<Response> =>
  s.handle(new Request(`http://sidecar${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
const health = async (s: CloudSidecar): Promise<Record<string, unknown>> =>
  (await (await s.handle(new Request("http://sidecar/health"))).json()) as Record<string, unknown>;
const codeOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

/** Ask, have the browser read and confirm (or not), and poll once — the window's loop, once. */
async function askAndConfirm(s: CloudSidecar, server: ApprovalServer, confirm = true): Promise<{ id: string; claim: Response }> {
  const started = await call(s, "/cloud/signin/approval", {});
  expect(started.status, await started.clone().text()).toBe(200);
  const { approvalId: id } = (await started.json()) as { approvalId: string };
  expect((await call(s, "/cloud/signin", { approval: true })).status).toBe(202);
  expect((await server.read(id)).status).toBe(200);
  if (confirm) expect((await server.confirm(id)).status).toBe(200);
  return { id, claim: await call(s, "/cloud/signin", { approval: true }) };
}

describe("the pending door adopts its account at the first claim", () => {
  it("a fresh data dir: the claim writes the door and its owner, the relaunch owns it and drains", async () => {
    const at = await install();
    const server = approvalServer(BASE);
    const first = await pending(at, server);
    expect(await health(first)).toMatchObject({ identityPending: true, adopted: false, signedIn: false });
    expect(existsSync(at.doorFile)).toBe(false);

    const { claim } = await askAndConfirm(first, server);
    const confirmedAt = Date.now();
    expect(claim.status, await claim.clone().text()).toBe(200);
    expect(await claim.json()).toMatchObject({ status: "signed_in", adopted: true, address: server.browser });

    // The door the CLAIM wrote, in the shape the shell reads, naming the account the session named.
    const door = JSON.parse(readFileSync(at.doorFile, "utf8")) as { mode: string; cloudUrl: string; address: string };
    expect(door).toEqual({ mode: "cloud", cloudUrl: BASE, address: server.browser });
    expect(readMirrorOwner(at.dataDir)).toBe(server.browser);
    expect(existsSync(join(at.dataDir, "cloud-tokens.seal"))).toBe(true);
    expect(await health(first)).toMatchObject({ identityPending: false, adopted: true });

    // THE RELAUNCH, as the shell performs it: the address is read from the file, never typed.
    await first.stop();
    sidecars.splice(sidecars.indexOf(first), 1);
    const relaunched = await addressed(at, server, door.address);
    expect(relaunched.signedIn()).toBe(true);
    // An empty store serves no mailbox until the account's list names it: a minted one is retired.
    expect(relaunched.servedMailboxId()).toBe("");
    expect(await health(relaunched)).toMatchObject({ mode: "cloud", signedIn: true, identityPending: false });
    expect(readMirrorOwner(at.dataDir)).toBe(server.browser);
    await relaunched.start();
    expect(relaunched.servedMailboxId()).toBe(FIXTURE_MAILBOX);
    const mail = await call(relaunched, `/messages/${FIXTURE_MESSAGE}`);
    const firstMailMs = Date.now() - confirmedAt;
    expect(mail.status, await mail.clone().text()).toBe(200);
    // The figure the report names: the confirm to the first message readable, engine side, with the
    // window's poll (≤ 2 s at the server's cadence) on top.
    console.info(`FIXTURE confirm->first-mail engine side: ${firstMailMs} ms`);
  }, 60_000);

  it("a second claim into a directory another account owns refuses by name and writes nothing", async () => {
    const at = await install();
    const server = approvalServer(BASE, "first@ohmail.test");
    // A directory the first account signed in to once, then signed out of (the door file gone).
    const earlier = await pending(at, server);
    expect((await askAndConfirm(earlier, server)).claim.status).toBe(200);
    await earlier.stop();
    sidecars.splice(sidecars.indexOf(earlier), 1);
    rmSync(at.doorFile);
    rmSync(join(at.dataDir, "cloud-tokens.seal"));

    server.browser = "second@ohmail.test";
    const again = await pending(at, server);
    const { claim } = await askAndConfirm(again, server);
    expect(claim.status).toBe(409);
    expect(await codeOf(claim)).toBe("mirror_owner_mismatch");
    expect(existsSync(at.doorFile), "a refused claim wrote a door").toBe(false);
    expect(existsSync(join(at.dataDir, "cloud-tokens.seal")), "a refused claim sealed a session").toBe(false);
    expect(readMirrorOwner(at.dataDir)).toBe("first@ohmail.test");

    // The control: the account that owns the directory is admitted and gets its door back.
    server.browser = "first@ohmail.test";
    const back = await askAndConfirm(again, server);
    expect(back.claim.status, await back.claim.clone().text()).toBe(200);
    expect(JSON.parse(readFileSync(at.doorFile, "utf8")).address).toBe("first@ohmail.test");
  }, 60_000);

  it("once adopted, the same process refuses another account's claim", async () => {
    const at = await install();
    const server = approvalServer(BASE, "first@ohmail.test");
    const s = await pending(at, server);
    expect((await askAndConfirm(s, server)).claim.status).toBe(200);
    server.browser = "second@ohmail.test";
    const { claim } = await askAndConfirm(s, server);
    expect(await codeOf(claim)).toBe("mirror_owner_mismatch");
    expect(JSON.parse(readFileSync(at.doorFile, "utf8")).address).toBe("first@ohmail.test");
  }, 60_000);

  it("a door chosen during the wait wins: the claim refuses and seals nothing", async () => {
    const at = await install();
    const server = approvalServer(BASE);
    const s = await pending(at, server);
    const chosen = JSON.stringify({ mode: "local", imap: { host: "imap.example.test", user: "someone" } });
    writeFileSync(at.doorFile, chosen);
    const { claim } = await askAndConfirm(s, server);
    expect(claim.status).toBe(409);
    expect(await codeOf(claim)).toBe("door_changed");
    expect(readFileSync(at.doorFile, "utf8")).toBe(chosen);
    expect(existsSync(join(at.dataDir, "cloud-tokens.seal"))).toBe(false);
  }, 60_000);

  it("a denied and an expired request each end with their code, and no door is written", async () => {
    const at = await install();
    const server = approvalServer(BASE);
    const s = await pending(at, server);

    const started = (await (await call(s, "/cloud/signin/approval", {})).json()) as { approvalId: string };
    expect((await server.deny(started.approvalId)).status).toBe(200);
    const denied = await call(s, "/cloud/signin", { approval: true });
    expect(denied.status).toBe(410);
    expect(await codeOf(denied)).toBe("approval_denied");

    const again = (await (await call(s, "/cloud/signin/approval", {})).json()) as { approvalId: string };
    server.expire(again.approvalId);
    const expired = await call(s, "/cloud/signin", { approval: true });
    expect(expired.status).toBe(410);
    expect(await codeOf(expired)).toBe("approval_expired");
    expect(existsSync(at.doorFile)).toBe(false);
  }, 60_000);

  it("a pending launch holds no session, even with a seal left on disk", async () => {
    const at = await install();
    const server = approvalServer(BASE);
    const earlier = await pending(at, server);
    expect((await askAndConfirm(earlier, server)).claim.status).toBe(200);
    await earlier.stop();
    sidecars.splice(sidecars.indexOf(earlier), 1);
    rmSync(at.doorFile);
    const s = await pending(at, server);
    expect(s.signedIn()).toBe(false);
    expect(await health(s)).toMatchObject({ identityPending: true, signedIn: false });
  }, 60_000);

  it("a pending launch is refused without a key, and a pairing code is refused on it", async () => {
    const at = await install();
    const server = approvalServer(BASE);
    await expect(createCloudSidecar({
      dataDir: at.dataDir, cloudUrl: BASE, handoffBase: BASE, address: null,
      identityPending: { doorFile: at.doorFile }, fetchImpl: server.fetchImpl, pollIntervalMs: 3_600_000,
    })).rejects.toThrow(/OHMAIL_KEK/);
    const s = await pending(at, server);
    const paired = await call(s, "/cloud/pair-redeem", { token: "x" });
    expect(paired.status).toBe(409);
    expect(await codeOf(paired)).toBe("identity_pending");
  }, 60_000);
});
