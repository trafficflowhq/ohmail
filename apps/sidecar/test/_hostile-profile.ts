/**
 * THE HOSTILE SETTINGS COPIES: the key that carries what a person stated for every install, written
 * as anything a writer to the mailbox's settings folder could put there. Shared by the in-process
 * test (`organizer-profile-hostile-notices.test.ts`) and its twin on real mail servers
 * (`organizer-profile-hostile-notices.imap.test.ts`).
 */
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage,
  type OrganizerProfileDoc, type OrganizerProfilePayload,
} from "@trafficflow/core/adapters/organizer-profile";

export const NOW = new Date("2026-11-10T09:00:00.000Z");
export const STATED_AT = "2026-11-09T18:30:00.000Z";
export const FAR_AHEAD = "2099-01-01T00:00:00.000Z";
/** Stands in every free text of the planted copy: it may be seen nowhere afterwards. */
export const MARK = "zqhostile";
export const pair = (value: unknown, at: unknown): string => JSON.stringify({ subject: { value, at } });

/** The key's value as JSON text, each a way of saying something a reader must not take. */
export const HOSTILE: ReadonlyArray<readonly [name: string, json: string]> = [
  ["a word", `"each"`],
  ["a number", `7`],
  ["true", `true`],
  ["null", `null`],
  ["a list", `[${pair("each", STATED_AT)}]`],
  ["the member as a word", `{"subject":"each"}`],
  ["the member as a list", `{"subject":["each","${STATED_AT}"]}`],
  ["the word in other letters", pair("EACH", STATED_AT)],
  ["a word outside the pair", pair("every", STATED_AT)],
  ["an empty word", pair("", STATED_AT)],
  ["a number for the word", pair(1, STATED_AT)],
  ["a list for the word", pair(["each"], STATED_AT)],
  ["a record for the word", pair({ value: "each" }, STATED_AT)],
  ["no instant", `{"subject":{"value":"each"}}`],
  ["the instant as a number", pair("each", Date.parse(STATED_AT))],
  ["the instant without its fraction", pair("each", "2026-11-09T18:30:00Z")],
  ["the instant as a day", pair("each", "2026-11-09")],
  ["the instant as a sentence", pair("each", `${MARK} yesterday evening`)],
  ["the member through a prototype", `{"__proto__":${pair("each", STATED_AT)}}`],
  ["the word through a prototype", `{"subject":{"__proto__":{"value":"each","at":"${STATED_AT}"}}}`],
  ["what a notice or a wake is made of", JSON.stringify({
    endpoint: `https://collector.example/${MARK}`, p256dh: `${MARK}-key`, auth: `${MARK}-auth`, distributor: `${MARK}.distributor`,
    text: `${MARK} see you then`, title: `${MARK} Catalogue weekly`, pairing: false, master: true, showTitles: true, hideTitles: false,
    ohbox: false, cal_alert: true, summaryAt: 99_999, dormancyDays: -4,
  })],
];

/**
 * Instants in the very form `toISOString` writes, before 1970: the year 0, a year before it, and the
 * earliest instant a date holds. A store refuses each of them.
 */
export const BEFORE_1970 = ["0000-06-15T00:00:00.000Z", "-000001-01-01T00:00:00.000Z", "-271821-04-20T00:00:00.000Z"] as const;

/** Every copy planted where a store takes copies in: the hostile values, a date far ahead, and the instants before 1970. */
export const PLANTED: ReadonlyArray<readonly [name: string, json: string]> = [
  ...HOSTILE,
  ["a date far ahead", pair("head", FAR_AHEAD)],
  ...BEFORE_1970.map((at) => [`an instant before 1970, ${at}`, pair("each", at)] as const),
];

export const PAYLOAD: OrganizerProfilePayload = {
  screener: [{ address: "anna@example.org", name: "Anna" }], rules: [], notifyRules: [], awayResponder: null, tagNames: ["kiln"], signature: null,
};
export const SOMEONE_ELSE = "another-install";

/** A settings message whose document carries `preferences` as exactly this JSON text; `null` for no key. */
export function messageWith(preferencesJson: string | null, at: Date, by: string = SOMEONE_ELSE): string {
  const doc = makeProfileDoc(PAYLOAD, { updatedAt: at, producer: { kind: "local", version: "test" }, preferences: {} });
  const message = formatProfileMessage(doc, { installId: by });
  if (preferencesJson === null) return message;
  const body = JSON.stringify({ ...doc, preferences: "@@" }, null, 2).replace(`"@@"`, preferencesJson);
  return `${message.slice(0, message.indexOf("{"))}${body.replace(/\n/g, "\r\n")}\r\n`;
}

export function docOf(raw: string): OrganizerProfileDoc {
  const parsed = parseProfileMessage(raw);
  if (parsed === null || isMalformedProfile(parsed) || parsed.status !== "ok") throw new Error("the planted copy was not read");
  return parsed.doc!;
}
