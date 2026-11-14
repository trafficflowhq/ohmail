/** @vitest-environment jsdom */
/**
 * THE DESKTOP's ONE-TIME "OPEN EMAIL LINKS WITH OHMAIL?" IN THE NEW SHELL (the switch's point 65): the window's
 * `stageCard` entry hands the ask as its `notice()`, which the frame's one notice slot says beside the list (no part
 * of the new frame draws an entry's `render` there). What the ask does is today's: asked once, every answer kept,
 * nothing said while another question (the first run) stands or where ohmail already takes mail links.
 */
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Said {
  readonly kind: string;
  readonly title: string;
  readonly line?: string;
  readonly acts?: readonly { readonly label: string; readonly onPress: () => void }[];
}
interface Handed {
  readonly features: Record<string, { readonly notice?: () => readonly Said[] } | "none">;
}
const NONE = "none";

const seen: { host: Handed | null } = { host: null };
vi.mock("../../webapp/app/shell/browser-mail", async () => {
  const real = await vi.importActual<object>("../../webapp/app/shell/browser-mail");
  return {
    ...real,
    MailFrame: ({ host }: { host: Handed }) => {
      seen.host = host;
      return null;
    },
  };
});

import type { EngineStatus } from "../src/bridge-fetch.js";
import { DEFAULT_MAIL_ASKED_KEY } from "../src/DesktopDefaultMail.js";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { linkSlot } from "../src/link-in.js";

interface Tauri {
  __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<unknown>; transformCallback: () => number };
}
const tauri = globalThis as unknown as Tauri;
let statusAnswer: { state: string };
let invoked: string[];
beforeEach(() => {
  localStorage.clear();
  invoked = [];
  statusAnswer = { state: "not-default" };
  tauri.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command) => {
      invoked.push(command);
      if (command === "default_mail_status") return statusAnswer;
      if (command === "default_mail_request") return { how: "system-dialog", state: "not-default" };
      return null;
    },
  };
});

const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const props = (firstRunOpen: boolean): DesktopFrameProps => ({
  engine: named("engine"), status: { state: "serving", mode: "local" } as EngineStatus, session: "live",
  sessionRefused: false, sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null,
  storage: null, mayLinkOut: true, manageOffered: false, withdrawManage: () => undefined, rereadAccess: () => undefined,
  reuseSweeps: [], ai: null, setAi: () => undefined, onStatus: () => undefined, openOverlay: () => undefined,
  takeOver: () => undefined, firstRunOpen, firstRun: undefined, takesMailLinks: true, scope: "a-mailbox",
  onUnread: () => undefined, liveBody: named("liveBody"), links: linkSlot(),
  connection: { read: () => null, subscribe: () => () => undefined, set: () => undefined } as unknown as DesktopFrameProps["connection"],
});

/** The notice the window's entry says, read as the frame reads it: its `notice()` called in a part's render. */
let root: Root | null = null;
let said: readonly Said[] = [];
function Says({ notice }: { notice: () => readonly Said[] }) {
  said = notice();
  return null;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
async function noticeOf(firstRunOpen: boolean): Promise<void> {
  const frame = createRoot(document.createElement("div"));
  await act(async () => frame.render(h(DesktopFrame, props(firstRunOpen))));
  const entry = seen.host?.features.stageCard;
  await act(async () => frame.unmount());
  if (entry === undefined || entry === NONE || entry.notice === undefined)
    throw new Error("the window's stageCard entry says no notice");
  root = createRoot(document.createElement("div"));
  const notice = entry.notice;
  await act(async () => root!.render(h(Says, { notice })));
  await settle();
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  said = [];
  seen.host = null;
  delete tauri.__TAURI_INTERNALS__;
});

describe("the desktop's ask to open mail links, as the frame's notice", () => {
  it("is said when another app holds mail links, with Make default and Not now; Not now is kept", async () => {
    await noticeOf(false);
    expect(said.map((n) => n.title)).toEqual(["Open email links with ohmail?"]);
    expect(said[0]!.acts?.map((a) => a.label)).toEqual(["Make default", "Not now"]);
    await act(async () => said[0]!.acts![1]!.onPress());
    await settle();
    expect(said).toEqual([]);
    expect(localStorage.getItem(DEFAULT_MAIL_ASKED_KEY)).toBe("1");
  });

  it("Make default asks the system, says the platform's own sentence with Done, and is never asked again", async () => {
    await noticeOf(false);
    await act(async () => said[0]!.acts![0]!.onPress());
    await settle();
    expect(invoked).toContain("default_mail_request");
    expect(said[0]!.title).toBe("macOS is applying the change — confirm its dialog if one appears.");
    expect(said[0]!.acts?.map((a) => a.label)).toEqual(["Done"]);
    await act(async () => said[0]!.acts![0]!.onPress());
    await settle();
    expect(said).toEqual([]);
    expect(localStorage.getItem(DEFAULT_MAIL_ASKED_KEY)).toBe("1");
  });

  it("says nothing while the first run stands, nor where ohmail already takes mail links", async () => {
    await noticeOf(true);
    expect(said).toEqual([]);
    expect(invoked).not.toContain("default_mail_status");
    await act(async () => root?.unmount());
    statusAnswer = { state: "default" };
    await noticeOf(false);
    expect(said).toEqual([]);
  });
});
