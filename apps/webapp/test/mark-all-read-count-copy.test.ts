import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";

describe("a count of one is said in the singular", () => {
  it("the first run's History row and a Screener card's caption, in English and German", () => {
    const enT = createTranslator({ locale: "en", messages });
    const deT = createTranslator({ locale: "de", messages: de });
    expect(enT("onboarding.etaDone", { screened: 0, history: 1 })).toBe("Done. 0 screened, 1 listed under History.");
    expect(enT("onboarding.etaDone", { screened: 0, history: 12 })).toBe("Done. 0 screened, 12 listed under History.");
    expect(deT("onboarding.etaDone", { screened: 0, history: 1 })).toBe("Fertig. 0 sortiert, 1 unter Historie gelistet.");
    expect(enT("screener.heldCaption", { count: 1, time: "9:00" })).toBe("1 message — shown · first contact 9:00");
    expect(deT("screener.heldCaption", { count: 1, time: "9:00" }))
      .toBe("1 Nachricht — gezeigt · erster Kontakt 9:00");
    expect(enT("screener.heldCaption", { count: 12, time: "9:00" })).toBe("12 messages — all shown · first contact 9:00");
  });
});
