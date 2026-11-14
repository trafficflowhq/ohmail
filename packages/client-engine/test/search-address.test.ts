import { describe, expect, it } from "vitest";
import { OhmailEngine, addressMatchKey, folderLeaf } from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * ═══ ALL THE MAIL FROM AND TO ONE ADDRESS — the device half of the address view ══════════
 *
 * The reported ask: search rows show a display name and hide the address, and there is no way
 * to say "show me everything involving this person". The second half is the one with no
 * mechanism behind it at all — `SearchIndex` posts TOKENS, and `tokenize` splits on every
 * non-alphanumeric character, so `jonas@lichtgrat.example` enters the index as `jonas`,
 * `lichtgrat` and `example`. Asking that index for an address gets you every message from
 * anybody called Jonas and every message from anybody at any studio.
 *
 * So the guard here is not "does the search find the address". It is:
 *
 *  1. BOTH DIRECTIONS, ONE LIST. The demo's `jonas` is mail FROM `jonas`'s own address;
 *     replying to it sends mail TO the same address through the real send path
 *     (`sentOverlayMessage`, `folder: "Sent"`). One address, one call, both messages — which is
 *     the acceptance case, and which nothing in this tree could answer before.
 *  2. THE DIRECTIONS SEPARATE. `from` returns the received message and not the reply; `to`
 *     returns the reply and not the received message.
 *  3. CASE FOLDS AND NOTHING ELSE DOES. The mutation for this is one character
 *     (`addressMatchKey`'s `toLowerCase()`), and it reddens this case alone.
 *  4. THE COUNTS ARE A UNION, NOT A SUM. A message with the address on both sides is counted
 *     once in `any` — the number under a toggle has to survive the reader counting the rows.
 *  5. IT IS AN EQUALITY, NOT A SUBSTRING. The address's tail and its prefix
 *     are nobody, and a selector that answered them would put a stranger's mail on the screen
 *     under somebody else's name.
 */

/** The demo's one message with a real audience: from Jonas, to Mila and Rahel, cc Tobias. */
const JONAS = "jonas@lichtgrat.example";
/** One of `jonas`'s To recipients — a message this account RECEIVED that also names them. */
const RAHEL = "rahel@lichtgrat.example";
/** `jonas`'s Cc. `Cc` counts as `to` — see `AddressDirection`. */
const TOBIAS = "tobias@lichtgrat.example";
/** The account's own address — `jonas`'s first To, and therefore the sent overlay's From. */
const MILA = "mila@lichtgrat.example";

async function demoEngine(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

/**
 * Reply to the demo's `jonas`, which sends TO `jonas`'s address and mints the Sent-folder
 * overlay. Asserted `confirmed` rather than assumed: a send the adapter refused produces no
 * overlay at all, and every "to" assertion below would then be measuring a fixture that never
 * happened rather than a selector that works.
 */
async function replyToJonas(engine: OhmailEngine): Promise<void> {
  const res = await engine.mutate({
    kind: "mail_send",
    inReplyTo: "jonas",
    body: "The 18th works.",
  });
  expect(res.status).toBe("confirmed");
}

describe("messagesWith — one address, both directions", () => {
  it("returns a RECEIVED and a SENT message for one address in a single call", async () => {
    const engine = await demoEngine();

    // Before the reply there is only the received message.
    const before = engine.messagesWith(JONAS, "any");
    expect(before.counts).toEqual({ any: 1, from: 1, to: 0 });
    expect(before.items.map((h) => h.message.id)).toEqual(["jonas"]);

    await replyToJonas(engine);

    const after = engine.messagesWith(JONAS, "any");
    // TWO messages now, and they are the two DIRECTIONS of one correspondence.
    expect(after.counts).toEqual({ any: 2, from: 1, to: 1 });
    const received = after.items.find((h) => h.message.id === "jonas");
    const sent = after.items.find((h) => folderLeaf(h.message.folder) === "Sent");
    expect(received).toBeDefined();
    expect(sent).toBeDefined();
    // The received one is theirs; the sent one is ours, addressed to them.
    expect(received!.message.from.address).toBe(JONAS);
    expect(sent!.message.to.map((t) => t.address)).toContain(JONAS);

    // NEWEST FIRST. The reply is minted at `DEMO_NOW`; the fixture is older, so the reply leads.
    expect(folderLeaf(after.items[0]!.message.folder)).toBe("Sent");

    // An equality carries no relevance signal, and the selector says so rather than inventing
    // a score a caller might sort by.
    for (const hit of after.items) {
      expect(hit.score).toBe(0);
      expect(hit.matches).toEqual([]);
    }
  });

  it("`from` and `to` each return their own side and not the other", async () => {
    const engine = await demoEngine();
    await replyToJonas(engine);

    const from = engine.messagesWith(JONAS, "from");
    expect(from.items.map((h) => h.message.id)).toEqual(["jonas"]);

    const to = engine.messagesWith(JONAS, "to");
    expect(to.items).toHaveLength(1);
    expect(folderLeaf(to.items[0]!.message.folder)).toBe("Sent");
    expect(to.items[0]!.message.id).not.toBe("jonas");

    // The COUNTS do not move with the filter — the toggle labels all three from one call.
    expect(from.counts).toEqual({ any: 2, from: 1, to: 1 });
    expect(to.counts).toEqual(from.counts);
  });

  it("a To recipient of RECEIVED mail is a `to` match, and a Cc is the same", async () => {
    // The other half of "to": not only mail this account sent, but mail this account received
    // that also named the address. `jonas` names Rahel in To and Tobias in Cc.
    const engine = await demoEngine();

    const rahel = engine.messagesWith(RAHEL, "to");
    expect(rahel.items.map((h) => h.message.id)).toEqual(["jonas"]);
    expect(rahel.counts).toEqual({ any: 1, from: 0, to: 1 });
    // …and Rahel wrote none of it, so the `from` direction is empty rather than a fallback.
    expect(engine.messagesWith(RAHEL, "from").items).toHaveLength(0);

    const tobias = engine.messagesWith(TOBIAS, "to");
    expect(tobias.items.map((h) => h.message.id)).toEqual(["jonas"]);
  });

  it("case folds — the address is matched however either side spelled it", async () => {
    const engine = await demoEngine();
    await replyToJonas(engine);

    const lower = engine.messagesWith(JONAS, "any");
    expect(lower.items).toHaveLength(2);

    // THE MUTATION TARGET. Drop `toLowerCase()` in `addressMatchKey` and this case alone reds:
    // every other case in this file already spells the address the way the fixture does.
    for (const spelling of ["Jonas@Lichtgrat.Example", "JONAS@LICHTGRAT.EXAMPLE", "jonas@lichtgrat.example"]) {
      const res = engine.messagesWith(spelling, "any");
      expect(res.items.map((h) => h.message.id).sort()).toEqual(
        lower.items.map((h) => h.message.id).sort(),
      );
      expect(res.counts).toEqual(lower.counts);
    }

    // The rule is `lower()` and NOTHING ELSE — the key this device matches on is the key the
    // server's `messages_account_from_addr_idx` matches on. A trim here would make the device
    // answer a WIDER question than the archive.
    expect(addressMatchKey("Jonas@Lichtgrat.Example")).toBe(JONAS);
    expect(addressMatchKey(" jonas@lichtgrat.example ")).not.toBe(JONAS);
  });

  it("is an EQUALITY — no substring, no prefix, no token match", async () => {
    const engine = await demoEngine();
    await replyToJonas(engine);

    // A substring of the address, either end.
    expect(engine.messagesWith("onas@lichtgrat.example", "any").items).toHaveLength(0);
    expect(engine.messagesWith("jonas@lichtgrat", "any").items).toHaveLength(0);
    // The domain alone, and the local part alone — both are what a tokenized index would match.
    expect(engine.messagesWith("lichtgrat.example", "any").items).toHaveLength(0);
    expect(engine.messagesWith("jonas", "any").items).toHaveLength(0);
    // A different address at the same domain is a different person.
    expect(engine.messagesWith("jonas2@lichtgrat.example", "any").items).toHaveLength(0);
    // …while the TOKEN search still finds them, which is what shows these are two mechanisms
    // and not one made stricter.
    expect(engine.search("lichtgrat").items.length).toBeGreaterThan(0);
  });

  it("an address nobody in the mirror uses answers empty rather than everything", async () => {
    const engine = await demoEngine();
    const res = engine.messagesWith("nobody@nowhere.test", "any");
    expect(res.items).toHaveLength(0);
    expect(res.counts).toEqual({ any: 0, from: 0, to: 0 });
  });

  it("an EMPTY address answers empty — never the bucket of every headerless message", async () => {
    // `messages.from_address` is `NOT NULL DEFAULT ''` on the server, so a blank From is a real
    // row. If the empty key were stored, asking for "" would answer all of them at once — and
    // a caller reaches this by handing the selector an address it failed to parse.
    const engine = await demoEngine();
    for (const blank of ["", "   "]) {
      const res = engine.messagesWith(blank, "any");
      expect(res.items).toHaveLength(0);
      expect(res.counts).toEqual({ any: 0, from: 0, to: 0 });
    }
  });

  it("`any` counts a message on BOTH sides once — a union, never a sum", async () => {
    // THE SELF-CC SHAPE, which is the case a sum gets wrong. Reply to `jonas` and copy the
    // account's OWN address: the sent overlay's From is that address (it is the sender) and its
    // Cc is that address too. One message, on both sides.
    const engine = await demoEngine();
    const res = await engine.mutate({
      kind: "mail_send",
      inReplyTo: "jonas",
      body: "Copying myself.",
      cc: [{ name: null, address: MILA }],
    });
    expect(res.status).toBe("confirmed");

    const sent = engine.messagesWith(MILA, "any").items.find((h) => folderLeaf(h.message.folder) === "Sent");
    expect(sent).toBeDefined();
    // The premise this case rests on, asserted rather than assumed: the row really is on both
    // sides. Without it the union assertion below would pass over a fixture that never happened.
    expect(sent!.message.from.address).toBe(MILA);
    expect(sent!.message.cc.map((c) => c.address)).toContain(MILA);

    const both = engine.messagesWith(MILA, "any");
    // Two messages: the received `jonas` (MILA in To) and the reply (MILA on both sides).
    // `from` counts the reply; `to` counts BOTH. So from + to === 3 and the union is 2.
    expect(both.counts).toEqual({ any: 2, from: 1, to: 2 });
    expect(both.counts.from + both.counts.to).toBeGreaterThan(both.counts.any);
    // THE INVARIANT: the union IS the row count, which is the number the toggle prints over
    // this list. A sum here would say "All 3" above three rows one of which does not exist.
    expect(both.items).toHaveLength(both.counts.any);
  });

  it("a row whose folder is OUTSIDE the six-member union is included, and labelled by its leaf", async () => {
    // THE DEPENDENCY THIS SELECTOR MUST NOT HAVE. A sent copy's folder is `"Sent"` — not one of
    // the six `Folder` members and not a pile — so anything that reached the mirror by FOLDER
    // would miss every message this account ever sent. `messagesWith` selects on the from/to/cc
    // FIELDS and never on the folder, which is what makes the sent half work at all.
    const engine = await demoEngine();
    await replyToJonas(engine);

    const sent = engine.messagesWith(JONAS, "to").items[0]!;
    expect(folderLeaf(sent.message.folder)).toBe("Sent");
    // Outside the union, so a surface labels it through `folderLeaf` — the same fallback
    // `facetsOf` and the views use for any folder this client has no view for.
    expect(folderLeaf(sent.message.folder)).toBe("Sent");
  });

  it("sees a message that arrives AFTER the index was built", async () => {
    // The index is cached on the mirror's version stamp and shared with `search()`. A stale
    // cache here would show the address view a mailbox the search box says has moved on.
    const engine = await demoEngine();
    expect(engine.messagesWith(JONAS, "any").counts.to).toBe(0);
    await replyToJonas(engine);
    expect(engine.messagesWith(JONAS, "any").counts.to).toBe(1);
  });

  it("defaults to `any` when no direction is named", async () => {
    const engine = await demoEngine();
    await replyToJonas(engine);
    expect(engine.messagesWith(JONAS).items.map((h) => h.message.id).sort())
      .toEqual(engine.messagesWith(JONAS, "any").items.map((h) => h.message.id).sort());
  });
});
