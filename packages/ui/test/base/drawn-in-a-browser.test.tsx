/**
 * WHAT A PERSON SEES OF A PART, IN A REAL BROWSER: what jsdom cannot lay out. Each case draws parts of the kit
 * with the entry's own sheets, in a window of the size it names, and reads what the browser computed.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { Button, Dialog, Dot, Empty, Field, JumpBack, Page, Sentence } from "../../src/base/index.js";
import { MiniMonth } from "../../src/calendar/index.js";
import {
  ActionPanel,
  ColumnHandle,
  Message,
  MessageHead,
  Row,
  Rows,
  Sheet,
  TextNotKept,
  type RowProps,
} from "../../src/mail/index.js";
import { DEVICES, entryCss, fontsCss, type Device, type Entry } from "../compare/harness.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>> | null = null;
beforeAll(async () => {
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

interface Drawn {
  entry?: Entry;
  device?: Device;
  face?: "paper" | "ohmarchy";
  scheme?: "light" | "dark";
  lang?: string;
  /** The person asked for less motion. */
  still?: boolean;
  /** What a real pointer stands over while it is read: the last of them, reached through the others. */
  hover?: string | string[];
  /** What the pointer is held down on while it is read (after `hover`). */
  press?: string;
  /** The keys pressed, in order, before it is read. */
  keys?: string[];
}

/** A page with the parts in the entry's root, the device's window and root attributes; `read` runs in it. */
async function drawn<T>(parts: ReactNode, read: () => T, at: Drawn = {}): Promise<T> {
  const {
    entry = "base",
    device = "desktop",
    face = "paper",
    scheme = "light",
    lang = "en",
    still = true,
    hover,
    press,
    keys = [],
  } = at;
  const root = {
    "data-face": face,
    "data-scheme": scheme,
    ...DEVICES[device].root,
    "data-icons": "1",
    "data-rm": still ? "1" : "0",
  };
  const attrs = Object.entries(root)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const [width, height] = DEVICES[device].window;
  const tab = await browser!.newPage({
    viewport: { width, height },
    reducedMotion: still ? "reduce" : "no-preference",
  });
  try {
    await tab.setContent(`<!doctype html><html lang="${lang}"${attrs}><head><meta charset="utf-8">
<style>${await fontsCss()}</style><style>${await entryCss(entry)}</style><style>html,body{margin:0}</style></head>
<body><div class="oh-root">${renderToStaticMarkup(parts)}</div></body></html>`);
    await tab.evaluate(() => document.fonts.ready);
    for (const over of [hover ?? []].flat()) await tab.hover(over);
    if (press) {
      await tab.hover(press);
      await tab.mouse.down();
    }
    for (const key of keys) await tab.keyboard.press(key);
    return await tab.evaluate(read);
  } finally {
    await tab.close();
  }
}

describe("the full stop", () => {
  it("a step still ahead is a hollow dot ringed in the second ink, in either scheme", async () => {
    for (const scheme of ["light", "dark"] as const) {
      const seen = await drawn(
        <p className="oh-text">
          Account
          <Dot kind="todo" />
        </p>,
        () => {
          const dot = document.querySelector("[aria-hidden='true']")!;
          const probe = document.createElement("i");
          probe.style.color = "var(--ink2)";
          document.body.append(probe);
          const ink2 = getComputedStyle(probe).color;
          const cs = getComputedStyle(dot);
          return { ground: cs.backgroundColor, ring: cs.boxShadow, ink2 };
        },
        { scheme },
      );
      expect(seen.ground, scheme).toBe("rgba(0, 0, 0, 0)");
      expect(seen.ring, scheme).toBe(`${seen.ink2} 0px 0px 0px 2px inset`);
    }
  }, 60_000);
});

describe("a dialog", () => {
  it("stands inside a phone's window, its edge's room clear on both sides, with a field and long German ways", async () => {
    const seen = await drawn(
      <Dialog
        open
        onClose={() => {}}
        title="Bestätige, dass du es bist"
        hot
        line="Bevor dieses Gerät verknüpft wird"
        confirm={{ label: "Bestätigen", onPress: () => {}, keyHint: "↵" }}
        cancel={{ label: "Abbrechen", keyHint: "Esc" }}
      >
        <Field
          label="Code aus deiner Authentifizierungs-App"
          value=""
          hint="Sechs Ziffern"
          onChange={() => {}}
        />
        <p>
          <Button kind="quiet" size="s" onPress={() => {}}>
            Stattdessen einen Wiederherstellungscode verwenden
          </Button>
          <Button kind="quiet" size="s" onPress={() => {}}>
            Stattdessen einen Passkey verwenden
          </Button>
        </p>
      </Dialog>,
      () => {
        const box = document.querySelector("[role='dialog']")!.getBoundingClientRect();
        const probe = document.createElement("i");
        probe.style.cssText = "display:block;width:var(--s4)";
        document.querySelector(".oh-root")!.append(probe);
        return {
          left: box.left,
          right: box.right,
          edge: probe.getBoundingClientRect().width,
          window: innerWidth,
          sideways: document.documentElement.scrollWidth - innerWidth,
        };
      },
      { device: "phone", lang: "de" },
    );
    expect(seen.window).toBe(390);
    expect([seen.left, seen.right, seen.sideways]).toEqual([seen.edge, 390 - seen.edge, 0]);
  }, 60_000);
});

describe("a dialog's other ways", () => {
  it("stand under its answers, one under the other, their words in line with the dialog's (the sheet's step-up dialog)", async () => {
    const seen = await drawn(
      <Dialog
        open
        onClose={() => {}}
        title="Confirm with a one-time code"
        hot
        confirm={{ label: "Verify code", onPress: () => {}, keyHint: "↵" }}
        cancel={{ label: "Cancel", keyHint: "Esc" }}
        under={
          <>
            <Button kind="quiet" size="s" onPress={() => {}}>
              Use a passkey instead
            </Button>
            <Button kind="quiet" size="s" onPress={() => {}}>
              Use a recovery code instead
            </Button>
          </>
        }
      >
        <Field label="Six-digit code from your authenticator app" value="" onChange={() => {}} />
      </Dialog>,
      () => {
        const box = (el: Element) => el.getBoundingClientRect();
        const dialog = document.querySelector("[role='dialog']")!;
        const acts = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Cancel"))!;
        const ways = [...dialog.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Use a"));
        const pad = parseFloat(getComputedStyle(dialog).paddingLeft);
        return {
          content: box(dialog).left + pad,
          actsBottom: box(acts).bottom,
          ways: ways.map((w) => [box(w).left, box(w).top, box(w).height]),
          last: dialog.lastElementChild?.contains(ways[0]!) ?? false,
        };
      },
    );
    /* The reference (doors.css .dialog .dr-alt; the step-up dialog at 1440): the ways 12 under the answers, each a
       small quiet button of 32 drawn 12 left of the dialog's text so its word stands in line with it. */
    expect(seen.last).toBe(true);
    expect(seen.ways).toHaveLength(2);
    const [first, second] = seen.ways as [number[], number[]];
    expect(first[1]! - seen.actsBottom).toBeCloseTo(12, 1);
    expect(first[0]).toBeCloseTo(seen.content - 12, 1);
    expect(second[0]).toBeCloseTo(seen.content - 12, 1);
    expect([first[2], second[2]]).toEqual([32, 32]);
    expect(second[1]).toBeCloseTo(first[1]! + 32, 1);
  }, 60_000);
});

describe("a page before the app", () => {
  /* The delete page's parts: a sentence, two sheets to read beside it, its line, one ink act. */
  const page = (props: Partial<Parameters<typeof Page>[0]> = {}) => (
    <div style={{ boxSizing: "border-box", height: "100vh", display: "grid", placeItems: "center" }}>
      <Page
        back={<Button kind="quiet" icon="back" label="Back" />}
        line="This cannot be undone."
        note="Your mail is on your own mail server."
        material={<div className="zz-sheets" style={{ height: 600 }} />}
        columns={2}
        acts={<Button size="l">Delete my account</Button>}
        {...props}
      >
        <Sentence size="xl">
          Delete my account
          <Dot kind="hot" />
        </Sentence>
      </Page>
    </div>
  );
  const read = () => {
    const box = (sel: string) => {
      const b = document.querySelector(sel)!.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    const body = getComputedStyle(document.querySelector(".oh-page-body")!);
    const back = document.querySelector<HTMLElement>(".oh-page-back button")!;
    const look = getComputedStyle(back);
    const probe = document.createElement("i");
    probe.style.cssText = "color:var(--sheet);border-color:var(--ctl-ring)";
    document.body.append(probe);
    const sentence = document.querySelector(".oh-page-say .oh-sentence")!;
    return {
      top: box(".oh-page-top"),
      say: box(".oh-page-say"),
      line: box(".oh-page-line"),
      acts: box(".oh-page-acts"),
      mat: box(".oh-page-material"),
      scrolls: body.overflowY,
      foot: body.paddingBottom,
      back: { ...box(".oh-page-back button"), ground: look.backgroundColor, ring: look.boxShadow },
      icon: box(".oh-page-back button svg"),
      sheet: getComputedStyle(probe).color,
      ctlRing: getComputedStyle(probe).borderTopColor,
      size: parseFloat(getComputedStyle(sentence).fontSize),
    };
  };

  it("starts higher where two sheets stand beside its sentence (the delete page): 96 under the top on a desktop, in both faces", async () => {
    /* The reference: doors.css, `[data-device="desktop"] .dr[data-page="deleteaccount"]{--ob-lead:96px}`; the delete
       page at 1440 in paper (its sentence at 160, the top line 64) and in ohmarchy (the lead 96 over the window's 0;
       without it the trail's own 16). */
    for (const face of ["paper", "ohmarchy"] as const) {
      const high = await drawn(page({ high: true }), read, { face });
      expect(high.say.top - high.top.bottom, face).toBeCloseTo(96, 1);
      const own = await drawn(page(), read, { face });
      expect(own.say.top - own.top.bottom, face).toBeCloseTo(face === "paper" ? 200 : 16, 1);
    }
  }, 60_000);

  it("on the unfolded phone held upright, stacks its material under the buttons and scrolls as one (the delete page)", async () => {
    /* The reference: doors.css `.dr[data-stack="1"]` (the delete page at 719 by 781): the sentence 96 under the top,
       the line, the act and then the sheets, each 24 under the one before, all as wide as the page; the body scrolls
       and keeps 48 at its foot. Held sideways the sheets stand beside the sentence as before. */
    const upright = await drawn(page({ stack: true }), read, { device: "fold" });
    expect(upright.say.top - upright.top.bottom).toBeCloseTo(96, 1);
    expect(upright.line.top - upright.say.bottom).toBeCloseTo(24, 1);
    expect(upright.acts.top - upright.line.bottom).toBeCloseTo(24, 1);
    expect(upright.mat.top - upright.acts.bottom).toBeCloseTo(24, 1);
    expect([upright.mat.left, upright.mat.width]).toEqual([upright.say.left, upright.say.width]);
    expect([upright.scrolls, upright.foot]).toEqual(["auto", "48px"]);
    const sideways = await drawn(page({ stack: true }), read, { device: "foldl" });
    expect(sideways.mat.left).toBeGreaterThan(sideways.say.right);
    const unstacked = await drawn(page(), read, { device: "fold" });
    expect(unstacked.mat.left).toBeGreaterThan(unstacked.say.right);
  }, 60_000);

  it("sets its sentence a step smaller on a phone where it carries a whole address, and nowhere else", async () => {
    /* The reference: doors.css, `[data-device="phone"] .dr[data-page="deleteaccount"] .sentence.xl{font-size:var(--t-head)}`:
       24 in paper and 19 in ohmarchy on the phone; the display size elsewhere. */
    const paper = await drawn(page({ smaller: true }), read, { device: "phone" });
    expect(paper.size).toBe(24);
    const ohmarchy = await drawn(page({ smaller: true }), read, { device: "phone", face: "ohmarchy" });
    expect(ohmarchy.size).toBe(19);
    const own = await drawn(page(), read, { device: "phone" });
    expect(own.size).toBeGreaterThan(24);
    const desk = await drawn(page({ smaller: true }), read);
    expect(desk.size).toBe(44);
  }, 60_000);

  it("stands its way back on the page's edge by its sign, and as a ringed circle on touch", async () => {
    /* The reference (onboarding.css `.ob-top > .cap` and its touch rule; every door's way back): at 1440 the bare
       button stands 10 left of the page's edge so its sign is in line with the sentence, on no ground; on a phone
       and the unfolded phone a white circle ringed in the control ring with a 22 px sign, on the edge. */
    const desk = await drawn(page(), read);
    expect([desk.back.left, desk.back.top, desk.back.width, desk.back.height]).toEqual([150, 12, 40, 40]);
    expect(desk.back.ground).toBe("rgba(0, 0, 0, 0)");
    expect(desk.icon.left).toBe(desk.say.left);
    const desk2 = await drawn(page(), read, { face: "ohmarchy" });
    expect(desk2.back.left - desk2.say.left).toBeCloseTo(-6, 1);
    for (const device of ["phone", "fold"] as const) {
      const touch = await drawn(page(), read, { device });
      expect(touch.back.left, device).toBe(touch.say.left);
      expect([touch.back.width, touch.back.height], device).toEqual([44, 44]);
      expect(touch.back.ground, device).toBe(touch.sheet);
      expect(touch.back.ring, device).toBe(`${touch.ctlRing} 0px 0px 0px 1px inset`);
      expect([touch.icon.width, touch.icon.height], device).toEqual([22, 22]);
    }
  }, 60_000);

  it("takes its line in parts: small facts as tags in a row, what matters heavy on a row of its own, a break where it is asked", async () => {
    /* The reference: doors.css `.dr .ob-line` and the approve page at 1440 (doors.js P.approve): three tags in a row
       12 apart; a break; the heavy sentence as wide as the line; a break; one more tag. The rows 8 apart, a break
       a row of no height. */
    const seen = await drawn(
      page({
        columns: 1,
        material: undefined,
        line: [
          { tag: "Linux" },
          { tag: "Requested just now from 203.0.113.0/24" },
          { tag: "Signs in to mila@lichtgrat.example" },
          { break: true },
          { heavy: "Confirm only if it is yours and you started this." },
          { break: true },
          { tag: "4:40 left" },
          { note: "If you were not expecting this, close this page." },
        ],
        note: undefined,
      }),
      () => {
        const line = document.querySelector(".oh-page-line")!;
        const parts = [...line.children].map((c) => {
          const b = c.getBoundingClientRect();
          return {
            cls: c.className,
            left: b.left,
            top: b.top,
            right: b.right,
            bottom: b.bottom,
            width: b.width,
          };
        });
        const heavy = line.querySelector(".oh-page-heavy")!;
        return {
          parts,
          width: line.getBoundingClientRect().width,
          weight: getComputedStyle(heavy).fontWeight,
        };
      },
    );
    const tags = seen.parts.filter((p) => p.cls.includes("oh-tag"));
    const heavy = seen.parts.find((p) => p.cls.includes("oh-page-heavy"))!;
    const note = seen.parts.find((p) => p.cls.includes("oh-page-note"))!;
    expect(tags).toHaveLength(4);
    expect(tags[1]!.left - tags[0]!.right).toBeCloseTo(12, 1);
    expect(tags[2]!.left - tags[1]!.right).toBeCloseTo(12, 1);
    expect(new Set(tags.slice(0, 3).map((t) => t.top)).size).toBe(1);
    expect(heavy.top - tags[0]!.bottom).toBeCloseTo(16, 1);
    expect([heavy.left, heavy.width]).toEqual([tags[0]!.left, seen.width]);
    expect(seen.weight).toBe("700");
    expect(tags[3]!.left).toBe(heavy.left);
    expect(tags[3]!.top - heavy.bottom).toBeCloseTo(16, 1);
    expect(note.top - tags[3]!.bottom).toBeCloseTo(8, 1);
    expect(note.width).toBe(seen.width);
  }, 60_000);
});

describe("a row you were taken to", () => {
  const located = (
    <div className="oh-rows" role="list">
      <Row
        who="Petra Wyss"
        people={[]}
        sign="ohbox"
        subject="Your talk is on the programme"
        when="08:47"
        located
      />
    </div>
  );
  const read = () => {
    const row = document.querySelector<HTMLElement>("[role='button']")!;
    const probe = document.createElement("i");
    probe.style.color = "var(--wash)";
    document.body.append(probe);
    const wash = getComputedStyle(probe).color;
    const at = (): string => getComputedStyle(row).backgroundColor;
    /* Read where it arrives: the clock of its wash at its start. */
    document.getAnimations().forEach((a) => {
      a.pause();
      a.currentTime = 0;
    });
    const first = at();
    document.getAnimations().forEach((a) => a.finish());
    return { wash, first, settled: at() };
  };

  it("is washed as it arrives, and the wash settles", async () => {
    const seen = await drawn(located, read, { entry: "mail", still: false });
    expect(seen.first).toBe(seen.wash);
    expect(seen.settled).not.toBe(seen.wash);
  }, 60_000);

  it("stays washed, without motion, for a person who asked for less", async () => {
    const seen = await drawn(located, read, { entry: "mail", still: true });
    expect([seen.first, seen.settled]).toEqual([seen.wash, seen.wash]);
  }, 60_000);
});

describe("the open row's pressable time", () => {
  it.each(["light", "dark"] as const)(
    "keeps the open row's ink under the pointer, as its address does, in paper %s",
    async (scheme) => {
      const at = (q: string) =>
        drawn(
          <div className="oh-rows" role="list">
            <Row
              who="Petra Wyss"
              address="petra@example.org"
              people={[]}
              subject="Your talk is on the programme"
              when="08:47"
              whenTitle="Mon 9 Nov 08:47"
              onWhen={() => {}}
              onContact={() => {}}
              open
            />
          </div>,
          () => {
            const probe = document.createElement("i");
            probe.style.color = "var(--on-row-open)";
            document.body.append(probe);
            return {
              ink: getComputedStyle(probe).color,
              time: getComputedStyle(document.querySelector(".oh-row-when")!).color,
              address: getComputedStyle(document.querySelector(".oh-row-address")!).color,
            };
          },
          { entry: "mail", scheme, hover: q },
        );
      const onTime = await at(".oh-row-when");
      const onAddress = await at(".oh-row-address");
      expect(onAddress.address).toBe(onAddress.ink);
      expect(onTime.time).toBe(onTime.ink);
    },
    60_000,
  );
});

describe("a message's head", () => {
  /** Every box of the head whose words or parts run past it, by its words. */
  const over = () =>
    [...document.querySelectorAll<HTMLElement>("header *")]
      .filter((el) => getComputedStyle(el).display !== "inline" && el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${(el.textContent ?? "").trim().slice(0, 40)}: ${el.scrollWidth - el.clientWidth} px`);

  it.each([
    ["de", "an", "dich", "Details", "Mo. 17:30"],
    ["en", "to", "you", "details", "Mon 17:30"],
  ])(
    "in %s, at a phone's width, keeps its recipients' line inside its track",
    async (lang, word, you, label, when) => {
      const head = (
        <MessageHead
          sender={{ name: "Ben Arnold", address: "ben@lichtgrat.example" }}
          menu={{ label: "Nachricht" }}
          stamp={{ when, full: false, title: when }}
          to={[{ word, people: [{ name: you }] }]}
          details={{ label, open: false, lines: [] }}
        />
      );
      expect(
        await drawn(<div style={{ width: 358 }}>{head}</div>, over, { entry: "mail", device: "phone", lang }),
      ).toEqual([]);
    },
    60_000,
  );
});

describe("text not kept here, first in a letter", () => {
  const letter = (body: (notice: ReactNode) => ReactNode) => (
    <Message
      head={
        <MessageHead
          sender={{ name: "Tim Berger", address: "tim@gassenblatt.example" }}
          menu={{ label: "Message" }}
          stamp={{ when: "Wed 28 Oct 19:02", full: true, title: "Wed 28 Oct 19:02" }}
          to={[{ word: "to", people: [{ name: "you" }] }]}
          details={{ label: "details", open: false, lines: [] }}
        />
      }
    >
      {body(
        <TextNotKept
          kind="kept"
          label="Gone from your mail server"
          line="Every copy was deleted there or moved by another mail app."
        />,
      )}
    </Message>
  );
  const read = () => {
    const head = document.querySelector(".oh-messagehead")!.getBoundingClientRect();
    const notice = document.querySelector(".oh-notkept")!.getBoundingClientRect();
    return notice.top - head.bottom;
  };

  /* The reference: reading.css `.mhead + .lt-kept{margin-top:var(--s1)}` under the head's own 16 (lt-expunged at 1440:
     the head's foot at 166, the notice at 182). The app draws the letter's body, so the notice may stand first in a
     box of the app's own: it stands 16 under the head all the same. */
  it("stands 16 under the head, directly under it and first in the body the app draws", async () => {
    const direct = await drawn(
      letter((notice) => notice),
      read,
      { entry: "mail" },
    );
    expect(direct).toBeCloseTo(16, 1);
    const inBody = await drawn(
      letter((notice) => <div data-read-body="">{notice}</div>),
      read,
      { entry: "mail" },
    );
    expect(inBody).toBeCloseTo(16, 1);
  }, 60_000);

  /* The reference: reading.js preview() + kept(), reading.css `.lt-prev{color:var(--ink2)}` in the letter's own face
     (`.msg .body`), then `.lt-kept` 24 under it (lt-junk at 1440: the preview at 182, 54.4 high, the notice at 260.4). */
  it("stands under the letter's preview, which is muted, in the letter's face", async () => {
    const seen = await drawn(
      <Message
        head={
          <MessageHead
            sender={{ name: "Prize Desk", address: "winner@jackpot-central.example" }}
            menu={{ label: "Message" }}
            stamp={{ when: "Sun 8 Nov 03:12", full: true, title: "Sun 8 Nov 03:12" }}
            to={[{ word: "to", people: [{ name: "you" }] }]}
            details={{ label: "details", open: false, lines: [] }}
          />
        }
      >
        <div data-read-body="">
          <TextNotKept
            kind="kept"
            preview="You have been selected. Confirm within 24 hours to release your reward…"
            label="Text in your Junk folder"
            line="You marked this as spam, so it was filed to Junk on your mail server and its text is not stored here."
          />
        </div>
      </Message>,
      () => {
        const probe = document.createElement("i");
        probe.style.cssText = "color:var(--ink2);font-size:var(--t-read);line-height:var(--lh-read)";
        document.body.append(probe);
        const want = getComputedStyle(probe);
        const head = document.querySelector(".oh-messagehead")!.getBoundingClientRect();
        const preview = [...document.querySelectorAll("[data-read-body] *")].find((el) =>
          el.textContent?.startsWith("You have been selected"),
        )!;
        const look = getComputedStyle(preview);
        const box = preview.getBoundingClientRect();
        const notice = document.querySelector(".oh-notkept")!.getBoundingClientRect();
        return {
          under: box.top - head.bottom,
          gap: notice.top - box.bottom,
          before: preview.compareDocumentPosition(document.querySelector(".oh-notkept")!) === 4,
          look: [look.color, look.fontSize, look.lineHeight, look.whiteSpace],
          want: [want.color, want.fontSize, want.lineHeight, "pre-wrap"],
        };
      },
      { entry: "mail" },
    );
    expect(seen.before).toBe(true);
    expect(seen.under).toBeCloseTo(16, 1);
    expect(seen.gap).toBeCloseTo(24, 1);
    expect(seen.look).toEqual(seen.want);
  }, 60_000);
});

describe("a column's handle", () => {
  it.each(["paper", "ohmarchy"] as const)(
    "in %s draws its short line with rounded ends",
    async (face) => {
      const seen = await drawn(
        <ColumnHandle
          column="rail"
          label="Width of the places"
          value={232}
          min={200}
          max={320}
          onChange={() => {}}
        />,
        () => {
          const line = getComputedStyle(document.querySelector("[role='separator']")!, "::after");
          return [line.width, line.borderTopLeftRadius, line.borderBottomRightRadius];
        },
        { entry: "mail", face },
      );
      expect(seen).toEqual(["2px", "2px", "2px"]);
    },
    60_000,
  );
});

describe("the reading column's way back to its start", () => {
  const column = (panel: boolean) => (
    <div style={{ display: "grid", height: "100vh" }}>
      <Sheet
        kind="reading"
        label="Reading"
        jump={<JumpBack label="Back to top" to="top" shown />}
        foot={
          panel ? (
            <ActionPanel
              label="Message"
              items={[
                { id: "reply", label: "Reply", icon: "reply", rank: 0 },
                { id: "delete", label: "Delete", icon: "trash", rank: 0 },
              ]}
            />
          ) : undefined
        }
      >
        <p>Letter</p>
      </Sheet>
    </div>
  );
  const read = () => {
    const probe = document.createElement("i");
    probe.style.cssText = "display:block;width:var(--s3)";
    document.body.append(probe);
    const box = (q: string) => {
      const r = document.querySelector(q)?.getBoundingClientRect();
      return r ? { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width } : null;
    };
    return {
      s3: probe.getBoundingClientRect().width,
      jump: box(".oh-jumpback")!,
      panel: box(".oh-actionpanel-bar"),
      letters: box(".oh-sheet-body")!,
      column: box(".oh-sheet")!,
      window: innerWidth,
    };
  };

  it.each(["paper", "ohmarchy"] as const)(
    "at a phone's width, in %s, stands over the panel where the sheet draws it",
    async (face) => {
      const seen = await drawn(column(true), read, { entry: "mail", device: "phone", face });
      expect(seen.window).toBe(390);
      /* The reference (JumpBack/end@paper-light-phone): [334, 716, 44, 44], the panel's top a step under it. */
      expect([seen.jump.width, seen.jump.right]).toEqual([44, 390 - seen.s3]);
      expect(seen.jump.bottom).toBeCloseTo(seen.panel!.top - seen.s3, 1);
    },
    60_000,
  );

  it("in a wide column without a panel, stands at the letters' right corner, not the pane's", async () => {
    const seen = await drawn(column(false), read, { entry: "mail", device: "desktop" });
    expect(seen.letters.right).toBeLessThan(seen.column.right - 100);
    expect(seen.jump.right).toBeCloseTo(seen.letters.right - seen.s3, 1);
    expect(seen.jump.bottom).toBeCloseTo(seen.column.bottom - seen.s3, 1);
  }, 60_000);

  it.each(["paper", "ohmarchy"] as const)(
    "in a wide column with a panel, in %s, stands over the panel at the letters' right corner",
    async (face) => {
      const seen = await drawn(column(true), read, { entry: "mail", device: "desktop", face });
      expect(seen.jump.right).toBeCloseTo(seen.letters.right - seen.s3, 1);
      expect(seen.jump.bottom).toBeCloseTo(seen.panel!.top - seen.s3, 1);
    },
    60_000,
  );
});

describe("a panel verb that gave up its word", () => {
  /* The read slot of the upright foldable gives up its word first (`short`); More stands beside it. */
  const panel = (
    <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
      <ActionPanel
        label="Message"
        items={[
          { id: "reply", label: "Reply", icon: "reply", kind: "ink", rank: 0 },
          { id: "forward", label: "Forward", icon: "forward", rank: 0 },
          { id: "unread", label: "Mark unread", icon: "unread", rank: 0, apart: true, wordFirst: true },
        ]}
        more={{ label: "More", behind: true }}
        short={["unread"]}
      />
    </div>
  );
  const read = () => {
    const verb = document.querySelector<HTMLElement>("[data-id='unread']")!;
    const box = verb.getBoundingClientRect();
    const sign = verb.querySelector("svg")!.getBoundingClientRect();
    const look = getComputedStyle(verb);
    return { padding: look.padding, width: box.width, sign: Math.round((sign.left - box.left) * 100) / 100 };
  };

  /* The reference: app.css, `.fs[data-panel="both"] .panel .cap.hasic.quiet` (and the unfolded phone's) outrank
     `.panel .cap.slim.quiet{padding:0}`, so a quiet verb that gave up its word keeps its signed padding; ohmarchy's own
     `.cap.slim.quiet{padding:0}` comes later on touch away from the unfolded phone. Read on the reference's read slot
     (device=fold&open=lt-order) and on the same verb made slim in each look: padding, width, the sign from its left. */
  it.each([
    ["paper", "fold", "0px 6px 0px 5px", 40, 9.5],
    ["paper", "desktop", "0px 9px 0px 7px", 40, 9],
    ["paper", "phone", "0px 9px 0px 7px", 44, 11],
    ["ohmarchy", "fold", "0px 6px 0px 5px", 40, 9.5],
    ["ohmarchy", "desktop", "0px 6px", 32, 8],
    ["ohmarchy", "phone", "0px", 44, 12],
  ] as const)(
    "keeps the padding the sheet draws for its sign alone: %s on the %s",
    async (face, device, padding, width, sign) => {
      const seen = await drawn(panel, read, { entry: "mail", face, device });
      expect(seen).toEqual({ padding, width, sign });
    },
    60_000,
  );
});

describe("a mini-month's day that cannot be picked", () => {
  const month = (size: "rail" | "widget") => (
    <MiniMonth
      size={size}
      weekdays={["M", "T", "W", "T", "F", "S", "S"]}
      days={[
        { id: "o", number: "30", label: "Friday 30 October", outside: true },
        { id: "d", number: "2", label: "Monday 2 November", disabled: true },
        { id: "p", number: "3", label: "Tuesday 3 November" },
      ]}
    />
  );
  const read = () => {
    /* Read where the pointer's wash comes to rest. */
    document.getAnimations().forEach((a) => a.finish());
    const probe = document.createElement("i");
    probe.style.cssText = "color:var(--ink2);background:var(--hover-ground)";
    document.body.append(probe);
    const day = (name: string) => {
      const el = document.querySelector<HTMLElement>(`[aria-label^="${name}"]`)!;
      return {
        disc: getComputedStyle(el.querySelector(".oh-mini-disc")!).backgroundColor,
        ink: getComputedStyle(el).color,
        seen: getComputedStyle(el).visibility,
        out: el.hasAttribute("data-out"),
        off: el.hasAttribute("data-off"),
      };
    };
    return {
      ink2: getComputedStyle(probe).color,
      hover: getComputedStyle(probe).backgroundColor,
      off: day("Monday 2"),
      outside: day("Friday 30"),
      open: day("Tuesday 3"),
    };
  };

  it("does not answer the pointer, where a day that can be picked does", async () => {
    const onOff = await drawn(month("rail"), read, { entry: "calendar", hover: '[aria-label^="Monday 2"]' });
    expect(onOff.off.disc).toBe("rgba(0, 0, 0, 0)");
    const onOpen = await drawn(month("rail"), read, {
      entry: "calendar",
      hover: '[aria-label^="Tuesday 3"]',
    });
    expect(onOpen.open.disc).toBe(onOpen.hover);
  }, 60_000);

  it("carries a mark of its own, in the outside day's ink, and stands in a widget too", async () => {
    for (const size of ["rail", "widget"] as const) {
      const seen = await drawn(month(size), read, { entry: "calendar" });
      expect([seen.off.off, seen.off.out], size).toEqual([true, false]);
      expect(seen.off.ink, size).toBe(seen.ink2);
      expect(seen.off.seen, size).toBe("visible");
      expect(seen.outside.out, size).toBe(true);
    }
  }, 60_000);
});

describe("a row's verbs, beside its option", () => {
  const listed = (more: Partial<RowProps>) => (
    <div style={{ width: 420 }}>
      <Rows label="Ohbox">
        <Row
          who="Petra Wyss"
          address="petra@example.org"
          people={[]}
          sign="ohbox"
          subject="Your talk is on the programme"
          preview="Made the final programme: Saturday at 11:00 in the main hall."
          when="08:47"
          listing={{ name: "Petra Wyss: Your talk is on the programme", selected: false }}
          {...more}
        />
      </Rows>
    </div>
  );
  const read = () => {
    document.getAnimations().forEach((a) => a.finish());
    const tone = (v: string) => {
      const probe = document.createElement("i");
      probe.style.color = `var(${v})`;
      document.body.append(probe);
      return getComputedStyle(probe).color;
    };
    const box = (q: string) => {
      const r = document.querySelector(q)?.getBoundingClientRect();
      return r ? { left: r.left, right: r.right, middle: r.top + r.height / 2 } : null;
    };
    const row = document.querySelector("[role='option']")!;
    const quick = document.querySelector(".oh-row-quick");
    return {
      hover: tone("--hover"),
      open: tone("--row-open"),
      sheet: tone("--sheet"),
      inside: row.querySelectorAll("button").length,
      row: getComputedStyle(row).backgroundColor,
      room: box("[data-room]"),
      own: box("button[data-own]"),
      ownGround: getComputedStyle(document.querySelector("button[data-own]") ?? row).backgroundColor,
      quickShown: quick ? getComputedStyle(quick).opacity : null,
      quickFade: quick ? getComputedStyle(quick).backgroundImage : null,
    };
  };

  it.each(["paper", "ohmarchy"] as const)(
    "in %s, its own button stands over the room the row keeps, and the row stays under the pointer on it",
    async (face) => {
      const seen = await drawn(listed({ own: { label: "Discard" } }), read, {
        entry: "mail",
        face,
        hover: "button[data-own]",
      });
      expect(seen.inside).toBe(0);
      expect(seen.own!.left).toBeCloseTo(seen.room!.left, 1);
      expect(seen.own!.right).toBeCloseTo(seen.room!.right, 1);
      expect(Math.abs(seen.own!.middle - seen.room!.middle)).toBeLessThan(0.05);
      expect([seen.row, seen.ownGround]).toEqual([seen.hover, seen.sheet]);
    },
    60_000,
  );

  it.each([false, true])(
    "its quick verb shows under the pointer on it and fades over the row's ground (open: %s)",
    async (open) => {
      const seen = await drawn(listed({ quick: { label: "Done", icon: "check" }, open }), read, {
        entry: "mail",
        hover: [".oh-row-who", ".oh-row-quick > button"],
      });
      expect(seen.inside).toBe(0);
      expect(seen.quickShown).toBe("1");
      expect(seen.row).toBe(open ? seen.open : seen.hover);
      expect(seen.quickFade).toContain(seen.row);
    },
    60_000,
  );

  it("a press on the quick verb's fade is a press on the row: only the verb itself takes the pointer", async () => {
    const seen = await drawn(
      listed({ quick: { label: "Done", icon: "check" } }),
      () => {
        const fade = document.querySelector(".oh-row-quick")!.getBoundingClientRect();
        const verb = document.querySelector(".oh-row-quick > button")!.getBoundingClientRect();
        const at = (x: number, y: number) => {
          const el = document.elementFromPoint(x, y);
          return el?.closest("[role='option']") ? "row" : el?.closest("button") ? "verb" : "neither";
        };
        const y = fade.top + fade.height / 2;
        return {
          room: verb.left - fade.left,
          onFade: at(fade.left + 4, y),
          onVerb: at(verb.left + verb.width / 2, y),
        };
      },
      { entry: "mail", hover: [".oh-row-who", ".oh-row-quick > button"] },
    );
    expect(seen.room).toBeGreaterThan(16);
    expect([seen.onFade, seen.onVerb]).toEqual(["row", "verb"]);
  }, 60_000);
});

describe("an empty place's way on, as a link", () => {
  const ACT = "a[href], button";
  const empty = (way: "runs" | "goes") => (
    <Empty
      label="No mail yet"
      act={
        way === "goes"
          ? { label: "Connect", icon: "plus", href: "/join" }
          : { label: "Connect", icon: "plus", onPress: () => {} }
      }
    />
  );
  /** The act's box, and every computed property of it and of what it holds. */
  const read = () => {
    document.getAnimations().forEach((a) => a.finish());
    const act = document.querySelector("a[href], button")!;
    const drawnOf = (el: Element) => {
      const cs = getComputedStyle(el);
      return Object.fromEntries(Array.from(cs).map((p) => [p, cs.getPropertyValue(p)]));
    };
    const r = act.getBoundingClientRect();
    return {
      tag: act.tagName,
      focused: document.activeElement === act,
      box: [r.x, r.y, r.width, r.height],
      drawn: [act, ...Array.from(act.querySelectorAll("*"))].map(drawnOf),
    };
  };
  const states: [string, Drawn][] = [
    ["resting", {}],
    ["under the pointer", { hover: ACT }],
    ["pressed", { press: ACT, still: false }],
    ["focused by the keys", { keys: ["Tab"] }],
  ];

  it.each([
    ["paper", "light"],
    ["paper", "dark"],
    ["ohmarchy", "light"],
    ["ohmarchy", "dark"],
  ] as const)(
    "in %s %s, draws as the button in every state: the same box, the same styles",
    async (face, scheme) => {
      for (const [state, at] of states) {
        const runs = await drawn(empty("runs"), read, { ...at, face, scheme });
        const goes = await drawn(empty("goes"), read, { ...at, face, scheme });
        expect([runs.tag, goes.tag], state).toEqual(["BUTTON", "A"]);
        // A press takes the focus, as the keys do; neither shows the keys' ring after a press.
        const focused = state === "focused by the keys" || state === "pressed";
        expect([runs.focused, goes.focused], state).toEqual([focused, focused]);
        expect(goes.drawn[0]!["outline-style"], state).toBe(
          state === "focused by the keys" ? "solid" : "none",
        );
        expect(goes.box, state).toEqual(runs.box);
        expect(goes.drawn, state).toEqual(runs.drawn);
      }
    },
    120_000,
  );
});
