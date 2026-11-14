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
import {
  Blank,
  Button,
  Dialog,
  Dot,
  Empty,
  Field,
  FindField,
  JumpBack,
  Page,
  Sentence,
  Seg,
  Slot,
} from "../../src/base/index.js";
import { MiniMonth } from "../../src/calendar/index.js";
import {
  ActionPanel,
  ColumnHandle,
  Dock,
  GroupHeading,
  ListLine,
  ListTail,
  LookPicture,
  Message,
  MessageHead,
  MovePicker,
  Row,
  Rows,
  RuleLine,
  SettingArea,
  SettingFilter,
  SettingLine,
  SettingNote,
  SettingsSheet,
  Sheet,
  TagLine,
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
  /** The web door's Text size: the zoom it stamps on the root. */
  zoom?: number;
  /** A window of another size than the device's own. */
  window?: [number, number];
}

/** A page with the parts in the entry's root, the device's window and root attributes; `read` runs in it. */
async function drawn<T>(parts: ReactNode, read: () => T, at: Drawn = {}): Promise<T> {
  return opened(parts, at, (tab) => tab.evaluate(read));
}

/** One node of what Chromium itself hands a screen reader: its role, name, description and states. */
interface Spoken {
  role: string;
  name: string;
  description: string;
  disabled?: boolean;
}

/** What Chromium's own accessibility tree says of the parts, drawn as `drawn` draws them. */
async function spoken(parts: ReactNode, at: Drawn = {}): Promise<Spoken[]> {
  return opened(parts, at, async (tab) => {
    const cdp = await tab.context().newCDPSession(tab);
    type Value = { value?: unknown };
    type AxNode = {
      ignored: boolean;
      role?: Value;
      name?: Value;
      description?: Value;
      properties?: { name: string; value: Value }[];
    };
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
    await cdp.detach();
    const said = (v?: Value) => (typeof v?.value === "string" ? v.value : "");
    return nodes
      .filter((n) => !n.ignored)
      .map((n) => {
        const prop = (name: string) => n.properties?.find((p) => p.name === name)?.value.value;
        return {
          role: said(n.role),
          name: said(n.name),
          description: said(n.description),
          ...(prop("disabled") === true ? { disabled: true } : {}),
        };
      });
  });
}

async function opened<T>(
  parts: ReactNode,
  at: Drawn,
  take: (tab: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>>) => Promise<T>,
): Promise<T> {
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
    zoom = 1,
    window,
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
  const [width, height] = window ?? DEVICES[device].window;
  const tab = await browser!.newPage({
    viewport: { width, height },
    reducedMotion: still ? "reduce" : "no-preference",
  });
  try {
    const stamp = zoom === 1 ? "" : ` style="zoom:${zoom};--ui-zoom:${zoom}"`;
    await tab.setContent(`<!doctype html><html lang="${lang}"${attrs}${stamp}><head><meta charset="utf-8">
<style>${await fontsCss()}</style><style>${await entryCss(entry)}</style><style>html,body{margin:0}</style></head>
<body><div class="oh-root">${renderToStaticMarkup(parts)}</div></body></html>`);
    await tab.evaluate(() => document.fonts.ready);
    for (const over of [hover ?? []].flat()) await tab.hover(over);
    if (press) {
      await tab.hover(press);
      await tab.mouse.down();
    }
    for (const key of keys) await tab.keyboard.press(key);
    return await take(tab);
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

describe("a section of Settings in its list, to a screen reader", () => {
  const menu = (open: "General" | null) => (
    <Rows>
      <Row
        entry
        who="General"
        people={[]}
        sign="settings"
        subject="Light"
        preview="English"
        open={open === "General"}
      />
      <Row
        entry
        who="Mailboxes"
        people={[]}
        sign="mail"
        when="2"
        subject="1 full"
        preview="lichtgrat.example"
        unread
      />
    </Rows>
  );
  /* As the journeys find a section: a button named exactly by it, which says it is the current page. */
  const current = (open: "General" | null, at: Drawn) =>
    opened(menu(open), at, (tab) =>
      Promise.all(
        ["General", "Mailboxes"].map((name) =>
          tab.getByRole("button", { name, exact: true }).getAttribute("aria-current"),
        ),
      ),
    );
  it.each([
    ["paper", "desktop"],
    ["ohmarchy", "desktop"],
    ["paper", "phone"],
    ["ohmarchy", "phone"],
  ] as const)(
    "in %s on a %s: a button named by its section alone, its value and detail its description, the open one the current page",
    async (face, device) => {
      const at: Drawn = { entry: "mail", face, device };
      const buttons = (await spoken(menu("General"), at)).filter((n) => n.role === "button");
      expect(buttons.map((b) => b.name)).toEqual(["General", "Mailboxes"]);
      // The dot between value and detail is drawn in paper with a pointer only, and said where it is drawn.
      const dot = face === "paper" && device === "desktop" ? " · " : " ";
      expect(buttons.map((b) => b.description.replace(/\s+/g, " ").trim())).toEqual([
        `Light${dot}English`,
        `1 full${dot}lichtgrat.example`,
      ]);
      expect(await current("General", at)).toEqual(["page", null]);
      expect(await current(null, at)).toEqual([null, null]);
    },
    60_000,
  );
});

describe("a setting's line, to a screen reader", () => {
  it.each([
    ["paper", "desktop"],
    ["ohmarchy", "desktop"],
    ["paper", "phone"],
    ["ohmarchy", "phone"],
  ] as const)(
    "in %s on a %s: a group named by its label alone, around its value and its control",
    async (face, device) => {
      const tree = await spoken(
        <SettingsSheet title="About">
          <SettingLine label="Build" tag="Web" value="2.0.0">
            <Button kind="quiet" size="s" onPress={() => {}}>
              Copy
            </Button>
          </SettingLine>
          <SettingLine label="Notify me on this device" toggle={{ on: true }} />
        </SettingsSheet>,
        { entry: "mail", face, device },
      );
      const roles = tree.filter((n) => ["group", "button", "switch"].includes(n.role));
      // The tree is read in Chromium's own order, which is no document order.
      expect(roles.map((n) => `${n.role} ${n.name}`).sort()).toEqual([
        "button Copy",
        "group Build",
        "group Notify me on this device",
        "switch Notify me on this device",
      ]);
    },
    60_000,
  );
});

/** Each look a sheet of Settings is drawn in, at the web door's two Text sizes. */
const SETTINGS_LOOKS = (["paper", "ohmarchy"] as const).flatMap((face) =>
  (["light", "dark"] as const).flatMap((scheme) =>
    ([1, 1.25] as const).map((zoom) => [face, scheme, zoom] as const),
  ),
);

describe("a note on a sheet of settings", () => {
  it.each(SETTINGS_LOOKS)(
    "in %s %s at Text size %s: the second ink, a step up under the line it is about, the warning sign of 18 at the head of its first line, the words a step after it",
    async (face, scheme, zoom) => {
      const seen = await drawn(
        <div style={{ width: 520, paddingTop: 16 }}>
          <SettingLine label="Two-step sign-in" value="On" />
          <SettingNote warn>
            You have no unused recovery codes. Without them, losing your authenticator locks you out.
          </SettingNote>
        </div>,
        () => {
          const note = document.querySelector("p")!;
          const [sign, words] = [note.querySelector("svg")!, note.querySelector("span")!].map((e) =>
            e.getBoundingClientRect(),
          );
          const box = note.getBoundingClientRect();
          const line = document.querySelector("[role='group']")!.getBoundingClientRect();
          /* A token as the browser computes it here: lengths in the window's px, as the boxes are. */
          const probe = document.createElement("i");
          probe.style.cssText = "display:block;width:var(--s2);height:var(--s3);color:var(--ink2)";
          note.parentElement!.append(probe);
          const token = probe.getBoundingClientRect();
          return {
            sign: [sign.left - box.left, sign.top - box.top, sign.width],
            words: words.left - sign.right,
            step: token.width,
            ink: getComputedStyle(note).color,
            ink2: getComputedStyle(probe).color,
            /* How far it stands into the line above it. */
            rise: line.bottom - box.top,
            /* What stands under it, in the window's px: the box less the words' lines. */
            under: box.bottom - words.bottom,
            s3: token.height,
            measure: getComputedStyle(note).maxWidth !== "none",
          };
        },
        { entry: "mail", face, scheme, zoom },
      );
      expect(seen.ink).toBe(seen.ink2);
      expect(seen.sign.map((v) => Math.round(v * 100) / 100)).toEqual([0, 2 * zoom, 18 * zoom]);
      expect(Math.abs(seen.words - seen.step)).toBeLessThan(0.5);
      expect(Math.abs(seen.rise - seen.step)).toBeLessThan(0.5);
      expect(Math.abs(seen.under - seen.s3)).toBeLessThan(0.5);
      expect(seen.measure).toBe(true);
    },
    60_000,
  );
});

describe("a setting written in words", () => {
  it.each(SETTINGS_LOOKS)(
    "in %s %s at Text size %s: its label a step under the line above and a step more than a field's own over its field, its refusal under the field",
    async (face, scheme, zoom) => {
      const seen = await drawn(
        <div style={{ width: 520 }}>
          <SettingLine label="Away responder" toggle={{ on: true }} />
          <SettingArea label="Message" value="" onChange={() => {}} refusal="Add a message first." />
          <SettingLine label="Turns off on" value="No end date" />
        </div>,
        () => {
          const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
          const [above, label, field, refusal, below] = [
            "[role='group']",
            "label",
            "textarea",
            "[id$='-said']",
            "[role='group']:last-child",
          ].map(box);
          const probe = document.createElement("i");
          probe.style.cssText = "display:block;width:var(--s2);height:6px";
          document.querySelector(".oh-root")!.append(probe);
          const step = probe.getBoundingClientRect();
          return {
            over: label.top - above.bottom,
            between: field.top - label.bottom,
            refusal: refusal.top - field.bottom,
            under: below.top - refusal.bottom,
            step: step.width,
            gap: step.height,
            /* The label's own room under its words, in the page's px. */
            labelUnder: parseFloat(getComputedStyle(document.querySelector("label")!).paddingBottom),
            pageStep: step.width / (parseFloat(document.documentElement.style.zoom) || 1),
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        },
        { entry: "mail", face, scheme, zoom },
      );
      const near = (a: number, b: number) => expect(Math.abs(a - b), `${a} for ${b}`).toBeLessThan(0.75);
      near(seen.over, seen.step);
      near(seen.labelUnder, seen.pageStep);
      near(seen.between, seen.gap);
      near(seen.refusal, seen.gap);
      near(seen.under, seen.step);
      expect(seen.sideways).toBe(0);
    },
    60_000,
  );
});

describe("a rule, said as its sentence", () => {
  const rule = (
    /* As wide as a phone's sheet holds its lines: the window less its steps, at every Text size. */
    <div style={{ padding: "0 16px" }}>
      <RuleLine
        who="giulia@terracotta-milano.example"
        person={{
          name: "Giulia Ferrari",
          address: "giulia@terracotta-milano.example",
          label: "Giulia Ferrari",
          onContact: () => {},
        }}
        goes={
          <>
            goes to <Slot label="Goes to Ohbox">Ohbox</Slot>
          </>
        }
        origin="Screener decision · 14 messages"
        act={
          <Button kind="quiet" size="s">
            Revoke
          </Button>
        }
      />
    </div>
  );
  it.each(SETTINGS_LOOKS)(
    "in %s %s at Text size %s: the circle, the sentence and its word side by side; under a finger who, where and whence on three lines, the circle a thumb's 44",
    async (face, scheme, zoom) => {
      for (const device of ["desktop", "phone"] as const) {
        const seen = await drawn(
          rule,
          () => {
            const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
            const [line, circle, name, slot, origin, act] = [
              ".oh-ruleline",
              "button[aria-label='Giulia Ferrari']",
              "b",
              "button[aria-label='Goes to Ohbox']",
              "small",
              "button:not([aria-label])",
            ].map(box);
            return {
              order: circle.right <= name.left && name.right <= act.left,
              /* What answers a press beside the circle, 8 of the page's px out of its box and inside a thumb's 44. */
              beside: (() => {
                const zoomed = parseFloat(document.documentElement.style.zoom) || 1;
                const hit = document.elementFromPoint(
                  circle.left - 8 * zoomed,
                  circle.top + circle.height / 2,
                );
                return hit?.closest("button")?.getAttribute("aria-label") ?? null;
              })(),
              ends: line.right - act.right,
              lines: [name.top < slot.top, slot.bottom <= origin.top + 1],
              tall: line.height,
              xl: (() => {
                const probe = document.createElement("i");
                probe.style.cssText = "display:block;height:var(--h-xl)";
                document.querySelector(".oh-root")!.append(probe);
                return probe.getBoundingClientRect().height;
              })(),
              sideways: document.documentElement.scrollWidth - innerWidth,
              widest: [...document.querySelectorAll("*")]
                .map((e) => [e.getBoundingClientRect().right, e.tagName + "." + e.className] as const)
                .sort((a, b) => b[0] - a[0])[0],
            };
          },
          { entry: "mail", face, scheme, zoom, device },
        );
        expect(seen.order, device).toBe(true);
        expect(seen.beside, device).toBe(device === "phone" ? "Giulia Ferrari" : null);
        expect(seen.ends, device).toBeLessThan(0);
        expect(seen.tall, device).toBeGreaterThanOrEqual(seen.xl - 0.5);
        expect(seen.lines, device).toEqual(device === "phone" ? [true, true] : [seen.lines[0], true]);
        expect(seen.sideways, `${device} ${JSON.stringify(seen.widest)}`).toBe(0);
      }
    },
    60_000,
  );
});

describe("a tag's line", () => {
  const quiet = (word: string) => (
    <Button kind="quiet" size="s">
      {word}
    </Button>
  );
  const lines = (
    <SettingsSheet>
      <TagLine
        hue={150}
        name="Pottery Project"
        colour={{ label: "Colour of Pottery Project", expanded: false }}
        value="4 messages"
        acts={
          <>
            {quiet("Rename")}
            {quiet("Delete")}
          </>
        }
      />
      <TagLine
        hue={150}
        field={{ label: "New tag", value: "Paperwork", placeholder: "Name a new tag", onChange: () => {} }}
        refusal="You already have “Paperwork”."
        acts={
          <Button kind="two" size="s">
            Add
          </Button>
        }
      />
    </SettingsSheet>
  );
  it.each(
    (["paper", "ohmarchy"] as const).flatMap((face) =>
      (["light", "dark"] as const).flatMap((scheme) =>
        ([1, 1.25, 1.5] as const).map((zoom) => [face, scheme, zoom] as const),
      ),
    ),
  )(
    "in %s %s at Text size %s: the colour a round button with its dot in the middle, the two words one group at the line's end, the name's field at the line's height, its refusal under the whole line",
    async (face, scheme, zoom) => {
      for (const device of ["desktop", "phone"] as const) {
        const seen = await drawn(
          <div style={{ width: device === "desktop" ? 676 : undefined }}>{lines}</div>,
          () => {
            const box = (el: Element) => el.getBoundingClientRect();
            const word = (w: string) =>
              box([...document.querySelectorAll("button")].find((b) => b.textContent === w)!);
            const probe = (length: string) => {
              const i = document.createElement("i");
              i.style.cssText = `display:block;height:${length}`;
              document.querySelector(".oh-sheet")!.append(i);
              const h = i.getBoundingClientRect().height;
              i.remove();
              return h;
            };
            const [rest, written] = [".oh-settingline", ".oh-tagline"].map((sel) =>
              box(document.querySelector(sel)!),
            );
            const colour = document.querySelector("button[aria-label='Colour of Pottery Project']")!;
            const dot = box(colour.querySelector(".oh-tagdot")!);
            const field = document.querySelector("input")!;
            const refusal = box(document.querySelector(".oh-field-refusal")!);
            const count = box(
              [...document.querySelectorAll("span")].find((e) => e.textContent === "4 messages")!,
            );
            const touch = document.documentElement.dataset.touch === "1";
            return {
              colour: [box(colour).width, box(colour).height, getComputedStyle(colour).borderRadius],
              pill: (() => {
                const i = document.createElement("i");
                i.style.borderRadius = "var(--r-pill)";
                document.querySelector(".oh-sheet")!.append(i);
                const r = getComputedStyle(i).borderRadius;
                i.remove();
                return r;
              })(),
              hue: probe(touch ? "var(--s6)" : "var(--h-s)"),
              middle: [
                dot.left + dot.width / 2 - (box(colour).left + box(colour).width / 2),
                dot.top + dot.height / 2 - (box(colour).top + box(colour).height / 2),
                dot.width,
              ],
              pulled: rest!.left - box(colour).left,
              s2: probe("var(--s2)"),
              together: word("Delete").left - word("Rename").right,
              edge: rest!.right - word("Delete").right,
              beside: touch
                ? [word("Rename").top >= box(colour).bottom - 0.5, count.left - rest!.left]
                : [count.right <= word("Rename").left, word("Rename").top < box(colour).bottom],
              field: [box(field).height, getComputedStyle(field).fontWeight, box(field).left - written!.left],
              hm: probe("var(--h-m)"),
              mid: (() => {
                const i = document.createElement("b");
                i.style.fontWeight = "var(--w-mid)";
                document.querySelector(".oh-sheet")!.append(i);
                const w = getComputedStyle(i).fontWeight;
                i.remove();
                return w;
              })(),
              under: [
                refusal.left - box(field).left,
                refusal.top - box(field).bottom,
                refusal.right > word("Add").left,
              ],
              sideways: document.documentElement.scrollWidth - innerWidth,
              /* What answers a press 4 of the page's px out of the colour's box, inside the step a finger is given. */
              reach: (() => {
                const zoomed = parseFloat(document.documentElement.style.zoom) || 1;
                const hit = document.elementFromPoint(
                  box(colour).left - 4 * zoomed,
                  box(colour).top + box(colour).height / 2,
                );
                return colour.contains(hit);
              })(),
              /* Read last: the keys on the colour. */
              ring: (() => {
                (colour as HTMLElement).focus();
                const drawn = getComputedStyle(colour);
                return [drawn.outlineStyle, drawn.borderRadius];
              })(),
            };
          },
          { entry: "mail", face, scheme, zoom, device },
        );
        const at = `${device}`;
        /* Under a finger the colour answers a step further round it; under the keys it wears the kit's ring and stays round. */
        expect(seen.reach, at).toBe(device === "phone");
        expect(seen.ring, at).toEqual(["solid", seen.pill]);
        /* The colour: a button of the face's pill as tall as a small control (a step of six under a finger), its dot of 12 in its middle, pulled out by a step. */
        expect(seen.colour[0], at).toBeCloseTo(seen.hue, 0);
        expect(seen.colour[1], at).toBeCloseTo(seen.hue, 0);
        expect(seen.colour[2], at).toBe(seen.pill);
        expect(Math.abs(seen.middle[0]!) + Math.abs(seen.middle[1]!), at).toBeLessThanOrEqual(1);
        expect(seen.middle[2], at).toBeCloseTo(12 * zoom, 0);
        expect(seen.pulled, at).toBeCloseTo(seen.s2, 0);
        /* The two words one group: drawn a step closer than two buttons stand, the last at the line's edge past its padding. */
        expect(seen.together, at).toBeCloseTo(-seen.s2, 0);
        expect(seen.edge, at).toBeLessThan(0);
        /* On a desktop the count and the words beside the name; under a finger under it, the count set in by the colour. */
        if (device === "desktop") expect(seen.beside, at).toEqual([true, true]);
        else {
          expect(seen.beside[0], at).toBe(true);
          expect(seen.beside[1], at).toBeCloseTo(seen.hue, 0);
        }
        /* The name's field: one line at the line's height in the middle weight, set in by the colour's width. */
        expect(seen.field[0], at).toBeCloseTo(seen.hm, 0);
        expect(seen.field[1], at).toBe(seen.mid);
        expect(seen.field[2], at).toBeCloseTo(seen.hue, 0);
        /* Its refusal under the whole line: from the field's edge, at once under it, on under the word that acts. */
        expect(seen.under[0], at).toBeCloseTo(0, 0);
        expect(seen.under[1], at).toBeGreaterThanOrEqual(-0.5);
        expect(seen.under[2], at).toBe(true);
        expect(seen.sideways, at).toBe(0);
      }
    },
    60_000,
  );
});

describe("a list's search and its filter", () => {
  it.each(SETTINGS_LOOKS)(
    "in %s %s at Text size %s: the sign inside the box at its edge's step, the words a step after it; the filter's word at the line's end",
    async (face, scheme, zoom) => {
      const seen = await drawn(
        <div style={{ width: 676 }}>
          <Field
            label="Search by sender or domain"
            placeholder="Search by sender or domain"
            value=""
            onChange={() => {}}
            bare
            sign="search"
          />
          <SettingFilter
            act={
              <Button kind="quiet" size="s">
                Revoke all 6 matching
              </Button>
            }
          >
            <Seg
              label="Files into"
              options={[
                { value: "all", label: "All" },
                { value: "news", label: "News" },
              ]}
              value="all"
            />
          </SettingFilter>
        </div>,
        () => {
          const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
          const [input, sign, filter] = ["input", "svg", "[role='group']"].map(box);
          const act = [...document.querySelectorAll("button")]
            .find((b) => b.textContent === "Revoke all 6 matching")!
            .getBoundingClientRect();
          const probe = document.createElement("i");
          probe.style.cssText = "display:block;width:var(--s4);height:var(--s2)";
          document.querySelector(".oh-root")!.append(probe);
          const step = probe.getBoundingClientRect();
          const pad = parseFloat(getComputedStyle(document.querySelector("input")!).paddingLeft);
          return {
            sign: [
              sign.left - input.left,
              sign.width,
              sign.top + sign.height / 2 - (input.top + input.height / 2),
            ],
            words: pad * (step.width / (parseFloat(getComputedStyle(probe).width) || 1)),
            edge: step.width,
            s2: step.height,
            inLine: act.top < filter.bottom && act.left > filter.right,
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        },
        { entry: "mail", face, scheme, zoom },
      );
      const near = (a: number, b: number) => expect(Math.abs(a - b), `${a} for ${b}`).toBeLessThan(0.75);
      near(seen.sign[0]!, seen.edge);
      near(seen.sign[1]!, 18 * zoom);
      near(seen.sign[2]!, 0);
      near(seen.words, seen.edge + 18 * zoom + seen.s2);
      expect(seen.inLine).toBe(true);
      expect(seen.sideways).toBe(0);
    },
    60_000,
  );
});

describe("a refused blank", () => {
  it.each(SETTINGS_LOOKS)(
    "in %s %s at Text size %s: its dotted line turns hot while it is refused, and back to the ink",
    async (face, scheme, zoom) => {
      for (const refused of [true, false]) {
        const seen = await drawn(
          <p className="oh-text">
            Your token is{" "}
            <Blank label="setup token" placeholder="token" value="x" refused={refused} onChange={() => {}} />
          </p>,
          () => {
            const line = getComputedStyle(document.querySelector("input")!);
            const probe = document.createElement("i");
            probe.style.cssText = "color:var(--hot);background-color:var(--ink)";
            document.querySelector(".oh-root")!.append(probe);
            const tones = getComputedStyle(probe);
            return {
              color: line.borderBottomColor,
              style: line.borderBottomStyle,
              hot: tones.color,
              ink: tones.backgroundColor,
            };
          },
          { face, scheme, zoom },
        );
        expect(seen.style, `refused ${refused}`).toBe("dotted");
        expect(seen.color, `refused ${refused}`).toBe(refused ? seen.hot : seen.ink);
      }
    },
    60_000,
  );
});

describe("the dock in a low room", () => {
  const places = ["ohbox", "screener", "news", "receipts", "later", "drafts"].map((id, i) => ({
    id,
    label: id,
    icon: id as "ohbox",
    count: i < 2 ? String(i + 2) : undefined,
    current: i === 0,
  }));
  /*
   * Where the frame stands it. Asked for upright: beside the column, a rail's width, a step in from the window's
   * edges. Unasked: in the frame's foot box, 440 wide in the middle and a step over the foot.
   */
  const dock = (upright: boolean, onSearch = false) => (
    <div
      style={
        upright
          ? { position: "fixed", inset: "var(--s3) auto var(--s3) var(--s3)", width: 64, display: "grid" }
          : {
              position: "fixed",
              left: "max(var(--s3), 50% - 220px)",
              right: "max(var(--s3), 50% - 220px)",
              bottom: "var(--s4)",
            }
      }
    >
      <Dock
        label="Places"
        floor={2}
        places={onSearch ? places.map((place) => ({ ...place, current: false })) : places}
        more={{ label: "More" }}
        search={{ label: "Search", current: onSearch }}
        write={{ label: "Write" }}
        upright={upright}
      />
    </div>
  );
  it.each(SETTINGS_LOOKS)(
    "in %s %s at Text size %s: asked for, it stands upright, Write first, the places a thumb's 48 under it; unasked it keeps the foot however low the window, every entry inside it and Write answering a finger",
    async (face, scheme, zoom) => {
      for (const [width, height, asked] of [
        [678, 466, true],
        [568, 320, true],
        [678, 466, false],
        [568, 320, false],
        [640, 360, false],
        [390, 430, false],
        [390, 844, false],
        [669, 951, false],
      ] as const) {
        const room = [width, height] as const;
        const seen = await drawn(
          dock(asked),
          () => {
            const nav = document.querySelector("nav")!;
            const box = (el: Element) => el.getBoundingClientRect();
            const write = [...nav.querySelectorAll("button")].find((b) => b.textContent === "Write")!;
            const first = nav.querySelector("button[aria-current='page']") ?? nav.querySelector("button")!;
            const places = first.parentElement!;
            const probe = document.createElement("i");
            probe.style.cssText = "display:block;width:var(--h-l);height:var(--s2)";
            document.querySelector(".oh-root")!.append(probe);
            const tok = box(probe);
            return {
              upright: getComputedStyle(nav).flexDirection === "column",
              writeFirst: box(write).bottom <= box(places).top,
              between: box(places).top - box(write).bottom,
              entry: [box(first).width, box(first).height],
              thumb: tok.width,
              step: tok.height,
              ring: getComputedStyle(places).boxShadow,
              /* The entries that stand between the window's head and its foot (a narrow foot may scroll sideways). */
              inside: [...nav.querySelectorAll("button")].filter((b) => {
                const at = box(b);
                return at.top >= -0.5 && at.bottom <= innerHeight + 0.5;
              }).length,
              entries: nav.querySelectorAll("button").length,
              /* Write answers a finger at its middle. */
              writes: (() => {
                const at = box(write);
                return write.contains(
                  document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2),
                );
              })(),
            };
          },
          { entry: "mail", device: "phone", face, scheme, zoom, window: [...room] },
        );
        expect(seen.upright, `${room} ${asked}`).toBe(asked);
        if (!asked) {
          /* At the foot every entry stays inside the window, however low it is: Write is never out of reach. */
          expect(seen.inside, `${room}: entries inside the window`).toBe(seen.entries);
          expect(seen.writes, `${room}: Write answers a finger`).toBe(true);
          continue;
        }
        expect(seen.writeFirst, `${room}`).toBe(true);
        expect(Math.abs(seen.between - seen.step), `${room}`).toBeLessThan(0.75);
        expect(
          seen.entry.map((v) => Math.round(v)),
          `${room}`,
        ).toEqual([Math.round(seen.thumb), Math.round(seen.thumb)]);
        expect(seen.ring, `${room}`).toBe("none");
      }
    },
    60_000,
  );
  it.each(SETTINGS_LOOKS)(
    "in %s %s at Text size %s: on Search its disc is filled as the open place is, its sign in that fill's ink",
    async (face, scheme, zoom) => {
      const seen = await drawn(
        dock(true, true),
        () => {
          const search = document.querySelector("nav button[data-search]")!;
          const probe = document.createElement("i");
          probe.style.cssText = "color:var(--on-nav-on);background-color:var(--nav-on)";
          document.querySelector(".oh-root")!.append(probe);
          const tones = getComputedStyle(probe);
          const drawn = getComputedStyle(search);
          return {
            fill: drawn.backgroundColor,
            ink: drawn.color,
            on: tones.backgroundColor,
            onInk: tones.color,
          };
        },
        { entry: "mail", device: "phone", face, scheme, zoom, window: [678, 466] },
      );
      expect(seen.fill).toBe(seen.on);
      expect(seen.ink).toBe(seen.onInk);
    },
    60_000,
  );
});

describe("a look's picture", () => {
  const ROWS = [
    { who: "Giulia Ferrari", address: "giulia@terracotta-milano.example", time: "09:12" },
    { who: "Petra Wyss", address: "petra@makersfest.example", time: "08:47" },
  ] as const;
  /* What the picture draws, node by node, and the face's own tokens as a root of the page's face computes them. */
  const read = () => {
    const picture = document.querySelector<HTMLElement>("span[data-face]")!;
    const props = [
      "color",
      "background-color",
      "box-shadow",
      "border-radius",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "padding",
      "margin",
      "width",
      "height",
    ];
    const at = picture.getBoundingClientRect();
    const nodes = [picture, ...picture.querySelectorAll("*")].map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return [
        el.tagName,
        r.left - at.left,
        r.top - at.top,
        r.width,
        r.height,
        ...props.map((p) => cs.getPropertyValue(p)),
      ].join(" | ");
    });
    const sheet = picture.firstElementChild!;
    const title = sheet.children[0]!;
    const open = sheet.children[1]!;
    const probe = document.createElement("i");
    probe.style.cssText =
      "color:var(--ink);background-color:var(--ground);border-top-color:var(--sheet);border-right-color:var(--hot);border-bottom-color:var(--row-open);font-family:var(--f-display)";
    document.body.append(probe);
    const tok = getComputedStyle(probe);
    const drawn = (el: Element) => getComputedStyle(el);
    return {
      nodes,
      seen: {
        ground: drawn(picture).backgroundColor,
        ink: drawn(picture).color,
        sheet: drawn(sheet).backgroundColor,
        hot: drawn(title.lastElementChild!).backgroundColor,
        open: drawn(open).backgroundColor,
        title: drawn(title).fontFamily,
      },
      tokens: {
        ground: tok.backgroundColor,
        ink: tok.color,
        sheet: tok.borderTopColor,
        hot: tok.borderRightColor,
        open: tok.borderBottomColor,
        title: tok.fontFamily,
      },
    };
  };
  it.each(
    (["light", "dark"] as const).flatMap((scheme) =>
      ([1, 1.25] as const).map((zoom) => [scheme, zoom] as const),
    ),
  )(
    "in %s at Text size %s: each face's picture wears that face's own tokens, and draws the same on a Paper page and on an Ohmarchy page",
    async (scheme, zoom) => {
      for (const face of ["paper", "ohmarchy"] as const) {
        const [onPaper, onOhmarchy] = await Promise.all(
          (["paper", "ohmarchy"] as const).map((page) =>
            drawn(<LookPicture face={face} scheme={scheme} title="Ohbox" rows={ROWS} />, read, {
              entry: "mail",
              face: page,
              scheme,
              zoom,
            }),
          ),
        );
        /* Read on a page of the picture's own face, the tokens are that face's. */
        const own = face === "paper" ? onPaper! : onOhmarchy!;
        expect(own.seen, `${face} ${scheme}: the picture against its face's tokens`).toEqual(own.tokens);
        expect(onOhmarchy!.nodes, `${face} ${scheme}: the same on both pages`).toEqual(onPaper!.nodes);
      }
    },
    60_000,
  );
  it("its sheet names no root and no other part: every rule that reaches it is the picture's own", async () => {
    const rules = await drawn(
      <LookPicture face="paper" scheme="light" title="Ohbox" rows={ROWS} />,
      () => {
        const out: string[] = [];
        const walk = (list: CSSRuleList) => {
          for (const rule of list) {
            if (rule instanceof CSSStyleRule && rule.selectorText.includes("oh-lookpic"))
              out.push(rule.selectorText);
            if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
          }
        };
        for (const sheet of document.styleSheets) walk(sheet.cssRules);
        return out;
      },
      { entry: "mail" },
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((rule) => /:root|\bhtml\b|\bbody\b/.test(rule))).toEqual([]);
    expect(
      rules.filter((rule) => (rule.match(/\.[\w-]+/g) ?? []).some((name) => !name.startsWith(".oh-lookpic"))),
    ).toEqual([]);
  });
});

/** Paper and Ohmarchy, with a pointer and under a finger, at the default Text size and at the largest. */
const ASK_LOOKS = (["paper", "ohmarchy"] as const).flatMap((face) =>
  (["desktop", "phone"] as const).flatMap((device) =>
    ([1, 1.5] as const).map((zoom) => [face, device, zoom] as const),
  ),
);

describe("a list's own line", () => {
  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: it starts where the list's last line starts, a refusal is bold in the ink with its sign on its first line, and longer German words wrap inside it with its press",
    async (face, device, zoom) => {
      const seen = await drawn(
        <div style={{ width: 250 }}>
          <ListTail way={{ label: "Verlauf" }}>Ältere Mail</ListTail>
          <ListLine warn act={{ label: "Erneut versuchen" }}>
            Weitere Absenderinnen und Absender konnten nicht geladen werden.
          </ListLine>
          <ListLine>Das ist alles auf deinem Mailserver.</ListLine>
        </div>,
        () => {
          const tail = document.querySelector(".oh-listtail")!;
          const [warn, plain] = [...document.querySelectorAll(".oh-listline")] as HTMLElement[];
          const say = warn!.querySelector(".oh-listline-say")!;
          const [sign, words] = [say.querySelector("svg")!, say.querySelector("span")!];
          const act = warn!.querySelector("button")!.getBoundingClientRect();
          const box = warn!.getBoundingClientRect();
          const probe = document.createElement("i");
          probe.style.color = "var(--ink)";
          document.querySelector(".oh-root")!.append(probe);
          const lineHigh = parseFloat(getComputedStyle(words).lineHeight) * (box.width / warn!.offsetWidth);
          const wordsBox = words.getBoundingClientRect();
          return {
            starts: [
              parseFloat(getComputedStyle(tail).paddingLeft),
              parseFloat(getComputedStyle(warn!).paddingLeft),
            ],
            role: [warn!.getAttribute("role"), plain!.getAttribute("role")],
            weight: [getComputedStyle(warn!).fontWeight, getComputedStyle(plain!).fontWeight],
            ink: [
              getComputedStyle(warn!).color,
              getComputedStyle(probe).color,
              getComputedStyle(plain!).color,
            ],
            signOnFirstLine: sign.getBoundingClientRect().bottom < wordsBox.top + lineHigh * 1.2,
            lines: Math.round(wordsBox.height / lineHigh),
            actInside:
              act.left >= box.left - 0.5 && act.right <= box.right + 0.5 && act.bottom <= box.bottom + 0.5,
            wordsInside: words.getBoundingClientRect().right <= box.right + 0.5,
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        },
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      expect(seen.starts[1]).toBe(seen.starts[0]);
      expect(seen.role).toEqual(["status", null]);
      expect(Number(seen.weight[0])).toBeGreaterThan(Number(seen.weight[1]));
      expect(seen.ink[0]).toBe(seen.ink[1]);
      expect(seen.ink[2]).not.toBe(seen.ink[1]);
      expect(seen.signOnFirstLine).toBe(true);
      expect(seen.lines).toBeGreaterThan(1);
      expect(seen.actInside).toBe(true);
      expect(seen.wordsInside).toBe(true);
      expect(seen.sideways).toBeLessThanOrEqual(0);
    },
    60_000,
  );
});

describe("a waiting sender's row", () => {
  const sender: RowProps = {
    who: "Cinderlock Security",
    address: "alerts@cinderlock-mail.example",
    people: [{ name: "Cinderlock Security", address: "alerts@cinderlock-mail.example" }],
    subject: "Ihr Konto wurde vorübergehend eingeschränkt",
    preview: "Bitte bestätigen Sie Ihre Angaben, damit wir den Zugang wieder freigeben können.",
    when: "08:47",
    unread: true,
  };
  const place = {
    word: "Aussortieren",
    accept: { label: "Aussortieren und abbestellen" },
    choose: { label: "Einen Ort wählen" },
  };

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: each label is whole or not there in every width, the address goes before a label and a label before the name is cut, and the place's controls lie over the room the row keeps, inside the row",
    async (face, device, zoom) => {
      const seen = await drawn(
        <>
          {[760, 460, 380, 300].map((width) => (
            <div key={width} data-at={width} style={{ width }}>
              <Rows>
                <Row {...sender} labels={["Braucht dich", "2 zurückgehalten"]} place={place} />
              </Rows>
            </div>
          ))}
        </>,
        () =>
          [...document.querySelectorAll<HTMLElement>("[data-at]")].map((at) => {
            const row = at.querySelector<HTMLElement>(".oh-row")!;
            const first = row.querySelector(".oh-row-first")!.getBoundingClientRect();
            const who = row.querySelector<HTMLElement>(".oh-row-who")!;
            const address = row.querySelector<HTMLElement>(".oh-row-address")!;
            const held = row.querySelector(".oh-row-labels")!.getBoundingClientRect();
            const labels = [...row.querySelectorAll(".oh-row-labels > .oh-tag")].map((tag) => {
              const r = tag.getBoundingClientRect();
              /* What holds the labels cuts what leaves its box: a label is whole inside it, or under its foot. */
              const seenWhole =
                r.top < held.bottom - 1 && r.left >= held.left - 0.5 && r.right <= held.right + 0.5;
              const gone = r.top >= held.bottom - 1;
              return seenWhole ? "whole" : gone ? "gone" : "cut";
            });
            const room = row.querySelector(".oh-row-place[data-room]")!.getBoundingClientRect();
            const real = at.querySelector(".oh-row-beside .oh-row-place")!.getBoundingClientRect();
            const box = row.getBoundingClientRect();
            return {
              width: at.dataset.at,
              labels,
              nameCut: who.scrollWidth > who.clientWidth + 1,
              addressShown: address.getBoundingClientRect().width > 1,
              over: [
                real.left - room.left,
                real.top - room.top,
                real.width - room.width,
                real.height - room.height,
              ],
              inside:
                real.left >= box.left && real.right <= box.right + 0.5 && real.bottom <= box.bottom + 0.5,
            };
          }),
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      for (const at of seen) {
        expect(at.labels, `labels at ${at.width}`).not.toContain("cut");
        /* The last label goes first. */
        if (at.labels[0] === "gone") expect(at.labels[1], `order at ${at.width}`).toBe("gone");
        /* The address gives way before a label; a label before the name. */
        if (at.addressShown) expect(at.labels, `address at ${at.width}`).toEqual(["whole", "whole"]);
        if (at.nameCut) expect(at.labels, `name at ${at.width}`).toEqual(["gone", "gone"]);
        for (const off of at.over)
          expect(Math.abs(off), `the place over its room at ${at.width}`).toBeLessThan(0.75);
        expect(at.inside, `the place inside the row at ${at.width}`).toBe(true);
      }
      /* The widths are told apart: somewhere both labels stand, and somewhere one has gone. */
      expect(seen.some((at) => at.labels.every((label) => label === "whole"))).toBe(true);
      expect(seen.some((at) => at.labels.includes("gone"))).toBe(true);
    },
    60_000,
  );

  it.each(["paper", "ohmarchy"] as const)(
    "in %s a sender taken for junk recedes to the second ink, and the row that is open never does",
    async (face) => {
      const seen = await drawn(
        <Rows>
          <Row {...sender} />
          <Row {...sender} receded />
          <Row {...sender} receded open />
          <Row {...sender} open />
        </Rows>,
        () => {
          const probe = document.createElement("i");
          probe.style.color = "var(--ink2)";
          document.querySelector(".oh-root")!.append(probe);
          const ink = (row: Element) => getComputedStyle(row.querySelector(".oh-row-who")!).color;
          return {
            ink2: getComputedStyle(probe).color,
            who: [...document.querySelectorAll(".oh-row")].map(ink),
          };
        },
        { entry: "mail", face },
      );
      expect(seen.who[1]).toBe(seen.ink2);
      expect(seen.who[0]).not.toBe(seen.ink2);
      expect(seen.who[2]).toBe(seen.who[3]);
    },
    60_000,
  );

  it.each([
    ["paper", "phone", 1],
    ["paper", "phone", 1.5],
    ["ohmarchy", "phone", 1],
    ["ohmarchy", "phone", 1.5],
    ["paper", "fold", 1.5],
    ["ohmarchy", "fold", 1.5],
  ] as const)(
    "in %s on a %s at Text size %s: under a finger a press inside the next row reaches that row, never the place above",
    async (face, device, zoom) => {
      const placed = (n: number) => ({
        word: "News",
        accept: { label: `Row ${n}: News and unsubscribe` },
        choose: { label: `Row ${n}: choose a place` },
      });
      const seen = await drawn(
        <Rows label="Waiting">
          <Row {...sender} place={placed(1)} />
          <Row {...sender} who="Second Sender" place={placed(2)} />
          <Row {...sender} who="Third Sender" place={placed(3)} />
        </Rows>,
        () => {
          const slots = [...document.querySelectorAll<HTMLElement>(".oh-row-slot")];
          const probes: { row: number; under: number; hit: string }[] = [];
          slots.slice(0, 2).forEach((slot, i) => {
            const chip = slot.querySelector(".oh-row-beside .oh-row-place-word")!.getBoundingClientRect();
            const next = slots[i + 1]!.querySelector(".oh-row")!.getBoundingClientRect();
            /* At the middle of the chip above, a little under the next row's top: inside the next row. */
            for (const under of [0.5, 2, 4, 8]) {
              const hit = document.elementFromPoint(chip.left + chip.width / 2, next.top + under);
              const press = hit?.closest("button")?.getAttribute("aria-label");
              const own = hit?.closest(".oh-row-slot") === slots[i + 1];
              probes.push({
                row: i + 2,
                under,
                hit: press ?? (own ? "its own row" : String(hit?.className)),
              });
            }
          });
          return probes;
        },
        { entry: "mail", face, device, zoom },
      );
      expect(seen).toHaveLength(8);
      for (const probe of seen) expect(probe.hit, JSON.stringify(probe)).toBe("its own row");
    },
    60_000,
  );
});

describe("the line a place is searched from", () => {
  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: one row tall, its sign in the room of a row's circle, the words inside the box with a chip, the time and the way to empty it, and no sideways scroll in German",
    async (face, device, zoom) => {
      const seen = await drawn(
        <div style={{ width: 250, display: "grid", gap: 8 }}>
          <FindField label="Suchen" placeholder="Nachrichten durchsuchen" value="" onChange={() => {}} />
          <FindField
            label="Suchen"
            placeholder="In dieser Mail"
            value="Rechnung Brennofen"
            took="0,12 s"
            clear={{ label: "Leeren" }}
            chip={{
              label: "Petra Wyss-Hürlimann",
              person: { name: "Petra Wyss-Hürlimann", address: "petra@makersfest.example" },
              remove: "Petra Wyss-Hürlimann entfernen",
            }}
            onChange={() => {}}
          />
        </div>,
        () => {
          const probe = document.createElement("i");
          probe.style.cssText = "display:block;width:var(--gutter);height:var(--h-l)";
          document.querySelector(".oh-root")!.append(probe);
          const unit = probe.getBoundingClientRect();
          return [...document.querySelectorAll<HTMLElement>(".oh-findfield")].map((field) => {
            const box = field.getBoundingClientRect();
            const sign = field.querySelector("svg")!.getBoundingClientRect();
            const input = field.querySelector("input")!.getBoundingClientRect();
            const parts = [...field.children].map((child) => child.getBoundingClientRect());
            const took = field.querySelector(".oh-findfield-took");
            const tookWords = took?.firstElementChild?.getBoundingClientRect();
            const tookBox = took?.getBoundingClientRect();
            return {
              tall: box.height - unit.height,
              signMid: sign.left + sign.width / 2 - box.left - unit.width / 2,
              words: input.left - box.left - unit.width,
              inputWide: input.width,
              inside: parts.every(
                (r) => r.width === 0 || (r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
              ),
              took: !took
                ? null
                : getComputedStyle(took).display === "none"
                  ? "none"
                  : tookWords!.top >= tookBox!.bottom - 1
                    ? "gone"
                    : tookWords!.right <= tookBox!.right + 0.5 && tookWords!.left >= tookBox!.left - 0.5
                      ? "whole"
                      : "cut",
              sideways: document.documentElement.scrollWidth - innerWidth,
            };
          });
        },
        { face, device, zoom, lang: "de" },
      );
      const [rest, narrowed] = seen;
      expect(Math.abs(rest!.tall)).toBeLessThan(0.75);
      if (device === "desktop") {
        /* With a pointer the sign stands in the middle of the circle's room, and the words start after it. */
        expect(Math.abs(rest!.signMid)).toBeLessThan(0.75);
        expect(Math.abs(rest!.words)).toBeLessThan(0.75);
      }
      for (const field of seen) {
        expect(field.inside).toBe(true);
        expect(field.inputWide).toBeGreaterThan(24);
        expect(field.sideways).toBeLessThanOrEqual(0);
      }
      /* Under a finger, beside a chip, the time is not drawn; with a pointer it is whole or not there, never cut. */
      if (device === "phone") expect(narrowed!.took).toBe("none");
      else expect(["whole", "gone"]).toContain(narrowed!.took);
    },
    60_000,
  );
});

describe("the parts a screen stands side by side, under a finger", () => {
  const hit: RowProps = {
    who: "Petra Wyss-Hürlimann",
    address: "petra@makersfest.example",
    people: [{ name: "Petra Wyss-Hürlimann", address: "petra@makersfest.example" }],
    subject: "Rechnung für den Brennofen",
    preview: "Im Anhang die Rechnung vom November.",
    when: "08:47",
  };
  const rule = (who: string, place: string, held: boolean) => (
    <RuleLine
      who={who}
      person={{ name: who, address: who, label: `Karte von ${who}`, onContact: () => {} }}
      goes={
        <>
          geht nach{" "}
          <Slot label={`${who} geht nach ${place}`} disabled={held}>
            {place}
          </Slot>
        </>
      }
      origin="Entscheid im Screener · 14 Nachrichten"
      act={
        <Button kind="quiet" size="s" label={`${who} widerrufen`} disabled={held}>
          Widerrufen
        </Button>
      }
    />
  );
  /* Search's field over its filters over its hits; a place's headings between its rows; a sheet of settings.
     All in a sheet's own steps from the window's edge, where a line's press may reach out to them. */
  const standing = (
    <div style={{ padding: "0 16px" }}>
      <FindField
        label="Suchen"
        value="Rechnung"
        took="0,12 s"
        clear={{ label: "Leeren" }}
        chip={{
          label: "Petra Wyss-Hürlimann",
          person: { name: "Petra Wyss-Hürlimann", address: "petra@makersfest.example" },
          remove: "Petra Wyss-Hürlimann entfernen",
        }}
        onChange={() => {}}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
        <Button kind="two" size="s" mark="down" opens="menu">
          Ort
        </Button>
        <Button kind="two" size="s" mark="x" pressed>
          Mit Anhang
        </Button>
        <Button kind="two" size="s" mark="down" opens="menu">
          Zeitraum
        </Button>
        <Button kind="two" size="s" mark="down" opens="menu">
          Postfach
        </Button>
      </div>
      <Rows>
        <Row {...hit} />
      </Rows>
      <GroupHeading tag="Nur lesen" expanded onPress={() => {}}>
        Auf dem Server
      </GroupHeading>
      <Rows>
        <Row {...hit} who="Zweite Absenderin" />
      </Rows>
      <GroupHeading count="3" expanded onPress={() => {}}>
        Früher
      </GroupHeading>
      <Rows>
        <Row {...hit} who="Dritte Absenderin" />
      </Rows>
      <SettingLine label="Abwesenheitsnotiz" toggle={{ on: true }} />
      <SettingLine label="Endet am" narrow="under">
        <Slot label="Enddatum wählen">Freitag, 21. November</Slot>
        <Button kind="quiet" size="s">
          Kein Enddatum
        </Button>
      </SettingLine>
      <SettingLine label="Antwortet einer Person" narrow="under">
        <Slot label="Wie oft geantwortet wird" disabled>
          einmal in vier Tagen
        </Slot>
      </SettingLine>
      <SettingLine label="Signatur anhängen" toggle={{ on: false }} />
      {rule("giulia@terracotta-milano.example", "News", true)}
      {rule("rechnung@brennofen-zentrale.example", "Ohbox", false)}
      <SettingLine label="Lesebestätigung" toggle={{ on: false }} />
    </div>
  );
  const moving = (
    <MovePicker
      open
      onClose={() => {}}
      label="Verschieben"
      title="Verschieben nach"
      places={[
        { id: "ohbox", label: "Ohbox" },
        { id: "news", label: "News" },
      ]}
      find={{ label: "Ordner suchen", placeholder: "Ordner suchen", value: "" }}
      mailbox="petra@makersfest.example"
      folders={[
        { id: "a", name: "Gartenlokal Rosa", path: "Kunden › Gastronomie" },
        { id: "b", name: "Brennofen", path: "Kunden › Werkstatt", disabled: true },
        { id: "c", name: "Steuern 2026" },
      ]}
    />
  );
  /* Along every edge of everything a press can mean, a little inside its own drawn box: whose is the press? */
  const walk = () => {
    const PRESSED =
      "button, a[href], input, textarea, [role='button'], [role='option'], [role^='menuitem'], [data-press]";
    const said = (el: Element) =>
      (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 48) || el.tagName;
    const taken = new Set<string>();
    let walked = 0;
    let probes = 0;
    const outside = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>(PRESSED)) {
      const r = el.getBoundingClientRect();
      if (r.width < 9 || r.height < 9) continue;
      walked++;
      const at = (x: number, y: number, where: string) => {
        probes++;
        const under = document.elementFromPoint(x, y);
        if (!under) outside.add(said(el));
        const owner = under?.closest(PRESSED);
        if (owner && owner !== el && !el.contains(owner) && !owner.contains(el))
          taken.add(`${where} of "${said(el)}" answers as "${said(owner)}"`);
      };
      /* Between its round corners: what lies outside their curve is not the control's. */
      const scale = r.width / el.offsetWidth || 1;
      const round = parseFloat(getComputedStyle(el).borderTopLeftRadius) * scale || 0;
      const corner = Math.max(4, Math.min(round, r.width / 2, r.height / 2));
      /* A whole pixel in and more: a press is read at whole pixels, and half of one in is the next box's. */
      for (const inside of [1, 2, 4]) {
        for (let x = r.left + corner; x <= r.right - corner; x += 6) {
          at(x, r.top + inside, `${inside} under the top`);
          at(x, r.bottom - inside, `${inside} over the foot`);
        }
        for (let y = r.top + corner; y <= r.bottom - corner; y += 6) {
          at(r.left + inside, y, `${inside} in from the left`);
          at(r.right - inside, y, `${inside} in from the right`);
        }
      }
    }
    return { walked, probes, outside: [...outside], taken: [...taken] };
  };

  it.each([
    ["paper", "phone", 1],
    ["paper", "phone", 1.5],
    ["ohmarchy", "phone", 1],
    ["ohmarchy", "phone", 1.5],
    ["paper", "fold", 1.5],
    ["ohmarchy", "fold", 1.5],
  ] as const)(
    "in %s on a %s at Text size %s: a press inside a control's own box is that control's, never its neighbour's (a marked button, the find field's parts, a row, a heading that shuts, a slot on a line of settings and in a rule, the Move menu's lines)",
    async (face, device, zoom) => {
      /* A window high enough to hold every part: nothing is walked out of sight. */
      const window: [number, number] = [DEVICES[device].window[0], 2400];
      const stood = await drawn(standing, walk, { entry: "mail", face, device, zoom, lang: "de", window });
      const menu = await drawn(moving, walk, { entry: "mail", face, device, zoom, lang: "de" });
      expect(stood.walked).toBeGreaterThanOrEqual(24);
      expect(menu.walked).toBe(6);
      expect([...stood.outside, ...menu.outside]).toEqual([]);
      expect([...stood.taken, ...menu.taken]).toEqual([]);
    },
    60_000,
  );
});
