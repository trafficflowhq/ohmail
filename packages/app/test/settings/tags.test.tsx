/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagsPane, tagsState, type TagsModel } from "../../src/settings/tags/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import tagsDe from "../../messages/settings-tags.de.json" with { type: "json" };
import tagsEn from "../../messages/settings-tags.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const WORDS: Record<"en" | "de", Messages> = {
  en: { settings: settingsEn.settings, ...tagsEn } as Messages,
  de: { settings: settingsDe.settings, ...tagsDe } as Messages,
};
const S = settingsEn.settings;

function verbs() {
  return { create: vi.fn(), rename: vi.fn(), recolour: vi.fn(), remove: vi.fn() };
}
function mount(model: TagsModel, at?: { rename?: string; typeNew?: string }, locale: "en" | "de" = "en") {
  return render(
    <TextProvider locale={locale} messages={WORDS[locale]} timeZone="Europe/Zurich">
      <TagsPane model={model} at={at} />
    </TextProvider>,
  );
}
const newField = () => screen.getByRole("textbox", { name: S.tagNew });
const add = () => screen.getByRole("button", { name: S.tagAdd });

afterEach(cleanup);

describe("Tags", () => {
  it("lists each tag with how many messages carry it", () => {
    mount(tagsState());
    const pottery = screen.getAllByRole("group", { name: "Pottery Project" })[0]!;
    expect(within(pottery).getByText("4 messages")).toBeTruthy();
  });

  it("refuses a name the account already holds, in any case, before the write", () => {
    const v = verbs();
    mount({ ...tagsState(), verbs: v });
    fireEvent.change(newField(), { target: { value: "  paperwork " } });
    expect(screen.getByText("You already have a tag called “paperwork”.")).toBeTruthy();
    expect(add().hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(newField(), { key: "Enter" });
    expect(v.create).not.toHaveBeenCalled();
  });

  it("makes a new tag by its trimmed name and empties the field", () => {
    const v = verbs();
    mount({ ...tagsState(), verbs: v });
    fireEvent.change(newField(), { target: { value: " Garden " } });
    fireEvent.click(add());
    expect(v.create).toHaveBeenCalledWith("Garden");
    expect((newField() as HTMLInputElement).value).toBe("");
  });

  it("saves a rename only when the name changed, and Esc leaves it as it was", () => {
    const v = verbs();
    mount({ ...tagsState(), verbs: v });
    fireEvent.click(screen.getAllByRole("button", { name: S.tagRename })[0]!);
    const field = screen.getByRole("textbox", { name: S.tagRename });
    expect(document.activeElement).toBe(field);
    expect(screen.getByRole("button", { name: S.tagSave }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(v.rename).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: S.tagRename })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: S.tagRename }), { target: { value: "Pottery" } });
    fireEvent.click(screen.getByRole("button", { name: S.tagSave }));
    expect(v.rename).toHaveBeenCalledWith("t1", "Pottery");
  });

  it("asks before a delete, with how many messages carry the tag, and deletes on yes", () => {
    const v = verbs();
    mount({ ...tagsState(), verbs: v });
    fireEvent.click(screen.getAllByRole("button", { name: S.tagDelete })[1]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Delete “Paperwork”?");
    expect(dialog.textContent).toContain("It's on 12 of your messages.");
    expect(v.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: S.tagDelete }));
    expect(v.remove).toHaveBeenCalledWith("t2");
  });

  it("recolours from the colour button's menu", () => {
    const v = verbs();
    mount({ ...tagsState(), verbs: v });
    fireEvent.click(screen.getByRole("button", { name: "Recolour Travel" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Heather/ }));
    expect(v.recolour).toHaveBeenCalledWith("t3", "heather");
  });

  it("draws the list with no verb and no new line where the shell wires none", () => {
    mount({ ...tagsState(), verbs: null });
    expect(screen.queryByRole("button", { name: S.tagRename })).toBeNull();
    expect(screen.queryByRole("textbox", { name: S.tagNew })).toBeNull();
  });

  it("says where tags live, in the tag place's own words, and an empty list", () => {
    mount({ ...tagsState(), tags: [], notOnServer: "Tags are stored by ohmail." });
    expect(screen.getByText(S.tagsEmpty)).toBeTruthy();
    expect(screen.getByText("Tags are stored by ohmail.")).toBeTruthy();
  });

  it("opens on a moment for the states page, and reads in German", () => {
    mount(tagsState(), { typeNew: "paperwork" }, "de");
    expect(screen.getByText("Du hast schon einen Tag namens „paperwork“.")).toBeTruthy();
  });
});
