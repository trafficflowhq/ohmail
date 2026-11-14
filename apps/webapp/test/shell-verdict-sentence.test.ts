/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import type { StayVerdict } from "@ohmail/client-engine";
import type { Folder } from "@ohmail/wire";
import { verdictArgs, verdictKeyOf } from "@ohmail/app-logic/press/press-verdict";
import { placeLabel } from "@ohmail/app-logic/text/format";
import { displayDomain } from "@ohmail/app-logic/text/idn";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { message, mountShell, stubDom, unmountAll } from "./_draft-shell";

type T = (key: string, values?: Record<string, string | number>) => string;
const verdictSentence = (t: T, v: Exclude<StayVerdict, { key: "none" }>, sender: string, place: string) =>
  t(`screening.${verdictKeyOf(v)}`, verdictArgs(v, {
    sender, place, history: t("screening.placeHistory"), label: placeLabel, domain: displayDomain,
  }));
const tEn = createTranslator({ locale: "en", messages: en as Record<string, unknown> }) as unknown as T;
const tDe = createTranslator({ locale: "de", messages: de as Record<string, unknown> }) as unknown as T;
const still = (stillPlace: string | null): Exclude<StayVerdict, { key: "none" }> =>
  ({ key: "still", count: 5, still: 1, stillPlace, ids: ["h-1"], movable: true }) as Exclude<StayVerdict, { key: "none" }>;

afterEach(unmountAll);

describe("the shell's verdict sentence names the one staying place", () => {
  it("a row kept in History is said to be in History, in en and de", () => {
    expect(verdictSentence(tEn, still(null), "info@shop.example", "Ohbox")).toBe("5 are in Ohbox · 1 is still in History.");
    const de1 = verdictSentence(tDe, still(null), "info@shop.example", "Ohbox");
    expect(de1).toContain(de.screening.placeHistory);
    expect(de1).not.toContain("History");
  });

  it("the positive control: a row in a folder is said to be in that folder", () => {
    expect(verdictSentence(tEn, still("Fixture"), "info@shop.example", "Ohbox")).toBe("5 are in Ohbox · 1 is still in Fixture.");
  });

  it("sayVerdict toasts this function's sentence, never its own copy", async () => {
    stubDom();
    const from = { name: "Fixture sender", address: "sender@example.invalid" };
    const letters = Array.from({ length: 5 }, (_, i) => message(`incoming-${i}`, { from }));
    letters.push(message("retained", { from, folder: "Fixture" as Folder }));
    await mountShell("#/screener", letters, []);
    const row = screen.getByRole("option", { name: /Fixture sender/ });
    fireEvent.contextMenu(row);
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("Ohbox"));
    expect(await screen.findByText(verdictSentence(tEn, still("Fixture"), from.address, "Ohbox"))).toBeTruthy();
  });
});
