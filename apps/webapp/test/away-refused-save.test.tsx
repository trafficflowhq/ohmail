/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, getByRole, getByText, within } from "@testing-library/react";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";
import { bindApiOwner, type AwayResponderSaveWire, type AwayResponderWire } from "../app/api-client";
import messages from "../messages/en.json";

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

let host: HTMLElement;
let writes: number;

async function mountRow(
  save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderSaveWire>,
  row: Partial<AwayResponderSaveWire> = {},
): Promise<void> {
  const stored: AwayResponderSaveWire = {
    enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
    ...row,
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), window.location.origin).pathname !== "/api/away-responder") {
      return fetch(input, init);
    }
    if (init?.method === "PUT") {
      writes++;
      return Response.json(await save(JSON.parse(String(init.body))));
    }
    return Response.json(stored);
  };
  history.replaceState(null, "", "#/settings/away");
  host = await mountCloudShell();
  await tick(2500);
}

const A = messages.away;
const pane = () => getByRole(host, "region", { name: A.title });
const bodyField = () => getByRole<HTMLTextAreaElement>(pane(), "textbox", { name: A.bodyLabel });

async function click(control: HTMLElement): Promise<void> {
  await act(() => { fireEvent.click(control); });
  await tick(100);
}

const flipSwitch = () => click(getByRole(pane(), "switch", { name: A.title }));
const pressSave = () => {
  const unsaved = getByText(pane(), (text) => text === A.unsavedStillOff || text === A.unsavedStillOn);
  const announcement = unsaved.closest<HTMLElement>("[aria-live]");
  if (!announcement) throw new Error("the unsaved announcement is missing");
  return click(within(announcement).getByRole("button", { name: A.save }));
};

const text = (): string => pane().textContent ?? "";

beforeEach(() => {
  writes = 0;
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  localStorage.clear();
  installConfirmEnv();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
});

afterEach(async () => {
  await teardownConfirmEnv();
  bindApiOwner(null);
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  history.replaceState(null, "", "/");
});

const refuse = async (): Promise<never> => { throw new Error("the save was refused"); };

describe("a refused save is reported from the answer", () => {
  it("stored ON, switched off, refused → the row reads ON and says still on", async () => {
    await mountRow(refuse, { enabled: true });
    expect(text(), "the row did not start on").toContain(messages.away.on);

    await flipSwitch();
    /* The edit is named as unsaved; the line keeps stating the stored responder. */
    expect(text(), "the switch did not take the edit").toContain(messages.away.unsavedStillOn);

    await pressSave();
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

    await pressSave();
    expect(text(), "the row kept the edit over a responder that is still off")
      .toContain(messages.away.off);
    expect(text()).toContain(messages.away.failedStillOff);
  });

  it("a save that lands still applies the edit and still says Saved. (the positive control)", async () => {
    await mountRow(async (next) => ({ ...next, updatedAt: null }), { enabled: true });
    await flipSwitch();
    await pressSave();
    expect(text(), "a landed save did not apply").toContain(messages.away.off);
    expect(text()).toContain(messages.away.saved);
    expect(text()).not.toContain(messages.away.failedStillOn);
    expect(text()).not.toContain(messages.away.failedStillOff);
  });

  it("a message typed before the outage stays in the field, and the sentence says it failed", async () => {
    await mountRow(refuse, { enabled: true });
    await act(() => { fireEvent.change(bodyField(), { target: { value: "Away until the 20th, Anna covers" } }); });
    await pressSave();
    expect(bodyField().value, "the typed message was dropped")
      .toBe("Away until the 20th, Anna covers");
    expect(text()).toContain(messages.away.failedStillOn);
    expect(text(), "the kept edit is not named as unsaved").toContain(messages.away.unsavedStillOn);
  });

  it("an enabled responder with no message keeps its own sentence", async () => {
    // Nothing is sent to the server at all here — the pane refuses it where somebody can see why,
    // and the new sentence must not swallow that one.
    await mountRow(refuse, { enabled: false, body: "" });
    await flipSwitch();
    await pressSave();
    expect(writes).toBe(0);
    expect(text()).toContain(messages.away.incomplete);
    expect(text()).not.toContain(messages.away.failedStillOff);
  });
});
