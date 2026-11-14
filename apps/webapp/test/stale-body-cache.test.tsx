/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  type EngineAdapter,
  type EngineMessage,
  type MessageBodyRecord,
  type MessageBodyWire,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { MessageBody } from "../app/letter-body/MessageBody";
import {
  OWNER_BILLING_HTML,
  OWNER_BILLING_TEXT,
  OWNER_TRACKING_PIXEL,
} from "./fixtures/owner-billing-email";

/**
 * ── THE ACCEPTANCE FIXTURE, THROUGH THE MIRROR THE OWNER ACTUALLY HAD ───────
 *
 * One change shipped the html renderer and it reached the hosted service, and a user pasted the SAME
 * billing notice still rendering as a text dump whose last visible line is
 * `[url8792.mail.wolkenmail.example/wf/open?upn=…]` — a tracking pixel printed as prose.
 *
 * Three measurements before anything was changed, and the first two killed the obvious
 * explanations:
 *
 *   NOT A STALE DEPLOY.   The live `/_next/static/chunks/app/(product)/mailbox/page-*.js`
 *                         contains `allow-popups-to-escape-sandbox`, `data-ohmail-blocked` and
 *                         `default-src 'none'`. The renderer is in the reader's browser.
 *   NOT A MISSING FIELD.  That message stores a long `html` in `message_bodies`, with a
 *                         beacon deep inside it — and the same beacon early in the
 *                         TEXT part, which is the line that was on screen.
 *   THE MIRROR.           `message_body` records persist. A record written by any build before
 *                        the html change is `{messageId, state, text}` with no `html` key, `hydrateBody`
 *                         returned early on `state === "ready"`, and `bodyOf` reads
 *                         `rec.html ?? null` — so a message opened once before the fix could
 *                         never render as mail again.
 *
 * ── AND IT WAS THEN WATCHED HAPPENING ON THE DEPLOYED BUILD ─────────────────────────────
 *
 * Driven in a real browser against `ohmail.app` (build), on a profile that had used
 * the product before that change. **76 of its 77 persisted `message_body` records were
 * `state: "ready"` with the key absent** — `["messageId","state","text"]` — so 76 messages
 * were permanently un-renderable as mail on a build that can render mail. Then, in order:
 *
 *   stale record   click the message  →  ZERO `GET /messages/:id/body`, `.msg-body` renders
 *                                        text, no `<iframe>`. The defect.
 *   CONTROL        a message with NO record at all  →  ONE `GET …/body` → `200`, and the
 *                                        record it wrote has all five keys. The instrument
 *                                        fires, so the zero above is a measurement.
 *   the repair     delete the stale record — which is exactly what this fix makes
 *                                        `hydrateBody` do — reload, click the SAME message
 *                                        →  ONE `GET …/body` → `200`, key present.
 *
 * ── WHY THIS FILE EXISTS BESIDE `body-hydration.test.ts` ────────────────────────────────
 *
 * That one asserts the engine asks. This one asserts what a READER SEES, by running the same
 * two frames a reading surface runs: `bodyOf(store, message)` into the real `MessageBody`,
 * before the re-fetch and after it. The seam between them is where the defect lived — the
 * engine was correct about the wire, the renderer was correct about the html, and the record
 * between them was from last week.
 *
 * The `text` half of the assertion is deliberately about the BEACON URL rather than about
 * paragraph shape: a beacon shown as a bracketed line is the defect that was reported, and a
 * beacon silently fetched would be worse. Both are checked, and neither is satisfied by the
 * other.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const MESSAGE_ID = "owner-billing";
const NOW = new Date("2026-08-04T20:00:00.000Z");

/** A sentence only the HTML part carries, so "it rendered the mail" is not a guess. */
const HTML_ONLY_SENTENCE = "usage credits";

/** The ESP host in the reported mail — what `BodyText` puts first in a link's label. */
const BEACON_HOST = "url8792.mail.wolkenmail.example";

function ownerMessage(): EngineMessage {
  return {
    id: MESSAGE_ID,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: "Your organization is approaching its usage credits spend limit",
    from: { name: "Wolkenmail", address: "billing@mail.wolkenmail.example" },
    to: [],
    cc: [],
    date: "2026-07-31T19:56:14.000Z",
    folder: "ohmail/News",
    snippet: "Your organization has used 90% of its monthly usage credits",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
  };
}

/** The endpoint as production actually answers for this message: text AND html. */
function ownerAdapter(): EngineAdapter & { bodyCalls: string[] } {
  const bodyCalls: string[] = [];
  return {
    bodyCalls,
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0",
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async (id: string): Promise<MessageBodyWire> => {
      bodyCalls.push(id);
      return { text: OWNER_BILLING_TEXT, html: OWNER_BILLING_HTML, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
    },
  };
}

/**
 * A mirror holding exactly what a browser that read this message before that change holds: the text
 * part, `ready`, and NO `html` key at all. Written through `putLocal` because that is the only
 * way to produce the shape — every write the current engine makes carries the field.
 */
async function preO11bMirror() {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{
    type: "message",
    op: "create",
    id: MESSAGE_ID,
    seq: 1,
    updatedAt: NOW.toISOString(),
    entity: ownerMessage(),
  } as SyncChange]);
  await store.putLocal("message_body", MESSAGE_ID, {
    messageId: MESSAGE_ID,
    state: "ready",
    text: OWNER_BILLING_TEXT,
  } as MessageBodyRecord);
  const adapter = ownerAdapter();
  return { store, adapter, engine: new OhmailEngine({ adapter, store, now: () => NOW }) };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) {
    const r = root;
    await act(async () => { r.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
}

afterEach(unmount);

/** Render the reading surface's two lines — `bodyOf` into `MessageBody` — and nothing else. */
async function render(store: MemoryMirrorStore): Promise<HTMLDivElement> {
  await unmount();
  const message = store.get<EngineMessage>("message", MESSAGE_ID)!;
  const body = bodyOf(store, message);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(MessageBody, { text: body.text, html: body.html, remoteLoaded: body.loadedRemoteContent }));
  });
  // `MessageBody` builds the frame on the render AFTER mount, deliberately — see its
  // `mounted` state, which exists so the first client render matches the server's.
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
  return host;
}

describe("the reported billing mail, cached before the renderer existed", () => {
  it("BEFORE the fix's re-fetch: the text dump, with the tracking pixel as a visible line", async () => {
    const { store } = await preO11bMirror();
    const el = await render(store);

    // The state that was reported. `bodyOf` says `full` — this is not a loading or a snippet
    // state — and there is no document, so `MessageBody` falls through to `BodyText`.
    expect(bodyOf(store, store.get<EngineMessage>("message", MESSAGE_ID)!).state).toBe("full");
    expect(el.querySelector("iframe")).toBeNull();

    // The reported last line, character for character as the linkifier renders it:
    // `url8792.mail.wolkenmail.example/wf/open?upn=u001.Hx4mQs…`, host first and the tail cut at
    // `MAX_TAIL`. A beacon, on screen, as prose.
    expect(el.textContent ?? "").toContain(`${BEACON_HOST}/wf/open`);

    // Worse than shown: it is LIVE. The linkifier could only linkify what it was given, and what it was
    // given was the text alternative — so the beacon arrived as an ordinary url and became an
    // ordinary anchor. Nothing fetches it on open, but a reader can hand the ESP the open by
    // clicking a line they were never meant to see.
    const links = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(links).toContain(OWNER_TRACKING_PIXEL);
  });

  it("AFTER it: mail, in a frame — and the beacon is neither shown nor fetchable", async () => {
    const { store, engine, adapter } = await preO11bMirror();
    await engine.hydrateBody(MESSAGE_ID);
    expect(adapter.bodyCalls).toEqual([MESSAGE_ID]);

    const el = await render(store);
    const frame = el.querySelector("iframe");
    expect(frame).not.toBeNull();

    const doc = frame!.getAttribute("srcdoc") ?? "";
    // It is the MAIL, not a stub: a sentence that exists only in the html part.
    expect(doc).toContain(HTML_ONLY_SENTENCE);

    // ── THE BEACON, BOTH WAYS IT COULD STILL BE WRONG ──────────────────────────────────
    //
    // Not fetchable: its url appears nowhere the browser would read as a resource. Not
    // rendered as prose either — the reported defect was a url shown as a line of
    // text, and moving it from the page into the frame's source would be the same defect.
    expect(doc).not.toContain(OWNER_TRACKING_PIXEL);
    expect(el.textContent ?? "").not.toContain(OWNER_TRACKING_PIXEL);

    // What replaced it: the blank gif and the marker, so nothing is requested and a 1×1
    // beacon stays 1×1 rather than being rewarded with a visible box.
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    const beacon = [...parsed.querySelectorAll("img[data-ohmail-blocked]")];
    expect(beacon.length).toBeGreaterThan(0);
    for (const img of beacon) expect(img.getAttribute("src")).toMatch(/^data:image\/gif;base64,/);

    // And the blocking is SAID. A message silently stripped of its pictures reads as broken.
    expect(el.textContent ?? "").toMatch(/blocked/i);
  });

  it("the frame is still the sandboxed, script-free one — the repair changed no policy", async () => {
    /**
     * The re-fetch hands the renderer a document it had never been given before, so the two
     * tokens the whole containment rests on are re-asserted HERE rather than only in
     * `message-body.test.ts`: `allow-scripts` and `allow-forms` absent, and the frame's own
     * `default-src 'none'`. A cache repair that quietly widened either would look exactly like
     * a success in every other assertion in this file.
     */
    const { store, engine } = await preO11bMirror();
    await engine.hydrateBody(MESSAGE_ID);
    const el = await render(store);

    const frame = el.querySelector("iframe")!;
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-forms");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("srcdoc") ?? "").toContain("default-src 'none'");
  });
});
