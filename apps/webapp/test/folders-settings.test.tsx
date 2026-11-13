/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";

import { SettingsView } from "../app/views/SettingsView";
import { FoldersRow } from "../app/shell/FoldersRow";

/**
 * SETTINGS → FOLDERS — the master toggle's pane (FOLDERS-SPEC.md §6; owner decisions 1 and 2).
 *
 *  1. A HOST THAT WIRES THE NODE GETS A NAV ENTRY, directly after Tags — the rail's own
 *     placement argument — and choosing it renders the honest intro plus the node.
 *  2. NO NODE ⇒ NO ENTRY AND NO PANE — the control is absent by construction rather than present
 *     and dead. This clause used to give the reason as "a standalone install and the demo have no
 *     consent row", which is now true of the demo alone: `consentRoutes` are mounted on
 *     `localRoutes`, so a standalone install answers `GET /consent` and `consent.known` goes true
 *     there. What withholds the pane on that door is the transport's `foldersStorable`, because
 *     the engine behind it serves no folder verb and the route silently drops the flag — see
 *     `ConsentTransport.foldersStorable`. The CASES below are unaffected: they drive the
 *     `foldersSection` prop directly and never the door. Corrected because a header that states
 *     the retired reason as the reason under test is the shape this pane's own slice was about.
 *  3. THE SWITCH SHOWS THE STORED VALUE, NEVER THE HOPED-FOR ONE: pressing it calls the writer
 *     and does not move until the prop (the server's echo) moves. A refused write must not draw
 *     a rail the account does not have.
 *  4. BOTH LOCALES carry the copy — the pane renders German from the catalogue, not English.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;

async function mount(node: React.ReactNode, locale: "en" | "de" = "en") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? (de as never) : messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
  });
}

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const navLabels = () =>
  [...host.querySelectorAll(".set-nav button")].map((b) => b.textContent?.trim());

const choose = async (label: string): Promise<void> => {
  const entry = [...host.querySelectorAll(".set-nav button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!entry) throw new Error(`no settings nav entry labelled ${label}`);
  await act(async () => { entry.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

const BASE: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
};

describe("the pane exists exactly where the shell wired it", () => {
  it("wired: a Folders entry directly after Tags, whose pane is the intro plus the node", async () => {
    await mount(h(SettingsView, {
      ...BASE,
      foldersSection: h("p", { className: "folders-probe" }, "the toggle"),
    }));
    const labels = navLabels();
    expect(labels).toContain("Folders");
    expect(labels.indexOf("Folders")).toBe(labels.indexOf("Tags") + 1);
    await choose("Folders");
    expect(host.querySelector(".folders-probe")).not.toBeNull();
    expect(host.textContent).toContain("the real folders on your mail server, not a copy");
  });

  it("not wired: no entry, no pane", async () => {
    await mount(h(SettingsView, BASE));
    expect(navLabels()).not.toContain("Folders");
  });

  it("the menu says which section is open, to a screen reader too, and only that one", async () => {
    await mount(h(SettingsView, { ...BASE, foldersSection: h("p", null, "the toggle") }));
    const current = () =>
      [...host.querySelectorAll('.set-nav button[aria-current="page"]')].map((b) => b.textContent?.trim());
    expect(current()).toEqual(["General"]);
    await choose("Folders");
    expect(current()).toEqual(["Folders"]);
  });

  it("German reads German — the pane copy comes from the catalogue", async () => {
    await mount(
      h(SettingsView, { ...BASE, foldersSection: h(FoldersRow, { on: false, setFoldersEnabled: async () => false }) }),
      "de",
    );
    expect(navLabels()).toContain("Ordner");
    await choose("Ordner");
    expect(host.textContent).toContain("die echten Ordner auf deinem Mailserver, keine Kopie");
    expect(host.textContent).toContain("Ordner verwenden");
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

    await mount(h(FoldersRow, { on: false, setFoldersEnabled }));
    const sw = host.querySelector('[role="switch"]') as HTMLElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Your folders stay hidden");

    await act(async () => { sw.click(); });
    expect(calls).toEqual([true]);
    // In flight: the write has not answered, so the switch has not moved.
    expect(sw.getAttribute("aria-checked")).toBe("false");

    await act(async () => { resolveWrite(true); });
    // Still false: this component renders the PROP. The hook that owns the echo re-renders it
    // with `on: true` — simulated here by the rerender, which is the seam under test.
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await mountOver(h(FoldersRow, { on: true, setFoldersEnabled }));
    const sw2 = host.querySelector('[role="switch"]') as HTMLElement;
    expect(sw2.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("show in the menu");
  });

  it("a refused write says so instead of moving the switch", async () => {
    await mount(h(FoldersRow, { on: false, setFoldersEnabled: async () => { throw new Error("nope"); } }));
    const sw = host.querySelector('[role="switch"]') as HTMLElement;
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
    await mount(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS,
      mailboxesOff: { "mb-2": "2026-08-25T21:03:31.000Z" },
      mailboxesKnown: true,
      setMailboxFoldersEnabled: async () => ({}),
    }));
    const switches = [...host.querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(3);   // the master + one per mailbox
    expect(host.textContent).toContain("one@example.com");
    expect(host.textContent).toContain("two@example.com");
    // mb-1 participates (no exception), mb-2 is the stored exception.
    expect(switches[1]!.getAttribute("aria-checked")).toBe("true");
    expect(switches[2]!.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Folders show");
    expect(host.textContent).toContain("Folders hidden");
  });

  it("with the master OFF, or one mailbox, or no setter: no list — the master is the only switch", async () => {
    await mount(h(FoldersRow, {
      on: false, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }));
    expect([...host.querySelectorAll('[role="switch"]')]).toHaveLength(1);

    await mountOver(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: [MBS[0]!], mailboxesOff: {}, mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }));
    expect([...host.querySelectorAll('[role="switch"]')]).toHaveLength(1);

    await mountOver(h(FoldersRow, { on: true, setFoldersEnabled: noopMaster, mailboxes: MBS }));
    expect([...host.querySelectorAll('[role="switch"]')]).toHaveLength(1);
  });

  it("the list WAITS for the live exceptions map — a warm boot's cache paints no switches (codex round 1)", async () => {
    // `known` true from the boot cache, exceptions map still resting: the switches must not
    // render — a stored opt-out shown as ON is the wrong-then-right flash this pane refuses
    // everywhere else. The live wire (or a write's echo) flips `mailboxesKnown` and the list
    // appears wearing the stored answer.
    await mount(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, setMailboxFoldersEnabled: async () => ({}),
    }));
    expect([...host.querySelectorAll('[role="switch"]')]).toHaveLength(1);
    await mountOver(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: { "mb-2": "2026-08-25T21:03:31.000Z" },
      mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }));
    const switches = [...host.querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(3);
    expect(switches[2]!.getAttribute("aria-checked")).toBe("false");
  });

  it("pressing a mailbox switch writes THAT mailbox, and the switch renders the prop, never the press", async () => {
    const calls: Array<[string, boolean]> = [];
    await mount(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true,
      setMailboxFoldersEnabled: async (id: string, enabled: boolean) => {
        calls.push([id, enabled]);
        return { [id]: "2026-08-25T21:03:31.000Z" };
      },
    }));
    const switches = [...host.querySelectorAll('[role="switch"]')];
    await act(async () => { (switches[2] as HTMLElement).click(); });
    expect(calls).toEqual([["mb-2", false]]);
    // The prop has not moved, so neither has the switch — the hook's echo owns the move.
    expect(switches[2]!.getAttribute("aria-checked")).toBe("true");
    await mountOver(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: { "mb-2": "2026-08-25T21:03:31.000Z" },
      mailboxesKnown: true,
      setMailboxFoldersEnabled: async () => ({}),
    }));
    expect([...host.querySelectorAll('[role="switch"]')][2]!.getAttribute("aria-checked")).toBe("false");
  });

  it("a refused mailbox write says so and moves nothing", async () => {
    await mount(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true,
      setMailboxFoldersEnabled: async () => { throw new Error("nope"); },
    }));
    const switches = [...host.querySelectorAll('[role="switch"]')];
    await act(async () => { (switches[1] as HTMLElement).click(); });
    expect(switches[1]!.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Couldn't save that");
  });

  it("German reads German — the list copy comes from the catalogue", async () => {
    await mount(h(FoldersRow, {
      on: true, setFoldersEnabled: noopMaster,
      mailboxes: MBS, mailboxesOff: {}, mailboxesKnown: true, setMailboxFoldersEnabled: async () => ({}),
    }), "de");
    expect(host.textContent).toContain("Ordner werden gezeigt");
    expect(host.textContent).not.toContain("Folders show");
  });
});

/** Re-render into the SAME root — the echo arriving, without a second mount's fresh state. */
async function mountOver(node: React.ReactNode) {
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
  });
}
