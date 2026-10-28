/**
 * "APPLY ON ALL DEVICES" FOR THE APPEARANCE FACE — the wire it travels on, and the two races
 * that decide what the phone shows afterwards.
 *
 * OHMARCHY-PLAN.md §3a gives the face two scopes: a DEVICE pin (local, instant, no server) and
 * the ACCOUNT's synced choice, which is one field on the consent row. This file holds the
 * account half end to end:
 *
 *  · **THE WIRE** (`src/net/consent.ts`, against the loopback fake): the write names ONE axis,
 *    the read carries the field back, `paper` and "no preference" stay different answers, a
 *    server too old to store a face reads as "no preference", and a refusal throws rather than
 *    reporting a face nobody stored.
 *  · **THE ECHO** — what the phone shows is what the ACCOUNT holds, never the argument sent. The
 *    fake can accept a write and store nothing (`declineFaceWrites`), which is the only
 *    configuration in which that discipline is observable at all: a server that always stores
 *    what it is told is satisfied identically by a client that echoes itself.
 *  · **THE RACES** (`src/state/face-scope.ts`): a consent read resolving AFTER a press must not
 *    publish the pre-write face, a read that merely OVERLAPS a write is refused whatever it
 *    answers (it may have seen the pre-write row and no client-side stamp can tell), and two
 *    overlapping reads must settle in issue order — the rules `folders-flag.ts` arrived at from
 *    measured defects, applied to a value that has a user act behind it.
 *  · **THE PIN** — released only on a CONFIRMED write, and only the pin the press was made
 *    under; a refusal leaves this device pinned to the face it is showing.
 *
 * MUTATIONS RUN AND RESTORED (each named at its test):
 *  · `applyAll` returning the ARGUMENT instead of `deps.write`'s value → the echo test goes red;
 *  · `applyAll` not bumping the epoch → the user-wins test goes red;
 *  · dropping the unsettled-write barrier → the mid-PATCH read test goes red;
 *  · decrementing `unsettled` on the success path rather than in `finally` → the refusal-lifts-
 *    the-barrier test goes red;
 *  · releasing the pin unconditionally → the newer-choice test goes red;
 *  · `beginRead`'s applier accepting `undefined` → the could-not-ask test goes red;
 *  · `beginRead` dropping the `mine <= appliedSeq` guard → the out-of-order test goes red;
 *  · `clearPin()` moved out of the try (or before the write) → the refusal test goes red;
 *  · `writeThemeFace` sending the whole settings object → the one-axis test goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { readFoldersEnabled, writeThemeFace } from "../src/net/consent";
import type { ConnectedSession } from "../src/net/pairing";
import {
  accountFaceShown, faceMirrorStands, faceMirrorStore, faceScope, FACE_MIRROR_KEY, type FaceMirror,
} from "../src/state/face-scope";
import type { SecureKV } from "../src/state/servers";
import { resolveFace, type FaceName } from "../src/theme/face";
import { listen, mailServer } from "./helpers/mail-server";

/** A minimal session for the consent seam: ONE origin, a plain fetch — the seam needs no more. */
function sessionFor(origin: string): ConnectedSession {
  return {
    profile: { origin },
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
}

/** A promise a test settles by hand — the only way to hold a request in the air deliberately. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A scope over recording deps — what was adopted, and which submitted face the release was asked
 * for. `state.pin` models the DEVICE pin the world layer holds, and the release applies that
 * layer's rule (only a pin that still equals the submitted face, or none), so the
 * newer-choice-while-the-PATCH-flew case can be DRIVEN here rather than described.
 */
function scopeWith(write: (face: FaceName) => Promise<FaceName | null>) {
  const adopted: (FaceName | null)[] = [];
  const submitted: FaceName[] = [];
  const state: { pin: FaceName | null } = { pin: null };
  const scope = faceScope({
    write,
    adopt: (face) => adopted.push(face),
    clearPin: (face) => {
      submitted.push(face);
      if (state.pin === face || state.pin === null) state.pin = null;
    },
    pin: () => state.pin,
    setPin: (face) => { state.pin = face; },
    remember: () => {},
    follows: false,
  });
  return { scope, adopted, submitted, state };
}

/** A keystore in memory; a relaunch is a new phone over the same rows. */
function memoryKV(): SecureKV & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => { rows.set(key, value); },
    remove: async (key) => { rows.delete(key); },
  };
}

/**
 * One phone on the real wire: its pin, the account face it adopted, the account look it keeps
 * for the next launch (wired as `world.tsx` does), and what it shows.
 */
function phoneOn(origin: string, follows = true, kv: SecureKV = memoryKV(), owner = "account-1") {
  const session = sessionFor(origin);
  const state: { pin: FaceName | null; account: FaceName | null; known: boolean; mirror: FaceMirror | null } =
    { pin: null, account: null, known: false, mirror: null };
  const mirror = faceMirrorStore(kv, (m) => { state.mirror = m; });
  const scope = faceScope({
    write: (face) => writeThemeFace(session, face),
    adopt: (face) => { state.account = face; state.known = true; },
    clearPin: (face) => { if (state.pin === face || state.pin === null) state.pin = null; },
    pin: () => state.pin,
    setPin: (face) => { state.pin = face; },
    remember: (face) => mirror.set(face === null ? null : { owner, face }),
    follows,
  });
  /** The consent read the phone makes at start and after every drain (the settings doorbell). */
  const read = async () => {
    const apply = scope.beginRead();
    const ans = await readFoldersEnabled(session);
    apply(ans === null ? undefined : ans.themeFace);
  };
  /** What the phone wears; `signedIn` false is the launch before its session is live. */
  const shows = (signedIn = true) =>
    resolveFace(state.pin, accountFaceShown(state.account, state.known, state.mirror, signedIn ? owner : null));
  return { scope, state, read, shows, boot: () => mirror.boot() };
}

/* ────────────────────────────────────────────────────────────────────────────── the wire */

describe("the face travels on PATCH /consent/settings, one axis, echo back", () => {
  it("writes the face to the account and answers what the ACCOUNT stored", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const session = sessionFor(origin);

    // Nothing chosen: the field is absent on this fake's default wire, which is a server too old
    // to store a face — and reads as "no preference", never as paper.
    expect((await readFoldersEnabled(session))!.themeFace).toBeNull();

    expect(await writeThemeFace(session, "ohmarchy")).toBe("ohmarchy");
    expect(fake.themeFace(), "the account row holds it").toBe("ohmarchy");
    // …and it TRAVELS: the next read of the same row carries it back, which is how a face chosen
    // on this phone reaches a laptop and vice versa.
    expect((await readFoldersEnabled(session))!.themeFace).toBe("ohmarchy");

    /* `paper` IS STORED, never collapsed to null. The two are different answers — "no
       preference" may be overridden by a later account write, "asked for paper" may not — and
       the service keeps them apart deliberately (`setThemeFace`). */
    expect(await writeThemeFace(session, "paper")).toBe("paper");
    expect(fake.themeFace()).toBe("paper");
    expect((await readFoldersEnabled(session))!.themeFace).toBe("paper");
    fake.server.close();
  });

  it("names ONE axis, so it cannot overwrite a setting it does not own", async () => {
    /* Mutation: send `{ themeFace, foldersEnabled: false }` → this fails, and so would the
       account's real folders flag on any phone that pressed the face control. The route tests
       presence with `in`, which is exactly why one-axis bodies are safe to share a row. */
    const fake = mailServer();
    const origin = await listen(fake.server);
    const session = sessionFor(origin);
    fake.setFoldersEnabledAt(new Date().toISOString());

    await writeThemeFace(session, "ohmarchy");

    const patch = [...fake.seen].reverse().find((r) => r.url === "/consent/settings")!;
    expect(patch.method).toBe("PATCH");
    expect(JSON.parse(patch.body)).toEqual({ themeFace: "ohmarchy" });
    // The folders flag the face write shares a row with is untouched.
    expect(fake.foldersOn()).toBe(true);
    fake.server.close();
  });

  it("shows the ACCOUNT's answer even when it disagrees with the press", async () => {
    /* THE DIRECTION THAT MATTERS. The account accepts the request and leaves the row as it was —
       a policy this client cannot see, answered 200, so there is no error to catch. The only
       thing separating "the account adopted ohmarchy" from "it did not" is whether the caller
       reads the echo. */
    const fake = mailServer();
    const origin = await listen(fake.server);
    const session = sessionFor(origin);
    fake.declineFaceWrites(true);

    expect(await writeThemeFace(session, "ohmarchy")).toBeNull();
    expect(fake.themeFace(), "the account really stored nothing").toBeUndefined();
    fake.server.close();
  });

  it("a refusal throws, and a face this build cannot draw reads as no preference", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.failNext("PATCH", "/consent/settings");
    await expect(writeThemeFace(sessionFor(origin), "ohmarchy")).rejects.toThrow();
    expect(fake.themeFace()).toBeUndefined();

    // A value from the future (an account that adopted a face a later build introduced): the
    // read keeps working and reports no preference, rather than throwing the whole answer — the
    // other two fields on it are unaffected by a face nobody here can paint.
    fake.setThemeFace("tokyo-night");
    const ans = (await readFoldersEnabled(sessionFor(origin)))!;
    expect(ans.themeFace).toBeNull();
    expect(ans.signatures).toEqual({});
    fake.server.close();
  });

  it("a dead port is could-not-ask, which is not an answer about the face either", async () => {
    expect(await readFoldersEnabled(sessionFor("http://127.0.0.1:1"))).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────── the scope machine */

describe("faceScope: the echo is adopted and the pin released, on success only", () => {
  it("adopts what the write answered — not what was asked for — then releases the pin", async () => {
    /* Mutation: `deps.adopt(face)` (the argument) instead of `deps.adopt(stored)` → red, because
       the write here deliberately answers something else. */
    const { scope, adopted, submitted } = scopeWith(async () => "paper");
    expect(await scope.applyAll("ohmarchy")).toBe(true);
    expect(adopted).toEqual(["paper"]);
    expect(submitted).toEqual(["ohmarchy"]);
  });

  it("a REFUSED write adopts nothing and leaves this device pinned", async () => {
    /* Mutation: move `clearPin()` above the await, or out of the try → red. A pin dropped on a
       refusal hands the device to an account answer nobody stored. */
    const { scope, adopted, submitted } = scopeWith(async () => {
      throw new Error("refused");
    });
    expect(await scope.applyAll("ohmarchy")).toBe(false);
    expect(adopted).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it("RELEASES ONLY THE PIN THE PRESS WAS MADE UNDER — a newer choice survives", async () => {
    /**
     * Review-caught. The selector stays live while the PATCH flies: press apply-all for ohmarchy,
     * then pick paper before the answer lands. An unconditional release erases that paper pin and
     * hands the device back to the stored ohmarchy — the device-pin-first rule broken by its own
     * scope change.
     *
     * Mutation: `deps.clearPin()` with no argument, and the release made unconditional → this
     * goes red; the plain-success case above stays green, which is why this needed its own.
     */
    const gate = deferred<FaceName | null>();
    const { scope, state, submitted } = scopeWith(() => gate.promise);
    state.pin = "ohmarchy";
    const press = scope.applyAll("ohmarchy");
    state.pin = "paper"; // a newer device choice, made while the PATCH flew
    gate.resolve("ohmarchy");
    expect(await press).toBe(true);
    expect(submitted, "the release names the face the press submitted").toEqual(["ohmarchy"]);
    expect(state.pin, "the newer pin stands — this write knew nothing about it").toBe("paper");
  });

  it("…and DOES release the pin the press submitted, so the account really takes over", async () => {
    // The other half: without this, the guard above could be satisfied by never releasing at all.
    const { scope, state } = scopeWith(async () => "ohmarchy");
    state.pin = "ohmarchy";
    expect(await scope.applyAll("ohmarchy")).toBe(true);
    expect(state.pin).toBeNull();
  });

  it("an account with no preference is adopted as null, which clears the adopted value", async () => {
    // Adopting null is the point, not an else-arm smell: an account whose choice went away must
    // stop skinning this device, rather than leaving a stale copy in charge.
    const { scope, adopted } = scopeWith(async () => null);
    expect(await scope.applyAll("paper")).toBe(true);
    expect(adopted).toEqual([null]);
  });
});

describe("faceScope: the user wins, and reads settle in issue order", () => {
  it("a read ISSUED before a press applies nothing, however it answers", async () => {
    /**
     * THE MEASURED SHAPE, ported: a session's boot `GET /consent` resolving after the press left
     * the account ohmarchy and the phone paper for the rest of the session (folders-flag.ts's
     * round 1). Mutation: remove the `epoch += 1` from `applyAll` → red.
     */
    const { scope, adopted } = scopeWith(async () => "ohmarchy");

    const applyStale = scope.beginRead(); // the boot read goes out…
    await scope.applyAll("ohmarchy"); // …the user presses while it is in the air…
    applyStale("paper"); // …and it answers the PRE-write value.

    expect(adopted, "the stale read published nothing").toEqual(["ohmarchy"]);
  });

  it("a read issued after the write SETTLED does apply — the barrier is not permanent", async () => {
    const { scope, adopted } = scopeWith(async () => "ohmarchy");
    await scope.applyAll("ohmarchy");
    scope.beginRead()("paper"); // the account was changed on a laptop; this read is the newer fact
    expect(adopted).toEqual(["ohmarchy", "paper"]);
  });

  it("NO READ MAY OVERLAP A WRITE — one issued mid-PATCH is refused, epoch or no epoch", async () => {
    /**
     * Review-caught, and the epoch alone did not give this. A drain completing during the write
     * issues a read AFTER the epoch bump, so it carries the new epoch; it may still have observed
     * the pre-PATCH row, and landing after the echo it would revert the account face — with the
     * pin already released, leaving the device wearing a face nobody chose.
     *
     * Mutation: drop the `busyAtIssue || unsettled > 0` clause → this goes red while every other
     * ordering case here stays green.
     */
    const gate = deferred<FaceName | null>();
    const { scope, adopted } = scopeWith(() => gate.promise);
    const press = scope.applyAll("ohmarchy");
    const midWrite = scope.beginRead(); // issued while the PATCH is unsettled
    gate.resolve("ohmarchy");
    expect(await press).toBe(true);
    midWrite("paper"); // …and answers the row as it was before the write
    expect(adopted, "only the write's echo published").toEqual(["ohmarchy"]);
  });

  it("a refused write LIFTS the barrier too — the session is not deafened for ever", async () => {
    /* Mutation: decrement `unsettled` on the success path instead of in `finally` → red. A
       refusal that left the barrier standing would refuse every later read of the session. */
    const { scope, adopted } = scopeWith(async () => {
      throw new Error("refused");
    });
    expect(await scope.applyAll("ohmarchy")).toBe(false);
    scope.beginRead()("ohmarchy");
    expect(adopted).toEqual(["ohmarchy"]);
  });

  it("two overlapping reads settle in ISSUE order — an older answer landing last is dropped", async () => {
    /* Mutation: drop the `mine <= appliedSeq` guard → red. Both reads are valid answers here;
       what makes one wrong is only that it was asked for first. */
    const { scope, adopted } = scopeWith(async () => null);
    const first = scope.beginRead();
    const second = scope.beginRead();
    second("ohmarchy"); // the newer read answers first
    first("paper"); // the older one lands afterwards and must be ignored
    expect(adopted).toEqual(["ohmarchy"]);
  });

  it("COULD-NOT-ASK is not an answer: it applies nothing and supersedes nothing", async () => {
    /**
     * The folders machine's round-3 rule. Mutation: let the applier treat `undefined` as `null`
     * → the first assertion goes red (a failed read would clear the account's adopted face);
     * mutation: let `undefined` claim `appliedSeq` → the second goes red (a failed newer read
     * would discard the only valid answer the session had).
     */
    const { scope, adopted } = scopeWith(async () => null);
    const older = scope.beginRead();
    const newer = scope.beginRead();
    newer(undefined); // the newer read failed
    older("ohmarchy"); // …so the older, VALID answer must still apply
    expect(adopted).toEqual(["ohmarchy"]);

    scope.beginRead()(undefined);
    expect(adopted, "a failed read never publishes").toEqual(["ohmarchy"]);
  });

  it("a write in flight already invalidates the reads that preceded it", async () => {
    // The epoch bumps BEFORE the request goes out, so the guard holds while the write is still
    // unsettled — not merely after it lands.
    const gate = deferred<FaceName | null>();
    const { scope, adopted } = scopeWith(() => gate.promise);
    const applyStale = scope.beginRead();
    const press = scope.applyAll("ohmarchy");
    applyStale("paper"); // lands while the PATCH is still on the wire
    expect(adopted).toEqual([]);
    gate.resolve("ohmarchy");
    expect(await press).toBe(true);
    expect(adopted).toEqual(["ohmarchy"]);
  });
});

describe("the phone follows the account's look, as the web and the desktop do", () => {
  it("two phones of one account: the newest choice wins on both, and an old pin retires", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const a = phoneOn(origin);
    const b = phoneOn(origin);
    a.state.pin = "paper"; // left by an earlier build's "this device only" control
    await a.read();
    await b.read();
    expect(a.shows(), "no account look yet: the old pin still decides").toBe("paper");

    expect(await b.scope.choose("ohmarchy")).toBe(true);
    expect(fake.themeFace(), "the choice is written to the account").toBe("ohmarchy");
    expect(b.state.pin, "and leaves no pin behind").toBeNull();
    expect(b.shows()).toBe("ohmarchy");

    await a.read(); // start, or the drain after the settings doorbell
    expect(a.state.pin, "the account holds a look, so the old pin retires").toBeNull();
    expect(a.shows()).toBe("ohmarchy");

    expect(await a.scope.choose("paper")).toBe(true);
    await b.read();
    expect(b.shows(), "and back the other way").toBe("paper");
    expect(a.shows()).toBe("paper");
    fake.server.close();
  });

  it("a press before the account answered shows at once and is written on the first read", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.setThemeFace("paper");
    const a = phoneOn(origin);
    expect(await a.scope.choose("ohmarchy")).toBe(true);
    expect(a.shows()).toBe("ohmarchy");
    expect(fake.themeFace(), "nothing is written before the account's look is known").toBe("paper");
    await a.read();
    await vi.waitFor(() => expect(fake.themeFace()).toBe("ohmarchy"));
    await vi.waitFor(() => expect(a.state.pin).toBeNull());
    expect(a.shows()).toBe("ohmarchy");
    fake.server.close();
  });

  it("a refused choice stays this phone's pin, and the next read does not take it away", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.setThemeFace("paper");
    const a = phoneOn(origin);
    await a.read();
    fake.failNext("PATCH", "/consent/settings");
    expect(await a.scope.choose("ohmarchy")).toBe(false);
    expect(a.state.pin).toBe("ohmarchy");
    await a.read();
    expect(a.shows(), "the person's press is not undone behind their back").toBe("ohmarchy");
    // A later choice that the account takes governs again.
    expect(await a.scope.choose("paper")).toBe(true);
    expect(a.state.pin).toBeNull();
    fake.server.close();
  });

  it("a standalone phone keeps its own pin: a choice writes nothing and no read retires it", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.setThemeFace("ohmarchy");
    const solo = phoneOn(origin, false);
    expect(await solo.scope.choose("paper")).toBe(true);
    await solo.read();
    expect(solo.state.pin).toBe("paper");
    expect(solo.shows()).toBe("paper");
    expect(fake.seen.some((r) => r.method === "PATCH"), "no account write").toBe(false);
    fake.server.close();
  });
});

describe("a relaunch wears the account's last look, before any read and offline", () => {
  it("a signed-in choice comes back on the first frame, and stays when the server is away", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const kv = memoryKV();
    const a = phoneOn(origin, true, kv);
    await a.boot();
    await a.read();
    expect(await a.scope.choose("ohmarchy")).toBe(true);
    expect(a.state.pin, "the account holds it, so no pin is left").toBeNull();
    fake.server.close();

    const again = phoneOn(origin, true, kv); // the cold start: only what the keystore kept
    await again.boot();
    expect(again.shows(false), "the first frame, before the session is live").toBe("ohmarchy");
    expect(again.shows(), "the session up, its read not back").toBe("ohmarchy");
    await again.read(); // could not ask
    expect(again.shows(), "a failed read leaves it").toBe("ohmarchy");
  });

  it("the account's answer replaces the kept look, and 'no preference' clears it", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const kv = memoryKV();
    fake.setThemeFace("ohmarchy");
    const a = phoneOn(origin, true, kv);
    await a.read();
    expect(JSON.parse(kv.rows.get(FACE_MIRROR_KEY)!)).toEqual({ owner: "account-1", face: "ohmarchy" });

    fake.setThemeFace("paper"); // changed on a laptop
    await a.read();
    const b = phoneOn(origin, true, kv);
    await b.boot();
    expect(b.shows(false)).toBe("paper");
    expect(b.state.mirror?.face).toBe("paper");

    fake.setThemeFace(null);
    await a.read();
    expect(kv.rows.has(FACE_MIRROR_KEY)).toBe(false);
    fake.server.close();
  });

  it("another account's kept look is not worn, and a standalone phone keeps none", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const kv = memoryKV();
    fake.setThemeFace("ohmarchy");
    await phoneOn(origin, true, kv).read();
    const other = phoneOn(origin, true, kv, "account-2");
    await other.boot();
    expect(other.shows(), "account 2 signed in, its read not back").toBe("paper");

    const soloKV = memoryKV();
    await phoneOn(origin, false, soloKV).read();
    expect(soloKV.rows.size, "the standalone door writes no account look").toBe(0);
    fake.server.close();
  });

  it("the kept look goes on sign-out, a mid-use end, another account or the standalone door", () => {
    const kept: FaceMirror = { owner: "account-1", face: "ohmarchy" };
    const live = (ownerKey: string, standalone = false) => ({ k: "live" as const, session: { ownerKey, standalone } });
    expect(faceMirrorStands(kept, { k: "starting" })).toBe(true);
    expect(faceMirrorStands(kept, { k: "connecting" })).toBe(true);
    expect(faceMirrorStands(kept, live("account-1"))).toBe(true);
    expect(faceMirrorStands(kept, { k: "idle" })).toBe(false);
    expect(faceMirrorStands(kept, { k: "ended" })).toBe(false);
    expect(faceMirrorStands(kept, live("account-2"))).toBe(false);
    expect(faceMirrorStands(kept, live("account-1", true))).toBe(false);
  });

  it("a look adopted before the keystore answered is not overwritten by the older row", async () => {
    let answer: (raw: string | null) => void = () => {};
    const held = new Promise<string | null>((resolve) => { answer = resolve; });
    const seen: (FaceMirror | null)[] = [];
    const store = faceMirrorStore(
      { get: () => held, set: async () => {}, remove: async () => {} },
      (m) => seen.push(m),
    );
    const booting = store.boot();
    store.set({ owner: "account-1", face: "paper" });
    answer(JSON.stringify({ owner: "account-1", face: "ohmarchy" }));
    await booting;
    expect(seen).toEqual([{ owner: "account-1", face: "paper" }]);
  });
});
