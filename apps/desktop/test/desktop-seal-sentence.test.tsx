/** @vitest-environment jsdom */
import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { cleanInstallPane, mountInstallPane } from "./_install-pane.js";

/**
 * A SEAL THAT DID NOT LAND IS SAID IN THE DESKTOP PANE.
 *
 * The gate carries `/health.sealed` to the registered Desktop pane. A refused save withholds
 * the renewal, and a relaunch resumes the saved session without asking the person to sign in.
 *
 * MUTATIONS WATCHED RED: the note rendered unconditionally → the healthy case reddens; the note
 * removed → the refused case; Try again not reaching the engine → the press case.
 */

const status: EngineStatus = {
  state: "serving", mode: "cloud", credentialState: "ready", address: "me@ohmail.test",
  mailboxId: "mailbox-1", cloudUrl: "https://api.ohmail.app",
} as EngineStatus;

function mount(
  sealFailed: boolean, locale: "en" | "de" = "en", asked: { method: unknown; url: unknown }[] = [],
) {
  return mountInstallPane({
    status,
    locale,
    answer: ({ method, url, path }) => {
      asked.push({ method, url });
      if (path === "/health") return { body: { signedIn: true, sessionExpired: false, sealed: !sealFailed } };
      if (path === "/cloud/session/renew") return { body: {} };
      return undefined;
    },
  });
}

afterEach(cleanInstallPane);

const NOTE = "could not be saved on this";

describe("Settings → Desktop says when this install's sign-in did not reach the disk", () => {
  it("renders the sentence while the engine reports the seal refused", async () => {
    const pane = await mount(true);
    expect(pane.textContent).toContain(NOTE);
    expect(pane.textContent, "and it names what happens next, not the filesystem's error")
      .toContain("you stay signed in");
    expect(pane.textContent, "the old promise of a sign-in after a restart is gone — it is false now")
      .not.toContain("sign in again after a restart");
    expect(pane.textContent, "never the thrown value's message or a path").not.toMatch(/EISDIR|\/tmp\//);
  });

  it("Try again asks the engine to renew now, over the bridge, once per press", async () => {
    const asked: { method: unknown; url: unknown }[] = [];
    const pane = await mount(true, "en", asked);
    const press = [...pane.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    expect(press, "the note carries its one verb").toBeDefined();
    await act(async () => { fireEvent.click(press!); });
    expect(asked.filter((a) => a.url === "/cloud/session/renew")).toEqual([{ method: "POST", url: "/cloud/session/renew" }]);
  });

  it("says nothing on an install whose seal is landing — the ordinary case", async () => {
    const pane = await mount(false);
    expect(pane.textContent).not.toContain(NOTE);
  });

  it("…and the sentence comes from the catalogue, so a German install reads German", async () => {
    const pane = await mount(true, "de");
    expect(pane.textContent).toContain("konnte auf diesem");
    expect(pane.textContent, "no English left standing in the middle of a German pane").not.toContain(NOTE);
  });
});
