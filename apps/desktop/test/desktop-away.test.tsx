/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import { ROSTER, storeWith, stubDom } from "../../webapp/test/_draft-shell";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { DesktopLocale } from "../src/DesktopLocale.js";
import { linkSlot } from "../src/link-in.js";
import { AWAY_PATH } from "../src/local-away.js";

vi.mock("../src/local-mailbox-facts", async () => ({
  ...await vi.importActual<typeof import("../src/local-mailbox-facts")>("../src/local-mailbox-facts"),
  readMailboxFacts: async () => ROSTER,
}));

/**
 * THE AWAY RESPONDER IN THE APP — available on the hosted door, absent on the standalone one.
 *
 * The control shipped in the browser and was missing here on BOTH doors, and only one of those two
 * absences was intended. The shared shell offers it when `apiConfigured()` says there is a server;
 * that is false in every desktop build, both doors, because `vite.config.ts` aliases the Cloud
 * client to a stub whose value exports refuse. So a hosted install — mirroring a real account, with
 * a hosted worker standing by to send — was told it had no away responder.
 *
 * ── WHAT MUST BE TRUE ────────────────────────────────────────────────────────────────────────
 *
 *  1. THE HOSTED DOOR GETS IT, over the pipe. The window cannot open a socket, so the proof is in
 *     the request that leaves: `GET`/`PUT /away-responder`, addressed root-relative, to the engine.
 *     The engine serves no such route locally in cloud mode and forwards it to the account with the
 *     bearer, which is what makes the row that is written the HOSTED account's own.
 *  2. IT IS THE SHARED CONTROL, not a copy. One `PUT /away-responder` whose `updatedAt` is the
 *     enablement episode the worker's at-most-once record is filed under; two implementations would
 *     be two definitions of when an episode begins, and the visible failure — one correspondent
 *     answered twice — would show up in somebody's mailbox rather than in a suite.
 *  3. THE STANDALONE DOOR GETS NOTHING, and that is structural rather than a refusal on press. The
 *     local engine would answer these routes perfectly well out of its own database; nothing on
 *     that door SENDS the reply, so a control there would store a configuration that answers
 *     nobody. `awayDoorFor` is where that rule lives.
 *  4. NOTHING REACHES THE CLOUD CLIENT. `fetch` is booby-trapped below: a control that fell back to
 *     the hosted client would throw rather than pass.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}
const host = globalThis as unknown as Host;

/** One answer, framed exactly as the shell frames one for the bridge. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked { method: string; url: string; body: Record<string, unknown> | null }

/** The account's stored row, as the hosted API would answer it through the engine's forward. */
let stored: Record<string, unknown>;
let asked: Asked[];
let holdRead: Promise<void> | null;

function engineAnswering(): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (_command, payload) => {
      const p = (payload ?? {}) as { method?: string; url?: string; body?: number[] };
      const raw = p.body && p.body.length > 0 ? new TextDecoder().decode(Uint8Array.from(p.body)) : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if ((p.url ?? "") !== AWAY_PATH) {
        return encode(404, JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
      }
      asked.push({ method: p.method ?? "GET", url: p.url ?? "", body });
      // The FULL REPLACE the hosted route performs, with a fresh `updatedAt` — the enablement
      // episode. Answered from what was stored, never from what was asked for.
      if ((p.method ?? "GET").toUpperCase() === "PUT") {
        stored = { ...(body ?? {}), updatedAt: "2026-08-07T12:00:00.000Z" };
      } else if (holdRead !== null) {
        await holdRead;
      }
      return encode(200, JSON.stringify(stored));
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

const noChange = () => undefined;
const ISO = "2026-08-07T12:00:00.000Z";

async function mountRow(at = "#/settings/away"): Promise<void> {
  stubDom();
  window.location.hash = at;
  const engine = new OhmailEngine({
    store: await storeWith([], []),
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: ISO,
      }),
      fetchBody: async () => ({
        text: "", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unreachable" }),
    },
  });
  const props: DesktopFrameProps = {
    engine, status: { state: "serving", mode: "cloud" }, session: "live", sessionRefused: false,
    sealFailed: false, paired: false, hostLabel: null, freshness: null, account: "account",
    storage: null, mayLinkOut: false, manageOffered: false, withdrawManage: noChange,
    rereadAccess: noChange, reuseSweeps: [], recheckSweeps: async () => undefined, ai: null,
    setAi: noChange, onStatus: noChange, openOverlay: noChange, takeOver: noChange,
    firstRunOpen: false, firstRun: undefined, takesMailLinks: true, scope: "account",
    onUnread: noChange, liveBody: async () => ({ kind: "refused", reason: "gone" }),
    links: linkSlot(), connection: { read: () => null, subscribe: () => noChange },
  };
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(h(DesktopLocale, {
      children: h(ThemeProvider, { children: h(ToastHost, { children: h(DesktopFrame, props) }) }),
    }));
  });
  const label = at === "#/settings/away" ? messages.settings.away : messages.settings.general;
  await within(hostEl).findByRole("region", { name: label });
  await act(async () => {});
}

const away = () => within(within(hostEl).getByRole("region", { name: messages.settings.away }));
const message = () => away().getByRole<HTMLTextAreaElement>("textbox", { name: messages.away.bodyLabel });

/** React's controlled inputs ignore a plain `.value=`; go through the native setter. */
function setNative(el: HTMLInputElement | HTMLTextAreaElement, v: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  asked = [];
  holdRead = null;
  stored = {
    enabled: false, body: null, startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", updatedAt: null,
  };
  engineAnswering();
  /* BOOBY TRAP. Nothing on this path may reach the hosted client: this window's `connect-src`
     admits no address off this machine and the packaged bundle has no API client at all. A fallback to it would
     land here rather than passing quietly. */
  vi.stubGlobal("fetch", async () => {
    throw new Error("the desktop window opened a socket — nothing here may reach the network");
  });
});

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  hostEl?.remove();
  delete host.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the away responder on the hosted door", () => {
  it("reads the account's row over the pipe, and draws the stored state", async () => {
    stored = { ...stored, enabled: true, body: "Back Monday.", audience: "everyone", throttle: "per_week" };
    const waiting = Promise.withResolvers<void>();
    holdRead = waiting.promise;
    await mountRow();
    const read = { method: "GET", url: AWAY_PATH, body: null };
    await vi.waitFor(() => expect(asked).toEqual([read]));
    await act(async () => { waiting.resolve(); });
    expect(message().value).toBe("Back Monday.");
    expect(asked).toEqual([read]);
    expect(away().getByRole("switch", { name: messages.away.title }).getAttribute("aria-checked")).toBe("true");
    // There is no subject to draw: the responder replies in the correspondent's own thread.
    expect(hostEl.querySelector("#away-subject")).toBeNull();
  });

  it("opens on the latest responder after the notice has read it", async () => {
    stored = { ...stored, body: "Old reply." };
    await mountRow("#/settings/general");
    await vi.waitFor(() => expect(asked.map(({ method }) => method)).toEqual(["GET"]));

    stored = { ...stored, enabled: true, body: "Newer reply.", audience: "everyone", updatedAt: ISO };
    await act(async () => {
      window.location.hash = "#/settings/away";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(asked.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(message().value).toBe("Newer reply.");
    await click(away().getByRole("switch", { name: messages.away.title }));
    await click(away().getAllByRole("button", { name: "Save", exact: true })[0]!);
    expect(asked.filter(({ method }) => method === "PUT").map(({ body }) => body)).toEqual([
      { enabled: false, body: "Newer reply.", startsAt: null, endsAt: null, audience: "everyone",
        throttle: "per_day", piles: ["INBOX"] },
    ]);
  });

  it("saves the whole row in ONE explicit PUT — one press, one enablement episode", async () => {
    await mountRow();
    await click(away().getByRole("switch", { name: messages.away.title }));
    await act(async () => { setNative(message(), "Back Monday."); });
    const [save] = away().getAllByRole("button", { name: "Save", exact: true });
    await click(save!);

    const puts = asked.filter((a) => a.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(AWAY_PATH);
    // A FULL REPLACE, every field named — the route stores what it is handed. A partial body would
    // blank the fields it omitted on a row somebody had already filled in.
    //
    // `piles` IS ONE OF THOSE FIELDS, and that is why it is named here rather than allowed to be
    // absent. Mail 0096 gave the responder a pile scope whose column default is the narrow
    // `{INBOX}`, and this endpoint is a full replace: a client that sent the other six fields and
    // omitted this one would reset somebody's Reads opt-in on every unrelated save — a body edit,
    // or the save that turns the responder off. The migration's own docblock says exactly that of
    // an API one deploy older. So the pane sends the scope it is showing.
    //
    // The value is written as a LITERAL rather than imported from `AWAY_PILES_DEFAULT`: this
    // assertion is about the bytes on the wire, and a default widened to include `ohmail/News`
    // would opt every existing responder into Reads without anybody asking — the defect that
    // migration exists to close. Against the constant this test would go green for it.
    expect(puts[0]!.body).toEqual({
      enabled: true, body: "Back Monday.",
      startsAt: null, endsAt: null, audience: "screened_in", throttle: "per_day",
      piles: ["INBOX"],
    });
    expect(hostEl.textContent).toContain("Saved.");
    // One read at open, shared by the notice and the pane; the save draws the PUT's own echo, with no read after it.
    expect(asked.map(({ method }) => method)).toEqual(["GET", "PUT"]);
  });

  it("says so when the account cannot be reached, rather than leaving its pane blank", async () => {
    // `503 offline_read_only` — what the engine answers before it forwards anything while the
    // hosted account is out of reach. As the Screener pane's last row this could draw nothing; as
    // a pane of its own, nothing is a nav entry onto an empty rectangle.
    host.__TAURI_INTERNALS__ = {
      invoke: async () => encode(503, JSON.stringify({
        error: { code: "offline_read_only", message: "this install is offline" },
      })),
    };
    await mountRow();
    await vi.waitFor(() => expect(hostEl.textContent).toContain("could not be read"));
    // Still no controls: a resting OFF switch shown to somebody whose responder is ON would be a
    // lie about mail going out.
    expect(away().queryByRole("switch", { name: messages.away.title })).toBeNull();
  });
});
