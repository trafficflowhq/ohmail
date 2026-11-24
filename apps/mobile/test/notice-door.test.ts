/**
 * THE ACT `notices.post`, FROM THE PAGE'S BRIDGE TO THE NATIVE POSTER'S ARGUMENTS, PER PHONE. Over the real page
 * bridge, the real native host with its guard, and the real door; the native module is a recorder. Android's mail
 * app draws; the iPhone answers `unsupported` and asks its native side nothing; and nothing is drawn while the app
 * is in front, without the system's permission, or for a session that no longer stands.
 */
import { describe, expect, it } from "vitest";
import { noticeDoor, noticeKindsHere } from "../src/notices/notice-door";
import { posterArgs } from "../src/notices/notices-port";
import { BRIDGE_NOTICE_KINDS, type NoticePermission, type ShellApp } from "../src/shell/bridge-kinds";
import { BridgeRefused } from "../web/src/bridge";
import { A, pageOver, phone, post, recordingNative } from "./helpers/notice-phone";

describe("a mail notice the page asks the phone to draw", () => {
  it("is drawn by Android's mail app, handed as the pairing, a kind's word, a number and closed words", async () => {
    const p = phone();
    const bridge = pageOver(p.deps);
    await expect(post(bridge, { kind: "ohbox", count: 3 })).resolves.toEqual({ notice: "posted" });
    await expect(post(bridge, { kind: "screener", count: 1 })).resolves.toEqual({ notice: "posted" });
    await expect(post(bridge, { kind: "pairing", change: "paired", device: "phone" })).resolves.toEqual({ notice: "posted" });
    await expect(post(bridge, { kind: "pairing", change: "revoked", device: null })).resolves.toEqual({ notice: "posted" });
    expect(p.posts).toEqual([
      [A, "ohbox", 3, null, null],
      [A, "screener", 1, null, null],
      [A, "pairing", 0, "paired", "phone"],
      [A, "pairing", 0, "revoked", null],
    ]);
    // Every argument is the pairing, a listed word, a whole number or nothing: no place for a sentence.
    const WORDS = new Set<unknown>([A, ...BRIDGE_NOTICE_KINDS, "paired", "revoked", "desktop", "phone", "browser", null]);
    for (const args of p.posts) {
      expect(args).toHaveLength(5);
      for (const arg of args) expect(typeof arg === "number" ? Number.isInteger(arg) : WORDS.has(arg), String(arg)).toBe(true);
    }
  });

  it("answers unsupported on the iPhone and draws nothing, with a working poster seeded", async () => {
    const p = phone({ platform: "ios" });
    const bridge = pageOver(p.deps, "ohmail-shell://app");
    for (const notice of [
      { kind: "ohbox", count: 3 }, { kind: "screener", count: 1 }, { kind: "pairing", change: "paired", device: "phone" },
    ]) {
      await expect(post(bridge, notice)).resolves.toEqual({ notice: "unsupported" });
    }
    expect(p.posts).toEqual([]);
    expect(noticeKindsHere(p.deps)).toEqual([]);
  });

  it("draws none in the calendar's app, on any other system, or in a build without the poster", async () => {
    for (const over of [
      { app: "ohcal" as ShellApp }, { platform: "web" }, { platform: "windows" }, { platform: "" }, { native: null },
    ]) {
      const p = phone(over);
      await expect(post(pageOver(p.deps), { kind: "ohbox", count: 3 }), JSON.stringify(over)).resolves.toEqual({ notice: "unsupported" });
      expect(p.posts, JSON.stringify(over)).toEqual([]);
      expect(noticeKindsHere(p.deps), JSON.stringify(over)).toEqual([]);
    }
    expect(noticeKindsHere(phone().deps)).toEqual(["ohbox", "screener", "pairing"]);
  });

  it("draws nothing the system has not let this app post", async () => {
    for (const permission of ["default", "denied", "unsupported"] as NoticePermission[]) {
      const p = phone({ permission: () => permission });
      await expect(post(pageOver(p.deps), { kind: "ohbox", count: 3 }), permission).resolves.toEqual({ notice: "denied" });
      expect(p.posts, permission).toEqual([]);
    }
  });

  it("draws nothing while the app is the one being looked at", async () => {
    const p = phone({ inFront: () => true });
    await expect(post(pageOver(p.deps), { kind: "ohbox", count: 3 })).resolves.toEqual({ notice: "inFront" });
    expect(p.posts).toEqual([]);
  });

  it("draws nothing for a session that no longer stands, or for a pairing whose id is not one", async () => {
    let standing = true;
    const p = phone({ live: () => standing });
    const bridge = pageOver(p.deps);
    await expect(post(bridge, { kind: "ohbox", count: 1 })).resolves.toEqual({ notice: "posted" });
    // Signed out, or switched to another pairing: the page of the one left may still be asking.
    standing = false;
    await expect(post(bridge, { kind: "ohbox", count: 2 })).resolves.toEqual({ notice: "denied" });
    expect(p.posts).toEqual([[A, "ohbox", 1, null, null]]);

    for (const instance of ["", "default", "0b9f2c1e-7d4a-4c1b-9e3f-5a6b7c8d9e0f", `${A}\n`]) {
      const q = phone({ instance });
      await expect(post(pageOver(q.deps), { kind: "ohbox", count: 1 }), instance).resolves.toEqual({ notice: "denied" });
      expect(q.posts, instance).toEqual([]);
    }
  });

  it("runs nothing for a notice that does not read closed, at the guard and again at the door", async () => {
    const p = phone();
    const bridge = pageOver(p.deps);
    for (const notice of [
      { kind: "ohbox", count: 1, subject: "Invoice 4471 is overdue" },
      { kind: "pairing", change: "paired", device: "Dana's phone" },
      { kind: "scheduled", outcome: "sent", count: 1 },
      { kind: "ohbox", count: "3" },
    ]) {
      await expect(post(bridge, notice), JSON.stringify(notice)).rejects.toEqual(new BridgeRefused("malformed"));
      // The door is the last reader before native: it refuses what the guard refuses, were it ever handed it.
      await expect(noticeDoor(p.deps).post(notice), JSON.stringify(notice)).resolves.toEqual({ refused: "malformed" });
    }
    expect(p.posts).toEqual([]);
  });

  it("answers denied, and takes nothing down, when native draws nothing or fails", async () => {
    const refusing = recordingNative(() => false);
    await expect(post(pageOver(phone({ native: refusing.native }).deps), { kind: "ohbox", count: 1 })).resolves.toEqual({ notice: "denied" });
    const failing = recordingNative(() => { throw new Error("no channel"); });
    await expect(post(pageOver(phone({ native: failing.native }).deps), { kind: "ohbox", count: 1 })).resolves.toEqual({ notice: "denied" });
  });

  it("hands the poster every kind the bridge carries", () => {
    expect(BRIDGE_NOTICE_KINDS.map((kind) => posterArgs(
      kind === "pairing" ? { kind, change: "paired", device: "desktop" } : { kind, count: 7 },
    )[0])).toEqual([...BRIDGE_NOTICE_KINDS]);
  });
});
