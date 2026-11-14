import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";

describe("a count of one is said in the singular", () => {
  it("the first run's History row and a Screener card's caption, in English and German", () => {
    const enT = createTranslator({ locale: "en", messages });
    const deT = createTranslator({ locale: "de", messages: de });
    expect(enT("onboarding.doneHistory", { count: 1 })).toBe("1 message listed under History");
    expect(enT("onboarding.doneHistory", { count: 12 })).toBe("12 messages listed under History");
    expect(deT("onboarding.doneHistory", { count: 1 })).toBe("1 Nachricht unter Historie gelistet");
    expect(enT("screener.heldCaption", { count: 1, time: "9:00" })).toBe("1 message — shown · first contact 9:00");
    expect(deT("screener.heldCaption", { count: 1, time: "9:00" }))
      .toBe("1 Nachricht — gezeigt · erster Kontakt 9:00");
    expect(enT("screener.heldCaption", { count: 12, time: "9:00" })).toBe("12 messages — all shown · first contact 9:00");
  });
});
