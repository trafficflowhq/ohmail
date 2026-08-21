#!/usr/bin/env node
/**
 * smoke.mjs — the render check for the embedded UI bundles.
 *
 * It deliberately checks the ARTIFACT rather than the sources —
 * `dist/index.html` and the emitted chunks, exactly the bytes the installers
 * carry — because a bundle that builds and renders nothing is the failure mode
 * a compile step cannot catch.
 *
 * What it proves, per run:
 *   1. the bundle parses and executes to completion, with zero console errors
 *      and zero uncaught exceptions;
 *   2. it draws: the rail, its app controls, the views' entry points and real
 *      mail are in the DOM, not an empty <div id="root">;
 *   3. nothing collapsed: no "N more" style placeholder stands in for mail
 *      (all mail is always rendered, never summarised into a count);
 *   4. it is offline: the document requested nothing but its own two local
 *      files, and calling `fetch` from inside the page throws.
 *
 * jsdom, not a real browser: this runs on every runner with no download and no
 * display, and layout is not what is at risk here — the Blanc geometry is
 * verified against the design system in packages/ui's own suite.
 *
 * ── ONE WINDOW BUNDLE, AND THE OFFLINE AUDIT IT INHERITED ─────────────────
 *
 * `--expect engine` names the artifact under test: the window bundle that goes
 * inside a binary compiled with the Rust `local-engine` feature, which reaches
 * a mail engine on this machine over the shell's command channel
 * (`src/bridge-fetch.ts`). It is the only value, and it is still REQUIRED —
 * the artifact is declared, not sniffed, and the flag once distinguished a
 * second, fixtures-only "interface preview" (retired under the no-demo rule;
 * a caller passing `--expect preview` is told it is gone rather than handed
 * these checks under an old name).
 *
 * Four sections:
 *
 *   · 1–3: it executed cleanly, it drew, nothing collapsed. The two assertions
 *     that matter most, "no uncaught exceptions" and "no console errors", catch
 *     exactly the released defect this mode exists for — a build whose sync
 *     client threw inside a React render and showed a blank white window the
 *     moment a mailbox served.
 *   · 4, THE OFFLINE AUDIT — inherited from the retired preview and now run on
 *     the artifact that SHIPS, which is strictly more than it proved before:
 *     `installOfflineGuard()` is in this bundle's entry, the page's whole reach
 *     is the shell's command channel, and fetch/XHR/WebSocket/EventSource/
 *     sendBeacon must all refuse. The bridge is `invoke`, not `fetch`, so the
 *     engine build passes this audit BY DESIGN rather than by exemption.
 *   · 5: a stub command channel stands in for the shell, serves one small
 *     mailbox, and the checks assert the window asked for it, reached it over
 *     the bridge and drew it — with no demo ribbon over somebody's own mail.
 *
 *   node scripts/smoke.mjs [--dist dist] --expect engine
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, ResourceLoader } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const distArg = args.indexOf("--dist");
const DIST = path.resolve(APP, distArg >= 0 ? (args[distArg + 1] ?? "dist") : "dist");

/* The artifact under test, still DECLARED rather than defaulted or sniffed, and with one valid
   value now. `preview` used to be one — the retired fixtures artifact — and is refused with its
   own sentence so a stale caller learns what happened instead of getting these checks under an
   old name. */
const expectArg = args.indexOf("--expect");
const EXPECT = expectArg >= 0 ? args[expectArg + 1] : undefined;
if (EXPECT !== "engine") {
  process.stderr.write(
    EXPECT === "preview"
      ? `smoke: the interface preview is retired — the app has no demo artifact to smoke.\n` +
        `  The window bundle is the one artifact: npm run ui:build:engine && npm run smoke\n`
      : `smoke: --expect takes "engine"; got ${EXPECT === undefined ? "nothing" : `"${EXPECT}"`}\n`,
  );
  process.exit(1);
}

const failures = [];
let checks = 0;
const check = (label, ok, detail = "") => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* A check that CANNOT LOOK and a check that finds nothing must never be the same
   output, so a missing bundle is a non-zero exit before a single assertion runs
   — never a green run over an empty check list. */
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  process.stderr.write(
    `smoke: no ${EXPECT} bundle at ${DIST}\n` +
      `  Build it first:  npm run ui:build:engine\n`,
  );
  process.exit(1);
}

/* ─────────────────────────────────────────────── the recording loader ── */
/* Every byte the document asks for passes through here. A request for anything
   that is not a file inside dist/ is refused AND recorded, so "zero network"
   is an assertion about observed behaviour, not a claim about the source. */
const requested = [];
class DistOnlyLoader extends ResourceLoader {
  fetch(url, options) {
    requested.push(url);
    if (!url.startsWith("file://")) return Promise.reject(new Error(`refused: ${url}`));
    const file = fileURLToPath(url);
    if (!file.startsWith(DIST + path.sep)) return Promise.reject(new Error(`outside dist: ${url}`));
    return super.fetch(url, options);
  }
}

/* ────────────────────────────── the shell, stubbed (engine mode only) ── */
/**
 * `window.__TAURI_INTERNALS__` is the WHOLE seam. `src/bridge-fetch.ts` reads
 * that one global and nothing else — `shell()` and `bridgeAvailable()` both look
 * for `invoke` on it — and `src/native.ts` additionally wants
 * `transformCallback` for the menu listener. So two functions are the entire
 * stand-in for the Rust side, and the bundle under test is the real one.
 *
 * THE WIRE IS THE SHELL'S AND IS NOT INVENTED HERE. `engine_request` answers one
 * byte string:
 *
 *     [ 4 bytes big-endian: metadata length ][ metadata JSON ][ body bytes ]
 *
 * with the metadata `{ status, statusText, h: [[name, value], …] }`. The bytes go
 * back as a PLAIN ARRAY of byte values, which is not a shortcut: it is what the
 * runtime's message-channel transport really answers with under a strict CSP —
 * the transport this window uses, because `offline-guard.ts` refuses the
 * custom-scheme one — and `asBytes` in the bridge has a branch for exactly it.
 */
const invoked = [];
/** `engine_request` URLs this stub has no answer for. Asserted empty — see below. */
const unmodelled = [];

const encoder = new TextEncoder();
function frame(status, statusText, body) {
  const payload = encoder.encode(JSON.stringify(body));
  const meta = encoder.encode(
    JSON.stringify({ status, statusText, h: [["content-type", "application/json"]] }),
  );
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return Array.from(out);
}

/**
 * THE ONE MAILBOX THE STUB SERVES, and why it is not an empty page.
 *
 * An empty `/sync` page renders the "Nothing in your Ohbox" state, which draws no
 * `.rows` at all — so the bundle would be asserted against the emptiest surface it
 * has, which is close to asserting nothing. Real rows exercise the selectors, the
 * consent projection, the row components and the reading pane's empty state.
 *
 * THE RULE IS LOAD-BEARING AND IS NOT DECORATION. `consent-cutline.ts` presents an
 * INBOX message from a sender with NO rule in the Screener, not the Ohbox — sitting
 * in the INBOX is not consent. Without the rule below these two messages would
 * render as a Screener count and the row checks would be asserting an empty Ohbox.
 *
 * Addresses are under `.invalid`, which is reserved and resolves nowhere.
 */
const SENDER = { name: "Renate Kowalski", address: "renate@ohmail.invalid" };
const MAILBOX_ID = "mb_smoke";
const SERVED = [
  {
    id: "msg_smoke_1",
    subject: "The lease renewal, and the two dates it turns on",
    snippet:
      "Both dates are in the second half of the month, so there is time — but the notice " +
      "period starts from the earlier one and not from the signature.",
    unread: true,
  },
  {
    id: "msg_smoke_2",
    subject: "Re: the survey, and what the surveyor actually wrote",
    snippet:
      "The report is shorter than the summary made it sound. The one paragraph that matters " +
      "is about the roof, and it is not the paragraph the listing quoted.",
    unread: false,
  },
];

function syncPage() {
  /* Relative to now rather than a fixed date: the Ohbox groups by recency, and a
     row minted at a hard-coded instant would drift into a different group as the
     file aged — a check that changes meaning with the calendar. */
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const now = at(0);
  const message = (m, i) => ({
    id: m.id,
    accountId: "acc_smoke",
    mailboxId: MAILBOX_ID,
    threadId: null,
    messageIdHeader: `<${m.id}@ohmail.invalid>`,
    subject: m.subject,
    from: SENDER,
    to: [{ name: null, address: "you@ohmail.invalid" }],
    cc: [],
    date: at(20 + i * 40),
    folder: "INBOX",
    snippet: m.snippet,
    unread: m.unread,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: at(20 + i * 40),
  });

  return {
    changes: {
      creates: [
        {
          type: "rule",
          op: "create",
          id: "rule_smoke",
          seq: 1,
          updatedAt: now,
          entity: {
            id: "rule_smoke",
            kind: "sender",
            match: SENDER.address,
            destination: "INBOX",
            priority: 100,
            provenance: "manual",
            enabled: true,
            stats: { hits: SERVED.length, lastHitAt: now, demotions: 0 },
            createdAt: now,
            updatedAt: now,
          },
        },
        ...SERVED.map((m, i) => ({
          type: "message",
          op: "create",
          id: m.id,
          seq: 2 + i,
          updatedAt: now,
          entity: message(m, i),
        })),
      ],
      updates: [],
      moves: [],
      deletes: [],
    },
    /* base64url of "3" — the cursor the engine commits after this page. */
    cursor: "Mw",
    hasMore: false,
    serverTime: now,
  };
}

/**
 * `GET /mailboxes` — THE SECOND ROUTE THE ENGINE-BEARING WINDOW ASKS FOR AT BOOT.
 *
 * `DesktopMailboxes.tsx` reads it twice over: the sync line at the foot of the rail starts its
 * ladder with "can we see this account's mailboxes at all?", and Settings → Mailboxes lists what
 * this install is connected to. Both doors serve it out of the database on this machine, so a
 * window that asks for it is behaving correctly and a stub that 404s it is simply out of date —
 * which is the sentence the `unmodelled` list exists to say, and it said it: the check went red
 * the moment that surface landed, with `GET /mailboxes` named.
 *
 * The answer is deliberately a HEALTHY, SETTLED mailbox rather than a bare `{ items: [] }`:
 *
 *  · an EMPTY list is a fact of its own — the ladder renders "No mailbox connected, so nothing can
 *    arrive" over it — and that sentence across a window the rest of these checks assert is full
 *    of somebody's mail would be a contradiction the run could not read;
 *  · `lastSyncAt` set and `initialImportCompletedAt` set is what makes the line settle instead of
 *    holding "Syncing your mail" over a mailbox with nothing left to fetch. The distinction is
 *    load-bearing in the component — an ABSENT `initialImportCompletedAt` means "this engine
 *    predates the column", a null means "not known to have finished" — so the field is present.
 *
 * The identity matches the world the rest of the stub serves: {@link MAILBOX_ID}, the account the
 * `engine_status` answer names, and the address the served messages were sent to.
 */
function mailboxList() {
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  return {
    items: [
      {
        id: MAILBOX_ID,
        accountId: "acc_smoke",
        address: "you@ohmail.invalid",
        status: "active",
        errorCode: null,
        disabledReason: null,
        syncBlockedReason: null,
        syncBlockedSince: null,
        lastSyncAt: at(1),
        initialImportCompletedAt: at(90),
        createdAt: at(60 * 24 * 7),
      },
    ],
  };
}

/**
 * `GET /consent` — THE THIRD ROUTE THE ENGINE-BEARING WINDOW ASKS FOR AT BOOT.
 *
 * It arrived with the hosted door's settings wire: `local-consent.ts` sends the shared shell's
 * consent read down the bridge, `consentDoorFor` wires it on the hosted door only, and the engine
 * FORWARDS it to the account rather than answering it out of the local mirror. This stub answers
 * `mode: "cloud"` from `engine_status`, so it is that door the run exercises — the window is
 * behaving correctly and a stub that 404s the route is out of date, which is exactly what the
 * `unmodelled` list said when it named `GET /consent`. Same shape as the two routes above it.
 *
 * ── THE ANSWER IS THE SHELL'S OWN RESTING STATE, DELIBERATELY ──────────────────────────────
 *
 * Every field below is the value the shell already holds when the read has NOT happened, so
 * modelling the route removes the 404 without moving one product decision in the window these
 * checks then assert:
 *
 *  · `autoSuggestAt: null` — off, and it is the one setting that authorises spending;
 *  · `blockRemoteImagesAt` SET, because `blockRemoteImagesAt !== null` is what "blocked" means on
 *    this wire and blocked is the shell's resting value — a stub that sent null would quietly
 *    answer a privacy question in the permissive direction;
 *  · `blockAutoUnsubscribeAt: null`, which is `autoUnsubscribe` ON — again the resting value, and
 *    the flag only decides whether a consequence is DISCLOSED;
 *  · `locale: null` — the account states no preference, so the window keeps its own language.
 *
 * What the read does change is `known`, which is the point: the controls gated on it stop being
 * withheld. None of them is on screen at boot, so no check here depends on that.
 *
 * `dormancyDays` is the product default (60) and `screeningBaselineAt` is the instant the mailbox
 * above finished its first import, which is the same event. The pair is the cutline arithmetic —
 * `cutoff = screeningBaselineAt - dormancyDays` — and it cannot move the served mail: both
 * messages come with a rule for their sender, so they present in that rule's destination whatever
 * the cutline says. The counts describe that same world: one decided sender, nothing undecided.
 */
function consentState() {
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  return {
    seedConfirmedAt: at(60 * 24 * 7),
    screeningResetAt: null,
    dormancyDays: 60,
    screeningBaselineAt: at(90),
    autoSuggestAt: null,
    blockRemoteImagesAt: at(60 * 24 * 7),
    blockAutoUnsubscribeAt: null,
    locale: null,
    counts: { decidedSenders: 1, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
  };
}

/**
 * Four platform globals a webview has and jsdom does not, borrowed from this Node process.
 *
 * THIS IS NOT PER-ARTIFACT, and it used to live inside `installShellStub` where it was. The
 * bridge is the reason the list was written — it builds a `Response` out of the frame it was
 * handed and decodes the metadata with a `TextDecoder` — but "which of these a bundle happens to
 * touch" is not a fact the harness gets to assume. It was wrong the first time something else
 * touched one: the fixtures adapter sizes a servable attachment with
 * `new TextEncoder().encode(...)` while it builds the demo world, which runs in the PREVIEW,
 * where the stub is deliberately absent — so the preview died at first render with
 * `ReferenceError: TextEncoder is not defined` and reported twenty failed checks that all said
 * "nothing drew". A real webview has all four in both artifacts; jsdom has none of them; so both
 * artifacts got them, and the lesson outlived the preview: the harness supplies the
 * platform globals a real webview supplies, unconditionally.
 *
 * jsdom's own `Headers` is left alone — the bridge's `toHeaders` builds one and hands it to the
 * borrowed `Response`, which reads it as an iterable, and that pairing is exercised on every
 * request the shell stub answers.
 */
function installPlatformGlobals(window) {
  for (const name of ["Response", "Request", "TextEncoder", "TextDecoder"]) {
    if (typeof window[name] === "undefined" && typeof globalThis[name] !== "undefined") {
      window[name] = globalThis[name];
    }
  }
}

function installShellStub(window) {
  window.__TAURI_INTERNALS__ = {
    /* The runtime hands back a numeric callback id; `native.ts` only passes it
       on to `plugin:event|listen`, which this stub answers with null. */
    transformCallback: () => 1,
    invoke(command, payload) {
      invoked.push({ command, payload });
      if (command === "engine_status") {
        return Promise.resolve({
          state: "serving",
          mode: "cloud",
          address: "you@ohmail.invalid",
          mailboxId: MAILBOX_ID,
          accountId: "acc_smoke",
          credentialState: "ready",
        });
      }
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url.startsWith("/sync")) return Promise.resolve(frame(200, "OK", syncPage()));
        /* Exact, or with a query — and NOT a `startsWith("/mailboxes")`, which would also swallow
           `/mailboxes/:id` and the organizer, takeover and resync routes under it. Those are
           mutations this window has no business making at boot, and a prefix match would answer
           them 200 instead of naming them here. */
        if (url === "/mailboxes" || url.startsWith("/mailboxes?")) {
          return Promise.resolve(frame(200, "OK", mailboxList()));
        }
        /* The away-responder notice reads its state at boot the same way the mailbox
           list is read: one GET, render-only, parsed as `{enabled, audience}`. A
           disabled responder is the honest stub and keeps
           the boot free of 404s. */
        if (url === "/away-responder") {
          return Promise.resolve(
            frame(200, "OK", { enabled: false, audience: "screened_in", body: "" }),
          );
        }
        /* Exact, and GET only. The four writes go to `/consent/settings` and a PATCH there is a
           user action this boot never takes — so a prefix match would answer a mutation 200 and
           hide it, where naming it is the whole job of the list below. */
        if (url === "/consent" && (payload?.method ?? "GET") === "GET") {
          return Promise.resolve(frame(200, "OK", consentState()));
        }
        /* The profile-import PROBE — the "we found your ohmail settings on this mailbox" card
           asks once per mailbox at mount (`useProfileImport`), on both doors, since the desktop
           wired its transport. `state: "none"` is the honest resting answer — this stub's
           mailbox carries no travelling settings document — and it is what keeps the card
           absent, which is the surface's own resting state. GET only, exact shape: the apply
           and decline POSTs are user actions this boot never takes, and the `unmodelled` list
           below is where they would rightly land. This entry was added AFTER the check named it
           red — the wiring landed without the stub following, which is exactly the drift the
           list exists to say out loud. */
        if (url === `/mailboxes/${MAILBOX_ID}/profile-import` && (payload?.method ?? "GET") === "GET") {
          return Promise.resolve(frame(200, "OK", { state: "none" }));
        }
        /* `GET /messages/bodies?ids=…` — THE BATCH BODY READ, asked for at boot now that recent
           mail hydrates in the BACKGROUND rather than only when a message is opened. Nothing about
           the window changed here; the engine simply started warming the newest run, and this stub
           had never been taught the route, so all four platform jobs went red on this one check
           out of thirty-nine — which is precisely the drift the `unmodelled` list exists to name,
           doing its job.

           Modelled, not prefix-matched: `/messages/:id/…` mutations (`load-remote`, `unsubscribe`)
           live under the same first segment and are user actions this boot never takes, so a
           `startsWith("/messages")` would answer them 200 and hide them. Query only, GET only.

           THE ANSWER IS THE SAME SHAPE THE REAL ROUTE SERVES — `{ items: [...] }`, one row per id
           with `messageId` ON the row, because position is meaningless on this wire: the server
           answers only the ids it owns and omits the rest. Bodies are the served snippet, which
           keeps the stub's world consistent (the snippet check below reads the same text) and
           keeps every privacy-shaped field at its resting value: `html: null`, no remote content
           loaded, no unsubscribe header, and no `withheld` key — that key exists only when a
           server says it, and inventing one would make this boot exercise the storage-cap
           surface instead of the ordinary one. */
        if (url.startsWith("/messages/bodies?") && (payload?.method ?? "GET") === "GET") {
          const asked = new Set(
            new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("ids")?.split(",") ?? [],
          );
          return Promise.resolve(frame(200, "OK", {
            /* Only the ids this stub owns, and silently no row for anything else — the real
               route's omission rule, kept so the check cannot pass against a laxer stub. */
            items: SERVED.filter((m) => asked.has(m.id)).map((m) => ({
              messageId: m.id,
              text: m.snippet,
              html: null,
              loadedRemoteContent: false,
              unsubscribe: "no_header",
              unsubscribeUrl: null,
            })),
          }));
        }
        /* RECORDED, not silently 404'd into a console error the checks would then
           report as a product defect. A surface that starts calling a second route
           at boot has to be modelled here; until it is, this says so by name. */
        unmodelled.push(`${payload?.method ?? "GET"} ${url}`);
        return Promise.resolve(
          frame(404, "Not Found", {
            error: { code: "not_found", message: `the smoke stub serves no ${url}` },
          }),
        );
      }
      /* `plugin:event|listen`, `set_badge`, `notify` — the shell answers each with
         nothing, and so does this. */
      return Promise.resolve(null);
    },
  };
}

/* jsdom has no ESM loader, and the bundle is a single self-contained chunk with
   no import/export statements (vite.config.ts turns the modulepreload polyfill
   off, which is what removes the last `fetch(` from the output). Dropping the
   type attribute is therefore a no-op semantically and lets jsdom run it. */
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const classic = html.replace(/<script\s+type="module"\s+/g, "<script ");
check("index.html has a script to run", classic !== html || /<script /.test(classic));

const consoleErrors = [];
const uncaught = [];
/** Anything the page managed to send before the guard sealed the API. */
const leaked = [];

const dom = new JSDOM(classic, {
  url: pathToFileURL(path.join(DIST, "index.html")).href,
  runScripts: "dangerously",
  resources: new DistOnlyLoader(),
  pretendToBeVisual: true,
  beforeParse(window) {
    /* The three observer APIs jsdom lacks and the design system uses. Stubbed,
       not faked: the seen-on-scroll waterline simply never fires here. */
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    if (!window.matchMedia) {
      window.matchMedia = (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      });
    }
    window.Element.prototype.scrollIntoView = function () {};
    window.HTMLElement.prototype.scrollTo = function () {};
    if (!window.crypto?.randomUUID) {
      Object.defineProperty(window, "crypto", {
        value: { ...(window.crypto ?? {}), randomUUID: () => globalThis.crypto.randomUUID() },
        configurable: true,
      });
    }
    /* jsdom ships no fetch, EventSource or sendBeacon, and the offline guard
       only replaces what a host actually has — so without this the guard checks
       below would pass vacuously. Install a *working* set first: a real webview
       has all of them, and now a call that slips through is recorded here
       instead of disappearing into a ReferenceError. */
    for (const name of ["fetch", "EventSource"]) {
      window[name] = function () {
        leaked.push(`${name}(${[...arguments].map(String).join(", ")})`);
        return { then() {}, catch() {}, finally() {} };
      };
    }
    window.navigator.sendBeacon = function () {
      leaked.push("navigator.sendBeacon");
      return true;
    };
    for (const name of ["XMLHttpRequest", "WebSocket"]) {
      const real = window[name];
      window[name] = function (...a) {
        leaked.push(`new ${name}(${a.map(String).join(", ")})`);
        return new real(...a);
      };
    }

    /* Both artifacts run in a webview, so both get the webview's platform globals. See the
       docblock: putting these behind the branch below made a jsdom gap look like a product that
       could not draw. */
    installPlatformGlobals(window);

    /* The stand-in for the Rust side. Without it the bundle would find no shell and honestly
       draw the door chooser (`doors.ts` routes no-shell to not-connected); WITH it, the run
       proves the whole path this artifact ships for — status, bridge, mail on screen. */
    installShellStub(window);

    window.addEventListener("error", (e) => uncaught.push(String(e.error ?? e.message)));
    window.addEventListener("unhandledrejection", (e) => uncaught.push(String(e.reason)));
    const err = window.console.error.bind(window.console);
    window.console.error = (...a) => {
      consoleErrors.push(a.map(String).join(" "));
      err(...a);
    };
  },
});

/* The engine boots in an effect and drains its first page asynchronously. Give
   the microtask queue and a few timer turns a chance rather than guessing: a
   status call, then the client engine's hydrate, then a full drain over the
   bridge. These are TIMER TURNS and not a wall clock, so a loaded runner
   stretches them along with everything else. */
const { window } = dom;
for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 25));

const doc = window.document;
const root = doc.getElementById("root");
const text = doc.body.textContent ?? "";
const rows = doc.querySelectorAll(".rows > *").length;

/* ── 1 · it executed cleanly ───────────────────────────────────────────── */
/* THESE TWO ARE THE ONES THAT CATCH A BROKEN ENGINE BUILD. A copy of the client
   whose HTTP adapter throws on construction fails both, because the constructor
   runs inside a React render: the exception escapes to `window.onerror` and
   React logs it. That is the released blank-window build, caught here. */
check("no uncaught exceptions", uncaught.length === 0, uncaught.slice(0, 3).join(" | "));
check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

/* ── 2 · it drew ───────────────────────────────────────────────────────── */
check("#root exists", root != null);
check("#root is not empty", (root?.children.length ?? 0) > 0);
check("the rail rendered", doc.querySelector(".rail") != null);
check("the wordmark rendered", doc.querySelector(".rail .wordmark") != null);
/* THE APP CONTROLS, WHEREVER THEY LIVE — and they moved. They used to be a capsule fixed over
   the bottom of the window (`.dock`), and they are now rows at the foot of the rail. This check
   asserted the retired class, so it went red on the runners the moment the move landed and green
   nowhere: this bundle is only ever smoked in CI. What it is FOR is that the palette and
   the theme control reached the screen, so it asserts the two controls and not merely their
   container — a `.rail-dock` that rendered empty is exactly the failure a container check misses. */
check("the rail's app controls rendered", doc.querySelector(".rail .rail-dock") != null);
check("the command control rendered", doc.querySelector(".rail-dock .dock-cmd") != null);
check("the theme control rendered", doc.querySelector(".rail-dock .dock-theme") != null);
check("a list pane rendered", doc.querySelector(".rows") != null);
/* The floor follows the dataset — whatever the stub served — and is still far
   above "an empty shell rendered its chrome". */
check("body text is substantial", text.length > 400, `${text.length} chars`);

for (const label of ["Ohbox", "Screener", "Reads", "Receipts", "Answer Later", "Search", "Settings"]) {
  check(`rail names "${label}"`, text.includes(label));
}

/* ── 3 · nothing collapsed: every message renders in full ──────────────── */
/* Ordered before the per-artifact sections so the shared checks read together;
   the placement in the output is what changed, not the assertion. */
const collapsed = text.match(/\b\d+\s+(more|others?|collapsed|hidden)\b/i);
check("no collapsed-mail placeholder", collapsed == null, collapsed?.[0] ?? "");

/* ── 4 · it is offline ─────────────────────────────────────────────────── */
/* INHERITED FROM THE RETIRED PREVIEW AND NOW RUN ON THE ARTIFACT THAT SHIPS —
   which is strictly the stronger audit: `installOfflineGuard()` is this bundle's
   own entry line, the page's whole reach is the shell's command channel
   (`invoke`, not `fetch`), and every network-capable API must refuse. Not
   weakened, not widened, and deliberately not made conditional inside each
   check: an offline assertion with an escape hatch in it is an assertion nobody
   trusts. */
{
  const foreign = requested.filter((u) => !u.startsWith("file://"));
  check("no non-file request was made", foreign.length === 0, foreign.slice(0, 3).join(" | "));
  const outside = requested
    .filter((u) => u.startsWith("file://"))
    .filter((u) => !fileURLToPath(u).startsWith(DIST + path.sep));
  check("no request left dist/", outside.length === 0, outside.slice(0, 3).join(" | "));

  check("nothing was sent before the guard ran", leaked.length === 0, leaked.slice(0, 3).join(" | "));

  const refuses = (expr) => {
    try {
      window.eval(expr);
      return false;
    } catch (e) {
      return /offline by construction/.test(String(e?.message ?? e));
    }
  };
  check("the offline guard makes fetch() throw", refuses("fetch('https://example.invalid')"));
  check("the offline guard makes navigator.sendBeacon() throw", refuses("navigator.sendBeacon('/x')"));
  for (const api of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
    check(`the offline guard makes ${api} throw`, refuses(`new ${api}('wss://example.invalid')`));
  }
}

/* ══ 5 · it reached the engine, and drew what it was served ══════════════ */
{
  const commands = invoked.map((i) => i.command);
  const asked = invoked.filter((i) => i.command === "engine_request");

  /* The window asked the shell what the engine is doing. Everything downstream —
     the door routing, the mail mount, the client engine — hangs off this answer,
     so a bundle that never asks has nothing to draw a mailbox from. */
  check("the window asked the shell about the engine", commands.includes("engine_status"));

  /* THE CHECK THE BLANK-WINDOW BUILD COULD NOT HAVE PASSED. A request over
     `engine_request` means a real `HttpAdapter` was constructed and used: the
     stub that shipped in its place throws in its constructor, so nothing ever
     reaches the bridge. */
  check(
    "the client engine reached the bridge",
    asked.some((i) => String(i.payload?.url ?? "").startsWith("/sync")),
    commands.join(", "),
  );

  /* THE MODEL ABOVE IS ASSERTED TO HAVE A CONSUMER, not merely to exist. A stub route nobody
     asks for is a 404 that stopped being reported, and the difference between the two is
     invisible in `unmodelled` — an empty list means both "everything was modelled" and "nothing
     was asked". So the mailbox read is named: it is what the rail's sync line and Settings →
     Mailboxes both start from, and a bundle that stopped making it would draw a window that can
     no longer say which mailbox it is opening. */
  check(
    "the window asked the engine which mailboxes this install opens",
    asked.some((i) => String(i.payload?.url ?? "") === "/mailboxes"),
    asked.map((i) => i.payload?.url).join(", "),
  );

  /* A route the stub does not model would be answered 404 and would surface as a
     product failure in section 1. Named here instead, so "the stub is out of
     date" and "the bundle is broken" are different sentences. */
  check("the stub was asked for no route it does not serve", unmodelled.length === 0,
        unmodelled.slice(0, 3).join(" | "));

  /* THE APOLOGY CARD IS A FAILING RUN'S BEST WITNESS, so it is asserted rather
     than left to be inferred from a thin body and a missing rail.

     The bundle draws it whenever the boot check or the error boundary catches
     something, and its text IS that something — for the released build whose
     sync client was a throwing stub, the stub's own refusal. Reporting the
     sentence here is the difference between a list of checks that failed and a
     list of checks that failed BECAUSE there is no sync client in this build. */
  const notice = doc.querySelector(".gate-card");
  check(
    "the window drew mail rather than an apology",
    notice == null,
    notice?.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "",
  );

  /* It drew the served mailbox, not merely the chrome around one. */
  check("message rows rendered", rows >= SERVED.length, `${rows} rows`);
  check(`the served sender "${SENDER.name}" is on screen`, text.includes(SENDER.name));
  for (const m of SERVED) {
    check("the served subject is on screen", text.includes(m.subject), m.subject);
  }
  check("a served snippet is on screen", text.includes(SERVED[0].snippet.slice(0, 40)));

  /* AND IT IS NOT PRETENDING TO BE THE DEMO. `demo` is structurally false in
     this artifact — the ribbon and the frozen clock belong to the landing
     page's demo, and both would be lies about somebody's own mail. The fixtures
     adapter behind them is aliased to a refusing stub in this bundle
     (`src/no-fixtures-adapter.ts`), so a ribbon here means that alias came off. */
  check(
    "no demo ribbon over a served mailbox",
    !/invented mail/i.test(text) && !/nothing leaves this tab/i.test(text),
  );
}

/* ── verdict ───────────────────────────────────────────────────────────── */
window.close();

if (failures.length) {
  process.stderr.write(`\nSMOKE FAILED (${failures.length}/${checks}, --expect ${EXPECT})\n`);
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `SMOKE OK (${checks} checks, engine) — ${rows} rows, ${text.length} chars, ` +
    `${invoked.length} shell command(s) over the bridge, ` +
    `${requested.length} local file request(s), 0 network\n`,
);
