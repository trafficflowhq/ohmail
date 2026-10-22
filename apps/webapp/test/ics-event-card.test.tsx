/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseIcsEvent } from "@trafficflow/core/ics";
import { IcsEventCard, formatWhen } from "../app/components/IcsEventCard";
import { AttachmentStrip, type AttachmentItem, type AttachmentsView } from "../app/components/AttachmentStrip";
import { calendarEventsOf } from "@ohmail/client-engine";
import { HOSTILE_DURATION } from "../../../packages/core/test/fixtures/invite-shapes";
import { MessageEvents } from "../app/shell/MessageEvents";
import { MessageChromeProvider } from "../app/shell/message-chrome";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog, setActiveFormatZone } from "../app/shell/locale";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ═══ THE EVENT CARD — what a calendar attachment SAYS, in both languages, and what it never does ═══
 *
 * The card is the reading surface for a meeting invitation: what (SUMMARY), when (start–end in
 * the reader's zone and locale), where (LOCATION), who (organizer + invited count), and the
 * METHOD framed as the message it is — an invitation, a proposed new time (old struck through
 * under new), a cancellation, an answer. Every one of those fields is sender-controlled text,
 * so the injection case is load-bearing: a SUMMARY carrying `<script>` must land in the DOM as
 * inert characters, and a crafted ORGANIZER must never become a link.
 *
 * The block-level tests pin the degradation: a calendar part whose text does not parse draws no
 * card, and the strip keeps every calendar part as its plain tile.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES = path.join(HERE, "..", "messages");
const read = (locale: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8"));
const EN_CATALOG = read("en");
const GERMAN = fillFrom(EN_CATALOG as never, read("de") as never);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: React.ReactElement): Promise<HTMLDivElement> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  setActiveCatalog(DEFAULT_LOCALE, null);
  setActiveFormatZone(null);
});

/* ── fixtures: the two dialects the live corpus is made of ─────────────────────────────── */

const REQUEST_ICS = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Zurich:20260911T160000",
  "DTEND;TZID=Europe/Zurich:20260911T163000",
  "ORGANIZER;CN=Petra Wyss:mailto:petra@makersfest.example",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Mila Brunner:mailto:mila@lichtgrat.example",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Petra Wyss:mailto:petra@makersfest.example",
  "SUMMARY:Tech check — main hall",
  "LOCATION:Makersfest\\, Halle 2\\, Zürich",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const COUNTER_ICS = [
  "BEGIN:VCALENDAR",
  "METHOD:COUNTER",
  "BEGIN:VEVENT",
  "ORGANIZER;CN=Mila Brunner:mailto:mila@lichtgrat.example",
  "SUMMARY:Glaze evening — planning call",
  "DTSTART;TZID=W. Europe Standard Time:20260730T150000",
  "DTEND;TZID=W. Europe Standard Time:20260730T153000",
  "X-MS-OLDSTART:20260730T080000Z",
  "X-MS-OLDEND:20260730T083000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const CANCEL_ICS = [
  "BEGIN:VCALENDAR",
  "METHOD:CANCEL",
  "BEGIN:VEVENT",
  "SUMMARY:Studio day",
  "DTSTART;VALUE=DATE:20260915",
  "DTEND;VALUE=DATE:20260916",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const card = (ics: string) => h(IcsEventCard, { event: parseIcsEvent(ics)! });

describe("the four fields, framed by METHOD (English, reader in Zurich)", () => {
  it("REQUEST reads as an invitation: what, when, where, who", async () => {
    setActiveFormatZone("Europe/Zurich");
    const el = await render(card(REQUEST_ICS));
    expect(el.querySelector(".ics-kicker")!.textContent).toBe("Invitation");
    expect(el.querySelector(".ics-summary")!.textContent).toBe("Tech check — main hall");
    const when = el.querySelector(".ics-when")!.textContent!;
    expect(when).toContain("Sep 11");
    expect(when).toContain("2026");
    expect(when).toMatch(/4:00/); // 16:00 Zurich in the reader's own Zurich clock, en digits
    expect(when).toMatch(/4:30/);
    expect(el.textContent).toContain("Makersfest, Halle 2, Zürich"); // the \, unescaped
    expect(el.textContent).toContain("Petra Wyss · 2 invited");
    // The calendar-page glyph carries the event's day.
    expect(el.querySelector(".ics-date-day")!.textContent).toBe("11");
    expect(el.querySelector(".ics-date-mo")!.textContent).toMatch(/Sep/);
  });

  it("the same invitation reads in the READER's zone — New York sees 10:00 AM", async () => {
    setActiveFormatZone("America/New_York");
    const el = await render(card(REQUEST_ICS));
    expect(el.querySelector(".ics-when")!.textContent).toMatch(/10:00/);
  });

  it("COUNTER reads as a proposed new time, the old one struck through beneath", async () => {
    setActiveFormatZone("Europe/Zurich");
    const el = await render(card(COUNTER_ICS));
    expect(el.querySelector(".ics-kicker")!.textContent).toBe("Proposed new time");
    expect(el.querySelector(".ics-when")!.textContent).toMatch(/3:00/); // the proposal
    const prev = el.querySelector(".ics-prev s");
    expect(prev, "the replaced time renders as a struck-through element").not.toBeNull();
    expect(prev!.textContent).toMatch(/10:00/); // 08:00Z is 10:00 in Zurich
  });

  it("CANCEL reads as a cancellation, in the accent register, over an all-day date", async () => {
    const el = await render(card(CANCEL_ICS));
    const kicker = el.querySelector(".ics-kicker")!;
    expect(kicker.textContent).toBe("Cancelled");
    expect(kicker.getAttribute("data-tone")).toBe("cancel");
    expect(el.querySelector(".ics-card")!.hasAttribute("data-cancelled")).toBe(true);
    expect(el.querySelector(".ics-when")!.textContent).toContain("All day");
    expect(el.querySelector(".ics-when")!.textContent).toContain("Sep 15");
  });
});

describe("the same card in German", () => {
  it("labels flip to the catalogue's German — Outlook's own vocabulary", async () => {
    setActiveCatalog("de", GERMAN as never);
    setActiveFormatZone("Europe/Zurich");
    const el = await render(card(COUNTER_ICS));
    expect(el.querySelector(".ics-kicker")!.textContent).toBe("Neue vorgeschlagene Zeit");
    const el2 = await render(card(REQUEST_ICS));
    expect(el2.querySelector(".ics-kicker")!.textContent).toBe("Einladung");
    expect(el2.textContent).toContain("2 eingeladen");
    // German formats the clock as 16:00, not 4:00 PM.
    expect(el2.querySelector(".ics-when")!.textContent).toContain("16:00");
  });
});

describe("hostile content stays inert", () => {
  it("a SUMMARY carrying <script> renders as characters — no element, no execution", async () => {
    const el = await render(
      card(
        [
          "BEGIN:VCALENDAR",
          "BEGIN:VEVENT",
          "DTSTART:20260713T120000Z",
          "SUMMARY:<script>document.title='owned'</script>",
          "LOCATION:<img src=x onerror=alert(1)>",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      ),
    );
    expect(el.querySelector("script"), "no script element may exist").toBeNull();
    expect(el.querySelector("img"), "no img element may exist").toBeNull();
    expect(el.querySelector(".ics-summary")!.textContent).toBe("<script>document.title='owned'</script>");
    expect(document.title).not.toBe("owned");
  });

  it("people render as text — never a link, whatever the CAL-ADDRESS carried", async () => {
    const el = await render(
      card(
        [
          "BEGIN:VCALENDAR",
          "METHOD:REQUEST",
          "BEGIN:VEVENT",
          "DTSTART:20260713T120000Z",
          "ORGANIZER;CN=Evil Org:mailto:evil@example.com?bcc=victim@example.com",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      ),
    );
    expect(el.querySelector("a"), "the card renders no anchor at all").toBeNull();
    expect(el.textContent).toContain("Evil Org");
  });
});

describe("the time forms the parser distinguishes render distinctly", () => {
  it("a UTC instant lands on the reader's clock", () => {
    setActiveFormatZone("Europe/Zurich");
    const ev = parseIcsEvent(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260713T120000Z\r\nDTEND:20260713T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
    )!;
    const when = formatWhen(ev.start, ev.end);
    expect(when).toMatch(/2:00/); // 12:00Z = 14:00 CEST
    expect(when).toMatch(/3:00/);
  });

  it("an unresolvable zone shows the wall time AS LABELED, claiming nothing more", () => {
    setActiveFormatZone("Europe/Zurich");
    const ev = parseIcsEvent(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Middle Earth Standard Time:20260819T140000\r\nEND:VEVENT\r\nEND:VCALENDAR",
    )!;
    const when = formatWhen(ev.start, ev.end);
    expect(when).toMatch(/2:00/); // the wall clock verbatim (en: 2:00 PM)
    expect(when).toContain("(Middle Earth Standard Time)");
  });

  it("a multi-day all-day range names its INCLUSIVE last day", () => {
    const ev = parseIcsEvent(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260915\r\nDTEND;VALUE=DATE:20260918\r\nEND:VEVENT\r\nEND:VCALENDAR",
    )!;
    const when = formatWhen(ev.start, ev.end);
    expect(when).toContain("Sep 15");
    expect(when).toContain("Sep 17"); // DTEND 09-18 is exclusive
    expect(when).not.toContain("Sep 18");
  });

  it("a trivially speakable weekly rule is said in words", async () => {
    const el = await render(
      card(
        [
          "BEGIN:VCALENDAR",
          "BEGIN:VEVENT",
          "DTSTART;TZID=Europe/Zurich:20260915T083000",
          "RRULE:FREQ=WEEKLY;BYDAY=TU",
          "SUMMARY:Team sync",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      ),
    );
    expect(el.textContent).toContain("Weekly on Tuesday");
  });
});

/* ── MessageEvents: the card where the text parses, nothing otherwise; the strip keeps the tile ── */

/** The events block over a message whose list and texts are these, through the real `calendarEventsOf`. */
function eventsWith(items: AttachmentItem[], textOf: (id: string) => string | undefined) {
  const texts = new Map(items.flatMap((i): [string, string][] => {
    const t = textOf(i.id);
    return t === undefined ? [] : [[i.id, t]];
  }));
  const engine = {
    attachmentsOf: () => ({ state: "ready", items: items.map((i) => ({ ...i, inline: false, contentId: null })) }),
    calendarTextsOf: () => texts,
  };
  const attachments = { eventsOf: (id: string) => calendarEventsOf(engine as never, id), hold: () => () => {} };
  return h(MessageChromeProvider as never, { value: { attachments }, children: h(MessageEvents, { messageId: "m1" }) } as never);
}

function stripWith(items: AttachmentItem[]) {
  const view: AttachmentsView = { state: "ready", items };
  return h(AttachmentStrip, { items: view, onOpen: () => {}, onDownloadAll: () => {}, downloadingAll: false });
}

const calItem = (over: Partial<AttachmentItem> = {}): AttachmentItem => ({
  id: "c1",
  filename: "invite.ics",
  mimeType: "text/calendar; charset=utf-8; method=REQUEST",
  sizeBytes: 900,
  state: "ready",
  ...over,
});

describe("the event block draws where the text parses, and degrades honestly", () => {
  it("a calendar part whose text parses renders the event card, with no control of its own", async () => {
    const el = await render(eventsWith([calItem()], () => REQUEST_ICS));
    expect(el.querySelector(".msg-events .ics-card")).not.toBeNull();
    expect(el.querySelectorAll("a, button"), "the card is text only").toHaveLength(0);
  });

  it("the strip keeps the calendar part as a plain tile with its Save", async () => {
    const el = await render(stripWith([calItem()]));
    expect(el.querySelector(".ics-card")).toBeNull();
    expect(el.querySelector(".att-tile")).not.toBeNull();
    expect(el.textContent).toContain("invite.ics");
  });

  it("MALFORMED ics draws no card, never a broken one", async () => {
    const el = await render(eventsWith([calItem()], () => "BEGIN:VCALENDAR\r\ngarbage without an event\r\n"));
    expect(el.querySelector(".ics-card")).toBeNull();
    expect(el.querySelector(".msg-events")).toBeNull();
  });

  it("text still arriving draws nothing", async () => {
    const el = await render(eventsWith([calItem({ state: "loading" })], () => undefined));
    expect(el.querySelector(".msg-events")).toBeNull();
  });

  it("a non-calendar part is never drawn as an event", async () => {
    const el = await render(eventsWith([calItem({ id: "p1", filename: "doc.pdf", mimeType: "application/pdf" })], () => REQUEST_ICS));
    expect(el.querySelector(".ics-card")).toBeNull();
  });

  it("a disposed, NAMED .ics gets the same card — the disposition changes nothing", async () => {
    const el = await render(eventsWith([calItem({ filename: "meeting.ics" })], () => REQUEST_ICS));
    expect(el.querySelector(".ics-card")).not.toBeNull();
  });
});

/* ── a crafted calendar part cannot take the message down ─────────────────────────────────────── */

describe("a hostile calendar part draws at most its own card, never a throw", () => {
  it("DURATION past the range of a Date: one card, the start only", async () => {
    const el = await render(eventsWith([calItem({ id: "hostile-file" })], () => HOSTILE_DURATION.parts[0]!.bytes));
    expect(el.querySelectorAll(".msg-events .ics-card")).toHaveLength(1);
    expect(el.querySelector(".ics-card .ics-summary")?.textContent).toBe("Endless meeting");
  });

  it("a card whose render throws draws nothing; the other cards and the pane stay", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = new Proxy({}, { get: () => { throw new Error("hostile"); } });
    const attachments = {
      hold: () => () => {},
      eventsOf: () => [{ partId: "bad", event: throwing }, { partId: "good", event: parseIcsEvent(REQUEST_ICS)! }],
    };
    const el = await render(h("div", { className: "pane" },
      h(MessageChromeProvider as never, { value: { attachments }, children: h(MessageEvents, { messageId: "m1" }) } as never)));
    quiet.mockRestore();
    expect(el.querySelector(".pane"), "the pane went down").not.toBeNull();
    expect(el.querySelectorAll(".msg-events .ics-card")).toHaveLength(1);
  });
});
