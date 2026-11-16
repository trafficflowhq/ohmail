/**
 * THE BRIDGE'S GUARD. Native reads nothing of a message the guard has not named: a request of a
 * known kind whose fields have their types, or a refusal. A path is root-relative or refused.
 */
import { describe, expect, it } from "vitest";
import { PATH_MAX, PIECE_BYTES, readRequest } from "../src/shell/bridge-kinds";

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
