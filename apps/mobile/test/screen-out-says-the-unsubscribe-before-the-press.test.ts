/**
 * ON THE PHONE — the sender screen and the open message's screening sheet say, before
 * Screen out or Spam, the one-click unsubscribe the press asks for: the sender-level condition (now and
 * later mail) for every decide at the gate, a fact where a held letter offers one-click, nothing past
 * the gate or with the switch off; the toast states Undo's reach. Driven through `liveActions` on the fake door; the screens are read by their code with
 * comments blanked (no RN renderer here), as `domain-card-files-the-domain` reads the card.
 *
 * TO WATCH IT FAIL: in `unsubscribe-claim.ts#unsubscribeClaim`, return `"sends"` for every armed
 * press — the conditional cases go red; return `"none"` — every armed case goes red.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoUnsubscribeConfirms } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { sayArg } from "../src/refusal";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { closeRoutingSession, noteScreenChanged, openRoutingSession } from "../src/state/held-routing";
import { liveActions, liveScreener, planHeldRouting, presentedOf, type WorldView } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (rel: string) => withoutComments(fs.readFileSync(path.join(HERE, "..", rel), "utf8"));
const view: WorldView = { now: new Date("2026-08-19T10:00:00Z"), zone: "UTC" };
const LIST = "news@list.test";
const PLAIN = "person@plain.test";
/** A list offering one-click whose letter its provider did not confirm: the pass will not send for it. */
const UNCONFIRMED = "news@unconfirmed.test";
/** A stranger whose mail sits in the INBOX: presented at the gate, decided by the rule path. */
const PAST = "early@past.test";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

afterEach(() => { closeRoutingSession(); });

async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

/** One held letter from a list offering one-click, two from a person offering none (`unread`: one never read). */
async function scene(opts: { unread?: boolean; autoUnsubscribe?: boolean } = {}) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  // The list's provider confirmed its sender (the pass sends for it); the other list's did not.
  const confirmed = { ...dto("l1", { from: { name: "List", address: LIST }, folder: "ohmail/Screener" }), authVerdict: "pass" };
  const unconfirmed = { ...dto("u1", { from: { name: "Unconfirmed", address: UNCONFIRMED }, folder: "ohmail/Screener" }), authVerdict: "unavailable" };
  fake.addMessage(confirmed);
  fake.addMessage(dto("p1", { from: { name: "Person", address: PLAIN }, folder: "ohmail/Screener" }));
  fake.addMessage(dto("p2", { from: { name: "Person", address: PLAIN }, folder: "ohmail/Screener" }));
  fake.addMessage(dto("e1", { from: { name: "Early", address: PAST }, folder: "INBOX" }));
  fake.addMessage(unconfirmed);
  fake.setBody("l1", "news", "one_click");
  fake.setBody("u1", "news", "one_click");
  fake.setBody("p1", "hello", "no_header");
  fake.setBody("p2", "again", "not_one_click");
  fake.setBody("e1", "before", "one_click");
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: Array<{ text: string; undo?: () => void }> = [];
  const actions = liveActions({
    engine: boot.engine, uuid: deps.uuid, zone: "UTC", autoUnsubscribe: () => opts.autoUnsubscribe ?? true,
    toast: (m, o?: { undo?: () => void }) => { said.push({ text: String(sayArg(m)), ...(o?.undo ? { undo: o.undo } : {}) }); },
  });
  // The sender screen hydrates every held body it shows; this one leaves `p2` unread on request.
  const read = opts.unread ? ["l1", "p1", "e1", "u1"] : ["l1", "p1", "p2", "e1", "u1"];
  actions.hydrateHeld(read);
  await until(() => read.every((id) => boot.engine.read().get<{ state?: string }>("message_body", id)?.state === "ready"));
  const waiting = liveScreener(presentedOf(boot.engine.read(), view.now), view).waiting;
  const row = (address: string) => waiting.find((w) => w.address === address)!;
  const decides = () => fake.seen.filter((r) => r.method === "POST" && r.url.startsWith("/screener/"));
  const close = () => { boot.store.close(); fake.server.close(); };
  return { ...boot, fake, actions, said, waiting, row, decides, close };
}

describe("the phone says the unsubscribe before Screen out or Spam is pressed", () => {
  it("a held letter offering one-click: a fact; every letter read and none offering it: still the condition", async () => {
    const s = await scene();
    try {
      expect(s.actions.unsubClaimOf(s.row(LIST), s.waiting, "sender")).toBe("sends");
      // Later mail, and past mail the press moves, may offer it: the server asks for the sender.
      expect(s.actions.unsubClaimOf(s.row(PLAIN), s.waiting, "sender")).toBe("may_send");
      // The open message's sheet asks the same question of the same letters.
      expect(s.actions.screeningUnsubClaim("l1", "sender")).toBe("sends");
      expect(s.actions.screeningUnsubClaim("p1", "sender")).toBe("may_send");
    } finally { s.close(); }
  });

  it("a one-click letter its provider did not confirm: the condition, never the fact", async () => {
    const s = await scene();
    try {
      expect(s.actions.unsubClaimOf(s.row(UNCONFIRMED), s.waiting, "sender")).toBe("may_send");
      expect(s.actions.screeningUnsubClaim("u1", "sender")).toBe("may_send");
    } finally { s.close(); }
  });

  it("a row past the gate is decided by the rule path, which asks nothing: no claim, even over a one-click letter", async () => {
    const s = await scene();
    try {
      expect(s.waiting.some((w) => w.address === PAST), "premise: the INBOX stranger is on the shelf").toBe(true);
      expect(s.actions.unsubClaimOf(s.row(PAST), s.waiting, "sender")).toBe("none");
      expect(s.actions.screeningUnsubClaim("e1", "sender")).toBe("none");
    } finally { s.close(); }
  });

  it("a held letter still unread: a condition, never a promise", async () => {
    const s = await scene({ unread: true });
    try {
      expect(s.actions.unsubClaimOf(s.row(PLAIN), s.waiting, "sender")).toBe("may_send");
      expect(s.actions.screeningUnsubClaim("p1", "sender")).toBe("may_send");
    } finally { s.close(); }
  });

  it("the account's switch off: nothing is said, whatever the sender offers", async () => {
    const s = await scene({ autoUnsubscribe: false });
    try {
      expect(s.actions.unsubClaimOf(s.row(LIST), s.waiting, "sender")).toBe("none");
      expect(s.actions.screeningUnsubClaim("l1", "sender")).toBe("none");
    } finally { s.close(); }
  });

  it("no mailbox whose provider's word ohmail reads: nothing is sent by itself, so nothing is said", async () => {
    const s = await scene({ autoUnsubscribe: autoUnsubscribeConfirms([{ status: "connected", providerConfirms: false }]) });
    try {
      expect(s.actions.unsubClaimOf(s.row(LIST), s.waiting, "sender")).toBe("none");
      expect(s.actions.unsubClaimOf(s.row(PLAIN), s.waiting, "sender")).toBe("none");
      expect(s.actions.screeningUnsubClaim("l1", "sender")).toBe("none");
    } finally { s.close(); }
    // The world reads the account's mailbox rows into the same getter the switch sits in.
    expect(source("src/state/world.tsx")).toContain(
      "autoUnsubscribe: () => !standaloneNow.current && autoUnsubscribeNow.current && autoUnsubscribeConfirms(mailboxesNow.current),",
    );
  });

  it("the sender screen draws the line under the bar, and the open message's sheet above its note", () => {
    const detail = source("src/ui/SenderDetail.tsx");
    expect(detail).toContain("w.actions.unsubClaimOf(row, w.screener.waiting)");
    expect(detail).toMatch(/Copy\.decideUnsub\(claim, target, row\.scope === "domain"\)/);
    expect(detail).toMatch(/testID="decide-unsub"/);
    const sheet = source("src/ui/MessageActions.tsx");
    expect(sheet).toContain("w.actions.screeningUnsubClaim(m.id, scope)");
    expect(sheet).toMatch(/testID="screening-unsub"/);
    expect(Copy.decideUnsub("sends", LIST, false)).toBe(`Screen out and Spam also send ${LIST} a one-click unsubscribe request, and ask again for their later mail that offers one.`);
    expect(Copy.decideUnsub("may_send", PLAIN, false)).toBe(`Where ${PLAIN} offers one-click unsubscribe, Screen out and Spam also ask to unsubscribe you, now and for their later mail.`);
    expect(DE.decideUnsub("sends", LIST, false)).toContain("Ein-Klick-Abmeldung");
  });
});

describe("the press, and how far its Undo reaches", () => {
  const hold = (s: Awaited<ReturnType<typeof scene>>, windowMs: number) => openRoutingSession({
    windowMs,
    journal: s.store,
    plan: (i) => planHeldRouting(s.engine.read(), i, (changed) => noteScreenChanged(i.id, changed)),
    dispatch: async (ms) => { await Promise.all(ms.map((m) => s.engine.mutate(m).catch(() => null))); },
  });

  it("held: the toast says Undo stops the request, and Undo inside the window sends nothing", async () => {
    const s = await scene();
    try {
      hold(s, 60_000);
      expect(await s.actions.decide(s.row(LIST), "screened", false, "sender", s.waiting)).toBe(true);
      const t = s.said.at(-1)!;
      expect(t.text).toContain("Undo also stops their one-click unsubscribe request");
      t.undo!();
      await new Promise((r) => setTimeout(r, 200));
      expect(s.decides()).toHaveLength(0);
    } finally { s.close(); }
  });

  it("held for a sender whose held letters offer none: the toast still says the sender-level condition", async () => {
    const s = await scene();
    try {
      hold(s, 60_000);
      expect(await s.actions.decide(s.row(PLAIN), "screened", false, "sender", s.waiting)).toBe(true);
      expect(s.said.at(-1)!.text).toContain("Where they offer one-click unsubscribe, ohmail asks to unsubscribe you once Undo is gone, and again for their later mail");
      expect(s.said.at(-1)!.undo, "positive control: the press was held with Undo").toBeDefined();
    } finally { s.close(); }
  });

  it("no window to hold it: the request is said as gone, and the decide is sent once", async () => {
    const s = await scene();
    try {
      expect(await s.actions.decide(s.row(LIST), "screened", false, "sender", s.waiting)).toBe(true);
      await until(() => s.decides().length >= 1);
      expect(s.decides()).toHaveLength(1);
      expect(s.said.map((x) => x.text).join(" | ")).toContain("ohmail is sending them a one-click unsubscribe request, which cannot be taken back, and asks again for their later mail");
    } finally { s.close(); }
  });
});
