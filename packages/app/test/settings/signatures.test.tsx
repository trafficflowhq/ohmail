/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SignaturesPane,
  signaturesState,
  signatureWrite,
  type SignaturesModel,
} from "../../src/settings/signatures/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import sigDe from "../../messages/settings-signatures.de.json" with { type: "json" };
import sigEn from "../../messages/settings-signatures.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const WORDS: Record<"en" | "de", Messages> = {
  en: { settings: settingsEn.settings, ...sigEn } as Messages,
  de: { settings: settingsDe.settings, ...sigDe } as Messages,
};
const G = settingsEn.settings.signatures;

function mount(model: SignaturesModel, locale: "en" | "de" = "en") {
  return render(
    <TextProvider locale={locale} messages={WORDS[locale]} timeZone="Europe/Zurich">
      <SignaturesPane model={model} />
    </TextProvider>,
  );
}
const editorOf = (address: string) =>
  screen.getByRole("textbox", { name: `${G.title}: ${address}` }) as HTMLTextAreaElement;
const sheetOf = (address: string) => editorOf(address).closest(".oh-settingssheet") as HTMLElement;
const type = (address: string, text: string) =>
  fireEvent.change(editorOf(address), { target: { value: text } });
function held() {
  let settle!: (ok: boolean) => void;
  const promise = new Promise<unknown>((yes, no) => {
    settle = (ok) => (ok ? yes({}) : no(new Error("refused")));
  });
  return { promise, settle };
}

afterEach(cleanup);

describe("Signatures", () => {
  it("draws each mailbox's stored signature, and says which sign with nothing", () => {
    mount(signaturesState());
    expect(editorOf("mila@brunner.example").value).toBe("Mila Brunner\nStudio Brunner");
    expect(
      within(sheetOf("mila.brunner@work.example")).getByText(sigEn.settingsSignatures.none),
    ).toBeTruthy();
    expect(within(sheetOf("mila.brunner@work.example")).getByText(G.mailboxOff)).toBeTruthy();
  });

  it("saves a changed draft once, as plain text, and draws the stored value again after it", async () => {
    const write = held();
    const model = { ...signaturesState(), write: vi.fn(() => write.promise) };
    mount(model);
    const save = () => within(sheetOf("mila@brunner.example")).getByRole("button", { name: G.save });
    expect(save().hasAttribute("disabled")).toBe(true);
    type("mila@brunner.example", "Mila");
    fireEvent.click(save());
    expect(model.write).toHaveBeenCalledWith("m1", "Mila");
    expect(
      within(sheetOf("mila@brunner.example"))
        .getByRole("button", { name: G.saving })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(editorOf("mila.brunner@work.example").readOnly).toBe(true);
    await act(async () => write.settle(true));
    expect(editorOf("mila@brunner.example").value).toBe("Mila Brunner\nStudio Brunner");
  });

  it("keeps the draft and says a refusal on the mailbox's sheet, in the organizer's words where it refused", async () => {
    const write = held();
    const refusal = vi.fn(() => "The organizing install refused it.");
    mount({ ...signaturesState(), write: () => write.promise, refusal });
    type("mila@brunner.example", "Mila");
    fireEvent.click(within(sheetOf("mila@brunner.example")).getByRole("button", { name: G.save }));
    await act(async () => write.settle(false));
    expect(
      within(sheetOf("mila@brunner.example")).getByText("The organizing install refused it.", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(editorOf("mila@brunner.example").value).toBe("Mila");
  });

  it("writes an emptied signature as none, and formatted text as markup alone", () => {
    expect(signatureWrite({ text: "  ", html: "" })).toEqual([null]);
    expect(signatureWrite({ text: "Mila", html: "" })).toEqual(["Mila"]);
    expect(signatureWrite({ text: "Mila", html: "<b>Mila</b>" })).toEqual([null, "<b>Mila</b>"]);
  });

  it("discards a draft back to the stored signature", () => {
    mount(signaturesState());
    type("mila@brunner.example", "Mila");
    fireEvent.click(within(sheetOf("mila@brunner.example")).getByRole("button", { name: G.revert }));
    expect(editorOf("mila@brunner.example").value).toBe("Mila Brunner\nStudio Brunner");
  });

  it("holds the way out while a draft is unsaved, asks, and leaves only on Discard", () => {
    const release = vi.fn();
    let ask: ((leave: () => void) => void) | null = null;
    const holdLeave = vi.fn((a: (leave: () => void) => void) => {
      ask = a;
      return release;
    });
    mount({ ...signaturesState(), holdLeave });
    expect(holdLeave).not.toHaveBeenCalled();
    type("mila@brunner.example", "Mila");
    expect(holdLeave).toHaveBeenCalledTimes(1);
    const leave = vi.fn();
    act(() => ask!(leave));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(G.leaveAsk);
    fireEvent.click(within(dialog).getByRole("button", { name: G.leaveKeep }));
    expect(leave).not.toHaveBeenCalled();
    act(() => ask!(leave));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: G.revert }));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalled();
  });

  it("reads a signature another install publishes, and offers no save for it", () => {
    const model = signaturesState();
    mount({ ...model, mailboxes: [{ ...model.mailboxes[0]!, reading: true }] });
    expect(editorOf("mila@brunner.example").readOnly).toBe(true);
    expect(screen.getByText(G.mailboxRead)).toBeTruthy();
    expect(screen.queryByRole("button", { name: G.save })).toBeNull();
  });

  it("reads in German", () => {
    mount(signaturesState(), "de");
    expect(screen.getByText(settingsDe.settings.signatures.intro)).toBeTruthy();
  });
});
