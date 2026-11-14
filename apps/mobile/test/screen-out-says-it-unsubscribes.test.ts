/**
 * PHONE-SCREEN-OUT-DOES-NOT-DISCLOSE-THE-UNSUBSCRIBE — a screen-out or spam decide on a door that
 * sends the sender's one-click unsubscribe says so, in the webapp's words; everything the server
 * does not unsubscribe for says nothing of the kind. Driven through `liveActions` on a real wire
 * (the fake door), both screening presses: the Screener's decide and the open message's sheet.
 *
 * TO WATCH IT FAIL: in `live.ts#pressClaim`, arm it `false` — the first case goes red while the
 * controls stay green; arm it on `decideRoute` alone and the controls go red.
 */
import { describe, expect, it } from "vitest";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveScreener, presentedOf, type LiveDeps, type WorldView } from "../src/state/live";
import { readFoldersEnabled } from "../src/net/consent";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { sayArg } from "../src/refusal";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};
const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const STRANGER = { name: "List Sender", address: "news@list.test" };

async function scene(extra: Partial<LiveDeps>, held = true) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("s1", { subject: "Weekly", folder: held ? "ohmail/Screener" : "INBOX", from: STRANGER }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), ...extra });
  const row = liveScreener(presentedOf(boot.engine.read(), view.now), view).waiting[0]!;
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, origin, actions, row, toasts, close };
}

// The held bodies here are never read, so a press says the request as a condition (`decideUnsub`).
const ALSO = "one-click unsubscribe";
const says = (toasts: string[]) => toasts.some((t) => t.includes(ALSO));

describe("a screen-out on the phone says it unsubscribes, as the web does", () => {
  it("the Screener's screen-out and spam decides carry the sentence when the switch is on", async () => {
    for (const dest of ["screened", "spam"] as const) {
      const s = await scene({ autoUnsubscribe: () => true });
      try {
        const ids = s.actions.unsubscribeIdsOf(s.row, [], "sender");
        expect(ids).toEqual(["s1"]);
        expect(await s.actions.decide(s.row, dest, false, "sender", [], ids)).toBe(true);
        expect(says(s.toasts), `the ${dest} decide did not say it unsubscribes`).toBe(true);
      } finally { s.close(); }
    }
  });

  it("the open message's screen-out of a waiting sender says it too", async () => {
    const s = await scene({ autoUnsubscribe: () => true });
    try {
      const ids = s.actions.screeningUnsubscribeIds("s1", "sender");
      expect(ids).toEqual(["s1"]);
      expect(await s.actions.screenSender("s1", "screened", "sender", true, undefined, ids)).toBe(true);
      expect(says(s.toasts)).toBe(true);
    } finally { s.close(); }
  });

  it("says nothing with the switch off, for an admit, or for a rule written past the gate", async () => {
    const off = await scene({ autoUnsubscribe: () => false });
    try {
      expect(await off.actions.decide(off.row, "screened", false, "sender")).toBe(true);
      expect(says(off.toasts), "the switch is off, so nothing is sent and nothing is claimed").toBe(false);
      expect(off.toasts.length, "the positive control: the decide still said something").toBeGreaterThan(0);
    } finally { off.close(); }
    const admit = await scene({ autoUnsubscribe: () => true });
    try {
      expect(await admit.actions.decide(admit.row, "ohbox", false, "sender")).toBe(true);
      expect(says(admit.toasts), "an admit unsubscribes nobody").toBe(false);
    } finally { admit.close(); }
    const past = await scene({ autoUnsubscribe: () => true }, false);
    try {
      expect(await past.actions.decide(past.row, "screened", false, "sender")).toBe(true);
      expect(past.fake.seen.some((r) => r.url.startsWith("/screener/")), "past the gate is a rule, not a decide").toBe(false);
      expect(says(past.toasts), "a rule written past the gate arms nothing").toBe(false);
    } finally { past.close(); }
  });

  it("the switch is read off the account's consent answer — null or absent is on, an instant is off", async () => {
    const s = await scene({});
    try {
      const session = { profile: { origin: s.origin }, fetch: (u: string, i?: RequestInit) => globalThis.fetch(u, i) };
      const read = async () => (await readFoldersEnabled(session as never))?.autoUnsubscribe;
      expect(await read(), "absent (an older server, which still sends) reads as on").toBe(true);
      s.fake.setBlockAutoUnsubscribeAt(null);
      expect(await read(), "null is the product default: on").toBe(true);
      s.fake.setBlockAutoUnsubscribeAt("2026-08-19T10:00:00.000Z");
      expect(await read(), "an instant is the account's off switch").toBe(false);
    } finally { s.close(); }
    expect(DE.liveAlsoUnsubscribing("x.", "sends")).toContain("Ein-Klick-Abmeldung");
    expect(Copy.liveAlsoUnsubscribing("x.", "may"))
      .toBe("x. Where the waiting mail offers one-click unsubscribe, ohmail asks to unsubscribe you. Sent requests cannot be taken back.");
  });
});
