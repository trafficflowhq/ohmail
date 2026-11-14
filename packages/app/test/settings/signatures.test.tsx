/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SignaturesPane,
  isDirty,
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
  const promise = new Promise<{ signatures: Record<string, string> }>((yes, no) => {
    settle = (ok) => (ok ? yes({ signatures: { m1: "Mila" } }) : no(new Error("refused")));
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

  it("recognizes the same delivered link and break while retaining changes to the destination or formatting", () => {
    const draft = {
      text: "link",
      html: '<p><a href="https://example.invalid/a" target="_blank" rel="noopener">link</a><br></p>',
    };
    const echo = { text: "link", html: '<p><a href="https://example.invalid/a">link</a><br /></p>' };
    expect(isDirty(draft, echo)).toBe(false);
    expect(isDirty(draft, { ...echo, html: echo.html.replace("/a", "/b") })).toBe(true);
    expect(isDirty(draft, { ...echo, html: "<p><strong>link</strong><br /></p>" })).toBe(true);
  });
  it("keeps the exact draft and its leave question while the mailbox organizer has only queued the write", async () => {
    const model = signaturesState();
    const hold = vi.fn(() => vi.fn());
    const write = vi.fn().mockResolvedValue({
      signatures: { m1: model.mailboxes[0]!.stored.text },
      signatureChanges: { m1: { state: "asked", holder: null, refusal: null } },
    });
    const mounted = mount({ ...model, holdLeave: hold, write });
    type("mila@brunner.example", "Waiting for the other install");
    await act(async () =>
      fireEvent.click(within(sheetOf("mila@brunner.example")).getByRole("button", { name: G.save })),
    );
    expect(editorOf("mila@brunner.example").value).toBe("Waiting for the other install");
    expect(hold.mock.results[0]!.value).not.toHaveBeenCalled();
    expect(
      within(sheetOf("mila@brunner.example")).getByRole("button", { name: G.save }).hasAttribute("disabled"),
    ).toBe(false);
    function update(text: string) {
      const mailboxes = model.mailboxes.map((mb) =>
        mb.id === "m1" ? { ...mb, stored: { text, html: "" } } : mb,
      );
      mounted.rerender(
        <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
          <SignaturesPane model={{ ...model, mailboxes, holdLeave: hold, write }} />
        </TextProvider>,
      );
    }
    update("Waiting for the other install");
    expect(hold.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    update("Newer confirmed words");
    expect(editorOf("mila@brunner.example").value).toBe("Newer confirmed words");
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
