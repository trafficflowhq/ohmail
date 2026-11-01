/**
 * THE FOUND-SETTINGS QUESTION ON THE PHONE — the seam's four calls and the card's decisions.
 *
 * The organizer holds its gate and its settings write while a found document is unanswered, so
 * a phone with nothing to answer it with froze both for ever. These cases hold the
 * phone's half: the door is asked on the session's own transport, only a fully formed answer asks
 * anything, each press reaches its own route with the exact subject, and the words are the web's.
 * The engine's side, over a real server, is `apps/sidecar/test/phone-settings-document.imap.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy, DECKS } from "../src/copy";
import { setActiveLocale } from "../src/i18n/locale";
import {
  answerProfileImport, questionOf, readImportStatus, readProfileImport, type ProfileImportQuestion, type ProfileImportSession,
} from "../src/net/profile-import";
import {
  ASK_AGAIN_NONE_MS, ASK_AGAIN_OPEN_MS, askTickets, askableRows, cardQuestion, countsSaid, failureSaid, importSubject, importingSaid,
  keptSaid, mailboxesToAsk, savedBySaid, savedRows,
} from "../src/ui/profile-import-card";
/* @reads: apps/mobile/src/ui/ProfileImportCard.tsx apps/mobile/src/state/world.tsx */

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FOUND = {
  state: "found",
  fingerprint: "f".repeat(64),
  updatedAt: "2026-09-26T09:40:51.000Z",
  producer: { kind: "local", version: "0.25.1" },
  counts: { screener: 58, rules: 3, notifyRules: 0, tags: 1, awayResponder: false },
};

interface Sent { url: string; method: string; body: unknown }

/** A session whose transport records what it was asked and answers from a script. */
function sessionAnswering(answer: (url: string) => Response | Promise<Response>, apiBase: string | null = null): {
  session: ProfileImportSession; sent: Sent[];
} {
  const sent: Sent[] = [];
  const session = {
    profile: { origin: "http://sidecar", apiBase },
    fetch: async (url: string, raw?: unknown) => {
      const init = raw as RequestInit | undefined;
      sent.push({
        url, method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return answer(url);
    },
  };
  return { session, sent };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the door is read tolerantly — only a fully formed answer asks anything", () => {
  it("reads found, declined and newer, and everything else as none", () => {
    expect(questionOf(FOUND).state).toBe("found");
    expect(questionOf({ ...FOUND, state: "declined" }).state).toBe("declined");
    expect(questionOf({ state: "newer", v: 3 })).toEqual({ state: "newer", v: 3 });
    for (const odd of [
      null, {}, "found", { state: "none" }, { state: "too_large", fingerprint: "x", list: "rules", count: 9, max: 1 },
      { ...FOUND, fingerprint: "" }, { ...FOUND, counts: { ...FOUND.counts, rules: "3" } },
      { ...FOUND, producer: null }, { state: "newer", v: 2.5 }, { ...FOUND, state: "offered" },
    ]) {
      expect(questionOf(odd), JSON.stringify(odd)).toEqual({ state: "none" });
    }
  });

  it("asks on the session's own door, off its API base, and a failed read is null — never none", async () => {
    const paired = sessionAnswering(() => json(200, FOUND), "https://mail.example.test/api");
    expect((await readProfileImport(paired.session, "mb 1"))?.state).toBe("found");
    expect(paired.sent).toEqual([{ url: "https://mail.example.test/api/mailboxes/mb%201/profile-import", method: "GET", body: null }]);
    expect(await readProfileImport(sessionAnswering(() => json(500, {})).session, "m")).toBeNull();
    expect(await readProfileImport(sessionAnswering(() => { throw new Error("offline"); }).session, "m")).toBeNull();
  });
});

describe("each press reaches its own route with the exact subject", () => {
  it("Import applies the fingerprint shown, Not now declines it, Save replaces it", async () => {
    const { session, sent } = sessionAnswering((url) =>
      url.endsWith("/profile-import")
        ? json(200, { imported: FOUND.counts, skippedRules: 1, seq: 4 })
        : json(200, { dismissed: true }));
    const fp = { fingerprint: FOUND.fingerprint };
    expect(await answerProfileImport(session, "m", "import", fp))
      .toEqual({ kind: "done", imported: { ...FOUND.counts, signature: false }, skippedRules: 1 });
    expect(await answerProfileImport(session, "m", "notNow", fp)).toEqual({ kind: "done", imported: null, skippedRules: 0 });
    expect(await answerProfileImport(session, "m", "save", fp)).toEqual({ kind: "done", imported: null, skippedRules: 0 });
    expect(await answerProfileImport(session, "m", "notNow", { v: 3 })).toMatchObject({ kind: "done" });
    expect(sent.map((s) => [s.method, s.url.replace("http://sidecar", ""), s.body])).toEqual([
      ["POST", "/mailboxes/m/profile-import", fp],
      ["POST", "/mailboxes/m/profile-import/decline", fp],
      ["POST", "/mailboxes/m/profile-import/replace", fp],
      ["POST", "/mailboxes/m/profile-import/decline", { v: 3 }],
    ]);
  });

  it("a refusal carries the door's own sentence, and a dead transport carries none", async () => {
    const said = sessionAnswering(() => json(409, { error: { code: "profile_changed", message: "The settings changed." } }));
    expect(await answerProfileImport(said.session, "m", "import", { fingerprint: "x" }))
      .toEqual({ kind: "refused", status: 409, message: "The settings changed." });
    const dead = sessionAnswering(() => { throw new Error("offline"); });
    expect(await answerProfileImport(dead.session, "m", "notNow", { fingerprint: "x" }))
      .toEqual({ kind: "refused", status: null, message: null });
    expect(failureSaid(null)).toBe(`${Copy.pfiErrorTitle} ${Copy.pfiErrorGeneric} ${Copy.pfiErrorRetry}`);
  });
});

describe("which mailbox asks, and where", () => {
  const row = (mailboxId: string, question: ProfileImportQuestion) => ({ mailboxId, address: `${mailboxId}@x.test`, question });

  it("the card takes the first open question; Settings takes every Not now still standing", () => {
    const declined = questionOf({ ...FOUND, state: "declined" });
    const rows = [row("a", { state: "none" }), row("b", declined), row("c", questionOf(FOUND)), row("d", { state: "newer", v: 3 })];
    expect(cardQuestion(rows)?.mailboxId).toBe("c");
    expect(cardQuestion([row("d", { state: "newer", v: 3 })])?.mailboxId).toBe("d");
    expect(cardQuestion([row("a", { state: "none" }), row("b", declined)])).toBeNull();
    expect(savedRows(rows).map((r) => r.mailboxId)).toEqual(["b"]);
  });

  it("says the counts in words, drops the zero parts, and names who saved it", () => {
    setActiveLocale("en");
    expect(countsSaid(FOUND.counts)).toBe("58 screener decisions, 3 rules, and 1 tag");
    expect(countsSaid({ screener: 0, rules: 0, notifyRules: 0, tags: 0, awayResponder: false })).toBe("");
    expect(countsSaid({ screener: 0, rules: 2, notifyRules: 0, tags: 0, awayResponder: true })).toBe("2 rules and your away reply");
    expect(countsSaid({ screener: 1, rules: 0, notifyRules: 0, tags: 0, awayResponder: false })).toBe("1 screener decision");
    expect(savedBySaid({ kind: "local" }, FOUND.updatedAt, "en")).toMatch(/^Saved .+ by ohmail on another computer\.$/);
    expect(savedBySaid({ kind: "mobile" }, FOUND.updatedAt, "en")).toMatch(/on a phone\.$/);
    expect(savedBySaid({ kind: "local" }, "not a date", "en")).toBeNull();
    setActiveLocale("de");
    expect(countsSaid(FOUND.counts)).toBe("58 Screener-Entscheidungen, 3 Regeln und 1 Tag");
    expect(countsSaid({ ...FOUND.counts, signature: true })).toBe("58 Screener-Entscheidungen, 3 Regeln, 1 Tag und deine Signatur");
    setActiveLocale("en");
  });

  it("names the signature only when the door counted one; an older door's answer still asks", () => {
    setActiveLocale("en");
    const older = questionOf(FOUND);
    expect(older.state === "found" && older.counts.signature).toBe(false);
    const signed = questionOf({ ...FOUND, counts: { ...FOUND.counts, signature: true } });
    expect(signed.state === "found" && countsSaid(signed.counts)).toBe("58 screener decisions, 3 rules, 1 tag, and your signature");
    expect(countsSaid({ screener: 0, rules: 0, notifyRules: 0, tags: 0, awayResponder: false, signature: true })).toBe("your signature");
  });

  /* AN IMPORT NEVER LOSES A SIGNATURE TYPED HERE (ruled 2026-11-01): the card says so before the
     press when the copy's replaces the one on this mailbox, only that press names it, and the
     done line says when the typed one stayed. */
  it("says the copy's signature replaces the one on this mailbox, Import names it, and a kept one is said", async () => {
    setActiveLocale("en");
    const receipt = "9".repeat(32);
    const q = questionOf({ ...FOUND, counts: { ...FOUND.counts, signature: true, signatureReplaces: receipt } });
    if (q.state !== "found") throw new Error("the door's answer asked nothing");
    expect(countsSaid(q.counts)).toBe("58 screener decisions, 3 rules, 1 tag, and your signature, replacing the one on this mailbox now");
    expect(countsSaid(q.counts, { replacing: false }), "the Replace note speaks of the mailbox's copy").toBe("58 screener decisions, 3 rules, 1 tag, and your signature");
    expect(importSubject(q)).toEqual({ fingerprint: FOUND.fingerprint, signatureReplaces: receipt });
    const plain = questionOf(FOUND);
    expect(plain.state === "found" && importSubject(plain)).toEqual({ fingerprint: FOUND.fingerprint });
    const odd = questionOf({ ...FOUND, counts: { ...FOUND.counts, signature: true, signatureReplaces: 7 } });
    expect(odd.state === "found" && odd.counts.signatureReplaces, "a receipt that is no string was kept").toBeUndefined();

    const kept = { ...FOUND.counts, signature: false, signatureKept: true };
    const { session, sent } = sessionAnswering(() => json(200, { imported: kept, skippedRules: 0, seq: 3 }));
    const a = await answerProfileImport(session, "m", "import", importSubject(q));
    expect(sent[0]!.body).toEqual({ fingerprint: FOUND.fingerprint, signatureReplaces: receipt });
    expect(a.kind === "done" && keptSaid(a.imported)).toBe("The signature you typed on this mailbox stays; the saved one was not imported.");
    expect(keptSaid({ ...FOUND.counts, signature: true }), "a done line without the flag said the signature stayed").toBeNull();
    setActiveLocale("de");
    expect(countsSaid(q.counts)).toBe("58 Screener-Entscheidungen, 3 Regeln, 1 Tag und deine Signatur, die die jetzige Signatur dieses Postfachs ersetzt");
    expect(keptSaid(kept)).toBe("Die Signatur, die du in diesem Postfach eingegeben hast, bleibt; die gespeicherte wurde nicht importiert.");
    setActiveLocale("en");
  });
});

describe("the card is asked for on the drain that carries the find", () => {
  /**
   * An organizer's find rings the settings doorbell (`profile.ts#writeMarker`); the phone reads it
   * as `World.mailboxes.settingsBell`. Before the ring existed the phone waited out a 60 s
   * throttle behind a `none`. Mutate `rang ||` out of `mailboxesToAsk` and the ring case goes red.
   */
  const T = 1_000_000;
  const asked = new Map([["a", T - 1_000], ["b", T - 2_000]]);
  const answers = { a: { state: "none" } as ProfileImportQuestion, b: questionOf(FOUND) };

  it("a rung doorbell asks every mailbox at once, whatever its throttle says", () => {
    expect(mailboxesToAsk(["a", "b", "c"], asked, answers, T, true)).toEqual(["a", "b", "c"]);
  });

  it("without a ring each mailbox waits out its own throttle, and a new one is asked", () => {
    expect(mailboxesToAsk(["a", "b", "c"], asked, answers, T, false)).toEqual(["c"]);
    expect(mailboxesToAsk(["a", "b"], asked, answers, T - 1_000 + ASK_AGAIN_NONE_MS, false)).toEqual(["a"]);
    expect(mailboxesToAsk(["a", "b"], asked, answers, T - 2_000 + ASK_AGAIN_OPEN_MS, false)).toEqual(["a", "b"]);
  });

  it("only the newest ask lands, and a press outranks every ask that left before it", () => {
    const t = askTickets();
    const older = t.begin("a");
    const newer = t.begin("a");
    expect(t.current("a", older), "a slower, older ask overwrote the ring's answer").toBe(false);
    expect(t.current("a", newer)).toBe(true);
    const inFlight = t.begin("b");
    t.supersede("b"); // Not now answered while the ask was out
    expect(t.current("b", inFlight), "an ask older than the answer brought the dismissed card back").toBe(false);
  });

  it("the hook asks through that rule with the world's doorbell, and the world reads the mirror's record", () => {
    const card = readFileSync(join(APP, "src/ui/ProfileImportCard.tsx"), "utf8");
    expect(card).toContain("const bell = w.mailboxes.settingsBell;");
    expect(card).toContain("for (const id of mailboxesToAsk(ids, asked.current, known.current, now, rang)) {");
    expect(card).toContain("if (mounted.current && q !== null && tickets.current(id, ticket))");
    expect(card).toMatch(/\}, \[session, w\.mailboxes\.rows, bell, tickets\]\);/);
    expect(card).toContain("tickets.supersede(mailboxId);");
    const world = readFileSync(join(APP, "src/state/world-projection.ts"), "utf8");
    expect(world).toContain('settingsBell: raw.entries("settings")[0]?.seq ?? null,');
  });
});

describe("a removed mailbox has no settings check", () => {
  /* VTF2-02 on the phone's card: a removal leaves the row `disabled`, and a check on it could only
     fail. Mutate the filter out of `askableRows` and the first case goes red. */
  it("drops a removed mailbox and keeps every other status, an unnamed one included", () => {
    const rows = [
      { id: "gone", status: "disabled" }, { id: "live", status: "connected" },
      { id: "failing", status: "error" }, { id: "older-server", status: null },
    ];
    expect(askableRows(rows).map((r) => r.id)).toEqual(["live", "failing", "older-server"]);
  });

  it("the hook asks, and lists, only through that rule", () => {
    const card = readFileSync(join(APP, "src/ui/ProfileImportCard.tsx"), "utf8");
    expect(card).toContain("const ids = askableRows(w.mailboxes.rows).map((r) => r.id);");
    expect(card).toContain("const rows = askableRows(w.mailboxes.rows)");
    expect(card).not.toMatch(/w\.mailboxes\.rows\s*\.(map|filter)\(/);
  });
});

describe("the phone and the browser say the same words", () => {
  it("the card's and the Settings row's static sentences are the web's, in both languages", async () => {
    const pairs: Array<[keyof typeof DECKS.en, string]> = [
      ["pfiTitle", "title"], ["pfiWillDo", "willDo"], ["pfiHeldRouting", "routingWhileOpen"],
      ["pfiImport", "import"], ["pfiImporting", "importing"],
      ["pfiLater", "later"], ["pfiDoneTitle", "doneTitle"], ["pfiDoneAction", "doneAction"],
      ["pfiErrorTitle", "errorTitle"], ["pfiErrorGeneric", "errorGeneric"], ["pfiErrorRetry", "errorRetry"],
      ["pfiNewerTitle", "newerTitle"], ["pfiAwayPart", "awayPart"], ["pfiSavedBody", "savedBody"],
      ["pfiReplace", "replace"], ["pfiReplacing", "replacing"], ["pfiReplaceNoteBare", "replaceNoteBare"],
      ["pfiReplacedTitle", "replacedTitle"], ["pfiSignaturePart", "signaturePart"],
      ["pfiSignatureReplacingPart", "signatureReplacingPart"], ["pfiDoneSignatureKept", "doneSignatureKept"],
    ];
    for (const lang of ["en", "de"] as const) {
      const web = (await import(`../../webapp/messages/${lang}.json`)).default.profileImport as Record<string, string>;
      for (const [phone, key] of pairs) expect(DECKS[lang][phone], `${lang} ${key}`).toBe(web[key]);
      expect(DECKS[lang].pfiLede("X")).toBe(web.lede!.replace("{address}", "X"));
      expect(DECKS[lang].pfiReplaceNote("X")).toBe(web.replaceNote!.replace("{details}", "X"));
      expect(DECKS[lang].pfiSavedTitle("X")).toBe(web.savedTitle!.replace("{address}", "X"));
    }
  });
});

describe("a press the organizer finishes (202), on the phone's own door", () => {
  it("a 202 is `importing` with its ticket — never a refusal, never 'done'", async () => {
    const door = sessionAnswering(() => json(202, { state: "importing", fingerprint: "f".repeat(64), reason: "slow" }));
    expect(await answerProfileImport(door.session, "m", "import", { fingerprint: "f".repeat(64) }))
      .toEqual({ kind: "importing", fingerprint: "f".repeat(64), reason: "slow" });
  });

  it("the status read settles it: done with what arrived, or the door's refusal; importing is no answer yet", async () => {
    const counts = { screener: 1, rules: 2, notifyRules: 0, tags: 1, awayResponder: false };
    const done = sessionAnswering(() => json(200, { state: "imported", imported: counts, skippedRules: 1 }));
    expect(await readImportStatus(done.session, "m", "f")).toEqual({ kind: "done", imported: { ...counts, signature: false }, skippedRules: 1 });
    expect(done.sent[0]!.url).toBe("http://sidecar/mailboxes/m/profile-import/status?fingerprint=f");
    const refused = sessionAnswering(() => json(200, { state: "refused", reason: "changed", message: "The settings changed." }));
    expect(await readImportStatus(refused.session, "m", "f")).toEqual({ kind: "refused", status: 200, message: "The settings changed." });
    const waiting = sessionAnswering(() => json(200, { state: "importing", fingerprint: "f" }));
    expect(await readImportStatus(waiting.session, "m", "f")).toBeNull();
  });

  it("the door's sentence is said ONCE; the generic line alone carries the retry", () => {
    expect(failureSaid("The settings changed.")).toBe(`${Copy.pfiErrorTitle} The settings changed.`);
    expect(failureSaid(null)).toBe(`${Copy.pfiErrorTitle} ${Copy.pfiErrorGeneric} ${Copy.pfiErrorRetry}`);
    expect(importingSaid("slow")).toBe(Copy.pfiImportingSlow);
    expect(importingSaid("unreachable")).toBe(Copy.pfiImportingUnreachable);
  });
});
