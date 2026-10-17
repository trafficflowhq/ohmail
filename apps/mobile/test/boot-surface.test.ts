/**
 * BOOT-FROM-LOCAL AND THE UNKNOWN≠EMPTY RULE — the state transitions the screens render, held
 * where the screens cannot hold them (they stay logic-free):
 *
 *  · `listSurface` (`src/state/surface.ts`) — a zero-row list over an unsettled mirror is a
 *    SKELETON, never the empty state. The mutant this suite exists to kill is the one-line
 *    conflation that renders "Nothing here" during the unknown state.
 *  · `mirrorSettled` (`src/state/live.ts`) — false on a first-ever boot, true the moment the
 *    first drain completes, and STILL true when the mirror is reopened with no adapter and no
 *    network — which is the warm relaunch: content in the first frame, wire unasked.
 *
 * Driven through the same `bootEngine` composition the app runs, against the loopback mail
 * server, exactly as `live-screens.test.ts` drives the world.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LAST_DRAIN_AT_META, SqlMirrorStore, mirrorDbName } from "@ohmail/client-engine";
import { bootEngine, mirrorOwnerKey, type MobileEngineDeps } from "../src/engine/boot";
import {
  RECONNECT_PROMISE_MS, connectionSaid, connectionSay, mirrorSettled, staleAsOf, staleSaid,
} from "../src/state/live";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { Copy } from "../src/copy";
import { listSurface, metaWhen } from "../src/state/surface";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: () => "00000000-0000-4000-8000-000000000000",
};

describe("the provider sequences verify → drain (held at the source; no node renderer drives hooks)", () => {
  // The engine-level clearance (engine-boot.test.ts) makes a wrong sequence LOUD; these pins
  // keep the provider from ever being that wrong sequence. Prior art: folders-parity.test.ts.
  const connection = readFileSync(fileURLToPath(new URL("../src/net/connection.tsx", import.meta.url)), "utf8");
  it("the first drain starts only inside the clearance continuation", () => {
    expect(connection).toMatch(/clearance\.current\.set\(session, gate\);\s*void gate\.then\(\(ok\) => \{\s*if \(ok\) void drain\(session, true\);/);
    // And nothing kicks a drain at adoption time outside it.
    expect(connection).not.toMatch(/setState\(\{ k: "live", session \}\);\s*void drain\(/);
  });
  it("runConnect keeps the disown edge and the departure from live in ONE commit", () => {
    // The keystore read precedes the teardown: with an await between the disown's falling
    // busy edge and the state change, the world layer would read "drain completed" while the
    // OUTGOING session was still on screen and restart work against its closing store.
    /* RE-DERIVED to the decided state's spelling, and the invariant is untouched: the keystore
       read, then the teardown, with NOTHING between them. `live.current` was a ref written when
       React painted — a staleness check against it read `connecting` on the standalone door and
       skipped the teardown of the OUTGOING session (`src/net/decided.ts` carries the device
       measurement). The read is now `live.now()`, bound once because two calls are two values. */
    expect(connection).toMatch(
      /const row = \(await env\.profiles\.list\(\)\)\.find\(\(p\) => p\.id === id\);\s*\{ const at = live\.now\(\); if \(at\.k === "live"\) teardown\(at\.session\); \}/,
    );
  });
  it("the drain cadence starts in the same continuation, for the session it cleared; its teardown stops it", () => {
    expect(connection).toMatch(
      /if \(ok\) void drain\(session, true\);[\s\S]{0,400}?if \(!ok \|\| atCadence\.k !== "live" \|\| atCadence\.session !== session\) return;[\s\S]{0,160}?stop: keepDraining\(\{\s*lifecycle: appLifecycle,/,
    );
    expect(connection).toMatch(/if \(cadence\.current\?\.session === session\) \{\s*cadence\.current\.stop\(\);/);
    // The lifecycle is React Native's own AppState, nothing derived.
    expect(connection).toMatch(/now: \(\) => AppState\.currentState,/);
  });
  it("syncNow rides the same clearance — a pull cannot race the verdict", () => {
    expect(connection).toMatch(/const gate = clearance\.current\.get\(session\) \?\? Promise\.resolve\(false\);/);
    // The pull affordance grew a doorbell (requestPull) ahead of the drain; BOTH must sit
    // INSIDE the clearance continuation, behind the same guard — the doorbell must not ring
    // for a session whose verdict refused any more than the drain may move its mirror. A
    // wildcard match would cross the continuation's closing brace (review-caught), so the
    // callback BODY is extracted by balanced braces and the order guard → ring → drain is
    // asserted within it and nowhere else.
    // Two continuations chain on the gate (the adopt path and syncNow); anchor on syncNow's.
    const syncNowAt = connection.indexOf("syncNow: () =>");
    expect(syncNowAt, "syncNow left the connection layer").toBeGreaterThan(-1);
    const open = connection.indexOf("gate.then((ok) => {", syncNowAt);
    expect(open, "syncNow no longer chains on the clearance gate").toBeGreaterThan(-1);
    const start = connection.indexOf("{", open);
    let depth = 0;
    let end = -1;
    for (let i = start; i < connection.length; i++) {
      if (connection[i] === "{") depth++;
      else if (connection[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    expect(end, "the continuation's braces do not balance").toBeGreaterThan(start);
    const body = connection.slice(start + 1, end);
    /* THE SAME GUARD, in the decided state's spelling — see the note on the case above. It is two
       lines now because the read is bound once: `live.now()` answers a value, and narrowing across
       two calls is narrowing two different values. The ORDER this case exists for is unchanged. */
    const guardAt = body.indexOf(
      'const atDrain = live.now();\n          if (!ok || atDrain.k !== "live" || atDrain.session !== session) return;',
    );
    const ringAt = body.indexOf("const rang = session.engine.requestPull();");
    const drainAt = body.indexOf("const round = runner.request(session.engine);");
    expect(guardAt, "the verdict guard left the continuation").toBeGreaterThan(-1);
    expect(ringAt, "the doorbell left the continuation").toBeGreaterThan(guardAt);
    expect(drainAt, "the drain left the continuation").toBeGreaterThan(ringAt);
    // And the ring exists nowhere outside it: the continuation is its only caller.
    const outside = connection.slice(0, start) + connection.slice(end);
    expect(outside.includes("session.engine.requestPull()")).toBe(false);
  });
});

describe("listSurface: unknown is not empty, and empty is not unknown", () => {
  it("zero rows over an UNSETTLED mirror is a skeleton — the empty-state mutant goes red here", () => {
    // The load-bearing line: a screen that answered "empty" for the unknown state would show
    // "Nothing in your Ohbox" about mail the app has simply not read yet — the exact defect
    // the sync interim-state rule forbids. `skeleton` is the only truthful arm.
    expect(listSurface({ settled: false, count: 0 })).toBe("skeleton");
  });

  it("zero rows over a SETTLED mirror is the honest empty state — a forever-skeleton goes red here", () => {
    expect(listSurface({ settled: true, count: 0 })).toBe("empty");
  });

  it("rows always render — mid-bootstrap included: real mail beats a silhouette", () => {
    expect(listSurface({ settled: false, count: 3 })).toBe("content");
    expect(listSurface({ settled: true, count: 3 })).toBe("content");
  });

  it("the meta line is silenced over a skeleton — no invented counts", () => {
    expect(metaWhen("skeleton", "0 unread of 0")).toBeUndefined();
    expect(metaWhen("empty", "0 unread of 0")).toBe("0 unread of 0");
    expect(metaWhen("content", "2 unread of 5")).toBe("2 unread of 5");
  });
});

describe("mirrorSettled across the mirror's life", () => {
  it("false at first boot, true after the first drain — even a drain that found nothing", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
      expect(boot.kind).toBe("ready");
      if (boot.kind !== "ready") return;
      // First-ever launch, pre-drain: unknown. The Ohbox shows the skeleton, not "All quiet".
      expect(mirrorSettled(boot.store)).toBe(false);
      expect(listSurface({ settled: mirrorSettled(boot.store), count: 0 })).toBe("skeleton");

      await boot.verifyIdentity(); // the app's own sequence: the verdict opens the drain routes
      await boot.engine.start();
      // The drain completed over an EMPTY mailbox: settled, and only now may the empty state
      // speak. (Skeleton → empty-state is a legal transition; empty-state → content is not.)
      expect(mirrorSettled(boot.store)).toBe(true);
      expect(listSurface({ settled: mirrorSettled(boot.store), count: 0 })).toBe("empty");
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("survives kill+relaunch with NO adapter — the warm boot renders content, wire unasked", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const ownerKey = mirrorOwnerKey(origin, "acct-1");
    try {
      const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
      if (boot.kind !== "ready") throw new Error("boot refused");
      fake.addMessage(dto("m1", { subject: "Kept locally" }));
      await boot.verifyIdentity(); // the app's own sequence: the verdict opens the drain routes
      await boot.engine.start();
      expect(mirrorSettled(boot.store)).toBe(true);
      boot.store.close();
    } finally {
      fake.server.close(); // the server is GONE — everything below is the phone alone
    }

    // The relaunch: the mirror by itself, no adapter, no network anywhere in reach.
    const relaunched = new SqlMirrorStore({ owner: ownerKey, open: world.open });
    await relaunched.load();
    expect(world.names()).toContain(mirrorDbName(ownerKey));
    expect(relaunched.list("message")).toHaveLength(1);
    // The stamp persisted: the first frame of a warm boot is CONTENT, never a skeleton and
    // never a "connecting" hold — the whole point of boot-from-local.
    expect(mirrorSettled(relaunched)).toBe(true);
    expect(listSurface({ settled: mirrorSettled(relaunched), count: 1 })).toBe("content");
    relaunched.close();
  });

  it("a bootstrap killed MID-WAY relaunches unsettled — partial rows render, the stamp waits", async () => {
    // The cursor may have moved (pages committed) while the completion stamp has not landed:
    // that mirror is still UNKNOWN — rows render (content beats silhouette), but a zero-row
    // pile on it must keep the skeleton rather than claim emptiness a finished drain never
    // established.
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
      if (boot.kind !== "ready") throw new Error("boot refused");
      // No drain is run at all — the sharpest version of "the stamp has not landed".
      expect(mirrorSettled(boot.store)).toBe(false);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/**
 * ═══ "AS OF <TIME> · CATCHING UP" — the Freshness Contract's middle state (INSTANT-ARCH §6.6) ═
 *
 * `mirrorSettled` separates unknown from settled; `staleAsOf` separates settled-and-current
 * from settled-and-STALE — a mirror whose last completed drain is days old renders instantly
 * and the chrome says how old, until a drain settles. The engine's `freshness()` is the one
 * derivation (the same stamp and threshold its stale-resume freshen reads), so this surface
 * cannot disagree with the webapp's strip about what stale means.
 *
 * Watched RED, then restored:
 *  · stale-shown-as-current — `staleAsOf` returning null for a stale verdict: the aged-stamp
 *    guard fails.
 *  · label-stuck-after-current — dropping the `state === "stale"` narrowing (labeling every
 *    settled mirror): the settled guard and the post-drain guard fail.
 *  · wiring dropped — removing the `staleAsOf` derivation from `world.tsx` or the render from
 *    `chrome.tsx`: the source pins fail (the house idiom where no node renderer drives hooks).
 */
describe("staleSaid: 'catching up' is said only while a round is in flight", () => {
  // Watched RED: a label keyed on age alone (the shipped rule) fails the idle case.
  it("in flight: the activity; settled or failed with nothing running: the age alone", () => {
    expect(staleSaid("Fri 09:00", true)).toBe(Copy.staleAsOf("Fri 09:00"));
    expect(staleSaid("Fri 09:00", false)).toBe(Copy.staleAsOfIdle("Fri 09:00"));
    expect(staleSaid("Fri 09:00", false)).not.toBe(Copy.staleAsOf("Fri 09:00"));
  });
});

describe("staleAsOf across the mirror's life", () => {
  it("null while current, the labeled time once the stamp ages, null again at the settle", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
      if (boot.kind !== "ready") throw new Error("boot refused");
      await boot.verifyIdentity();
      await boot.engine.start();
      // A drain just settled: current, no label owed.
      expect(staleAsOf(boot.engine, "UTC", new Date())).toBeNull();

      // The stamp ages three days — the phone in a drawer over a long weekend.
      const aged = new Date(Date.now() - 3 * 24 * 60 * 60_000);
      await boot.store.setMeta(LAST_DRAIN_AT_META, aged.toISOString());
      const label = staleAsOf(boot.engine, "UTC", new Date());
      expect(label, "a stale mirror owed a label and got none").not.toBeNull();
      // Sentence-ready, `setTimeLabel`'s shape inside the week ("Fri 09:00") in the reader's zone.
      expect(label).toMatch(/^\p{L}+ \d{2}:\d{2}$/u);

      // A drain settles: the stamp is re-written and the label clears in the same verdict.
      await boot.engine.syncOnce();
      expect(staleAsOf(boot.engine, "UTC", new Date()), "the label outlived the catch-up").toBeNull();
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("null over a mirror that has NEVER settled — unknown is the skeleton's, not the label's", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
      if (boot.kind !== "ready") throw new Error("boot refused");
      expect(mirrorSettled(boot.store)).toBe(false);
      expect(staleAsOf(boot.engine, "UTC", new Date())).toBeNull();
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  // The wiring, pinned at the source — the file's own idiom for seams no node renderer drives.
  it("the world derives it beside the settled stamp, and the chrome renders it in the shared bar", () => {
    const world = readFileSync(fileURLToPath(new URL("../src/state/world.tsx", import.meta.url)), "utf8");
    expect(world, "world.tsx no longer derives boot.staleAsOf from the engine's verdict")
      .toMatch(/staleAsOf: staleAsOf\(engine, zone, new Date\(\)\)/);
    const chrome = readFileSync(fileURLToPath(new URL("../src/ui/chrome.tsx", import.meta.url)), "utf8");
    const live = readFileSync(fileURLToPath(new URL("../src/state/live.ts", import.meta.url)), "utf8");
    /* The shared TopBar renders ONE ranked line, `live.ts#topLineSaid`, handed the world's label
       and its busy flag; the ranking says the label through `staleSaid`. */
    expect(chrome, "the shared TopBar no longer renders the label — a view can only speak about itself")
      .toMatch(/topLineSaid\(\{[\s\S]*?stale: boot\.staleAsOf,[\s\S]*?draining: boot\.draining,[\s\S]*?\}\);/);
    expect(chrome).toContain("{line.text}");
    expect(live, "the ranking no longer says the freshness label")
      .toMatch(/if \(o\.stale !== null\) return \{ text: staleSaid\(o\.stale, o\.draining\)/);
    // "Catching up" is an activity claim: the chrome says it only while a round is in flight, and
    // the world hands it the connection's own busy flag. The appearing direction has a clock — the
    // memo's deps carry `freshBeat`, ticked when the engine's verdict changes by time alone.
    expect(world, "the label's activity half no longer reads the connection's busy flag")
      .toMatch(/draining: conn\.syncing,/);
    /* IN THE MEMO'S DEPENDENCY ARRAY, wherever in it — the old pin required `freshBeat` to be
       the last name on its line, which is formatting, not the invariant, and a later name
       added beside it moved the pin without moving the fact. */
    expect(world, "current→stale is time's transition and the world memo has no clock for it")
      .toMatch(/\}, \[[^\]]*\bfreshBeat\b[^\]]*\]/);
    // The watcher compares the engine's LIVE verdict against what the world RENDERED — the
    // rendered value is the sentinel (rounds 2–4: no formatted-label ambiguity, no re-render
    // on a healthy drain's stamp churn, and no transition swallowed unrendered by a seed) —
    // at arm time and each minute.
    expect(world).toMatch(/const renderedStale = world\.boot\.staleAsOf;/);
    expect(world).toMatch(/const staleMoved = staleAsOf\(engine, zone, new Date\(\)\) !== renderedStale;/);
    /* The deps and the bump moved when the CONNECTION verdict joined this watcher — one effect,
       one beat, both sentinels. Pinned in the case that owns that addition, below. */
    expect(world).toMatch(/if \(staleMoved \|\| connMoved\) setFreshBeat/);
    /* AND THE SESSION'S OWN DOOR IS THE FOURTH DEP — a BOOLEAN, because the world object is fresh
       per derivation and depending on it would re-subscribe this watcher every render. */
    expect(world).toMatch(/\}, \[engine, zone, renderedStale, renderedConnection, rendersOwnDoor\]\);/);
  });
});

/**
 * ═══ "CONNECTION LOST" — the sentence the phone never said (owner ruling, 2026-09-11) ════════
 *
 * Device run 2 measured 2 min 27 s with the mail server unreachable and then restored, and the
 * only thing any screen said for the whole of it was `As of 19:42 · catching up`: true, and
 * useless. The engine had the facts all along — `reachable`, `unreachableSince`, `signInRefused`
 * per mailbox — and the app's own interface for the door dropped that half of `runtimes()`.
 *
 * `connectionSay` ranks the facts; `connectionSaid` words the verdict. Two functions because the
 * ranking is what a test can drive and the wording is what two surfaces must share.
 *
 * Watched RED, then restored:
 *  · the `refused` arm removed (a rejected sign-in falling through to `lost`) — the refusal case
 *    fails: the phone promises a reconnect nothing is attempting;
 *  · `reachable === null` read as unreachable — the before-the-first-cycle case fails with
 *    "Connection lost" a second after the mailbox opened;
 *  · the five-minute cutline inverted — both clock cases fail, in opposite directions;
 *  · the shared `connectionSaid` inlined back into one surface — the source pins fail.
 */
describe("connectionSay — the engine's connection facts, ranked", () => {
  const ZURICH = "Europe/Zurich";
  const NOW = new Date("2026-09-11T20:00:00.000Z");
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

  it("says NOTHING where nothing has answered — no door, and a door before its first cycle", () => {
    /* The two absences that are not states. A paired session holds no door at all; a door whose
       engine has not run a cycle has an empty map. Rendering either as an outage would put
       "Connection lost" on screen the second after somebody's mailbox opened. */
    expect(connectionSay(null, NOW, ZURICH)).toBeNull();
    expect(connectionSay(
      { reachable: null, unreachableSince: null, signInRefused: false }, NOW, ZURICH,
    )).toBeNull();
    expect(connectionSaid(null)).toBeNull();
  });

  it("says nothing while the link is up — the positive control for every arm below", () => {
    const verdict = connectionSay(
      { reachable: true, unreachableSince: null, signInRefused: false }, NOW, ZURICH,
    );
    expect(verdict).toEqual({ kind: "reachable" });
    expect(connectionSaid(verdict), "a healthy link put a sentence on screen").toBeNull();
  });

  it("HELD WRITE-OFFS over a link that is up are said, never the healthy silence", () => {
    /* The local backstop: messages kept failing to save on this phone, so the engine stopped
       setting them aside and the folder waits. The server answers, so "reachable" would be the
       strip reading healthy over a mailbox whose mail has stopped (REVIEW-026-PHONE-ONE-MESSAGE-B L1). */
    const verdict = connectionSay(
      { reachable: true, unreachableSince: null, signInRefused: false, writeOffsHeld: true }, NOW, ZURICH,
    );
    expect(verdict).toEqual({ kind: "writeOffsHeld" });
    expect(connectionSaid(verdict)).toBe(Copy.connectionMailHeld);
    /* An outage is the truer cause where both hold: the link is named first. */
    expect(connectionSay(
      { reachable: false, unreachableSince: null, signInRefused: false, writeOffsHeld: true }, NOW, ZURICH,
    )).toEqual({ kind: "lost" });
  });

  it("a REFUSED SIGN-IN outranks the outage, and promises no reconnect", () => {
    /* Both flags are set on a refused sign-in — the server answered and the link is not usable —
       and the automatic re-dial is suspended entirely. So the `lost` arm would say
       "Reconnecting…" over a mailbox nothing is dialling, which is this repository's
       failure-looks-healthy shape with the words the other way round.
       IT IS NOW SAID RATHER THAN SILENT, and the claim that moved is only the second one: this
       state was silent because nothing on this phone could be done about it, and the verb beside
       it is what changed. The ranking — not the outage sentence — is what this case is about. */
    const verdict = connectionSay(
      { reachable: false, unreachableSince: ago(60_000), signInRefused: true }, NOW, ZURICH,
    );
    expect(verdict).toEqual({ kind: "refused" });
    expect(connectionSaid(verdict)).toBe(Copy.connectionSignInRefused);
    expect(connectionSaid(verdict)).not.toBe(Copy.connectionLost);
  });

  it("says it is reconnecting inside five minutes, in both languages", () => {
    const verdict = connectionSay(
      { reachable: false, unreachableSince: ago(90_000), signInRefused: false }, NOW, ZURICH,
    );
    expect(verdict).toEqual({ kind: "lost" });
    expect(connectionSaid(verdict)).toBe("Connection lost. Reconnecting…");
    setActiveLocale("de");
    try {
      expect(connectionSaid(verdict)).toBe("Verbindung verloren. Verbinde neu …");
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("stops promising a reconnect past five minutes, and names the time in the reader's zone", () => {
    /* THE LADDER NEVER RUNS OUT on a phone — its last step (60 s) repeats — so "the ladder is
       exhausted" is a condition that cannot arrive and the wall clock is the only honest
       trigger. Both sides of the cutline, so an inverted comparison fails in one direction or
       the other rather than passing by luck. */
    const inside = connectionSay(
      { reachable: false, unreachableSince: ago(RECONNECT_PROMISE_MS - 5_000), signInRefused: false },
      NOW, ZURICH,
    );
    expect(inside, "a four-minute outage stopped promising a reconnect").toEqual({ kind: "lost" });

    const past = connectionSay(
      { reachable: false, unreachableSince: ago(RECONNECT_PROMISE_MS + 5_000), signInRefused: false },
      NOW, ZURICH,
    );
    /* 19:54:55 UTC is 21:54 in Zurich — the READER's zone, like the stale label beside it — and
       the same day, so the clock alone, as every stamp reads today. */
    expect(past).toEqual({ kind: "gone", since: "21:54" });
    expect(connectionSaid(past)).toBe("Couldn't reconnect since 21:54");
    setActiveLocale("de");
    try {
      expect(connectionSaid(past)).toBe("Seit 21:54 keine Verbindung");
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("NO PASSWORD ON THIS PHONE outranks the outage arms, and promises no reconnect", () => {
    /* Nothing was dialled, so there is no observed death to name and nothing is retrying:
       "Reconnecting…" would be a promise nobody is keeping and an outage clock a duration with
       no start. The remedy is a person's, so the sentence carries it. */
    const verdict = connectionSay(
      { reachable: false, unreachableSince: null, signInRefused: false, needsCredential: true },
      NOW, ZURICH,
    );
    expect(verdict).toEqual({ kind: "needsCredential" });
    expect(connectionSaid(verdict))
      .toBe("This mailbox needs its password again. Enter it to start syncing.");
    setActiveLocale("de");
    try {
      expect(connectionSaid(verdict))
        .toBe("Dieses Postfach braucht sein Passwort erneut. Gib es ein, damit wieder synchronisiert wird.");
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("NOTHING DIALLED YET gives no verdict — neither reachable nor an outage (FIX-026 row 96)", () => {
    /* A password sealed onto a launch that was skipped is dialled by the NEXT launch. Nothing was
       tried and nothing failed, so "Reconnecting…" would promise a re-dial nobody is making. The
       arm sits below `needsCredential` (a missing password still asks for it) and above the outage. */
    expect(connectionSay(
      { reachable: false, unreachableSince: null, signInRefused: false, needsCredential: false, dialled: false },
      NOW, ZURICH,
    ), "an undialled runtime was read as an outage").toBeNull();
    expect(connectionSay(
      { reachable: false, unreachableSince: null, signInRefused: false, needsCredential: true, dialled: false },
      NOW, ZURICH,
    )).toEqual({ kind: "needsCredential" });
    /* The control: an engine older than the field, and a dialled runtime, keep their arms. */
    expect(connectionSay(
      { reachable: false, unreachableSince: null, signInRefused: false, dialled: true }, NOW, ZURICH,
    )).toEqual({ kind: "lost" });
    expect(connectionSay(
      { reachable: false, unreachableSince: null, signInRefused: false }, NOW, ZURICH,
    )).toEqual({ kind: "lost" });
  });

  it("A REFUSED CERTIFICATE is named, and promises no reconnect — in both languages", () => {
    /* The engine stops re-dialling a certificate this phone refused, so "Reconnecting…" would be
       a promise nothing keeps; the outage clock beside it does not change that. */
    const verdict = connectionSay(
      { reachable: false, unreachableSince: ago(90_000), signInRefused: false, certificateRefused: true },
      NOW, ZURICH,
    );
    expect(verdict).toEqual({ kind: "certificate" });
    expect(connectionSaid(verdict)).toBe(
      "This phone would not accept the mail server's certificate, so it stopped before sending your password.",
    );
    expect(connectionSaid(verdict)).not.toBe(Copy.connectionLost);
    setActiveLocale("de");
    try {
      expect(connectionSaid(verdict)).toBe(
        "Dieses Handy hat das Zertifikat des Mailservers nicht akzeptiert und deshalb abgebrochen, bevor das Passwort rausging.",
      );
    } finally {
      resetLocaleRegisterForTests();
    }
    // The control: the same outage without the flag is still the outage.
    expect(connectionSay(
      { reachable: false, unreachableSince: ago(90_000), signInRefused: false, certificateRefused: false },
      NOW, ZURICH,
    )).toEqual({ kind: "lost" });
  });

  it("POSITIVE CONTROL — an engine that does not say it leaves every arm as it was", () => {
    /* An engine bundle older than the field carries no `needsCredential`, and an absence must not
       become a password to ask for: the outage below it keeps its own sentence. */
    expect(connectionSay(
      { reachable: false, unreachableSince: ago(90_000), signInRefused: false }, NOW, ZURICH,
    )).toEqual({ kind: "lost" });
    expect(connectionSay(
      { reachable: true, unreachableSince: null, signInRefused: false, needsCredential: false },
      NOW, ZURICH,
    )).toEqual({ kind: "reachable" });
  });

  it("an outage with NO stamped instant stays `lost` however long it runs", () => {
    /* A real state on the first observation, and the second sentence is "since <time>" — there
       is no time to name, so the honest answer is the first sentence and not an invented one. */
    for (const stamp of [null, "not an instant"]) {
      expect(connectionSay(
        { reachable: false, unreachableSince: stamp, signInRefused: false }, NOW, ZURICH,
      )).toEqual({ kind: "lost" });
    }
  });

  /**
   * THE WIRING, PINNED AT THE SOURCE — this file's own idiom for seams no node renderer drives.
   *
   * Four things, and each was a way for the sentence to reach nobody: the world has to derive it,
   * the watcher has to notice a change nothing else re-renders on, the top bar has to RANK it
   * above "catching up", and the Settings panel has to render it beside the chip.
   */
  it("the world derives it, the watcher notices it, and both surfaces render one sentence", () => {
    const src = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const world = src("../src/state/world.tsx");
    /* THE DOOR SCOPED TO THE SESSION, AND THE CLOCK READ HERE — both halves, both measured.
       The clock: it used to be the projection's `v.now`, right while one memo derived
       everything; the mail projection and the connection are two memos now, so pinning `v.now`
       would pin a stale sentence into the memo that exists to keep it fresh. The door:
       `standaloneHereFor`, not the module's global — unscoped, a switch to a healthy paired
       account rendered the RETAINED standalone engine's outage as that account's. */
    expect(world, "world.tsx no longer derives boot.connection from the door")
      .toMatch(/connection: connectionSay\(standaloneHereFor\(session\), new Date\(\), zone\)/);
    /* ONE WATCHER AND ONE BEAT. A second `setInterval` bumping a second counter would be a
       second writer of one derived world, and the two could disagree about which render is
       current — so the connection's check lives in the effect the stale label already has.
       The FIRST-SYNC verdict joined the same sentinel rather than getting one of its own, which
       is this rule holding rather than bending: both are read off the same door in the same
       synchronous pass, and a second interval for the second verdict is exactly the second
       writer the paragraph above refuses. The sentinel is still the verdicts' SHAPE and never
       their references — `connectionSay` and `firstSyncSay` each answer a fresh value per call.
       The set-aside sentence joined the same sentinel for the same reason. */
    expect(world).toMatch(
      /const renderedConnection = JSON\.stringify\(\[world\.boot\.connection, world\.boot\.firstSync, world\.boot\.setAside\]\);/,
    );
    expect(world).toMatch(/if \(staleMoved \|\| connMoved\) setFreshBeat/);
    /* AND THE SESSION'S OWN DOOR IS THE FOURTH DEP — a BOOLEAN, because the world object is fresh
       per derivation and depending on it would re-subscribe this watcher every render. */
    expect(world).toMatch(/\}, \[engine, zone, renderedStale, renderedConnection, rendersOwnDoor\]\);/);
    expect(
      (world.match(/setInterval\(/g) ?? []).length,
      "world.tsx grew a second interval — one live-verdict watcher, one beat",
    ).toBe(1);

    /* THE TOP BAR RANKS IT ABOVE THE FRESHNESS LABEL: a lost link is WHY the mirror is stale, so
       two lines would say one thing twice and the weaker of them would claim "catching up". */
    const chrome = src("../src/ui/chrome.tsx");
    const ranking = src("../src/state/live.ts");
    expect(chrome).toMatch(/topLineSaid\(\{[\s\S]*?connection: boot\.connection,[\s\S]*?\}\);/);
    expect(ranking, "the freshness label is no longer ranked below the outage sentence")
      .toMatch(/const outage = connectionSaid\(o\.connection\);\s*if \(outage !== null\) return[\s\S]*?if \(o\.stale !== null\)/);

    /* AND THE PANEL THAT NAMES THIS PHONE, which is where somebody asking "is my mail being
       filed?" is already looking. It reads the WORLD's verdict rather than re-deriving one. */
    const settings = src("../app/settings.tsx");
    expect(settings).toMatch(/const outage = connectionSaid\(w\.boot\.connection\)/);
    expect(settings).toMatch(/\{outage === null \? null : \(/);
    /* AND THE FIRST-SYNC SENTENCE BESIDE IT, never instead of it. The two are true at once —
       measured against a server that signs you in and then refuses to hand over the mail — and a
       panel that showed only the link's would send somebody to look at their network. */
    expect(settings).toMatch(/const unreadable = firstSyncSaid\(w\.boot\.firstSync\)/);
    expect(settings).toMatch(/\{unreadable === null \? null : \(/);

    /* AND NEITHER SURFACE BRANCHES ON THE PLATFORM for this sentence: the engine, the ranking
       and the wording are shared JS, so an iPhone and an Android phone say the same thing. The
       Settings panel does carry a platform line — the rule about notifications — so the check is
       scoped to the sentence's own expression rather than to the file. */
    for (const [name, body, needle, end] of [
      ["chrome", chrome, "topLineSaid({", "});"],
      ["ranking", ranking, "export function topLineSaid(", "\n}\n"],
      ["settings", settings, "connectionSaid(", "\n"],
    ] as const) {
      const at = body.indexOf(needle);
      expect(at, `${name} does not read the shared sentence`).toBeGreaterThan(-1);
      expect(
        body.slice(at, body.indexOf(end, at)),
        `${name} branches the outage sentence on the platform`,
      ).not.toMatch(/Platform/);
    }
  });
});
