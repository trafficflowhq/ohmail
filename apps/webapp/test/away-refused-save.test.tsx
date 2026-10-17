/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { AwayResponderRow, type AwayTransport } from "../app/shell/AwayResponderRow";
import type { AwayResponderSaveWire, AwayResponderWire } from "../app/api-client";

/**
 * ═══ A REFUSED SAVE LEAVES THE SWITCH SHOWING WHAT IS STORED ════════════════════════════════
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * Turn the responder off, press Save during an outage: the write was refused and the row went on
 * rendering the edit — "Off. Nothing is sent." — over a responder that was still enabled and
 * still answering every stranger who wrote. The one sentence the pane did raise said only that
 * something had failed, which does not tell anybody whether mail is going out in their name.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 * The RENDERED row after a refusal: the switch, the description, and the sentence beside Save.
 *  1. Stored ON, switched off, save refused → the row reads ON and says "still on".
 *  2. Stored OFF, switched on, save refused → the row reads OFF and says "still off" — the other
 *     half, because a fix that only reverts one direction is half-applied by construction.
 *  3. A save that SUCCEEDS still applies the edit and still says "Saved." — the positive control.
 *  4. The local refusal (an enabled responder with no message) keeps its own sentence rather than
 *     being swallowed by the new one.
 *  5. A message typed before the outage stays in the field under the failure sentence.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * The status line reads the STORED row, so the edit itself stays in the controls (a typed message
 * is never dropped, case 5). Make the failure sentence read `draft.enabled` and cases 1 and 2 go
 * red on it; swap `failedWire` back to `failed` and they go red on the sentence too.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;

async function mountRow(
  save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderSaveWire>,
  row: Partial<AwayResponderSaveWire> = {},
): Promise<void> {
  const stored: AwayResponderSaveWire = {
    enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
    ...row,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(
          AwayResponderRow as React.FunctionComponent<{ transport: AwayTransport }>,
          { transport: { state: async () => stored, save } },
        ))),
      }),
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** The responder's OWN switch, by its accessible name — the pane also draws a box per pile. */
const flipSwitch = async (): Promise<void> => {
  const name = messages.away.title;
  const found = [...host.querySelectorAll('[role=switch], input[type=checkbox]')]
    .filter((el) => el.getAttribute("aria-label") === name
      || el.getAttribute("name") === name
      || (el.id !== "" && host.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() === name));
  if (found.length !== 1) throw new Error(`away switch: expected 1 control named ${name}, found ${found.length}`);
  await act(async () => { found[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const press = async (label: string): Promise<void> => {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!button) throw new Error(`no button labelled ${label}`);
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const text = (): string => host.textContent ?? "";

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const refuse = async (): Promise<never> => { throw new Error("the save was refused"); };

describe("a refused save is reported from the answer", () => {
  it("stored ON, switched off, refused → the row reads ON and says still on", async () => {
    await mountRow(refuse, { enabled: true });
    expect(text(), "the row did not start on").toContain(messages.away.on);

    await flipSwitch();
    /* The edit is named as unsaved; the line keeps stating the stored responder. */
    expect(text(), "the switch did not take the edit").toContain(messages.away.unsavedStillOn);

    await press(messages.away.save);
    // THE ROW IS WHAT IS STORED, and the responder is still sending.
    expect(text(), "the row kept the edit over a responder that is still on")
      .toContain(messages.away.on);
    expect(text()).not.toContain(messages.away.off);
    expect(text(), "the refusal did not say which state the responder is in")
      .toContain(messages.away.failedStillOn);
  });

  it("stored OFF, switched on, refused → the row reads OFF and says still off", async () => {
    await mountRow(refuse, { enabled: false });
    await flipSwitch();
    expect(text(), "the switch did not take the edit").toContain(messages.away.unsavedStillOff);

    await press(messages.away.save);
    expect(text(), "the row kept the edit over a responder that is still off")
      .toContain(messages.away.off);
    expect(text()).toContain(messages.away.failedStillOff);
  });

  it("a save that lands still applies the edit and still says Saved. (the positive control)", async () => {
    await mountRow(async (next) => ({ ...next, updatedAt: null }), { enabled: true });
    await flipSwitch();
    await press(messages.away.save);
    expect(text(), "a landed save did not apply").toContain(messages.away.off);
    expect(text()).toContain(messages.away.saved);
    expect(text()).not.toContain(messages.away.failedStillOn);
    expect(text()).not.toContain(messages.away.failedStillOff);
  });

  it("a message typed before the outage stays in the field, and the sentence says it failed", async () => {
    /* AWAY-OUTAGE-ON-SAVE-DROPS-THE-TYPED-MESSAGE: the catch put the stored row back, so the words
       were gone. The phone keeps them; so does this row now, still stating the stored responder. */
    await mountRow(refuse, { enabled: true });
    const field = host.querySelector("#away-body") as HTMLTextAreaElement;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { set.call(field, "Away until the 20th, Anna covers"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await press(messages.away.save);
    expect((host.querySelector("#away-body") as HTMLTextAreaElement).value, "the typed message was dropped")
      .toBe("Away until the 20th, Anna covers");
    expect(text()).toContain(messages.away.failedStillOn);
    expect(text(), "the kept edit is not named as unsaved").toContain(messages.away.unsavedStillOn);
  });

  it("an enabled responder with no message keeps its own sentence", async () => {
    // Nothing is sent to the server at all here — the pane refuses it where somebody can see why,
    // and the new sentence must not swallow that one.
    await mountRow(refuse, { enabled: false, body: "" });
    await flipSwitch();
    await press(messages.away.save);
    expect(text()).toContain(messages.away.incomplete);
    expect(text()).not.toContain(messages.away.failedStillOff);
  });
});
