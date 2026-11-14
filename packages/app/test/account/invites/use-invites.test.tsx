/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Answer } from "../../../src/account/contract.js";
import type { InvitesDoor, MadeInvite, OpenInvite } from "../../../src/account/invites/model.js";
import { useInvites } from "../../../src/account/invites/use-invites.js";
import { FACTOR, fakeInvitesDoor, FOR_NOBODY, FOR_RAHEL, held, ok, said, THROWS } from "./fake-door.js";

afterEach(cleanup);

/* An invite link as a door hands it. Its last part is what only the person may see. */
const PART = createHash("sha256").update("use-invites fixture").digest("base64url");
const LINK = `https://mail.lichtgrat.example/join/invite#${PART}`;
const made = (name = "Rahel Beck"): MadeInvite => ({ link: LINK, name });

function mounted(door: InvitesDoor, strict = false) {
  // Strict mode from the root: under a wrapper it would replay no effect.
  return renderHook(() => useInvites(door), { reactStrictMode: strict });
}
/** A press, and every answer it brings taken in. */
const settled = (press: () => void) =>
  act(async () => {
    press();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
/** The pane opened and its read answered. */
async function opened(door: InvitesDoor, strict = false) {
  const hook = mounted(door, strict);
  await settled(() => {});
  return hook;
}
/** Everything the model holds as data: what a secret would have to be in to be kept. */
const kept = (model: unknown): string => JSON.stringify(model);
const count = (door: { calls(): readonly string[] }, call: string): number =>
  door.calls().filter((each) => each === call).length;

describe("the open invites, read as the pane opens", () => {
  it("asks once, and claims nothing before the answer", async () => {
    const read = held<Answer<readonly OpenInvite[]>>();
    const door = fakeInvitesDoor({ reads: [read.promise] });
    const { result } = mounted(door);
    expect(result.current.invites).toBeNull();
    await settled(() => read.settle(ok([FOR_RAHEL, FOR_NOBODY])));
    expect(result.current.invites).toEqual([FOR_RAHEL, FOR_NOBODY]);
    expect(door.calls()).toEqual(["read"]);
  });

  it("still reads where the tree is mounted twice over", async () => {
    const door = fakeInvitesDoor({ reads: [ok([FOR_RAHEL]), ok([FOR_RAHEL])] });
    const { result } = await opened(door, true);
    expect(result.current.invites).toEqual([FOR_RAHEL]);
  });

  it("a read that failed is never an empty list: nothing is listed, and why is said", async () => {
    const failed = await opened(fakeInvitesDoor({ reads: [said("The server could not be reached.")] }));
    expect(failed.result.current.invites).toBeNull();
    expect(failed.result.current.problem).toEqual({
      with: "read",
      why: { word: "said", said: "The server could not be reached." },
    });
    const thrown = await opened(fakeInvitesDoor({ reads: [THROWS] }));
    expect(thrown.result.current.invites).toBeNull();
    expect(thrown.result.current.problem).toEqual({ with: "read", why: { word: "said", said: "" } });
    const refused = await opened(fakeInvitesDoor({ reads: [FACTOR] }));
    expect(refused.result.current.problem).toEqual({ with: "read", why: { word: "sign_in" } });
    expect(refused.result.current.ask).toBeNull();
  });

  it("a later read that fails keeps what was read, and says why", async () => {
    const door = fakeInvitesDoor({ reads: [ok([FOR_RAHEL]), said("Not now.")], makes: [ok(made())] });
    const { result } = await opened(door);
    await settled(() => result.current.make());
    expect(result.current.invites).toEqual([FOR_RAHEL]);
    expect(result.current.problem).toEqual({ with: "read", why: { word: "said", said: "Not now." } });
    expect(result.current.made).toEqual(made());
  });

  it("an answer that a later read overtook is not drawn", async () => {
    const first = held<Answer<readonly OpenInvite[]>>();
    const door = fakeInvitesDoor({ reads: [first.promise, ok([FOR_RAHEL])], makes: [ok(made())] });
    const { result } = mounted(door);
    await settled(() => result.current.make());
    expect(result.current.invites).toEqual([FOR_RAHEL]);
    await settled(() => first.settle(ok([])));
    expect(result.current.invites).toEqual([FOR_RAHEL]);
  });
});

describe("a new invite", () => {
  it("makes one link for the name typed, trimmed; shows it, empties the name and reads the list again", async () => {
    const door = fakeInvitesDoor({ reads: [ok([]), ok([FOR_RAHEL])], makes: [ok(made())] });
    const { result } = await opened(door);
    await settled(() => result.current.type("  Rahel Beck "));
    expect(result.current.name).toBe("  Rahel Beck ");
    await settled(() => result.current.make());
    expect(door.calls()).toEqual(["read", "make:Rahel Beck", "read"]);
    expect(result.current.made).toEqual(made());
    expect(result.current.name).toBe("");
    expect(result.current.invites).toEqual([FOR_RAHEL]);
    expect(result.current.working).toBeNull();
  });

  it("says it is working while the link is made, takes no second verb meanwhile, and makes no second link beside one on show", async () => {
    const making = held<Answer<MadeInvite>>();
    const door = fakeInvitesDoor({
      reads: [ok([FOR_RAHEL]), ok([FOR_RAHEL])],
      makes: [making.promise, ok(made())],
      revokes: [ok(null)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.make());
    expect(result.current.working).toEqual({ kind: "make", name: "" });
    await settled(() => result.current.revoke(FOR_RAHEL.id));
    await settled(() => result.current.make());
    expect(door.calls()).toEqual(["read", "make:"]);
    await settled(() => making.settle(ok(made(""))));
    expect(result.current.working).toBeNull();
    await settled(() => result.current.make());
    expect(count(door, "make:")).toBe(1);
  });

  it("Done takes the link out of everything the model holds, and asks the server nothing", async () => {
    const door = fakeInvitesDoor({ reads: [ok([]), ok([FOR_RAHEL])], makes: [ok(made())] });
    const { result } = await opened(door);
    await settled(() => result.current.make());
    expect(kept({ ...result.current, made: null })).not.toContain(PART);
    expect(kept(result.current)).toContain(PART);
    await settled(() => result.current.done());
    expect(result.current.made).toBeNull();
    expect(kept(result.current)).not.toContain(PART);
    expect(door.calls()).toEqual(["read", "make:", "read"]);
  });

  it("says copied only once the clipboard took it", async () => {
    const taking = held<boolean>();
    const door = fakeInvitesDoor({ reads: [ok([]), ok([])], makes: [ok(made())], copies: [taking.promise] });
    const { result } = await opened(door);
    await settled(() => result.current.copy());
    expect(door.copied()).toEqual([]);
    await settled(() => result.current.make());
    await settled(() => result.current.copy());
    expect(door.copied()).toEqual([LINK]);
    expect(result.current.told).toBeNull();
    await settled(() => taking.settle(true));
    expect(result.current.told).toEqual({ kind: "copied" });
    expect(result.current.problem).toBeNull();
  });

  it("a clipboard that refuses, or throws, is said; a copy that is taken afterwards takes that back", async () => {
    const door = fakeInvitesDoor({
      reads: [ok([]), ok([])],
      makes: [ok(made())],
      copies: [false, THROWS, true],
    });
    const { result } = await opened(door);
    await settled(() => result.current.make());
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

describe("an open invite", () => {
  it("is revoked by its own id; that is said, and the list is read again", async () => {
    const door = fakeInvitesDoor({ reads: [ok([FOR_RAHEL]), ok([])], revokes: [ok(null)] });
    const { result } = await opened(door);
    await settled(() => result.current.revoke("i-unlisted"));
    expect(door.calls()).toEqual(["read"]);
    await settled(() => result.current.revoke(FOR_RAHEL.id));
    expect(door.calls()).toEqual(["read", "revoke:i-1", "read"]);
    expect(result.current.told).toEqual({ kind: "revoked" });
    expect(result.current.invites).toEqual([]);
  });

  it("revoked while its link is on show: the link stays up, as it always did", async () => {
    const door = fakeInvitesDoor({
      reads: [ok([]), ok([FOR_RAHEL]), ok([])],
      makes: [ok(made())],
      revokes: [ok(null)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.make());
    await settled(() => result.current.revoke(FOR_RAHEL.id));
    expect(result.current.told).toEqual({ kind: "revoked" });
    expect(result.current.made).toEqual(made());
  });
});

/** The two verbs the server guards with a fresh factor: the answers the door is handed, the call, the press. */
const VERBS = [
  {
    name: "a new invite",
    kind: "make",
    call: "make:",
    handed: (answers: readonly ("factor" | "taken")[]) => ({
      makes: answers.map((answer) => (answer === "factor" ? FACTOR : ok(made()))),
    }),
  },
  {
    name: "an invite revoked",
    kind: "revoke",
    call: "revoke:i-1",
    handed: (answers: readonly ("factor" | "taken")[]) => ({
      revokes: answers.map((answer) => (answer === "factor" ? FACTOR : ok(null))),
    }),
  },
] as const;

for (const verb of VERBS) {
  describe(`${verb.name}, guarded by the factor`, () => {
    /** The pane opened, the verb pressed, and the door's first answer taken in. */
    async function pressed(...answers: ("factor" | "taken")[]) {
      const door = fakeInvitesDoor({ reads: [ok([FOR_RAHEL]), ok([FOR_RAHEL])], ...verb.handed(answers) });
      const hook = await opened(door);
      await settled(() => {
        if (verb.kind === "make") hook.result.current.make();
        else hook.result.current.revoke(FOR_RAHEL.id);
      });
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
    const door = fakeInvitesDoor({
      reads: [ok([FOR_RAHEL])],
      revokes: [said("Not this one.")],
      makes: [held<Answer<MadeInvite>>().promise],
    });
    const { result } = await opened(door);
    await settled(() => result.current.revoke(FOR_RAHEL.id));
    expect(result.current.problem).toEqual({ with: "revoke", why: { word: "said", said: "Not this one." } });
    expect(result.current.told).toBeNull();
    expect(result.current.working).toBeNull();
    await settled(() => result.current.make());
    expect(result.current.problem).toBeNull();
  });

  it("a door that throws at a verb is a verb that did not go through, never a pane that hangs", async () => {
    const door = fakeInvitesDoor({ reads: [ok([])], makes: [THROWS] });
    const { result } = await opened(door);
    await settled(() => result.current.make());
    expect(result.current.problem).toEqual({ with: "make", why: { word: "said", said: "" } });
    expect(result.current.working).toBeNull();
    expect(result.current.made).toBeNull();
  });

  it("a press while the factor is asked replaces nothing that is parked", async () => {
    const door = fakeInvitesDoor({
      reads: [ok([FOR_RAHEL]), ok([FOR_RAHEL])],
      makes: [FACTOR, ok(made())],
      revokes: [ok(null)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.make());
    await settled(() => result.current.revoke(FOR_RAHEL.id));
    await settled(() => result.current.ask!.onVerified());
    expect(door.calls()).toEqual(["read", "make:", "make:", "read"]);
  });

  it("a pane left while a verb is on its way reads nothing afterwards, and holds no link", async () => {
    const making = held<Answer<MadeInvite>>();
    const door = fakeInvitesDoor({ reads: [ok([]), ok([])], makes: [making.promise] });
    const { result, unmount } = await opened(door);
    await settled(() => result.current.make());
    unmount();
    await settled(() => making.settle(ok(made())));
    expect(door.calls()).toEqual(["read", "make:"]);
    expect(kept(result.current)).not.toContain(PART);
  });
});
