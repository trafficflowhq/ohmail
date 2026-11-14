/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Answer } from "../../../src/account/contract.js";
import type { Enrolled, SecurityDoor } from "../../../src/account/security/model.js";
import { useSecurity } from "../../../src/account/security/use-security.js";
import {
  ENROLLED,
  FACTOR,
  fakeSecurityDoor,
  held,
  NOT_HANDED,
  ok,
  said,
  SIGN_IN,
  THROWS,
  type Handed,
} from "./fake-door.js";

afterEach(cleanup);

const CODES = ["58049-86391", "88255-40533"];
const KEY = "JBSWY3DPEHPK3PXP";

function mounted(door: SecurityDoor, strict = false) {
  // Strict mode from the root: under a wrapper it would replay no effect.
  return renderHook(() => useSecurity(door), { reactStrictMode: strict });
}
/** A press, and every answer it brings taken in. */
const settled = (press: () => void) =>
  act(async () => {
    press();
  });
/** The pane opened and its read answered. */
async function opened(door: SecurityDoor, strict = false) {
  const hook = mounted(door, strict);
  await settled(() => {});
  return hook;
}
/** Everything the model holds as data: what a secret would have to be in to be kept. */
const kept = (model: unknown): string => JSON.stringify(model);

describe("what is enrolled, read as the pane opens", () => {
  it("asks once, and draws nothing as known before the answer", async () => {
    const read = held<Answer<Enrolled>>();
    const door = fakeSecurityDoor({ reads: [read.promise] });
    const { result } = mounted(door);
    expect(result.current.enrolled).toEqual({ at: "loading" });
    await settled(() => read.settle(ok(ENROLLED.both)));
    expect(result.current.enrolled).toEqual({ at: "read", ...ENROLLED.both });
    expect(door.calls()).toEqual(["read"]);
  });

  it("still reads where the tree is mounted twice over", async () => {
    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.passkey), ok(ENROLLED.passkey)] });
    const { result } = await opened(door, true);
    expect(result.current.enrolled).toEqual({ at: "read", ...ENROLLED.passkey });
  });

  it("a read that failed is its reason, and no verb reaches the door over it", async () => {
    const door = fakeSecurityDoor({
      reads: [said("The server could not be reached.")],
      newCodes: [ok(CODES)],
    });
    const { result } = await opened(door);
    expect(result.current.enrolled).toEqual({
      at: "failed",
      why: { word: "said", said: "The server could not be reached." },
    });
    await settled(() => result.current.askNewCodes());
    await settled(() => result.current.confirmNewCodes());
    await settled(() => result.current.startAuthenticator());
    await settled(() => result.current.removeAuthenticator());
    expect(result.current.codes).toEqual({ at: "rest" });
    expect(door.calls()).toEqual(["read"]);
  });

  it("a read the door could not answer is a read that failed", async () => {
    const { result } = await opened(fakeSecurityDoor({ reads: [THROWS] }));
    expect(result.current.enrolled.at).toBe("failed");
  });

  it("a read refused as a way back in is a read that failed, never the factor's dialog", async () => {
    const { result } = await opened(fakeSecurityDoor({ reads: [FACTOR] }));
    expect(result.current.enrolled).toEqual({ at: "failed", why: { word: "sign_in" } });
    expect(result.current.ask).toBeNull();
  });
});

describe("new recovery codes in place of the set in use", () => {
  it("asks before it replaces: no press but the question's own Confirm reaches the door", async () => {
    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.both)], newCodes: [ok(CODES)] });
    const { result } = await opened(door);
    await settled(() => result.current.confirmNewCodes());
    expect(door.calls()).toEqual(["read"]);
    await settled(() => result.current.askNewCodes());
    expect(result.current.codes).toEqual({ at: "asked" });
    expect(door.calls()).toEqual(["read"]);
    await settled(() => result.current.cancelNewCodes());
    expect(result.current.codes).toEqual({ at: "rest" });
    await settled(() => result.current.confirmNewCodes());
    expect(door.calls()).toEqual(["read"]);
  });

  it("Confirm makes the set once, shows it, and reads what is enrolled again", async () => {
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.noCodes), ok(ENROLLED.both)],
      newCodes: [ok(CODES)],
    });
    const { result } = await opened(door);
    await settled(() => result.current.askNewCodes());
    await settled(() => result.current.confirmNewCodes());
    expect(door.calls()).toEqual(["read", "newCodes", "read"]);
    expect(result.current.codes).toEqual({ at: "shown", codes: CODES });
    expect(result.current.enrolled).toEqual({ at: "read", ...ENROLLED.both });
    expect(result.current.working).toBeNull();
  });

  it("says it is working while the set is made, and takes no second verb meanwhile", async () => {
    const making = held<Answer<readonly string[]>>();
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.both), ok(ENROLLED.both)],
      newCodes: [making.promise],
    });
    const { result } = await opened(door);
    await settled(() => result.current.askNewCodes());
    await settled(() => result.current.confirmNewCodes());
    expect(result.current.working).toBe("newCodes");
    expect(result.current.codes).toEqual({ at: "rest" });
    await settled(() => result.current.startAuthenticator());
    await settled(() => result.current.removeAuthenticator());
    expect(door.calls()).toEqual(["read", "newCodes"]);
    await settled(() => making.settle(ok(CODES)));
    expect(result.current.working).toBeNull();
  });

  it("Done drops the codes: nothing the model holds says one afterwards", async () => {
    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.both), ok(ENROLLED.both)], newCodes: [ok(CODES)] });
    const { result } = await opened(door);
    await settled(() => result.current.askNewCodes());
    await settled(() => result.current.confirmNewCodes());
    expect(kept(result.current)).toContain(CODES[0]);
    await settled(() => result.current.codesDone());
    expect(result.current.codes).toEqual({ at: "rest" });
    for (const code of CODES) expect(kept(result.current)).not.toContain(code);
  });

  it("a set made, then a read after it that failed: the set stands beside the reason, and Done still drops it", async () => {
    const failures = [
      ["refused with a sentence", said("The server could not be reached.")],
      ["not answered", THROWS],
      ["refused as a way back in", SIGN_IN],
    ] as const;
    for (const [name, failed] of failures) {
      const door = fakeSecurityDoor({ reads: [ok(ENROLLED.both), failed], newCodes: [ok(CODES)] });
      const { result } = await opened(door);
      await settled(() => result.current.askNewCodes());
      await settled(() => result.current.confirmNewCodes());
      expect(result.current.enrolled.at, name).toBe("failed");
      expect(result.current.codes, name).toEqual({ at: "shown", codes: CODES });
      await settled(() => result.current.codesDone());
      expect(result.current.codes, name).toEqual({ at: "rest" });
      for (const code of CODES) expect(kept(result.current), name).not.toContain(code);
      // Done asks the door nothing.
      expect(door.calls(), name).toEqual(["read", "newCodes", "read"]);
      cleanup();
    }
  });
});

describe("a verb the server guards with the factor", () => {
  /** The pane opened, the question confirmed, and the server asking for the factor. */
  async function parked(answers: Parameters<typeof fakeSecurityDoor>[0] = {}) {
    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.both), ok(ENROLLED.both)], ...answers });
    const hook = await opened(door);
    await settled(() => hook.result.current.askNewCodes());
    await settled(() => hook.result.current.confirmNewCodes());
    return { door, ...hook };
  }

  it("is tried first, asks the factor only on the refusal, and sends nothing more before it verifies", async () => {
    const { door, result } = await parked({ newCodes: [FACTOR, ok(CODES)] });
    expect(door.calls()).toEqual(["read", "newCodes"]);
    expect(result.current.ask).not.toBeNull();
    expect(result.current.problem).toBeNull();
    await settled(() => result.current.startAuthenticator());
    expect(door.calls()).toEqual(["read", "newCodes"]);
  });

  it("the verified factor sends the parked verb once, however often it is said", async () => {
    const { door, result } = await parked({ newCodes: [FACTOR, ok(CODES)] });
    const ask = result.current.ask!;
    await settled(() => {
      ask.onVerified();
      ask.onVerified();
    });
    expect(door.calls()).toEqual(["read", "newCodes", "newCodes", "read"]);
    expect(result.current.codes).toEqual({ at: "shown", codes: CODES });
    expect(result.current.ask).toBeNull();
  });

  it("refused again after the factor is the way back in, never a second dialog", async () => {
    const { door, result } = await parked({ newCodes: [FACTOR, FACTOR, ok(CODES)] });
    await settled(() => result.current.ask!.onVerified());
    expect(result.current.problem).toEqual({ with: "newCodes", why: { word: "sign_in" } });
    expect(result.current.ask).toBeNull();
    expect(door.calls()).toEqual(["read", "newCodes", "newCodes"]);
  });

  it("Cancel drops it: a factor said afterwards sends nothing", async () => {
    const { door, result } = await parked({ newCodes: [FACTOR, ok(CODES)] });
    const ask = result.current.ask!;
    await settled(() => ask.onCancel());
    expect(result.current.ask).toBeNull();
    expect(result.current.nothingRan).toBe(false);
    await settled(() => ask.onVerified());
    expect(door.calls()).toEqual(["read", "newCodes"]);
  });

  it("a factor that landed after Cancel says nothing ran, and nothing did", async () => {
    const { door, result } = await parked({ newCodes: [FACTOR, ok(CODES)] });
    const ask = result.current.ask!;
    await settled(() => ask.onCancel());
    await settled(() => ask.onDiscarded());
    expect(result.current.nothingRan).toBe(true);
    expect(door.calls()).toEqual(["read", "newCodes"]);
    // The next press starts clean.
    await settled(() => result.current.askNewCodes());
    await settled(() => result.current.confirmNewCodes());
    expect(result.current.nothingRan).toBe(false);
  });

  it("a pane left while the factor is asked sends nothing afterwards", async () => {
    const { door, result, unmount } = await parked({ newCodes: [FACTOR, ok(CODES)] });
    const ask = result.current.ask!;
    unmount();
    await settled(() => ask.onVerified());
    expect(door.calls()).toEqual(["read", "newCodes"]);
  });

  it("a pane left while a verb is on its way asks nothing when the answer lands", async () => {
    const making = held<Answer<readonly string[]>>();
    const { door, unmount } = await parked({ newCodes: [making.promise] });
    unmount();
    await settled(() => making.settle(ok(CODES)));
    expect(door.calls()).toEqual(["read", "newCodes"]);
  });

  it("any other refusal is said as the door answered it, and a verb that gave no answer is said too", async () => {
    const refused = await parked({ newCodes: [said("You are offline.")] });
    expect(refused.result.current.problem?.why).toEqual({ word: "said", said: "You are offline." });
    cleanup();
    const again = await parked({ newCodes: [SIGN_IN] });
    expect(again.result.current.problem?.why).toEqual({ word: "sign_in" });
    cleanup();
    const broken = await parked({ newCodes: [THROWS] });
    expect(broken.result.current.problem?.why).toEqual({ word: "said", said: "" });
    expect(broken.result.current.working).toBeNull();
    cleanup();
    const unhanded = await parked();
    expect(unhanded.result.current.problem?.why).toEqual({ word: "said", said: NOT_HANDED });
  });
});

describe("the authenticator", () => {
  it("starting one shows its key, and reads nothing again", async () => {
    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.passkey)], starts: [ok({ key: KEY })] });
    const { result } = await opened(door);
    await settled(() => result.current.startAuthenticator());
    expect(result.current.authenticator).toEqual({ at: "key", key: KEY, code: "" });
    expect(door.calls()).toEqual(["read", "startAuthenticator"]);
  });

  /** The pane opened and an enrolment started. */
  async function withKey(input: Parameters<typeof fakeSecurityDoor>[0] = {}) {
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.passkey), ok(ENROLLED.both)],
      starts: [ok({ key: KEY })],
      ...input,
    });
    const hook = await opened(door);
    await settled(() => hook.result.current.startAuthenticator());
    return { door, ...hook };
  }

  it("sends nothing while no code is typed", async () => {
    const { door, result } = await withKey({ activates: [ok(null)] });
    await settled(() => result.current.activate());
    await settled(() => result.current.typeCode("   "));
    await settled(() => result.current.activate());
    expect(door.calls()).toEqual(["read", "startAuthenticator"]);
  });

  it("sends the code trimmed, once; then the key and the code are gone and the read is asked again", async () => {
    const { door, result } = await withKey({ activates: [ok(null)] });
    await settled(() => result.current.typeCode("  123456 "));
    await settled(() => result.current.activate());
    expect(door.codes()).toEqual(["123456"]);
    expect(door.calls()).toEqual(["read", "startAuthenticator", "activate", "read"]);
    expect(result.current.authenticator).toEqual({ at: "rest" });
    expect(kept(result.current)).not.toContain(KEY);
    expect(kept(result.current)).not.toContain("123456");
    expect(result.current.enrolled).toEqual({ at: "read", ...ENROLLED.both });
  });

  it("a refused code keeps the key and what was typed, and says the refusal", async () => {
    const { door, result } = await withKey({ activates: [said("That code is not right.")] });
    await settled(() => result.current.typeCode("000000"));
    await settled(() => result.current.activate());
    expect(result.current.authenticator).toEqual({ at: "key", key: KEY, code: "000000" });
    expect(result.current.problem).toEqual({
      with: "activate",
      why: { word: "said", said: "That code is not right." },
    });
    expect(door.calls()).toEqual(["read", "startAuthenticator", "activate"]);
  });

  it("the factor sends the code that was typed at the press, once", async () => {
    const { door, result } = await withKey({ activates: [FACTOR, ok(null)] });
    await settled(() => result.current.typeCode("123456"));
    await settled(() => result.current.activate());
    await settled(() => result.current.typeCode("999999"));
    await settled(() => result.current.ask!.onVerified());
    expect(door.codes()).toEqual(["123456", "123456"]);
  });

  it("Cancel drops the key and the code", async () => {
    const { result } = await withKey();
    await settled(() => result.current.typeCode("123456"));
    await settled(() => result.current.cancelAuthenticator());
    expect(result.current.authenticator).toEqual({ at: "rest" });
    expect(kept(result.current)).not.toContain(KEY);
  });

  /** An enrolment started, new codes made while its key stands, and the read after them answered as handed. */
  async function keyThenRead(read: Handed<Enrolled>, input: Parameters<typeof fakeSecurityDoor>[0] = {}) {
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.passkey), read, ok(ENROLLED.both)],
      starts: [ok({ key: KEY })],
      newCodes: [ok(CODES)],
      ...input,
    });
    const hook = await opened(door);
    await settled(() => hook.result.current.startAuthenticator());
    await settled(() => hook.result.current.askNewCodes());
    await settled(() => hook.result.current.confirmNewCodes());
    return { door, ...hook };
  }

  it("a key, then a read after it that failed: the key stands with its code, and Cancel still drops it", async () => {
    const failures = [
      ["refused with a sentence", said("The server could not be reached.")],
      ["not answered", THROWS],
      ["refused as a way back in", SIGN_IN],
    ] as const;
    for (const [name, failed] of failures) {
      const { door, result } = await keyThenRead(failed);
      expect(result.current.enrolled.at, name).toBe("failed");
      expect(result.current.authenticator, name).toEqual({ at: "key", key: KEY, code: "" });
      await settled(() => result.current.typeCode("123456"));
      expect(result.current.authenticator, name).toEqual({ at: "key", key: KEY, code: "123456" });
      await settled(() => result.current.cancelAuthenticator());
      expect(result.current.authenticator, name).toEqual({ at: "rest" });
      expect(kept(result.current), name).not.toContain(KEY);
      expect(kept(result.current), name).not.toContain("123456");
      // Cancel asks the door nothing.
      expect(door.calls(), name).toEqual(["read", "startAuthenticator", "newCodes", "read"]);
      cleanup();
    }
  });

  it("over that failed read the code that finishes the enrolment is still taken, through its factor, once", async () => {
    const { door, result } = await keyThenRead(said("The server could not be reached."), {
      activates: [FACTOR, ok(null)],
    });
    await settled(() => result.current.typeCode(" 123456 "));
    await settled(() => result.current.activate());
    expect(result.current.ask).not.toBeNull();
    await settled(() => result.current.ask!.onVerified());
    expect(door.codes()).toEqual(["123456", "123456"]);
    expect(door.calls()).toEqual([
      "read",
      "startAuthenticator",
      "newCodes",
      "read",
      "activate",
      "activate",
      "read",
    ]);
    expect(result.current.authenticator).toEqual({ at: "rest" });
    expect(kept(result.current)).not.toContain(KEY);
    expect(result.current.enrolled).toEqual({ at: "read", ...ENROLLED.both });
  });

  it("is removed only while a passkey is also enrolled", async () => {
    const alone = fakeSecurityDoor({ reads: [ok(ENROLLED.authenticator)], removes: [ok(null)] });
    const lone = await opened(alone);
    await settled(() => lone.result.current.removeAuthenticator());
    expect(alone.calls()).toEqual(["read"]);
    cleanup();

    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.both), ok(ENROLLED.passkey)], removes: [ok(null)] });
    const { result } = await opened(door);
    await settled(() => result.current.removeAuthenticator());
    expect(door.calls()).toEqual(["read", "removeAuthenticator", "read"]);
    expect(result.current.enrolled).toEqual({ at: "read", ...ENROLLED.passkey });
  });
});
