/** @vitest-environment jsdom */
/**
 * THE MAIL GROUND'S COMPOSITION STANDS ONCE, OVER THE WEB'S REAL ENTRY. `CloudShell` itself is mounted, as the page
 * mounts it, over a session the server confirms: its own host (`useWebHost`), the supplies every browser host hands
 * (`useMailSupplies`), and the frame over the mail ground. Nothing here is a tests' door.
 *
 * Every part of the composition that stands at this entry is mounted once for the frame's life and stands once at
 * every place: the press seam (the frame's room's own), the mail state, the consent row, the partition's one
 * derivation, the file door and the picture door. The account's consent wire is asked once. A walk from the Ohbox to
 * Settings' Account section and back mounts none of them again and asks the wire nothing again. The rail is the
 * registrations'.
 *
 * Each part is counted live through a wrapper of its own module: the real hook or provider runs, the wrapper counts
 * its mounts. The one composer is counted with the place that writes, in the case that walks there
 * (`composition-once.test.tsx`).
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { OhmailEngine } from "@ohmail/client-engine";
import { armDeleteIntent } from "@ohmail/app-logic/press/delete-intents";
import { UNDO_MS } from "@ohmail/app-logic/press/delete-undo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  ACCOUNT, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession, scriptSync,
  sessionFull, syncPage, teardownConfirmEnv, tick,
} from "../fixtures/cloud-confirm-shell";

const PARTS = ["seam", "mailState", "consentRow", "partition", "fileDoor", "pictureDoor"] as const;
type Part = (typeof PARTS)[number];
const seen = vi.hoisted(() => ({
  mounts: { seam: 0, mailState: 0, consentRow: 0, partition: 0, fileDoor: 0, pictureDoor: 0 },
  live: { seam: 0, mailState: 0, consentRow: 0, partition: 0, fileDoor: 0, pictureDoor: 0 },
  /** How often the consent wire's `state` was asked, on whichever wire object the row was handed. */
  asks: 0,
  wires: new WeakSet<object>(),
}));

/** Counts one mount of `part` for the life of the component that calls it. */
const counting = vi.hoisted(() => (part: "seam" | "mailState" | "consentRow" | "partition" | "fileDoor" | "pictureDoor") => () => {
  seen.mounts[part] += 1;
  seen.live[part] += 1;
  return () => {
    seen.live[part] -= 1;
  };
});

vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useShellDispatch: (...args: Parameters<typeof real.useShellDispatch>) => {
      const seam = real.useShellDispatch(...args);
      useEffect(counting("seam"), []);
      return seam;
    },
  };
});

vi.mock("@ohmail/app/mail-state", async (load) => {
  const real = await load<typeof import("@ohmail/app/mail-state")>();
  const { createElement, useEffect } = await import("react");
  function Counted(props: Parameters<typeof real.MailStateProvider>[0]) {
    useEffect(counting("mailState"), []);
    return createElement(real.MailStateProvider, props);
  }
  return { ...real, MailStateProvider: Counted };
});

vi.mock("@ohmail/app-logic/consent/consent-state", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/consent/consent-state")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useConsentState: (...args: Parameters<typeof real.useConsentState>) => {
      /* The wire the row is handed, counted where it is asked: its `state` is wrapped once per wire object. */
      const wire = args[2] as unknown as { state?: (...a: unknown[]) => unknown } | string;
      if (typeof wire === "object" && typeof wire.state === "function" && !seen.wires.has(wire)) {
        seen.wires.add(wire);
        const asked = wire.state;
        wire.state = (...a: unknown[]) => {
          seen.asks += 1;
          return asked.apply(wire, a);
        };
      }
      const row = real.useConsentState(...args);
      useEffect(counting("consentRow"), []);
      return row;
    },
  };
});

vi.mock("@ohmail/app-logic/consent/partition", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/consent/partition")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    usePartitionOf: (...args: Parameters<typeof real.usePartitionOf>) => {
      const record = real.usePartitionOf(...args);
      useEffect(counting("partition"), []);
      return record;
    },
  };
});

vi.mock("@ohmail/app-logic/reader/attachments", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/reader/attachments")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useMessageAttachments: (...args: Parameters<typeof real.useMessageAttachments>) => {
      const door = real.useMessageAttachments(...args);
      useEffect(counting("fileDoor"), []);
      return door;
    },
  };
});

vi.mock("@ohmail/app-logic/reader/remote-images", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/reader/remote-images")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useRemoteImages: (...args: Parameters<typeof real.useRemoteImages>) => {
      const door = real.useRemoteImages(...args);
      useEffect(counting("pictureDoor"), []);
      return door;
    },
  };
});

const ONCE: Record<Part, number> = { seam: 1, mailState: 1, consentRow: 1, partition: 1, fileDoor: 1, pictureDoor: 1 };

const visit = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await tick(1500);
};
/** The frame's own rail, drawn from the places' registrations. */
const rail = (): HTMLElement | null => screen.queryByRole("navigation", { name: "Places" });
/** The Ohbox's list column, as the frame names it. */
const list = (): HTMLElement | null => screen.queryByRole("region", { name: "Messages" });

beforeEach(() => {
  installConfirmEnv();
  resetStorageOwnerForTest();
  window.localStorage.clear();
  for (const part of PARTS) {
    seen.mounts[part] = 0;
    seen.live[part] = 0;
  }
  seen.asks = 0;
});
afterEach(async () => {
  window.history.replaceState(null, "", "/");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  resetStorageOwnerForTest();
  vi.restoreAllMocks();
  await teardownConfirmEnv();
});

describe("the mail ground's composition over the web's real entry", () => {
  it("mounts the press seam, the mail state, the consent row, the partition and the two doors once, and asks the consent wire once, over a walk to Settings and back", async () => {
    scriptSession(() => sessionFull());
    rememberOwner();
    window.location.hash = "#/ohbox";
    await mountCloudShell();
    await tick(2500);
    expect(rail(), "the rail of the registrations").not.toBeNull();
    expect(list(), "the Ohbox's list").not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" }), "a rail today's views feed").toBeNull();
    expect({ mounts: { ...seen.mounts }, live: { ...seen.live }, asks: seen.asks }, "as the frame mounted").toEqual({
      mounts: ONCE, live: ONCE, asks: 1,
    });

    await visit("#/settings/account");
    expect(window.location.hash, "Settings' Account section is a place of this entry").toBe("#/settings/account");
    expect({ ...seen.live }, "at Settings every part still stands, once").toEqual(ONCE);

    await visit("#/ohbox");
    expect(list(), "the Ohbox's list again").not.toBeNull();
    expect({ mounts: { ...seen.mounts }, live: { ...seen.live }, asks: seen.asks }, "after the walk").toEqual({
      mounts: ONCE, live: ONCE, asks: 1,
    });
  }, 60_000);

  it("replays a prior delete once and lets the person undo a different Ohbox delete from Account", async () => {
    Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
    const prior = "prior-letter";
    const subject = "Keep this letter";
    const held = "m_Keep_this_letter";
    scriptSession(sessionFull);
    scriptRefresh(refresh204);
    scriptSync(() => syncPage(subject));
    const wire = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), window.location.origin).pathname === "/api/mailboxes") {
        return Response.json({ items: [{
          id: "mb_1", status: "connected", address: "owner@example.invalid",
          organizerRole: "organizer", organizeConsentedAt: new Date().toISOString(),
        }] });
      }
      return wire(input, init);
    }) as typeof fetch;
    rememberOwner();
    armDeleteIntent({ id: "earlier-press", messageIds: [prior], at: Date.now() }, ACCOUNT);
    const replay = vi.spyOn(OhmailEngine.prototype, "replayDelete");
    const send = vi.spyOn(OhmailEngine.prototype, "mutate");
    const row = () => screen.queryByRole("option", { name: new RegExp(subject) });
    const heldDeletes = () => send.mock.calls.filter(([change]) =>
      change.kind === "message_delete" && change.messageId === held,
    );
    window.location.hash = "#/ohbox";
    await mountCloudShell();
    await tick(2500);
    expect(replay.mock.calls.map(([id]) => id)).toEqual([prior]);
    const selected = screen.getByRole("option", { name: new RegExp(subject) });
    await act(async () => { selected.click(); });
    await tick(250);
    const reader = within(screen.getByRole("region", { name: "Open message" }));
    await act(async () => { fireEvent.click(reader.getByRole("button", { name: "More" })); });
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Delete" })); });
    await tick(50);
    expect(row()).toBeNull();
    expect(heldDeletes()).toHaveLength(0);

    await visit("#/settings/account");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(heldDeletes()).toHaveLength(0);
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "z" }); });
    await visit("#/ohbox");
    expect(row()).toBeTruthy();
    await tick(UNDO_MS + 100);
    expect(heldDeletes()).toHaveLength(0);
    expect(replay.mock.calls.map(([id]) => id)).toEqual([prior]);
  }, 60_000);
});
