/**
 * SEARCH ON THE MIRROR — the engine's instant index through the phone's world face,
 * measured against the loopback mail server: hits are the rows the lists render, the SIMILAR
 * tier stands only when nothing matched exactly, an address query answers all three direction
 * counts, a held-deleted row is hidden for the window, and — the feature's whole claim — a
 * query costs NO wire request: the answer is the device's. The screen and the three nav
 * entries are pinned in the workspace's structure idiom (no RN renderer here).
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Copy } from "../src/copy";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  addressShaped,
  hiddenMessagesReader,
  liveSearch,
  type WorldView,
} from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(HERE, "..", rel), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  return { fake, ...boot };
}

describe("the device answers a search from its mirror, off the wire", () => {
  it("finds by subject, renders the list's own rows, and costs no request", async () => {
    const live = await scene((f) => {
      f.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      f.addMessage(dto("m1", { subject: "Quarterly invoice enclosed", unread: true }));
      f.addMessage(dto("m2", { subject: "Team photo", unread: false }));
    });
    const face = liveSearch(live.engine, live.engine.read(), view);
    const before = live.fake.seen.length;
    const hit = face.query("invoice");
    expect(hit.items.map((m) => m.id)).toEqual(["m1"]);
    // The row is the projection every list renders — subject and time already formatted.
    expect(hit.items[0]!.subject).toBe("Quarterly invoice enclosed");
    expect(hit.similar).toEqual([]);
    expect(hit.coverageMessages).toBe(2);
    expect(hit.indexing).toBe(false);
    // OFFLINE BY CONSTRUCTION: the whole answer came from the mirror, nothing dialled.
    expect(live.fake.seen.length).toBe(before);
    live.store.close();
    live.fake.server.close();
  });

  it("a typo lands in the SIMILAR tier, and only when nothing matched exactly", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("m1", { subject: "Quarterly invoice enclosed" }));
    });
    const face = liveSearch(live.engine, live.engine.read(), view);
    const guess = face.query("invoce");
    expect(guess.items).toEqual([]);
    expect(guess.similar.map((m) => m.id)).toEqual(["m1"]);
    live.store.close();
    live.fake.server.close();
  });

  it("an address is its own search — all three direction counts, rows per direction", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("a1", { from: { name: "Anna", address: "anna@corp.example" } }));
      f.addMessage({ ...dto("a2"), to: [{ name: "Anna", address: "anna@corp.example" }] });
      f.addMessage(dto("a3", { subject: "Unrelated" }));
    });
    const face = liveSearch(live.engine, live.engine.read(), view);
    const any = face.address("anna@corp.example", "any");
    expect(any.counts).toEqual({ any: 2, from: 1, to: 1 });
    expect(any.items.map((m) => m.id).sort()).toEqual(["a1", "a2"]);
    expect(face.address("anna@corp.example", "from").items.map((m) => m.id)).toEqual(["a1"]);
    expect(face.address("anna@corp.example", "to").items.map((m) => m.id)).toEqual(["a2"]);
    live.store.close();
    live.fake.server.close();
  });

  it("a held-deleted row is hidden from search for the window — the lists' own reader", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("m1", { subject: "Quarterly invoice enclosed" }));
      f.addMessage(dto("m2", { subject: "Invoice reminder" }));
    });
    const hiding = hiddenMessagesReader(live.engine.read(), new Set(["m1"]));
    const face = liveSearch(live.engine, hiding, view);
    expect(face.query("invoice").items.map((m) => m.id)).toEqual(["m2"]);
    live.store.close();
    live.fake.server.close();
  });
});

describe("the Place picker can read empty folders from its own account", () => {
  const places = [{ folder: "INBOX", count: 3 }, { folder: "ohmail/Quarantine", count: 0 }];

  async function inventoryDoor(answer: () => Promise<Response> = async () => Response.json({ places })) {
    const origin = "https://search.test";
    const accountId = "acct-places";
    let identity: string | null = accountId;
    const fetch = vi.fn(async (resource: string) => {
      const url = new URL(resource);
      if (url.pathname === "/auth/session" && identity !== null) {
        return Response.json({ user: { accountId: identity } });
      }
      if (url.pathname === "/search" && url.searchParams.get("places") === "1") return answer();
      return new Response(null, { status: 404 });
    });
    const boot = await bootEngine({ ...deps, fetch }, { origin, token: "tok-places", accountId });
    if (boot.kind !== "ready") throw new Error("boot refused");
    return { ...boot, fetch, setIdentity: (account: string | null) => { identity = account; } };
  }

  it("waits for the identity verdict before reading genuine zeros from the archive", async () => {
    const boot = await inventoryDoor();
    try {
      expect(await boot.engine.searchPlaces()).toBeNull();
      expect(boot.fetch).not.toHaveBeenCalled();

      const identity = boot.verifyIdentity();
      const inventory = boot.engine.searchPlaces();
      expect(await identity).toEqual({ kind: "verified" });
      expect(await inventory).toEqual(places);
      expect(boot.fetch.mock.calls.map(([url]) => new URL(url).pathname + new URL(url).search))
        .toEqual(["/auth/session", "/search?places=1"]);
    } finally {
      boot.store.close();
    }
  });

  it("drops an in-flight inventory when a new identity verdict refuses the account", async () => {
    let release = (_response: Response) => {};
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const servePlaces = vi.fn(() => response);
    const boot = await inventoryDoor(servePlaces);
    try {
      expect(await boot.verifyIdentity()).toEqual({ kind: "verified" });
      const inventory = boot.engine.searchPlaces();
      await vi.waitFor(() => expect(servePlaces).toHaveBeenCalledOnce());

      boot.setIdentity("acct-different");
      expect((await boot.verifyIdentity()).kind).toBe("mismatch");
      release(Response.json({ places }));
      expect(await inventory).toBeNull();
      expect(await boot.engine.searchPlaces()).toBeNull();
      expect(servePlaces).toHaveBeenCalledOnce();
    } finally {
      release(new Response(null, { status: 503 }));
      boot.store.close();
    }
  });

  it("keeps counts unknown when the archive cannot confirm its account", async () => {
    const boot = await inventoryDoor();
    try {
      boot.setIdentity(null);
      expect(await boot.verifyIdentity()).toEqual({ kind: "unverified" });
      expect(await boot.engine.searchPlaces()).toBeNull();
      expect(boot.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/auth/session"]);
    } finally {
      boot.store.close();
    }
  });

  it.each([
    { name: "matching", renewed: "test-account", expected: places },
    { name: "different", renewed: "other-account", expected: null },
    { name: "timed out again", renewed: null, expected: null },
  ])("requires fresh owner proof after a slow identity response ($name)", async ({ renewed, expected }) => {
    const accountId = "test-account";
    let settle!: (res: Response) => void;
    const firstReply = new Promise<Response>((resolve) => { settle = resolve; });
    let settleRetry!: (res: Response) => void;
    const lateRetry = new Promise<Response>((resolve) => { settleRetry = resolve; });
    let identityReads = 0;
    const inventory = vi.fn(() => Response.json({ places }));
    const fetch = vi.fn(async (resource: string) => {
      const url = new URL(resource);
      if (url.pathname === "/auth/session") {
        identityReads++;
        if (identityReads === 1) return firstReply;
        return renewed === null ? lateRetry : Response.json({ user: { accountId: renewed } });
      }
      if (url.pathname === "/api/search" && url.searchParams.get("places") === "1") return inventory();
      return new Response(null, { status: 404 });
    });
    const origin = "https://search.test";
    const boot = await bootEngine({ ...deps, fetch }, {
      origin, apiBase: `${origin}/api`, token: "fixture", accountId, identityDeadlineMs: 10,
    });
    if (boot.kind !== "ready") throw new Error("boot refused");
    try {
      expect(await boot.verifyIdentity()).toEqual({ kind: "unverified" });
      settle(Response.json({ user: { accountId } }));
      const first = boot.engine.searchPlaces();
      const second = boot.engine.searchPlaces();
      expect(await Promise.all([first, second])).toEqual([expected, expected]);
      expect(identityReads).toBe(2);
      expect(inventory).toHaveBeenCalledTimes(expected === null ? 0 : 2);
      if (expected === null) {
        settleRetry(Response.json({ user: { accountId } }));
        expect(await boot.engine.searchPlaces()).toBeNull();
        expect(identityReads).toBe(2);
        expect(inventory).not.toHaveBeenCalled();
      }
    } finally {
      settle(new Response(null, { status: 503 }));
      settleRetry(new Response(null, { status: 503 }));
      boot.store.close();
    }
  });

  it("reads the full inventory when renewal finishes after both early checks timed out", async () => {
    const origin = "https://search.test";
    const accountId = "sample-owner";
    let generation = 1;
    const late: ((response: Response) => void)[] = [];
    let identityReads = 0;
    const inventory = vi.fn(() => Response.json({ places }));
    const fetch = async (resource: string) => {
      const url = new URL(resource);
      if (url.pathname === "/auth/session") {
        identityReads++;
        return generation === 1
          ? new Promise<Response>((resolve) => { late.push(resolve); })
          : Response.json({ user: { accountId } });
      }
      if (url.pathname === "/api/search" && url.searchParams.get("places") === "1") return inventory();
      return new Response(null, { status: 404 });
    };
    const boot = await bootEngine(deps, {
      origin, apiBase: `${origin}/api`, accountId, identityDeadlineMs: 10,
      auth: { headers: () => ({}), fetch, credentialGeneration: () => generation },
    });
    if (boot.kind !== "ready") throw new Error("boot refused");
    try {
      expect(await boot.verifyIdentity()).toEqual({ kind: "unverified" });
      expect(await boot.engine.searchPlaces()).toBeNull();
      expect(await boot.engine.searchPlaces()).toBeNull();
      expect(identityReads).toBe(2);
      expect(inventory).not.toHaveBeenCalled();

      generation++;
      expect(await boot.engine.searchPlaces()).toEqual(places);
      expect(identityReads).toBe(3);
      expect(inventory).toHaveBeenCalledOnce();
    } finally {
      for (const resolve of late) resolve(new Response(null, { status: 503 }));
      boot.store.close();
    }
  });
});

describe("addressShaped admits one address and refuses everything the token search answers", () => {
  it("admits a bare address, trimmed; refuses phrases, lists and malformed shapes", () => {
    expect(addressShaped("anna@corp.example")).toBe("anna@corp.example");
    expect(addressShaped("  anna@corp.example  ")).toBe("anna@corp.example");
    expect(addressShaped("hello world")).toBeNull();
    expect(addressShaped("anna@corp.example bob@corp.example")).toBeNull();
    expect(addressShaped("a@b, c@d")).toBeNull();
    expect(addressShaped("@corp.example")).toBeNull();
    expect(addressShaped("anna@")).toBeNull();
    expect(addressShaped("a@b@c")).toBeNull();
    expect(addressShaped("invoice")).toBeNull();
  });
});

describe("the screen and the three nav entries, in the structure idiom", () => {
  const screen = read("app/search.tsx");
  const nav = read("app/(tabs)/_layout.tsx");
  const more = read("src/ui/MoreNav.tsx");
  const ld = read("src/ui/list-detail.tsx");

  it("the box takes focus, rows are MailRow, and the door opens the two scopes it names", () => {
    expect(screen).toContain("autoFocus");
    expect(screen).toContain("<MailRow");
    expect(screen).toContain("Copy.searchEmptyAddressScopes(door)");
    expect(screen).toContain("setAddr(door)");
    // The three directions, the engine's own union — and the empty state per direction.
    for (const needle of [
      "Copy.searchAddressAll",
      "Copy.searchAddressFrom",
      "Copy.searchAddressTo",
      "Copy.searchAddressEmptyFrom(addr)",
      "Copy.searchAddressEmptyTo(addr)",
      "Copy.searchAddressEmptyAny(addr)",
      "Copy.searchIndexing",
      // ARCHIVE-024: the verdict names the whole mailbox; no inventory of the device.
      "Copy.searchWholeSearching",
      // The unanswered verdict is `unansweredSaid`'s: the server's sentence, or the phone's own
      // network when that is the cause (`offline-is-said.test.ts` drives both).
      'unansweredSaid(network, "search", store.cause)',
    ]) expect(screen).toContain(needle);
    expect(screen).not.toContain("Copy.searchScopeDevice");
    // The visit schedules the warmup outside the first paint and keystroke paths.
    expect(screen).toContain("w.search.warm");
  });

  it("the warm effect runs ONCE per visit — a dependency the render rebuilds is a loop", () => {
    /*
     * Measured on an Android device: `useEffect(() => warm(), [warm])` over `w.search.warm`
     * spun the JS thread flat out with the screen frozen and no keystroke reaching state. The
     * world memo re-derives on the search index's revision, `liveSearch` hands back a fresh
     * closure each time, and a settled build bumps that revision — so the effect's own work
     * changed its own dependency. The ref holds the latest closure without being one.
     */
    expect(screen).toMatch(/const warm = useRef\(w\.search\.warm\);/);
    expect(screen).toMatch(/warm\.current = w\.search\.warm;/);
    expect(screen).toMatch(/useEffect\(\(\) => \{\s*const idle = requestIdleCallback\(\(\) => warm\.current\(\)\);\s*return \(\) => cancelIdleCallback\(idle\);\s*\}, \[\]\);/);
    // And nothing else on this screen may depend on a value the world rebuilds per render.
    const deps = [...screen.matchAll(/useEffect\([\s\S]*?\}, \[([^\]]*)\]\);/g)].map((m) => m[1]!.trim());
    expect(deps.filter((d) => d !== "")).toEqual([]);
  });

  it("every navigation entry opens the one screen — dock/rail, More, the iOS pane foot", () => {
    expect(nav).toContain('pushPlace("/search", navigation.getParent())');
    const push = read("src/ui/place-navigation.ts");
    expect(push).toContain('path === "/search" ? "search"');
    expect(push).toContain("router.push(path)");
    expect(more).toContain('go("/search")');
    expect(ld).toContain('router.push("/search")');
  });
});
