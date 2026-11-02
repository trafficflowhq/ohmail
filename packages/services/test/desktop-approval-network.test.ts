import { describe, it, expect } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { loginTokens } from "@trafficflow/db/cloud";
import { AuthService, makeTestAuthDeps, StaticKeyProvider, type ServiceContext } from "../src/index.js";

/**
 * The approval read says whether the computer asked from the address of the browser reading it.
 * The request keeps its class to show and a keyed digest of its address (over IPv6, its /64); the
 * read answers one word, `same`, `different` or `unknown`, and nothing of the reader's address or
 * class goes back. A class missing on either side is `unknown`, never `different`; two families differ.
 */

const NOW = new Date("2026-07-27T00:00:00.000Z");
const DESKTOP = "203.0.113.77"; // stored as 203.0.x.x

type Harness = {
  svc: AuthService; db: Awaited<ReturnType<typeof makeTestDb>>;
  ctx: (over?: Partial<ServiceContext>) => ServiceContext;
};

async function harness(): Promise<Harness> {
  const db = await makeTestDb();
  const svc = new AuthService(makeTestAuthDeps());
  const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
    db, accountId: "", userId: null, now: () => NOW, requestId: "r", ip: "", ...over,
  });
  return { svc, db, ctx };
}

const rowOf = async (h: Harness, id: string) =>
  (await h.db.select().from(loginTokens).where(eq(loginTokens.id, id)))[0]!;

/** A desktop's request made from `ip`. The read never spends the challenge, so any valid one does. */
async function asked(h: Harness, ip: string): Promise<string> {
  const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
  const { approvalId } = await h.svc.issueDesktopApproval(
    h.ctx({ ip }), { challenge, kind: "desktop-linux", label: "studio-mac" },
  );
  return approvalId;
}

/** A signed-in browser reading the request from `ip`. */
const readFrom = (h: Harness, id: string, ip: string) =>
  h.svc.readDesktopApproval(h.ctx({ userId: randomUUID(), accountId: randomUUID(), ip }), id);

describe("the approval read compares the two networks on the server", () => {
  it("a browser in another IPv4 /16 reads different", async () => {
    const h = await harness();
    const id = await asked(h, DESKTOP);
    expect(await readFrom(h, id, "198.51.100.9")).toHaveProperty("network", "different");
  });

  it("a browser elsewhere in the same /16 reads different; only the request's own address reads same", async () => {
    const h = await harness();
    const id = await asked(h, DESKTOP);
    expect(await readFrom(h, id, "203.0.7.1")).toHaveProperty("network", "different");
    expect(await readFrom(h, id, DESKTOP)).toHaveProperty("network", "same");
  });

  it("an IPv4-mapped IPv6 browser address is read as the IPv4 it carries", async () => {
    const h = await harness();
    const id = await asked(h, DESKTOP);
    expect(await readFrom(h, id, "::ffff:203.0.113.77")).toHaveProperty("network", "same");
    expect(await readFrom(h, id, "::ffff:203.0.200.4")).toHaveProperty("network", "different");
    expect(await readFrom(h, id, "::FFFF:198.51.100.9")).toHaveProperty("network", "different");
  });

  it("every spelling of an IPv4-mapped address is the IPv4 it carries, on either side", async () => {
    const h = await harness();
    // 171.205 is abcd in hex, 239.190 is efbe.
    const id = await asked(h, "171.205.239.190");
    for (const same of ["0:0:0:0:0:ffff:171.205.239.190", "0000:0000:0000:0000:0000:FFFF:171.205.239.190", "::ffff:abcd:efbe", "::FFFF:ABCD:EFBE"]) {
      expect(await readFrom(h, id, same), same).toHaveProperty("network", "same");
    }
    expect(await readFrom(h, id, "::ffff:efbe:abcd")).toHaveProperty("network", "different");
    const mapped = await asked(h, "0:0:0:0:0:ffff:abcd:efbe");
    expect(await readFrom(h, mapped, "171.205.239.190")).toHaveProperty("network", "same");
  });

  it("IPv6 compares by the /64", async () => {
    const h = await harness();
    const id = await asked(h, "2001:db8:aa:1::5");
    for (const same of ["2001:db8:aa:1:abcd:ef01:2345:6789", "2001:0DB8:00AA:0001::7"]) {
      expect(await readFrom(h, id, same), same).toHaveProperty("network", "same");
    }
    expect(await readFrom(h, id, "2001:db8:aa:ffff::9")).toHaveProperty("network", "different");
    expect(await readFrom(h, id, "2001:db8:ab::1")).toHaveProperty("network", "different");
  });

  it("the person's own repeat sign-in reads same each time; the rows keep a key per request, no address", async () => {
    const h = await harness();
    const ids = [await asked(h, DESKTOP), await asked(h, DESKTOP)];
    for (const id of ids) expect(await readFrom(h, id, DESKTOP)).toHaveProperty("network", "same");
    const rows = await Promise.all(ids.map((id) => rowOf(h, id)));
    expect(rows.map((r) => r.ipClass)).toEqual(["203.0.x.x", "203.0.x.x"]);
    const keys = rows.map((r) => (r.oauthMeta as { networkKey?: unknown } | null)?.networkKey);
    expect(keys).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), expect.stringMatching(/^[0-9a-f]{32}$/)]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113");
  });

  it("a request kept without the key never reads same", async () => {
    const h = await harness();
    const id = await asked(h, DESKTOP);
    await h.db.update(loginTokens).set({ oauthMeta: null }).where(eq(loginTokens.id, id));
    for (const ip of ["203.0.7.1", DESKTOP]) expect(await readFrom(h, id, ip), ip).toHaveProperty("network", "unknown");
    expect(await readFrom(h, id, "198.51.100.9")).toHaveProperty("network", "different");
  });

  it("the key is the deployment's: under another key even the request's own address reads different", async () => {
    const h = await harness();
    const id = await asked(h, DESKTOP);
    const other = new AuthService({ ...makeTestAuthDeps(), keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1) });
    const read = await other.readDesktopApproval(h.ctx({ userId: randomUUID(), accountId: randomUUID(), ip: DESKTOP }), id);
    expect(read).toHaveProperty("network", "different");
  });

  it("a browser with no address reads unknown", async () => {
    const h = await harness();
    const id = await asked(h, DESKTOP);
    expect(await readFrom(h, id, "")).toHaveProperty("network", "unknown");
    expect(await readFrom(h, id, "not-an-address")).toHaveProperty("network", "unknown");
  });

  it("a request stored with no class reads unknown, never different", async () => {
    const h = await harness();
    const id = await asked(h, "");
    expect(await readFrom(h, id, "198.51.100.9")).toHaveProperty("network", "unknown");
    expect(await readFrom(h, id, "")).toHaveProperty("network", "unknown");
  });

  it("an IPv4 request read from IPv6, or the reverse, is different: the family is not the crafter's to pick", async () => {
    const h = await harness();
    const v4 = await asked(h, DESKTOP);
    expect(await readFrom(h, v4, "2001:db8:aa::1")).toHaveProperty("network", "different");
    const v6 = await asked(h, "2001:db8:aa:1::5");
    expect(await readFrom(h, v6, "198.51.100.9")).toHaveProperty("network", "different");
  });

  it("nothing of the reader's address or class goes back, nor the request's key", async () => {
    const h = await harness();
    const id = await asked(h, DESKTOP);
    const v4 = JSON.stringify(await readFrom(h, id, "198.51.100.9"));
    expect(v4).not.toContain("198.51");
    const v6 = JSON.stringify(await readFrom(h, id, "2001:db8:ab::1"));
    expect(v6).not.toContain("2001:db8:ab");
    const own = await readFrom(h, id, DESKTOP);
    expect(Object.keys(own).sort()).toEqual(["approved", "expiresIn", "ipClass", "label", "network", "platform", "requestedAt"]);
    for (const kept of Object.values((await rowOf(h, id)).oauthMeta ?? {})) expect(JSON.stringify(own)).not.toContain(String(kept));
  });
});
