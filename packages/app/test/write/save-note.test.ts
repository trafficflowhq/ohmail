/**
 * WHETHER THE LETTER IS KEPT, IN ITS NOTE (the switch's point 68): the close refusal first, then (the ceiling's own line
 * between) the account's refusal to keep it, said only where the ceiling does not already say why, then the resumed note.
 */
import { describe, expect, it } from "vitest";
import { saveLines } from "../../src/write/status/save-note.js";

const WORDS = { notSaved: "not saved", resumed: "resumed" };
const none = {
  closeRefusal: null,
  ceiling: false,
  saveRefused: false,
  resumed: false,
  elsewhere: "none",
} as const;

describe("the letter's save lines", () => {
  it("say nothing of a letter that is kept", () => {
    expect(saveLines(none, WORDS)).toEqual({ before: [], after: [] });
  });

  it("put the close refusal first and the rest after the ceiling, in rank", () => {
    expect(
      saveLines({ ...none, closeRefusal: "stayed open", saveRefused: true, resumed: true }, WORDS),
    ).toEqual({
      before: ["stayed open"],
      after: ["not saved", "resumed"],
    });
  });

  it("leave the account's refusal to the ceiling's line where the words are too long", () => {
    expect(saveLines({ ...none, ceiling: true, saveRefused: true }, WORDS)).toEqual({
      before: [],
      after: [],
    });
  });

  it("over a letter whose row went elsewhere: no resumed note, and the refusal only of words typed since", () => {
    const refused = { ...none, saveRefused: true, resumed: true };
    expect(saveLines({ ...refused, elsewhere: "untyped" }, WORDS)).toEqual({ before: [], after: [] });
    expect(saveLines({ ...refused, elsewhere: "typed" }, WORDS)).toEqual({
      before: [],
      after: ["not saved"],
    });
  });
});
