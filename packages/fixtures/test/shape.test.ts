/**
 * Shape sanity: the fixture world must match the prototype world
 * exactly — the counts the UI renders are assertions about this data.
 */
import { describe, expect, it } from "vitest";
import {
  account,
  composeDraft,
  counts,
  fictionalNames,
  getFixtures,
  guardFrom,
  mailboxes,
  NAMESPACE_EXEMPTION,
  notificationSettings,
  ohbox,
  parseGuardList,
  PUBLIC_GUARD,
  reads,
  readsAiChip,
  readsWaterline,
  receipts,
  receiptsGroups,
  screenedOut,
  search,
  spam,
  tags,
  tagsOf,
  triage,
  waiting,
  type GuardLists,
} from "@ohmail/fixtures";
import { GUARD_LIST_ENV, maskEntries, PRIVATE_MODE, privateGuardText, privateModeIt } from "../../../test/support/guard-list.js";

describe("screener world", () => {
  it("holds 3 waiting, 2 screened out, 2 spam", () => {
    expect(waiting).toHaveLength(3);
    expect(screenedOut).toHaveLength(2);
    expect(spam).toHaveLength(2);
    expect(counts.screenerWaiting).toBe(3);
  });

  it("every waiting sender carries held bodies and an AI suggestion", () => {
    for (const w of waiting) {
      expect(w.held.length).toBeGreaterThan(0);
      for (const h of w.held) expect(h.body.length).toBeGreaterThan(20);
      expect(w.ai.confidence).toBeGreaterThan(0);
      expect(w.ai.rationale.length).toBeGreaterThan(0);
    }
    expect(waiting.map((w) => w.ai.dest)).toEqual(["ohbox", "reads", "screened"]);
    expect(waiting.find((w) => w.id === "lena")?.held).toHaveLength(2);
  });

  it("spam items keep detection metadata", () => {
    expect(spam.map((s) => s.detection.confidence)).toEqual([0.98, 0.96]);
    expect(spam[0].detection.label).toBe("auto-detected · 0.98 · phishing fingerprint");
    expect(spam[1].detection.label).toBe("auto-detected · 0.96 · lookalike domain (cinderl0ck)");
  });
});

/**
 * NO-COLLAPSE (the "Demo/public content" invariant). A screener record may never say "8 held" unless
 * eight renderable messages are behind it, and it may never keep a "newest
 * body" beside a count — that is exactly how held mail became hidden mail.
 */
describe("no-collapse: held mail", () => {
  const everyHeldBag = () => [
    ...waiting.map((w) => w.held),
    ...screenedOut.map((s) => s.held),
    ...spam.map((s) => s.held),
  ];

  it("every screener record's held bag is non-empty and fully rendered", () => {
    for (const bag of everyHeldBag()) {
      expect(bag.length).toBeGreaterThan(0);
      for (const h of bag) {
        expect(h.id.length).toBeGreaterThan(0);
        expect(h.subject.length).toBeGreaterThan(0);
        expect(h.time.length).toBeGreaterThan(0);
        expect(h.body.length).toBeGreaterThan(20);
      }
    }
  });

  it("held messages carry their own identity — corpus-wide unique", () => {
    const ids = everyHeldBag().flatMap((bag) => bag.map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("screened-out senders carry every held message — '8 held' means eight", () => {
    const fashion = screenedOut.find((s) => s.address === "promo@fashion-deals.example")!;
    expect(fashion.held).toHaveLength(8);
    expect(fashion.held.map((h) => h.id)).toEqual([
      "fd-1",
      "fd-2",
      "fd-3",
      "fd-4",
      "fd-5",
      "fd-6",
      "fd-7",
      "fd-8",
    ]);
    // Oldest first, newest last — the row's summary line.
    expect(fashion.held[fashion.held.length - 1]!.subject).toBe(
      "Mid-Season Sale: bis 70% auf alles",
    );
    const forum = screenedOut.find((s) => s.address === "notifications@old-forum.example")!;
    expect(forum.held).toHaveLength(2);
  });

  it("spam is held viewable, in full, per sender", () => {
    expect(spam.map((s) => s.held.length)).toEqual([1, 1]);
    expect(spam[0].held[0].trackerNote).toBe("12 tracking links blocked");
  });

  it("no screener record carries a count or a last-body beside its bag", () => {
    for (const rec of [...waiting, ...screenedOut, ...spam] as Array<
      Record<string, unknown>
    >) {
      for (const forbidden of ["heldCount", "lastSubject", "lastBody", "subject", "body"]) {
        expect(rec[forbidden]).toBeUndefined();
      }
    }
  });
});

/**
 * PRIVACY (the "Demo/public content" invariant): zero real personal data, zero real brands.
 *
 * The ban list is never spelled out here: it is the guard's private list where
 * the run names it (OHMAIL_GUARD_LIST, read by test/support/guard-list.ts; `guardFrom`
 * parses it), else the synthetic set in src/privacy.ts. So this file holds no
 * planted copies, and the corpus is expected to carry no entry at all.
 */
describe("privacy guard", () => {
  /**
   * Every string reachable from a value, at every depth.
   *
   * Split out of {@link everyString} so the positive control below can run the SAME walk over a
   * mutated copy of the real corpus. A control that re-implements the walk proves the list and
   * nothing about the reach, which is the half that was wrong: two `PRODID` values sat inside the
   * calendar invitations' attachment bodies for months — reached by this walk the whole time, and
   * simply not on the list.
   */
  function stringsIn(value: unknown): string[] {
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(value);
    return out;
  }

  /** Every renderable string of the world, at every depth (held mail included). */
  function everyString(): string[] {
    const out: string[] = stringsIn(getFixtures());
    // The registry's own review prose is corpus too: a note or a named
    // collision that spells out a banned brand is still that brand living in
    // this repository. Mirrors `fixtureCorpus()` on the macOS side.
    for (const f of fictionalNames) {
      out.push(f.note);
      if (f.collision) out.push(f.collision);
    }
    return out;
  }

  /**
   * THE CORPUS IS JUDGED AGAINST BOTH LISTS, and only the corpus is.
   *
   * The shared list is also read by two scans over PRODUCT code (the mobile sources, the folder
   * paths), where naming a vendor is the point, so the corpus-only half carries the terms that are a
   * leak in the demo world and ordinary product prose everywhere else (its docblock in `privacy.ts`
   * says why it exists). The lists are the private ones where this checkout holds them, else the
   * public synthetic set — and every message names an entry by its INDEX, never by the term.
   */
  const guard = guardFrom(privateGuardText());
  const corpusBanned = (g: GuardLists): readonly string[] => [...g.shared, ...g.corpusOnly];
  const CORPUS_BANNED = corpusBanned(guard);
  /** The indices of the entries `text` carries, matched as the guard matches: a lower-cased substring. */
  const hitsIn = (text: string, terms: readonly string[]): number[] => {
    const lower = text.toLowerCase();
    return terms.flatMap((term, i) => (lower.includes(term) ? [i] : []));
  };

  privateModeIt(
    "PRIVATE MODE — the run names the private list, and the list is broad",
    () => {
      expect(guard.mode, `${GUARD_LIST_ENV} names the private list`).toBe("private");
      expect(guard.shared.length).toBeGreaterThan(15);
      expect(guard.corpusOnly.length).toBeGreaterThan(0);
    },
  );

  it.runIf(!PRIVATE_MODE)(
    "PUBLIC MODE — the run names no private list: every reader runs on the synthetic set",
    () => {
      expect(guard === PUBLIC_GUARD).toBe(true);
    },
  );

  it("both lists are lower-cased, and the corpus-only half is DISJOINT from the shared one", () => {
    // A term on both would make one of the two lists a lie about its own scope.
    for (const g of [guard, PUBLIC_GUARD]) {
      const lowered = corpusBanned(g).flatMap((t, i) => (t === t.toLowerCase() ? [] : [i]));
      expect(lowered, `${g.mode}: entries not lower-cased, by index`).toEqual([]);
      const both = g.corpusOnly.flatMap((t, i) => (g.shared.includes(t) ? [i] : []));
      expect(both, `${g.mode}: corpus-only entries also shared, by index`).toEqual([]);
      expect(g.corpusOnly.length).toBeGreaterThan(0);
    }
  });

  it("no banned term appears anywhere in the corpus", () => {
    const found = hitsIn(everyString().join("\n"), CORPUS_BANNED);
    expect(found, `${guard.mode} entries in the corpus, by index`).toEqual([]);
  });

  it("the private list's parser refuses a bad row by its LINE, never by quoting it", () => {
    const parsed = parseGuardList("# a comment\nzqone\tshared\tidentity,namespace\nzqtwo words\tshared\tbrand\nzqthree\tcorpus\tvendor\n");
    expect([parsed.mode, parsed.shared.length, parsed.corpusOnly.length]).toEqual(["private", 2, 1]);
    expect(parsed.roles.namespace).toEqual(["zqone"]);
    const refused: Array<[text: string, line: number]> = [
      ["zqone\tshared", 1], // two cells
      ["# a comment\nZqUpper\tshared\tbrand", 2], // not lower case
      ["zqone\tshared\tbrand\nzqone\tcorpus\tvendor", 2], // listed twice
      ["zqone\televen\tbrand", 1], // no such list
      ["zqone\tshared\tnamespace", 1], // a role with no class
      ["zqone\tshared\tbrand,vendor", 1], // two classes
    ];
    for (const [text, line] of refused) {
      let message = "";
      try {
        parseGuardList(text);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(`line ${line}:`);
      expect(message.toLowerCase().includes("zq"), `line ${line}: the refusal quoted the row`).toBe(false);
    }
    expect(() => parseGuardList("# only a comment\n")).toThrow(/no shared entry/);
    expect(guardFrom(null) === PUBLIC_GUARD).toBe(true);
  });

  it("a red's path or folder is masked by index, longest entry first, whatever its case", () => {
    // Synthetic and overlapping on purpose: masked shortest first, the longer entry would leave a fragment.
    const lists = { shared: ["zqab", "zqabcd"], corpusOnly: ["zq.x"] };
    expect(maskEntries("src/ZQABCD-zqab/Zq.X.ts", lists)).toBe("src/[#1]-[#0]/[#2].ts");
  });

  it("the walk really reaches held mail at every depth", () => {
    const strings = everyString();
    // A body that only exists inside a screened-out sender's held bag.
    expect(strings).toContain(screenedOut[0].held[3].body);
    // A body that only exists inside a spam sender's held bag.
    expect(strings).toContain(spam[1].held[0].body);
    // A body that only exists as a waiting sender's second held message.
    expect(strings).toContain(waiting[0].held[1].body);
  });

  /**
   * ── THE CONTROL THAT WOULD HAVE FOUND THE TWO THIS GUARD MISSED ─────────────────────────
   *
   * Two `PRODID` values once carried real calendar brands inside the `text/calendar` bodies of the
   * two invitations, technical provenance nothing on screen ever shows, and this guard was green
   * the whole time because neither term was on a list. So every entry is planted alone into a copy
   * of the REAL corpus at the depth those two hid at, upper-cased, and the REAL predicate must catch
   * it: the arm fails if the walk stops short of attachment bodies or the comparison stops being a
   * case-insensitive substring test. With the private list that is every real entry, read from it
   * and never printed; the public set is planted in every checkout, a public one included.
   */
  function plantedWorld(term: string): unknown {
    const world = structuredClone(getFixtures()) as {
      ohbox: Array<{ attachment?: { content?: string } }>;
    };
    // `content` is optional on the shape: most attachments are a filename and a size, and only
    // the two calendar parts carry bytes. Optional at BOTH hops, or this reads as a corpus with
    // no invitation in it.
    const invite = world.ohbox.find((m) => m.attachment?.content?.includes("BEGIN:VCALENDAR"));
    expect(invite, "no calendar attachment in the corpus — this control is about nothing")
      .toBeDefined();
    const before = invite!.attachment!.content!;
    invite!.attachment!.content = invite!.attachment!.content!.replace(
      "PRODID:-//ohmail demo//EN",
      () => `PRODID:-//${term.toUpperCase()} Inc//${term.toUpperCase()} Calendar 70.9054//EN`,
    );
    expect(invite!.attachment!.content !== before, "the PRODID line moved: nothing was planted").toBe(true);
    return world;
  }

  /** The entries of `g` the real predicate MISSED when each was planted alone: indices, never terms. */
  function missedInCorpus(g: GuardLists): number[] {
    const terms = corpusBanned(g);
    expect(terms.length).toBeGreaterThan(0);
    expect(hitsIn(stringsIn(getFixtures()).join("\n"), terms), `${g.mode}: hits before planting`).toEqual([]);
    const missed = terms.flatMap((term, i) =>
      hitsIn(stringsIn(plantedWorld(term)).join("\n"), terms).includes(i) ? [] : [i],
    );
    // And the untouched corpus is still clean: each planted copy was the only difference.
    expect(hitsIn(stringsIn(getFixtures()).join("\n"), terms)).toEqual([]);
    return missed;
  }

  privateModeIt(
    "PRIVATE MODE — every private entry planted where the two real brands hid is caught",
    () => {
      expect(guard.mode).toBe("private");
      expect(missedInCorpus(guard), "private entries missed, by index").toEqual([]);
    },
  );

  it("PUBLIC SET — every synthetic entry planted where the two real brands hid is caught", () => {
    expect(missedInCorpus(PUBLIC_GUARD), "synthetic entries missed, by index").toEqual([]);
  });

  it("every display name the UI can render is in the reviewed registry", () => {
    const registry = new Set(fictionalNames.map((f) => f.name));
    const rendered = [
      account.displayName,
      ...[...ohbox, ...reads, ...receipts].map((m) => m.from.name),
      ...waiting.map((w) => w.from.name),
      ...notificationSettings.vips,
    ];
    for (const name of rendered) expect(registry).toContain(name);
  });

  // A waiting row shows one timestamp and one subject; both must belong to the
  // SAME message or the row describes mail that does not exist. The row uses
  // the newest held message, so the sender's own stamp has to agree with it.
  it("a waiting sender's timestamp is its newest held message's timestamp", () => {
    for (const w of waiting) {
      const newest = w.held[w.held.length - 1]!;
      expect(w.time, `${w.id}: row time and row subject would come from different mail`).toBe(
        newest.time,
      );
    }
  });

  it("every registry entry states why it is safe", () => {
    for (const entry of fictionalNames) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(6);
    }
    expect(new Set(fictionalNames.map((f) => f.name)).size).toBe(fictionalNames.length);
  });

  // The registry's previous failure mode was a note that merely SOUNDED
  // reviewed — nine live brands certified as coined, because "coined ..." is
  // exactly as cheap to type as the truth. These two tests make the honest
  // and the dishonest entry different lengths.
  it("every registry entry carries one of the four falsifiable verdicts", () => {
    const allowed = new Set(["coined", "near-collision", "descriptive", "invented-person"]);
    for (const entry of fictionalNames) {
      expect(allowed, `${entry.name} has no verdict`).toContain(entry.verdict);
    }
  });

  it("a near-collision must name the real entity it collided with", () => {
    for (const entry of fictionalNames) {
      if (entry.verdict === "near-collision") {
        // Silence is not a review. If a twin was found, it gets written down.
        expect(entry.collision, `${entry.name} claims near-collision but names no twin`)
          .toBeTruthy();
        expect(entry.collision!.length).toBeGreaterThan(10);
      }
      if (entry.verdict === "invented-person") expect(entry.collision).toBeUndefined();
    }
    // And the verdict has to be load-bearing: at least one entry admits a twin,
    // otherwise the whole registry has quietly reverted to "everything coined".
    expect(fictionalNames.some((f) => f.verdict === "near-collision")).toBe(true);
  });

  it("the documented namespace exemption names exactly one banned term, by its role", () => {
    // The exemption exists so the ban list is not silently self-contradicting. If the term leaves
    // the list, or a second row takes the role, the exemption is stale — fail. Public mode has none.
    const named = guard.roles[NAMESPACE_EXEMPTION.role] ?? [];
    expect(named.length).toBe(guard.mode === "private" ? 1 : 0);
    expect(named.every((term) => guard.shared.includes(term)), "the exempt term is not shared").toBe(true);
    expect(NAMESPACE_EXEMPTION.until.length).toBeGreaterThan(10);
    expect(NAMESPACE_EXEMPTION.uiRule).toContain("folderLeaf");
  });

  it("the renamed senders are the coined ones, not the real brands they collided with", () => {
    expect(reads.find((m) => m.id === "f5")?.from).toEqual({
      name: "Gratbrief",
      address: "post@gratbrief.example",
    });
    expect(reads.find((m) => m.id === "f12")?.from).toEqual({
      name: "Röstsonntag",
      address: "hallo@roestsonntag.example",
    });
    expect(receipts.find((r) => r.id === "roestsonntag")?.from.address).toBe(
      "hallo@roestsonntag.example",
    );
  });

  // The second naming sweep: nine names that read as coined were live brands.
  // Pin the replacements by value — including the persona's own address, which
  // was a real design agency's registered domain and therefore on screen in
  // every screenshot.
  it("the second-sweep renames are pinned, addresses included", () => {
    // The persona's own mail domain — the worst of the nine, because it was a
    // real design agency's registered domain and it sits in every screenshot.
    expect(account.email).toBe("mila@lichtgrat.example");
    expect(mailboxes[0]!.name).toBe("lichtgrat.example");
    expect(reads.find((m) => m.id === "f3")?.from).toEqual({
      name: "Wohnfalz",
      address: "news@wohnfalz.example",
    });
    expect(waiting.find((w) => w.id === "lena")?.from.address).toBe("lena@atelier-eichspan.example");
    // Both halves of the phishing demo must be fictional: a real security
    // company must not be the brand the product is shown catching an
    // impersonation of.
    const verifier = ohbox.find((m) => m.from.name === "Cinderlock");
    expect(verifier?.from.address).toBe("no-reply@cinderlock.example");
    expect(spam.some((s) => s.from === "support@cinderl0ck-secure.example")).toBe(true);
  });
});

describe("reads", () => {
  it("has 12 unseen above the waterline and 3 seen below", () => {
    expect(reads).toHaveLength(15);
    expect(reads.filter((m) => m.unread)).toHaveLength(12);
    expect(reads.filter((m) => !m.unread)).toHaveLength(3);
    expect(counts.reads).toBe(12);
    // The anchor is the newest already-SEEN issue: the line renders directly above f13,
    // so the twelve unseen ones (f1–f12) all stand above the line.
    expect(readsWaterline.newestSeenId).toBe("f13");
    expect(readsWaterline.meta).toBe("last visit · Mon 18:40");
  });

  it("every reads item has a sender address and a full body", () => {
    for (const m of reads) {
      expect(m.from.address).toContain("@");
      expect(m.body!.length).toBeGreaterThan(40);
    }
  });

  it("carries the pending AI classification chip", () => {
    expect(readsAiChip.confidence).toBe(0.87);
    expect(readsAiChip.afterId).toBe("f1");
  });

  it("keeps the Wohnfalz issue's inline product art around the [[img]] split", () => {
    const wohnfalz = reads.find((m) => m.id === "f3")!;
    expect(wohnfalz.body).toContain("[[img]]");
    expect(wohnfalz.art?.caption).toBe("KLAPPRI — klappbar, wandmontiert");
  });
});

describe("ohbox", () => {
  /**
   * THIRTEEN IN THE FOLDER, ELEVEN ON THE SCREEN — and the gap is the whole point, not slack.
   *
   * `nadja` and `jonas` are the Answer Later pile. Parking moves nothing on the mail server, so
   * they are Ohbox mail and belong to this array and to `counts.ohboxTotal`; the one-pile rule
   * then holds them out of every Ohbox group, so the screen shows the other eleven. The two ids
   * are pinned as the LAST two because the showcase reads rows by index, and because it is the
   * fact `client-engine/test/selectors.test.ts` depends on when it asserts the visible eleven.
   *
   * `techcheck` and `glazecall` are the meeting-invite pair (an invitation and an Outlook
   * counter-proposal), each carrying a servable `text/calendar` part so the demo can show the
   * event card. Both READ since the 2026-08-31 landing review, like `cinderlock`: the demo
   * opens with exactly THREE unread rows (giulia — the threaded one — petra and ben) so the
   * "Earlier" group stands above the fold under the landing's callouts, and the invite pair
   * plus the spent verification code read as this morning's already-handled mail at its top.
   * `landing-mailbox-truth.test.ts` pins the story from the landing's side.
   */
  it("lists 13 messages — 11 the Ohbox shows, plus the 2 parked in Answer Later", () => {
    expect(ohbox).toHaveLength(13);
    expect(ohbox.filter((m) => m.unread)).toHaveLength(3);
    expect(ohbox.filter((m) => m.unread).map((m) => m.id)).toEqual(["giulia", "petra", "ben"]);
    expect(ohbox.filter((m) => !m.unread)).toHaveLength(10);
    expect(counts.ohboxUnread).toBe(3);
    expect(counts.ohboxTotal).toBe(13);
    // The parked pair, last and read: mail you have seen and owe more than a line.
    expect(ohbox.slice(-2).map((m) => m.id)).toEqual(["nadja", "jonas"]);
    expect(ohbox.slice(-2).every((m) => !m.unread)).toBe(true);
    // What the Ohbox screen is left with — the eleven, in order, opening on Giulia.
    expect(ohbox.slice(0, 11).map((m) => m.id)).toEqual([
      "giulia",
      "petra",
      "techcheck",
      "glazecall",
      "cinderlock",
      "ben",
      "anna",
      "reto",
      "flurina",
      "tim",
      "carla",
    ]);
  });

  it("the meeting-invite pair carries servable calendar parts — nameless, as the wire sends them", () => {
    for (const id of ["techcheck", "glazecall"]) {
      const m = ohbox.find((f) => f.id === id)!;
      expect(m.attachment?.filename).toBe("");
      expect(m.attachment?.contentType).toContain("text/calendar");
      expect(m.attachment?.content).toContain("BEGIN:VEVENT");
    }
    // The counter-proposal really is a COUNTER with the time it proposes to replace.
    const counter = ohbox.find((f) => f.id === "glazecall")!;
    expect(counter.attachment!.content).toContain("METHOD:COUNTER");
    expect(counter.attachment!.content).toContain("X-MS-OLDSTART");
  });

  it("keeps the OTP message labelled and out of AI, but shown in full", () => {
    const otp = ohbox.find((m) => m.id === "cinderlock")!;
    expect(otp.protected?.kind).toBe("verification");
    // Body redaction was removed: the IMAP mailbox already holds the code
    // unredacted, so hiding the display copy only hid the account holder's own mail from the
    // account holder. Body and snippet now carry the full code — pinned by value so a copy edit
    // cannot quietly reinstate the redaction that ruling retired.
    expect(otp.body).toContain("481 920");
    expect(otp.snippet).toContain("481 920");
    expect(otp.protected?.label).toBe("Verification code");
    expect(otp.protected?.redactedNote).toBe("kept out of AI");
    // The policy string is the claim under test. It must promise the user sees the code
    // in full AND that only what a model would read is stripped — the MODEL gate survives.
    // The negative half stays pinned: the AI-OPEN ruling of 2026-08-08 made the old
    // absolute `/never sent to AI/` false (a suggestion the user asks for reads this mail
    // with the code stripped), and a copy edit reinstating it is the drift this test catches.
    expect(otp.protected?.policy).toMatch(/see it in full/i);
    expect(otp.protected?.policy).toMatch(/stripped/);
    expect(otp.protected?.policy).not.toMatch(/never sent to AI/);
    expect(otp.rationale).toMatch(/^Sensitive class: verification/);
  });

  it("keeps Giulia's thread, rationale and tracker chip", () => {
    const giulia = ohbox.find((m) => m.id === "giulia")!;
    expect(giulia.threadCount).toBe(4);
    expect(giulia.rationale).toMatch(/learned from you · 14×/);
    expect(giulia.trackerNote).toBe("1 spy pixel blocked (open-tracker)");
  });
});

describe("receipts", () => {
  it("lists 7 receipts with bodies, grouped Today/Tuesday/Monday", () => {
    expect(receipts).toHaveLength(7);
    expect(receiptsGroups.map((g) => g.label)).toEqual(["Today", "Tuesday", "Monday"]);
    expect(receiptsGroups.flatMap((g) => g.items)).toEqual([
      "brandung",
      "kino",
      "erdton",
      "roestsonntag",
      "speichenhof",
      "alpenbahn",
      "pigment",
    ]);
    for (const r of receipts) expect(r.body!.length).toBeGreaterThan(40);
  });

  it("carries the amounts shown right-aligned", () => {
    expect(receipts.find((r) => r.id === "brandung")?.amount).toBe("CHF 96.00");
    expect(receipts.find((r) => r.id === "erdton")?.amount).toBe("CHF 240.00");
    expect(receipts.find((r) => r.id === "pigment")?.amount).toBe("€31.40");
  });
});

describe("tags", () => {
  it("defines the three hues with their assignments (2/2/2)", () => {
    expect(tags.map((t) => [t.id, t.hue, t.assignedTo.length])).toEqual([
      ["pottery", "moss", 2],
      ["buch", "ochre", 2],
      ["privat", "rosewood", 2],
    ]);
    expect(tags.map((t) => t.name)).toEqual([
      "Pottery Project",
      "Paperwork",
      "Adventures",
    ]);
  });

  it("resolves assignments from the message side", () => {
    expect(tagsOf("giulia").map((t) => t.id)).toEqual(["pottery"]);
    expect(tagsOf("erdton").map((t) => t.id)).toEqual(["buch"]);
    expect(tagsOf("tim").map((t) => t.id)).toEqual(["privat"]);
    expect(tagsOf("cinderlock")).toEqual([]);
  });
});

describe("triage", () => {
  it("mirrors the piles: 2 answer later, 1 parked, 1 resurface at Fri 09:00", () => {
    expect(triage.replyLater).toHaveLength(2);
    /*
     * NOT `giulia` AND `petra`, and that is the assertion. Those two were this pile until the
     * one-pile rule shipped and took them out of the Ohbox with it, which cost the demo its
     * opening message and its attachment row. The pile names mail written for it instead, and
     * `ohbox`'s own test pins the nine that stayed.
     */
    expect(triage.replyLater.map((e) => e.messageId)).toEqual(["nadja", "jonas"]);
    // Every entry is message-backed, so the pile can be opened and replied to in the demo — an
    // orphan `triage_item` renders a row that nothing can open (`fixtures-adapter.ts`).
    for (const e of triage.replyLater) expect(ohbox.some((m) => m.id === e.messageId)).toBe(true);
    expect(triage.setAside).toHaveLength(1);
    expect(triage.resurface).toHaveLength(1);
    expect(triage.resurface[0].title).toBe("Domain renewal lichtgrat.example");
    expect(triage.resurface[0].resurfaceAt).toBe("Fri 09:00");
    expect(counts.replyLater).toBe(2);
  });
});

describe("search demo", () => {
  it('finds 2 results for "invoce" in 11 ms with facets', () => {
    expect(search.query).toBe("invoce");
    expect(search.resultCount).toBe(2);
    expect(search.hits).toHaveLength(2);
    expect(search.tookMs).toBe(11);
    expect(search.hits[0].fuzzyNote).toContain("invoice");
    expect(search.hits[1].subject).toBe("Invoice #078 — Pottery Workshop — CHF 240.00");
    expect(search.facets.map((f) => f.title)).toEqual(["From", "Folder", "Refine", "Date"]);
  });
});

describe("compose draft", () => {
  it("is the grounded Giulia reply", () => {
    expect(composeDraft.to.address).toBe("giulia@terracotta-milano.example");
    expect(composeDraft.body).toContain("il 4 agosto va benissimo");
    expect(composeDraft.grounding).toContain("14 previous replies to Giulia");
    expect(composeDraft.grounding).toContain("Delivery replies — standard note");
  });
});

describe("notification settings", () => {
  it("matches the prototype defaults and VIP list", () => {
    expect(
      notificationSettings.channels.map((c) => [c.id, c.enabled]),
    ).toEqual([
      ["people", true],
      ["known", true],
      ["reads", false],
      ["receipts", false],
      ["screener", false],
    ]);
    expect(notificationSettings.vips).toEqual(["Petra Wyss", "Giulia Ferrari"]);
  });
});

describe("getFixtures()", () => {
  it("returns the whole world, wired", () => {
    const f = getFixtures();
    expect(f.mailboxes).toHaveLength(3);
    expect(f.mailboxes.map((m) => m.name)).toEqual([
      "lichtgrat.example",
      "milabrunner.example",
      "Wolkenmail",
    ]);
    expect(f.account.email).toBe("mila@lichtgrat.example");
    expect(f.screener.waiting).toBe(waiting);
    expect(f.ohbox).toBe(ohbox);
    expect(Object.keys(f.screener.emptyStates)).toEqual(["waiting", "screened", "spam"]);
  });
});
