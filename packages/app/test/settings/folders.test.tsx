/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FoldersPane,
  foldersMailboxes,
  foldersState,
  pullAfter,
  type FoldersModel,
} from "../../src/settings/folders/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const WORDS: Record<"en" | "de", Messages> = {
  en: { settings: settingsEn.settings } as Messages,
  de: { settings: settingsDe.settings } as Messages,
};
const F = settingsEn.settings.folders;

function mount(model: FoldersModel, locale: "en" | "de" = "en") {
  return render(
    <TextProvider locale={locale} messages={WORDS[locale]} timeZone="Europe/Zurich">
      <FoldersPane model={model} />
    </TextProvider>,
  );
}
const sw = (name: string) => within(screen.getAllByRole("group", { name })[0]!).getByRole("switch");
function held() {
  let settle!: (ok: boolean) => void;
  const promise = new Promise<unknown>((yes, no) => {
    settle = (ok) => (ok ? yes({}) : no(new Error("refused")));
  });
  return { promise, settle };
}

afterEach(cleanup);

describe("Folders", () => {
  it("writes one switch at a time, draws the server's answer, and says a refusal", async () => {
    const write = held();
    const set = vi.fn(() => write.promise);
    mount({ ...foldersState(false), set });
    expect(screen.getByText(F.useOff)).toBeTruthy();
    fireEvent.click(sw(F.useTitle));
    fireEvent.click(sw(F.useTitle));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(true);
    await act(async () => write.settle(false));
    expect(screen.getByText(F.failed, { exact: false })).toBeTruthy();
    expect(sw(F.useTitle).getAttribute("aria-checked")).toBe("false");
  });

  it("lists each mailbox's switch only while folders are on", () => {
    const setMailbox = vi.fn(() => Promise.resolve());
    const { rerender } = mount({ ...foldersState(true), setMailbox });
    fireEvent.click(sw("mila.brunner@work.example"));
    expect(setMailbox).toHaveBeenCalledWith("m2", false);
    rerender(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <FoldersPane model={{ ...foldersState(true), on: false }} />
      </TextProvider>,
    );
    expect(screen.queryByText(F.mailboxesNote)).toBeNull();
  });

  it("writes one mailbox switch at a time and says a refusal on the mailboxes' sheet", async () => {
    const write = held();
    const setMailbox = vi.fn(() => write.promise);
    mount({ ...foldersState(true), setMailbox });
    fireEvent.click(sw("mila.brunner@work.example"));
    fireEvent.click(sw("mila@brunner.example"));
    expect(setMailbox).toHaveBeenCalledTimes(1);
    expect(setMailbox).toHaveBeenCalledWith("m2", false);
    await act(async () => write.settle(false));
    const sheet = screen
      .getByRole("heading", { name: F.mailboxesTitle })
      .closest(".oh-settingssheet") as HTMLElement;
    expect(within(sheet).getByText(F.failed, { exact: false })).toBeTruthy();
    expect(sw("mila.brunner@work.example").getAttribute("aria-checked")).toBe("true");
  });

  it("withholds the mailboxes' list until it is known, writable and holds a second mailbox", () => {
    const two = [
      { id: "m1", address: "a@x.example" },
      { id: "m2", address: "b@x.example" },
    ];
    const base = { on: true, known: true, settable: true, mailboxes: two, off: { m2: "2026-11-01" } };
    expect(foldersMailboxes(base)).toEqual([
      { id: "m1", address: "a@x.example", on: true },
      { id: "m2", address: "b@x.example", on: false },
    ]);
    expect(foldersMailboxes({ ...base, on: false })).toBeNull();
    expect(foldersMailboxes({ ...base, known: false })).toBeNull();
    expect(foldersMailboxes({ ...base, settable: false })).toBeNull();
    expect(foldersMailboxes({ ...base, mailboxes: two.slice(0, 1) })).toBeNull();
  });

  it("pulls the change once a write is confirmed, and never after a refused one", async () => {
    const pull = vi.fn(() => Promise.resolve());
    const ok = pullAfter(() => Promise.resolve(true), pull);
    await expect(ok()).resolves.toBe(true);
    expect(pull).toHaveBeenCalledTimes(1);
    const refused = pullAfter(() => Promise.reject(new Error("409")), pull);
    await expect(refused()).rejects.toThrow("409");
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("reads in German", () => {
    mount(foldersState(true), "de");
    expect(screen.getAllByRole("group", { name: settingsDe.settings.folders.useTitle })).toHaveLength(1);
  });
});
