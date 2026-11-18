/**
 * THE BRIDGE'S GUARD. Native reads nothing of a message the guard has not named: a request of a
 * known kind whose fields have their types, or a refusal. A path is root-relative or refused.
 */
import { describe, expect, it } from "vitest";
import { NOTICE_COUNT_MAX, PATH_MAX, PIECE_BYTES, readNotice, readRequest } from "../src/shell/bridge-kinds";
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

/**
 * WHETHER THE WAKE IS WANTED CROSSES AS ONE BOOLEAN. Native keeps or takes down a pairing's wake registration by
 * it, so the act is as closed as the one that draws: exactly its own key, and one of the two booleans.
 */
describe("the page's word on its wake registration", () => {
  const want = (more: object) => readRequest({ ...head, kind: "act", act: "wake.want", ...more });
  const MALFORMED = { refused: "malformed" };

  it("admits each of the two booleans", () => {
    expect(want({ wanted: true })).toMatchObject({ kind: "act", act: "wake.want", wanted: true });
    expect(want({ wanted: false })).toMatchObject({ kind: "act", act: "wake.want", wanted: false });
  });

  it("refuses a word for a boolean, a number, nothing at all, and a value only inherited", () => {
    for (const wanted of ["true", "false", "off", 0, 1, null, undefined, [], {}]) {
      expect(want({ wanted }), String(wanted)).toEqual(MALFORMED);
    }
    expect(want({})).toEqual(MALFORMED);
    const inherited = Object.assign(Object.create({ wanted: true }) as object, { ...head, kind: "act", act: "wake.want" });
    expect(readRequest(inherited)).toEqual(MALFORMED);
  });

  it("refuses a key beside its own: an endpoint, an instance, a pairing, a distributor", () => {
    for (const spare of ["endpoint", "instance", "pairing", "profile", "distributor", "account", "url", "id2", "notice"]) {
      expect(want({ wanted: false, [spare]: "x" }), spare).toEqual(MALFORMED);
    }
    expect(want({ wanted: true, [Symbol("spare")]: 1 })).toEqual(MALFORMED);
  });
});

/**
 * A MAIL NOTICE CROSSES AS CLOSED RECORDS. What the page hands native for a notice is a kind with
 * exactly its own members: a whole number, or words of a list. Each arm below changes one thing of a
 * notice the guard admits, so each fails for its own reason.
 */
describe("the notice a page may ask native to draw", () => {
  const post = (notice: unknown, more: object = {}) =>
    readRequest({ ...head, kind: "act", act: "notices.post", notice, ...more });
  const MALFORMED = { refused: "malformed" };
  const ADMITTED: object[] = [
    { kind: "ohbox", count: 1 },
    { kind: "ohbox", count: NOTICE_COUNT_MAX },
    { kind: "screener", count: 3 },
    { kind: "pairing", change: "paired", device: "phone" },
    { kind: "pairing", change: "revoked", device: "desktop" },
    { kind: "pairing", change: "paired", device: "browser" },
    { kind: "pairing", change: "revoked", device: null },
  ];

  it("admits each kind this phone draws, with exactly its own members", () => {
    for (const notice of ADMITTED) {
      expect(post(notice), JSON.stringify(notice)).toMatchObject({ kind: "act", act: "notices.post" });
      expect(readNotice(notice), JSON.stringify(notice)).toEqual(notice);
    }
  });

  it("hands native a copy that holds the kind's members and nothing the page's object held beside them", () => {
    const fromPage = { kind: "ohbox", count: 2 };
    const copy = readNotice(fromPage);
    expect(copy).toEqual({ kind: "ohbox", count: 2 });
    expect(copy).not.toBe(fromPage);
    // A member read once: what was judged is what is handed on, whatever the page's object answers a second time.
    let reads = 0;
    const shifting = { kind: "ohbox", get count() { reads += 1; return reads === 1 ? 4 : "a letter's subject"; } };
    expect(readNotice(shifting)).toEqual({ kind: "ohbox", count: 4 });
  });

  it("refuses a string where a word belongs", () => {
    for (const notice of [
      { kind: "pairing", change: "paired", device: "Dana's phone" },
      { kind: "pairing", change: "a device paired with your account", device: "phone" },
      { kind: "pairing", change: "paired", device: "" },
      { kind: "pairing", change: "", device: null },
    ]) {
      expect(post(notice), JSON.stringify(notice)).toEqual(MALFORMED);
      expect(readNotice(notice), JSON.stringify(notice)).toBeNull();
    }
  });

  it("refuses a string, a fraction or a number out of range where a count belongs", () => {
    for (const count of ["3", "three new letters", 0, -1, 1.5, NOTICE_COUNT_MAX + 1, 1e21, null, true, [3], { n: 3 }, undefined]) {
      expect(post({ kind: "ohbox", count }), String(count)).toEqual(MALFORMED);
      expect(post({ kind: "screener", count }), String(count)).toEqual(MALFORMED);
    }
  });

  it("refuses a spare field, on the notice and on the act", () => {
    for (const spare of ["subject", "sender", "from", "title", "body", "text", "label", "tag", "url", "outcome", "id"]) {
      for (const notice of ADMITTED) {
        expect(post({ ...notice, [spare]: "Invoice 4471 is overdue" }), spare).toEqual(MALFORMED);
        expect(readNotice({ ...notice, [spare]: 1 }), spare).toBeNull();
      }
      expect(post({ kind: "ohbox", count: 1 }, { [spare]: "Invoice 4471 is overdue" }), `act.${spare}`).toEqual(MALFORMED);
    }
    // A member another kind owns is a spare field here.
    expect(post({ kind: "ohbox", count: 1, change: "paired" })).toEqual(MALFORMED);
    expect(post({ kind: "pairing", change: "paired", device: null, count: 1 })).toEqual(MALFORMED);
    // As the page's own text would carry one: a key that names the object's prototype is a key like any other.
    expect(readNotice(JSON.parse('{"kind":"ohbox","count":1,"__proto__":{"subject":"x"}}'))).toBeNull();
    expect(readNotice(Object.assign({ kind: "ohbox", count: 1 }, { [Symbol("subject")]: "x" }))).toBeNull();
  });

  it("refuses a word that is not on its list", () => {
    for (const notice of [
      // A send that waited for its time is not carried on the phone.
      { kind: "scheduled", outcome: "sent", count: 1 },
      { kind: "cal_alert", count: 1 },
      { kind: "newMail", count: 1 },
      { kind: "toString", count: 1 },
      { kind: "__proto__", count: 1 },
      { kind: "pairing", change: "renamed", device: "phone" },
      { kind: "pairing", change: "signed_out", device: "phone" },
      { kind: "pairing", change: "paired", device: "tablet" },
      { kind: "pairing", change: "paired", device: "constructor" },
    ]) {
      expect(post(notice), JSON.stringify(notice)).toEqual(MALFORMED);
      expect(readNotice(notice), JSON.stringify(notice)).toBeNull();
    }
  });

  it("refuses a notice with a member missing, and anything that is not a record", () => {
    for (const notice of [
      { kind: "ohbox" }, { kind: "pairing", change: "paired" }, { kind: "pairing", device: "phone" }, { count: 1 }, {},
      null, undefined, "ohbox", 3, [{ kind: "ohbox", count: 1 }], ["ohbox", 1],
    ]) {
      expect(post(notice), JSON.stringify(notice)).toEqual(MALFORMED);
      expect(readNotice(notice), JSON.stringify(notice)).toBeNull();
    }
    // A member the object only inherits is not its own.
    expect(readNotice(Object.create({ kind: "ohbox", count: 1 }))).toBeNull();
    expect(readNotice(Object.assign(Object.create({ count: 1 }), { kind: "ohbox" }))).toBeNull();
    // Also where a spare key of its own makes up the number: the count it only inherits is still not its own.
    expect(readNotice(Object.assign(Object.create({ count: 1 }), { kind: "ohbox", subject: "x" }))).toBeNull();
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
