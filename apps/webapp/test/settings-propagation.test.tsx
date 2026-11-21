/** @vitest-environment jsdom */
import { queryByRole } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";

/**
 * ═══ A SETTINGS FLIP ON ANOTHER SURFACE REACHES THIS ONE, LIVE — no restart, no reload ═══════
 *
 * The measured defect (owner, live): disabling folders on the web left the desktop showing the
 * folders group — a "no folders" husk over tombstoned entities — until the app was restarted.
 * The consent answer was read once at boot; folder ENTITIES synced, the SETTING did not.
 *
 * The propagation seam, end to end through the SHIPPED shell:
 *
 *  · every consent-settings writer appends a `settings` change row in its own transaction
 *    (`packages/services/test/settings-sync.test.ts`), which rings the wake at commit;
 *  · the row arrives in this client's mirror on the next drain — here, via the driven `/sync`;
 *  · `AppShell` reads the record's `updatedAt` as a stamp and `useConsentState` re-asks
 *    `GET /consent` on every stamp transition — the live read stays the authority;
 *  · the rail re-renders from the fresh answer: the group DISAPPEARS on a flip to off (never
 *    the husk), and APPEARS on a flip to on.
 *
 * Both directions of the cross-surface story land on this same seam: a flip made on the web
 * writes the hosted row whose change the DESKTOP mirror re-emits locally
 * (`apps/sidecar/test/cloud-mirror-settings.test.ts`), and a flip made on the desktop is
 * FORWARDED to the same hosted writer (`apps/desktop/test/desktop-cloud-settings.test.tsx`)
 * whose change reaches this browser's own drain — which is exactly what is driven here.
 *
 * The third render is pinned too: with the flag ON and ZERO folder entities, an unsettled
 * mirror shows SKELETON rows — "no folders on your mail server yet" is a sentence only a
 * settled mirror may say.
 */

const FOLDER_ID = "fd_props";
const STAMP_OFF = "2026-08-04T10:00:00.000Z";
const STAMP_ON = "2026-08-04T11:00:00.000Z";

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

const folderCreate = (seq: number) => ({
  type: "folder", op: "create", id: FOLDER_ID, seq, updatedAt: ISO,
  entity: { id: FOLDER_ID, name: "Project receipts", mailboxId: "mb_1", mailbox: "walker@example.invalid", updatedAt: ISO },
});
const folderDelete = (seq: number) => ({
  type: "folder", op: "delete", id: FOLDER_ID, seq, updatedAt: ISO,
});
const settingsRow = (seq: number, foldersEnabledAt: string | null, stamp: string) => ({
  type: "settings", op: "update", id: "acct_live_1", seq, updatedAt: stamp,
  entity: {
    accountId: "acct_live_1", dormancyDays: null, autoSuggestAt: null,
    blockRemoteImagesAt: null, loadTrackingPixelsAt: null, blockAutoUnsubscribeAt: null,
    foldersEnabledAt, folderMailboxesOff: {}, locale: null, updatedAt: stamp,
  },
});

const pageOf = (creates: unknown[], deletes: unknown[], cursor: string): Response =>
  json({
    changes: { creates, updates: [], moves: [], deletes },
    cursor, hasMore: false, serverTime: ISO,
  });

const foldersToggle = (el: HTMLElement): string | undefined =>
  queryByRole(el, "button", { name: "Folders" })?.textContent?.trim();

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(async () => {
  await teardownShellEnv();
});

describe("a consent read outliving the hook's active era applies nothing", () => {
  /**
   * The live→demo transition (and an unmount) deactivates the hook while a `GET /consent` can
   * still be in the air. The extracted `fetchLive` briefly lost the old inline effect's `live`
   * flag, so the late response installed account state into the inactive shell. The era guard
   * closes it: the boot effect's cleanup ends the era, and a read captured in an earlier era
   * applies neither state nor cache.
   */
  it("a read resolving after active flips false leaves the hook at rest", async () => {
    const { useConsentState } = await import("@ohmail/app-logic/consent/consent-state");
    const React = (await import("react")) as typeof import("react");
    const { createRoot } = await import("react-dom/client");
    const ract = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

    let release: ((v: unknown) => void) | null = null;
    const transport = {
      state: () => new Promise((r) => { release = r as (v: unknown) => void; }),
      setAutoSuggest: async () => ({ autoSuggestAt: null }),
      setDormancyDays: async () => ({ dormancyDays: 60 }),
      setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
      setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
      setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
      setFoldersEnabled: async () => ({ foldersEnabledAt: null }),
      setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
    } as never;

    let seen: { known: boolean } | null = null;
    function Probe({ active }: { active: boolean }): null {
      seen = useConsentState(active, null, transport);
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await ract(async () => { root.render(React.createElement(Probe, { active: true })); });
    expect(release, "the transport was never asked — the probe is broken").not.toBeNull();

    // The shell deactivates — the demo transition — while the read is still in the air.
    await ract(async () => { root.render(React.createElement(Probe, { active: false })); });
    // The late answer lands. It belongs to a closed era and must change nothing.
    await ract(async () => {
      release!({ dormancyDays: 45, seedConfirmedAt: ISO, foldersEnabledAt: ISO });
      await Promise.resolve();
    });
    expect(seen!.known, "a closed era's answer was installed into the inactive shell").toBe(false);
    await ract(async () => root.unmount());
    host.remove();
  });
});

describe("settings changes propagate through the sync channel to an open shell", () => {
  it("a flip to OFF arriving on /sync makes the folders group DISAPPEAR — never the husk", async () => {
    // Boot: folders on, one folder in the mirror.
    answerConsentWith({ foldersEnabledAt: ISO });
    let phase: "on" | "off" | "idle" = "on";
    answerSyncWith(() => {
      if (phase === "on") {
        phase = "idle";
        return pageOf([folderCreate(1)], [], "c1");
      }
      if (phase === "off") {
        phase = "idle";
        // The flip, exactly as the hosted log carries it: the setting AND the entity tombstones.
        return pageOf([settingsRow(2, null, STAMP_OFF)], [folderDelete(3)], "c3");
      }
      return pageOf([], [], "cIdle");
    });
    const el = await mountShell([mailbox()]);
    await tick(30_000);
    expect(foldersToggle(el), "the group never rendered — the fixture is broken").toBe("Folders");

    // Another surface flips the master OFF: the account's next /sync page carries the settings
    // row and the folder tombstones, and the live consent answer changes underneath.
    answerConsentWith({ foldersEnabledAt: null });
    phase = "off";
    await tick(30_000); // past the poll cadence: drain → stamp moves → re-ask → re-render

    expect(foldersToggle(el), "the group survived a flip made on another surface").toBeUndefined();
    // NEVER the husk: the reported symptom was this exact string over a dead group.
    expect(textOf(el)).not.toContain("No folders on your mail server yet.");
  });

  it("a flip to ON arriving on /sync grows the group live, folder row included", async () => {
    answerConsentWith({});
    let phase: "boot" | "on" | "idle" = "boot";
    answerSyncWith(() => {
      if (phase === "boot") {
        phase = "idle";
        return pageOf([], [], "c1");
      }
      if (phase === "on") {
        phase = "idle";
        return pageOf([settingsRow(2, STAMP_ON, STAMP_ON), folderCreate(3)], [], "c3");
      }
      return pageOf([], [], "cIdle");
    });
    const el = await mountShell([mailbox()]);
    await tick(30_000);
    expect(foldersToggle(el)).toBeUndefined();

    answerConsentWith({ foldersEnabledAt: STAMP_ON });
    phase = "on";
    await tick(30_000);

    expect(foldersToggle(el), "the group never appeared after a flip made elsewhere").toBe("Folders");
    expect(queryByRole(el, "button", { name: "Project receipts" })).not.toBeNull();
  });

  it("flag on + zero entities: skeleton while the mirror is unsettled, the honest empty line after", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    // Hold the FIRST drain open: while no drain has completed, `bootstrapping` is true and an
    // empty folder inventory is a question, not an answer.
    let release: ((r: Response) => void) | null = null;
    let held = false;
    answerSyncWith((() => {
      if (!held) {
        held = true;
        return new Promise<Response>((r) => { release = r; }) as unknown as Response;
      }
      return pageOf([], [], "cIdle");
    }) as () => Response);

    const el = await mountShell([mailbox()]);
    await tick(1_000);

    // UNSETTLED: the group stands (the flag is on), its content is the skeleton — and the
    // sentence only a settled mirror may say is nowhere.
    expect(foldersToggle(el)).toBe("Folders");
    expect.soft(queryByRole(el, "status", { name: "Loading folders" }), "no skeleton over the unsettled mirror").not.toBeNull();
    expect(textOf(el)).not.toContain("No folders on your mail server yet.");

    // The drain settles with a genuinely empty inventory: the skeleton yields to the honest line.
    release!(pageOf([], [], "c1"));
    await tick(30_000);
    expect(queryByRole(el, "status", { name: "Loading folders" })).toBeNull();
    expect(textOf(el)).toContain("No folders on your mail server yet.");
  });
});
