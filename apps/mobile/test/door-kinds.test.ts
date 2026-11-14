/**
 * THE DOOR PAGE'S TABLE OF KINDS IS CLOSED AND ITS OWN. The guard reads a message before anything else does: a kind of
 * this table with its fields in their types and bounds, or a refusal. Nothing of the scoped page's bridge (a request
 * to a server, the keeper, the old copy, a device act) is a kind here, and nothing of the door is one there.
 */
import { describe, expect, it } from "vitest";
import { readRequest } from "../src/shell/bridge-kinds";
import { readDoorRequest, type DoorKind, type DoorRequests } from "../src/shell/door-kinds";

const TICKET = "0123456789abcdef0123456789abcdef";
const RECT = { x: 0, y: 120, w: 360, h: 360 };
const INPUT = { address: "ada@example.test", pass: "x", name: null, imap: { host: "imap.example.test", port: 993 }, smtp: null };

/** One well-formed ask per kind: a kind added to the table without its row here does not compile. */
const ASKS: { readonly [K in DoorKind]: DoorRequests[K]["ask"] } = {
  config: {}, ready: {}, leave: {}, sync: {}, disconnect: {},
  "server.ask": { address: "mail.example.test" },
  "scan.start": { rect: RECT }, "scan.move": { rect: RECT }, "scan.stop": {}, "camera.allow": {},
  hand: { address: null, token: "t" },
  pair: { ticket: TICKET }, dismiss: { ticket: TICKET },
  open: { input: INPUT },
  switch: { id: "row-1" }, "forget.ask": { id: "row-1" }, forget: { id: "row-1", anyway: false },
  "settings.open": { what: "notifications" },
  answer: { askId: 1, what: "back", took: true }, cancel: { of: 1 },
};
/** The door's envelope nests a kind's fields; the scoped page's carries them flat. */
const ask = (kind: string, fields: object) => ({ id: 1, epoch: "e1", kind, ask: fields });
const flat = (kind: string, fields: object) => ({ ...fields, id: 1, epoch: "e1", kind });

describe("the door page's guard", () => {
  it("reads every kind of its table, and refuses each when its envelope is not one", () => {
    for (const [kind, fields] of Object.entries(ASKS)) {
      expect(readDoorRequest(ask(kind, fields)), kind).toMatchObject({ kind });
      expect(readDoorRequest({ ...ask(kind, fields), id: -1 }), kind).toEqual({ refused: "malformed" });
      expect(readDoorRequest({ ...ask(kind, fields), epoch: "" }), kind).toEqual({ refused: "malformed" });
    }
    expect(readDoorRequest(null)).toEqual({ refused: "malformed" });
    expect(readDoorRequest("config")).toEqual({ refused: "malformed" });
    // A kind's fields beside the envelope's own, as the scoped page sends them, are not read: a row's id is not the request's.
    expect(readDoorRequest(flat("switch", { id: "row-1" }))).toEqual({ refused: "malformed" });
    expect(readDoorRequest({ id: 1, epoch: "e1", kind: "forget", anyway: false })).toEqual({ refused: "malformed" });
  });

  it("knows no kind of the scoped page: no request to a server, no keeper, no old copy, no device act", () => {
    const scoped: [string, object][] = [
      ["http", { scope: "p0", method: "GET", path: "/sync", headers: [], body: null }],
      ["keep", { key: "k", value: "v" }], ["kept", {}], ["keepRows", { scope: "p0", puts: [], deletes: [] }],
      ["keptRows", { scope: "p0" }], ["oldCopy.page", { scope: "p0", after: null }], ["oldCopy.done", { scope: "p0" }],
      ["act", { act: "signOut" }], ["place", { fragment: "#/" }], ["linkAskOpen", { token: "t" }],
      ["note", { what: "mounted", n: 1 }], ["switch.read", {}], ["switch.store", {}],
      ["switch.open", { to: { to: "last" } }],
    ];
    for (const [kind, fields] of scoped) {
      expect(readRequest(flat(kind, fields), "ohmail"), `${kind} is the scoped page's`).toMatchObject({ kind });
      expect(readDoorRequest(ask(kind, fields)), kind).toEqual({ refused: "unknownKind" });
      expect(readDoorRequest(flat(kind, fields)), kind).toEqual({ refused: "unknownKind" });
    }
    expect(readDoorRequest(ask("constructor", {}))).toEqual({ refused: "unknownKind" });
  });

  it("is unknown to the scoped page's guard in every kind that is the door's alone", () => {
    const shared = new Set(["config", "ready", "answer", "cancel"]);
    for (const [kind, fields] of Object.entries(ASKS)) {
      if (shared.has(kind)) continue;
      expect(readRequest(ask(kind, fields), "ohmail"), kind).toEqual({ refused: "unknownKind" });
    }
  });

  it("refuses a field of the wrong type or beyond its bound, kind by kind", () => {
    const bad: [DoorKind, object][] = [
      ["server.ask", { address: 7 }], ["server.ask", { address: "a".repeat(2049) }],
      ["scan.start", { rect: { ...RECT, w: -1 } }], ["scan.move", { rect: { ...RECT, x: Number.NaN } }],
      ["scan.start", { rect: [0, 0, 1, 1] }], ["scan.start", {}],
      ["hand", { address: null }], ["hand", { address: 3, token: "t" }], ["hand", { address: null, token: "t".repeat(4097) }],
      ["pair", { ticket: "0123" }], ["pair", { ticket: TICKET.toUpperCase() }], ["pair", { ticket: `${TICKET}0` }], ["pair", {}],
      ["dismiss", { ticket: 5 }],
      ["open", { input: { ...INPUT, pass: 1 } }], ["open", { input: { ...INPUT, pass: "p".repeat(1025) } }],
      ["open", { input: { ...INPUT, imap: { host: "h", port: 70000 } } }], ["open", { input: { ...INPUT, imap: { host: "h", port: "993" } } }],
      ["open", { input: { ...INPUT, smtp: "smtp.example.test" } }], ["open", { input: { ...INPUT, name: 4 } }], ["open", {}],
      ["switch", { id: "" }], ["switch", { id: 4 }], ["forget.ask", {}],
      ["forget", { id: "row-1" }], ["forget", { id: "row-1", anyway: "yes" }],
      ["settings.open", { what: "wifi" }],
      ["answer", { askId: 1, what: "unsent", unsent: 2 }], ["answer", { askId: 1, what: "back" }],
      ["cancel", { of: "1" }],
    ];
    for (const [kind, fields] of bad) {
      expect(readDoorRequest(ask(kind, fields)), `${kind} ${JSON.stringify(fields)}`).toEqual({ refused: "malformed" });
    }
  });
});
