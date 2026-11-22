/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_BOOTSTRAPPING, SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { afterEach, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import { FOLDERS_ON, LIST_WORDS, listFrame } from "../places/list-seat.js";

afterEach(cleanup);

it("distinguishes an empty inventory from an inventory still loading", async () => {
  const { host } = listFrame({ letters: [], first: "#/ohbox", consent: FOLDERS_ON });
  const frame = (sync: typeof SYNC_SETTLED) => (
    <EngineContext.Provider value={{ engine: host.engine, demo: false, serverDemo: false, sync }}>
      <TextProvider locale="en" messages={LIST_WORDS} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>
    </EngineContext.Provider>
  );
  const { rerender } = render(frame(SYNC_BOOTSTRAPPING));
  await screen.findByRole("button", { name: "Folders" });
  expect(screen.queryByRole("status", { name: "Loading folders" })?.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("No folders on your mail server yet.")).toBeNull();

  rerender(frame(SYNC_SETTLED));
  expect(screen.queryByRole("status", { name: "Loading folders" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Folders" })).toBeNull();
});
