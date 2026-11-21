/** @vitest-environment jsdom */
import { cleanup, fireEvent, getByRole, getByLabelText, within } from "@testing-library/react";
import { draw, fakeDoor, O, P } from "../../../packages/app/test/mailboxes/connect/support.js";
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

import { ProviderPicker } from "../app/shell/ProviderPicker";
import { PROVIDERS, hostsFor, providerById } from "../app/shell/providers";

/**
 * CHOOSING THE PROVIDER YOU HAVE ALREADY CHOSEN MUST NOT DELETE WHAT YOU TYPED.
 *
 * Found while reproducing the connect flow behind the first external bug report. The report's
 * own cause was elsewhere (the desktop door sent a password with no transport — see
 * `apps/desktop/test/desktop-doors.test.ts`), but the flow it describes runs straight through
 * this control, and this control had a second way to produce the same sentence.
 *
 * The picker is a radiogroup. Its CHECKED tile is the group's roving tab stop, so tabbing in and
 * pressing Space or Enter re-fires the choice; clicking the tile you already chose does the same.
 * Every consumer answered a choice by writing the preset's hosts into its form — and the generic
 * "any other IMAP mailbox" preset's hosts are `""`. So a no-op re-selection wrote two empty
 * strings over the IMAP and SMTP hosts the person had typed, in fields below the fold, with no
 * visible change anywhere near the pointer.
 *
 * The banner for a failed submit renders directly ABOVE the provider grid, which makes the
 * re-click the single most likely next gesture: read the error, glance up, confirm the provider.
 * That gesture erased the field the error was complaining about.
 *
 * Two independent guards, because the two halves fail differently:
 *   · the control does not report a choice that did not change;
 *   · and the host rule itself refuses to overwrite with nothing, so a consumer that DOES get a
 *     legitimate re-notification (or reorders its state writes) still cannot lose the value.
 *
 * MUTATION WATCH (each applied, watched go red, restored):
 *   · `hostsFor` → `imapHost: p.imap.host` (the original unconditional write).
 *   · `ProviderPicker`'s `onClick` → `onChange(p.id)` unguarded.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  cleanup();
  root = null;
  host = null;
});

async function mount(node: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>,
  ));
  return host;
}

/** The manual entry's tile, found the way a person finds it: by its visible name. */
function tileNamed(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
    .find((b) => b.textContent?.includes(name));
  if (!found) throw new Error(`no tile named ${name}`);
  return found;
}

const MANUAL = PROVIDERS.find((p) => p.manual)!;

describe("the provider picker does not report a choice that did not change", () => {
  it("REPRODUCTION: clicking the tile that is already checked fires nothing", async () => {
    const seen: string[] = [];
    const el = await mount(
      <ProviderPicker value={MANUAL.id} onChange={(id) => seen.push(id)} />,
    );

    const tile = tileNamed(el, "Any other IMAP mailbox");
    expect(tile.getAttribute("aria-checked")).toBe("true");

    await act(async () => { tile.click(); });

    // Before: `["imap"]` — and every consumer answered it by blanking both host fields.
    expect(seen).toEqual([]);
  });

  /**
   * Space and Enter on the focused tile go through the SAME `onClick` (it is a real `<button>`),
   * so this is the keyboard half of the reproduction rather than a second mechanism. It is the
   * likelier half: the checked tile is the group's only tab stop.
   */
  it("does not fire when the checked tile is activated from the keyboard", async () => {
    const seen: string[] = [];
    const el = await mount(
      <ProviderPicker value={MANUAL.id} onChange={(id) => seen.push(id)} />,
    );
    const tile = tileNamed(el, "Any other IMAP mailbox");
    expect(tile.tabIndex).toBe(0); // it really is the tab stop

    await act(async () => {
      tile.focus();
      tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(seen).toEqual([]);
  });

  /** A choice that IS a change still reports — the guard must not mute the control. */
  it("still fires for a tile that is not the checked one", async () => {
    const seen: string[] = [];
    const el = await mount(
      <ProviderPicker value={MANUAL.id} onChange={(id) => seen.push(id)} />,
    );
    await act(async () => { tileNamed(el, "Fastmail").click(); });
    expect(seen).toEqual(["fastmail"]);
  });

  /** And with nothing chosen yet, the first click on any tile reports. */
  it("fires for the first choice, when nothing is checked", async () => {
    const seen: string[] = [];
    const el = await mount(<ProviderPicker value={null} onChange={(id) => seen.push(id)} />);
    await act(async () => { tileNamed(el, "Any other IMAP mailbox").click(); });
    expect(seen).toEqual(["imap"]);
  });
});

describe("a preset imposes the hosts it has, and only those", () => {
  const typed = { imapHost: "mail.my-own-server.example", smtpHost: "smtp.my-own-server.example" };
  const GMAIL = providerById("gmail");
  const EMPTY = { imapHost: "", smtpHost: "" };

  it("REPRODUCTION: the generic entry leaves a typed host alone", () => {
    // Before: `{ imapHost: "", smtpHost: "" }`.
    expect(hostsFor(MANUAL, typed, MANUAL)).toEqual(typed);
  });

  /**
   * THE REVIEW'S FINDING, AND IT IS WORSE THAN THE BUG ABOVE.
   *
   * The first version of `hostsFor` kept any value the incoming preset had nothing to say about,
   * with no idea who had put it there. Choosing Gmail fills the host in; choosing "any other IMAP
   * mailbox" next kept it — so the manual fields opened pre-filled with `imap.gmail.com`, which
   * the person never typed and can easily not notice, and the password they then enter for THEIR
   * server is probed against Gmail.
   *
   * A preset's value must never survive into a different provider's attempt.
   */
  function pickAndReadManual(label: string): typeof EMPTY {
    const { door } = fakeDoor({ ways: "none", discover: "none" });
    const view = draw(door, { purpose: { kind: "firstRun" } });
    try {
      const group = within(getByRole(view.container, "group", { name: P.label }));
      fireEvent.click(group.getByRole("button", { name: label }));
      expect(group.getByRole("button", { name: label, pressed: true })).toBeTruthy();
      fireEvent.click(group.getByRole("button", { name: P.otherLabel }));
      expect(group.getByRole("button", { name: P.otherLabel, pressed: true })).toBeTruthy();
      return {
        imapHost: getByLabelText<HTMLInputElement>(view.container, O.imapHost).value,
        smtpHost: getByLabelText<HTMLInputElement>(view.container, O.smtpHost).value,
      };
    } finally {
      view.unmount();
    }
  }

  it("REPRODUCTION: leaving a named provider for the generic entry clears ITS host, not keeps it", () => {
    expect(pickAndReadManual(GMAIL.label)).toEqual(EMPTY);
  });

  it("and the same for every named preset — no provider's host leaks into a manual attempt", () => {
    for (const preset of PROVIDERS.filter((provider) => !provider.manual)) {
      expect(pickAndReadManual(preset.label), preset.id).toEqual(EMPTY);
    }
  });

  it("a named preset still imposes its own hosts over whatever was there", () => {
    expect(hostsFor(GMAIL, typed, MANUAL)).toEqual({
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
    });
  });

  it("every named preset has both hosts to impose, so none of them can silently blank a field", () => {
    for (const p of PROVIDERS.filter((x) => !x.manual)) {
      expect(hostsFor(p, typed, MANUAL), p.id).toEqual({ imapHost: p.imap.host, smtpHost: p.smtp.host });
      expect(p.imap.host, p.id).not.toBe("");
      expect(p.smtp.host, p.id).not.toBe("");
    }
  });

  it("the generic entry starting from empty stays empty — the fields open blank, as they should", () => {
    expect(hostsFor(MANUAL, EMPTY, MANUAL)).toEqual(EMPTY);
    expect(hostsFor(MANUAL, EMPTY, null)).toEqual(EMPTY);
  });

  it("the very first choice has no previous provider, and nothing is carried into it", () => {
    expect(hostsFor(MANUAL, typed, null)).toEqual(EMPTY);
  });
});
