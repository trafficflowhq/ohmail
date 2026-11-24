/** @vitest-environment jsdom */
/**
 * THE MAILBOXES ENTRY's NOTICES ON THE DESKTOP's HOST: the organizer's change and the gap's
 * offer reach the frame's notice slot through the entry the window hands, over the window's own two wires. The
 * frame itself is not drawn here: the host is captured as the window hands it to the frame.
 */
import { createElement as h } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the case reads of the host the window hands its frame: the entries and the wires, by name. */
interface Handed {
  readonly features: Record<string, { readonly notice?: { readonly name: string } } | "none">;
  readonly wires: Record<string, unknown>;
}
/** The host contract's word for an answer a host does not have. */
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
import { CLOUD_URL } from "../src/doors.js";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { linkSlot } from "../src/link-in.js";

const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const status = (s: Partial<EngineStatus>): EngineStatus => ({ state: "serving", ...s }) as EngineStatus;
const onItsOwn = status({ mode: "local" });
const managed = status({ mode: "cloud", cloudUrl: CLOUD_URL });

const props = (s: EngineStatus): DesktopFrameProps => ({
  engine: named("engine"), status: s, session: "live", sessionRefused: false, sealFailed: false,
  paired: false, hostLabel: null, freshness: null, account: s === onItsOwn ? null : "acct-1",
  storage: null, mayLinkOut: true, manageOffered: false, withdrawManage: () => undefined, rereadAccess: () => undefined,
  reuseSweeps: [], ai: null, setAi: () => undefined, onStatus: () => undefined, openOverlay: () => undefined,
  takeOver: () => undefined, firstRunOpen: false, firstRun: undefined, takesMailLinks: true, scope: "a-mailbox",
  onUnread: () => undefined, liveBody: named("liveBody"), links: linkSlot(),
  /* No connection is known: a feed that reads none and never moves. */
  connection: { read: () => null, subscribe: () => () => undefined, set: () => undefined } as unknown as DesktopFrameProps["connection"],
});

let root: ReturnType<typeof createRoot> | null = null;
async function hostOf(p: DesktopFrameProps): Promise<Handed> {
  root ??= createRoot(document.createElement("div"));
  await act(async () => root!.render(h(DesktopFrame, p)));
  if (seen.host === null) throw new Error("the window handed the frame no host");
  return seen.host;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  seen.host = null;
});

describe("the desktop's Mailboxes entry", () => {
  it.each([
    ["on its own", onItsOwn],
    ["on the managed door", managed],
  ])("%s: says the mail ground's mailbox notices over the window's own wires", async (_door, s) => {
    const host = await hostOf(props(s));
    const entry = host.features.mailboxes;
    if (entry === NONE) throw new Error("the window lists its Mailboxes section");
    /* The window composes the shared Mailboxes notices and its Away notice in this entry. */
    expect(entry.notice?.name).toBe("useMailboxNotices");
    expect(host.wires.organizerNotice).not.toBe(NONE);
    expect(host.wires.gapLetters).not.toBe(NONE);
  });
});
