/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import { NONE } from "../../../packages/app/src/host/index.js";
import { PANE_IDS, type SettingsPanes } from "../../../packages/app/src/settings/contract.js";
import { paneOf } from "../../../packages/app/src/settings/facts.js";
import { FoldersPane, foldersMailboxes } from "../../../packages/app/src/settings/folders/index.js";
import { settingsPlace } from "../../../packages/app/src/settings/place.js";
import { TextProvider } from "@ohmail/app/text";
import en from "../../../packages/app/messages/settings.en.json";
import de from "../../../packages/app/messages/settings.de.json";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { madeOf, SETTINGS } from "../../../packages/app/test/settings/frame/hosts.js";

afterEach(cleanup);

function words(node: React.ReactNode, locale: "en" | "de") {
  return <TextProvider locale={locale} messages={{ ...FRAME_WORDS[locale], ...(locale === "de" ? de : en) }}
    timeZone="UTC">{node}</TextProvider>;
}

function mount(node: React.ReactNode, locale: "en" | "de" = "en") {
  const view = render(words(node, locale));
  return { ...view, mountOver: (next: React.ReactNode) => view.rerender(words(next, locale)) };
}

function mountSettings(foldersSection?: React.ReactNode, locale: "en" | "de" = "en") {
  const address = fakeAddress("#/settings");
  const barePanes = Object.fromEntries(PANE_IDS.map((id) => [
    id, id === "general" || id === "tags" ? paneOf(id, { Body: () => null }) : NONE,
  ]));
  const panes = {
    ...barePanes,
    folders: foldersSection ? paneOf("folders", { Body: () => foldersSection }) : NONE,
  } as SettingsPanes;
  const settings = settingsPlace(panes, () => ({
    startAt: null,
    go: (pane) => address.visit(pane ? `#/settings/${pane}` : "#/settings"),
  }));
  const { host } = madeOf(SETTINGS["W-m"]!, { address, window: fakeWindow("desktop"), places: { settings } });
  return mount(<Frame host={host} />, locale);
}

function folders(
  {
    on, setFoldersEnabled, mailboxes = null, mailboxesOff = {}, mailboxesKnown = false, setMailboxFoldersEnabled,
  }: {
    on: boolean;
    setFoldersEnabled: (enabled: boolean) => Promise<unknown>;
    mailboxes?: { id: string; address: string }[] | null;
    mailboxesOff?: Record<string, string>;
    mailboxesKnown?: boolean;
    setMailboxFoldersEnabled?: (id: string, enabled: boolean) => Promise<unknown>;
  },
) {
  return <FoldersPane model={{
    on,
    set: setFoldersEnabled,
    setMailbox: setMailboxFoldersEnabled ?? (async () => { throw new Error("Mailbox write unavailable"); }),
    mailboxes: foldersMailboxes({
      on, known: mailboxesKnown, settable: setMailboxFoldersEnabled !== undefined, mailboxes, off: mailboxesOff,
    }),
  }} />;
}

function menu() {
  return within(screen.getByRole("navigation", { name: /Settings sections|Einstellungsbereiche/ }));
}

const navLabels = () => menu().getAllByRole("button").map((button) => button.getAttribute("aria-label"));

const choose = async (label: string) => {
  await act(async () => { menu().getByRole("button", { name: label }).click(); });
};

describe("the pane exists exactly where the shell wired it", () => {
  it("wired: a Folders entry directly after Tags, whose pane offers the master switch", async () => {
    mountSettings(folders({ on: false, setFoldersEnabled: async () => false }));
    const labels = navLabels();
    expect(labels).toContain("Folders");
    expect(labels.indexOf("Folders")).toBe(labels.indexOf("Tags") + 1);
    await choose("Folders");
    expect(screen.getByRole("switch", { name: "Use folders", checked: false })).toBeTruthy();
  });

  it("not wired: no entry, no pane", async () => {
    mountSettings();
    expect(navLabels()).not.toContain("Folders");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("the menu says which section is open, to a screen reader too, and only that one", async () => {
    mountSettings(folders({ on: false, setFoldersEnabled: async () => false }));
    const current = () => menu().getAllByRole("button", { current: "page" }).map((button) => button.getAttribute("aria-label"));
    expect(current()).toEqual(["General"]);
    await choose("Folders");
    expect(current()).toEqual(["Folders"]);
  });

  it("German reads German — the pane copy comes from the catalogue", async () => {
    mountSettings(folders({ on: false, setFoldersEnabled: async () => false }), "de");
    expect(navLabels()).toContain("Ordner");
    await choose("Ordner");
    expect(screen.getByRole("switch", { name: "Ordner verwenden", checked: false })).toBeTruthy();
  });
});

describe("the switch shows the stored value, never the hoped-for one", () => {
  it("pressing calls the writer; the switch moves only when the echo (the prop) moves", async () => {
    const calls: boolean[] = [];
    let resolveWrite: (v: boolean) => void = () => {};
    const setFoldersEnabled = (enabled: boolean): Promise<boolean> => {
      calls.push(enabled);
      return new Promise((res) => { resolveWrite = res; });
    };

    const { container: host, mountOver } = mount(folders({ on: false, setFoldersEnabled }));
    const sw = within(host).getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(within(host).getByRole("switch", { name: "Use folders", checked: false })).toBe(sw);

    await act(async () => { sw.click(); });
    expect(calls).toEqual([true]);
    // In flight: the write has not answered, so the switch has not moved.
    expect(sw.getAttribute("aria-checked")).toBe("false");

    await act(async () => { resolveWrite(true); });
    // Still false: this component renders the PROP. The hook that owns the echo re-renders it
    // with `on: true` — simulated here by the rerender, which is the seam under test.
    expect(sw.getAttribute("aria-checked")).toBe("false");
    mountOver(folders({ on: true, setFoldersEnabled }));
    const sw2 = within(host).getByRole("switch");
    expect(sw2.getAttribute("aria-checked")).toBe("true");
    expect(within(host).getByRole("switch", { name: "Use folders", checked: true })).toBe(sw2);
  });

  it("a refused write says so instead of moving the switch", async () => {
    const { container: host } = mount(folders({ on: false, setFoldersEnabled: async () => { throw new Error("nope"); } }));
    const sw = within(host).getByRole("switch");
    await act(async () => { sw.click(); });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Couldn't save that");
  });
});

describe("the per-mailbox list (FOLDERS-SPEC.md §17)", () => {
  const MBS = [
    { id: "mb-1", address: "one@example.com" },
    { id: "mb-2", address: "two@example.com" },
  ];
  const noopMaster = async (v: boolean) => v;

  it("renders one switch per mailbox under the ON master, wearing the SERVER's answer", async () => {
    const { container: host } = mount(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS,
      mailboxesOff: { "mb-2": "2026-08-25T21:03:31.000Z" },
      mailboxesKnown: true,
      setMailboxFoldersEnabled: async () => ({}),
    }));
    const switches = within(host).getAllByRole("switch");
    expect(switches).toHaveLength(3);   // the master + one per mailbox
    expect(host.textContent).toContain("one@example.com");
    expect(host.textContent).toContain("two@example.com");
    // mb-1 participates (no exception), mb-2 is the stored exception.
    expect(switches[1]!.getAttribute("aria-checked")).toBe("true");
    expect(switches[2]!.getAttribute("aria-checked")).toBe("false");
    expect(switches[1]!.getAttribute("aria-label")).toEqual(MBS[0]!.address);
    expect(switches[2]!.getAttribute("aria-label")).toEqual(MBS[1]!.address);
  });

  it("with the master OFF, or one mailbox, or no setter: no list — the master is the only switch", async () => {
    const { container: host, mountOver } = mount(folders({
      on: false, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }));
    expect(within(host).getAllByRole("switch")).toHaveLength(1);

    mountOver(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: [MBS[0]!], mailboxesOff: {}, mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }));
    expect(within(host).getAllByRole("switch")).toHaveLength(1);

    mountOver(folders({ on: true, setFoldersEnabled: noopMaster, mailboxes: MBS }));
    expect(within(host).getAllByRole("switch")).toHaveLength(1);
  });

  it("the list WAITS for the live exceptions map — a warm boot's cache paints no switches (codex round 1)", async () => {
    // `known` true from the boot cache, exceptions map still resting: the switches must not
    // render — a stored opt-out shown as ON is the wrong-then-right flash this pane refuses
    // everywhere else. The live wire (or a write's echo) flips `mailboxesKnown` and the list
    // appears wearing the stored answer.
    const { container: host, mountOver } = mount(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, setMailboxFoldersEnabled: async () => ({}),
    }));
    expect(within(host).getAllByRole("switch")).toHaveLength(1);
    mountOver(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: { "mb-2": "2026-08-25T21:03:31.000Z" },
      mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }));
    const switches = within(host).getAllByRole("switch");
    expect(switches).toHaveLength(3);
    expect(switches[2]!.getAttribute("aria-checked")).toBe("false");
  });

  it("pressing a mailbox switch writes THAT mailbox, and the switch renders the prop, never the press", async () => {
    const calls: Array<[string, boolean]> = [];
    const { container: host, mountOver } = mount(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true,
      setMailboxFoldersEnabled: async (id: string, enabled: boolean) => {
        calls.push([id, enabled]);
        return { [id]: "2026-08-25T21:03:31.000Z" };
      },
    }));
    const switches = within(host).getAllByRole("switch");
    await act(async () => { switches[2]!.click(); });
    expect(calls).toEqual([["mb-2", false]]);
    // The prop has not moved, so neither has the switch — the hook's echo owns the move.
    expect(switches[2]!.getAttribute("aria-checked")).toBe("true");
    mountOver(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: { "mb-2": "2026-08-25T21:03:31.000Z" },
      mailboxesKnown: true,
      setMailboxFoldersEnabled: async () => ({}),
    }));
    expect(within(host).getAllByRole("switch")[2]!.getAttribute("aria-checked")).toBe("false");
  });

  it("a refused mailbox write says so and moves nothing", async () => {
    const { container: host } = mount(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true,
      setMailboxFoldersEnabled: async () => { throw new Error("nope"); },
    }));
    const switches = within(host).getAllByRole("switch");
    await act(async () => { switches[1]!.click(); });
    expect(switches[1]!.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Couldn't save that");
  });

  it("German reads German — the list copy comes from the catalogue", async () => {
    const { container: host } = mount(folders({
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }), "de");
    expect(within(host).getByRole("switch", { name: "Ordner verwenden", checked: true })).toBeTruthy();
    expect(within(host).queryByRole("switch", { name: "Use folders" })).toBeNull();
  });
});
