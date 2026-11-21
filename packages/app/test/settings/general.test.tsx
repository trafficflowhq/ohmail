/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralPane, generalState, type GeneralModel } from "../../src/settings/general/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import generalDe from "../../messages/settings-general.de.json" with { type: "json" };
import generalEn from "../../messages/settings-general.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const WORDS: Record<"en" | "de", Messages> = {
  en: { settings: settingsEn.settings, ...generalEn } as Messages,
  de: { settings: settingsDe.settings, ...generalDe } as Messages,
};

function mount(model: GeneralModel, locale: "en" | "de" = "en") {
  const view = (m: GeneralModel) => (
    <TextProvider locale={locale} messages={WORDS[locale]} timeZone="Europe/Zurich">
      <GeneralPane model={m} />
    </TextProvider>
  );
  const made = render(view(model));
  return { again: (m: GeneralModel) => made.rerender(view(m)) };
}
/** The line of that name (a segmented control inside it is a group of the same name). */
const group = (name: string) => screen.getAllByRole("group", { name })[0]!;
const sw = (name: string) => within(group(name)).getByRole("switch");
/** A promise the test settles by hand. */
function held() {
  let settle!: (ok: boolean) => void;
  const promise = new Promise<unknown>((yes, no) => {
    settle = (ok) => (ok ? yes(true) : no(new Error("refused")));
  });
  return { promise, settle };
}

afterEach(cleanup);

describe("General", () => {
  it("draws no image switch before the server's consent row has answered", () => {
    mount({ ...generalState(), images: null, pixels: null });
    expect(screen.queryByRole("group", { name: "Load images in messages" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Block tracking pixels" })).toBeNull();
    expect(group("Picture quality")).toBeTruthy();
  });

  it("offers the tracking choice when the server supplied only that setting", () => {
    mount({ ...generalState(), images: null });
    expect(screen.queryByRole("switch", { name: "Load images in messages" })).toBeNull();
    expect(sw("Block tracking pixels").getAttribute("aria-checked")).toBe("true");
  });

  it("draws the server's answer: images on, pixels blocked", () => {
    mount(generalState());
    expect(sw("Load images in messages").getAttribute("aria-checked")).toBe("true");
    expect(sw("Block tracking pixels").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(settingsEn.settings.images.on)).toBeTruthy();
  });

  it("writes one image switch at a time and says a refusal on the sheet", async () => {
    const write = held();
    const set = vi.fn(() => write.promise);
    const model = generalState();
    mount({ ...model, images: { blocked: true, fromComputer: false, set } });
    fireEvent.click(sw("Load images in messages"));
    fireEvent.click(sw("Load images in messages"));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(false);
    await act(async () => write.settle(false));
    expect(screen.getByText(settingsEn.settings.images.failed, { exact: false })).toBeTruthy();
    expect(sw("Load images in messages").getAttribute("aria-checked")).toBe("false");
  });

  it("asks the pixel switch for a block when it is turned on", () => {
    const set = vi.fn(() => Promise.resolve());
    mount({ ...generalState(), pixels: { blocked: false, fromComputer: true, set } });
    expect(screen.getByText(settingsEn.settings.pixels.offComputer)).toBeTruthy();
    fireEvent.click(sw("Block tracking pixels"));
    expect(set).toHaveBeenCalledWith(true);
  });

  it("chooses a language once while its write is out, and says a failed one", async () => {
    const write = held();
    const set = vi.fn(() => write.promise);
    mount({
      ...generalState(),
      language: { value: "en", choices: ["en", "de"], local: true, busy: false, set },
    });
    expect(screen.getByText(settingsEn.settings.languageHintLocal)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deutsch" }));
    fireEvent.click(screen.getByRole("button", { name: "Deutsch" }));
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => write.settle(false));
    expect(screen.getByText(settingsEn.settings.languageFailed, { exact: false })).toBeTruthy();
  });

  it("withholds the language where the shell keeps none", () => {
    mount({ ...generalState(), language: null });
    expect(screen.queryByRole("group", { name: "Language" })).toBeNull();
  });

  it("says where the look applies, and offers it to every device only where it does not yet", () => {
    const applyAll = vi.fn();
    const model = generalState();
    const { again } = mount(model);
    expect(screen.getByText(settingsEn.settings.faceScopeAll)).toBeTruthy();
    expect(screen.queryByRole("button", { name: settingsEn.settings.faceApplyAll })).toBeNull();
    again({ ...model, look: { ...model.look, scope: { governs: "device", busy: false, applyAll } } });
    fireEvent.click(screen.getByRole("button", { name: settingsEn.settings.faceApplyAll }));
    expect(applyAll).toHaveBeenCalledTimes(1);
    again({ ...model, look: { ...model.look, scope: null } });
    expect(screen.queryByText(settingsEn.settings.faceScopeAll)).toBeNull();
  });

  it("chooses a look by its tile, and a press on the chosen one writes nothing", () => {
    const set = vi.fn();
    const model = generalState();
    const { again } = mount({ ...model, look: { ...model.look, set } });
    const tiles = group(generalEn.settingsGeneral.lookChoice);
    fireEvent.click(within(tiles).getByRole("button", { name: /^oh(?:\.|$)/ }));
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(within(tiles).getByRole("button", { name: /^ohmarchy/ }));
    expect(set).toHaveBeenCalledWith("ohmarchy");
    again({ ...model, look: { ...model.look, face: "ohmarchy", set } });
    fireEvent.click(within(group(generalEn.settingsGeneral.lookChoice)).getByRole("button", { name: "oh" }));
    expect(set).toHaveBeenLastCalledWith("paper");
  });

  it("chooses where the subject appears in a conversation", () => {
    const set = vi.fn();
    const model = generalState();
    const { again } = mount({ ...model, subject: { value: "head", set } });
    expect(screen.getByRole("button", { name: "One heading" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "On each message" }));
    expect(set).toHaveBeenCalledWith("each");
    again({ ...model, subject: { value: "each", set } });
    expect(screen.getByRole("button", { name: "On each message" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("sets the text size, the picture quality and what follows a verb by their segments", () => {
    const sizes = vi.fn();
    const quality = vi.fn();
    const after = vi.fn();
    const model = generalState();
    mount({
      ...model,
      textSize: { ...model.textSize, set: sizes },
      imageQuality: { ...model.imageQuality, set: quality },
      afterVerb: { ...model.afterVerb, set: after },
    });
    fireEvent.click(within(group("Text size")).getByRole("button", { name: "125%" }));
    fireEvent.click(within(group("Text size")).getByRole("button", { name: "100%" }));
    fireEvent.click(within(group("Picture quality")).getByRole("button", { name: "Original" }));
    fireEvent.click(
      within(group("After acting on a message")).getByRole("button", { name: "Back to the list" }),
    );
    expect(sizes.mock.calls).toEqual([[125]]);
    expect(quality).toHaveBeenCalledWith("original");
    expect(after).toHaveBeenCalledWith("close");
  });

  it("draws the host's own line at the foot, and nothing where it has none", () => {
    const { again } = mount(generalState());
    expect(screen.queryByText("Default mail app")).toBeNull();
    again({ ...generalState(), defaultMail: () => <p>Default mail app</p> });
    expect(screen.getByText("Default mail app")).toBeTruthy();
  });

  it("reads in German", () => {
    mount(generalState(), "de");
    expect(group(settingsDe.settings.language)).toBeTruthy();
    expect(screen.getByRole("heading", { name: generalDe.settingsGeneral.appearance })).toBeTruthy();
    expect(group(generalDe.settingsGeneral.lookChoice)).toBeTruthy();
  });
});
