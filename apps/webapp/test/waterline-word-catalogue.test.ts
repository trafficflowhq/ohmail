/**
 * THE NEW SHELL's CATALOGUE KEEPS THE WATERLINE AND UNREAD APART: the sweep over every key for a bare "new" beside a
 * count, its exemptions, and the Ohbox's rail tooltip. Moved from `waterline-word.test.tsx` (whose other cases stand
 * over today's Reads and Receipts views until the streams' mount), and re-pointed by path from today's catalogue
 * (`apps/webapp/messages`) to the one the new shell draws its words from: every namespace of `packages/app/messages`,
 * merged as the frame's text provider merges them. The expectations are the old cases' word for word.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MESSAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/app/messages");

type Locale = "en" | "de";
/** Every namespace file of one language, merged key by key into one catalogue. */
function catalogueOf(locale: Locale): Record<string, unknown> {
  const merge = (into: Record<string, unknown>, from: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(from)) {
      const had = into[k];
      if (had && typeof had === "object" && v && typeof v === "object") merge(had as Record<string, unknown>, v as Record<string, unknown>);
      else into[k] = v;
    }
  };
  const all: Record<string, unknown> = {};
  for (const file of readdirSync(MESSAGES).filter((f) => f.endsWith(`.${locale}.json`)).sort()) {
    merge(all, JSON.parse(readFileSync(join(MESSAGES, file), "utf8")) as Record<string, unknown>);
  }
  return all;
}
const CATALOGUE: Record<Locale, unknown> = { en: catalogueOf("en"), de: catalogueOf("de") };

const at = (root: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>(
    (o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    root,
  );

/**
 * Every catalogue key a WATERLINE count is rendered through. Adding a surface that shows the
 * waterline means adding its key here, and the assertions below then require the clause.
 */
const WATERLINE_KEYS = [
  "stream.newSince",   // the Reads and Receipts pile header, list side and stream side
  "rail.readsTitle",   // the rail badge's tooltip, for both streams
  "markAll.ariaFresh", // Mark-all-read's label when the line stands over nothing unread
] as const;

/**
 * A COUNT WITH A BARE "NEW" BESIDE IT — the shape being ended. `{count}` in any of its ICU
 * spellings, or a plural arm's `#`, immediately followed by the word.
 */
const BARE_NEW = /(\{count[^{}]*\}|#)\s+(new|New|neu|neue|neues|Neu|Neue|Neues)\b/;

/**
 * The keys that match `BARE_NEW` and are not waterline sentences. Named rather than waived, and
 * the "no exemption has rotted" case below deletes a row the day its string moves — which is how
 * this table went from two rows to one: `ohbox.meta` was exempted while it still counted unread
 * under the word "new", and moved into `UNREAD_KEYS` when it took the noun.
 */
const BARE_NEW_EXEMPT: Record<string, string> = {
  "ohbox.newSince":
    "The chip on a RESURFACED CONVERSATION, counting the messages that arrived after the pin "
    + "went up. A per-row fact with its own referent — this conversation, since you asked to see "
    + "it again — and neither the waterline nor a mailbox unread count, so neither word would be "
    + "true. The face is two words because a badge face is; the sentence it stands for is "
    + "`ohbox.newSinceTitle`, which the badge carries as its title and the row speaks.",
  "frame.systemNotice.ohboxBody":
    "A push notification about mail that has just ARRIVED, which is a third fact and not a "
    + "standing count: the number is the messages that came in, and \"new\" is what they are. "
    + "No waterline and no read state is involved, so there is no second word to confuse it with.",
};

/* German only: "neue Absender" is the German for first-time senders (English "first-time
   senders", which this pattern never matches). The number counts SENDERS waiting in the Screener,
   not messages, so neither the waterline nor unread applies; "neu" is what the senders are. */
const BARE_NEW_EXEMPT_DE: Record<string, string> = {
  "ohbox.doorbellAria": "A count of first-time SENDERS waiting in the Screener (\"# neue Absender warten\"), not of messages.",
  "ohbox.emptyScreenerHint": "A count of first-time SENDERS waiting in the Screener, not of messages.",
  "screener.metaWaiting": "A count of first-time SENDERS waiting in the Screener, not of messages.",
  "screener.metaWaitingOnDevice": "A count of first-time SENDERS waiting in the Screener, not of messages.",
};

describe("the catalogues keep the waterline and unread apart", () => {
  it("the sweep can fire, and does not fire on ordinary copy", () => {
    /* The pattern is the whole guard, so it is pinned by example in both directions — a sweep
       that matches nothing passes over a catalogue full of the defect. */
    for (const yes of ["{count} new", "{count, number} new", "{count} neu", "one {# new}"]) {
      expect(BARE_NEW.test(yes), `${yes} is the shape being ended`).toBe(true);
    }
    for (const no of ["{count} unread", "New", "{count} newer messages", "Nothing new"]) {
      expect(BARE_NEW.test(no), `${no} is not the shape being ended`).toBe(false);
    }
  });

  for (const locale of ["en", "de"] as const) {
    describe(locale, () => {
      it("the Ohbox's rail tooltip states the unread number alone: no total the device cannot know", () => {
        /* It once said "of M messages": the mirror's three groups, a window's count on a large mailbox and never the
           Ohbox's; the store answers no Ohbox total. Its one figure is the unread count. */
        const s = at(CATALOGUE[locale], "rail.ohboxTitle");
        expect(typeof s, `${locale} rail.ohboxTitle is missing`).toBe("string");
        expect([...(s as string).matchAll(/\{\s*(\w+)/g)].map((m) => m[1]), `${locale} rail.ohboxTitle states a second figure`)
          .toEqual(["unread"]);
      });

      it("no other key writes a bare \"new\" beside a count", () => {
        const hits: string[] = [];
        const walk = (o: unknown, prefix: string): void => {
          if (o == null || typeof o !== "object") return;
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            const dotted = prefix ? `${prefix}.${k}` : k;
            if (typeof v === "string") {
              if (BARE_NEW.test(v) && !(WATERLINE_KEYS as readonly string[]).includes(dotted)
                  && !(dotted in BARE_NEW_EXEMPT)
                  && !(locale === "de" && dotted in BARE_NEW_EXEMPT_DE)) {
                hits.push(`${dotted}  ${JSON.stringify(v)}`);
              }
            } else walk(v, dotted);
          }
        };
        walk(CATALOGUE[locale], "");
        expect(
          hits,
          "a count is being rendered with a bare \"new\" beside it. If it is the waterline, say "
            + "so in the sentence and add the key to WATERLINE_KEYS; if it is an unread count, "
            + "say \"unread\"; if it is neither, add a row to BARE_NEW_EXEMPT saying which.",
        ).toEqual([]);
      });

      it("every exemption still matches a live string", () => {
        const exempt = { ...BARE_NEW_EXEMPT, ...(locale === "de" ? BARE_NEW_EXEMPT_DE : {}) };
        for (const [key, why] of Object.entries(exempt)) {
          const s = at(CATALOGUE[locale], key);
          expect(typeof s, `${locale} ${key} is exempted but gone — delete the row`).toBe("string");
          expect(BARE_NEW.test(s as string), `${locale} ${key} no longer needs its exemption`)
            .toBe(true);
          expect(why.length, `${key} has no reason`).toBeGreaterThan(40);
        }
      });
    });
  }
});
