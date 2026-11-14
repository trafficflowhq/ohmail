/** @vitest-environment jsdom */
/**
 * AN UNMETERED HOST STATES NO CREDIT PRICE ON THE DRAFT OFFER (moved word for word from `selfhost-credit-copy.test.tsx`
 * by the older tests' sorting; its other cases wait there for the Screener's mounts). A self-hosted
 * server, the standalone desktop and a paired computer charge nothing, yet the shared shell said "This uses 15 credits
 * of your AI budget" on every host. The managed control keeps its price, with the number from
 * `DRAFT_REPLY_COST_CREDITS`.
 *
 * Read over Write's reply: the composition under Write as the mail ground stands it (`_write-1-writing.tsx`), the
 * reply opened on a letter, its foot's draft control read as a person reads it. By the Write design
 * (`r2-write/RULING-0.md`; DIFFERENCES-FROM-TODAY.md "Write, a reply") Draft reply is ONE press with its price said on
 * the control before the press: no offer card and no sentence that asks first. Its price is the constant's on a
 * managed host, the empty balance is said in its place, and an unmetered host states no price.
 */
import { afterEach, describe, expect, it } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { DRAFT_REPLY_COST_CREDITS, type DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { mountWriting, unmountWritings } from "./_write-1-writing.js";
import { act as settle, message } from "./_draft-shell.js";

afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});

const CREDIT_WORDS = { en: /credit|AI budget/i, de: /Punkt|Guthaben|KI-Budget/i } as const;

/** A drafter that is asked nothing before the press: the offer is read, never bought. */
const DRAFTER: DraftReplyWire = {
  configured: () => true,
  create: async () => { throw new Error("nothing is bought before the press"); },
  read: async () => { throw new Error("nothing is read before the press"); },
  fromText: "none",
};
/** Write's reply opened on a letter, on a host that is metered or not; answers the text a person reads at its foot. */
async function draftOffer(opts: { locale: "en" | "de"; managed?: boolean; noCredits?: boolean }): Promise<string> {
  const world = await mountWriting({
    messages: [message("m1")],
    hash: "#/inbox",
    sheet: ["m1"],
    draftWire: DRAFTER,
    metered: opts.managed !== false,
    noCredits: opts.noCredits === true,
    locale: opts.locale,
  });
  await settle(async () => world.now().openReply("m1"));
  for (let i = 0; i < 6; i += 1) await settle(async () => new Promise((r) => setTimeout(r, 5)));
  return world.el.textContent ?? "";
}

describe("the draft offer", () => {
  it("CONTROL — a managed host states the price, and the number is the constant's", async () => {
    const text = await draftOffer({ locale: "en" });
    expect(text).toContain(`${DRAFT_REPLY_COST_CREDITS} credits`);
    await unmountWritings();
    expect(await draftOffer({ locale: "de", managed: true })).toContain(`${DRAFT_REPLY_COST_CREDITS} Punkte`);
  });

  it.each(["en", "de"] as const)("%s: an account the Screener already knows has no credits is told so, not offered a price", async (locale) => {
    const text = await draftOffer({ locale, managed: true, noCredits: true });
    expect(text).toContain((locale === "en" ? en : de).aiRefusal.insufficientCredits);
    expect(text).not.toContain(String(DRAFT_REPLY_COST_CREDITS));
  });

  it.each(["en", "de"] as const)("%s: an unmetered host says what happens and states no price", async (locale) => {
    const text = await draftOffer({ locale, managed: false });
    /* the draft is one press, with no sentence that asks first; the control says what it does. */
    expect(text).toContain((locale === "en" ? en : de).write.draft.verb);
    expect(text).not.toMatch(CREDIT_WORDS[locale]);
    expect(text).not.toContain(String(DRAFT_REPLY_COST_CREDITS));
  });
});
