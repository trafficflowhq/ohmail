/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import messages from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import { DesktopSettings } from "../src/DesktopSettings.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * A SEAL THAT DID NOT LAND IS A SENTENCE IN THE ACCOUNT PANE, not a line in the engine log.
 *
 * `/health` carries `sealed` and the gate hands it here; this is the rendering half, asked of the
 * DOM. The note's claim is the engine's: a refused save withholds the renewal and a relaunch
 * resumes the saved one, so nobody is asked to sign in again.
 *
 * MUTATIONS WATCHED RED: the note rendered unconditionally → the healthy case reddens; the note
 * removed → the refused case; Try again not reaching the engine → the press case.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

/** The engine answers nothing: this pane's other rows are not what is under test. */
const host = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: () => Promise<unknown> } };

let hostEl: HTMLDivElement;
let root: Root;

const status: EngineStatus = {
  state: "serving", mode: "cloud", credentialState: "ready", address: "me@ohmail.test",
} as EngineStatus;

async function mount(sealFailed: boolean): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    /* The child rides in `children` rather than as a third argument: this provider's props type
       requires it, and the third-argument form is the shape the test-dirs ratchet counts. */
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: messages as never, timeZone: "UTC",
      children: h(DesktopSettings, {
        status, session: "live", sealFailed,
        onStatus: () => undefined, onSwitchDoor: () => undefined, onSignIn: () => undefined,
      }),
    }));
  });
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  hostEl.remove();
  // `liveCopy` reads an injected module-level catalogue, not the provider — see `locale.ts`.
  setActiveCatalog(DEFAULT_LOCALE, null);
  delete host.__TAURI_INTERNALS__;
});

const NOTE = "could not be saved on this";

describe("Settings → Desktop says when this install's sign-in did not reach the disk", () => {
  it("renders the sentence while the engine reports the seal refused", async () => {
    await mount(true);
    expect(hostEl.textContent).toContain(NOTE);
    expect(hostEl.textContent, "and it names what happens next, not the filesystem's error")
      .toContain("you stay signed in");
    expect(hostEl.textContent, "the old promise of a sign-in after a restart is gone — it is false now")
      .not.toContain("sign in again after a restart");
    expect(hostEl.textContent, "never the thrown value's message or a path").not.toMatch(/EISDIR|\/tmp\//);
  });

  it("Try again asks the engine to renew now, over the bridge, once per press", async () => {
    const asked: { method: unknown; url: unknown }[] = [];
    host.__TAURI_INTERNALS__ = {
      invoke: async (command: string, payload?: { method?: unknown; url?: unknown }) => {
        if (command === "engine_request") asked.push({ method: payload?.method, url: payload?.url });
        return null;
      },
    } as never;
    await mount(true);
    const press = [...hostEl.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    expect(press, "the note carries its one verb").toBeDefined();
    await act(async () => { press!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(asked.filter((a) => a.url === "/cloud/session/renew")).toEqual([{ method: "POST", url: "/cloud/session/renew" }]);
  });

  it("says nothing on an install whose seal is landing — the ordinary case", async () => {
    await mount(false);
    expect(hostEl.textContent).not.toContain(NOTE);
  });

  it("…and the sentence comes from the catalogue, so a German install reads German", async () => {
    setActiveCatalog("de", fillFrom(messages as never, de as never) as never);
    await mount(true);
    expect(hostEl.textContent).toContain("konnte auf diesem");
    expect(hostEl.textContent, "no English left standing in the middle of a German pane").not.toContain(NOTE);
  });
});
