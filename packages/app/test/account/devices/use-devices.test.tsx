/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Answer } from "../../../src/account/contract.js";
import type { DevicesDoor, DevicesLists, MadeLink } from "../../../src/account/devices/model.js";
import { useDevices } from "../../../src/account/devices/use-devices.js";
import {
  CODE,
  FACTOR,
  fakeDevicesDoor,
  held,
  LAPTOP,
  lists,
  ok,
  PHONE,
  plain,
  said,
  THIS,
  THROWS,
} from "./fake-door.js";

afterEach(cleanup);

/* A pairing link as a door hands it. Its last part is what only the person may see. */
const PART = createHash("sha256").update("use-devices fixture").digest("base64url");
const LINK = `https://api.ohmail.example/pair#${PART}`;
const made = (id = "c-9", name = "Ben"): MadeLink => ({ id, link: LINK, name });
const NEWER = { id: "c-9", name: "Ben", until: "09:34" } as const;

function mounted(door: DevicesDoor, strict = false) {
  // Strict mode from the root: under a wrapper it would replay no effect.
  return renderHook(() => useDevices(door), { reactStrictMode: strict });
}
/** A press, and every answer it brings taken in. */
const settled = (press: () => void) =>
  act(async () => {
    press();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
/** The pane opened and its reads answered. */
async function opened(door: DevicesDoor, strict = false) {
  const hook = mounted(door, strict);
  await settled(() => {});
  return hook;
}
/** Everything the model holds as data: what a secret would have to be in to be kept. */
const kept = (model: unknown): string => JSON.stringify(model);
const count = (door: { calls(): readonly string[] }, call: string): number =>
  door.calls().filter((each) => each === call).length;

describe("both lists, read as the pane opens", () => {
  it("asks the lists, then whether the server groups the browser sessions, and claims nothing before the answer", async () => {
    const read = held<Answer<DevicesLists>>();
    const door = fakeDevicesDoor({ reads: [read.promise] });
    const { result } = mounted(door);
    expect(result.current.list).toEqual({ at: "loading" });
    expect(door.calls()).toEqual(["read", "groupsWebSessions"]);
    await settled(() => read.settle(ok(lists([THIS, PHONE], [CODE]))));
    expect(result.current.list).toEqual({ at: "read", devices: [THIS, PHONE], webGroup: null });
    expect(result.current.codes).toEqual([CODE]);
    expect(door.calls()).toEqual(["read", "groupsWebSessions"]);
  });

  it("still reads where the tree is mounted twice over", async () => {
    const door = fakeDevicesDoor({ reads: [ok(lists()), ok(lists())] });
    const { result } = await opened(door, true);
    expect(result.current.list).toEqual({ at: "read", devices: [THIS, PHONE], webGroup: null });
  });

  it("lists this device first, whatever order the server answers in", async () => {
    const { result } = await opened(fakeDevicesDoor({ reads: [ok(lists([PHONE, THIS, LAPTOP]))] }));
    expect(result.current.list).toEqual({ at: "read", devices: [THIS, PHONE, LAPTOP], webGroup: null });
  });

  it("makes one line of the other plain browser sessions only where the server groups them", async () => {
    const sessions = [THIS, PHONE, plain(3), plain(2)];
    const grouping = await opened(fakeDevicesDoor({ reads: [ok(lists(sessions))], groups: true }));
    expect(grouping.result.current.list).toEqual({
      at: "read",
      devices: [THIS, PHONE],
      webGroup: { count: 2, seen: plain(3).seen },
    });
    for (const groups of [false, THROWS] as const) {
      const each = await opened(fakeDevicesDoor({ reads: [ok(lists(sessions))], groups }));
      expect(each.result.current.list, String(groups)).toEqual({
        at: "read",
        devices: [THIS, PHONE, plain(3), plain(2)],
        webGroup: null,
      });
    }
  });

  it("a read that failed is never an empty list: it is said, and Try again reads once more", async () => {
    const door = fakeDevicesDoor({ reads: [said("The server could not be reached."), ok(lists())] });
    const { result } = await opened(door);
    expect(result.current.list).toEqual({ at: "failed" });
    expect(result.current.problem).toEqual({
      with: "read",
      why: { word: "said", said: "The server could not be reached." },
    });
    await settled(() => result.current.retry());
    expect(result.current.list).toEqual({ at: "read", devices: [THIS, PHONE], webGroup: null });
    expect(result.current.problem).toBeNull();
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "read"]);
    await settled(() => result.current.retry());
    expect(count(door, "read")).toBe(2);
  });

  it("a read the door could not answer, or refused as a way back in, is a read that failed, never the factor's dialog", async () => {
    const thrown = await opened(fakeDevicesDoor({ reads: [THROWS] }));
    expect(thrown.result.current.list).toEqual({ at: "failed" });
    expect(thrown.result.current.problem).toEqual({ with: "read", why: { word: "said", said: "" } });
    const refused = await opened(fakeDevicesDoor({ reads: [FACTOR] }));
    expect(refused.result.current.list).toEqual({ at: "failed" });
    expect(refused.result.current.problem).toEqual({ with: "read", why: { word: "sign_in" } });
    expect(refused.result.current.ask).toBeNull();
  });

  it("a later read that fails keeps what was read, and says why", async () => {
    const door = fakeDevicesDoor({ reads: [ok(lists()), said("Not now.")], adds: [ok(made())] });
    const { result } = await opened(door);
    await settled(() => result.current.add());
    expect(result.current.list).toEqual({ at: "read", devices: [THIS, PHONE], webGroup: null });
    expect(result.current.problem).toEqual({ with: "read", why: { word: "said", said: "Not now." } });
    expect(result.current.made).toEqual(made());
  });

  it("an answer that a later read overtook is not drawn", async () => {
    const first = held<Answer<DevicesLists>>();
    const door = fakeDevicesDoor({ reads: [first.promise, ok(lists([THIS]))], adds: [ok(made())] });
    const { result } = mounted(door);
    await settled(() => result.current.add());
    expect(result.current.list).toEqual({ at: "read", devices: [THIS], webGroup: null });
    await settled(() => first.settle(ok(lists([THIS, PHONE, LAPTOP]))));
    expect(result.current.list).toEqual({ at: "read", devices: [THIS], webGroup: null });
  });
});

describe("a new device", () => {
  it("makes one link for the name typed, trimmed; shows it, empties the name and reads the lists again", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists()), ok(lists([THIS, PHONE], [NEWER]))],
      adds: [ok(made())],
    });
    const { result } = await opened(door);
    await settled(() => result.current.type("  Ben "));
    expect(result.current.name).toBe("  Ben ");
    await settled(() => result.current.add());
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "add:Ben", "read"]);
    expect(result.current.made).toEqual(made());
    expect(result.current.name).toBe("");
    expect(result.current.codes).toEqual([NEWER]);
    expect(result.current.working).toBeNull();
  });

  it("says it is working while the link is made, takes no second verb meanwhile, and makes no second link beside one on show", async () => {
    const making = held<Answer<MadeLink>>();
    const door = fakeDevicesDoor({
      reads: [ok(lists([THIS], [CODE])), ok(lists([THIS], [CODE]))],
      adds: [making.promise, ok(made("c-10"))],
      revokes: [ok(null)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.add());
    expect(result.current.working).toEqual({ kind: "add", name: "" });
    await settled(() => result.current.revokeCode(CODE.id));
    await settled(() => result.current.add());
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "add:"]);
    await settled(() => making.settle(ok(made())));
    expect(result.current.working).toBeNull();
    await settled(() => result.current.add());
    expect(count(door, "add:")).toBe(1);
  });

  it("Done takes the link out of everything the model holds, and reads the lists again", async () => {
    const door = fakeDevicesDoor({ reads: [ok(lists()), ok(lists()), ok(lists())], adds: [ok(made())] });
    const { result } = await opened(door);
    await settled(() => result.current.add());
    expect(kept({ ...result.current, made: null })).not.toContain(PART);
    expect(kept(result.current)).toContain(PART);
    await settled(() => result.current.done());
    expect(result.current.made).toBeNull();
    expect(kept(result.current)).not.toContain(PART);
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "add:", "read", "read"]);
  });

  it("says copied only once the clipboard took it", async () => {
    const taking = held<boolean>();
    const door = fakeDevicesDoor({
      reads: [ok(lists()), ok(lists())],
      adds: [ok(made())],
      copies: [taking.promise],
    });
    const { result } = await opened(door);
    await settled(() => result.current.copy());
    expect(door.copied()).toEqual([]);
    await settled(() => result.current.add());
    await settled(() => result.current.copy());
    expect(door.copied()).toEqual([LINK]);
    expect(result.current.told).toBeNull();
    await settled(() => taking.settle(true));
    expect(result.current.told).toEqual({ kind: "copied" });
    expect(result.current.problem).toBeNull();
  });

  it("a clipboard that refuses, or throws, is said; a copy that is taken afterwards takes that back", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists()), ok(lists())],
      adds: [ok(made())],
      copies: [false, THROWS, true],
    });
    const { result } = await opened(door);
    await settled(() => result.current.add());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await settled(() => result.current.copy());
      expect(result.current.problem).toEqual({ with: "copy" });
      expect(result.current.told).toBeNull();
    }
    await settled(() => result.current.copy());
    expect(result.current.problem).toBeNull();
    expect(result.current.told).toEqual({ kind: "copied" });
  });
});

describe("a code not used yet", () => {
  it("is revoked by its own id; that is said, and the lists are read again", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists([THIS], [CODE])), ok(lists([THIS]))],
      revokes: [ok(null)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.revokeCode("c-unlisted"));
    expect(door.calls()).toEqual(["read", "groupsWebSessions"]);
    await settled(() => result.current.revokeCode(CODE.id));
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "revokeCode:c-1", "read"]);
    expect(result.current.told).toEqual({ kind: "revoked" });
    expect(result.current.codes).toEqual([]);
  });

  it("takes the link on show down with its own row, and with no other", async () => {
    const both = ok(lists([THIS], [CODE, NEWER]));
    const door = fakeDevicesDoor({
      reads: [ok(lists([THIS], [CODE])), both, ok(lists([THIS], [NEWER])), ok(lists([THIS]))],
      adds: [ok(made(NEWER.id))],
      revokes: [ok(null), ok(null)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.add());
    await settled(() => result.current.revokeCode(CODE.id));
    expect(result.current.made).toEqual(made(NEWER.id));
    await settled(() => result.current.revokeCode(NEWER.id));
    expect(result.current.made).toBeNull();
    expect(kept(result.current)).not.toContain(PART);
  });
});

describe("a device signed out", () => {
  it("is asked about first: no press but the question's own Confirm reaches the door", async () => {
    const door = fakeDevicesDoor({ reads: [ok(lists()), ok(lists([THIS]))], removes: [ok(null)] });
    const { result } = await opened(door);
    await settled(() => result.current.confirm());
    await settled(() => result.current.askRemove(PHONE.id));
    expect(result.current.question).toEqual({ kind: "remove", id: PHONE.id });
    await settled(() => result.current.dismiss());
    expect(result.current.question).toBeNull();
    await settled(() => result.current.confirm());
    expect(door.calls()).toEqual(["read", "groupsWebSessions"]);
    await settled(() => result.current.askRemove(PHONE.id));
    await settled(() => result.current.confirm());
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "remove:d-phone", "read"]);
    expect(result.current.question).toBeNull();
    expect(result.current.told).toEqual({ kind: "removed" });
    expect(result.current.list).toEqual({ at: "read", devices: [THIS], webGroup: null });
  });

  it("this device, and one that is not listed, are never asked about", async () => {
    const door = fakeDevicesDoor({ reads: [ok(lists())], removes: [ok(null)] });
    const { result } = await opened(door);
    for (const id of [THIS.id, "d-unlisted"]) {
      await settled(() => result.current.askRemove(id));
      expect(result.current.question, id).toBeNull();
      await settled(() => result.current.confirm());
    }
    expect(door.calls()).toEqual(["read", "groupsWebSessions"]);
  });

  it("the other browser sessions are signed out together only from the question, and how many is said", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists([THIS, plain(2), plain(1)])), ok(lists([THIS]))],
      groups: true,
      signOuts: [ok({ ended: 2 })],
    });
    const { result } = await opened(door);
    await settled(() => result.current.askSignOutWeb());
    expect(result.current.question).toEqual({ kind: "signOutWeb" });
    expect(count(door, "signOutWeb")).toBe(0);
    await settled(() => result.current.confirm());
    expect(count(door, "signOutWeb")).toBe(1);
    expect(result.current.told).toEqual({ kind: "signedOutWeb", ended: 2 });
    expect(result.current.list).toEqual({ at: "read", devices: [THIS], webGroup: null });
  });

  it("asks nothing about a group that is not drawn, and drops a question whose device a read no longer lists", async () => {
    const again = held<Answer<DevicesLists>>();
    const door = fakeDevicesDoor({
      reads: [ok(lists([THIS, PHONE, plain(1)])), ok(lists([THIS, PHONE, plain(1)])), again.promise],
      adds: [ok(made())],
    });
    const { result } = await opened(door);
    await settled(() => result.current.askSignOutWeb());
    expect(result.current.question).toBeNull();
    await settled(() => result.current.add());
    await settled(() => result.current.done());
    await settled(() => result.current.askRemove(PHONE.id));
    expect(result.current.question).toEqual({ kind: "remove", id: PHONE.id });
    await settled(() => again.settle(ok(lists([THIS]))));
    expect(result.current.question).toBeNull();
  });
});

/** The four verbs the server guards with a fresh factor: the answers the door is handed, the call, the presses. */
const VERBS = [
  {
    name: "a new device",
    kind: "add",
    call: "add:Ben",
    handed: (answers: readonly ("factor" | "taken")[]) => ({
      adds: answers.map((answer) => (answer === "factor" ? FACTOR : ok(made()))),
    }),
    presses: ["type", "add"],
  },
  {
    name: "a code revoked",
    kind: "revokeCode",
    call: "revokeCode:c-1",
    handed: (answers: readonly ("factor" | "taken")[]) => ({
      revokes: answers.map((answer) => (answer === "factor" ? FACTOR : ok(null))),
    }),
    presses: ["revokeCode"],
  },
  {
    name: "a device signed out",
    kind: "remove",
    call: "remove:d-phone",
    handed: (answers: readonly ("factor" | "taken")[]) => ({
      removes: answers.map((answer) => (answer === "factor" ? FACTOR : ok(null))),
    }),
    presses: ["askRemove", "confirm"],
  },
  {
    name: "the other browser sessions signed out",
    kind: "signOutWeb",
    call: "signOutWeb",
    handed: (answers: readonly ("factor" | "taken")[]) => ({
      signOuts: answers.map((answer) => (answer === "factor" ? FACTOR : ok({ ended: 1 }))),
    }),
    presses: ["askSignOutWeb", "confirm"],
  },
] as const;

for (const verb of VERBS) {
  describe(`${verb.name}, guarded by the factor`, () => {
    const everything = ok(lists([THIS, PHONE, plain(1)], [CODE]));
    /** The pane opened, the verb pressed, and the door's first answer taken in. */
    async function pressed(...answers: ("factor" | "taken")[]) {
      const door = fakeDevicesDoor({
        reads: [everything, everything],
        groups: true,
        ...verb.handed(answers),
      });
      const hook = await opened(door);
      for (const press of verb.presses) {
        await settled(() => {
          const model = hook.result.current;
          if (press === "type") model.type("Ben");
          else if (press === "revokeCode") model.revokeCode(CODE.id);
          else if (press === "askRemove") model.askRemove(PHONE.id);
          else model[press]();
        });
      }
      return { door, ...hook };
    }

    it("is tried as it is; only the refusal asks the factor; the verified factor sends the same once more", async () => {
      const { door, result } = await pressed("factor", "taken");
      expect(count(door, verb.call)).toBe(1);
      expect(result.current.ask).not.toBeNull();
      expect(result.current.working).toBeNull();
      await settled(() => result.current.ask!.onVerified());
      expect(count(door, verb.call)).toBe(2);
      expect(result.current.ask).toBeNull();
      expect(result.current.problem).toBeNull();
      expect(door.calls().slice(-1)).toEqual(["read"]);
    });

    it("a factor that says it verified twice over sends the verb once", async () => {
      const { door, result } = await pressed("factor", "taken", "taken");
      const asked = result.current.ask!;
      await settled(() => {
        asked.onVerified();
        asked.onVerified();
      });
      expect(count(door, verb.call)).toBe(2);
    });

    it("taken at once asks no factor", async () => {
      const { door, result } = await pressed("taken");
      expect(count(door, verb.call)).toBe(1);
      expect(result.current.ask).toBeNull();
    });

    it("refused again after the factor: the way back in, never a second dialog, never a third send", async () => {
      const { door, result } = await pressed("factor", "factor", "taken");
      await settled(() => result.current.ask!.onVerified());
      expect(count(door, verb.call)).toBe(2);
      expect(result.current.ask).toBeNull();
      expect(result.current.problem).toEqual({ with: verb.kind, why: { word: "sign_in" } });
    });

    it("Cancel sends nothing more, and a factor that lands after it says nothing ran", async () => {
      const { door, result } = await pressed("factor", "taken");
      const asked = result.current.ask!;
      await settled(() => asked.onCancel());
      expect(result.current.ask).toBeNull();
      expect(result.current.nothingRan).toBe(false);
      await settled(() => asked.onDiscarded());
      await settled(() => asked.onVerified());
      expect(result.current.nothingRan).toBe(true);
      expect(result.current.question).toBeNull();
      expect(count(door, verb.call)).toBe(1);
    });

    it("a pane left while the factor is asked runs nothing afterwards", async () => {
      const { door, result, unmount } = await pressed("factor", "taken");
      const asked = result.current.ask!;
      const before = door.calls().length;
      unmount();
      await settled(() => asked.onVerified());
      expect(door.calls()).toHaveLength(before);
    });
  });
}

describe("what a verb leaves to say", () => {
  it("a refusal is said as the door said it, with the verb it was about; the next send starts clean", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists([THIS], [CODE]))],
      revokes: [said("Not this one.")],
      adds: [held<Answer<MadeLink>>().promise],
    });
    const { result } = await opened(door);
    await settled(() => result.current.revokeCode(CODE.id));
    expect(result.current.problem).toEqual({
      with: "revokeCode",
      why: { word: "said", said: "Not this one." },
    });
    expect(result.current.told).toBeNull();
    expect(result.current.working).toBeNull();
    await settled(() => result.current.add());
    expect(result.current.problem).toBeNull();
  });

  it("a door that throws at a verb is a verb that did not go through, never a pane that hangs", async () => {
    const door = fakeDevicesDoor({ reads: [ok(lists())], adds: [THROWS] });
    const { result } = await opened(door);
    await settled(() => result.current.add());
    expect(result.current.problem).toEqual({ with: "add", why: { word: "said", said: "" } });
    expect(result.current.working).toBeNull();
    expect(result.current.made).toBeNull();
  });

  it("a press while the factor is asked replaces nothing that is parked", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists([THIS], [CODE])), ok(lists([THIS], [CODE]))],
      adds: [FACTOR, ok(made())],
      revokes: [ok(null)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.add());
    await settled(() => result.current.revokeCode(CODE.id));
    await settled(() => result.current.ask!.onVerified());
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "add:", "add:", "read"]);
  });

  it("a pane left while a verb is on its way reads nothing afterwards, and holds no link", async () => {
    const making = held<Answer<MadeLink>>();
    const door = fakeDevicesDoor({ reads: [ok(lists()), ok(lists())], adds: [making.promise] });
    const { result, unmount } = await opened(door);
    await settled(() => result.current.add());
    unmount();
    await settled(() => making.settle(ok(made())));
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "add:"]);
    expect(kept(result.current)).not.toContain(PART);
  });
});
