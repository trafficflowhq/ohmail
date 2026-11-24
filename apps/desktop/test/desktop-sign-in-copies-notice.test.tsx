/** @vitest-environment jsdom */
/**
 * When ohmail ends sign-ins used by an older copy, a Cloud desktop window shows the same notice
 * as the web. The account strip offers OK and Details, which shows advice and lists the affected
 * sign-ins by client and date.
 */
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import settings from "../../../packages/app/messages/settings.en.json";

interface Said {
  readonly kind: string;
  readonly title: string;
  readonly line?: string;
  readonly acts?: readonly { readonly label: string; readonly onPress: () => void }[];
  readonly more?: { readonly label: string; readonly line?: string; readonly rows: readonly string[] };
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
    expect(n!.more?.line).toBe(settings.settings.reuseSweepsBody);
    expect(n!.more?.line).not.toBe(n!.title);
    expect(n!.acts).toHaveLength(1);
    expect(n!.more?.label).toBe(settings.settings.reuseSweepsDetails);
    expect(n!.more?.rows).toHaveLength(2);
    expect(n!.more?.rows[0]).toContain("2026");
    expect(n!.more?.rows[1]).toContain("2026");
    expect(n!.more?.rows[0]).not.toBe(n!.more?.rows[1]);
  });
});
