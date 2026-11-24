import { describe, expect, it } from "vitest";
import {
  addressBook,
  formatRecipient,
  isRobotAddress,
  matchAddresses,
  type AddressBookEntry,
  type EntityReader,
} from "@ohmail/client-engine";

/**
 * THE ADDRESS BOOK THE PRODUCT ALREADY HAD AND COULD NOT REACH.
 *
 * Composing a message, the To field offered nothing — every recipient had to be typed in full
 * and remembered exactly — while the mirror sitting in the same tab held every address the
 * user has ever corresponded with. This is that derivation.
 *
 * The two things worth guarding are the two that are easy to get subtly wrong: WHERE the
 * addresses come from (sent drafts are the only record of outbound mail, because `Folder` has
 * no Sent in it) and HOW they are ordered (frequency must lead, or a newsletter that arrived
 * an hour ago outranks the colleague written to daily).
 */

const now = Date.now();
const ago = (days: number): string => new Date(now - days * 86_400_000).toISOString();

function readerOf(messages: unknown[], drafts: unknown[] = []): EntityReader {
  return {
    get: () => undefined,
    list: <T,>(type: string): T[] =>
      (type === "message" ? messages : type === "draft" ? drafts : []) as T[],
    entries: () => [],
  } as unknown as EntityReader;
}

/* A From's display name is learned only where the sender's own provider vouched for it (`pass`), so the
   received letters below carry that verdict unless a case is about the verdict itself. */
const msg = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "m", folder: "INBOX", to: [], cc: [], date: ago(1), authVerdict: "pass", ...over,
});

const who = (address: string, name: string | null = null) => ({ address, name });

describe("where the addresses come from", () => {
  it("takes the FROM of every message", () => {
    const book = addressBook(readerOf([msg({ from: who("lena@example.invalid", "Lena Eichspan") })]));
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ address: "lena@example.invalid", name: "Lena Eichspan", count: 1 });
  });

  it("takes TO and CC as well — people in a thread who never wrote to you directly", () => {
    const book = addressBook(readerOf([
      msg({
        from: who("lena@example.invalid"),
        to: [who("me@example.invalid"), who("piet@example.invalid", "Piet")],
        cc: [who("ana@example.invalid", "Ana")],
      }),
    ]));
    expect(book.map((e) => e.address).sort()).toEqual([
      "ana@example.invalid", "lena@example.invalid", "me@example.invalid", "piet@example.invalid",
    ]);
  });

  it("takes the recipients of SENT drafts, a record of outbound mail", () => {
    // Sent messages reach the mirror too (see this module's header); a draft the user sent is
    // the same record from the other side. Drop this source and the people the user writes to
    // rank below the newsletters that write to them — which is the whole complaint, unfixed.
    const book = addressBook(readerOf([], [
      { id: "d1", status: "sent", to: [who("mara@example.invalid", "Mara")], cc: [], updatedAt: ago(2) },
    ]));
    expect(book).toHaveLength(1);
    expect(book[0]!.address).toBe("mara@example.invalid");
  });

  it("ignores drafts that were never sent", () => {
    // Somebody half-written-to is not a correspondent: an open draft names a person the user
    // has not decided to write to, an abandoned one names a person they decided not to.
    const book = addressBook(readerOf([], [
      { id: "d1", status: "draft", to: [who("nope@example.invalid")], cc: [], updatedAt: ago(1) },
      { id: "d2", status: "sending", to: [who("alsonope@example.invalid")], cc: [], updatedAt: ago(1) },
    ]));
    expect(book).toEqual([]);
  });

  it("excludes what the caller says to exclude — the account's own address above all", () => {
    const book = addressBook(
      readerOf([msg({ from: who("lena@example.invalid"), to: [who("Me@Example.invalid")] })]),
      { exclude: ["me@example.invalid"] },
    );
    expect(book.map((e) => e.address)).toEqual(["lena@example.invalid"]);
  });

  it("one address in two spellings is one entry, and a same-day tie keeps the fuller name", () => {
    // Senders routinely appear as both "Lena" and "Lena Eichspan". These two carry the SAME
    // stamp, so recency cannot separate them and the length tiebreak decides — see the name
    // rule below, where recency is what actually leads.
    const book = addressBook(readerOf([
      msg({ id: "a", from: who("Lena@Example.invalid", "Lena") }),
      msg({ id: "b", from: who("lena@example.invalid", "Lena Eichspan") }),
    ]));
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ address: "lena@example.invalid", name: "Lena Eichspan", count: 2 });
  });

  it("drops rows with no usable address rather than inventing one", () => {
    const book = addressBook(readerOf([
      msg({ id: "a", from: who("", null) }),
      msg({ id: "b", from: who("not-an-address") }),
      msg({ id: "c", from: undefined }),
    ]));
    expect(book).toEqual([]);
  });
});

/**
 * WHOSE NAME AN ADDRESS WEARS.
 *
 * Reported from a live account: the recipient chip read
 *
 *     Example Boat Hire Ltd - Sam Example   sam@example.com   ×
 *
 * — "this is not Andreas". The address was right and the name belonged to somebody else's idea
 * of him. The book harvests To and Cc as well as From, so a label a THIRD PARTY's client wrote
 * for a person lands in this map under that person's address; the rule that then chose between
 * the candidates was "the longest one ever seen", which has no notion of who said it or when.
 * A long company-shaped label therefore won permanently, over the name the person signs their
 * own mail with, on every surface that reads this book — and, because accepting a suggestion
 * writes `Name <address>` into the draft, out onto the wire's To header as well.
 */
describe("whose name an address wears", () => {
  it("the person's OWN signature outranks a label somebody else addressed them by", () => {
    // The report, reproduced. Andreas signs "Andreas Ingold". The long label rode in on the To
    // header of a mail the boat-hire company sent, where their client had its own name for him.
    const book = addressBook(readerOf([
      msg({ id: "own", from: who("andi@bergerweb.invalid", "Andreas Ingold"), date: ago(3) }),
      msg({
        id: "theirs", folder: "Sent",
        from: who("me@example.invalid"),
        to: [who("andi@bergerweb.invalid", "Bootsvermietung Enge GmbH - Andreas Ingold")],
        date: ago(1),
      }),
    ]));
    const andi = book.find((e) => e.address === "andi@bergerweb.invalid");
    expect(andi?.name).toBe("Andreas Ingold");
  });

  it("…even when the third party's label is longer AND newer", () => {
    // Neither length nor recency may cross the tier: a stranger's label for somebody is not
    // evidence about that person's name, however recently it was written.
    const book = addressBook(readerOf([
      msg({ id: "own", from: who("andi@bergerweb.invalid", "Andreas Ingold"), date: ago(400) }),
      msg({
        id: "theirs", folder: "Sent",
        from: who("me@example.invalid"),
        cc: [who("andi@bergerweb.invalid", "Bootsvermietung Enge GmbH - Andreas Ingold")],
        date: ago(0),
      }),
    ]));
    expect(book.find((e) => e.address === "andi@bergerweb.invalid")?.name).toBe("Andreas Ingold");
  });

  it("a sender who has changed how they sign wears their LATEST name, not their longest", () => {
    // Someone who left "Nora Lindt (Atelier Papierwerk GmbH)" behind and now signs "Nora Lindt"
    // is shown as they sign today. The old string is longer and, under the previous rule, was
    // permanent.
    const book = addressBook(readerOf([
      msg({ id: "old", from: who("nora@atelier.invalid", "Nora Lindt (Atelier Papierwerk GmbH)"), date: ago(300) }),
      msg({ id: "new", from: who("nora@atelier.invalid", "Nora Lindt"), date: ago(2) }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("a From with no display name does not erase the name the sender last gave", () => {
    // "" is the absence of a claim, not a claim that the name is now nothing. Most automated
    // mail is bare, and one bare message must not blank a correspondent everywhere.
    const book = addressBook(readerOf([
      msg({ id: "named", from: who("nora@atelier.invalid", "Nora Lindt"), date: ago(10) }),
      msg({ id: "bare", from: who("nora@atelier.invalid"), date: ago(1) }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("an address that has never written to you wears the most recent label you gave it", () => {
    // Nothing self-declared exists for this person, so the account's own label is all there is —
    // and between two of them the recent one is the better guess, not the longer one.
    const book = addressBook(readerOf([
      msg({
        id: "old", folder: "Sent", from: who("me@example.invalid"), date: ago(200),
        to: [who("piet@example.invalid", "Piet from the old agency listing")],
      }),
      msg({
        id: "new", folder: "Sent", from: who("me@example.invalid"), date: ago(1),
        to: [who("piet@example.invalid", "Piet Brun")],
      }),
    ]));
    expect(book.find((e) => e.address === "piet@example.invalid")?.name).toBe("Piet Brun");
  });

  it("a name accepted into a sent draft cannot outrank the sender's own signature", () => {
    // The feedback loop this closes: accepting a suggestion writes `Name <address>` into the
    // draft, the sent draft is harvested back into the book, and a wrong name would re-elect
    // itself for ever. A draft's To label is somebody's own typing, never the address owner's.
    const book = addressBook(
      readerOf(
        [msg({ id: "own", from: who("andi@bergerweb.invalid", "Andreas Ingold"), date: ago(9) })],
        [{
          id: "d1", status: "sent", updatedAt: ago(1),
          to: [who("andi@bergerweb.invalid", "Bootsvermietung Enge GmbH - Andreas Ingold")], cc: [],
        }],
      ),
    );
    expect(book[0]?.name).toBe("Andreas Ingold");
  });

  it("a date in the FUTURE is not evidence of recency and cannot pin a name for ever", () => {
    // `date` is the `Date:` header — sender-written, unchecked, and the mirror holds no arrival
    // clock to use instead. Under a most-recent-wins rule that is a lever: one message dated
    // 2099 (a broken client, an import, or somebody wanting the last word) would make its
    // display name unbeatable by every correctly dated message that ever follows.
    const book = addressBook(readerOf([
      msg({ id: "future", from: who("nora@atelier.invalid", "Nora"), date: ago(-30_000) }),
      msg({ id: "real", from: who("nora@atelier.invalid", "Nora Lindt"), date: ago(1) }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("…but a date a few minutes ahead of the reader's clock is ordinary mail", () => {
    // A device with a slow clock must not have every fresh name demoted, so the horizon carries
    // a day of skew — far wider than any real drift, far narrower than any useful forgery.
    const book = addressBook(readerOf([
      msg({ id: "old", from: who("nora@atelier.invalid", "Nora"), date: ago(9) }),
      msg({ id: "skewed", from: who("nora@atelier.invalid", "Nora Lindt"), date: ago(-0.005) }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("…and it loses to a PRE-1970 date, which is a real one", () => {
    // The first version of this guard scored a rejected date at `0`, which is not below the
    // range of a real one: `pagination.ts` records at length that a message dated before 1970 is
    // ordinary in imported archives and gives a NEGATIVE millisecond value. So the 2099 claim
    // went on beating the 1968 one — the defect still open for exactly the population where a
    // bogus date is most likely to turn up.
    const book = addressBook(readerOf([
      msg({ id: "future", from: who("nora@atelier.invalid", "Nora"), date: ago(-30_000) }),
      msg({ id: "archive", from: who("nora@atelier.invalid", "Nora Lindt"), date: "1968-04-02T09:00:00.000Z" }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("a date of exactly the Unix epoch is a REAL date, not the absence of one", () => {
    // `Date.parse("1970-01-01T00:00:00.000Z")` is `0`, which is also what a message with no date
    // used to produce — so a sentinel living inside the number could not tell them apart, and the
    // epoch-dated message was demoted to "says nothing" and lost to a 1968 one. Whether a date
    // parsed is known where it is parsed, and that is where it now stays.
    const book = addressBook(readerOf([
      msg({ id: "epoch", from: who("nora@atelier.invalid", "Nora Lindt"), date: "1970-01-01T00:00:00.000Z" }),
      msg({ id: "older", from: who("nora@atelier.invalid", "Nora"), date: "1968-04-02T09:00:00.000Z" }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("a name with a real date beats one with no date at all, however old the date", () => {
    // The same rule from the other side: an undated message says nothing about recency either,
    // so it must not outrank a message that does say something.
    const book = addressBook(readerOf([
      msg({ id: "undated", from: who("nora@atelier.invalid", "Nora"), date: null }),
      msg({ id: "archive", from: who("nora@atelier.invalid", "Nora Lindt"), date: "1968-04-02T09:00:00.000Z" }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("a future-dated name is still used when it is the only one there is", () => {
    // Refusing it as EVIDENCE OF RECENCY is not refusing it as a name — the address has made no
    // other claim, and showing a bare address instead would be losing information over a header
    // field nobody in this story got wrong on purpose.
    const book = addressBook(readerOf([
      msg({ id: "future", from: who("nora@atelier.invalid", "Nora Lindt"), date: ago(-30_000) }),
    ]));
    expect(book[0]?.name).toBe("Nora Lindt");
  });

  it("the choice is TOTAL — two equal claims cannot swap as unrelated mail arrives", () => {
    // Same tier, same instant, same length, different strings. Without a last-resort rule the
    // winner is whichever message the mirror enumerated first, which is the same instability
    // the ranking's own tiebreaks exist to prevent. Both orders must give the same answer.
    const same = ago(5);
    const one = msg({ id: "a", from: who("kim@example.invalid", "Kim Abt"), date: same });
    const two = msg({ id: "b", from: who("kim@example.invalid", "Kim Zwo"), date: same });
    expect(addressBook(readerOf([one, two]))[0]?.name)
      .toBe(addressBook(readerOf([two, one]))[0]?.name);
    expect(addressBook(readerOf([one, two]))[0]?.name).toBe("Kim Zwo");
  });

  it("counts and recency still take every appearance, whichever header it stood on", () => {
    // The tier decides the NAME only. Ranking is unchanged: a person seen on three headers is
    // seen three times, and the newest of them is how recently they were seen.
    const book = addressBook(readerOf([
      msg({ id: "own", from: who("andi@bergerweb.invalid", "Andreas Ingold"), date: ago(30) }),
      msg({ id: "a", from: who("lena@example.invalid"), to: [who("andi@bergerweb.invalid", "A. Ingold")], date: ago(20) }),
      msg({ id: "b", from: who("lena@example.invalid"), cc: [who("andi@bergerweb.invalid")], date: ago(2) }),
    ]));
    const andi = book.find((e) => e.address === "andi@bergerweb.invalid");
    expect(andi?.count).toBe(3);
    expect(andi?.lastAt).toBe(Date.parse(ago(2)));
    expect(andi?.name).toBe("Andreas Ingold");
  });
});

/**
 * A NAME NOBODY VOUCHED FOR IS NOT LEARNED.
 *
 * Found on a live mailbox: typing a person's full address in To and pressing Enter made the chip
 * read "PayPal Service", and the letter went out as `To: "PayPal Service" <address>`. The name
 * came from a received letter that paired it with that address. A received letter's To and Cc
 * are its sender's words about other people, and a From nobody checked is anyone's words; only
 * the account's own sent mail and a From the sender's provider passed may name somebody.
 */
describe("a name nobody vouched for is not learned", () => {
  const carla = "carla@example.invalid";

  it("a spoofed From pairing a name with an address does not teach that name", () => {
    const book = addressBook(readerOf([msg({ from: who(carla, "PayPal Service"), authVerdict: "fail" })]));
    expect(book.find((e) => e.address === carla)?.name).toBe("");
  });

  it("a name on a received letter's To or Cc is not learned, even from a sender that passed", () => {
    const book = addressBook(readerOf([
      msg({
        from: who("service@pay.invalid", "Pay"),
        to: [who(carla, "PayPal Service")],
        cc: [who("dora@example.invalid", "PayPal Billing")],
      }),
    ]));
    expect(book.find((e) => e.address === carla)?.name).toBe("");
    expect(book.find((e) => e.address === "dora@example.invalid")?.name).toBe("");
  });

  it("a name from the account's own sent mail is still offered, and a spoofed one cannot replace it", () => {
    const book = addressBook(readerOf(
      [
        msg({ id: "out", folder: "Sent", from: who("me@example.invalid"), to: [who(carla, "Carla Brun")], date: ago(9) }),
        msg({ id: "spoof", from: who(carla, "PayPal Service"), authVerdict: "fail", date: ago(0) }),
        msg({ id: "named", from: who("x@pay.invalid"), to: [who(carla, "PayPal Service")], date: ago(0) }),
      ],
      [{ id: "d1", status: "sent", to: [who("dora@example.invalid", "Dora Abt")], cc: [], updatedAt: ago(2) }],
    ), { exclude: ["me@example.invalid"] });
    expect(book.find((e) => e.address === carla)?.name).toBe("Carla Brun");
    expect(matchAddresses(book, "carla").map((e) => e.name)).toEqual(["Carla Brun"]);
    expect(matchAddresses(book, "dora").map((e) => e.name)).toEqual(["Dora Abt"]);
  });

  it("a reply that carried an unvouched name does not teach it either", () => {
    // A reply copies the letter's From and Cc with their names, so the Sent copy and the sent draft
    // repeat the name the forged letter gave; the account did not choose it.
    const book = addressBook(readerOf(
      [
        msg({ id: "spoof", from: who(carla, "PayPal Service"), cc: [who("dora@example.invalid", "PayPal Billing")], authVerdict: "fail", date: ago(2) }),
        msg({
          id: "reply", folder: "Sent", from: who("me@example.invalid"), date: ago(1),
          to: [who(carla, "PayPal Service")], cc: [who("dora@example.invalid", "PayPal Billing")],
        }),
      ],
      [{ id: "d1", status: "sent", to: [who(carla, "paypal service")], cc: [], updatedAt: ago(1) }],
    ));
    expect(book.find((e) => e.address === carla)?.name).toBe("");
    expect(book.find((e) => e.address === "dora@example.invalid")?.name).toBe("");
  });

  it("once the forged letter is gone, a reply that repeated its name still does not outrank the person's own", () => {
    // The Sent copy cannot show that it was a reply, and the sent draft can: neither may stand above
    // the name carla signs with when her provider gives no verdict.
    const book = addressBook(readerOf(
      [
        msg({ id: "real", from: who(carla, "Carla Brun"), authVerdict: "unavailable", date: ago(5) }),
        msg({ id: "reply", folder: "Sent", from: who("me@example.invalid"), to: [who(carla, "PayPal Service")], date: ago(1) }),
      ],
      [{ id: "d1", status: "sent", inReplyToMessageId: "gone", to: [who(carla, "PayPal Service")], cc: [], updatedAt: ago(1) }],
    ));
    expect(book.find((e) => e.address === carla)?.name).toBe("Carla Brun");
  });

  it("says when the name it shows is one nobody checked", () => {
    const book = addressBook(readerOf([
      msg({ id: "a", from: who(carla, "Carla Brun"), authVerdict: "pass" }),
      msg({ id: "b", from: who("dora@example.invalid", "Dora Abt"), authVerdict: "unavailable" }),
      msg({ id: "c", folder: "Sent", from: who("me@example.invalid"), to: [who("piet@example.invalid", "Piet Brun")] }),
    ]));
    expect(book.find((e) => e.address === carla)?.nameUnchecked).toBeUndefined();
    expect(book.find((e) => e.address === "dora@example.invalid")?.nameUnchecked).toBe(true);
    expect(book.find((e) => e.address === "piet@example.invalid")).toMatchObject({ name: "Piet Brun", nameUnchecked: true });
  });
});

/**
 * A SENDER'S NAME WHERE THE PROVIDER GIVES NO VERDICT.
 *
 * Only Gmail's stamp can be read as a pass; Microsoft, iCloud, Fastmail and self-hosted mailboxes
 * carry no verdict on any letter. Their senders' names are still shown, as a weak name: used only
 * when neither the account's own label nor a passed From names that address. A failed From still
 * names nobody.
 */
describe("a sender's name where the provider gives no verdict", () => {
  const lena = "lena@example.invalid";

  it("a mailbox whose provider gives no verdict still learns its senders' names", () => {
    for (const authVerdict of ["unavailable", "unauthenticated", null, undefined]) {
      const book = addressBook(readerOf([msg({ from: who(lena, "Lena Eichspan"), authVerdict })]));
      expect(book.find((e) => e.address === lena)?.name, String(authVerdict)).toBe("Lena Eichspan");
    }
  });

  it("a From the provider marked as failing teaches no name, even where nothing else names the address", () => {
    const book = addressBook(readerOf([
      msg({ id: "a", from: who(lena, "PayPal Service"), authVerdict: "fail", date: ago(1) }),
      msg({ id: "b", from: who(lena), authVerdict: "unavailable", date: ago(2) }),
    ]));
    expect(book.find((e) => e.address === lena)?.name).toBe("");
  });

  it("the account's own label for an address beats a newer unchecked From name", () => {
    // Its own label: a letter it started itself. A Sent copy could be a reply repeating the name.
    const book = addressBook(readerOf(
      [msg({ id: "weak", from: who(lena, "PayPal Service"), authVerdict: "unavailable", date: ago(0) })],
      [{ id: "d1", status: "sent", inReplyToMessageId: null, to: [who(lena, "Lena Eichspan")], cc: [], updatedAt: ago(9) }],
    ));
    const entry = book.find((e) => e.address === lena);
    expect(entry?.name).toBe("Lena Eichspan");
    expect(entry?.nameUnchecked).toBeUndefined();
  });

  it("a passed From name beats a newer unchecked one", () => {
    const book = addressBook(readerOf([
      msg({ id: "pass", from: who(lena, "Lena Eichspan"), authVerdict: "pass", date: ago(9) }),
      msg({ id: "weak", from: who(lena, "PayPal Service"), authVerdict: null, date: ago(0) }),
    ]));
    expect(book.find((e) => e.address === lena)?.name).toBe("Lena Eichspan");
  });

  it("between two unchecked From names the newer one is shown", () => {
    const book = addressBook(readerOf([
      msg({ id: "old", from: who(lena, "Lena E."), authVerdict: "unavailable", date: ago(9) }),
      msg({ id: "new", from: who(lena, "Lena Eichspan"), authVerdict: "unavailable", date: ago(1) }),
    ]));
    expect(book.find((e) => e.address === lena)?.name).toBe("Lena Eichspan");
  });
});

describe("the robots", () => {
  it("recognises the obvious ones, punctuation and case notwithstanding", () => {
    for (const a of [
      "noreply@x.invalid", "no-reply@x.invalid", "NoReply@x.invalid",
      "donotreply@x.invalid", "do-not-reply@x.invalid",
      "mailer-daemon@x.invalid", "MAILER-DAEMON@x.invalid",
      "bounces@x.invalid", "bounce@x.invalid",
      "postmaster@x.invalid", "nobody@x.invalid",
    ]) {
      expect(isRobotAddress(a), a).toBe(true);
    }
  });

  it("does NOT condemn a real person whose name merely resembles one", () => {
    // The list is short and matched on the whole local part on purpose. A heuristic that
    // guessed harder would eventually hide somebody real, and that costs far more than one
    // dead suggestion does.
    for (const a of [
      "noreplyman@x.invalid", "bouncer@x.invalid", "post@x.invalid",
      "daemon.jones@x.invalid", "reply@x.invalid", "nora@x.invalid",
    ]) {
      expect(isRobotAddress(a), a).toBe(false);
    }
  });

  it("keeps them out of the book entirely", () => {
    const book = addressBook(readerOf([
      msg({ id: "a", from: who("noreply@shop.invalid", "Shop") }),
      msg({ id: "b", from: who("lena@example.invalid") }),
    ]));
    expect(book.map((e) => e.address)).toEqual(["lena@example.invalid"]);
  });
});

describe("the ranking", () => {
  it("FREQUENCY LEADS: someone written to often outranks a stranger who wrote an hour ago", () => {
    // The failure this prevents is the one that makes an address book useless — the top
    // suggestion being whoever happened to send something most recently.
    const book = addressBook(readerOf([
      ...Array.from({ length: 8 }, (_, i) => msg({ id: `f${i}`, from: who("often@example.invalid"), date: ago(20) })),
      msg({ id: "r", from: who("recent@example.invalid"), date: ago(0) }),
    ]));
    expect(book[0]!.address).toBe("often@example.invalid");
  });

  it("…but recency breaks a tie between two of comparable weight", () => {
    const book = addressBook(readerOf([
      msg({ id: "a", from: who("stale@example.invalid"), date: ago(400) }),
      msg({ id: "b", from: who("fresh@example.invalid"), date: ago(1) }),
    ]));
    expect(book.map((e) => e.address)).toEqual(["fresh@example.invalid", "stale@example.invalid"]);
  });

  it("the order is TOTAL, so the list cannot flicker between equal candidates", () => {
    // A comparator that returns 0 for two different entries leaves the order to the engine's
    // sort stability, which is how a suggestion list reshuffles as unrelated mail arrives.
    const same = ago(3);
    const book = addressBook(readerOf([
      msg({ id: "a", from: who("b@example.invalid"), date: same }),
      msg({ id: "b", from: who("a@example.invalid"), date: same }),
    ]));
    expect(book.map((e) => e.address)).toEqual(["a@example.invalid", "b@example.invalid"]);
  });
});

describe("matching what is typed", () => {
  const book: AddressBookEntry[] = [
    { address: "lena@atelier.invalid", name: "Lena Eichspan", count: 5, lastAt: now, evidence: "we_wrote" },
    { address: "andreas@example.invalid", name: "Andreas Roth", count: 3, lastAt: now, evidence: "they_wrote" },
    { address: "mara@example.invalid", name: "", count: 2, lastAt: now, evidence: "sender_named" },
  ];

  it("matches a PREFIX of the address", () => {
    expect(matchAddresses(book, "len").map((e) => e.address)).toEqual(["lena@atelier.invalid"]);
  });

  it("matches a prefix of ANY word in the name, so a surname is reachable", () => {
    expect(matchAddresses(book, "eich").map((e) => e.address)).toEqual(["lena@atelier.invalid"]);
    expect(matchAddresses(book, "roth").map((e) => e.address)).toEqual(["andreas@example.invalid"]);
  });

  it("matches a prefix of the DOMAIN, so a company finds its people", () => {
    expect(matchAddresses(book, "example").map((e) => e.address).sort())
      .toEqual(["andreas@example.invalid", "mara@example.invalid"]);
  });

  it("is a PREFIX and not a substring — typing `an` must not offer everything with `an` in it", () => {
    // Substring matching is what makes a suggestion list feel random: `an` would hit
    // "Eichspan", "atelier" and every address containing the pair.
    const hits = matchAddresses(book, "an").map((e) => e.address);
    expect(hits).toEqual(["andreas@example.invalid"]);
  });

  it("an empty query offers nothing — the field is not a browsable directory", () => {
    expect(matchAddresses(book, "")).toEqual([]);
    expect(matchAddresses(book, "   ")).toEqual([]);
  });

  it("is case-insensitive and honours the limit", () => {
    expect(matchAddresses(book, "LENA")).toHaveLength(1);
    expect(matchAddresses(book, "example", 1)).toHaveLength(1);
  });
});

/**
 * ═══ WHO PUT THE ADDRESS HERE OUTRANKS HOW OFTEN IT APPEARS ══════════════════════════════
 *
 * `count + recency` are things a sender produces on demand, so with the score alone the top
 * suggestion for a colleague's NAME belongs to whoever sent the most mail most recently — and
 * the `From` display name is the sender's own writing, so they choose the name too. The
 * misdirected send is an ordinary user accepting the first suggestion.
 */
describe("the ranking cannot be bought with volume", () => {
  const colleague = who("nora@atelier.invalid", "Nora Lindt");
  const stranger = who("nora@elsewhere.invalid", "Nora Lindt");

  /** Twenty inbound messages from the stranger, against two the account itself sent. */
  const world = (): EntityReader => readerOf([
    ...Array.from({ length: 20 }, (_, i) => msg({
      id: `s${i}`, from: stranger, to: [who("me@example.invalid")], date: ago(0),
    })),
    msg({ id: "out1", folder: "Sent", from: who("me@example.invalid"), to: [colleague], date: ago(30) }),
    msg({ id: "out2", folder: "Sent Items", from: who("me@example.invalid"), to: [colleague], date: ago(29) }),
  ]);

  it("the colleague the account has WRITTEN to is the first suggestion, not the loud stranger", () => {
    const book = addressBook(world(), { exclude: ["me@example.invalid"] });
    expect(book.map((e) => e.address)).toEqual(["nora@atelier.invalid", "nora@elsewhere.invalid"]);
    // …and typing the shared display name offers ours first.
    expect(matchAddresses(book, "nora").map((e) => e.address)).toEqual([
      "nora@atelier.invalid", "nora@elsewhere.invalid",
    ]);
  });

  it("the score still decides WITHIN a class — the stranger's volume is not thrown away", () => {
    const book = addressBook(readerOf([
      ...Array.from({ length: 5 }, (_, i) => msg({ id: `a${i}`, from: who("loud@x.invalid"), date: ago(0) })),
      msg({ id: "b", from: who("quiet@x.invalid"), date: ago(0) }),
    ]));
    expect(book.map((e) => e.address)).toEqual(["loud@x.invalid", "quiet@x.invalid"]);
  });

  it("names the evidence on every entry — our record, their mail, or a sender's claim", () => {
    const book = addressBook(readerOf(
      [
        msg({ id: "in", from: who("writer@x.invalid"), to: [who("named@x.invalid")] }),
        msg({ id: "out", folder: "Sent", from: who("me@x.invalid"), to: [who("written@x.invalid")] }),
      ],
      [{ id: "d1", status: "sent", to: [who("drafted@x.invalid")], cc: [], updatedAt: ago(2) }],
    ));
    const by = new Map(book.map((e) => [e.address, e.evidence]));
    expect(by.get("written@x.invalid")).toBe("we_wrote");
    expect(by.get("drafted@x.invalid")).toBe("we_wrote");
    expect(by.get("writer@x.invalid")).toBe("they_wrote");
    // The one that used to be indistinguishable from the other two: a `To` a sender wrote.
    expect(by.get("named@x.invalid")).toBe("sender_named");
  });

  it("an address only a sender ever named ranks below one that has written to us", () => {
    const book = addressBook(readerOf([
      // Ten mentions in strangers' recipient lists against one real correspondent.
      ...Array.from({ length: 10 }, (_, i) => msg({
        id: `n${i}`, from: who(`bot${i}@x.invalid`), to: [who("named@x.invalid")], date: ago(0),
      })),
      msg({ id: "real", from: who("real@x.invalid"), date: ago(20) }),
    ]));
    const order = book.map((e) => e.address);
    expect(order.indexOf("real@x.invalid")).toBeLessThan(order.indexOf("named@x.invalid"));
  });
});

describe("what gets written into the field", () => {
  it("name and address when a name is known, the bare address when not", () => {
    expect(formatRecipient({ address: "lena@x.invalid", name: "Lena", count: 1, lastAt: 0, evidence: "they_wrote" }))
      .toBe("Lena <lena@x.invalid>");
    expect(formatRecipient({ address: "mara@x.invalid", name: "", count: 1, lastAt: 0, evidence: "they_wrote" }))
      .toBe("mara@x.invalid");
  });

  it("drops a name the recipient field's splitter could not read back", () => {
    // The field's value is ONE comma-separated string and its splitter is blind to quoting, so
    // "Ingold, Andreas" — the Exchange/Outlook default — became two entries, the first of which
    // is not an address, and one invalid entry empties the whole envelope. The bare address is
    // the honest thing to write: the envelope is the address, the name is sugar.
    for (const name of ["Ingold, Andreas", "Ingold; Andreas", 'Andi "The Boat" Ingold', "a <b> c"]) {
      expect(formatRecipient({ address: "andi@x.invalid", name, count: 1, lastAt: 0, evidence: "they_wrote" }), name)
        .toBe("andi@x.invalid");
    }
    // Everything a splitter CAN read back still rides along — the dash in the reported name
    // among them, which is why that report was about the name and not about the formatting.
    expect(formatRecipient({
      address: "andi@x.invalid", name: "Bootsvermietung Enge GmbH - Andreas Ingold",
      count: 1, lastAt: 0, evidence: "they_wrote",
    })).toBe("Bootsvermietung Enge GmbH - Andreas Ingold <andi@x.invalid>");
  });
});
