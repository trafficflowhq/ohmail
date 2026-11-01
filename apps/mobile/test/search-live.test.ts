/**
 * SEARCH ON THE MIRROR — the engine's instant index through the phone's world face,
 * measured against the loopback mail server: hits are the rows the lists render, the SIMILAR
 * tier stands only when nothing matched exactly, an address query answers all three direction
 * counts, a held-deleted row is hidden for the window, and — the feature's whole claim — a
 * query costs NO wire request: the answer is the device's. The screen and the three nav
 * entries are pinned in the workspace's structure idiom (no RN renderer here).
 */
import { describe, expect, it } from "vitest";
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
    // The index is warmed off the keystroke path the moment the screen opens.
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
    expect(screen).toMatch(/useEffect\(\(\) => \{\s*warm\.current\(\);\s*\}, \[\]\);/);
    // And nothing else on this screen may depend on a value the world rebuilds per render.
    const deps = [...screen.matchAll(/useEffect\([\s\S]*?\}, \[([^\]]*)\]\);/g)].map((m) => m[1]!.trim());
    expect(deps.filter((d) => d !== "")).toEqual([]);
  });

  it("every navigation entry opens the one screen — dock/rail, More, the iOS pane foot", () => {
    expect(nav).toContain('router.push("/search")');
    expect(more).toContain('go("/search")');
    expect(ld).toContain('router.push("/search")');
  });
});
