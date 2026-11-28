/**
 * THE PHONE SHOWS ITS TAGS — where the web shows them: on the row (drawn and spoken), in the
 * open message, and as a list per tag in the places list. A tag put on a message elsewhere
 * reached the phone's store and no surface drew it. The tag list is the store's set: the
 * engine pins tagged mail whatever the window, and the mobile window is measured here.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { color as tokenColor } from "@ohmail/tokens";
import { bootEngine, MOBILE_WINDOW, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveMessage, liveOhbox, liveTagged, liveTags, presentedOf, tagMarksOf, type WorldView,
} from "../src/state/live";
import { DECKS } from "../src/copy";
import { TAG_HUES, palettes, tagHueOf, wheelAuthored } from "../src/theme/palette";
import { ohmarchyPalettes } from "../src/theme/ohmarchy";
import { mailRowSpoken } from "../src/ui/row-spoken";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
let n = 0;
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
};
const NOW = new Date("2026-08-19T12:00:00Z");
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const catalog = (l: "en" | "de") =>
  JSON.parse(src(`../webapp/messages/${l}.json`)) as { tag: Record<string, string>; rail: Record<string, string> };

async function phoneOn(origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  return boot;
}

/** The world's own view: the clock, and the account's tags off the raw mirror. */
const viewOf = (engine: { read: () => Parameters<typeof liveTags>[0] }): WorldView =>
  ({ now: NOW, zone: "UTC", tags: liveTags(engine.read()) });

/** The web's own act on the server: one tag assignment through the route it presses. */
const assign = (origin: string, id: string, tagId: string, assigned: boolean) =>
  fetch(`${origin}/messages/${id}/tags`, { method: "POST", body: JSON.stringify({ tagId, assigned }) });

describe("a tag put on a message elsewhere, on the phone's own wire", () => {
  it("reaches the row, what the row says, the open message and the tag's list", async () => {
    const fake = mailServer();
    fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
    fake.addMessage(dto("m-old", { subject: "Kiln deposit", date: "2026-08-10T08:00:00Z" }));
    fake.addMessage(dto("m-new", { subject: "Kiln invoice", date: "2026-08-18T08:00:00Z" }));
    fake.addMessage(dto("m-plain", { subject: "Glaze order" }));
    fake.addTag("t-inv", "Invoices", "denim");
    const origin = await listen(fake.server);
    try {
      const phone = await phoneOn(origin);
      await assign(origin, "m-old", "t-inv", true);
      await assign(origin, "m-new", "t-inv", true);
      await phone.engine.syncOnce();

      const v = viewOf(phone.engine);
      const pres = presentedOf(phone.engine.read(), NOW);
      const row = liveOhbox(pres, v).fresh.find((m) => m.id === "m-new")!;
      expect(row.tags).toEqual([{ id: "t-inv", name: "Invoices", hue: "denim" }]);
      expect(mailRowSpoken(row).endsWith(" Invoices.")).toBe(true);
      expect(liveOhbox(pres, v).fresh.find((m) => m.id === "m-plain")!.tags).toBeUndefined();
      expect(liveMessage(phone.engine, "m-new", v)?.tags?.map((t) => t.name)).toEqual(["Invoices"]);

      const tagged = liveTagged(pres, v);
      expect(tagged.count("t-inv")).toBe(2);
      expect(tagged.items("t-inv").rows.map((m) => m.id)).toEqual(["m-new", "m-old"]);
      expect(tagged.items("t-inv").unread).toBe(2);
      expect(tagged.count("t-none")).toBe(0);

      /* Untagged elsewhere: the mark and the list both let go at the next drain. */
      await assign(origin, "m-new", "t-inv", false);
      await phone.engine.syncOnce();
      const after = presentedOf(phone.engine.read(), NOW);
      const v2 = viewOf(phone.engine);
      expect(liveOhbox(after, v2).fresh.find((m) => m.id === "m-new")!.tags).toBeUndefined();
      expect(liveTagged(after, v2).items("t-inv").rows.map((m) => m.id)).toEqual(["m-old"]);
      phone.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("keeps a tag's old mail when the window lets its untagged twin go", async () => {
    if (MOBILE_WINDOW.mode !== "windowed") throw new Error("the phone's mirror is no longer a window");
    const fake = mailServer();
    fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
    const floor = MOBILE_WINDOW.minRows;
    // Every row older than the window's days, so only the floor and the pin decide.
    const at = (i: number) => new Date(Date.parse("2026-01-01T00:00:00Z") - i * 60_000).toISOString();
    for (let i = 0; i < floor + 40; i++) fake.addMessage(dto(`o${i}`, { unread: false, date: at(i) }));
    fake.addMessage(dto("tagged-oldest", { unread: false, date: at(floor + 100) }));
    fake.addMessage(dto("twin-oldest", { unread: false, date: at(floor + 101) }));
    fake.addTag("t-keep", "Keep", "moss");
    const origin = await listen(fake.server);
    try {
      const phone = await phoneOn(origin);
      await assign(origin, "tagged-oldest", "t-keep", true);
      await phone.engine.syncOnce();
      const read = phone.engine.read();
      expect(read.get("message", "twin-oldest"), "the window evicts an untagged row").toBeUndefined();
      expect(read.get("message", "o0")).toBeDefined();
      const tagged = liveTagged(presentedOf(read, NOW), viewOf(phone.engine));
      expect(tagged.items("t-keep").rows.map((m) => m.id)).toEqual(["tagged-oldest"]);
      phone.store.close();
    } finally {
      fake.server.close();
    }
  }, 60_000);
});

describe("the marks: the web's ten hues and its clamp", () => {
  it("carries the tokens' wheel, in order, on both faces and both schemes", () => {
    expect([...TAG_HUES]).toEqual(Object.keys(tokenColor.light.tag));
    for (const p of [palettes.light, palettes.dark, ohmarchyPalettes.light, ohmarchyPalettes.dark]) {
      expect(Object.keys(p.tag).sort()).toEqual([...TAG_HUES].sort());
    }
  });

  it("authors the seven wheel hues as the tokens state them", () => {
    const NUM = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*(\.?[\d.]+))?\s*\)/;
    const parse = (css: string) => {
      const m = NUM.exec(css)!;
      return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]), a: m[4] === undefined ? 1 : Number(`0${m[4]}`) };
    };
    for (const scheme of ["light", "dark"] as const) {
      for (const [hue, w] of Object.entries(wheelAuthored[scheme])) {
        const tok = tokenColor[scheme].tag[hue as keyof typeof tokenColor.light.tag];
        expect({ hue, ...w.ink }).toEqual({ hue, ...parse(tok.ink) });
        expect({ hue, ...w.bg }).toEqual({ hue, ...parse(tok.bg) });
      }
    }
  });

  it("paints a stored hue off the list as moss, the web's clamp", () => {
    expect(tagHueOf("denim")).toBe("denim");
    expect(tagHueOf("clay")).toBe("moss");
    expect(tagHueOf("")).toBe("moss");
    const tags = [{ id: "a", name: "A", hue: "iris" }, { id: "b", name: "B", hue: "h1" }];
    expect(tagMarksOf(["b", "a"], tags)).toEqual([
      { id: "a", name: "A", hue: "iris" }, { id: "b", name: "B", hue: "moss" },
    ]);
    expect(tagMarksOf([], tags)).toEqual([]);
    expect(tagMarksOf(["a"], undefined)).toEqual([]);
  });
});

describe("the screens draw what the world hands them", () => {
  it("the row and the open message draw a TagChip per tag the row carries", () => {
    for (const file of ["src/ui/MailRow.tsx", "src/ui/MessageReader.tsx"]) {
      expect(src(file), file).toMatch(/m\.tags\s*\?\s*m\.tags\.map\(\(tag\) => \(\s*<TagChip key=\{tag\.id\} name=\{tag\.name\}/);
    }
  });

  it("the places list names every tag with its count, and a tag opens its own list", () => {
    const more = src("src/ui/MoreNav.tsx");
    expect(more).toMatch(/w\.tags\.map\(\(tag\) => \(/);
    expect(more).toContain("count={w.boot.settled ? w.tagged.count(tag.id) : undefined}");
    expect(more).toContain("go(`/tag/${encodeURIComponent(tag.id)}`)");
    const screen = fileURLToPath(new URL("../app/tag/[id].tsx", import.meta.url));
    expect(existsSync(screen)).toBe(true);
    expect(readFileSync(screen, "utf8")).toContain("w.tagged.items(tag.id)");
  });

  it("hands the lists and the reading screen the same tags", () => {
    const w = src("src/state/world-projection.ts");
    const at = w.indexOf("message: (id, wholeThread) => liveMessage(engine, id, {");
    expect(at).toBeGreaterThan(-1);
    expect(w.slice(at, at + 260)).toMatch(/\btags,/);
    // ONE tags binding, handed to the lists' view, the world and the reader.
    expect(w.match(/\bconst tags = /g) ?? []).toHaveLength(1);
    expect(w.match(/\btags,/g) ?? []).toHaveLength(3);
  });

  it("says the tag list's words in the web's words, in both languages", () => {
    for (const l of ["en", "de"] as const) {
      expect(DECKS[l].tagEmptyTitle).toBe(catalog(l).tag.emptyTitle);
      expect(DECKS[l].tagsTitle).toBe(catalog(l).rail.tags);
    }
  });
});
