/** @vitest-environment jsdom */
/**
 * THE SIGN-INS OHMAIL SIGNED OUT BECAUSE AN OLDER COPY USED THEM, ON THE DESKTOP's WINDOW (the switch's point 66: a
 * security notice): the window's account strip says the notice the web says, in the frame's one slot:
 * the sentence, the advice as its line, OK, and Details, behind which each swept sign-in stands by its client and its
 * date (the frame opens the list: `packages/app/test/frame/notice-more.test.tsx`). A window signed in to the Cloud.
 */
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Said {
  readonly kind: string;
  readonly title: string;
  readonly line?: string;
  readonly acts?: readonly { readonly label: string; readonly onPress: () => void }[];
  readonly more?: { readonly label: string; readonly rows: readonly string[] };
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
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { DesktopLocale } from "../src/DesktopLocale.js";
import { linkSlot } from "../src/link-in.js";

const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const SWEEPS = [
  { id: "s1", at: "2026-09-26T18:32:49.000Z", client: "desktop-linux" },
  { id: "s2", at: "2026-09-25T07:10:00.000Z", client: "web" },
];
const props: DesktopFrameProps = {
  engine: named("engine"), status: { state: "serving", mode: "cloud" } as EngineStatus, session: "live",
  sessionRefused: false, sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null,
  storage: null, mayLinkOut: true, manageOffered: false, withdrawManage: () => undefined, rereadAccess: () => undefined,
  reuseSweeps: SWEEPS, recheckSweeps: async () => undefined, ai: null, setAi: () => undefined,
  onStatus: () => undefined, openOverlay: () => undefined, takeOver: () => undefined, firstRunOpen: false,
  firstRun: undefined, takesMailLinks: true, scope: "a-mailbox", onUnread: () => undefined, liveBody: named("liveBody"),
  links: linkSlot(),
  connection: { read: () => null, subscribe: () => () => undefined, set: () => undefined } as unknown as DesktopFrameProps["connection"],
};

let root: Root | null = null;
let said: readonly Said[] = [];
function Says({ notice }: { notice: () => readonly Said[] }) {
  said = notice();
  return null;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  said = [];
  seen.host = null;
});

describe("the desktop's sign-ins signed out, as the frame's notice", () => {
  it("says the advice in its line, OK, and Details behind which each sign-in stands by its client and date", async () => {
    const frame = createRoot(document.createElement("div"));
    await act(async () => frame.render(h(DesktopLocale, null, h(DesktopFrame, props))));
    const entry = seen.host?.features.accountStrip;
    await act(async () => frame.unmount());
    if (entry === undefined || entry === NONE || entry.notice === undefined)
      throw new Error("the window's accountStrip entry says no notice");
    const notice = entry.notice;
    root = createRoot(document.createElement("div"));
    await act(async () =>
      root!.render(h(DesktopLocale, null, h(Says, { notice }))),
    );
    expect(said).toHaveLength(1);
    const [n] = said;
    expect(n!.kind).toBe("signInCopies");
    /* The advice is its line, apart from its sentence; one act (OK), and Details its more: each sign-in a row of its
       own, with its date. The words are the catalogue's (the web's case reads them by key). */
    expect(n!.line ?? "").not.toBe("");
    expect(n!.line).not.toBe(n!.title);
    expect(n!.acts).toHaveLength(1);
    expect(n!.more?.label ?? "").not.toBe("");
    expect(n!.more?.rows).toHaveLength(2);
    expect(n!.more?.rows[0]).toContain("2026");
    expect(n!.more?.rows[1]).toContain("2026");
    expect(n!.more?.rows[0]).not.toBe(n!.more?.rows[1]);
  });
});
