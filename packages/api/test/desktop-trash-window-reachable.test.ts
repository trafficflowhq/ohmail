import { accountOfMailbox } from "@trafficflow/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import {
  accountSettings, mailboxes, mailboxCredentials, messageBodies, messages,
} from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { localRoutes } from "../src/routes/local.js";
import { desktopHostRoutes } from "../src/routes/desktop-host.js";
import { trashRoutes } from "../src/routes/trash.js";
import { matchRoute, type Route, type RouteParams } from "../src/router.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * ═══ CAN THE DESKTOP REACH THE LIVE TRASH WINDOW — asked of the composition the desktop's own
 *     engine serves, and of the handler it mounts ════════════════════════════════════════════
 *
 * ── WHAT WAS BROKEN, AND WHERE IT WAS NOT ───────────────────────────────────────────────────
 *
 * The window shipped with its server half on `localRoutes` and all three GETs on the relay
 * allowlist, so BOTH desktop doors could answer it — the standalone one from this machine, the
 * hosted one through the write-through proxy. The section still never appeared, because the
 * shared hook reached for `app/api-client` directly and the desktop aliases that module to a
 * refusing stub: `apiConfigured()` answered `false`, so `supported` was false, so `AppShell`
 * withheld the control and the view rendered no section at all — not "unavailable", not a failed
 * read, nothing on screen. The fix is a wire seam (`TrashWire`), the Junk window's shape.
 *
 * This file is the SERVER half of that claim, and it exists because the half that was fine is the
 * half a future edit will break: strip `trashRoutes` from the local table — a plausible "the
 * desktop has no Cloud account" tidy-up — and the desktop's section goes back to showing nothing,
 * with the client wire still in place and nothing else failing.
 *
 * ── WHY BOTH A MATCH AND A DRIVEN HANDLER ───────────────────────────────────────────────────
 *
 * `matchRoute` is what decides 404 against handler, so reachability is asked of the router rather
 * than of a name list. But a matched route proves only that something is mounted, so the
 * `no_trash_folder` case is driven through the ROUTE OBJECT the composition holds — the mounted
 * handler answers 200 with the stated absence, which is the shape the client's `unavailable` state
 * is derived from. `trash-window.test.ts` owns the service's own properties; this file owns
 * "the desktop's table serves them".
 */

const NOW = new Date("2026-09-11T12:00:00.000Z");

/**
 * The mounted route AND the params the router extracted for it — never re-listed here, and handed
 * back together so a driven handler is invoked exactly as `createApp` invokes one.
 */
function mounted(
  table: Route[], method: string, path: string,
): { route: Route; params: RouteParams } {
  const m = matchRoute(table, method, path);
  if (!m.matched) throw new Error(`${method} ${path} is NOT on this composition — a 404 door`);
  return { route: m.route, params: m.params };
}

interface Seeded {
  deps: ApiDeps;
  accountId: string;
  mailboxId: string;
  db: Awaited<ReturnType<typeof makeTestDb>>;
}

/**
 * One account with one mailbox and "Use folders" on. `trashFolder: null` is the subject: a mailbox
 * with no native \Trash is the degrade the window must STATE rather than throw or fake as empty.
 */
async function seed(opts: { trashFolder?: string | null } = {}): Promise<Seeded> {
  const db = await makeTestDb();
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  const accountId = randomUUID();
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `trash-${randomUUID().slice(0, 8)}@example.invalid`,
    trashFolder: opts.trashFolder === undefined ? null : opts.trashFolder,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
    now: () => NOW,
    // The local door's caller: `serviceContext` reads the account off the session, and the
    // standalone engine mints one at boot. No cookie, no bearer — that is the whole desktop tier.
    session: { accountId, userId: randomUUID(), sessionId: randomUUID() },
  } as unknown as ApiDeps;
  return { deps, accountId, mailboxId: mb!.id, db };
}

const get = (path: string): Request => new Request(`http://localhost${path}`);

beforeEach(() => vi.restoreAllMocks());

describe("the desktop's own table serves the live Trash window", () => {
  it("BOTH desktop compositions route the list and the body — the standalone door and the paired one", () => {
    // `localRoutes` is what `apps/sidecar`'s standalone app is built from; `desktopHostRoutes`
    // spreads it whole, which is the door a paired phone reads through. Asked of the ROUTER,
    // because `matchRoute` is what decides handler against 404.
    for (const [name, table] of [
      ["the standalone door", localRoutes] as const,
      ["the paired-device door", desktopHostRoutes] as const,
    ]) {
      expect(matchRoute(table, "GET", "/trash/window").matched, `${name}: no list`).toBe(true);
      expect(matchRoute(table, "GET", "/trash/window/body").matched, `${name}: no body`).toBe(true);
    }
  });

  it("mounts the SAME route objects as the hosted table — one implementation, not a desktop copy", () => {
    // Identity, `desktop-host.test.ts`'s discipline: a fix to the handler cannot fork between a
    // re-listed desktop copy and the real one.
    for (const r of trashRoutes) {
      expect(localRoutes, `${r.method} ${r.pattern} is not the mounted object`).toContain(r);
    }
    expect(mounted(localRoutes, "GET", "/trash/window").route).toBe(trashRoutes[0]);
  });

  it("THE MUTATION: without `trashRoutes` in the composition, both reads are a router MISS (404)", () => {
    // The composition with the spread removed — the plausible future edit this file exists to
    // catch. `matched: false` is exactly what `createApp` turns into a 404, so this is the state
    // the desktop was in from the client's side: an ask with nowhere to land.
    const stripped = localRoutes.filter((r) => !trashRoutes.includes(r));
    expect(stripped.length, "the filter matched nothing — this control is vacuous")
      .toBe(localRoutes.length - trashRoutes.length);
    expect(matchRoute(stripped, "GET", "/trash/window").matched).toBe(false);
    expect(matchRoute(stripped, "GET", "/trash/window/body").matched).toBe(false);
  });

  it("a path near the window that nothing mounts is a MISS — so the passes above are not vacuous", () => {
    // The positive control's negative twin: this table really does answer `false` for something.
    expect(matchRoute(localRoutes, "GET", "/trash/window/nope").matched).toBe(false);
    expect(matchRoute(localRoutes, "GET", "/trash/windows").matched).toBe(false);
  });
});

describe("the mounted handler answers, and answers the stated absence", () => {
  it("`no_trash_folder` is a 200 with the mailbox NAMED — never a throw, never a fake empty folder", async () => {
    const s = await seed({ trashFolder: null });
    // Driven through the object the DESKTOP composition holds, so this measures the desktop's
    // path and not an import of the module.
    const { route, params } = mounted(localRoutes, "GET", "/trash/window");
    const res = await route.handler(get("/trash/window"), s.deps, params);

    expect(res.status).toBe(200);
    const page = await res.json() as {
      mailboxes: Array<{ id: string; window: string }>;
      items: unknown[];
      nextCursor: string | null;
    };
    expect(page.mailboxes).toEqual([
      expect.objectContaining({ id: s.mailboxId, window: "no_trash_folder" }),
    ]);
    // Zero rows BESIDE the stated absence: this is what the client turns into `unavailable`, and
    // an empty list with `window: "ok"` would have it claim the folder was read and was empty.
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("the read WRITES NO MIRROR ROW through this door either — the window's defining property", async () => {
    const s = await seed({ trashFolder: null });
    const before = [
      (await s.db.select({ id: messages.id }).from(messages)).length,
      (await s.db.select({ messageId: messageBodies.messageId }).from(messageBodies)).length,
    ];
    const list = mounted(localRoutes, "GET", "/trash/window");
    await list.route.handler(get("/trash/window"), s.deps, list.params);
    const after = [
      (await s.db.select({ id: messages.id }).from(messages)).length,
      (await s.db.select({ messageId: messageBodies.messageId }).from(messageBodies)).length,
    ];
    expect(after).toEqual(before);
  });

  it("the BODY route's own handler answers — a 400 on a missing epoch, not a 404 from the router", async () => {
    const s = await seed({ trashFolder: null });
    const { route, params } = mounted(localRoutes, "GET", "/trash/window/body");
    // The epoch is REQUIRED: a UID names a message only within one UIDVALIDITY. That this refusal
    // is the one in `routes/trash.ts` is the evidence the mounted handler is that file's.
    await expect(route.handler(
      get(`/trash/window/body?mailboxId=${s.mailboxId}&uid=1`), s.deps, params,
    )).rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
  });
});

describe("the desktop path stays READ-ONLY", () => {
  it("every `/trash` route on both desktop compositions is a GET, and there is no verb at all", () => {
    // The client seam carries the same rule (`TrashWire` has two reads and no verb). Here it is
    // asked of the server's table: a POST/PATCH/DELETE under `/trash` added to the shared route
    // module would arm a write against the provider's Trash on the desktop's own engine.
    for (const table of [localRoutes, desktopHostRoutes]) {
      const trash = table.filter((r) => r.pattern.startsWith("/trash"));
      expect(trash.length).toBeGreaterThan(0);
      for (const r of trash) {
        expect(r.method, `${r.method} ${r.pattern} is not a read`).toBe("GET");
      }
    }
  });

  it("the window's three routes are exactly the reads the module declares — no fourth door", () => {
    expect(trashRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual([
      "GET /trash/window",
      "GET /trash/window/body",
      "GET /trash/window/search",
    ]);
  });
});
