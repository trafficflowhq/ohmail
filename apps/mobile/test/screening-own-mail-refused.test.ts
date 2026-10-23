import { beforeEach, describe, expect, it } from "vitest";
import { DECKS } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * NO SCREENING PRESS ON THE ACCOUNT'S OWN MAIL (SENDER-SHEET-OFFERED-ON-OUR-OWN-MAIL). A press on
 * our own Sent copy would key a rule on our own address: the phone refuses it before anything goes
 * on the wire, and where it cannot tell (the account's addresses not read yet) the server's
 * `own_address` answer says the same sentence, in English and German. The row carries the fact the
 * reader's verbs read; somebody else's mail screens as before (the control).
 */
const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};
const ME = "me@fake.test";

async function scene(m1: { folder: string; from: string }, own: readonly string[] | undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m1", { subject: "Notes", folder: m1.folder, from: { name: "Me", address: m1.from } }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions = liveActions({
    engine: boot.engine, toast: (m) => { said.push(sayArg(m)); }, uuid: deps.uuid, zone: "UTC",
    ...(own === undefined ? {} : { ownAddresses: () => own }),
  });
  const row = () => liveMessage(boot.engine, "m1", { now: new Date("2026-08-19T10:00:00Z"), zone: "UTC", ...(own ? { ownAddresses: own } : {}) })!;
  const writes = () => fake.seen.filter((r) => r.method !== "GET" && (r.url.startsWith("/rules") || r.url.startsWith("/screener")));
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, actions, said, row, writes, close };
}

beforeEach(() => { resetLocaleRegisterForTests(); });

describe("a Screening press on the account's own mail", () => {
  for (const locale of ["en", "de"] as const) {
    it(`on our own Sent copy is refused on the phone, nothing is sent, and it is said (${locale})`, async () => {
      setActiveLocale(locale);
      const s = await scene({ folder: "Sent", from: ME }, [ME]);
      expect(s.row().ownMail).toBe(true);
      expect(await s.actions.screenSender("m1", "screened", "sender")).toBe(false);
      expect(s.writes()).toEqual([]);
      expect(s.said).toEqual([DECKS[locale].liveOwnAddress]);
      s.close();
    });
  }

  it("where the phone has not read the account's addresses, the server's own_address refuses the rule", async () => {
    setActiveLocale("en");
    const s = await scene({ folder: "INBOX", from: ME }, undefined);
    s.fake.answerNext("POST", "/rules", 400, { error: { code: "own_address", message: "refused by test" } });
    expect(await s.actions.screenSender("m1", "screened", "sender")).toBe(false);
    expect(s.writes().map((r) => `${r.method} ${r.url}`)).toEqual(["POST /rules"]);
    // The press filed the letter it was made on, so the sentence says it moved and the rule did
    // not: the own-address sentence never stands alone over mail that moved (REVIEW-026 HIGH-1).
    expect(s.said, s.said.join(" | ")).toContain(DECKS.en.liveRuleFailedMoved("Screened out", ME));
    expect(s.said).not.toContain(DECKS.en.liveOwnAddress);
    expect(s.said.some((x) => x.startsWith("That decision could not be saved"))).toBe(false);
    s.close();
  });

  it("somebody else's mail screens as before, and its row carries no own-mail fact (the control)", async () => {
    setActiveLocale("en");
    const s = await scene({ folder: "INBOX", from: "friend@fake.test" }, [ME]);
    expect(s.row().ownMail).toBeUndefined();
    expect(await s.actions.screenSender("m1", "screened", "sender")).toBe(true);
    expect(s.writes().map((r) => `${r.method} ${r.url}`)).toEqual(["POST /rules"]);
    s.close();
  });
});
