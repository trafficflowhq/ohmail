/** @vitest-environment jsdom */
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { act, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import type { ConnectedSession } from "../src/net/pairing";
import { mount } from "./_rendered-dom";

const connection = vi.hoisted(() => ({ session: null as import("../src/net/pairing").ConnectedSession | null }));
const { setFacePin, setFaceMirror } = vi.hoisted(() => ({ setFacePin: () => undefined, setFaceMirror: () => undefined }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "fixture-uuid" }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/net/connection", () => ({
  useConnection: () => ({ state: { k: "live", session: connection.session }, syncing: false, syncError: null, syncNow: () => undefined }),
}));
vi.mock("../src/net/pairing", () => ({ helloReader: () => null }));
vi.mock("../src/state/store", () => ({
  usePrefs: () => ({ facePin: null, faceMirror: null, setFacePin, setFaceMirror }),
}));
vi.mock("../src/state/mail-event-port", () => ({ mailEventPort: () => null }));
vi.mock("../src/engine/engine-log", () => ({ startUiVitals: () => () => undefined }));

import { useWorld, WorldProvider } from "../src/state/world";

async function account(owner: string, mailboxReply: () => Promise<Response>) {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ store, storePolicy: { mode: "full" }, adapter: {} as never });
  return {
    ownerKey: owner, standalone: false, engine, store, bearer: null,
    profile: { id: owner, accountId: owner, origin: "https://fixture.invalid", apiBase: null, flavor: "selfhost" },
    fetch: (url: string) => url.endsWith("/mailboxes") ? mailboxReply() : Promise.resolve(new Response("{}", { status: 404 })),
  } as unknown as ConnectedSession;
}

const addressed = (label: string) => Response.json({
  items: [{ id: `mailbox-${label}`, address: `${label}@example.test`, status: "connected", lastSyncAt: "2026-11-20T10:00:00Z" }],
});

function renderRoster() {
  const frames: { owner: string; known: boolean; rows: string[]; own: readonly string[]; observed: number | null }[] = [];
  function ReadRoster() {
    const world = useWorld();
    useLayoutEffect(() => {
      frames.push({
        owner: world.worldKey, known: world.mailboxes.known, rows: world.mailboxes.rows.map((row) => row.id),
        own: world.mailboxes.ownAddresses, observed: world.mailboxes.readAt(),
      });
    }, [world]);
    return null;
  }
  const tree = () => <WorldProvider><ReadRoster /></WorldProvider>;
  const view = mount(tree());
  return { frames, switchTo: (next: ConnectedSession) => {
    connection.session = next;
    view.render(tree());
  }, unmount: view.unmount };
}

it("starts the next account with an unknown roster on the first committed frame", async () => {
  const first = await account("first", async () => addressed("first"));
  let answerNext!: (reply: Response) => void;
  const awaitingNext = new Promise<Response>((resolve) => { answerNext = resolve; });
  const next = await account("next", () => awaitingNext);
  const sentFolders = vi.spyOn(next.engine, "setSentFolders");
  connection.session = first;
  const view = renderRoster();
  try {
    await act(async () => {});
    expect(view.frames.at(-1)).toMatchObject({ owner: "first", known: true, rows: ["mailbox-first"], own: ["first@example.test"] });
    view.switchTo(next);
    expect(view.frames.find((frame) => frame.owner === "next")).toEqual({
      owner: "next", known: false, rows: [], own: [], observed: null,
    });
    expect(sentFolders).not.toHaveBeenCalled();
    await act(async () => { answerNext(addressed("next")); });
    expect(view.frames.at(-1)).toMatchObject({ owner: "next", known: true, rows: ["mailbox-next"], own: ["next@example.test"] });
  } finally {
    view.unmount();
  }
});

it("ignores the previous session's delayed mailbox reply after a direct switch", async () => {
  let answerFirst!: (reply: Response) => void;
  const awaitingFirst = new Promise<Response>((resolve) => { answerFirst = resolve; });
  const first = await account("first", () => awaitingFirst);
  const next = await account("next", async () => addressed("next"));
  connection.session = first;
  const view = renderRoster();
  try {
    view.switchTo(next);
    await act(async () => {});
    const confirmed = view.frames.at(-1);
    expect(confirmed).toMatchObject({ owner: "next", known: true, rows: ["mailbox-next"], own: ["next@example.test"] });
    await act(async () => { answerFirst(addressed("first")); });
    expect(view.frames.at(-1)).toEqual(confirmed);
    expect(view.frames.filter((frame) => frame.owner === "next").flatMap((frame) => frame.rows)).not.toContain("mailbox-first");
  } finally {
    view.unmount();
  }
});
