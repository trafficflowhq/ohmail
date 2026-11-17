import { describe, expect, it } from "vitest";
import { CONNECT_STATES, saidOfState } from "@ohmail/app-logic/mailboxes/connect/states";
import { CONNECT_PURPOSES } from "@ohmail/app-logic/mailboxes/connect/types";
import { CONNECT_NAMESPACES } from "../../../src/mailboxes/connect/index.js";
import { EDIT_WORDS, FORM_WORDS, type Word } from "../../../src/mailboxes/connect/words.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import doorsDe from "../../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../../messages/doors.en.json" with { type: "json" };
import mailboxesDe from "../../../messages/mailboxes.de.json" with { type: "json" };
import mailboxesEn from "../../../messages/mailboxes.en.json" with { type: "json" };

type Catalogue = Record<string, Record<string, unknown>>;
const EN: Catalogue = { ...accountEn, ...doorsEn, ...mailboxesEn };
const DE: Catalogue = { ...accountDe, ...doorsDe, ...mailboxesDe };

/** Every word of a purpose's table, the nested ones too. */
function wordsOf(value: unknown): Word[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.ns === "string" && typeof record.key === "string") return [record as unknown as Word];
  return Object.values(record).flatMap(wordsOf);
}

describe("the form's words", () => {
  it("are a total table: every purpose has its row", () => {
    expect(Object.keys(FORM_WORDS).sort()).toEqual([...CONNECT_PURPOSES].sort());
  });

  it.each(CONNECT_PURPOSES)(
    "opened for %s, every word is a sentence of the catalogue, in English and in German",
    (purpose) => {
      const words = [...wordsOf(FORM_WORDS[purpose]), ...wordsOf(EDIT_WORDS)];
      expect(words.length).toBeGreaterThan(8);
      for (const { ns, key } of words) {
        expect(CONNECT_NAMESPACES).toContain(ns);
        expect(typeof EN[ns]?.[key], `${ns}.${key} in English`).toBe("string");
        expect(typeof DE[ns]?.[key], `${ns}.${key} in German`).toBe("string");
      }
    },
  );

  it("every state of a refused connect says a sentence the catalogue holds, in both languages", () => {
    for (const state of CONNECT_STATES) {
      const said = saidOfState(state);
      if (said === null || "server" in said) continue;
      expect(typeof EN[said.ns]?.[said.key], `${state.id}: ${said.ns}.${said.key}`).toBe("string");
      expect(typeof DE[said.ns]?.[said.key], `${state.id}: ${said.ns}.${said.key} in German`).toBe("string");
    }
  });
});
