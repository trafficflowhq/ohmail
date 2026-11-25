/**
 * ═══ THE AWAY RESPONDER ON THE PHONE ════════════════════════════════════════
 *
 * `PUT /away-responder` IS A FULL REPLACE. The route stores exactly the fields in the body and
 * defaults the ones that are absent, so a client that sends three fields silently resets the
 * other four — and the four it would reset decide WHO is answered (`audience`), WHICH mail
 * (`piles`) and HOW OFTEN. This phone edits three fields, which makes the full replace the whole
 * design problem rather than a detail of it.
 *
 * So what is measured here is the wire and the derived output a person reads:
 *  · a save carries the row that was READ, verbatim in the four fields this screen cannot edit;
 *  · no read ⇒ no save. A default row would be a shape the PUT then writes;
 *  · the 202 is not a failure and not a success: nothing was written here, the values on screen
 *    are the server's, and the sentence says the organizing install applies it;
 *  · the switch's four states, including an end date already past with the responder still on;
 *  · a pile this build has no word for reaches the screen VERBATIM, never filtered — a filtered
 *    list states a narrower scope than the responder acts on;
 *  · an unknown audience member reads as the WIDE one, so the sentence never claims more
 *    protection than the row gives.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { readAway, saveAway } from "../src/net/away";
import type { ConnectedSession } from "../src/net/pairing";
import {
  awayAudienceWide, awayPileWords, awaySaveBlocked, awaySaveBody, awaySay, type AwayRow,
} from "../src/ui/away-form";
import { DECKS } from "../src/copy";

const NOW = new Date("2026-09-20T15:00:00.000Z");

const stored: AwayRow = {
  enabled: false,
  body: null,
  startsAt: null,
  endsAt: null,
  audience: "everyone",
  throttle: "per_week",
  piles: ["INBOX", "ohmail/Reads"],
  updatedAt: "2026-09-19T08:00:00.000Z",
};

/** A server that records what it was PUT and answers with whatever the case asks it to. */
function awayServer(answer: { status: number; body: Record<string, unknown> }) {
  const puts: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stored));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      puts.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  return { server, puts };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`);
    });
  });
}

function sessionFor(origin: string): ConnectedSession {
  return {
    profile: { origin, apiBase: null },
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
}

describe("the wire — one row in, the whole row back", () => {
  it("reads the stored row, and a save carries the four fields this phone cannot edit", async () => {
    const { server, puts } = awayServer({ status: 200, body: { ...stored, enabled: true, body: "back monday" } });
    const origin = await listen(server);
    try {
      const session = sessionFor(origin);
      const read = await readAway(session);
      expect(read).not.toBeNull();
      expect(read!.audience).toBe("everyone");
      expect(read!.piles).toEqual(["INBOX", "ohmail/Reads"]);

      const next = awaySaveBody(read, { enabled: true, body: "back monday", endsAt: null })!;
      const out = await saveAway(session, next);
      expect(out.kind).toBe("saved");

      const sent = puts[0]!;
      // THE WHOLE ROW, not the three fields. A partial write here is a silent reset of who gets
      // answered and which mail does — in the direction that sends mail to more people.
      expect(sent.audience).toBe("everyone");
      expect(sent.throttle).toBe("per_week");
      expect(sent.piles).toEqual(["INBOX", "ohmail/Reads"]);
      expect(sent.enabled).toBe(true);
      expect(sent.body).toBe("back monday");
      // `updatedAt` is the server's; sending it back would be this client claiming an episode.
      expect("updatedAt" in sent).toBe(false);
    } finally {
      server.close();
    }
  });

  it("a 202 is neither failure nor success: the row on screen is the SERVER's", async () => {
    const applied = { ...stored, enabled: true, body: "away", pending: true };
    const { server } = awayServer({ status: 202, body: applied });
    const origin = await listen(server);
    try {
      const session = sessionFor(origin);
      const out = await saveAway(session, { ...stored, enabled: true, body: "away" });
      expect(out.kind).toBe("asked");
      // The values the controls adopt come off the answer, never off what was typed.
      expect(out.kind === "asked" && out.row.enabled).toBe(true);
      expect(DECKS.en.awayAsked).toBe(
        "Not saved here — the machine that organizes this mailbox applies it on its next pass.",
      );
    } finally {
      server.close();
    }
  });

  it("a refusal names its status, and an unreachable server is not a row", async () => {
    const { server } = awayServer({ status: 400, body: { error: "endsAt" } });
    const origin = await listen(server);
    try {
      const out = await saveAway(sessionFor(origin), { ...stored, enabled: true, body: "x" });
      expect(out).toEqual({ kind: "refused", status: 400 });
    } finally {
      server.close();
    }
    // A closed port: the read answers null — "could not ask", which is never "off".
    const dead = sessionFor("http://127.0.0.1:1");
    expect(await readAway(dead)).toBeNull();
    expect(await saveAway(dead, stored)).toEqual({ kind: "refused", status: null });
  });
});

describe("no read, no save", () => {
  it("composes nothing without the row it would be replacing", () => {
    expect(awaySaveBody(null, { enabled: true, body: "away", endsAt: null }),
      "a save over a read that never landed writes the route's DEFAULTS for audience, piles and "
      + "throttle — silently narrowing a standing order somebody set elsewhere").toBeNull();
  });

  it("an empty message is stored as nothing written, not as the empty string", () => {
    expect(awaySaveBody(stored, { enabled: false, body: "   ", endsAt: null })!.body).toBeNull();
    expect(awaySaveBody(stored, { enabled: true, body: " away ", endsAt: null })!.body).toBe(" away ");
  });
});

describe("what the switch says", () => {
  const endsAt = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

  it("names four states, and an end date already past is its own", () => {
    expect(awaySay(false, null, NOW)).toBe("off");
    expect(awaySay(false, endsAt(-1), NOW), "off is off whatever date it carries").toBe("off");
    expect(awaySay(true, null, NOW)).toBe("on");
    expect(awaySay(true, endsAt(48), NOW)).toBe("onUntil");
    expect(awaySay(true, endsAt(-1), NOW)).toBe("expired");
  });

  it("an unreadable instant reads as open-ended, never as expired", () => {
    expect(awaySay(true, "not-a-date", NOW), '"the end date passed" is a claim about a date, and '
      + "a date nobody can read is not evidence for it").toBe("on");
  });

  it("the form refuses the save the server would refuse, and only that one", () => {
    expect(awaySaveBlocked({ enabled: true, body: "x", endsAt: endsAt(-1) }, NOW)).toBe(true);
    expect(awaySaveBlocked({ enabled: false, body: "x", endsAt: endsAt(-1) }, NOW),
      "turning it OFF with a stale date is the one save nobody may be prevented from making").toBe(false);
    expect(awaySaveBlocked({ enabled: true, body: "x", endsAt: endsAt(48) }, NOW)).toBe(false);
  });
});

describe("what the phone states but does not change", () => {
  it("has a word for every pile the wire can deliver", () => {
    /* `piles` is a CLOSED union on the wire (`dto/types.ts`: INBOX | ohmail/News | ohmail/Receipts
       | ohmail/Screener) and the service canonicalises the pre-0.22 spelling on read. So a key for
       a folder the wire cannot send is a DEAD key, and the one it does send falls through to
       `verbatim` — the phone then prints a raw folder name where the product's own word belongs. */
    const { known, verbatim } = awayPileWords(["INBOX", "ohmail/News", "ohmail/Receipts", "ohmail/Screener"]);
    expect(verbatim).toEqual([]);
    expect(known).toEqual(["ohbox", "reads", "receipts", "screener"]);
  });

  it("carries a pile this build has no word for through verbatim", () => {
    const { known, verbatim } = awayPileWords(["INBOX", "ohmail/Someday", "ohmail/Receipts"]);
    expect(known).toEqual(["ohbox", "receipts"]);
    expect(verbatim, "a filtered list states a NARROWER scope than the responder acts on — on "
      + "screen that reads as a promise that mail is not being answered when it is")
      .toEqual(["ohmail/Someday"]);
    expect(DECKS.en.awayPileOther("ohmail/Someday")).toBe("Also ohmail/Someday");
    expect(DECKS.de.awayPileOther("ohmail/Someday")).toBe("Auch ohmail/Someday");
  });

  it("an audience member this build never heard of reads as the WIDE one", () => {
    expect(awayAudienceWide("screened_in")).toBe(false);
    expect(awayAudienceWide("everyone")).toBe(true);
    expect(awayAudienceWide("anyone_at_all"), "unknown fails wide, so the sentence claims less "
      + "protection than the row might give, never more").toBe(true);
  });
});

describe("the sentences", () => {
  it("say what the webapp's away namespace says, word for word", () => {
    expect(DECKS.en.awayOn).toBe("On. Replies to new mail, from the mailbox it arrived in.");
    expect(DECKS.en.awayOff).toBe("Off. Nothing is sent.");
    expect(DECKS.en.awayUntilPast("24 Sept")).toBe("The end date passed on 24 Sept. Nothing is sent.");
    expect(DECKS.en.awayIncomplete).toBe("Add a message before turning this on.");
    expect(DECKS.en.awayUnreachable).toBe(
      "Your away settings could not be read just now. Nothing here has changed.",
    );
  });

  it("are in both catalogues, and the German deck is what a German reader gets", () => {
    for (const key of ["awayTitle", "awayOn", "awayNever", "awayAudienceLabel", "awayPilesLabel", "awayThrottleLabel", "awayWhereThisPhone"] as const) {
      expect(DECKS.de[key], `${key} is missing from the German deck`).toBeTruthy();
      expect(DECKS.de[key]).not.toBe(DECKS.en[key]);
    }
  });
});
