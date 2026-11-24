/**
 * THE SWITCH BETWEEN THE TWO APPS, its JavaScript half over a native double: the payload's one strict reading of the
 * fields native hands over, the sender's guards and its handoff, the receiver's step and its handoff against a
 * loopback server, and the router never handed a switch link.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairLink } from "@ohmail/client-engine";
import { redirectSystemPath } from "../app/+native-intent";
import { LOCAL_ENGINE_ORIGIN, type MobileEngineDeps } from "../src/engine/boot";
import { BearerRegistry } from "../src/net/bearer-registry";
import { livePairings, type PairingEnv } from "../src/net/pairing";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { challengeOf, pairingDigest } from "../src/switch/digest";
import { isSwitchPath } from "../src/switch/link";
import { payloadFields, readPayload, type SwitchPayload } from "../src/switch/payload";
import {
  notePairings, placeHolder, switchIntake, takeUpArrival, type HandedSession, type ReceiveDeps,
} from "../src/switch/receive";
import { stepArrival } from "../src/switch/receiver";
import { HANDOFF_WAIT_MS, PRESS_GAP_MS, switchSender, type SenderDeps } from "../src/switch/sender";
import type { SwitchNative } from "../src/switch/switch-port";
import type { ShellEvent } from "../src/shell/bridge-kinds";
import type { Bridge } from "../web/src/bridge";
import { otherAppDoor } from "../web/src/other-app";
import { listen, pairServer, sqlWorld } from "./helpers/pair-server";

const ID = "0b9f2c1e-7d4a-4c1b-9e3f-5a6b7c8d9e0f";
const D = "A".repeat(43);
const C = "b".repeat(43);

describe("the payload", () => {
  it("reads each leg's own fields, and gives them back as the fields a native call carries", () => {
    const legs: SwitchPayload[] = [
      { v: "1", k: "open", p: "last" },
      { v: "1", k: "open", p: `event:${ID}`, d: D },
      { v: "1", k: "open", p: "last", d: D, c: C, l: "ohcal://pair?x=1" },
      { v: "1", k: "ask", c: C },
      { v: "1", k: "done", c: C, l: "ohcal://pair?x=1" },
    ];
    for (const leg of legs) {
      expect(readPayload(payloadFields(leg))).toEqual(leg);
    }
  });

  it("refuses a key outside the leg, a missing one, a wrong shape, a code without its challenge", () => {
    for (const fields of [
      { v: "1", k: "open" }, { v: "2", k: "open", p: "last" }, { v: "1", k: "pair", p: "last" },
      { v: "1", k: "open", p: "last", token: D }, { v: "1", k: "open", p: "last", d: "short" },
      { v: "1", k: "open", p: "last", d: D, l: "ohcal://pair" }, { v: "1", k: "open", p: "last", c: C },
      { v: "1", k: "ask", c: C, p: "last" }, { v: "1", k: "done", c: C }, { v: "1", k: "open", p: "https://x.example" },
      { v: "1", k: "open", p: "last", l: "a b" }, { v: 1, k: "open", p: "last" }, null, [],
    ]) {
      expect(readPayload(fields as Record<string, unknown>), JSON.stringify(fields)).toBeNull();
    }
  });
});

describe("the switch's link", () => {
  it("never reaches the router: a switch path is answered with the root, any other link passes as it came", () => {
    for (const path of [
      `https://ohcal.app/switch#v=1&k=done&c=${C}&l=x`, "https://ohmail.app/switch-preview#v=1", "/switch#v=1",
      "ohcal://switch#v=1&k=open&p=last", "ohmail://switch-preview",
    ]) {
      expect(redirectSystemPath({ path, initial: true }), path).toBe("/");
    }
    for (const path of ["ohmail://pair?token=x", "/message/42", "mailto:someone@example.com", "https://ohmail.app/open"]) {
      expect(redirectSystemPath({ path, initial: false }), path).toBe(path);
    }
    expect(isSwitchPath("/switching")).toBe(false);
  });
});

function nativeDouble(answer = true) {
  const opened: Record<string, string>[] = [];
  const native: SwitchNative = {
    appId: "app.ohmail",
    otherState: () => "here",
    open: async (fields) => (opened.push({ ...fields }), answer),
    openStore: async () => true,
    takeArrival: async () => null,
    addListener: () => ({ remove() {} }),
  };
  return { native, opened };
}

describe("the sender", () => {
  const deps = (over: Partial<SenderDeps> = {}): SenderDeps => ({
    app: "ohmail", native: nativeDouble().native, inFront: () => true, now: () => 10_000, digest: async () => D, ...over,
  });

  it("opens the other app at a place of its direction, with the place and the pairing's digest and nothing else", async () => {
    const { native, opened } = nativeDouble();
    expect(await switchSender(deps({ native })).open({ to: "event", id: ID })).toBe("opened");
    expect(opened).toEqual([{ v: "1", k: "open", p: `event:${ID}`, d: D }]);
  });

  it("sends no digest where no pairing lives, and reads a press no app took as absent", async () => {
    const { native, opened } = nativeDouble(false);
    expect(await switchSender(deps({ native, digest: async () => null })).open({ to: "last" })).toBe("absent");
    expect(opened).toEqual([{ v: "1", k: "open", p: "last" }]);
  });

  it("opens nothing at a place of the other direction, from behind, twice inside the gap, or without the module", async () => {
    const { native, opened } = nativeDouble();
    expect(await switchSender(deps({ native })).open({ to: "message", id: ID })).toEqual({ refused: "malformed" });
    expect(await switchSender(deps({ native, inFront: () => false })).open({ to: "last" })).toEqual({ refused: "notReady" });
    expect(await switchSender(deps({ native: null })).open({ to: "last" })).toEqual({ refused: "notReady" });
    let at = 10_000;
    const sender = switchSender(deps({ native, now: () => at }));
    expect(await sender.open({ to: "last" })).toBe("opened");
    at += PRESS_GAP_MS - 1;
    expect(await sender.open({ to: "last" })).toEqual({ refused: "tooMany" });
    at += 1;
    expect(await sender.open({ to: "last" })).toBe("opened");
    expect(opened).toHaveLength(2);
  });
});

/** The link a minted code rides in, as the sender composes it; and the sibling's provider, answering as asked. */
const LINK = `https://mail.example.test/pair#${"t".repeat(43)}`;
function askingDouble(said: Record<string, string> | null) {
  const { native, opened } = nativeDouble();
  const asked: (string | null)[] = [];
  native.askSibling = async (digest) => (asked.push(digest), said);
  return { native, opened, asked };
}

describe("the sender's handoff, on Android", () => {
  const deps = (over: Partial<SenderDeps> = {}): SenderDeps => ({
    app: "ohmail", native: nativeDouble().native, inFront: () => true, now: () => 10_000, digest: async () => D, ...over,
  });
  afterEach(() => { vi.useRealTimers(); });

  it("hands a signed-out sibling a code bound to its own challenge, in the same call that opens it", async () => {
    const { native, opened, asked } = askingDouble({ a: "none", c: C });
    const minted: string[] = [];
    expect(await switchSender(deps({ native, mint: async (c) => (minted.push(c), LINK) })).open({ to: "event", id: ID })).toBe("opened");
    expect([asked, minted]).toEqual([[D], [C]]);
    expect(opened).toEqual([{ v: "1", k: "open", p: `event:${ID}`, d: D, c: C, l: LINK }]);
  });

  it("opens with the place alone for a sibling that holds a pairing or answers nothing, and mints for no other answer", async () => {
    const answers: (Record<string, string> | null)[] = [{ a: "same" }, { a: "other" }, null, { a: "none" }, { a: "none", c: "short" }, { a: "maybe", c: C }];
    for (const said of answers) {
      const { native, opened } = askingDouble(said);
      const minted: string[] = [];
      expect(await switchSender(deps({ native, mint: async (c) => (minted.push(c), LINK) })).open({ to: "last" })).toBe("opened");
      expect([opened, minted], JSON.stringify(said)).toEqual([[{ v: "1", k: "open", p: "last", d: D }], []]);
    }
  });

  it("opens with the place alone when no code comes, the code is no pairing link, or the press is absent", async () => {
    for (const mint of [async () => null, async () => { throw new Error("offline"); }, async () => "a b"]) {
      const { native, opened } = askingDouble({ a: "none", c: C });
      expect(await switchSender(deps({ native, mint })).open({ to: "last" })).toBe("opened");
      expect(opened).toEqual([{ v: "1", k: "open", p: "last", d: D }]);
    }
    const gone = askingDouble(null);
    gone.native.open = async () => false;
    expect(await switchSender(deps({ native: gone.native, mint: async () => LINK })).open({ to: "last" })).toBe("absent");
  });

  it("asks nothing of the sibling and mints nothing from this phone's own mailbox or without a pairing", async () => {
    const own = askingDouble({ a: "none", c: C });
    expect(await switchSender(deps({ native: own.native })).open({ to: "last" })).toBe("opened");
    const none = askingDouble({ a: "none", c: C });
    const minted: string[] = [];
    const sender = switchSender(deps({ native: none.native, digest: async () => null, mint: async (c) => (minted.push(c), LINK) }));
    expect(await sender.open({ to: "last" })).toBe("opened");
    expect([own.asked, none.asked, minted]).toEqual([[], [], []]);
    expect([own.opened, none.opened]).toEqual([[{ v: "1", k: "open", p: "last", d: D }], [{ v: "1", k: "open", p: "last" }]]);
  });

  it("opens with the place alone once the press has waited its bound, and not at all once this app left the front", async () => {
    vi.useFakeTimers();
    const slow = askingDouble({ a: "none", c: C });
    const pending = switchSender(deps({ native: slow.native, mint: () => new Promise<string | null>(() => {}) })).open({ to: "last" });
    await vi.advanceTimersByTimeAsync(HANDOFF_WAIT_MS);
    expect(await pending).toBe("opened");
    expect(slow.opened).toEqual([{ v: "1", k: "open", p: "last", d: D }]);
    vi.useRealTimers();
    let front = true;
    const left = askingDouble({ a: "none", c: C });
    const sender = switchSender(deps({ native: left.native, inFront: () => front, mint: async () => ((front = false), LINK) }));
    expect(await sender.open({ to: "last" })).toEqual({ refused: "notReady" });
    expect(left.opened).toEqual([]);
  });
});

describe("the receiver's step", () => {
  const open = (p: string, d?: string): SwitchPayload => ({ v: "1", k: "open", p, ...(d ? { d } : {}) });

  it("opens a place only inside the account the sender named, and only of the sender's direction", () => {
    expect(stepArrival(open(`event:${ID}`, D), { k: "live", digest: D }, "ohmail")).toEqual({ act: "go", to: { to: "event", id: ID } });
    expect(stepArrival(open(`message:${ID}`, D), { k: "live", digest: D }, "ohcal")).toEqual({ act: "go", to: { to: "message", id: ID } });
    expect(stepArrival(open("last", D), { k: "live", digest: D }, "ohmail")).toEqual({ act: "stay", why: "last" });
  });

  it("stays where it was for another account, no digest, or the wrong direction", () => {
    const other = "Z".repeat(43);
    expect(stepArrival(open(`event:${ID}`, other), { k: "live", digest: D }, "ohmail")).toEqual({ act: "stay", why: "otherAccount" });
    expect(stepArrival(open(`event:${ID}`), { k: "live", digest: D }, "ohmail")).toEqual({ act: "stay", why: "otherAccount" });
    expect(stepArrival(open(`event:${ID}`, D), { k: "live", digest: null }, "ohmail")).toEqual({ act: "stay", why: "otherAccount" });
    expect(stepArrival(open(`message:${ID}`, D), { k: "live", digest: D }, "ohmail")).toEqual({ act: "stay", why: "malformed" });
    expect(stepArrival({ v: "1", k: "ask", c: C }, { k: "live", digest: D }, "ohmail")).toEqual({ act: "stay", why: "malformed" });
  });
});

/* ── the receiving app's handoff, against a loopback server speaking the redeem's handoff arm ─────────────────── */

const sha = async (text: string) => createHash("sha256").update(text).digest("base64");
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v), remove: async (k) => void map.delete(k) };
}

function receiverEnv(): PairingEnv {
  const world = sqlWorld();
  const engineDeps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" };
  return { profiles: new ServerProfileStore(memoryKV()), engineDeps, deviceKind: "mobile-android", bearers: new BearerRegistry() };
}

/** Native as the receiving app's: one arrival, and one pending challenge whose verifier it hands over once. */
function arriving(fields: Record<string, string> | null, pending: { challenge: string; verifier: string } | null) {
  const asked: string[] = [];
  let arrival = fields;
  let held = pending;
  const native: SwitchNative = {
    ...nativeDouble().native,
    takeArrival: async () => { const a = arrival; arrival = null; return a; },
    takeVerifier: async (challenge) => {
      asked.push(challenge);
      const p = held;
      held = null;
      return p !== null && p.challenge === challenge ? { verifier: p.verifier } : null;
    },
  };
  return { native, asked };
}

function receiving(env: PairingEnv, native: SwitchNative, over: Partial<ReceiveDeps> = {}) {
  const adopted: HandedSession[] = [];
  const places: unknown[] = [];
  const deps: ReceiveDeps = {
    env, native, from: "ohmail", surface: "shell", sha256: sha, transition: (op) => op(() => true),
    liveDigest: async () => null, minter: () => undefined, adopt: (h) => void adopted.push(h),
    place: (to) => void places.push(to), ...over,
  };
  return { deps, adopted, places };
}

/** The sender's server: a door that names its account by the rows it serves, and the sender's digest of it. */
async function sendersServer() {
  const fake = pairServer({ flavor: "desktop-host", accountId: "acct-1" });
  const origin = await listen(fake.server);
  fake.addMessage("m-1", "a letter");
  return { fake, origin, digest: await pairingDigest(sha, origin, "acct-1") };
}

describe("the receiving app's handoff", () => {
  it("signs a signed-out app in with the sibling's code, spent with its own verifier, and opens at the place", async () => {
    const { fake, origin, digest } = await sendersServer();
    try {
      const env = receiverEnv();
      fake.mintHandoffToken("code-1", CHALLENGE);
      const { native, asked } = arriving(
        { v: "1", k: "open", p: `event:${ID}`, d: digest, c: CHALLENGE, l: pairLink(origin, "code-1", null) },
        { challenge: CHALLENGE, verifier: VERIFIER },
      );
      const { deps, adopted, places } = receiving(env, native);
      expect(await takeUpArrival(deps)).toBe("signedIn");
      expect(asked).toEqual([CHALLENGE]);
      expect(fake.seen.filter((r) => r.url === "/pair/redeem").map((r) => JSON.parse(r.body)))
        .toEqual([{ grant: "app-handoff", token: "code-1", verifier: VERIFIER, kind: "mobile-android" }]);
      expect(adopted.map((h) => [h.kind, h.session.profile.origin, h.session.profile.accountId])).toEqual([["shell", origin, "acct-1"]]);
      expect(places).toEqual([{ to: "event", id: ID }]);
      expect((await livePairings(env)).map((p) => p.accountId)).toEqual(["acct-1"]);
      // Nothing waits a second time: the arrival and the verifier were each handed over once.
      expect(await takeUpArrival(deps)).toBe("nothing");
    } finally {
      fake.server.close();
    }
  });

  it("spends nothing without its own pending challenge, for another one, while it holds a live pairing, or for an origin it refuses", async () => {
    const { fake, origin, digest } = await sendersServer();
    try {
      fake.mintHandoffToken("code-1", CHALLENGE);
      const open = (l = pairLink(origin, "code-1", null)) => ({ v: "1", k: "open", p: "last", d: digest, c: CHALLENGE, l });
      const other = "o".repeat(43);
      expect(await takeUpArrival(receiving(receiverEnv(), arriving(open(), null).native).deps)).toBe("refused");
      const elsewhere = { challenge: createHash("sha256").update(other).digest("base64url"), verifier: other };
      expect(await takeUpArrival(receiving(receiverEnv(), arriving(open(), elsewhere).native).deps)).toBe("refused");
      // A verifier that is not its challenge's, whatever native said: refused before any request.
      expect(await takeUpArrival(receiving(receiverEnv(), arriving(open(), { challenge: CHALLENGE, verifier: other }).native).deps)).toBe("refused");
      const holding = receiverEnv();
      await holding.profiles.add({ origin: "https://mail.example.test", flavor: "selfhost", accountId: "acct-9", refreshToken: "r-9" });
      const held = arriving(open(), { challenge: CHALLENGE, verifier: VERIFIER });
      expect(await takeUpArrival(receiving(holding, held.native).deps)).toBe("stayed");
      expect(held.asked, "a code beside a live pairing is dropped, its verifier never asked for").toEqual([]);
      const refused = arriving(open(pairLink("http://mail.example.test", "code-1", null)), { challenge: CHALLENGE, verifier: VERIFIER });
      expect(await takeUpArrival(receiving(receiverEnv(), refused.native).deps)).toBe("refused");
      expect(fake.seen, "not one request reached the sibling's server").toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  it("drops the code when a pairing was made between the arrival and its transition", async () => {
    const { fake, origin, digest } = await sendersServer();
    try {
      fake.mintHandoffToken("code-1", CHALLENGE);
      const env = receiverEnv();
      const { native, asked } = arriving(
        { v: "1", k: "open", p: `event:${ID}`, d: digest, c: CHALLENGE, l: pairLink(origin, "code-1", null) },
        { challenge: CHALLENGE, verifier: VERIFIER },
      );
      const { deps, adopted, places } = receiving(env, native, {
        transition: async (op) => {
          await env.profiles.add({ origin: "https://mail.example.test", flavor: "selfhost", accountId: "acct-9", refreshToken: "r-9" });
          return op(() => true);
        },
      });
      expect(await takeUpArrival(deps)).toBe("stayed");
      expect(asked, "its verifier never asked for").toEqual([]);
      expect(fake.seen.filter((r) => r.url === "/pair/redeem")).toEqual([]);
      expect([adopted, places]).toEqual([[], []]);
    } finally {
      fake.server.close();
    }
  });

  it("signs out and drops a session whose account is not the one the sender named, and shows nothing", async () => {
    const { fake, origin } = await sendersServer();
    try {
      const env = receiverEnv();
      fake.mintHandoffToken("code-1", CHALLENGE);
      const named = await pairingDigest(sha, origin, "acct-2");
      const { native } = arriving(
        { v: "1", k: "open", p: `event:${ID}`, d: named, c: CHALLENGE, l: pairLink(origin, "code-1", null) },
        { challenge: CHALLENGE, verifier: VERIFIER },
      );
      const { deps, adopted, places } = receiving(env, native);
      expect(await takeUpArrival(deps)).toBe("dropped");
      expect([adopted, places, await env.profiles.list()]).toEqual([[], [], []]);
      expect(fake.seen.some((r) => r.url === "/auth/logout"), "the session the code made is signed out").toBe(true);
    } finally {
      fake.server.close();
    }
  });

  it("enters nothing for a code the server refuses, nor for a session a newer transition overtook", async () => {
    const { fake, origin, digest } = await sendersServer();
    try {
      fake.mintHandoffToken("code-1", "x".repeat(43));
      const open = { v: "1", k: "open", p: `event:${ID}`, d: digest, c: CHALLENGE, l: pairLink(origin, "code-1", null) };
      const refusedEnv = receiverEnv();
      const refused = receiving(refusedEnv, arriving(open, { challenge: CHALLENGE, verifier: VERIFIER }).native);
      expect(await takeUpArrival(refused.deps)).toBe("refused");
      expect([refused.adopted, refused.places, await refusedEnv.profiles.list()]).toEqual([[], [], []]);
      fake.mintHandoffToken("code-1", CHALLENGE);
      const overtaken = receiving(receiverEnv(), arriving(open, { challenge: CHALLENGE, verifier: VERIFIER }).native, {
        transition: (op) => op(() => false),
      });
      expect(await takeUpArrival(overtaken.deps)).toBe("superseded");
      expect([overtaken.adopted, overtaken.places]).toEqual([[], []]);
    } finally {
      fake.server.close();
    }
  });

  it("opens a place for an app that holds a live pairing only inside the account the sender named", async () => {
    const env = receiverEnv();
    await env.profiles.add({ origin: "https://mail.example.test", flavor: "selfhost", accountId: "acct-1", refreshToken: "r-1" });
    const mine = await pairingDigest(sha, "https://mail.example.test", "acct-1");
    const there = receiving(env, arriving({ v: "1", k: "open", p: `event:${ID}`, d: mine }, null).native, { liveDigest: async () => mine });
    expect(await takeUpArrival(there.deps)).toBe("place");
    expect(there.places).toEqual([{ to: "event", id: ID }]);
    const elsewhere = receiving(env, arriving({ v: "1", k: "open", p: `event:${ID}`, d: D }, null).native, { liveDigest: async () => mine });
    expect(await takeUpArrival(elsewhere.deps)).toBe("stayed");
    expect(elsewhere.places).toEqual([]);
  });
});

describe("the iPhone's three legs, over native's double", () => {
  /** Native as the iPhone's: the asks back and the answers it was asked to open, each answered as `opens` says. */
  function iphone(fields: Record<string, string> | null, pending: Record<string, string> | null, opens = true) {
    const base = arriving(fields, null);
    const askedBack: [string, string][] = [];
    const answered: [string, string][] = [];
    let held = pending;
    base.native.takeVerifier = async (challenge) => {
      const p = held;
      held = null;
      return p !== null && p.challenge === challenge ? { verifier: p.verifier!, d: p.d!, p: p.p! } : null;
    };
    base.native.askBack = async (digest, place) => (askedBack.push([digest, place]), opens);
    base.native.answer = async (challenge, link) => (answered.push([challenge, link]), opens);
    return { native: base.native, askedBack, answered };
  }

  it("a signed-out app asks the sibling back once, in answer to its opening leg, only for a sender that named its pairing", async () => {
    const asks = iphone({ v: "1", k: "open", p: `event:${ID}`, d: D }, null);
    expect(await takeUpArrival(receiving(receiverEnv(), asks.native).deps)).toBe("asked");
    expect(asks.askedBack).toEqual([[D, `event:${ID}`]]);
    const nameless = iphone({ v: "1", k: "open", p: "last" }, null);
    expect(await takeUpArrival(receiving(receiverEnv(), nameless.native).deps)).toBe("stayed");
    const refused = iphone({ v: "1", k: "open", p: "last", d: D }, null, false);
    expect(await takeUpArrival(receiving(receiverEnv(), refused.native).deps)).toBe("stayed");
    const holding = receiverEnv();
    await holding.profiles.add({ origin: "https://mail.example.test", flavor: "selfhost", accountId: "acct-9", refreshToken: "r-9" });
    const paired = iphone({ v: "1", k: "open", p: `event:${ID}`, d: D }, null);
    expect(await takeUpArrival(receiving(holding, paired.native).deps)).toBe("stayed");
    expect([nameless.askedBack, paired.askedBack]).toEqual([[], []]);
  });

  it("the sender answers the sibling's ask with a code minted for that challenge alone, and only from a paired door", async () => {
    const minted: string[] = [];
    const mint = async (c: string) => (minted.push(c), LINK);
    const asked = iphone({ v: "1", k: "ask", c: C }, null);
    expect(await takeUpArrival(receiving(receiverEnv(), asked.native, { minter: () => mint }).deps)).toBe("granted");
    expect([minted, asked.answered]).toEqual([[C], [[C, LINK]]]);
    // This phone's own mailbox, or no session in front: nothing is minted and nothing answered.
    const unpaired = iphone({ v: "1", k: "ask", c: C }, null);
    expect(await takeUpArrival(receiving(receiverEnv(), unpaired.native).deps)).toBe("stayed");
    const codeless = iphone({ v: "1", k: "ask", c: C }, null);
    expect(await takeUpArrival(receiving(receiverEnv(), codeless.native, { minter: () => async () => null }).deps)).toBe("refused");
    // Native answers only an ask its own press armed: an unarmed one is refused there.
    const unarmed = iphone({ v: "1", k: "ask", c: C }, null, false);
    expect(await takeUpArrival(receiving(receiverEnv(), unarmed.native, { minter: () => mint }).deps)).toBe("refused");
    expect([unpaired.answered, codeless.answered]).toEqual([[], []]);
  });

  it("the done leg is spent with the verifier, digest and place native kept with the ask, and never without them", async () => {
    const { fake, origin, digest } = await sendersServer();
    try {
      const done = { v: "1", k: "done", c: CHALLENGE, l: pairLink(origin, "code-1", null) };
      const none = iphone(done, null);
      expect(await takeUpArrival(receiving(receiverEnv(), none.native).deps)).toBe("refused");
      expect(fake.seen, "a done without this app's own ask reaches no server").toEqual([]);
      fake.mintHandoffToken("code-1", CHALLENGE);
      const kept = { challenge: CHALLENGE, verifier: VERIFIER, d: digest, p: `event:${ID}` };
      const env = receiverEnv();
      const { deps, adopted, places } = receiving(env, iphone(done, kept).native);
      expect(await takeUpArrival(deps)).toBe("signedIn");
      expect([adopted.map((h) => h.session.profile.accountId), places]).toEqual([["acct-1"], [{ to: "event", id: ID }]]);
    } finally {
      fake.server.close();
    }
  });

  it("a forged done naming another server signs in nowhere: the session is not the account the sender named", async () => {
    const { fake, digest } = await sendersServer();
    const other = pairServer({ flavor: "desktop-host", accountId: "acct-x" });
    const elsewhere = await listen(other.server);
    try {
      other.addMessage("m-x", "a letter");
      other.mintHandoffToken("code-x", CHALLENGE);
      const kept = { challenge: CHALLENGE, verifier: VERIFIER, d: digest, p: `event:${ID}` };
      const env = receiverEnv();
      const forged = iphone({ v: "1", k: "done", c: CHALLENGE, l: pairLink(elsewhere, "code-x", null) }, kept);
      const { deps, adopted, places } = receiving(env, forged.native);
      expect(await takeUpArrival(deps)).toBe("dropped");
      expect([adopted, places, await env.profiles.list()]).toEqual([[], [], []]);
      expect(other.seen.some((r) => r.url === "/auth/logout")).toBe(true);
    } finally {
      fake.server.close();
      other.server.close();
    }
  });

  it("an app that holds a live pairing spends no done leg: nothing is redeemed and its kept ask stays", async () => {
    const { fake, origin, digest } = await sendersServer();
    try {
      fake.mintHandoffToken("code-1", CHALLENGE);
      const holding = receiverEnv();
      await holding.profiles.add({ origin: "https://mail.example.test", flavor: "selfhost", accountId: "acct-9", refreshToken: "r-9" });
      const kept = { challenge: CHALLENGE, verifier: VERIFIER, d: digest, p: `event:${ID}` };
      const paired = iphone({ v: "1", k: "done", c: CHALLENGE, l: pairLink(origin, "code-1", null) }, kept);
      const { deps, adopted, places } = receiving(holding, paired.native);
      expect(await takeUpArrival(deps)).toBe("stayed");
      expect(fake.seen.filter((r) => r.url === "/pair/redeem")).toEqual([]);
      expect([adopted, places]).toEqual([[], []]);
      // The kept ask was never taken: native still hands it over.
      expect(await paired.native.takeVerifier!(CHALLENGE)).toEqual({ verifier: VERIFIER, d: digest, p: `event:${ID}` });
    } finally {
      fake.server.close();
    }
  });
});

describe("the intake, the held place and the pairings' note", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("takes an arrival only once the launch order has finished, then each native announces, one at a time", async () => {
    let announce: () => void = () => {};
    const native: SwitchNative = {
      ...nativeDouble().native,
      addListener: (_event, listener) => ((announce = listener), { remove: () => { announce = () => {}; } }),
    };
    const taken: number[] = [];
    let release: () => void = () => {};
    const intake = switchIntake(native, () => (taken.push(taken.length), new Promise<void>((r) => { release = r; })));
    announce();
    expect(taken, "nothing before the launch order has finished").toEqual([]);
    intake.launched();
    expect(taken, "the one held since the launch").toHaveLength(1);
    announce();
    announce();
    expect(taken, "one at a time").toHaveLength(1);
    release();
    await flush();
    expect(taken, "the ones announced meanwhile, taken next, once").toHaveLength(2);
    release();
    await flush();
    intake.stop();
    announce();
    expect(taken, "nothing once the provider has gone").toHaveLength(2);
  });

  it("holds a place for the session it was judged in, hands it over once, and drops one held for another", () => {
    const places = placeHolder();
    let told = 0;
    const off = places.onHeld(() => { told += 1; });
    places.hold("p-1", { to: "event", id: ID });
    expect([told, places.take("p-2"), places.take("p-1")]).toEqual([1, null, null]);
    places.hold("p-1", { to: "event", id: ID });
    expect([places.take("p-1"), places.take("p-1")]).toEqual([{ to: "event", id: ID }, null]);
    off();
    places.hold("p-1", { to: "message", id: ID });
    expect(told).toBe(2);
  });

  it("notes the app's live pairings by their digests for its provider: none says none, an ended one is none", async () => {
    const env = receiverEnv();
    const written: string[][] = [];
    const native: SwitchNative = { ...nativeDouble().native, notePairings: async (digests) => (written.push([...digests]), true) };
    expect(await notePairings(native, env, sha)).toBe(true);
    await env.profiles.add({ origin: "https://mail.example.test", flavor: "selfhost", accountId: "acct-1", refreshToken: "r-1" });
    const ended = await env.profiles.add({ origin: "https://other.example.test", flavor: "selfhost", accountId: "acct-2", refreshToken: "r-2" });
    await env.profiles.clearRefreshToken(ended.id, new Set(["r-2"]));
    await env.profiles.addStandalone({ origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "own-1" });
    expect(await notePairings(native, env, sha)).toBe(true);
    expect(written).toEqual([[], [
      await pairingDigest(sha, "https://mail.example.test", "acct-1"), await pairingDigest(sha, LOCAL_ENGINE_ORIGIN, "own-1"),
    ]]);
    expect(written.flat().every((d) => /^[A-Za-z0-9_-]{43}$/.test(d))).toBe(true);
    // A system whose module keeps no such note writes nothing.
    expect(await notePairings(nativeDouble().native, env, sha)).toBe(false);
  });
});

describe("the secrets of one handoff", () => {
  it("never reach the page, a place, a word of the outcome or the log", async () => {
    const { fake, origin, digest } = await sendersServer();
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))));
    try {
      const code = "q".repeat(43);
      const said = askingDouble({ a: "none", c: CHALLENGE });
      const link = pairLink(origin, code, null);
      const sender = switchSender({ app: "ohmail", native: said.native, inFront: () => true, now: () => 10_000, digest: async () => digest, mint: async () => link });
      const toPage = await sender.open({ to: "event", id: ID });
      fake.mintHandoffToken(code, CHALLENGE);
      const { deps, places } = receiving(receiverEnv(), arriving(said.opened[0]!, { challenge: CHALLENGE, verifier: VERIFIER }).native);
      const word = await takeUpArrival(deps);
      expect([toPage, word]).toEqual(["opened", "signedIn"]);
      const seen = JSON.stringify([toPage, word, places, logged]);
      for (const secret of [code, VERIFIER, CHALLENGE]) expect(seen.includes(secret)).toBe(false);
      // The code itself went exactly where it must: the call that opened the sibling, and the redeem's body.
      expect(said.opened[0]!.l).toBe(link);
      expect(fake.seen.filter((r) => r.body.includes(code)).map((r) => r.url)).toEqual(["/pair/redeem"]);
      expect(fake.seen.every((r) => !r.url.includes(code) && !r.url.includes(VERIFIER))).toBe(true);
    } finally {
      spies.forEach((s) => s.mockRestore());
      fake.server.close();
    }
  });
});

describe("the handoff's challenge", () => {
  it("is SHA-256 of the verifier's characters, base64url without padding, as the server derives it", async () => {
    expect(await challengeOf(sha, VERIFIER)).toBe(CHALLENGE);
    expect(CHALLENGE).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("the pairing's digest", () => {
  it("is SHA-256 over the origin, a newline and the account, base64url without padding", async () => {
    const sha = async (text: string) => createHash("sha256").update(text).digest("base64");
    const digest = await pairingDigest(sha, "https://mail.example.test", "acct-1");
    expect(digest).toBe(createHash("sha256").update("https://mail.example.test\nacct-1").digest("base64url"));
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("the other app, as the page knows it", () => {
  function bridgeDouble(answers: Record<string, unknown>) {
    const listeners = new Set<(e: ShellEvent) => void>();
    const asked: [string, unknown][] = [];
    const bridge = {
      request: async (kind: string, ask: unknown) => (asked.push([kind, ask]), answers[kind]),
      on: (handle: (e: ShellEvent) => void) => (listeners.add(handle), () => listeners.delete(handle)),
    } as unknown as Bridge;
    const send = (e: ShellEvent) => { for (const l of listeners) l(e); };
    return { bridge, asked, send };
  }

  it("names the other product and follows native's readings of it", () => {
    const { bridge, send } = bridgeDouble({});
    const door = otherAppDoor(bridge, { app: "ohmail", other: "here" });
    let told = 0;
    door.state.subscribe(() => { told += 1; });
    expect([door.product, door.state.read()]).toEqual(["ohcal", "here"]);
    send({ type: "other", state: "absent" });
    send({ type: "other", state: "absent" });
    expect([door.state.read(), told]).toEqual(["absent", 1]);
    expect(otherAppDoor(bridge, { app: "ohcal", other: "unknown" }).product).toBe("ohmail");
  });

  it("asks native to open it and reads a press no app took as absent; asks for its store page", async () => {
    const { bridge, asked } = bridgeDouble({ "switch.open": { went: "absent" }, "switch.store": { opened: true } });
    const door = otherAppDoor(bridge, { app: "ohcal", other: "unknown" });
    expect(await door.open({ to: "message", id: ID })).toBe("absent");
    expect(door.state.read()).toBe("absent");
    expect(await door.get()).toBe(true);
    expect(asked).toEqual([["switch.open", { to: { to: "message", id: ID } }], ["switch.store", {}]]);
  });
});
