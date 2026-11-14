/**
 * FOR WHOM A NOTICE IS DRAWN ON THE PHONE: only for the pairing that is signed in.
 *
 *  · which pairing the phone keeps as the signed-in one, at sign-in, at sign-out and at a switch: the connection's
 *    readings in, what the native side is told out;
 *  · the rule itself, over one table (`live-instance-cases.json`): the signed-in instance, another instance, no
 *    instance, a signed-out phone, an instance of a different shape;
 *  · the Kotlin that carries the rule into the wake's renderer, read as the text the plugin writes: where the gate
 *    is asked, where the kept pairing is read from, and what the wake's instance reaches.
 *
 * THE KOTLIN GATE ITSELF is proven on a JVM, not here: the plugin's `gateSource` compiled with the Kotlin compiler
 * and run over the same table. That run and the emulator's legs are in the lane's handover (owed proofs); a unit
 * case cannot run Kotlin, and only a phone shows the renderer drawing or not drawing.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LiveInstanceKeeper, signedInOf, type ConnectionKind, type SignedIn } from "../src/notices/live-instance";
import { isInstance, mayDrawFor, type NoticesNative } from "../src/notices/notices-port";
import cases from "./live-instance-cases.json";

/** Two pairings, by their local ids. */
const A = "pmb3k2x9aq1z7";
const B = "pzz9k2x9aq1z7";

/** The native keeper as a recorder: every pairing it was told to keep, and what it answers. */
function recordingNative(answer: () => boolean | Promise<boolean> = () => true) {
  const lives: (string | null)[] = [];
  const native: Pick<NoticesNative, "setLive"> = {
    setLive: async (instance) => { lives.push(instance); return answer(); },
  };
  return { native, lives };
}

describe("which pairing the phone keeps as the signed-in one", () => {
  const live = (instance: string): SignedIn => ({ k: "live", instance });
  const NONE: SignedIn = { k: "none" };
  const PENDING: SignedIn = { k: "pending" };

  async function told(readings: SignedIn[], answer?: () => boolean | Promise<boolean>) {
    const made = recordingNative(answer);
    const keeper = new LiveInstanceKeeper(made.native);
    for (const reading of readings) keeper.see(reading);
    await keeper.settled();
    return made.lives;
  }

  it("keeps the pairing a session is live for, and leaves what the last run kept until this one knows", async () => {
    expect(await told([PENDING, PENDING])).toEqual([]);
    expect(await told([PENDING, PENDING, live(A)])).toEqual([A]);
    // Told once: the same pairing again is no news.
    expect(await told([PENDING, live(A), live(A)])).toEqual([A]);
  });

  it("keeps none once nobody is signed in: signed out, nothing paired, a session ended or refused", async () => {
    expect(await told([PENDING, live(A), NONE])).toEqual([A, null]);
    expect(await told([PENDING, NONE])).toEqual([null]);
    expect(await told([NONE, NONE])).toEqual([null]);
  });

  it("keeps none from the moment a pairing is left until the next one is live", async () => {
    expect(await told([PENDING, live(A), PENDING, live(B)])).toEqual([A, null, B]);
    // Left, and the next one never arrives: nothing is kept.
    expect(await told([PENDING, live(A), PENDING])).toEqual([A, null]);
    expect(await told([live(A), live(B)])).toEqual([A, B]);
  });

  it("keeps none for a pairing whose id is not one", async () => {
    for (const instance of ["", "default", `${A}\n`, "0b9f2c1e-7d4a-4c1b-9e3f-5a6b7c8d9e0f"]) {
      expect(await told([live(instance)]), instance).toEqual([null]);
    }
    expect(await told([live(A), live("default")])).toEqual([A, null]);
  });

  it("tells native in order, each telling after the one before it was answered", async () => {
    const order: string[] = [];
    let open: (() => void) | null = null;
    const slow: Pick<NoticesNative, "setLive"> = {
      setLive: (instance) => new Promise((done) => {
        order.push(`asked ${instance}`);
        const answer = () => { order.push(`answered ${instance}`); done(true); };
        if (instance === A) open = answer; else answer();
      }),
    };
    const keeper = new LiveInstanceKeeper(slow);
    keeper.see(live(A));
    keeper.see(PENDING);
    keeper.see(live(B));
    await Promise.resolve();
    expect(order).toEqual([`asked ${A}`]);
    open!();
    await keeper.settled();
    expect(order).toEqual([`asked ${A}`, `answered ${A}`, "asked null", "answered null", `asked ${B}`, `answered ${B}`]);
  });

  it("tells native again what it did not confirm", async () => {
    let answers = [false, true];
    expect(await told([live(A), live(A)], () => answers.shift() ?? true)).toEqual([A, A]);
    // A sign-out native failed to keep is told again at the next reading that says nobody is signed in.
    answers = [true, false, true];
    expect(await told([live(A), NONE, NONE], () => answers.shift() ?? true)).toEqual([A, null, null]);
    const throwing = [() => { throw new Error("no module"); }, () => true];
    expect(await told([live(A), live(A)], () => throwing.shift()!())).toEqual([A, A]);
  });

  it("asks nothing of a phone with no native keeper", async () => {
    const keeper = new LiveInstanceKeeper(null);
    keeper.see(live(A));
    keeper.see(NONE);
    await expect(keeper.settled()).resolves.toBeUndefined();
  });

  it("reads each state of the connection as signed in, nobody, or not known yet", () => {
    const session = { profile: { id: A } };
    const reads: Record<ConnectionKind, SignedIn> = {
      starting: PENDING, connecting: PENDING, idle: NONE, refused: NONE, ended: NONE, live: live(A), shell: live(A),
    };
    for (const k of Object.keys(reads) as ConnectionKind[]) {
      expect(signedInOf({ k, ...(k === "live" || k === "shell" ? { session } : {}) }), k).toEqual(reads[k]);
    }
    // A live state that names no pairing is nobody.
    expect(signedInOf({ k: "live" })).toEqual(NONE);
  });
});

describe("for whom a notice is drawn", () => {
  it("only for a pairing's own id", () => {
    for (const c of cases.instances) expect(isInstance(c.text), JSON.stringify(c.text)).toBe(c.is);
    for (const other of [null, undefined, 7, {}, [A]]) expect(isInstance(other)).toBe(false);
  });

  it("only while the kept pairing is the one the notice is for", () => {
    // The signed-in instance, another instance, no instance, a signed-out phone, an instance of a different shape.
    for (const c of cases.draws) expect(mayDrawFor(c.kept, c.instance), c.name).toBe(c.draw);
    for (const c of cases.rule) expect(mayDrawFor(c.kept, c.instance), JSON.stringify([c.kept, c.instance])).toBe(c.draw);
    expect(cases.draws.filter((c) => c.draw).map((c) => c.name)).toEqual(["the signed-in instance"]);
  });
});

describe("the wake's renderer asks the same rule, in the Kotlin it is built from", () => {
  const require = createRequire(import.meta.url);
  type Prebuilt = { mods: { android: { dangerous: (config: Record<string, unknown>) => Promise<unknown> } } };
  const plugin = require("../plugins/wake-push-renderer.js") as ((config: Record<string, unknown>) => Prebuilt) & {
    SOURCE: string; GATE_SOURCE: string; GATE_CLASS: string; LIVE_FILE: string; LIVE_HEAD: string;
    gateSource(pkg: string): string;
  };
  /** The emitted Kotlin without its comments, so what is asserted is what the code does. */
  const code = (kotlin: string) => kotlin.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const renderer = code(plugin.SOURCE);
  const body = renderer.slice(renderer.indexOf("override fun render("), renderer.indexOf("private fun postWakeNotification("));

  it("the notices' module carries the gate's text, equal but for its package", () => {
    const committed = readFileSync(fileURLToPath(new URL(
      "../modules/ohmail-notices/android/src/main/java/app/ohmail/notices/LiveInstanceGate.kt", import.meta.url,
    )), "utf8");
    expect(committed).toBe(plugin.gateSource("app.ohmail.notices"));
    expect(plugin.GATE_SOURCE).toBe(plugin.gateSource("app.ohmail.push"));
    expect(plugin.GATE_SOURCE.replace("package app.ohmail.push", "package app.ohmail.notices")).toBe(committed);
  });

  it("a prebuild writes the gate beside the renderer that asks it", async () => {
    // The plugin's own step, run over an empty Android project: what it writes is what Gradle compiles.
    const root = mkdtempSync(join(tmpdir(), "wake-renderer-"));
    try {
      mkdirSync(join(root, "app/src/main/java"), { recursive: true });
      const config = plugin({ name: "ohmail", slug: "ohmail", android: { package: "app.ohmail" } });
      await config.mods.android.dangerous({
        ...config, modResults: null,
        modRequest: { platformProjectRoot: root, projectRoot: root, platform: "android", modName: "dangerous", introspect: false },
      });
      const written = join(root, "app/src/main/java/app/ohmail/push");
      expect(readdirSync(written).sort()).toEqual([
        "LiveInstanceGate.kt", "WakeAppState.kt", "WakeInteractiveInitializer.kt", "WakePayloadRenderer.kt",
      ]);
      expect(readFileSync(join(written, "LiveInstanceGate.kt"), "utf8")).toBe(plugin.GATE_SOURCE);
      expect(readFileSync(join(written, "WakePayloadRenderer.kt"), "utf8")).toBe(plugin.SOURCE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the gate imports nothing and reads nothing but what it is handed", () => {
    const gate = code(plugin.GATE_SOURCE);
    expect(gate).not.toMatch(/^\s*import /m);
    expect(gate).not.toMatch(/Context|File\(|Regex|System\.|Log\./);
    expect(gate).toContain(`const val FILE = ${JSON.stringify(plugin.LIVE_FILE)}`);
    expect(gate).toContain(`const val HEAD = ${JSON.stringify(plugin.LIVE_HEAD)}`);
    // The rule itself: a closed app draws only for the kept pairing, and the kept file is read and written closed.
    expect(gate).toContain("kept != null && instance != null && isInstance(kept) && isInstance(instance) && kept == instance");
    expect(gate).toContain("if (lines == null || lines.size != 2 || lines[0] != HEAD) return null");
    expect(gate).toContain("return if (isInstance(lines[1])) lines[1] else null");
    expect(gate).toContain("if (instance != null && isInstance(instance)) listOf(HEAD, instance) else null");
  });

  it("the renderer asks the gate after the constant and before anything is posted", () => {
    const constant = body.indexOf("if (decrypted != WAKE_PAYLOAD) return null");
    const gate = body.indexOf(`if (!${plugin.GATE_CLASS}.mayDraw(keptInstance(context), instance)) return null`);
    const posted = body.indexOf("postWakeNotification(");
    expect(constant).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(constant);
    expect(posted).toBeGreaterThan(gate);
    // One way to a notice, and it is past the gate.
    expect(renderer.split("postWakeNotification(").length - 1).toBe(2);
    expect(renderer.split(".notify(").length - 1).toBe(1);
  });

  it("what is kept is read from the app's no-backup folder, bounded, and anything unreadable is nobody", () => {
    const kept = body.slice(body.indexOf("private fun keptInstance("));
    expect(kept).toContain(`File(context.applicationContext.noBackupFilesDir, ${plugin.GATE_CLASS}.FILE)`);
    expect(kept).toContain(`file.length() > ${plugin.GATE_CLASS}.MOST`);
    expect(kept).toContain(`${plugin.GATE_CLASS}.keptOf(file.readLines(Charsets.US_ASCII))`);
    expect(kept).toMatch(/catch \(t: Throwable\) \{\s*null\s*\}/);
  });

  it("the wake's instance reaches the gate and the notice's tag, and nothing a person reads", () => {
    const uses = renderer.split("\n").filter((line) => /\binstance\b/.test(line)).map((line) => line.trim());
    expect(uses).toEqual([
      "override fun render(context: Context, instance: String, decrypted: String): NotificationContent? {",
      `if (!${plugin.GATE_CLASS}.mayDraw(keptInstance(context), instance)) return null`,
      "postWakeNotification(context, instance)",
      "private fun postWakeNotification(context: Context, instance: String) {",
      "NotificationManagerCompat.from(ctx).notify(instance, NOTIFICATION_ID, builder.build())",
    ]);
    expect(renderer).not.toMatch(/setContent\w+\([^)]*instance|Log\.|println/);
  });
});
