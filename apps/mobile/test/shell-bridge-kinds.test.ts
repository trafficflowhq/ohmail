/**
 * THE BRIDGE'S GUARD. Native reads nothing of a message the guard has not named: a request of a
 * known kind whose fields have their types, or a refusal. A path is root-relative or refused.
 */
import { describe, expect, it } from "vitest";
import { PATH_MAX, PIECE_BYTES, readRequest } from "../src/shell/bridge-kinds";
import { decodePlace, encodePlace, isSwitchPlace, type SwitchPlace } from "../src/switch/place";

const head = { id: 7, epoch: "e1" };
const http = (path: unknown, more: object = {}) =>
  readRequest({ ...head, kind: "http", scope: "p0", method: "GET", path, headers: [], body: null, ...more });

describe("the bridge's guard", () => {
  it("refuses a kind it does not know, and a message that is no request", () => {
    expect(readRequest({ ...head, kind: "sql", text: "select 1" })).toEqual({ refused: "unknownKind" });
    expect(readRequest({ ...head, kind: "pairLink", url: "ohmail://pair" })).toEqual({ refused: "unknownKind" });
    expect(readRequest({ ...head, kind: "toString" })).toEqual({ refused: "unknownKind" });
    for (const raw of [null, "config", 3, { kind: "config" }, { ...head, id: -1, kind: "config" }, { ...head, epoch: "", kind: "config" }]) {
      expect(readRequest(raw)).toEqual({ refused: "malformed" });
    }
  });

  it("admits a root-relative path and refuses every path that names another place", () => {
    expect(http("/sync?since=4")).toMatchObject({ kind: "http", path: "/sync?since=4" });
    expect(http("/messages/a1/body")).toMatchObject({ kind: "http" });
    for (const path of [
      "https://elsewhere.example/sync", "//elsewhere.example/sync", "sync", "/\\elsewhere", "/a/../pair", "/./sync",
      "/a/%2e%2e/pair", "/a%2fb", "/a%5Cb", "/sync\n", "/sync\u0000", "/" + "a".repeat(PATH_MAX), "", 42,
    ]) {
      expect(http(path), JSON.stringify(path)).toEqual({ refused: "malformed" });
    }
  });

  it("refuses a request whose fields do not have their types", () => {
    expect(http("/sync", { method: "TRACE" })).toEqual({ refused: "malformed" });
    expect(http("/sync", { headers: [["a"]] })).toEqual({ refused: "malformed" });
    expect(http("/sync", { body: { as: "file", path: "/data" } })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, kind: "act", act: "openLink", url: "https://x.example" })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, kind: "act", act: "chrome", scheme: "neon" })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, kind: "act", act: "chrome", scheme: "dark" })).toMatchObject({ kind: "act" });
    expect(readRequest({ ...head, kind: "note", what: "the reader opened a letter from x", n: 1 })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, kind: "note", what: "mounted", n: 1 })).toMatchObject({ kind: "note" });
    expect(readRequest({ ...head, kind: "answer", askId: 1, what: "back", took: "yes" })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, kind: "keep", key: "k", value: 3 })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, kind: "keep", key: "k", value: null })).toMatchObject({ kind: "keep" });
  });

  it("never sees a piece: the native module joins them before the guard reads the whole", () => {
    expect(readRequest({ ...head, kind: "piece", seq: 0, chunk: "x".repeat(PIECE_BYTES) })).toEqual({ refused: "unknownKind" });
    expect(readRequest({ ...head, kind: "joined", count: 2 })).toEqual({ refused: "unknownKind" });
  });
});

describe("the switch's three kinds", () => {
  const EVENT = "0b9f2c1e-7d4a-4c1b-9e3f-5a6b7c8d9e0f";
  const open = (to: unknown, app: "ohmail" | "ohcal" | null) => readRequest({ ...head, kind: "switch.open", to }, app);

  it("admits the presence read and the store, which carry nothing", () => {
    expect(readRequest({ ...head, kind: "switch.read" })).toMatchObject({ kind: "switch.read" });
    expect(readRequest({ ...head, kind: "switch.store" })).toMatchObject({ kind: "switch.store" });
  });

  it("opens the other app only at a place of this app's direction", () => {
    expect(open({ to: "last" }, "ohmail")).toMatchObject({ kind: "switch.open", to: { to: "last" } });
    expect(open({ to: "event", id: EVENT }, "ohmail")).toMatchObject({ to: { to: "event", id: EVENT } });
    expect(open({ to: "message", id: EVENT }, "ohcal")).toMatchObject({ to: { to: "message", id: EVENT } });
    // The other way round is malformed: ohmail never names a letter to the calendar, nor ohcal an event to the mail.
    expect(open({ to: "message", id: EVENT }, "ohmail")).toEqual({ refused: "malformed" });
    expect(open({ to: "event", id: EVENT }, "ohcal")).toEqual({ refused: "malformed" });
  });

  it("refuses every place when the guard is not told which app it runs in", () => {
    expect(open({ to: "last" }, null)).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, kind: "switch.open", to: { to: "last" } })).toEqual({ refused: "malformed" });
  });

  it("refuses a place that is not one of the three shapes, or carries anything more", () => {
    for (const to of [
      undefined, null, "last", { to: "home" }, { to: "event" }, { to: "event", id: "e1" }, { to: "event", id: `${EVENT}x` },
      { to: "event", id: "../pair" }, { to: "last", origin: "https://elsewhere.example" },
      { to: "event", id: EVENT, token: "t".repeat(43) }, [{ to: "last" }],
    ]) {
      expect(open(to, "ohmail"), JSON.stringify(to)).toEqual({ refused: "malformed" });
    }
  });
});

describe("the switch's place as one word", () => {
  const ID = "0b9f2c1e-7d4a-4c1b-9e3f-5a6b7c8d9e0f";

  it("goes and comes back whole, judged as its sender sent it", () => {
    const places: [SwitchPlace, "ohmail" | "ohcal"][] = [
      [{ to: "last" }, "ohmail"], [{ to: "event", id: ID }, "ohmail"], [{ to: "message", id: ID }, "ohcal"],
    ];
    for (const [place, from] of places) expect(decodePlace(encodePlace(place), from)).toEqual(place);
    expect(encodePlace({ to: "event", id: ID })).toBe(`event:${ID}`);
  });

  it("reads anything else as no place", () => {
    for (const word of ["", "home", `message:${ID}`, "event:", `event:${ID}:x`, "event:../x", 7, null, "x".repeat(65)]) {
      expect(decodePlace(word, "ohmail"), String(word)).toBeNull();
    }
    expect(decodePlace(`event:${ID}`, "ohcal")).toBeNull();
    expect(isSwitchPlace({ to: "last" }, "ohcal")).toBe(true);
  });
});
