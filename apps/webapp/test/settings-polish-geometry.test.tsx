import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderedUiFont, skipUnlessMeasuredFont } from "./_measured-font.js";
import { Button, SegmentedControl, SettingsRow, Switch, TagDot, TextField } from "@ohmail/ui";

/**
 * ═══ THE PHONE-WIDTH SETTINGS, COMPOSE AND SEARCH POLISH — MEASURED IN A REAL ENGINE ═══════════
 *
 * DESIGN-FOLD-WIDTHS §7 and the mechanical rows. jsdom lays
 * nothing out, so this drives headless Chromium over the shipped cascade and each surface's own
 * markup (the `@ohmail/ui` components where the surface uses them, the class structure of
 * `SettingsView`, `MailboxSection`, `RichEditor`, `SearchView` and `ScreenerView` where it does not)
 * and reads `getBoundingClientRect` at the widths the layout sweep found the defects at.
 *
 * Every describe ends in a RED CONTROL: the pre-fix rule re-applied as an override on the same page,
 * where the same measurement must read the defect. An arm that only admits proves nothing.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** The cascade these surfaces render under, in the order the app loads it. */
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/button.css",
  "packages/ui/src/primitives/switch.css",
  "packages/ui/src/primitives/seg.css",
  "packages/ui/src/primitives/chip.css",
  "packages/ui/src/primitives/text-field.css",
  "packages/ui/src/composites/settings.css",
  "packages/ui/src/composites/search.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/components/message-body.css",
].map(css).join("\n");

type Face = "paper" | "ohmarchy";
/** The same sheets with the app's after the package's — the load order is not one the app pins. */
const SHEETS_APP_FIRST = [
  "packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/tokens/src/ohmarchy.css", "packages/ui/src/base.css",
  "apps/webapp/app/app.css", "apps/webapp/app/components/message-body.css",
  "packages/ui/src/primitives/button.css", "packages/ui/src/primitives/switch.css", "packages/ui/src/primitives/seg.css",
  "packages/ui/src/primitives/chip.css", "packages/ui/src/primitives/text-field.css", "packages/ui/src/composites/settings.css",
  "packages/ui/src/composites/search.css",
].map(css).join("\n");

const page_ = (body: string, extra = "", face: Face = "paper", sheets = SHEETS): string =>
  `<!doctype html><html${face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}><head><meta charset="utf-8">
   <meta name="viewport" content="width=device-width,initial-scale=1">
   <style>${sheets}${extra}</style><style>body{margin:0}</style></head>
   <body class="mo-canvas">${body}</body></html>`;

/** A settings card of `width` px, the container every pane rule reads (`set-pane`). */
const pane = (width: number, inner: string, cls = ""): string =>
  `<div class="set-pane ${cls}" style="width:${width}px;box-sizing:border-box">${inner}</div>`;

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
/** The face paper's text renders in here; the arms measured in Inter read it (`_measured-font.ts`). */
let uiFont = "";
beforeAll(async () => { browser = await chromium.launch(); uiFont = await renderedUiFont(browser); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** Lay `html` out at a phone viewport (the 640px phone rules apply) and run `read` in the page. */
async function measure<T>(html: string, read: () => T, viewport = 390): Promise<T> {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 900 } });
  try {
    await page.setContent(html);
    return (await page.evaluate(read)) as T;
  } finally {
    await page.close();
  }
}

/* ══ a switch keeps its row ═════════════════════════════════════════════════════════════ */

const switchRow = renderToStaticMarkup(
  <SettingsRow
    label="People in Ohbox"
    description="Mail from people you said Yes to"
    control={<Switch checked onChange={() => {}} ariaLabel="People in Ohbox" />}
  />,
);
const readSwitch = (): { sw: Rect; lab: Rect; row: Rect } => {
  const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as Rect;
  return { sw: r(".switch"), lab: r(".set-row .lab"), row: r(".set-row") };
};

describe("the on/off switch stays beside its label on a phone", () => {
  for (const width of [280, 300, 328, 360, 640]) {
    it(`a ${width}px card: the switch shares the label's line and stays inside the row`, async () => {
      const m = await measure(page_(pane(width, switchRow)), readSwitch);
      expect(m.sw.top, "the switch dropped under its label").toBeLessThan(m.lab.bottom - 1);
      expect(m.sw.right).toBeLessThanOrEqual(m.row.right + 0.5);
      expect(m.sw.width, "the switch was squeezed").toBeGreaterThanOrEqual(40);
    });
  }
  it("RED CONTROL: the label's old 200px floor drops the switch at 300", async () => {
    const m = await measure(page_(pane(300, switchRow), ".set-pane .set-row:has(> .switch) > .lab{flex:1 1 200px}"), readSwitch);
    expect(m.sw.top).toBeGreaterThanOrEqual(m.lab.bottom - 1);
  });
});

/* ══ the new-tag colour dot is a swatch, never a bar ════════════════════════════════════ */

const tagCreate = renderToStaticMarkup(
  <div className="set-row set-tag-edit set-tag-new">
    <TagDot hue="moss" />
    <TextField className="set-tag-input" value="" placeholder="Name a new tag…" aria-label="New tag" onChange={() => {}} />
    <span className="set-tag-acts"><Button variant="primary" disabled>Add</Button></span>
  </div>,
);
const readTag = (): { dot: Rect; input: Rect; add: Rect } => {
  const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as Rect;
  return { dot: r(".tdot"), input: r(".set-tag-input"), add: r(".set-tag-acts .btn") };
};

describe("the tag colour swatch keeps 12-16px at every width", () => {
  for (const [order, sheets] of [["package first", SHEETS], ["app first", SHEETS_APP_FIRST]] as const) for (const width of [328, 360, 470, 640, 760]) {
    it(`${order}, a ${width}px card: the dot is a 12-16px square on the field's line`, async () => {
      const m = await measure(page_(pane(width, tagCreate), "", "paper", sheets), readTag);
      expect(m.dot.width, "the dot was stretched into a bar").toBeLessThanOrEqual(16);
      expect(m.dot.width).toBeGreaterThanOrEqual(12);
      expect(m.dot.height).toBeLessThanOrEqual(16);
      const mid = (m.dot.top + m.dot.bottom) / 2;
      expect(mid, "the dot stands on a line of its own").toBeGreaterThan(m.input.top);
      expect(mid).toBeLessThan(m.input.bottom);
    });
  }
  it("RED CONTROL: without the fix the stacked row stretches the dot across the card", async () => {
    const pre = ".set-tag-edit > .tdot{width:8px;height:8px} .set-pane .set-row.set-tag-edit:has(> .set-tag-input){flex-direction:column;align-items:stretch} .set-pane .set-row.set-tag-edit:has(> .set-tag-input) > *{width:auto !important}";
    const m = await measure(page_(pane(328, tagCreate), pre), readTag);
    expect(m.dot.width).toBeGreaterThan(100);
  });
});

/* ══ a two-option segmented control stays one row, the mono face included ══════════════ */

const pairRow = (form: "fill" | "stack" | "row"): string =>
  renderToStaticMarkup(
    <SettingsRow
      label="Who gets a reply"
      description="Senders still waiting in the Screener are not answered."
      control={
        <SegmentedControl
          options={[{ id: "known", label: "People I've let in" }, { id: "all", label: "Everyone who writes" }]}
          value="known"
          onChange={() => {}}
          ariaLabel="Who gets a reply"
        />
      }
    />,
  ).replace('class="seg"', `class="seg"${form === "row" ? "" : ` data-${form}=""`}`);
const readSeg = (): { a: Rect; b: Rect; seg: Rect; row: Rect } => {
  const bs = document.querySelectorAll(".seg button");
  const r = (e: Element) => e.getBoundingClientRect().toJSON() as Rect;
  return { a: r(bs[0]!), b: r(bs[1]!), seg: r(document.querySelector(".seg")!), row: r(document.querySelector(".set-row")!) };
};

describe("the segmented pair is one row in the form the control picks when it overflows", () => {
  for (const face of ["paper", "ohmarchy"] as const) {
    for (const width of [264, 300, 330]) {
      it(`${face}, a ${width}px card: both halves on one line, inside the row`, async () => {
        const m = await measure(page_(pane(width, pairRow("fill")), "", face), readSeg);
        expect(Math.abs(m.a.top - m.b.top), "the pair broke into two rows").toBeLessThan(1);
        expect(m.b.right).toBeLessThanOrEqual(m.row.right + 0.5);
        expect(m.seg.right).toBeLessThanOrEqual(m.row.right + 0.5);
        expect(Math.abs(m.a.width - m.b.width), "the halves are not equal").toBeLessThan(1);
      });
    }
  }
  it("the row form of the same pair does not fit a 264px card in the mono face — the case the fill answers", async () => {
    const m = await measure(page_(pane(264, pairRow("row")), "", "ohmarchy"), readSeg);
    expect(m.b.right, "the premise is gone: the row form now fits").toBeGreaterThan(m.row.right + 0.5);
  });
  /* REVIEW LOW 3: a single word longer than its half ("ohmarchy" in the mono face, the row forced to
     170px as the review forced it) painted past the half. It wraps inside its own button. The row is
     forced to 148px now: its content box is the 144px that 170 gave while the phone list's padding
     leaked onto every settings row, so the red control below still has a word wider than its half. */
  const wordPair = renderToStaticMarkup(
    <SettingsRow label="Face" control={<SegmentedControl options={[{ id: "p", label: "paper" }, { id: "o", label: "ohmarchy" }]} value="o" onChange={() => {}} ariaLabel="Face" />} />,
  ).replace('class="seg"', 'class="seg" data-fill=""');
  const readHalves = (): Array<{ over: number; right: number; segRight: number }> => {
    const seg = document.querySelector(".seg")!.getBoundingClientRect();
    return [...document.querySelectorAll(".seg button")].map((b) => {
      const range = document.createRange(); range.selectNodeContents(b);
      const ink = Math.max(...[...range.getClientRects()].map((r) => r.right));
      return { over: ink - b.getBoundingClientRect().right, right: b.getBoundingClientRect().right, segRight: seg.right };
    });
  };
  for (const face of ["paper", "ohmarchy"] as const) {
    it(`${face}, a 148px row: a one-word label wraps inside its half`, async () => {
      const m = await measure(page_(pane(260, wordPair), ".set-pane .set-row:has(> .seg){max-width:148px}", face), readHalves);
      for (const h of m) {
        expect(h.over, "a label paints past its half").toBeLessThanOrEqual(0.5);
        expect(h.right).toBeLessThanOrEqual(h.segRight + 0.5);
      }
    });
  }
  it("RED CONTROL: without overflow-wrap the mono word runs past its half", async () => {
    const m = await measure(page_(pane(260, wordPair), ".set-pane .set-row:has(> .seg){max-width:148px} .seg[data-fill] button{overflow-wrap:normal !important}", "ohmarchy"), readHalves);
    expect(Math.max(...m.map((h) => h.over))).toBeGreaterThan(0.5);
  });
  it("RED CONTROL: the stacked form puts the pair on two rows", async () => {
    const m = await measure(page_(pane(264, pairRow("stack")), "", "ohmarchy"), readSeg);
    expect(m.b.top).toBeGreaterThan(m.a.top + 1);
  });
});

/* ══ the mailbox row's status and verbs ═════════════════════════════════════════════════ */

/** `wrapped` is the shipped markup (the verbs one `.mbx-verbs` item); false is the base's, for red controls. */
const mbxRow = (withBox: boolean, wrapped = true): string => `
<div class="mbx-entry"><div class="mbx-row">
  <div class="mbx-main"><span class="mbx-addr">mila@fixture.invalid</span>
    <span class="mbx-sub">Any other IMAP mailbox · connected · ${"3,086"} messages</span>
    ${withBox ? `<div class="mbx-org" data-role="organizer"><div class="set-banner"><div class="lab"><b>Organizing</b>
      <span>ohmail Cloud files this mailbox, whether or not this page is open: it moves mail into your folders, screens strangers and applies your rules.</span></div>
      <button type="button" class="btn ghost">Hand the mailbox back — the mail stays where it is.</button></div></div>` : ""}
  </div>
  <div class="mbx-state"><span class="mbx-ok" title="x">Synced 1 minute ago</span>
    ${wrapped ? '<span class="mbx-verbs">' : ""}<button type="button" class="btn mbx-btn">Sync now</button><button type="button" class="btn mbx-btn">Edit</button><button type="button" class="btn mbx-btn">Remove</button>${wrapped ? "</span>" : ""}
  </div>
</div></div>`;
const readMbx = (): { status: Rect; verbs: Rect[]; state: Rect; main: Rect; card: Rect } => {
  const r = (e: Element) => e.getBoundingClientRect().toJSON() as Rect;
  return {
    status: r(document.querySelector(".mbx-ok")!),
    verbs: [...document.querySelectorAll(".mbx-btn")].map(r),
    state: r(document.querySelector(".mbx-state")!),
    main: r(document.querySelector(".mbx-main")!),
    card: r(document.querySelector(".set-pane")!),
  };
};
/** One line by vertical centre: a 12px stamp and a capsule share a line without sharing a top. */
const oneLine = (rs: Rect[]): boolean => rs.every((x) => Math.abs((x.top + x.bottom) / 2 - (rs[0]!.top + rs[0]!.bottom) / 2) < 2);

describe("Sync now, Edit and Remove stand on one row", () => {
  for (const width of [300, 328, 360, 440]) {
    it(`a ${width}px card: the status on its own line, the three verbs one row under it, flush left`, async () => {
      const m = await measure(page_(pane(width, mbxRow(true))), readMbx);
      expect(oneLine(m.verbs), "a verb went to a line of its own").toBe(true);
      expect(m.verbs[0]!.top, "the verbs are not under the status").toBeGreaterThanOrEqual(m.status.bottom - 1);
      expect(Math.abs(m.verbs[0]!.left - m.status.left), "the verbs are not flush left").toBeLessThan(1);
      expect(m.verbs[1]!.left - m.verbs[0]!.right).toBeCloseTo(8, 0);
      expect(m.verbs[2]!.right).toBeLessThanOrEqual(m.state.right + 0.5);
    });
  }
  /* every 5px from 540 to 760 (the pane query reads the CONTENT box; 540 is the first card past 480px of it):
     the stamp is squeezed hardest at the width where the column has only just come up beside the box */
  for (const width of Array.from({ length: 45 }, (_, i) => 540 + 5 * i)) {
    for (const withBox of [true, false]) {
      it(`a ${width}px card${withBox ? " with the Organizing box" : ""}: status and verbs on one line, the verbs whole`, async (ctx) => {
        skipUnlessMeasuredFont(uiFont, ctx);
        const m = await measure(page_(pane(width, mbxRow(withBox))), readMbx, 1100);
        expect(oneLine([m.status, ...m.verbs]), "the state column wrapped").toBe(true);
        expect(m.status.width, "the sync stamp was squeezed out of sight").toBeGreaterThanOrEqual(60);
        expect(m.verbs[2]!.right).toBeLessThanOrEqual(m.card.right + 0.5);
        const beside = m.state.top < m.main.bottom - 1;
        if (beside) expect(m.status.left, "the state column runs over the address and the box").toBeGreaterThanOrEqual(m.main.right - 0.5);
        expect(m.status.left, "the state column overflows its own box").toBeGreaterThanOrEqual(m.state.left - 0.5);
        if (beside) expect(m.state.width, "beside the box with under 200px").toBeGreaterThanOrEqual(200);
        else expect(m.state.width, "under the box but not full width").toBeGreaterThan(m.main.width - 1);
      });
    }
  }
  /* REVIEW LOW 1: above 480px of card the German verbs ran Remove past the pane (ohmarchy at 1024, 1180,
     1440; paper with the reconnect verb), because the stamp never gave way. The panes are the real ones:
     530 and 548 (1024 three-pane, paper and ohmarchy), 574 (1180 and 1440), 652 (700), 712 (760). */
  const DE = { sub: "Anderes IMAP-Postfach · verbunden · 3086 Nachrichten", ok: "Synchronisiert vor 1 Minute",
    sync: "Jetzt synchronisieren", rm: "Entfernen", box: "Postfach zurückgeben. Die Mails bleiben, wo sie sind." };
  const EN = { sub: "Any other IMAP mailbox · connected · 3,086" + " messages", ok: "Synced 1 minute ago",
    sync: "Sync now", rm: "Remove", box: "Hand the mailbox back — the mail stays where it is." };
  const localRow = (t: typeof DE, verb2: string, withBox: boolean, wrapped = true): string =>
    mbxRow(withBox, wrapped).replace("Any other IMAP mailbox · connected · 3,086" + " messages", t.sub).replace("Synced 1 minute ago", t.ok)
      .replace(">Sync now<", `>${t.sync}<`).replace(">Edit<", `>${verb2}<`).replace(">Remove<", `>${t.rm}<`)
      .replace("Hand the mailbox back — the mail stays where it is.", t.box);
  const readFit = (): { verbs: Rect[]; status: Rect; inner: number; overflow: number; room: boolean } => {
    const pane = document.querySelector(".set-pane") as HTMLElement;
    const cs = getComputedStyle(pane);
    const state = document.querySelector(".mbx-state") as HTMLElement;
    const ok = document.querySelector(".mbx-ok") as HTMLElement;
    const group = document.querySelector(".mbx-verbs") as HTMLElement | null;
    /* From 480px of card content: room for the 8ch stamp and the verbs on one line of the state column. */
    const wide = pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) > 480;
    const room = wide && !!group && parseFloat(getComputedStyle(ok).minWidth) + parseFloat(getComputedStyle(state).columnGap)
      + group.getBoundingClientRect().width <= state.getBoundingClientRect().width;
    return {
      room,
      verbs: [...document.querySelectorAll(".mbx-btn")].map((e) => e.getBoundingClientRect().toJSON() as Rect),
      status: document.querySelector(".mbx-ok")!.getBoundingClientRect().toJSON() as Rect,
      inner: pane.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
      overflow: pane.scrollWidth - pane.clientWidth,
    };
  };
  for (const face of ["paper", "ohmarchy"] as const) for (const [lang, t, v2s] of [["de", DE, ["Bearbeiten", "Microsoft neu verbinden"]], ["en", EN, ["Edit", "Reconnect Microsoft"]]] as const)
    /* the real panes' widths and every 12px from 540 to 756 between them */
    for (const verb2 of v2s) for (const width of [...new Set([530, 548, 574, 652, 712, ...Array.from({ length: 19 }, (_, i) => 540 + 12 * i)])]) for (const withBox of [false, true]) {
      it(`${face} ${lang}, "${verb2}", a ${width}px card${withBox ? " with the box" : ""}: every verb inside the pane, the stamp shown`, async () => {
        const m = await measure(page_(pane(width, localRow(t, verb2, withBox)), "", face), readFit, 1440);
        for (const v of m.verbs) expect(v.right, "a verb runs past the pane").toBeLessThanOrEqual(m.inner + 0.5);
        expect(m.overflow, "the pane scrolls sideways").toBeLessThanOrEqual(0);
        expect(oneLine(m.verbs), "the verbs left their row").toBe(true);
        expect(m.status.width, "the stamp was squeezed out of sight").toBeGreaterThanOrEqual(48);
        const beside = Math.abs((m.status.top + m.status.bottom) / 2 - (m.verbs[0]!.top + m.verbs[0]!.bottom) / 2) < 2;
        if (!beside) expect(m.status.bottom, "the stamp is not on its own line above the verbs").toBeLessThanOrEqual(m.verbs[0]!.top + 0.5);
        /* The stamp ellipsises before it leaves the verbs' line: where 8ch and the verbs fit, they share it. */
        if (m.room) expect(beside, "the stamp left the verbs' line while it could still give way").toBe(true);
      });
    }
  /* VERIFY LOW B: the address is read first, so it gives way last. Above 480px of card the state
     column goes under the address before the address truncates; the stamp ellipsises instead. */
  for (const face of ["paper", "ohmarchy"] as const) for (const [lang, t, v2] of [["de", DE, "Bearbeiten"], ["en", EN, "Edit"]] as const)
    for (const width of [540, 574, 600, 652, 660, 712, 760]) {
      it(`${face} ${lang}, a ${width}px card: the address whole`, async () => {
        const cut = await measure(page_(pane(width, localRow(t, v2, false)), "", face), () => {
          const a = document.querySelector(".mbx-addr") as HTMLElement;
          return a.scrollWidth > a.clientWidth + 0.5;
        }, 1440);
        expect(cut, "the address was cut while the stamp could still give way").toBe(false);
      });
    }
  /* The column ASKS for its verbs and an 8ch stamp, not the whole stamp: in a 712 or 730px paper card
     (760 wide and up) it stands beside the whole address with the stamp cut short, rather than under. */
  for (const width of [712, 730]) {
    it(`paper en, a ${width}px card: the column beside the address, the stamp ellipsised`, async () => {
      const m = await measure(page_(pane(width, localRow(EN, "Edit", false)), "", "paper"), () => {
        const r = (q: string) => document.querySelector(q)!.getBoundingClientRect();
        const ok = document.querySelector(".mbx-ok") as HTMLElement;
        return { stateTop: r(".mbx-state").top, mainBottom: r(".mbx-main").bottom, cut: ok.scrollWidth > ok.clientWidth };
      }, 1440);
      expect(m.stateTop, "the column went under the address").toBeLessThan(m.mainBottom);
      expect(m.cut, "the stamp is whole: the premise of this case is gone").toBe(true);
    });
  }
  /* Under 480px of card a German verb row can need two lines (paper at 360: 280px of content). Each
     line of verbs starts flush left under the status, never hung right. */
  for (const face of ["paper", "ohmarchy"] as const) for (const width of [300, 312, 342]) {
    it(`${face} de, a ${width}px card: every line of verbs starts flush left under the status`, async () => {
      const m = await measure(page_(pane(width, localRow(DE, "Microsoft neu verbinden", false)), "", face), readFit);
      const lines = [...new Set(m.verbs.map((v) => Math.round(v.top)))];
      for (const top of lines) {
        const first = Math.min(...m.verbs.filter((v) => Math.round(v.top) === top).map((v) => v.left));
        expect(Math.abs(first - m.status.left), "a line of verbs is not flush left").toBeLessThan(1);
      }
      for (const v of m.verbs) expect(v.right).toBeLessThanOrEqual(m.inner + 0.5);
    });
  }
  it("RED CONTROL: the first round's rules (the stamp's text in the column's minimum) run Remove past a 548px ohmarchy pane", async () => {
    const pre = ".mbx-state{flex:1 1 200px !important;width:auto !important;flex-wrap:nowrap !important;min-width:min-content !important}"
      + " .mbx-state > .mbx-ok{flex:0 1 auto !important;min-width:0 !important;contain:none !important}";
    const m = await measure(page_(pane(548, localRow(DE, "Microsoft neu verbinden", false, false)), pre, "ohmarchy"), readFit, 1440);
    expect(Math.max(...m.verbs.map((v) => v.right))).toBeGreaterThan(m.inner + 0.5);
  });

  it("RED CONTROL: the old wrapping state column leaves Remove alone on a line at 328", async () => {
    const pre = "@container set-pane (max-width: 480px){.mbx-state{flex-wrap:wrap !important;justify-content:space-between !important} .mbx-state > .mbx-ok{flex:0 1 auto !important;white-space:nowrap}}";
    const m = await measure(page_(pane(328, mbxRow(true, false)), pre), readMbx);
    expect(oneLine(m.verbs)).toBe(false);
  });
});

/* ══ Account, Devices and Security are as wide as every other settings card ═══════════ */

describe("one card width for every settings pane", () => {
  const layout = `<div class="set-layout" style="width:760px;display:block">
    ${pane(760, "<p>General</p>").replace('style="width:760px;box-sizing:border-box"', "")}
    ${pane(760, '<h2 class="acct-h">Sign out</h2>', "acct acct-session").replace('style="width:760px;box-sizing:border-box"', "")}
  </div>`;
  const read = (): number[] => [...document.querySelectorAll(".set-pane")].map((p) => p.getBoundingClientRect().width);
  it("the account card fills the column like the general card", async () => {
    const [general, account] = await measure(page_(layout), read, 1100);
    expect(Math.abs(general! - account!), "SETTINGS_CARD_WIDTH_DRIFT").toBeLessThanOrEqual(2);
  });
  it("RED CONTROL: the old 620px cap draws the account card narrower", async () => {
    const [general, account] = await measure(page_(layout, ".acct{max-width:620px}"), read, 1100);
    expect(general! - account!).toBeGreaterThan(2);
  });
});

/* ══ the formatting toolbar is one row ═══════════════════════════════════════════════════ */

const GLYPHS = ["B", "I", "S", "‹›", "🔗", "•", "1.", "❝"];
const bar = (width: number): string =>
  `<div class="rte" style="width:${width}px"><div class="rte-bar" role="toolbar">${GLYPHS.map((g) => `<button type="button" class="rte-b">${g}</button>`).join("")}</div></div>`;
const readBar = (): { tops: number[]; widths: number[]; bar: Rect; overflow: number } => {
  const b = document.querySelector(".rte-bar") as HTMLElement;
  const bs = [...b.querySelectorAll(".rte-b")].map((x) => x.getBoundingClientRect());
  return { tops: bs.map((x) => x.top), widths: bs.map((x) => x.width), bar: b.getBoundingClientRect().toJSON() as Rect, overflow: b.scrollWidth - b.clientWidth };
};

describe("Quote never sits alone on a second toolbar row", () => {
  for (const width of [286, 300, 330, 360]) {
    it(`a ${width}px editor: eight buttons on one row, none outside the bar`, async () => {
      const m = await measure(page_(bar(width)), readBar);
      expect(new Set(m.tops.map(Math.round)).size, "TOOLBAR_WRAPPED").toBe(1);
      expect(m.overflow, "the bar overflows its own box").toBeLessThanOrEqual(0);
      expect(Math.min(...m.widths)).toBeGreaterThanOrEqual(32);
    });
  }
  it("a 250px editor: still one row, the buttons give width rather than wrap or overflow", async () => {
    const m = await measure(page_(bar(250)), readBar);
    expect(new Set(m.tops.map(Math.round)).size, "TOOLBAR_WRAPPED").toBe(1);
    expect(m.overflow).toBeLessThanOrEqual(0);
    expect(Math.min(...m.widths)).toBeGreaterThanOrEqual(26);
  });
  it("a 600px editor keeps the 34px buttons", async () => {
    const m = await measure(page_(bar(600)), readBar, 1100);
    expect(Math.min(...m.widths)).toBeGreaterThanOrEqual(34);
  });
  it("RED CONTROL: the old wrapping bar puts a button on a second row at 300", async () => {
    const m = await measure(page_(bar(300), ".rte-bar{flex-wrap:wrap !important} @container rte-bar (max-width: 399.98px){.rte-bar > .rte-b{min-width:34px !important;width:auto !important;height:34px !important;padding:0 7px !important}}"), readBar);
    expect(new Set(m.tops.map(Math.round)).size).toBeGreaterThan(1);
  });
});

/* ══ a count and its word, a time and its unit, never split ════════════════════════════ */

const scopeLine = (width: number): string =>
  `<section class="view col view-search"><div class="results-head" style="width:${width}px">Searched your whole mailbox — <span class="nobr">936 matched · 109 ms</span></div></section>`;
const readLines = (): { matched: number; ms: number; first: number } => {
  const head = document.querySelector(".results-head")!;
  const text = head.querySelector(".nobr")!.firstChild as Text;
  const at = (needle: string) => {
    const i = text.data.indexOf(needle);
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + needle.length);
    return range.getClientRects()[0]!.top;
  };
  return { matched: at("matched"), ms: at("ms"), first: at("936") };
};

describe("the search line keeps '936 matched · 109 ms' whole", () => {
  for (const width of [220, 260, 300, 328]) {
    it(`a ${width}px column: the number, its word and the time on one line`, async () => {
      const m = await measure(page_(scopeLine(width)), readLines);
      expect(m.matched, "UNIT_ORPHAN: 'matched' left its number").toBe(m.first);
      expect(m.ms, "UNIT_ORPHAN: 'ms' left its number").toBe(m.first);
    });
  }
  it("RED CONTROL: without the unbreakable span the unit breaks off at 260", async () => {
    const m = await measure(page_(scopeLine(260), ".view-search .nobr{white-space:normal !important}"), readLines);
    expect(m.ms === m.first && m.matched === m.first).toBe(false);
  });
});

/* ══ "Original" is a header control in the held card's line ════════════════════════════ */

const heldLine = (width: number): string => `
<article class="hmail" style="width:${width}px"><div class="hm-line">
  <button type="button" class="hm-who"><b>ohmail</b><span class="addr">no-reply@fixture.invalid</span></button>
  <span class="t num">4 Aug</span>
  <span class="hm-adapt"><button type="button" class="mb-bar-btn" aria-pressed="false">Original</button></span>
</div><h2>Verify your email</h2><div class="hm-body"><div class="mb"><div class="mb-sheet" style="height:200px"></div></div></div></article>`;
const readHeld = (): { btn: Rect; t: Rect; sheet: Rect; line: Rect; pos: string } => {
  const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as Rect;
  return { btn: r(".mb-bar-btn"), t: r(".hm-line .t"), sheet: r(".mb-sheet"), line: r(".hm-line"), pos: getComputedStyle(document.querySelector(".mb-bar-btn")!).position };
};

describe("the dark toggle stands right of the date, in flow", () => {
  for (const width of [290, 340, 380, 600]) {
    it(`a ${width}px card: the toggle is in the header line, after the date, clear of the mail`, async () => {
      const m = await measure(page_(heldLine(width)), readHeld, 1100);
      expect(m.pos, "ADAPT_TOGGLE_FIXED").not.toBe("fixed");
      expect(m.btn.left, "the toggle is not right of the date").toBeGreaterThanOrEqual(m.t.right);
      expect(m.btn.bottom, "OVERLAP: the toggle sits on the mail").toBeLessThanOrEqual(m.sheet.top);
      expect(m.btn.right).toBeLessThanOrEqual(m.line.right + 0.5);
      const mid = (m.btn.top + m.btn.bottom) / 2;
      expect(mid, "the toggle left the date's line").toBeGreaterThan(m.t.top - 8);
      expect(mid).toBeLessThan(m.t.bottom + 8);
    });
  }
  /* LOOK UGLY 2: the pill hung 5-6px below the date's line — the slot was centred on a line the
     23px pill itself made taller. The pill's label sits on the date's line. */
  const readInk = (): { label: number; date: number } => {
    const mid = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
    return { label: mid(document.querySelector(".hm-adapt .mb-bar-btn")!), date: mid(document.querySelector(".hm-line .t")!) };
  };
  for (const face of ["paper", "ohmarchy"] as const) for (const width of [364, 600, 760]) {
    it(`${face}, a ${width}px card: the Original label sits on the date's line`, async () => {
      const m = await measure(page_(heldLine(width), "", face), readInk, 1100);
      expect(Math.abs(m.label - m.date), "the pill hangs off the date's line").toBeLessThanOrEqual(2);
    });
  }
  it("an empty slot takes no room", async () => {
    const html = page_(heldLine(340).replace(/<button type="button" class="mb-bar-btn"[^<]*<\/button>/, ""));
    const w = await measure(html, () => document.querySelector(".hm-adapt")!.getBoundingClientRect().width, 1100);
    expect(w).toBe(0);
  });
  it("RED CONTROL: a fixed toggle (the reported shape) overlaps the mail", async () => {
    const m = await measure(page_(heldLine(340), ".hm-adapt .mb-bar-btn{position:fixed;left:250px;top:120px}"), readHeld, 1100);
    expect(m.pos === "fixed" && m.btn.bottom > m.sheet.top).toBe(true);
  });
});

/* ══ the To row never runs its input under Cc/Bcc ═══════════════════════════════════════ */

const toRow = (width: number, toggle: string, hint: string): string => `
<div class="compose-head" style="width:${width}px"><div class="c-field"><label>An</label>
  <div class="rcp"><div class="rcp-box"><input class="tf tf-line rcp-input" id="compose-to" placeholder="${hint}" type="text" value=""></div></div>
  <button type="button" class="c-ccbcc-toggle">${toggle}</button></div></div>`;
const readTo = (): { input: Rect; toggle: Rect; row: Rect } => {
  const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as Rect;
  return { input: r("#compose-to"), toggle: r(".c-ccbcc-toggle"), row: r(".c-field") };
};

describe("the To input stays clear of the Cc/Bcc button, German included", () => {
  for (const face of ["paper", "ohmarchy"] as const) {
    for (const [width, toggle] of [[264, "Kopie/Blindkopie"], [300, "Kopie/Blindkopie"], [264, "Cc/Bcc"], [400, "Kopie/Blindkopie"]] as const) {
      it(`${face}, a ${width}px row with "${toggle}": the input ends before the button`, async () => {
        const m = await measure(page_(toRow(width, toggle, "name@beispiel.de"), "", face), readTo);
        expect(m.input.right, "OVERLAP: the input runs under the Cc/Bcc button").toBeLessThanOrEqual(m.toggle.left + 0.5);
        expect(m.toggle.right).toBeLessThanOrEqual(m.row.right + 0.5);
      });
    }
  }
  it("a row with room keeps the 120px typeable floor", async () => {
    const m = await measure(page_(toRow(600, "Cc/Bcc", "name@example.com")), readTo, 1100);
    expect(m.input.width).toBeGreaterThanOrEqual(120);
  });
  it("RED CONTROL: the bare 120px floor runs the input under the German button at 264", async () => {
    const m = await measure(page_(toRow(264, "Kopie/Blindkopie", "name@beispiel.de"), "input.rcp-input{min-width:120px !important}", "ohmarchy"), readTo);
    expect(m.input.right).toBeGreaterThan(m.toggle.left + 0.5);
  });
});
