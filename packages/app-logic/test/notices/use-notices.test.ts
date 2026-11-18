/** @vitest-environment jsdom */
/**
 * The one caller: at each settle it samples the copy, asks the gate and hands the emitter what the
 * gate answered. A switch that is off calls nothing; another account starts from nothing and takes
 * back what was drawn for the one left.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  MAIL_NOTICE_KINDS,
  MemoryMirrorStore,
  OhmailEngine,
  HttpAdapter,
  NOTICE_KINDS,
  aheadAlert,
  aheadSet,
  noticeChoicesOf,
  type AheadSet,
  type Clock,
  type Notice,
  type NoticeAct,
  type NoticeAhead,
  type NoticeChoices,
  type NoticeDevices,
  type NoticeKind,
  type NoticePermission,
  type NoticeTaken,
  type SyncChange,
} from "@ohmail/client-engine";
import { intlZones } from "@ohmail/cal-core";
import { createSyncGate, registerSyncGate } from "../../src/session/sync-scheduler.js";
import { markSessionDead, resetSessionTruthForTests } from "../../src/session/session-truth.js";
import { OWNER_COOKIE, readOwner } from "../../src/storage/owner-cookie.js";
import { resetStorageOwnerForTest, setStorageOwner, storageOwner } from "../../src/storage/storage-owner.js";
import { calendarReadsOf, liveCalendarScope } from "../../src/calendar/alerts/index.js";
import {
  OWN,
  ZURICH,
  calendarOf as shownCalendar,
  invitation,
  suggestion,
} from "../calendar/invitations/fixtures.js";
import type { StorageDoor } from "@ohmail/client-engine/durable";
import {
  NoticeCaller,
  noticeReadsOf,
  showDevicesListed,
  toldDevicesIn,
  toldDevicesKey,
  useNotices,
  type CalendarReads,
  type HostNoticeEmitter,
  type NoticesMount,
  type ToldDevices,
  type ToldDevicesStore,
} from "../../src/notices/use-notices.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-11-17T09:00:00.000Z";
let seq = 0;
const letter = (id: string): SyncChange =>
  ({
    type: "message",
    op: "create",
    id,
    seq: ++seq,
    updatedAt: AT,
    entity: {
      id,
      accountId: "acct",
      mailboxId: "mb",
      threadId: null,
      messageIdHeader: null,
      subject: "A subject",
      from: { name: "A sender", address: "a@example.org" },
      to: [],
      cc: [],
      date: AT,
      folder: "INBOX",
      snippet: "",
      unread: true,
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      sensitivity: {
        sensitive: false,
        category: null,
        no_ai: false,
        no_forward: false,
        no_kb: false,
        priority: false,
      },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: AT,
    },
  }) as SyncChange;

async function copyWith(...ids: string[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  if (ids.length > 0) await store.applyChanges(ids.map(letter));
  return store;
}

/**
 * An emitter that records what it is handed and what it takes back. It answers `takes` for each
 * notice: by default the platform took it.
 */
function recording(
  carries: readonly NoticeKind[] = MAIL_NOTICE_KINDS,
  takes: (notice: Notice) => NoticeTaken | void = () => true,
) {
  const posted: Notice[] = [];
  let takenBack = 0;
  const emitter: HostNoticeEmitter = {
    carries,
    acts: [],
    ahead: "none",
    post: (notice) => {
      posted.push(notice);
      return takes(notice);
    },
    takeBack: () => {
      takenBack += 1;
    },
  };
  return { emitter, posted, takenBack: () => takenBack };
}

/** A device's storage, as a door over a map. */
function jar(): StorageDoor & { readonly kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    get: (key) => kept.get(key) ?? null,
    set: (key, value) => {
      kept.set(key, value);
      return "stored";
    },
    remove: (key) => {
      kept.delete(key);
      return "stored";
    },
  };
}

function callerOf(
  emitter: HostNoticeEmitter,
  over: {
    choices?: Partial<NoticeChoices>;
    permission?: () => NoticePermission;
    devices?: () => NoticeDevices | null;
    atDevices?: () => ToldDevices | null;
    told?: ToldDevicesStore;
    calendar?: CalendarReads;
  } = {},
) {
  return new NoticeCaller(emitter, {
    choices: () => ({ ...noticeChoicesOf(null, null, { ohcalPhone: false }), ...over.choices }),
    permission: over.permission ?? (() => "granted"),
    devices: over.devices ?? (() => null),
    atDevices: over.atDevices ?? (() => null),
    told: over.told ?? toldDevicesIn(jar()),
    calendar: over.calendar ?? "none",
  });
}

describe("the one caller", () => {
  it("draws nothing for the copy it first sees, then hands the emitter what arrived", async () => {
    const r = recording();
    const caller = callerOf(r.emitter);
    const store = await copyWith("one", "two");
    caller.settle("acct-a", store);
    expect(r.posted, "an app opened over two unread letters has not just received two").toEqual([]);
    await store.applyChanges([letter("three")]);
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([{ kind: "ohbox", count: 1 }]);
    caller.settle("acct-a", store);
    expect(r.posted, "a settle with nothing new draws nothing").toHaveLength(1);
  });

  it("calls the emitter for nothing while the kind's switch, the master or the platform says no", async () => {
    for (const over of [
      { choices: { ohbox: false } },
      { choices: { master: false } },
      { permission: () => "denied" as const },
    ]) {
      const r = recording();
      const caller = callerOf(r.emitter, over);
      const store = await copyWith();
      caller.settle("acct-a", store);
      await store.applyChanges([letter(`n-${seq}`)]);
      caller.settle("acct-a", store);
      expect(r.posted, JSON.stringify(over)).toEqual([]);
    }
  });

  it("tells a new device and a take-back from what the surface hands in of the account's devices", async () => {
    const r = recording();
    let devices: NoticeDevices | null = { made: 2, revoked: 0, live: 2 };
    const caller = callerOf(r.emitter, { devices: () => devices });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(r.posted, "the first sample of an account tells nothing").toEqual([]);
    // One device signed itself out and another was paired: as many are signed in as before.
    devices = { made: 3, revoked: 0, live: 2 };
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([{ kind: "pairing", change: "paired", device: null }]);
    devices = { made: 3, revoked: 1, live: 1 };
    caller.settle("acct-a", store);
    expect(r.posted.slice(1)).toEqual([{ kind: "pairing", change: "revoked", device: null }]);
  });

  it("a settle at which the devices are not told keeps what the last one was told", async () => {
    const r = recording();
    let devices: NoticeDevices | null = { made: 2, revoked: 0, live: 2 };
    const caller = callerOf(r.emitter, { devices: () => devices });
    const store = await copyWith();
    caller.settle("acct-a", store);
    devices = null;
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([]);
    // The device paired while the numbers were missing is told once they are read again.
    devices = { made: 3, revoked: 0, live: 3 };
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([{ kind: "pairing", change: "paired", device: null }]);
    // Another account starts from nothing: its numbers are compared with none of the account left.
    devices = { made: 9, revoked: 4, live: 5 };
    caller.settle("acct-b", store);
    expect(r.posted).toHaveLength(1);
  });

  it("hands an emitter no kind it does not carry", async () => {
    const r = recording(["screener"]);
    const caller = callerOf(r.emitter);
    const store = await copyWith();
    caller.settle("acct-a", store);
    await store.applyChanges([letter("arrived")]);
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([]);
  });

  it("at an account switch takes back what was drawn, and the next account's first sample draws nothing", async () => {
    const r = recording();
    const caller = callerOf(r.emitter);
    const left = await copyWith();
    caller.settle("acct-a", left);
    await left.applyChanges([letter("for-a")]);
    caller.settle("acct-a", left);
    expect(r.posted).toHaveLength(1);
    expect(r.takenBack()).toBe(0);

    // The next account's copy holds three unread letters the first account never had.
    const next = await copyWith("b1", "b2", "b3");
    caller.settle("acct-b", next);
    expect(r.takenBack(), "what was drawn for the account left stays listed").toBe(1);
    expect(r.posted, "the next account's mail was compared against the account left").toHaveLength(1);
    await next.applyChanges([letter("b4")]);
    caller.settle("acct-b", next);
    expect(r.posted.at(-1)).toEqual({ kind: "ohbox", count: 1 });
  });

  it("at sign-out takes back what was drawn and starts from nothing again", async () => {
    const r = recording();
    const caller = callerOf(r.emitter);
    const store = await copyWith();
    caller.settle("acct-a", store);
    caller.end();
    expect(r.takenBack()).toBe(1);
    await store.applyChanges([letter("after")]);
    caller.settle("acct-a", store);
    expect(r.posted, "the first sample after the end seeds again").toEqual([]);
  });

  it("an emitter that throws while taking back takes nothing else down", async () => {
    const r = recording();
    const caller = callerOf({
      ...r.emitter,
      takeBack: () => {
        throw new Error("no");
      },
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(() => caller.settle("acct-b", store)).not.toThrow();
    expect(() => caller.end()).not.toThrow();
  });
});

/** The account's settings record as the feed delivers it, with its three device numbers. */
const settingsRecord = (devices: { made: number; revoked: number; live: number }): SyncChange =>
  ({
    type: "settings",
    op: "update",
    id: "acct",
    seq: ++seq,
    updatedAt: AT,
    entity: {
      accountId: "acct",
      dormancyDays: null,
      folderMailboxesOff: {},
      locale: null,
      updatedAt: AT,
      devices: devices.live,
      devicesMade: devices.made,
      devicesRevoked: devices.revoked,
    },
  }) as SyncChange;

const PAIRED: Notice = { kind: "pairing", change: "paired", device: null };
const REVOKED: Notice = { kind: "pairing", change: "revoked", device: null };

describe("what this device has told of the account's devices", () => {
  /** A device's storage that already holds what was told for `scope`. */
  const jarWith = (scope: string, made: number, revoked: number) => {
    const door = jar();
    toldDevicesIn(door).write(scope, { made, revoked });
    return door;
  };
  const keptIn = (door: StorageDoor, scope: string) => toldDevicesIn(door).read(scope);

  it("a device paired while every app was closed is told at the first settle after a start, and once", async () => {
    const door = jarWith("acct-a", 1, 0);
    const store = await copyWith();
    // The app starts: the record already says two devices were made.
    const first = recording();
    callerOf(first.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      told: toldDevicesIn(door),
    }).settle("acct-a", store);
    expect(first.posted).toEqual([PAIRED]);
    expect(keptIn(door, "acct-a")).toEqual({ made: 2, revoked: 0 });
    // And starts again: the same record, told already.
    const second = recording();
    callerOf(second.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      told: toldDevicesIn(door),
    }).settle("acct-a", store);
    expect(second.posted).toEqual([]);
  });

  it("a first sign-in on this device tells nothing and keeps what the record says", async () => {
    const door = jar();
    const r = recording();
    let devices: NoticeDevices = { made: 3, revoked: 1, live: 2 };
    const caller = callerOf(r.emitter, { devices: () => devices, told: toldDevicesIn(door) });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(r.posted, "this device is the new one, or learns from now").toEqual([]);
    expect(keptIn(door, "acct-a")).toEqual({ made: 3, revoked: 1 });
    devices = { made: 4, revoked: 1, live: 3 };
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([PAIRED]);
  });

  it("drawn nowhere while this surface is the one looked at, the numbers stay and the next settle tells", async () => {
    const door = jarWith("acct-a", 1, 0);
    let inFront = true;
    const drawn: Notice[] = [];
    const r = recording(MAIL_NOTICE_KINDS, (notice) => {
      if (inFront) return false;
      drawn.push(notice);
      return true;
    });
    const caller = callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      told: toldDevicesIn(door),
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(drawn).toEqual([]);
    expect(keptIn(door, "acct-a"), "advanced though nothing was drawn").toEqual({ made: 1, revoked: 0 });
    inFront = false;
    caller.settle("acct-a", store);
    expect(drawn).toEqual([PAIRED]);
    expect(keptIn(door, "acct-a")).toEqual({ made: 2, revoked: 0 });
    caller.settle("acct-a", store);
    expect(drawn, "told once").toEqual([PAIRED]);
  });

  it("is not advanced while the platform's permission is off, and tells once it is given", async () => {
    const door = jarWith("acct-a", 1, 0);
    let permission: NoticePermission = "denied";
    const r = recording();
    const caller = callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      permission: () => permission,
      told: toldDevicesIn(door),
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([]);
    expect(keptIn(door, "acct-a")).toEqual({ made: 1, revoked: 0 });
    permission = "granted";
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([PAIRED]);
    expect(keptIn(door, "acct-a")).toEqual({ made: 2, revoked: 0 });
  });

  it("is not advanced by an emitter that refuses, rejects or does not say", async () => {
    const answers: [string, () => NoticeTaken | void][] = [
      ["refused at once", () => false],
      ["refused by the platform's answer", () => Promise.resolve(false)],
      ["a rejection", () => Promise.reject(new Error("no"))],
      ["no answer", () => undefined],
    ];
    for (const [what, takes] of answers) {
      const door = jarWith("acct-a", 1, 0);
      const r = recording(MAIL_NOTICE_KINDS, takes);
      const caller = callerOf(r.emitter, {
        devices: () => ({ made: 2, revoked: 0, live: 2 }),
        told: toldDevicesIn(door),
      });
      const store = await copyWith();
      caller.settle("acct-a", store);
      await Promise.resolve();
      await Promise.resolve();
      expect(r.posted, what).toEqual([PAIRED]);
      expect(keptIn(door, "acct-a"), what).toEqual({ made: 1, revoked: 0 });
      caller.settle("acct-a", store);
      expect(r.posted, `${what}: the same rise is handed over again`).toEqual([PAIRED, PAIRED]);
    }
  });

  it("is advanced once the platform's later answer says it took the notice", async () => {
    const door = jarWith("acct-a", 1, 0);
    let answer: (taken: boolean) => void = () => {};
    const r = recording(MAIL_NOTICE_KINDS, () => new Promise<boolean>((resolve) => (answer = resolve)));
    const caller = callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      told: toldDevicesIn(door),
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(keptIn(door, "acct-a"), "before the platform answered").toEqual({ made: 1, revoked: 0 });
    answer(true);
    await Promise.resolve();
    expect(keptIn(door, "acct-a")).toEqual({ made: 2, revoked: 0 });
  });

  it("an answer that comes after the account was left keeps nothing", async () => {
    const door = jarWith("acct-a", 1, 0);
    let answer: (taken: boolean) => void = () => {};
    const r = recording(MAIL_NOTICE_KINDS, () => new Promise<boolean>((resolve) => (answer = resolve)));
    const caller = callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      told: toldDevicesIn(door),
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    caller.end();
    answer(true);
    await Promise.resolve();
    expect(keptIn(door, "acct-a")).toEqual({ made: 1, revoked: 0 });
  });

  it("another account's numbers are never read for this one", async () => {
    const door = jarWith("acct-a", 1, 0);
    const r = recording();
    let devices: NoticeDevices | null = { made: 1, revoked: 0, live: 1 };
    const caller = callerOf(r.emitter, { devices: () => devices, told: toldDevicesIn(door) });
    const store = await copyWith();
    caller.settle("acct-a", store);
    // The next account, at a settle at which its devices are not told yet, then with more than the first had.
    devices = null;
    caller.settle("acct-b", store);
    devices = { made: 9, revoked: 4, live: 5 };
    caller.settle("acct-b", store);
    expect(r.posted, "the next account's numbers were compared with the account left").toEqual([]);
    expect(keptIn(door, "acct-b")).toEqual({ made: 9, revoked: 4 });
    expect(keptIn(door, "acct-a"), "the account left keeps its own").toEqual({ made: 1, revoked: 0 });
    expect([...door.kept.keys()].sort()).toEqual([toldDevicesKey("acct-a"), toldDevicesKey("acct-b")]);
    // A new start under the second account reads its own numbers, never the first's.
    const again = recording();
    callerOf(again.emitter, { devices: () => devices, told: toldDevicesIn(door) }).settle("acct-b", store);
    expect(again.posted).toEqual([]);
  });

  it("at the Devices list what the record says is told without a notice", async () => {
    const door = jarWith("acct-a", 1, 0);
    let atDevices: ToldDevices | null = { made: 2, revoked: 1 };
    // In front, as a person reading the list is: the emitter draws nothing.
    const r = recording(MAIL_NOTICE_KINDS, () => false);
    const caller = callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 1, live: 1 }),
      atDevices: () => atDevices,
      told: toldDevicesIn(door),
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(keptIn(door, "acct-a")).toEqual({ made: 2, revoked: 1 });
    atDevices = null;
    caller.settle("acct-a", store);
    expect(r.posted, "handed over again after the person had read the list").toEqual([REVOKED, PAIRED]);
  });

  it("at the Devices list a rise its list has not shown yet is not told", async () => {
    const door = jarWith("acct-a", 1, 0);
    // The list on screen was read while the record said one device made; the record says two now.
    let listed: ToldDevices | null = { made: 1, revoked: 0 };
    const r = recording(MAIL_NOTICE_KINDS, () => false);
    const caller = callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      atDevices: () => listed,
      told: toldDevicesIn(door),
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(keptIn(door, "acct-a"), "the list does not show the new device yet").toEqual({
      made: 1,
      revoked: 0,
    });
    // The list's read that followed the rise answered: it shows the new device.
    listed = { made: 2, revoked: 0 };
    caller.settle("acct-a", store);
    expect(keptIn(door, "acct-a")).toEqual({ made: 2, revoked: 0 });
  });

  it("a take-back and a new device each advance their own number", async () => {
    const door = jarWith("acct-a", 1, 0);
    const r = recording(
      MAIL_NOTICE_KINDS,
      (notice) => notice.kind === "pairing" && notice.change === "revoked",
    );
    const caller = callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 1, live: 1 }),
      told: toldDevicesIn(door),
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([REVOKED, PAIRED]);
    expect(keptIn(door, "acct-a")).toEqual({ made: 1, revoked: 1 });
    caller.settle("acct-a", store);
    expect(r.posted.slice(2), "only the new device is still to tell").toEqual([PAIRED]);
  });

  it("reads the kept value closed: anything but exactly two whole numbers is no kept numbers", () => {
    const door = jar();
    const store = toldDevicesIn(door);
    for (const text of [
      "3",
      "null",
      "[2,0]",
      "not json",
      '{"made":2}',
      '{"made":"2","revoked":0}',
      '{"made":2.5,"revoked":0}',
      '{"made":-1,"revoked":0}',
      '{"made":2,"revoked":null}',
      '{"made":2,"revoked":0,"label":"Pixel in the kitchen"}',
      '{"made":2,"revoked":0,"live":2}',
      '{"made":9007199254740992,"revoked":0}',
    ]) {
      door.kept.set(toldDevicesKey("acct-a"), text);
      expect(store.read("acct-a"), text).toBeNull();
    }
    door.kept.set(toldDevicesKey("acct-a"), '{"made":2,"revoked":0}');
    expect(store.read("acct-a")).toEqual({ made: 2, revoked: 0 });
  });

  it("keeps the two numbers and nothing else of what it is handed", () => {
    const door = jar();
    toldDevicesIn(door).write("acct-a", {
      made: 2,
      revoked: 0,
      live: 2,
      label: "Pixel in the kitchen",
    } as never);
    expect([...door.kept]).toEqual([[toldDevicesKey("acct-a"), '{"made":2,"revoked":0}']]);
  });

  it("a kept value that does not read closed is a device that learns from now", async () => {
    const door = jar();
    door.kept.set(toldDevicesKey("acct-a"), '{"made":1,"revoked":0,"label":"Pixel"}');
    const r = recording();
    callerOf(r.emitter, {
      devices: () => ({ made: 2, revoked: 0, live: 2 }),
      told: toldDevicesIn(door),
    }).settle("acct-a", await copyWith());
    expect(r.posted).toEqual([]);
    expect(door.kept.get(toldDevicesKey("acct-a"))).toBe('{"made":2,"revoked":0}');
  });

  it("on a device whose storage keeps nothing a new device is still told while the app lives", async () => {
    // A jar that refuses: nothing written is read back.
    const refusing: StorageDoor = { get: () => null, set: () => "lost", remove: () => "lost" };
    const r = recording();
    let devices: NoticeDevices = { made: 1, revoked: 0, live: 1 };
    const caller = callerOf(r.emitter, { devices: () => devices, told: toldDevicesIn(refusing) });
    const store = await copyWith();
    caller.settle("acct-a", store);
    devices = { made: 2, revoked: 0, live: 2 };
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([PAIRED]);
    caller.settle("acct-a", store);
    expect(r.posted, "told once").toEqual([PAIRED]);
  });

  it("the numbers kept never fall", async () => {
    const door = jarWith("acct-a", 5, 2);
    const r = recording();
    callerOf(r.emitter, {
      devices: () => ({ made: 3, revoked: 1, live: 2 }),
      atDevices: () => ({ made: 3, revoked: 1 }),
      told: toldDevicesIn(door),
    }).settle("acct-a", await copyWith());
    expect(r.posted).toEqual([]);
    expect(keptIn(door, "acct-a")).toEqual({ made: 5, revoked: 2 });
  });
});

describe("what a surface hands its notices", () => {
  it("reads the account's devices from the engine's own copy, so a device paired is handed to the emitter", async () => {
    const r = recording();
    // The engine's own copy holds the settings record; the copy the surface presents holds none.
    const own = await copyWith();
    await own.applyChanges([settingsRecord({ made: 1, revoked: 0, live: 1 })]);
    const presented = await copyWith();
    const caller = new NoticeCaller(
      r.emitter,
      noticeReadsOf(
        { read: () => own },
        { permission: () => "granted" },
        {
          choices: () => noticeChoicesOf(null, null, { ohcalPhone: false }),
          atDevices: () => false,
          told: toldDevicesIn(jar()),
        },
      ),
    );
    caller.settle("acct-a", presented);
    expect(r.posted).toEqual([]);
    await own.applyChanges([settingsRecord({ made: 2, revoked: 0, live: 2 })]);
    caller.settle("acct-a", presented);
    expect(r.posted).toEqual([{ kind: "pairing", change: "paired", device: null }]);
  });

  it("at the Devices list hands the caller what the list of this engine shows, and nothing elsewhere", () => {
    const engine = { read: () => new MemoryMirrorStore() };
    const other = { read: () => new MemoryMirrorStore() };
    let atList = true;
    const reads = noticeReadsOf(engine, null, {
      choices: () => noticeChoicesOf(null, null, { ohcalPhone: false }),
      atDevices: () => atList,
      told: toldDevicesIn(jar()),
    });
    expect(reads.atDevices(), "no list has answered yet").toBeNull();
    const gone = showDevicesListed(engine, { made: 2, revoked: 1 });
    showDevicesListed(other, { made: 9, revoked: 9 });
    expect(reads.atDevices()).toEqual({ made: 2, revoked: 1 });
    atList = false;
    expect(reads.atDevices(), "the person is not at the list").toBeNull();
    atList = true;
    gone();
    expect(reads.atDevices(), "the list left the screen").toBeNull();
    showDevicesListed(engine, { made: 3, revoked: 1 });
    showDevicesListed(engine, null);
    expect(reads.atDevices(), "the list's last read failed").toBeNull();
  });

  it("answers the host's permission, and unsupported where the host has no notifications part", () => {
    const own = {
      choices: () => noticeChoicesOf(null, null, { ohcalPhone: false }),
      atDevices: () => false,
      told: toldDevicesIn(jar()),
    };
    const engine = { read: () => new MemoryMirrorStore() };
    expect(noticeReadsOf(engine, { permission: () => "denied" }, own).permission()).toBe("denied");
    expect(noticeReadsOf(engine, null, own).permission()).toBe("unsupported");
  });
});

describe("the mounted caller", () => {
  it("takes back what was drawn when the shell that mounted it goes", async () => {
    const r = recording();
    const store = await copyWith();
    const mount: NoticesMount = {
      reader: store,
      version: 1,
      settled: true,
      scope: "acct-a",
      emitter: r.emitter,
      reads: {
        choices: () => noticeChoicesOf(null, null, { ohcalPhone: false }),
        permission: () => "granted",
        devices: () => null,
        atDevices: () => null,
        told: toldDevicesIn(jar()),
        calendar: "none",
      },
    };
    function Shell() {
      useNotices(mount);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Shell));
    });
    expect(r.takenBack()).toBe(0);
    await act(async () => {
      root.unmount();
    });
    expect(r.takenBack(), "a sign-out left the account's notices listed").toBe(1);
  });
});

/** Tuesday 10 November 2026, 14:00 UTC, and the minute its alert rings: ten minutes before. */
const START = Date.UTC(2026, 10, 10, 14, 0);
const RINGS = START - 10 * 60_000;
const TWO: Clock = { hour: 14, minute: 0, day: "today" };
const weekly = (over: { id?: string; startMs?: number; acts?: readonly NoticeAct[] } = {}): NoticeAhead =>
  aheadAlert(
    { id: over.id ?? "ev-weekly", title: "Catalogue weekly", private: false, heldBack: false },
    true,
    {
      startMs: over.startMs ?? START,
      allDay: false,
      leadMin: 10,
      acts: over.acts ?? [],
    },
  )!;

/** A calendar that wants `alerts` for the account `scope`, whoever asks. */
function calendarOf(
  scope: string,
  alerts: () => readonly NoticeAhead[],
  liveScope: () => string | null = () => scope,
): CalendarReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    liveScope,
    changes: () => null,
    ahead: (under, nowMs) => {
      asked.push(under);
      return aheadSet(scope, alerts(), nowMs);
    },
    clock: () => TWO,
  };
}

/** A surface that sets alerts itself: it records each set it is handed. */
function setting(carries: readonly NoticeKind[] = NOTICE_KINDS) {
  const r = recording(carries);
  const sets: AheadSet[] = [];
  const emitter: HostNoticeEmitter = { ...r.emitter, ahead: (set) => void sets.push(set) };
  return { ...r, emitter, sets };
}

const ALERTS_ON = { cal_alert: true };

describe("the one caller rings the calendar's alerts", () => {
  it("uses the confirmed mirror or the mailbox served now, including a sign-out before the next render", () => {
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({
        fetch: () => {
          throw new Error("unexpected network read");
        },
      }),
    });
    const session = { scope: "acct-a", state: "live" as const, liveNoticeScope: storageOwner };
    try {
      setStorageOwner("acct-a");
      expect(liveCalendarScope(engine, session)).toBe("acct-a");
      setStorageOwner("acct-b");
      expect(liveCalendarScope(engine, session)).toBeNull();
      setStorageOwner(null);

      document.cookie = OWNER_COOKIE + "=acct-a; path=/";
      session.liveNoticeScope = readOwner;
      const gate = createSyncGate("acct-a");
      registerSyncGate(engine, gate);
      expect(liveCalendarScope(engine, session)).toBeNull();
      gate.confirm("acct-a");
      expect(liveCalendarScope(engine, session)).toBe("acct-a");
      document.cookie = OWNER_COOKIE + "=acct-b; path=/";
      expect(liveCalendarScope(engine, session)).toBeNull();
      document.cookie = OWNER_COOKIE + "=acct-a; path=/";
      expect(liveCalendarScope(engine, session)).toBeNull();
      gate.confirm("acct-a");
      expect(liveCalendarScope(engine, session)).toBe("acct-a");
      markSessionDead();
      expect(liveCalendarScope(engine, session)).toBeNull();
    } finally {
      document.cookie = OWNER_COOKIE + "=; Max-Age=0; path=/";
      resetStorageOwnerForTest();
      resetSessionTruthForTests();
    }
  });

  it.each(["another account", "signed out", "event withdrawn"])(
    "leaves a waiting alert silent when %s is observed before another settle",
    async (change) => {
      let live: string | null = "acct-a";
      let wanted = [weekly()];
      const r = recording(NOTICE_KINDS);
      const calendar = { ...calendarOf("acct-a", () => wanted), liveScope: () => live };
      const caller = callerOf(r.emitter, { choices: ALERTS_ON, calendar });
      caller.settle("acct-a", await copyWith(), RINGS - 60_000);
      expect(caller.nextAtMs()).toBe(RINGS);
      if (change === "event withdrawn") wanted = [];
      else live = change === "signed out" ? null : "acct-b";
      caller.ring(RINGS);
      expect(r.posted).toEqual([]);
      expect(caller.nextAtMs()).toBeNull();
    },
  );

  it("draws a newly arrived invitation and an offered suggestion only while the same calendar is live", async () => {
    let live: string | null = "acct-a";
    const clock = vi.spyOn(Date, "now").mockReturnValue(RINGS);
    let shown = true;
    const records = [invitation("first", "20261118")];
    const proposals = [suggestion("first", "calendar")];
    const calendar = calendarReadsOf({
      liveScope: () => live,
      events: () => records.map((record) => ({ record, waiting: null, refusal: null, refusedWriteId: null })),
      calendars: () => [shownCalendar({ shown })],
      suggestions: () => proposals,
      ownAddresses: () => [OWN],
      zone: () => ZURICH,
      zones: intlZones(),
      showTitles: () => true,
      acts: [],
    });
    const r = recording(NOTICE_KINDS);
    const delayed = new Map<string, () => boolean>();
    const emitter: HostNoticeEmitter = {
      ...r.emitter,
      post(notice, current) {
        if (current) delayed.set(notice.kind, current);
        return r.emitter.post(notice);
      },
    };
    const caller = callerOf(emitter, { choices: { cal_invitation: true, cal_found: true }, calendar });
    const settle = () => caller.settle("acct-a", store, RINGS);
    const store = await copyWith();
    settle();
    expect(r.posted).toEqual([]);
    records.push(invitation("second", "20261118"));
    proposals.push(suggestion("offered", "data"), suggestion("withheld", "rules"));
    settle();
    expect(r.posted.map((n) => n.kind)).toEqual(["cal_invitation", "cal_found"]);
    const waiting = delayed.get("cal_invitation")!;
    expect(waiting()).toBe(true);
    shown = false;
    expect(waiting(), "the invitation's calendar was hidden").toBe(false);
    shown = true;
    records[1] = invitation("second", "20261118", { myAnswer: "accepted" });
    expect(waiting(), "the invitation has already been answered").toBe(false);
    const found = delayed.get("cal_found")!;
    expect(found()).toBe(true);
    proposals.splice(1);
    expect(found(), "an offer removed while the browser waited").toBe(false);
    records[1] = invitation("second", "20261118", { private: true });
    expect(waiting(), "a pending invitation cannot show its earlier public title").toBe(false);
    live = null;
    records.push(invitation("while-away", "20261119"));
    settle();
    live = "acct-a";
    settle();
    expect(r.posted).toHaveLength(2);
    clock.mockRestore();
  });

  it.each(["signed out", "withdrawn", "redacted", "too late", "catch-up", "titles off"] as const)(
    "checks a delayed reminder at delivery after it is %s",
    async (change) => {
      let live: string | null = "acct-a";
      let wanted = [weekly()];
      const choices = { ...ALERTS_ON, showTitles: true };
      let allowed: () => boolean = () => true;
      const emitter: HostNoticeEmitter = {
        ...recording(NOTICE_KINDS).emitter,
        post: (_notice, current?: () => boolean) => {
          if (current) allowed = current;
        },
      };
      const caller = callerOf(emitter, {
        choices,
        calendar: calendarOf(
          "acct-a",
          () => wanted,
          () => live,
        ),
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(RINGS);
      try {
        caller.settle("acct-a", await copyWith(), RINGS);
        expect(allowed()).toBe(true);
        if (change === "signed out") live = null;
        if (change === "withdrawn") wanted = [];
        if (change === "redacted") wanted = [{ ...weekly(), label: { as: "busy" } }];
        if (change === "too late") clock.mockReturnValue(RINGS + 121_000);
        if (change === "catch-up") caller.suspendCalendar(RINGS);
        if (change === "titles off") choices.showTitles = false;
        expect(allowed()).toBe(false);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("a brief catch-up does not repeat an alert the page just rang", async () => {
    const r = recording(NOTICE_KINDS);
    const caller = callerOf(r.emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("acct-a", () => [weekly()]),
    });
    const store = await copyWith();
    caller.settle("acct-a", store, RINGS);
    expect(r.posted).toHaveLength(1);
    caller.suspendCalendar(RINGS + 1000);
    expect(caller.nextAtMs()).toBeNull();
    caller.settle("acct-a", store, RINGS + 2000);
    expect(r.posted).toHaveLength(1);
  });

  it("rings an alert at its minute, once, as the notice the gate lets through", async () => {
    const r = recording(NOTICE_KINDS);
    const caller = callerOf(r.emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("acct-a", () => [weekly()]),
    });
    caller.settle("acct-a", await copyWith(), RINGS - 5 * 60_000);
    expect(r.posted).toEqual([]);
    expect(caller.nextAtMs()).toBe(RINGS);
    caller.ring(RINGS - 1);
    expect(r.posted).toEqual([]);
    caller.ring(RINGS);
    expect(r.posted).toEqual([
      {
        kind: "cal_alert",
        eventId: "ev-weekly",
        label: { as: "title", text: "Catalogue weekly" },
        at: TWO,
        allDay: false,
        leadMin: 10,
        acts: [],
      },
    ]);
    caller.ring(RINGS + 1000);
    caller.settle("acct-a", await copyWith(), RINGS + 2000);
    expect(r.posted).toHaveLength(1);
    expect(caller.nextAtMs()).toBeNull();
  });

  it("an alert already due when the copy settles rings at that settle", async () => {
    const r = recording(NOTICE_KINDS);
    const caller = callerOf(r.emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("acct-a", () => [weekly()]),
    });
    caller.settle("acct-a", await copyWith(), RINGS + 30_000);
    expect(r.posted.map((n) => n.kind)).toEqual(["cal_alert"]);
  });

  it("hands a notice only the acts the surface carries", async () => {
    const r = recording(NOTICE_KINDS);
    const emitter: HostNoticeEmitter = { ...r.emitter, acts: ["again"] };
    const caller = callerOf(emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("acct-a", () => [weekly({ acts: ["join", "again"] })]),
    });
    caller.settle("acct-a", await copyWith(), RINGS);
    expect(r.posted).toMatchObject([{ kind: "cal_alert", acts: ["again"] }]);
  });

  it("rings nothing while the alerts' switch, the master or the platform says no, read at the alert's minute", async () => {
    const refusals: { choices?: Partial<NoticeChoices>; permission?: () => NoticePermission }[] = [
      {}, // alerts are off outside the calendar's phone app until switched on
      { choices: { cal_alert: false } },
      { choices: { cal_alert: true, master: false } },
      { choices: ALERTS_ON, permission: () => "denied" },
      { choices: ALERTS_ON, permission: () => "default" },
    ];
    for (const over of refusals) {
      const r = recording(NOTICE_KINDS);
      const caller = callerOf(r.emitter, { ...over, calendar: calendarOf("acct-a", () => [weekly()]) });
      caller.settle("acct-a", await copyWith(), RINGS - 60_000);
      caller.ring(RINGS);
      expect(r.posted, JSON.stringify(over)).toEqual([]);
    }
    // A surface that does not carry alerts is handed none.
    const mailOnly = recording(MAIL_NOTICE_KINDS);
    const caller = callerOf(mailOnly.emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("acct-a", () => [weekly()]),
    });
    caller.settle("acct-a", await copyWith(), RINGS);
    expect(mailOnly.posted).toEqual([]);
    // Switched off between the settle and the minute: the choice read at the minute holds.
    let on = true;
    const r = recording(NOTICE_KINDS);
    const late = new NoticeCaller(r.emitter, {
      choices: () => ({ ...noticeChoicesOf(null, null, { ohcalPhone: false }), cal_alert: on }),
      permission: () => "granted",
      devices: () => null,
      atDevices: () => null,
      told: toldDevicesIn(jar()),
      calendar: calendarOf("acct-a", () => [weekly()]),
    });
    late.settle("acct-a", await copyWith(), RINGS - 60_000);
    on = false;
    late.ring(RINGS);
    expect(r.posted).toEqual([]);
  });

  it("an event that moved, was deleted or declined is missing from the next settle's alerts and does not ring", async () => {
    const r = recording(NOTICE_KINDS);
    let wanted: NoticeAhead[] = [weekly()];
    const caller = callerOf(r.emitter, { choices: ALERTS_ON, calendar: calendarOf("acct-a", () => wanted) });
    caller.settle("acct-a", await copyWith(), RINGS - 60_000);
    wanted = [weekly({ startMs: START + 30 * 60_000 })];
    caller.settle("acct-a", await copyWith(), RINGS - 30_000);
    caller.ring(RINGS);
    expect(r.posted, "the old minute rang after the event moved").toEqual([]);
    expect(caller.nextAtMs()).toBe(RINGS + 30 * 60_000);
    wanted = [];
    caller.settle("acct-a", await copyWith(), RINGS + 60_000);
    caller.ring(RINGS + 30 * 60_000);
    expect(r.posted, "a deleted or declined event rang").toEqual([]);
    expect(caller.nextAtMs()).toBeNull();
  });

  it("at an account switch nothing set under the account left rings, and a set of another account is never taken", async () => {
    const r = recording(NOTICE_KINDS);
    // The calendar's reads answer account A's alerts whoever asks: a set under another scope than the one settled.
    let live = "acct-a";
    const calendar = calendarOf(
      "acct-a",
      () => [weekly()],
      () => live,
    );
    const caller = callerOf(r.emitter, { choices: ALERTS_ON, calendar });
    caller.settle("acct-a", await copyWith(), RINGS - 60_000);
    expect(caller.nextAtMs()).toBe(RINGS);
    live = "acct-b";
    caller.settle("acct-b", await copyWith(), RINGS - 30_000);
    expect(r.takenBack()).toBe(1);
    expect(calendar.asked).toEqual(["acct-a", "acct-b"]);
    expect(caller.nextAtMs(), "account A's alert waits under account B").toBeNull();
    caller.ring(RINGS);
    expect(r.posted).toEqual([]);
  });

  it("at sign-out nothing is left to ring", async () => {
    const r = recording(NOTICE_KINDS);
    const caller = callerOf(r.emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("acct-a", () => [weekly()]),
    });
    caller.settle("acct-a", await copyWith(), RINGS - 60_000);
    caller.end();
    expect(caller.nextAtMs()).toBeNull();
    caller.ring(RINGS);
    expect(r.posted).toEqual([]);
  });

  it("a shell with no calendar sets nothing and rings nothing; reads that throw take nothing down", async () => {
    const r = recording(NOTICE_KINDS);
    const none = callerOf(r.emitter, { choices: ALERTS_ON });
    none.settle("acct-a", await copyWith(), RINGS);
    none.ring(RINGS);
    const broken = callerOf(r.emitter, {
      choices: ALERTS_ON,
      calendar: {
        liveScope: () => "acct-a",
        changes: () => null,
        ahead: () => {
          throw new Error("no calendar");
        },
        clock: () => {
          throw new Error("no clock");
        },
      },
    });
    expect(() => broken.settle("acct-a", await0(), RINGS)).not.toThrow();
    const noClock = callerOf(r.emitter, {
      choices: ALERTS_ON,
      calendar: { ...calendarOf("acct-a", () => [weekly()]), clock: () => null },
    });
    noClock.settle("acct-a", await copyWith(), RINGS);
    expect(r.posted).toEqual([]);
    expect(none.nextAtMs()).toBeNull();
  });
});

/** An empty copy, made without waiting: enough for a caller that reads no letter. */
function await0(): MemoryMirrorStore {
  return new MemoryMirrorStore();
}

describe("a surface that sets alerts itself", () => {
  it("withdraws what the native surface holds when the presented calendar disappears", async () => {
    const s = setting();
    let calendar: CalendarReads | "none" = calendarOf("acct-a", () => [weekly()]);
    const caller = new NoticeCaller(s.emitter, {
      choices: () => ({ ...noticeChoicesOf(null, null, { ohcalPhone: false }), ...ALERTS_ON }),
      permission: () => "granted",
      devices: () => null,
      atDevices: () => null,
      told: toldDevicesIn(jar()),
      get calendar() {
        return calendar;
      },
    });
    const store = await copyWith();
    caller.settle("acct-a", store, RINGS - 60_000);
    expect(s.sets).toEqual([{ scope: "acct-a", alerts: [weekly()] }]);
    calendar = "none";
    caller.settle("acct-a", store, RINGS - 30_000);
    expect(s.sets.at(-1)).toEqual({ scope: "acct-a", alerts: [] });
  });

  it("is handed the account's set whole at each settle, and the page rings nothing of it", async () => {
    const s = setting();
    let wanted: NoticeAhead[] = [weekly()];
    const caller = callerOf(s.emitter, { choices: ALERTS_ON, calendar: calendarOf("acct-a", () => wanted) });
    caller.settle("acct-a", await copyWith(), RINGS - 60_000);
    expect(s.sets).toEqual([{ scope: "acct-a", alerts: [weekly()] }]);
    caller.ring(RINGS);
    expect(s.posted, "the page rang an alert its surface rings itself").toEqual([]);
    expect(caller.nextAtMs()).toBeNull();
    wanted = [];
    caller.settle("acct-a", await copyWith(), RINGS - 30_000);
    expect(s.sets[1]).toEqual({ scope: "acct-a", alerts: [] });
  });

  it("is handed an empty set while this device does not ring alerts: a surface holds no choice of its own", async () => {
    for (const over of [
      {},
      { choices: { cal_alert: true, master: false } },
      { choices: ALERTS_ON, permission: () => "denied" as const },
    ]) {
      const s = setting();
      callerOf(s.emitter, { ...over, calendar: calendarOf("acct-a", () => [weekly()]) }).settle(
        "acct-a",
        await copyWith(),
        RINGS - 60_000,
      );
      expect(s.sets, JSON.stringify(over)).toEqual([{ scope: "acct-a", alerts: [] }]);
    }
    const s = setting(MAIL_NOTICE_KINDS);
    callerOf(s.emitter, { choices: ALERTS_ON, calendar: calendarOf("acct-a", () => [weekly()]) }).settle(
      "acct-a",
      await copyWith(),
      RINGS - 60_000,
    );
    expect(s.sets).toEqual([{ scope: "acct-a", alerts: [] }]);
  });

  it("is never handed another account's set, and nothing for a scope that is no account's", async () => {
    const s = setting();
    const caller = callerOf(s.emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("acct-a", () => [weekly()]),
    });
    caller.settle("acct-b", await copyWith(), RINGS - 60_000);
    expect(s.sets).toEqual([{ scope: "acct-b", alerts: [] }]);
    const demo = setting();
    callerOf(demo.emitter, {
      choices: ALERTS_ON,
      calendar: calendarOf("demo:fixtures", () => [weekly()]),
    }).settle("demo:fixtures", await copyWith(), RINGS);
    expect(demo.sets).toEqual([]);
    const throwing = setting();
    const emitter: HostNoticeEmitter = {
      ...throwing.emitter,
      ahead: () => {
        throw new Error("the shell is gone");
      },
    };
    expect(() =>
      callerOf(emitter, { choices: ALERTS_ON, calendar: calendarOf("acct-a", () => [weekly()]) }).settle(
        "acct-a",
        await0(),
        RINGS,
      ),
    ).not.toThrow();
  });
});

describe("the mounted caller wakes for the next alert", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rings at the alert's minute with nothing else moving, and not after the shell is gone", async () => {
    vi.useFakeTimers({ now: RINGS - 60_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const r = recording(NOTICE_KINDS);
    const later = weekly({ id: "ev-later", startMs: START + 60 * 60_000 });
    const mount: NoticesMount = {
      reader: await copyWith(),
      version: 1,
      settled: true,
      scope: "acct-a",
      emitter: r.emitter,
      reads: {
        choices: () => ({ ...noticeChoicesOf(null, null, { ohcalPhone: false }), cal_alert: true }),
        permission: () => "granted",
        devices: () => null,
        atDevices: () => null,
        told: toldDevicesIn(jar()),
        calendar: calendarOf("acct-a", () => [weekly(), later]),
      },
    };
    function Shell() {
      useNotices(mount);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Shell));
    });
    expect(r.posted).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(r.posted, "rang before its minute").toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(r.posted.map((n) => (n as { eventId?: string }).eventId)).toEqual(["ev-weekly"]);
    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 60_000);
    });
    expect(r.posted, "an alert rang after sign-out").toHaveLength(1);
  });
});
