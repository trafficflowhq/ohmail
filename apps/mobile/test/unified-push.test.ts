import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `Platform` is the gate in front of the native require (see the module's header), so the suite
 * owns it: the real `react-native` entry is Flow-typed source this runner cannot parse, and a
 * mutable mock is what lets one file drive both platforms.
 */
const mocks = vi.hoisted(() => ({ platform: { OS: "android" as string } }));
vi.mock("react-native", () => ({ Platform: mocks.platform }));
import ts from "typescript";
import { WAKE_PAYLOAD } from "../src/net/unified-push";
import { Copy } from "../src/copy";
import { EN } from "../src/copy.en";
import { LOCALES } from "../src/i18n/locale";
import { DE } from "../src/copy.de";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CONNECTOR ADAPTER — what can be held down without an Android device, and what cannot
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `src/net/unified-push.ts` is the one file that touches the native module, and the native module
 * does not exist off-device: `requireNativeModule("ExpoUnifiedPush")` throws in node, and
 * `registerDevice` rejects on an emulator BY DESIGN, so even a simulator proves nothing. That is
 * exactly why the module is written as a port implementation — every behaviour that a test could
 * meaningfully assert lives in `push.ts` behind {@link UnifiedPushDistributor}, and this file
 * covers the two things that are true of the adapter itself regardless of platform:
 *
 *  1. IT LOADS AND DEGRADES. Importing it in node must not throw, and every function must answer
 *     the honest "there is nothing here" rather than propagating the missing module. This is the
 *     property that keeps the Settings screen alive on iOS and in every test run.
 *  2. THE PAYLOAD CONTRACT. The constant this app will act on, and — separately — the absence of
 *     the one field that would turn a silent wake into a visible notification.
 *
 * What is NOT claimed here: that a wake arrives, that a distributor forwards one, or that the
 * connector renders anything. Those need a phone with a distributor installed and they are named as
 * named as a device acceptance rather than pretended at.
 */

const SRC = fileURLToPath(new URL("../src/net/unified-push.ts", import.meta.url));

describe("the adapter loads and degrades where there is no native module", () => {
  it("importing it in node does not throw, and the payload constant is readable", () => {
    // The whole point of the lazy `require`. A top-level import of `expo-unified-push` would make
    // this file — and any screen importing it — throw on load in node and on iOS.
    expect(WAKE_PAYLOAD).toBe('{"type":"wake"}');
  });

  it("every entry point answers the empty/none case rather than propagating a missing module", async () => {
    const mod = await import("../src/net/unified-push");
    expect(mod.listDistributors()).toEqual([]);
    expect(mod.savedDistributor()).toBeNull();
    expect(() => { mod.chooseDistributor("org.example.dist"); }).not.toThrow();
    expect(() => { mod.chooseDistributor(null); }).not.toThrow();

    const d = mod.unifiedPushDistributor();
    expect(d.available()).toBe(false);
    await expect(d.register("B".repeat(87), "p-1")).resolves.toBeNull();
    await expect(d.unregister("p-1")).resolves.toBeUndefined();

    // `onWake` returns a working unsubscribe even when it subscribed to nothing, so a caller's
    // cleanup path is the same on every platform.
    const off = mod.onWake("p-1", () => { throw new Error("must not be called"); });
    expect(typeof off).toBe("function");
    expect(() => { off(); }).not.toThrow();
  });
});

describe("the payload this app will act on", () => {
  it("is the byte-identical fifteen-byte constant the server sends", () => {
    expect(WAKE_PAYLOAD).toBe('{"type":"wake"}');
    expect(Buffer.byteLength(WAKE_PAYLOAD, "utf8")).toBe(15);
    expect(Object.keys(JSON.parse(WAKE_PAYLOAD) as object)).toEqual(["type"]);
  });

  it("has NO `id` field — which is what keeps a wake SILENT on the device", () => {
    /**
     * ── THE PIN THAT STOPS A WAKE BECOMING A NOTIFICATION ────────────────────────────────────
     *
     * The connector's own default renderer (`ExpoUPService.renderJsonPayload`) reads an `id` out of
     * the decrypted JSON and returns null — drawing nothing — when there is none. So the silence of
     * a wake is a property of the PAYLOAD, not of anything this app suppresses: we are not turning a
     * notification off, there is nothing for the renderer to build.
     *
     * That makes `id` a field whose ADDITION would change user-visible behaviour on the phone
     * without changing a single line of UI code — a notification would simply start appearing, with
     * whatever `title` and `body` were added beside it. Pinned separately from the "one key" check
     * above because the two would be broken by different edits: adding a `title` is a privacy
     * regression, adding an `id` is a behaviour change that discloses nothing.
     */
    const parsed = JSON.parse(WAKE_PAYLOAD) as Record<string, unknown>;
    expect(parsed.id, "an `id` in the wake payload makes the connector render a notification")
      .toBeUndefined();
    for (const field of ["id", "title", "body", "imageUrl", "number", "url"]) {
      expect(parsed[field], `the wake payload gained a \`${field}\``).toBeUndefined();
    }
  });

  it("a message that is not the constant is IGNORED — the wake is a trigger, never data", () => {
    /**
     * The source-level half: `onWake` compares to the constant and calls back only on a match. A
     * client that acted on arbitrary push-delivered content would be trusting a channel that runs
     * through a third party the user chose, which is the one thing the content-free design exists
     * to avoid. Asserted over the source because the behaviour needs a native module to execute.
     */
    const code = withoutComments(readFileSync(SRC, "utf8"));
    expect(code).toMatch(/d\.message\s*!==\s*WAKE_PAYLOAD\)\s*return/);
    // And an undecrypted message is dropped rather than guessed at.
    expect(code).toMatch(/d\.decrypted\s*!==\s*true/);
    // Nothing parses the payload for content — no field is ever read out of it.
    expect(code).not.toMatch(/JSON\.parse/);
  });
});

describe("the wake listener's lifetime is the APP's, not a screen's", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE COPY PROMISES "OPEN OR IN THE BACKGROUND". A SCREEN-SCOPED LISTENER CANNOT KEEP THAT.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `onWake(...)` — the subscription that turns a delivered wake into a `/sync` — first shipped
   * inside a hook called only by the pushed Settings screen. So it existed only while that screen
   * was mounted: a launch that never opened Settings had no listener at all, and pressing Back
   * after enabling wakes tore down the one there was. Every other part of the feature worked, which
   * is what made it invisible — the registration landed, the server sent, and the phone ignored it.
   *
   * These assertions are structural because the alternative is a React render
   * test that would pass on a listener mounted anywhere at all; what matters is WHERE.
   */
  const ROOT = fileURLToPath(new URL("../app/_layout.tsx", import.meta.url));
  const PROVIDER = fileURLToPath(new URL("../src/state/wake.tsx", import.meta.url));
  const SETTINGS = fileURLToPath(new URL("../app/settings.tsx", import.meta.url));

  it("the provider is mounted in the ROOT layout", () => {
    const root = readFileSync(ROOT, "utf8");
    expect(root).toMatch(/import \{ WakeProvider \} from "\.\.\/src\/state\/wake"/);
    expect(root).toMatch(/<WakeProvider>/);
    // Inside the connection provider, because it needs the live session, and around the screens,
    // because that is the whole point.
    const conn = root.indexOf("<ConnectionProvider>");
    const wake = root.indexOf("<WakeProvider>");
    const shell = root.indexOf("<Shell />");
    expect(conn).toBeGreaterThan(-1);
    expect(wake).toBeGreaterThan(conn);
    expect(shell).toBeGreaterThan(wake);
  });

  it("`onWake` is subscribed ONLY by the provider — never by a screen", () => {
    /**
     * The assertion that would have caught the original defect: a second `onWake` caller anywhere,
     * or a move back into a screen.
     *
     * IT USED TO READ THREE FILENAMES. `settings.tsx`, `_layout.tsx` and `wake.tsx` — the three
     * the defect happened to involve — so a NEW screen subscribing was invisible to a guard whose
     * whole claim is the word ONLY. A guard whose reach is a list stops where somebody's attention
     * stopped, and this one's list was written the day the defect was found.
     *
     * It walks `src/` and `app/` now, and matches CALLS rather than the word, so the module that
     * declares `onWake` is not mistaken for a subscriber and neither is a mention in a comment.
     */
    const roots = [
      fileURLToPath(new URL("../src", import.meta.url)),
      fileURLToPath(new URL("../app", import.meta.url)),
    ];
    const base = fileURLToPath(new URL("..", import.meta.url));
    const callers: string[] = [];
    let scanned = 0;
    const visitDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { visitDir(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        scanned += 1;
        const sf = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest,
          true, entry.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && n.expression.getText(sf) === "onWake") {
            const rel = relative(base, full);
            if (!callers.includes(rel)) callers.push(rel);
          }
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(sf, visit);
      }
    };
    for (const r of roots) visitDir(r);
    /* The reach, stated: finding one subscriber means nothing beside a count of files looked at. */
    expect(scanned, "nothing was scanned, so ONE subscriber is not a measurement")
      .toBeGreaterThan(50);
    expect(callers, "onWake is subscribed somewhere other than the provider").toEqual([
      join("src", "state", "wake.tsx"),
    ]);
  });

  it("Settings CONSUMES the provider and owns no lifecycle of its own", () => {
    const settings = readFileSync(SETTINGS, "utf8");
    expect(settings).toMatch(/useWake\(\)/);
    // No subscription, no registration call, no distributor handling: the screen renders.
    for (const owned of ["onWake", "registerWake", "forgetWake", "chooseDistributor", "useEffect"]) {
      expect(settings, `settings.tsx should not own ${owned}`).not.toMatch(new RegExp(`\\b${owned}\\b`));
    }
  });

  it("a SUPERSEDED registration cannot overwrite the new session's state or id", () => {
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  THE COST OF MAKING THIS A PROVIDER, PAID EXPLICITLY
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * While the lifecycle lived in the Settings screen, leaving the screen unmounted everything —
     * so a registration for profile A could not outlive a switch to profile B. Now that it survives
     * every screen, which is the entire point of the fix, an in-flight registration CAN: the
     * connector's register has a fifteen-second ceiling.
     *
     * The consequence: A's late result overwrote B's state AND B's subscription id,
     * so turning wakes off afterwards sent A's id to B's server (a 404) and left A's row live —
     * wakes going to a phone that had moved on, with no surface left to stop them.
     *
     * Asserted structurally: a generation captured before the await, and every write gated on it
     * still being current. A React render test would need two real sessions and a mocked native
     * module to reach the same statement, and would pass on a guard that checked only `mounted`.
     */
    const src = readFileSync(fileURLToPath(new URL("../src/state/wake.tsx", import.meta.url)), "utf8");
    // The generation is captured BEFORE the await, not read after it — reading it after would
    // compare the new value to itself and never fire.
    expect(src).toMatch(/const mine = generation\.current;[\s\S]*?await registerWake/);
    // Every write requires a mounted attempt, its original generation and the same live session.
    expect(src).toMatch(
      /const fresh = \(\): boolean => mounted\(\) && generation\.current === mine && liveSession\.current === session;/,
    );
    /**
     * ── THE SUPERSEDED ARM, CHECKED BY WHAT IT MAY NOT DO ────────────────────────────────
     *
     * This used to be `/if \(!fresh\(\)\) return;\s*\n\s*subscriptionId\.current/` — the
     * literal shape of a bare early return. That shape stopped being available when the arm
     * grew a body: a superseded registration has already COMMITTED a row on the outgoing
     * server, and discarding the id without spending it left that row waking a phone which had
     * moved on. Requiring the bare return would now forbid the cleanup.
     *
     * So the property is asserted directly instead, which is also stronger than the old regex:
     * the arm exists, it WRITES NOTHING the fresh path owns, and it leaves before the id
     * assignment. A body that started setting state or the id fails here whatever its shape.
     */
    const supersededAt = src.indexOf("if (!fresh()) {");
    expect(supersededAt, "the superseded arm must exist").toBeGreaterThan(-1);
    const idWrite = src.indexOf("subscriptionId.current = next.k ===");
    expect(idWrite).toBeGreaterThan(supersededAt);
    // The superseded arm ends at its own return; the fresh path's checks (the page's no, then the id) come after it.
    const armEnd = src.indexOf("\n        return;\n      }", supersededAt) + "\n        return;\n      }".length;
    expect(armEnd).toBeLessThan(idWrite);
    const arm = src.slice(supersededAt, armEnd);
    // The page's no landing while this was in the air writes only while the session it was made for is current.
    expect(src).toMatch(/await forgetWake\(session, unifiedPushDistributor\(\), next\.id, nativeServerProfiles\(\)\);\s*\n\s*if \(fresh\(\)\) \{/);
    expect(arm, "a superseded result may not write the id").not.toMatch(/subscriptionId\.current\s*=/);
    expect(arm, "a superseded result may not write the pane's state").not.toMatch(/setState\(/);
    expect(arm, "and it must leave before the fresh path's writes").toMatch(/\n        return;\n      \}/);

    for (const guarded of [
      /if \(fresh\(\)\) \{\s*\n\s*subscriptionId\.current = null;/,
      /if \(fresh\(\)\) setBusy\(false\);/,
    ]) expect(src).toMatch(guarded);
    // …and the generation really advances when the session changes.
    expect(src).toMatch(/generation\.current \+= 1;/);
    // The old unconditional predicate must be gone from the state-writing path.
    expect(src).not.toMatch(/if \(!mounted\(\)\) return;\s*\n\s*subscriptionId/);
  });

  it("EVERY wake mutation goes through one chain, because a generation cannot undo a side effect", () => {
    /**
     * The generation counter discards a stale RESULT and can do nothing about a stale SIDE
     * EFFECT. Two races followed, and both ended with the pane saying "on" over a phone no wake
     * could reach:
     *
     *  · off then immediately on — the DELETE lands after the re-registration and removes the
     *    row the server had just handed back (it dedupes on the endpoint, so it is often the
     *    SAME id);
     *  · a superseded `registerWake` finishing LAST — `distributor.register(key, instance)` writes
     *    that instance's registration in the connector, so the outgoing profile's late call
     *    rebinds a registration the incoming profile has already replaced.
     *
     * Structural, and it has to be: both are orderings of real network and native calls that no
     * module-level test can stage. What is checkable is that no entry point fires one directly.
     *
     * ── RE-DERIVED WHEN REGISTRATIONS BECAME PER-PAIRING ──────────────────────────────────────
     *
     * This pinned one literal call site: `void serialize(() => unifiedPushDistributor()
     * .unregister()`, the blanket drop of the app's single shared registration in the
     * nothing-paired effect. That call is GONE, because there is no shared registration to drop —
     * each forget drops its own instance, and the sweep is `chooseDistributor(null)`, which the
     * connector documents as clearing every instance it holds.
     *
     * The pin is not deleted with it. The INVARIANT was never "that line exists"; it was "no wake
     * mutation reaches the native module or the wire outside the chain". So it is stated as the
     * invariant now — every `unregister(` in the file is inside `serialize` — which is a stronger
     * guard than the literal was, and covers the call site that replaced it.
     */
    const src = readFileSync(fileURLToPath(new URL("../src/state/wake.tsx", import.meta.url)), "utf8");
    // COMMENT-STRIPPED for the negative checks: this file explains the very shapes it forbids,
    // so a prose mention of `void attempt(…)` would read as an un-serialized call site. Through
    // the repo's one scanner — a pair of regexes reads a block-comment OPENER quoted inside a
    // line comment as a real opener and deletes every line to the next terminator, which empties
    // the very extract the negatives are asked about.
    const code = withoutComments(src);
    expect(src).toMatch(/const chain = useRef<Promise<unknown>>\(Promise\.resolve\(\)\);/);
    // A failed operation must not poison the queue — the profile store's own chain shape.
    expect(src).toMatch(/chain\.current\.then\(op, op\)/);

    // No entry point may reach the wire outside the chain.
    for (const direct of [
      /(?<!serialize\(\(\) => )\bvoid attempt\(/,
      /(?<!serialize\(\(\) => )\bvoid owedDrop\(/,
      /(?<!\bawait )\bowedDrop\(session, next\.id\)/,
    ]) expect(code, `an un-serialized wake mutation: ${String(direct)}`).not.toMatch(direct);
    expect(src).toMatch(/void serialize\(\(\) => attempt\(mounted\)\)/);
    expect(src).toMatch(/void serialize\(\(\) => attempt\(\(\) => true\)\)/);
    expect(src).toMatch(/void serialize\(\(\) => owedDrop\(previous, previousId\)\)/);
    expect(src).toMatch(/void serialize\(async \(\) => \{[\s\S]{0,600}?const dropped = await forgetWake/);

    /* EVERY unregister, inside the chain. Counted from the comment-stripped source so the prose
       above cannot satisfy it, and asserted non-empty so a file that stopped unregistering
       altogether is a red rather than a vacuous pass. */
    const unregisters = [...code.matchAll(/\.unregister\(/g)];
    expect(unregisters.length, "no unregister call sites at all — this census would pass over nothing")
      .toBeGreaterThan(0);
    for (const m of unregisters) {
      const line = code.slice(code.lastIndexOf("\n", m.index!) + 1, code.indexOf("\n", m.index!));
      expect(line, `an un-serialized unregister: ${line.trim()}`).toMatch(/serialize\(/);
    }

    /* AND THE NOTHING-PAIRED EFFECT NAMES NO INSTANCE, because there is no pairing left to name.
       An `unregister()` there would be the shared-registration shape returning: with no argument
       it can only mean the connector's default instance, which no profile has used since
       registrations became per-pairing.

       The bound is a proximity in CODE, so whitespace is collapsed before it is measured: the
       scanner BLANKS a comment to spaces rather than deleting it, which is what keeps every
       `file:line` above true, and an uncollapsed reading would be counting the blanks. Measured
       here: 127 characters collapsed, 693 raw. */
    const near = code.replace(/\s+/g, " ");
    expect(near).toMatch(/const nothingPaired = conn\.profiles\.length === 0;[\s\S]{0,400}?chooseDistributor\(null\)/);
  });

  it("a wake delivered for a SUPERSEDED session does not start a sync", () => {
    /**
     * `conn.syncNow()` reads the connection layer's own live ref, and during a profile switch there
     * is a window where teardown has begun and that ref has not caught up — a wake landing in it
     * would start a drain on a session whose mirror is already scheduled to close. This module
     * cannot fix the connection layer's window (another lane owns that file), but it can refuse to
     * be the thing that walks into it: the session is captured at subscribe time and compared before
     * the sync is asked for.
     */
    const src = readFileSync(fileURLToPath(new URL("../src/state/wake.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/const subscribedFor = session;/);
    expect(src).toMatch(/if \(liveSession\.current !== subscribedFor\) return;/);
    // The guard is BEFORE the sync, not after it.
    const guard = src.indexOf("liveSession.current !== subscribedFor");
    const sync = src.indexOf("conn.syncNow()", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(guard);
  });

  it("the provider refuses to be read outside itself rather than answering a default", () => {
    // A silent "no distributor" default would look exactly like a phone that has none — which is
    // the failure mode this whole file is about, reintroduced one layer up.
    const provider = readFileSync(PROVIDER, "utf8");
    expect(provider).toMatch(/useWake outside WakeProvider/);
  });
});

describe("the wake renderer draws ONE fixed notice, and never server content", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE SERVER YOU PAIRED WITH COULD OTHERWISE DRAW A NOTIFICATION IN OHMAIL'S NAME
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `expo-unified-push`'s native service renders a notification from ANY decrypted payload that
   * carries an `id`, using that payload's own `title`, `body`, `imageUrl` and `url` — and the `url`
   * becomes an `ACTION_VIEW` PendingIntent, so a tap opens whatever address the payload named.
   *
   * WHO could do that, measured rather than assumed: not the distributor, which relays bytes and
   * holds neither the device's keys nor the server's VAPID private key, so it cannot produce a body
   * the connector will decrypt and accept. The actor is the SERVER the phone paired with — it is
   * handed `p256dh`/`auth` at registration by design. On a product whose whole point is that you can
   * pair with a self-host or a friend's desktop, that is a phishing primitive.
   *
   * The connector lets an app REPLACE its default renderer with one of its own. The predecessor
   * here rendered NOTHING for every payload. This one is narrower on the axis that matters and wider
   * on the one the product needs: a wake to a KILLED app (no JS to sync it) now draws a single,
   * FIXED, app-owned "New mail" notice — while a payload carrying server-supplied content still
   * draws nothing, because the renderer reads no field out of the payload and acts only on the exact
   * closed wake constant. So the phishing surface stays shut and the closed-app case is closed.
   *
   * The tests below pin BOTH halves — the class-name agreement the connector resolves reflectively
   * (a one-character drift falls silently back to the DEFAULT renderer), AND the two refusals that
   * make rendering safe. The artifact itself is checked in CI (the dex must contain the class).
   */
  const APP_JSON = fileURLToPath(new URL("../app.json", import.meta.url));
  const APP = dirname(APP_JSON);
  const PLUGIN = fileURLToPath(new URL("../plugins/wake-push-renderer.js", import.meta.url));
  const EXPECTED_FQCN = "app.ohmail.push.WakePayloadRenderer";

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plugin = require("../plugins/wake-push-renderer.js") as {
    FQCN: string; INITIALIZER_FQCN: string; WAKE_PAYLOAD: string; NOTIFICATION_TITLE: string;
    SOURCE: string; APP_STATE_SOURCE: string; INITIALIZER_SOURCE: string;
  };
  // The EMITTED Kotlin, with comments stripped, so an assertion about what the code DOES cannot be
  // satisfied by prose that merely describes it.
  const kotlin = withoutComments(plugin.SOURCE);

  it("app.json applies the connector plugin with the renderer class named", () => {
    const cfg = JSON.parse(readFileSync(APP_JSON, "utf8")) as {
      expo: { plugins: (string | [string, Record<string, unknown>])[] };
    };
    const entry = cfg.expo.plugins.find(
      (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === "expo-unified-push",
    );
    expect(entry, "app.json does not apply the expo-unified-push plugin, so NO meta-data is written "
      + "and the connector's default renderer is in force").toBeDefined();
    expect(entry![1].payloadRendererClass).toBe(EXPECTED_FQCN);
  });

  it("app.json also applies the plugin that COMPILES that class", () => {
    // The meta-data alone names a class that would not exist; the reflective lookup would return
    // null and the default renderer would run. Both plugins or neither.
    const cfg = JSON.parse(readFileSync(APP_JSON, "utf8")) as { expo: { plugins: unknown[] } };
    expect(cfg.expo.plugins).toContain("./plugins/wake-push-renderer");
  });

  it("the plugin compiles EXACTLY the class app.json names — no drift", () => {
    /**
     * The assertion that catches the one-character-apart failure. The plugin exports its
     * fully-qualified name so this is a comparison of values rather than of two regexes over prose.
     */
    expect(plugin.FQCN).toBe(EXPECTED_FQCN);

    const src = readFileSync(PLUGIN, "utf8");
    expect(src).toMatch(/const PACKAGE = "app\.ohmail\.push"/);
    expect(src).toMatch(/const CLASS = "WakePayloadRenderer"/);
    // …and the Kotlin it writes really declares that package and class and implements the interface.
    expect(kotlin).toMatch(/class WakePayloadRenderer : PushPayloadRenderer \{/);
    expect(kotlin).toMatch(/override fun render\([^)]*\): NotificationContent\?/);
  });

  it("acts ONLY on the exact closed wake constant — it parses nothing", () => {
    /**
     * The refusal that keeps a paired server from drawing a notice in ohmail's name: a rich payload
     * (its own title/body/image/url) is not the constant, so it renders nothing. The only thing the
     * renderer ever does with `decrypted` is compare it for equality — it never parses it and never
     * feeds it to a notification field.
     */
    expect(kotlin).toMatch(/if \(decrypted != WAKE_PAYLOAD\) return null/);
    /*
     * No JSON parsing, no field extraction of any kind.
     *
     * `getString(` used to be banned outright. It is now banned with a STRING-LITERAL KEY —
     * `getString("title")`, which is how a payload field is pulled out of a JSON object or a
     * Bundle — because the renderer legitimately calls `ctx.getString(R.string.ohmail_wake_title)`
     * to read its own localized notice text. That is a resource id, not a field name, and it
     * cannot carry anything the server sent. The intent of the assertion is unchanged: nothing is
     * extracted from `decrypted` by name, which the next line checks from the other direction.
     */
    expect(kotlin).not.toMatch(/\bJson\b|jsonObject|parseToJsonElement|getString\(\s*"|optString/);
    // `decrypted` never reaches a notification builder call.
    expect(kotlin).not.toMatch(/setContent\w+\([^)]*decrypted/);
  });

  it("its constant is the server's wake body, byte for byte", () => {
    // Drift here would make wakes stop drawing (fail closed), never make the app draw something
    // unexpected — but it should not drift at all, so it is pinned to the server contract that
    // `src/net/unified-push.ts` already carries.
    expect(plugin.WAKE_PAYLOAD).toBe(WAKE_PAYLOAD);
    expect(kotlin).toContain(`const val WAKE_PAYLOAD = ${JSON.stringify(WAKE_PAYLOAD)}`);
  });

  it("draws ONLY when the React surface is not mounted — a running app still syncs silently", () => {
    /**
     * `ExpoUPService.onMessage` runs the renderer on every wake, alive or dead. A running app (open
     * or backgrounded) handles the wake through the JS `onWake` → `/sync` path with no notification,
     * and that behaviour must be preserved: the renderer draws only when no Activity is alive to keep
     * that listener mounted (a killed app, or a task swiped away in a lingering process).
     */
    expect(kotlin).toMatch(/if \(WakeAppState\.interactive\) return null/);
    // The suppress path returns BEFORE anything is posted.
    const guard = kotlin.indexOf("if (WakeAppState.interactive) return null");
    const post = kotlin.indexOf("postWakeNotification(context, instance)");
    expect(guard).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(guard);
  });

  it("NEVER reads ReactHost — that both creates it in a killed process and outlives the surface", () => {
    /**
     * Two traps, one rule. In a broadcast-spawned process reading `reactHost` (a `by lazy`) CREATES
     * and starts the host, making a killed process look alive (measured: the notice's channel was
     * never even created). And on a task removal React tears down the SURFACE — unmounting `onWake` —
     * but leaves the ReactHost, so `currentReactContext` stays non-null and a context read would
     * suppress the very notice this exists to draw. So the renderer reads the activity COUNT and
     * never the host: the source must not name either.
     */
    expect(kotlin).not.toMatch(/reactHost|currentReactContext|ReactApplication/);
  });

  it("the signal is a created-minus-destroyed activity count from an auto-start provider", () => {
    /**
     * A ContentProvider runs in every process start (including the connector's broadcast) before any
     * component, and counts activities created minus destroyed — i.e. whether the React surface (and
     * its `onWake` listener) is mounted. CREATE/DESTROY, not START/STOP, so a backgrounded app (its
     * Activity stopped, not destroyed) still counts as mounted and keeps suppressing; a task removal
     * destroys and drops the count to zero so the notice takes over. All pinned so neither the
     * provider, the count, nor its wiring can silently vanish.
     */
    const appState = withoutComments(plugin.APP_STATE_SOURCE);
    expect(appState).toMatch(/object WakeAppState/);
    expect(appState).toMatch(/@Volatile/);
    expect(appState).toMatch(/var liveActivities: Int = 0/);
    expect(appState).toMatch(/val interactive: Boolean\s*\n?\s*get\(\) = liveActivities > 0/);

    const init = withoutComments(plugin.INITIALIZER_SOURCE);
    expect(init).toMatch(/class WakeInteractiveInitializer : ContentProvider\(\)/);
    expect(init).toMatch(/registerActivityLifecycleCallbacks/);
    // Created increments, destroyed decrements (floored) — never start/stop.
    expect(init).toMatch(/onActivityCreated[^{]*\{\s*WakeAppState\.liveActivities\+\+/);
    expect(init).toMatch(/onActivityDestroyed[\s\S]*?WakeAppState\.liveActivities--/);
    expect(init).toMatch(/if \(WakeAppState\.liveActivities > 0\) WakeAppState\.liveActivities--/);
    expect(init).not.toMatch(/onActivityStarted[^{]*\{\s*WakeAppState/);
    expect(plugin.INITIALIZER_FQCN).toBe("app.ohmail.push.WakeInteractiveInitializer");
  });

  it("the notice text is the app's own label, not the payload's — and matches copy", () => {
    // A fixed title, pinned to the in-app `wake` label so the notification and the screen cannot
    // drift, and proven to be a constant (never read from `decrypted`).
    expect(plugin.NOTIFICATION_TITLE).toBe(EN.wake);
    expect(kotlin).toMatch(/setContentTitle\(ctx\.getString\(R\.string\.ohmail_wake_title\)\)/);
    // …and it is a RESOURCE now, so the constant it used to be must be gone: a leftover would be
    // the English string still compiled in beside the localized one.
    expect(kotlin).not.toContain("const val NOTIFICATION_TITLE");
    expect(kotlin).not.toContain('const val CHANNEL_NAME');
  });

  /**
   * ═══ THE NOTICE IN GERMAN, READ FROM THE GENERATED RESOURCES ═════════════════════════════
   *
   * The killed-app notice is drawn by native code in a process with no JS, so the copy deck
   * cannot reach it — it was the last English string a German reader could meet, along with the
   * channel name in the system's notification settings.
   *
   * This reads `android/app/src/main/res/`, the PREBUILD OUTPUT, not the plugin's constants.
   * Asserting the plugin's input would only prove the plugin agrees with itself; what ships is
   * the generated file, and the two have been different before (the launch screen shipped a
   * framework placeholder while the config said otherwise).
   *
   * Skipped when the native project has not been generated in this checkout — and NOT skipped
   * under CI, where nobody is watching a skip go by.
   */
  /**
   * ARMED BY THE ARTIFACT, NOT BY A FLAG. This block was fatal when `process.env.CI` was set, and
   * that failed every clean CI run: `android/` is generated by `expo prebuild` and gitignored, CI
   * runs neither, so the guard failed for a reason that had nothing to do with the product.
   *
   * Unlike the engine census next door, this subject cannot be self-built cheaply — a prebuild is
   * a native project generation, not seconds of esbuild — so it SKIPS, and the skip is visible:
   * counted in the summary, with the missing artifact named in the block's own title. The release
   * gate runs `expo prebuild --no-install` and then asserts that nothing here skipped, which is the
   * checkout that has the artifact.
   */
  /*
   * ═══ THE iOS HALF, WHICH NOTHING READ ════════════════════════════════════════════════════
   *
   * The wake notice below is censused from generated ANDROID resources. iOS permission prompts
   * come from a different place entirely — `app.json`'s `locales` map, pointing at
   * `locales/<lang>.json`, which Expo turns into `InfoPlist.strings` per language at prebuild.
   * No guard in this lane read any of it, and the native gate prebuilds Android only. Replace
   * the German `NSCameraUsageDescription` with the English one and every check here stayed
   * green, while the first camera prompt a German iPhone shows would be in English.
   *
   * These files are TRACKED, so unlike the generated resources there is nothing to skip on:
   * the check is armed on every checkout.
   */
  const LOCALES_DIR = join(APP, "locales");
  const appJson = JSON.parse(readFileSync(join(APP, "app.json"), "utf8")) as {
    expo?: { locales?: Record<string, string> };
  };
  const localeFile = (rel: string) => JSON.parse(
    readFileSync(join(APP, rel.replace(/^\.\//, "")), "utf8"),
  ) as Record<string, unknown>;

  /*
   * EXPO'S OWN SPLIT, which is where this pair of files now sits. `getResolvedLocalesAsync`
   * reads a locale file's TOP-LEVEL keys for BOTH platforms, its `ios` object for iOS only and
   * its `android` object for Android only. iOS writes `<lang>.lproj/InfoPlist.strings`; Android
   * writes `res/values-b+<lang>/strings.xml`, where a string with no default-locale entry is a
   * fatal `ExtraTranslation` in `lintVitalRelease` — no release APK at all.
   */
  const visibleTo = (file: Record<string, unknown>, platform: "ios" | "android") => {
    const { ios, android, ...shared } = file;
    const scoped = (platform === "ios" ? ios : android) ?? {};
    return { ...shared, ...(scoped as Record<string, unknown>) } as Record<string, unknown>;
  };

  it("declares a strings file for every language the app speaks, and no others", () => {
    const declared = appJson.expo?.locales ?? {};
    expect(Object.keys(declared).sort(), "app.json's locales map is not the deck's languages")
      .toEqual([...LOCALES].sort());
  });

  it("translates every iOS permission prompt — the ones a screen never shows", () => {
    const declared = appJson.expo?.locales ?? {};
    const byLang: Record<string, Record<string, string>> = {};
    for (const [lang, rel] of Object.entries(declared)) {
      const file = join(APP, rel.replace(/^\.\//, ""));
      expect(existsSync(file), `app.json points at ${rel}, which is not there`).toBe(true);
      byLang[lang] = visibleTo(localeFile(rel), "ios") as Record<string, string>;
    }
    const keys = Object.keys(byLang.en ?? {});
    expect(keys.length, "no iOS permission strings were read, so this proves nothing")
      .toBeGreaterThan(0);

    for (const key of keys) {
      for (const lang of Object.keys(byLang)) {
        const said = byLang[lang]?.[key];
        expect(said, `${key} is missing from locales/${lang}.json`).toBeDefined();
        expect((said ?? "").trim(), `${key} is empty in locales/${lang}.json`).not.toBe("");
      }
      /* THE ASSERTION THE GAP WAS: an English sentence sitting in the German file passes every
         presence check ever written. The two must differ, and the German must be German. */
      expect(byLang.de?.[key], `${key} reads identically in both languages — it is untranslated`)
        .not.toBe(byLang.en?.[key]);
    }
    /* Neither file may carry a key the other lacks: a prompt added in one language only would
       leave the other showing Apple's default, which names no app and explains nothing. */
    for (const lang of Object.keys(byLang)) {
      expect(Object.keys(byLang[lang] ?? {}).sort(),
        `locales/${lang}.json does not hold the same prompts as English`).toEqual(keys.sort());
    }
  });

  it("keeps every iOS purpose string OUT of the Android release build", () => {
    /*
     * MEASURED, twice, as a refused release APK: with the keys at a locale file's top level,
     * `expo prebuild` wrote `NSCameraUsageDescription` into `values-b+en/strings.xml` and
     * `values-b+de/strings.xml`, and `lintVitalRelease` failed with two `ExtraTranslation`
     * errors — "translated here but not found in default locale". The remedy is WHERE the key
     * sits, so that is what is asserted: not a lint option, which would ship the wrong strings
     * quietly, and not a filename rule, which the next key walks around.
     */
    const declared = appJson.expo?.locales ?? {};
    expect(Object.keys(declared).length, "no locale files were read, so this proves nothing")
      .toBeGreaterThan(0);
    for (const [lang, rel] of Object.entries(declared)) {
      const file = localeFile(rel);
      expect(Object.keys(visibleTo(file, "android")),
        `locales/${lang}.json sends these into res/values-b+${lang}/strings.xml, where the `
        + "default locale has no such string — lintVitalRelease refuses the build")
        .toEqual([]);
      /* The narrower rule too, so that adding a real Android string later cannot disarm it: an
         Info.plist key may appear nowhere but the `ios` section. */
      expect(Object.keys(file).filter((k) => /^NS[A-Z]/.test(k)),
        `locales/${lang}.json carries an Info.plist key outside "ios"`).toEqual([]);
      /* …and the iOS half is not lost by a fix that simply deleted the key. */
      expect(Object.keys(visibleTo(file, "ios")).filter((k) => /^NS[A-Z]/.test(k)).length,
        `locales/${lang}.json carries no iOS purpose string at all any more`).toBeGreaterThan(0);
    }
  });

  const RES_DIR = join(APP, "android/app/src/main/res");
  const NO_NATIVE = !existsSync(join(RES_DIR, "values"));

  describe.skipIf(NO_NATIVE)(
    NO_NATIVE
      ? "the wake notice speaks both languages — SKIPPED: no apps/mobile/android/ in this checkout "
        + "(run `npx expo prebuild --platform android`)"
      : "the wake notice speaks both languages",
    () => {
    const generated = (dir: string): string | null => {
      const file = join(RES_DIR, dir, "ohmail_wake_strings.xml");
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    };
    const value = (xml: string, name: string): string | null =>
      new RegExp(`<string name="${name}">([^<]*)</string>`).exec(xml)?.[1] ?? null;

    it("renders the English notice from the default resources", () => {
      const xml = generated("values");
      expect(xml, "the default resource file is missing from a generated android/").not.toBeNull();
      expect(value(xml!, "ohmail_wake_title")).toBe(EN.wake);
      expect(value(xml!, "ohmail_wake_channel")).toBe(EN.wake);
    });

    it("renders the German notice from values-de", () => {
      const xml = generated("values-de");
      expect(xml, "no values-de/ was generated — a German phone gets the English notice").not.toBeNull();
      expect(value(xml!, "ohmail_wake_title")).toBe(DE.wake);
      expect(value(xml!, "ohmail_wake_channel")).toBe(DE.wake);
    });

    it("selects by the DEVICE language, which is the honest limit and is written down", () => {
      /* Android picks the resource directory by the device locale. The in-app override lives in
         this app's keystore and cannot be read from a JS-less process, so a person who set ohmail
         to German on an English phone still gets an English notice. That is a real limit; the
         plugin's header states it, and this asserts the statement is there rather than trusting
         somebody to keep it. */
      const src = readFileSync(join(APP, "plugins/wake-push-renderer.js"), "utf8");
      expect(src).toMatch(/picks by the DEVICE's locale/);
    });
  });

  describe.skipIf(NO_NATIVE)(
    NO_NATIVE
      ? "no iOS purpose string reached the generated Android resources — SKIPPED: no "
        + "apps/mobile/android/ in this checkout (run `npx expo prebuild --platform android`)"
      : "no iOS purpose string reached the generated Android resources",
    () => {
    it("leaves every per-language strings.xml without a translated string", () => {
      /* The PREBUILD OUTPUT, which is what lint reads — the source rule above says the keys are
         iOS-scoped, and this says Expo's Android writer agreed. An absent directory is the
         strongest pass there is, so it counts as one. */
      const langs = Object.keys(appJson.expo?.locales ?? {});
      expect(langs.length, "app.json declares no locales, so this proves nothing").toBeGreaterThan(0);
      for (const lang of langs) {
        const file = join(RES_DIR, `values-b+${lang}`, "strings.xml");
        const xml = existsSync(file) ? readFileSync(file, "utf8") : "";
        expect(xml.match(/<string\b/g) ?? [],
          `values-b+${lang}/strings.xml carries a string the default locale does not have`)
          .toEqual([]);
      }
    });
  });

  it("logs nothing at all — no path by which push content reaches logcat", () => {
    // The residual's log-hygiene requirement: the module never logs, so `assert-log-hygiene.sh`
    // needs no allow-list extension for it. A `Log.d(TAG, "…$decrypted")` added later is red here.
    expect(kotlin).not.toMatch(/\bLog\./);
  });

  it("does no network fetch for the base render", () => {
    // The connector's default renderer fetches `imageUrl` with a blocking HTTP call. This one never
    // sets an image and opens no connection, so the killed-app notice needs no network to draw.
    expect(kotlin).not.toMatch(/setLargeIcon|imageUrl|HttpURLConnection|openConnection|URL\(/);
  });

  it("the plugin FAILS LOUD if the template's source layout moved", () => {
    // A plugin that silently skipped would leave the default renderer armed while every config
    // check above still passed — the worst of the available failures.
    const src = readFileSync(PLUGIN, "utf8");
    expect(src).toMatch(/throw new Error\(/);
    expect(src).toMatch(/the wake renderer was NOT written/);
  });
});

describe("the embedded FCM distributor is refused at RUNTIME as well as at build time", () => {
  it("an `internal` distributor is filtered out of the list the user can choose", () => {
    /**
     * The Gradle exclusion (`plugins/without-embedded-fcm.js`) is the real guard and the APK dex
     * scan in the release workflow is its evidence. This is the second line: if the exclusion ever
     * stops applying — a template change, a dependency bump — the honest failure must be "no
     * distributor available", never "silently registered with a Google push service".
     *
     * Asserted over the source, because `getDistributors` needs the native module. The filter is one
     * expression and it is the one that matters, so it is pinned exactly rather than by behaviour.
     */
    const code = withoutComments(readFileSync(SRC, "utf8"));
    expect(code).toMatch(/d\.isInternal\s*!==\s*true/);
  });

  it("the adapter names no push provider as a fallback anywhere in its code", () => {
    // There is no arm here that reaches for FCM, APNs or a relay of ours. A wake comes from the
    // paired server through the user's own distributor or it does not come.
    const code = withoutComments(readFileSync(SRC, "utf8"));
    for (const banned of ["firebase", "fcm", "messaging", "apns", "relay"]) {
      expect(code.toLowerCase(), `the adapter's code mentions ${banned}`).not.toContain(banned);
    }
  });
});

describe("enabling wakes asks for the notification permission the closed-app notice needs", () => {
  /**
   * The killed-app notice is dropped on Android 13+ without POST_NOTIFICATIONS, so the app must
   * request it. The request lives in the connector seam (the one file allowed the native module)
   * and is fired when the user opts in by choosing a distributor — the moment an Activity is in the
   * foreground to show the prompt. A denial is a supported outcome; the copy says so.
   */
  const UP = fileURLToPath(new URL("../src/net/unified-push.ts", import.meta.url));
  const WAKE = fileURLToPath(new URL("../src/state/wake.tsx", import.meta.url));

  it("the connector seam exposes a best-effort permission request", () => {
    const src = readFileSync(UP, "utf8");
    expect(src).toMatch(/export async function requestNotificationPermission\(\): Promise<void>/);
    // It goes through the native module's requestPermissions and swallows — never throws.
    expect(src).toMatch(/api\.requestPermissions/);
    const body = src.slice(src.indexOf("export async function requestNotificationPermission"));
    expect(body).toMatch(/try \{[\s\S]*?await api\.requestPermissions\(\)[\s\S]*?\} catch/);
  });

  it("the provider requests it when a distributor is chosen, and only there", () => {
    const src = readFileSync(WAKE, "utf8");
    expect(src).toMatch(/requestNotificationPermission/);
    // Inside choose (the opt-in), fire-and-forget — scoped to the choose callback, which ends where
    // the next top-level declaration (turnOff) begins.
    const start = src.indexOf("const choose = useCallback");
    const end = src.indexOf("const turnOff", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const chooseOnly = src.slice(start, end);
    expect(chooseOnly).toMatch(/void requestNotificationPermission\(\)/);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PLATFORM GATE — the thing that has to happen BEFORE the require, and cannot be
 *  proved by a return value alone
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * On iOS the require throws, and metro turns that throw into a fatal error before the adapter's
 * own `catch` can run — so "no native module" and "the app is dead" answer `null` identically and
 * a test that only reads the return value cannot tell the fix from the defect.
 *
 * The discriminator is a WORKING module behind the require. Node's `require.cache` is keyed by
 * resolved filename and the adapter's lazy `require` goes through it, so seeding the cache with a
 * stub makes the require SUCCEED. After that the two platforms answer differently: Android reads
 * the stub's distributor, iOS answers `null` — which it can only do by never having asked.
 *
 * Removing `if (Platform.OS !== "android") return cached;` makes the iOS case return the stub's
 * distributor; that is the red this pair was written against.
 */
const nodeRequire = createRequire(import.meta.url);
const STUB_DISTRIBUTOR = "org.example.updist";

/**
 * The binary's own answer to "is the push connector's native module in this build": the mail app carries it, the
 * calendar's app is built without it. The adapter asks before it loads the package.
 */
function seedNativePresence(present: boolean): void {
  const resolved = nodeRequire.resolve("expo");
  const m = new Module(resolved) as NodeModule;
  m.filename = resolved;
  m.loaded = true;
  m.exports = { requireOptionalNativeModule: (name: string) => (present && name === "ExpoUnifiedPush" ? {} : null) };
  nodeRequire.cache[resolved] = m;
}

function seedNativeModule(): string {
  seedNativePresence(true);
  const resolved = nodeRequire.resolve("expo-unified-push");
  const m = new Module(resolved) as NodeModule;
  m.filename = resolved;
  m.loaded = true;
  m.exports = {
    default: {
      getDistributors: () => [{ id: STUB_DISTRIBUTOR, name: "UP stub" }],
      getSavedDistributor: () => STUB_DISTRIBUTOR,
      saveDistributor: () => undefined,
      registerDevice: () => Promise.resolve(),
      unregisterDevice: () => undefined,
    },
    subscribeDistributorMessages: () => () => undefined,
  };
  nodeRequire.cache[resolved] = m;
  return resolved;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ADAPTER'S INSTANCE HANDLING — driven against a real, firing native stub
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The file's own header says what cannot be asserted off-device: that a wake arrives, that a
 * distributor forwards one. What CAN be is everything the adapter decides about WHICH registration
 * an event belongs to — and that is not a detail, because the subscription is process-wide.
 *
 * `subscribeDistributorMessages` delivers every instance's events to every subscriber. So a
 * `register` promise that did not check the instance would be settled by another profile's
 * `registered` (sending the wrong pairing's endpoint to a server) or by another profile's
 * `registrationFailed` (reporting a working registration as declined). Both are stageable here,
 * because the stub is the connector's own event shape.
 */
describe("the adapter keeps one instance's events out of another's", () => {
  afterEach(() => {
    delete nodeRequire.cache[nodeRequire.resolve("expo-unified-push")];
    delete nodeRequire.cache[nodeRequire.resolve("expo")];
    mocks.platform.OS = "android";
    vi.resetModules();
  });

  /** A native stub that RECORDS its calls and lets the test fire the connector's own events. */
  function seedDrivable() {
    seedNativePresence(true);
    const calls: { fn: string; args: unknown[] }[] = [];
    const listeners: ((e: { action: string; data: Record<string, unknown> }) => void)[] = [];
    const resolved = nodeRequire.resolve("expo-unified-push");
    const m = new Module(resolved) as NodeModule;
    m.filename = resolved;
    m.loaded = true;
    m.exports = {
      default: {
        getDistributors: () => [{ id: STUB_DISTRIBUTOR, name: "UP stub" }],
        getSavedDistributor: () => STUB_DISTRIBUTOR,
        saveDistributor: (...args: unknown[]) => { calls.push({ fn: "saveDistributor", args }); },
        registerDevice: (...args: unknown[]) => {
          calls.push({ fn: "registerDevice", args });
          return Promise.resolve();
        },
        unregisterDevice: (...args: unknown[]) => { calls.push({ fn: "unregisterDevice", args }); },
      },
      subscribeDistributorMessages: (fn: (e: { action: string; data: Record<string, unknown> }) => void) => {
        listeners.push(fn);
        return () => { listeners.splice(listeners.indexOf(fn), 1); };
      },
    };
    nodeRequire.cache[resolved] = m;
    const fire = (action: string, data: Record<string, unknown>): void => {
      for (const fn of [...listeners]) fn({ action, data });
    };
    return { calls, fire };
  }

  it("the instance reaches registerDevice, and ANOTHER instance's `registered` is ignored", async () => {
    const native = seedDrivable();
    mocks.platform.OS = "android";
    vi.resetModules();
    const mod = await import("../src/net/unified-push");

    const pending = mod.unifiedPushDistributor().register("B".repeat(87), "p-home");
    // THE INSTANCE IS PASSED. Without it the connector mints one endpoint for the whole app.
    const reg = native.calls.filter((c) => c.fn === "registerDevice");
    expect(reg).toHaveLength(1);
    expect(reg[0]!.args).toEqual(["B".repeat(87), "p-home"]);

    // The OTHER pairing's events land on this subscription too, and must pass straight through.
    native.fire("registered", { url: "https://dist.example/work", pubKey: "k", auth: "a", instance: "p-work" });
    native.fire("registrationFailed", { reason: "nope", instance: "p-work" });
    // …and then this one's, which is what settles it.
    native.fire("registered", { url: "https://dist.example/home", pubKey: "K", auth: "A", instance: "p-home" });

    expect(await pending).toEqual({
      endpoint: "https://dist.example/home", keys: { p256dh: "K", auth: "A" },
    });
  });

  it("another instance's registrationFailed does not report THIS registration as declined", async () => {
    const native = seedDrivable();
    vi.resetModules();
    const mod = await import("../src/net/unified-push");
    const pending = mod.unifiedPushDistributor().register("B".repeat(87), "p-home");
    native.fire("registrationFailed", { reason: "no distributor service", instance: "p-work" });
    native.fire("registered", { url: "https://dist.example/home", instance: "p-home" });
    // A distributor with no encrypted profile hands back a URL alone — the plaintext arm.
    expect(await pending).toEqual({ endpoint: "https://dist.example/home" });
  });

  it("unregister names its own instance and nothing else", async () => {
    const native = seedDrivable();
    vi.resetModules();
    const mod = await import("../src/net/unified-push");
    await mod.unifiedPushDistributor().unregister("p-home");
    expect(native.calls.filter((c) => c.fn === "unregisterDevice").map((c) => c.args))
      .toEqual([["p-home"]]);
  });

  it("a wake for ANOTHER pairing does not start this one's sync — and a legacy one still does", async () => {
    const native = seedDrivable();
    vi.resetModules();
    const mod = await import("../src/net/unified-push");
    let woke = 0;
    const off = mod.onWake("p-home", () => { woke += 1; });

    // The other pairing's wake. Before the instance was read, this synced whatever was live.
    native.fire("message", { message: mod.WAKE_PAYLOAD, decrypted: true, instance: "p-work" });
    expect(woke).toBe(0);

    // This pairing's wake.
    native.fire("message", { message: mod.WAKE_PAYLOAD, decrypted: true, instance: "p-home" });
    expect(woke).toBe(1);

    // AND THE LEGACY ARM, which is a decision rather than an oversight: an install upgrading from
    // the shared-endpoint build can have a wake in flight that names no instance, and dropping it
    // would lose a real wake on the one launch where that is hardest to explain.
    native.fire("message", { message: mod.WAKE_PAYLOAD, decrypted: true });
    expect(woke).toBe(2);

    // An UNDECRYPTED payload is still nothing to act on, whatever it names.
    native.fire("message", { message: mod.WAKE_PAYLOAD, decrypted: false, instance: "p-home" });
    expect(woke).toBe(2);
    off();
  });

  it("the legacy SHARED registration is dropped exactly once, on the first register", async () => {
    /**
     * A phone upgrading from the previous build holds a registration under the connector's DEFAULT
     * instance, and every server it paired with has a row against that one endpoint. Nothing left
     * on the phone can name those rows — the subscription ids lived in one provider's ref — so the
     * only way they are ever pruned is the phone stopping answering that endpoint.
     */
    const native = seedDrivable();
    vi.resetModules();
    const mod = await import("../src/net/unified-push");
    mod.resetLegacyDropForTests();
    const d = mod.unifiedPushDistributor();

    void d.register("B".repeat(87), "p-home");
    void d.register("B".repeat(87), "p-work");

    const drops = native.calls.filter((c) => c.fn === "unregisterDevice");
    // ONE drop, naming no instance — the default. Twice would be harmless and would mean the
    // latch had stopped working, which is worth knowing before it becomes a per-register call.
    expect(drops.map((c) => c.args)).toEqual([[]]);
  });
});

describe("the platform gate sits in FRONT of the native require", () => {
  afterEach(() => {
    delete nodeRequire.cache[nodeRequire.resolve("expo-unified-push")];
    delete nodeRequire.cache[nodeRequire.resolve("expo")];
    mocks.platform.OS = "android";
    vi.resetModules();
  });

  it("iOS never asks for the module — with a WORKING one seeded, every answer is still none", async () => {
    seedNativeModule();
    mocks.platform.OS = "ios";
    vi.resetModules();
    const mod = await import("../src/net/unified-push");

    // Each of these would carry the stub's value if the require had been reached.
    expect(mod.savedDistributor()).toBeNull();
    expect(mod.listDistributors()).toEqual([]);
    expect(mod.unifiedPushDistributor().available()).toBe(false);
    await expect(mod.unifiedPushDistributor().register("B".repeat(87), "p-1")).resolves.toBeNull();
    await expect(mod.unifiedPushDistributor().unregister("p-1")).resolves.toBeUndefined();
    await expect(mod.requestNotificationPermission()).resolves.toBeUndefined();
    expect(() => { mod.onWake("p-1", () => { throw new Error("must not be called"); })(); }).not.toThrow();
  });

  it("Android still reaches it — the gate is a platform test, not a removal", async () => {
    seedNativeModule();
    mocks.platform.OS = "android";
    vi.resetModules();
    const mod = await import("../src/net/unified-push");

    expect(mod.savedDistributor()).toBe(STUB_DISTRIBUTOR);
    expect(mod.listDistributors()).toEqual([
      { id: STUB_DISTRIBUTOR, name: "UP stub", saved: true },
    ]);
    expect(mod.unifiedPushDistributor().available()).toBe(true);
  });

  it("every non-Android platform is refused, not just iOS", async () => {
    for (const os of ["ios", "web", "macos", "windows"]) {
      seedNativeModule();
      mocks.platform.OS = os;
      vi.resetModules();
      const mod = await import("../src/net/unified-push");
      expect(mod.savedDistributor(), `${os} reached the native require`).toBeNull();
      delete nodeRequire.cache[nodeRequire.resolve("expo-unified-push")];
      delete nodeRequire.cache[nodeRequire.resolve("expo")];
    }
  });

  it("an app built without the push connector never loads its package, a working one seeded or not", async () => {
    seedNativeModule();
    seedNativePresence(false);
    mocks.platform.OS = "android";
    vi.resetModules();
    const mod = await import("../src/net/unified-push");
    expect(mod.savedDistributor()).toBeNull();
    expect(mod.listDistributors()).toEqual([]);
    expect(mod.unifiedPushDistributor().available()).toBe(false);
  });
});
