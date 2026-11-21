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
  CameraSquare,
  ChoiceTiles,
  Dialog,
  Dot,
  Empty,
  Field,
  FieldPair,
  FieldStack,
  FindField,
  JumpBack,
  Mark,
  Menu,
  MenuItem,
  Notice,
  Page,
  RadioLines,
  RefusalLine,
  RowsShape,
  Sentence,
  SentencePart,
  Seg,
  Slot,
  StepDots,
  Tag,
} from "../../src/base/index.js";
import { AgendaRow, MiniMonth } from "../../src/calendar/index.js";
import {
  ActionPanel,
  ColumnHandle,
  Composer,
  Dock,
  Doorbell,
  FigureLine,
  FigureTable,
  FolderShelf,
  GroupHeading,
  ListHead,
  ListLine,
  ListTail,
  LookPicture,
  Message,
  MessageHead,
  MonthRail,
  MovePicker,
  RailEntry,
  ReadingHead,
  ReadingLine,
  Row,
  Rows,
  RuleLine,
  ScaleBar,
  SettingArea,
  SettingFilter,
  SettingLine,
  SettingNote,
  SettingsSheet,
  Sheet,
  TagLine,
  TextNotKept,
  TickList,
  letterText,
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

it.each([
  ["paper", "phone"],
  ["ohmarchy", "desktop"],
] as const)("keeps a Settings summary on one truncating line in %s on %s", async (face, device) => {
  const reading = await drawn(
    <Rows>
      <Row entry who="Rules" people={[]} subject="On" preview={"Ohbox and News · ".repeat(50)} />
    </Rows>,
    () => {
      const line = document.querySelector<HTMLElement>(".oh-row-second")!;
      const style = getComputedStyle(line);
      const value = line.querySelector(".oh-row-subject")!.getBoundingClientRect();
      const detail = line.querySelector(".oh-row-preview")!.getBoundingClientRect();
      return {
        ellipsis: style.textOverflow,
        singleLine: Math.abs(value.top - detail.top) < value.height,
        clipped: line.scrollWidth > line.clientWidth,
      };
    },
    { entry: "mail", face, device },
  );
  expect(reading).toEqual({ ellipsis: "ellipsis", singleLine: true, clipped: true });
});

describe("the product's mark", () => {
  it.each([
    ["paper", "desktop", 200],
    ["paper", "phone", 128],
    ["ohmarchy", "desktop", 96],
    ["ohmarchy", "phone", 72],
  ] as const)(
    "in %s on a %s: a stop that is a doorbell stands exactly where the plain stop stands, a quarter of the letters high, hot; a finger reaches it as far as the smallest control",
    async (face, device, size) => {
      const seen = await drawn(
        <>
          <Mark hot>oh</Mark>
          <Mark hot bell={{ label: "Ring the doorbell" }}>
            oh
          </Mark>
        </>,
        () => {
          const [plain, belled] = [...document.querySelectorAll("p")];
          const from = (mark: Element, node: Element) => {
            const [m, n] = [mark.getBoundingClientRect(), node.getBoundingClientRect()];
            return [n.left - m.left, n.top - m.top, n.width, n.height].map((v) => Math.round(v * 10) / 10);
          };
          const bell = belled!.querySelector("button")!;
          const probe = document.createElement("i");
          probe.style.cssText = "display:block;height:var(--h-s);color:var(--hot)";
          document.body.append(probe);
          const least = probe.getBoundingClientRect().height;
          const hot = getComputedStyle(probe).color;
          probe.remove();
          const reach = parseFloat(getComputedStyle(bell, "::after").top);
          return {
            size: parseFloat(getComputedStyle(plain!).fontSize),
            plainStop: from(plain!, plain!.querySelector("i")!),
            bell: from(belled!, bell),
            ground: getComputedStyle(bell).backgroundColor === hot,
            round:
              getComputedStyle(bell).borderRadius ===
              getComputedStyle(plain!.querySelector("i")!).borderRadius,
            marksAlike: plain!.getBoundingClientRect().height === belled!.getBoundingClientRect().height,
            reached: bell.getBoundingClientRect().height - 2 * reach,
            least,
          };
        },
        { face, device },
      );
      expect(seen.size).toBe(size);
      expect(seen.plainStop.slice(2)).toEqual([size / 4, size / 4]);
      expect(seen.bell).toEqual(seen.plainStop);
      expect([seen.ground, seen.round, seen.marksAlike]).toEqual([true, true, true]);
      expect(seen.reached).toBe(Math.max(size / 4, seen.least));
    },
  );
});

describe("a ring", () => {
  it("is one motion wherever it rings: the mark's stop and the doorbell knock and ring out by the same frames, over the same time", async () => {
    const seen = await drawn(
      <>
        <Mark hot ringing>
          oh
        </Mark>
        <Doorbell count="6" label="6 waiting, Screener" ringing />
      </>,
      () => {
        const ring = (el: Element) =>
          el
            .getAnimations({ subtree: true })
            .map((move) => {
              const effect = move.effect as KeyframeEffect;
              const { duration, easing, fill } = effect.getComputedTiming();
              return [
                effect.pseudoElement ?? "itself",
                (move as CSSAnimation).animationName,
                duration,
                easing,
                fill,
              ];
            })
            .sort();
        return { stop: ring(document.querySelector("p i")!), bell: ring(document.querySelector("button")!) };
      },
      { entry: "mail", still: false },
    );
    expect(seen.stop.map(([on]) => on)).toEqual(["::before", "itself"]);
    expect(seen.bell).toEqual(seen.stop);
  });
});

describe("what an open fold says where it holds nothing", () => {
  it.each(["paper", "ohmarchy"] as const)(
    "in %s: a quiet line as high as a tag's, in the second ink, starting where the design starts it",
    async (face) => {
      const seen = await drawn(
        <div className="oh-rail" style={{ width: 240 }}>
          <RailEntry kind="fold" expanded none="No tags yet.">
            Tags
          </RailEntry>
          <RailEntry kind="sub" hue={150}>
            Pottery Project
          </RailEntry>
        </div>,
        () => {
          const note = document.querySelector("p")!;
          const tag = [...document.querySelectorAll("button")].at(-1)!;
          const words = (node: Element) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return range.getBoundingClientRect().left;
          };
          const probe = document.createElement("i");
          probe.style.cssText = "color:var(--ink2)";
          document.body.append(probe);
          const quiet = getComputedStyle(probe).color;
          probe.remove();
          const [n, t] = [note.getBoundingClientRect(), tag.getBoundingClientRect()];
          return {
            high: [n.height, t.height],
            under: n.top >= document.querySelector("button")!.getBoundingClientRect().bottom,
            quiet: getComputedStyle(note).color === quiet,
            lead: words(note) - n.left,
            tagName: words(tag.querySelector("span")!) - t.left,
            tagLead: parseFloat(getComputedStyle(tag).paddingLeft),
          };
        },
        { entry: "mail", face },
      );
      expect(seen.high[0]).toBe(seen.high[1]);
      expect([seen.under, seen.quiet]).toEqual([true, true]);
      /* Paper: under the tags' names. Ohmarchy: at a smaller entry's own lead, as its sheet has it. */
      expect(seen.lead).toBe(face === "paper" ? seen.tagName : seen.tagLead);
    },
  );
});

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

describe("what a press inside a dialog came to", () => {
  it("stands in sight under the longest list: outside what scrolls, over the answers, its words in line with the dialog's", async () => {
    const seen = await drawn(
      <Dialog
        open
        onClose={() => {}}
        title="40 changes wait"
        cancel={{ label: "Close", keyHint: "Esc" }}
        list
        said={{ line: "Not put back. The mailbox did not answer.", refused: true }}
      >
        {Array.from({ length: 40 }, (_, at) => (
          <div key={at} role="listitem" className="oh-text">
            Archive, letter {at + 1}
          </div>
        ))}
      </Dialog>,
      () => {
        const box = (el: Element) => el.getBoundingClientRect();
        const dialog = document.querySelector("[role='dialog']")!;
        const list = dialog.querySelector("[role='list']")!;
        /* A refusal answers a press: it is an alert. */
        const line = dialog.querySelector("[role='alert']")!;
        const close = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Close"))!;
        const words = line.querySelector("span")!;
        return {
          scrolls: list.scrollHeight > list.clientHeight + 1,
          inList: list.contains(line),
          listBottom: box(list).bottom,
          top: box(line).top,
          bottom: box(line).bottom,
          closeTop: box(close).top,
          dialogBottom: box(dialog).bottom,
          window: innerHeight,
          sign: box(line.querySelector("svg")!).left,
          content: box(dialog).left + parseFloat(getComputedStyle(dialog).paddingLeft),
          wordsHigh: box(words).height,
        };
      },
      { window: [900, 600] },
    );
    expect(seen.scrolls).toBe(true);
    expect(seen.inList).toBe(false);
    expect(seen.top).toBeGreaterThanOrEqual(seen.listBottom);
    expect(seen.bottom).toBeLessThanOrEqual(seen.closeTop);
    expect(seen.dialogBottom).toBeLessThanOrEqual(seen.window);
    /* Its sign starts where the dialog's sentence starts. */
    expect(seen.sign).toBeCloseTo(seen.content, 1);
    expect(seen.wordsHigh).toBeGreaterThan(0);
  }, 60_000);
});

describe("a notice's answer that is under way", () => {
  it("is drawn off as a button that is off, still takes the keys, and is said unavailable", async () => {
    const parts = (
      <>
        <Notice
          place="rail"
          title="3 letters are held"
          hot
          acts={[
            { label: "Release", busy: true, onPress: () => {} },
            { label: "Not now", disabled: true, onPress: () => {} },
          ]}
        />
        <Button size="s" disabled>
          Off
        </Button>
      </>
    );
    const seen = await drawn(parts, () => {
      const [release, later, off] = [...document.querySelectorAll("button")] as HTMLButtonElement[];
      const look = (el: Element) => {
        const cs = getComputedStyle(el);
        return [cs.backgroundColor, cs.color, cs.cursor];
      };
      release!.focus();
      const keysOnRelease = document.activeElement === release;
      later!.focus();
      return {
        release: look(release!),
        off: look(off!),
        keysOnRelease,
        keysOnLater: document.activeElement === later,
      };
    });
    expect(seen.release).toEqual(seen.off);
    expect(seen.keysOnRelease).toBe(true);
    expect(seen.keysOnLater).toBe(false);
    /* The browser's own tree lists its nodes in no order a page has: each button is read by its name. */
    const said = await spoken(parts);
    const off = (name: string) => said.find((n) => n.role === "button" && n.name === name)?.disabled ?? false;
    expect([off("Release"), off("Not now"), off("Off")]).toEqual([true, true, true]);
  }, 60_000);
});

describe("how far a walk is, at a page's top", () => {
  it.each([
    ["paper", "desktop", 1],
    ["ohmarchy", "desktop", 1],
    ["paper", "phone", 1.5],
  ] as const)(
    "in %s on a %s at Text size %s: small dots a step apart, done in ink, the one it is in hot, those ahead hollow; the numeral before them",
    async (face, device, zoom) => {
      const seen = await drawn(
        <div style={{ height: "100vh" }}>
          <Page
            back={<Button kind="quiet" icon="back" label="Zurück" />}
            aside={<StepDots label="Schritt 2 von 5, Postfach, 2 von 3" steps={5} at={1} sub="2/3" />}
            acts={<Button size="l">Weiter</Button>}
          >
            <Sentence size="xl">Meine Post liegt bei einem Anbieter</Sentence>
          </Page>
        </div>,
        () => {
          const zoomed = parseFloat(document.documentElement.style.zoom) || 1;
          const mark = document.querySelector("[role='img']")!;
          const dots = [...mark.children];
          const boxes = dots.map((d) => d.getBoundingClientRect());
          const token = (css: string) => {
            const probe = document.createElement("i");
            probe.style.cssText = css;
            document.querySelector(".oh-root")!.append(probe);
            const cs = getComputedStyle(probe);
            return { colour: cs.backgroundColor, tall: probe.getBoundingClientRect().height };
          };
          const numeral = [...document.querySelectorAll("[aria-hidden='true']")].find(
            (el) => el.textContent === "2/3",
          )!;
          return {
            zoomed,
            size: boxes.map((b) => [b.width / zoomed, b.height / zoomed]),
            gaps: boxes.slice(1).map((b, i) => (b.left - boxes[i]!.right) / zoomed),
            grounds: dots.map((d) => getComputedStyle(d).backgroundColor),
            ink: token("background:var(--ink)").colour,
            hot: token("background:var(--hot)").colour,
            step: token("display:block;height:var(--s2)").tall / zoomed,
            numeralBefore: numeral.getBoundingClientRect().right <= boxes[0]!.left,
            numeralSize: getComputedStyle(numeral).fontSize,
            meta: getComputedStyle(document.documentElement).getPropertyValue("--t-meta").trim(),
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        },
        { face, device, zoom, lang: "de" },
      );
      expect(seen.size).toHaveLength(5);
      for (const side of seen.size.flat()) expect(side).toBeCloseTo(8, 1);
      for (const gap of seen.gaps) expect(Math.abs(gap - seen.step)).toBeLessThan(0.1);
      expect(seen.grounds).toEqual([
        seen.ink,
        seen.hot,
        ...Array.from({ length: 3 }, () => "rgba(0, 0, 0, 0)"),
      ]);
      expect(seen.numeralBefore).toBe(true);
      expect(seen.sideways).toBe(0);
    },
    60_000,
  );
});

describe("what stands in a page's material", () => {
  it.each([
    ["paper", "light"],
    ["paper", "dark"],
    ["ohmarchy", "light"],
  ] as const)(
    "in %s %s: a field and a second button standing bare stand on the page's ground as the page's own do; on a sheet they stand on the sheet's",
    async (face, scheme) => {
      const seen = await drawn(
        <div style={{ height: "100vh" }}>
          <Page
            columns={2}
            material={
              <>
                <FieldStack>
                  <Field label="Host" value="" onChange={() => {}} />
                </FieldStack>
                <Button kind="two">Other</Button>
                <Sheet kind="plain">
                  <Field label="On a sheet" value="" onChange={() => {}} />
                  <Button kind="two">On a sheet</Button>
                </Sheet>
              </>
            }
            acts={<Button kind="two">Later</Button>}
          >
            <Sentence size="xl">My mail is with a host</Sentence>
          </Page>
        </div>,
        () => {
          const ground = (el: Element) => getComputedStyle(el).backgroundColor;
          const token = (name: string) => {
            const probe = document.createElement("i");
            probe.style.background = `var(${name})`;
            document.querySelector(".oh-root")!.append(probe);
            return ground(probe);
          };
          const [bare, onSheet] = [...document.querySelectorAll("input")].map(ground);
          const [other, sheetButton, later] = [...document.querySelectorAll("button")].map(ground);
          return {
            bare,
            onSheet,
            other,
            sheetButton,
            later,
            soft: token("--soft"),
            softSheet: token("--soft-sheet"),
          };
        },
        { entry: "mail", face, scheme },
      );
      expect(seen.soft).not.toBe(seen.softSheet);
      /* A second button stands on the page's ground in both faces. A field does on paper; ohmarchy's page is a
         window in the sheet's own tone, and a field on it is boxed in the soft sheet's, as the design draws it. */
      expect([seen.other, seen.later]).toEqual([seen.soft, seen.soft]);
      expect(seen.bare).toBe(face === "ohmarchy" ? seen.softSheet : seen.soft);
      expect([seen.onSheet, seen.sheetButton]).toEqual([seen.softSheet, seen.softSheet]);
    },
    60_000,
  );
});

describe("a form's fields, one under the other", () => {
  const form = (
    <div style={{ padding: "0 20px" }}>
      <FieldStack>
        <FieldPair>
          <Field label="IMAP-Server" value="imap.brennofen-zentrale.example" onChange={() => {}} />
          <Field label="Port" value="993" onChange={() => {}} />
        </FieldPair>
        <FieldPair>
          <Field label="SMTP-Server" value="smtp.brennofen-zentrale.example" onChange={() => {}} />
          <Field label="Port" value="465" onChange={() => {}} />
        </FieldPair>
        <Field label="Benutzername" value="" placeholder="E-Mail-Adresse" onChange={() => {}} />
      </FieldStack>
    </div>
  );
  it.each([
    ["desktop", 1],
    ["phone", 1],
    ["phone", 1.5],
  ] as const)(
    "on a %s at Text size %s: a step apart, a server with its port beside it, at most the design's measure wide, nothing outside the window",
    async (device, zoom) => {
      const seen = await drawn(
        form,
        () => {
          const box = (el: Element) => el.getBoundingClientRect();
          const stack = document.querySelector(".oh-root > div > div")!;
          const fields = [...document.querySelectorAll("input")].map((el) => box(el.closest("div")!));
          const probe = document.createElement("i");
          probe.style.cssText = "display:block;height:var(--s3)";
          document.querySelector(".oh-root")!.append(probe);
          const [host, port, smtp, , user] = fields as [DOMRect, DOMRect, DOMRect, DOMRect, DOMRect];
          return {
            step: box(probe).height,
            wide: box(stack).width,
            beside: [port.left - host.right, Math.abs(port.top - host.top)],
            portWide: port.width,
            under: [smtp.top - host.bottom, user.top - smtp.bottom],
            userWide: user.width,
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        },
        { device, zoom, lang: "de" },
      );
      const near = (a: number, b: number) => expect(Math.abs(a - b), `${a} for ${b}`).toBeLessThan(0.75);
      near(seen.beside[0]!, seen.step);
      near(seen.beside[1]!, 0);
      near(seen.under[0]!, seen.step);
      near(seen.under[1]!, seen.step);
      /* The design's measures: the stack 480 at most, the port 96, both in the page's own px under a Text size. */
      expect(seen.wide).toBeLessThanOrEqual(480 * zoom + 0.5);
      near(seen.portWide, 96 * zoom);
      near(seen.userWide, seen.wide);
      expect(seen.sideways).toBe(0);
    },
    60_000,
  );
});

describe("the tiles of a choice", () => {
  const tiles = (
    <div style={{ padding: "0 20px" }}>
      <ChoiceTiles
        label="E-Mail-Anbieter"
        value="microsoft"
        enter={{ value: "microsoft", keyHint: "↵" }}
        options={[
          { value: "gmail", label: "Gmail", dim: true },
          { value: "microsoft", label: "Microsoft" },
          { value: "icloud", label: "iCloud", dim: true },
          { value: "yahoo", label: "Yahoo", dim: true },
          { value: "fastmail", label: "Fastmail", dim: true },
          { value: "gmx", label: "GMX", dim: true },
          { value: "infomaniak", label: "Infomaniak", dim: true },
          { value: "other", label: "Anderer Anbieter (IMAP)", dim: true },
        ]}
      />
    </div>
  );
  /* The room is the page's material with its steps: 520 beside a sentence on a desktop, one page of 305 on the unfolded phone. */
  it.each([
    ["desktop", 1, 560, 4],
    ["phone", 1, 560, 2],
    ["phone", 1.5, 560, 2],
    ["fold", 1.5, 345, 2],
  ] as const)(
    "on a %s at Text size %s, in a room of at most %s: %s in a row, every word inside its tile, one that does not fit stepped back",
    async (device, zoom, room, across) => {
      const seen = await drawn(
        <div style={{ maxWidth: room }}>{tiles}</div>,
        () => {
          const buttons = [...document.querySelectorAll("button")];
          const boxes = buttons.map((b) => b.getBoundingClientRect());
          const inside = buttons.every((b) => {
            const word = b.querySelector("span")!.getBoundingClientRect();
            const own = b.getBoundingClientRect();
            return (
              word.left >= own.left - 0.5 &&
              word.right <= own.right + 0.5 &&
              b.scrollWidth <= b.clientWidth + 1
            );
          });
          const look = (el: Element) => {
            const cs = getComputedStyle(el);
            return [cs.backgroundColor, cs.color];
          };
          const probe = document.createElement("i");
          probe.style.cssText = "color:var(--ink2);height:var(--h-xl);display:block";
          document.querySelector(".oh-root")!.append(probe);
          return {
            across: boxes.filter((b) => Math.abs(b.top - boxes[0]!.top) < 1).length,
            widths: boxes.map((b) => Math.round(b.width)),
            inside,
            dim: look(buttons[0]!),
            ink2: getComputedStyle(probe).color,
            least: Math.min(...boxes.map((b) => b.height)),
            xl: probe.getBoundingClientRect().height,
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        },
        { device, zoom, lang: "de" },
      );
      expect(seen.across).toBe(across);
      expect(new Set(seen.widths).size).toBe(1);
      expect(seen.inside).toBe(true);
      expect(seen.dim).toEqual(["rgba(0, 0, 0, 0)", seen.ink2]);
      expect(seen.least).toBeGreaterThanOrEqual(seen.xl - 0.5);
      expect(seen.sideways).toBe(0);
    },
    60_000,
  );
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

describe("an empty place's one answer, in ink where the place says so", () => {
  it.each(["paper", "ohmarchy"] as const)(
    "in %s: said to be the view's one capsule it stands on the solid ground in the ground's own ink; left unsaid it is a second button",
    async (face) => {
      const got = await drawn(
        <>
          <div id="ink">
            <Empty
              mark="oh"
              label="6 decided"
              act={{ label: "Ohbox", kind: "ink", keyHint: "g o", onPress: () => {} }}
            />
          </div>
          <div id="two">
            <Empty label="No drafts" act={{ label: "Write", onPress: () => {} }} />
          </div>
        </>,
        () => {
          const token = (name: string, as: "color" | "backgroundColor") => {
            const probe = document.createElement("i");
            probe.style[as] = `var(${name})`;
            document.querySelector(".oh-root")!.append(probe);
            const seen = getComputedStyle(probe)[as];
            probe.remove();
            return seen;
          };
          const act = (id: string) => getComputedStyle(document.querySelector(`#${id} button`)!);
          const key = document.querySelector("#ink kbd")!;
          return {
            ink: [act("ink").backgroundColor, act("ink").color],
            solid: [token("--solid", "backgroundColor"), token("--on-solid", "color")],
            two: act("two").backgroundColor,
            keyInTheCapsule: key.parentElement === document.querySelector("#ink button"),
          };
        },
        { face },
      );
      expect(got.ink).toEqual(got.solid);
      expect(got.two).not.toBe(got.solid[0]);
      expect(got.keyInTheCapsule).toBe(true);
    },
    60_000,
  );
});

describe("the square a camera stands in", () => {
  it.each([
    ["paper", "phone"],
    ["ohmarchy", "phone"],
    ["paper", "desktop"],
  ] as const)(
    "in %s on a %s: a square as wide as its room up to its own measure, four corners a fifth in from its edges, and the hot dot in its upper right only while the camera looks",
    async (face, device) => {
      const got = await drawn(
        <>
          <div id="live">
            <CameraSquare state="live" label="Camera" />
          </div>
          <div id="off">
            <CameraSquare state="off" label="Camera off" />
          </div>
          <div id="narrow" style={{ width: 200 }}>
            <CameraSquare state="live" label="Camera" />
          </div>
        </>,
        () => {
          const token = (name: string) => {
            const probe = document.createElement("i");
            probe.style.backgroundColor = `var(${name})`;
            document.querySelector(".oh-root")!.append(probe);
            const seen = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return seen;
          };
          const read = (id: string) => {
            const room = document.getElementById(id)!;
            const square = room.querySelector('[role="img"]')!;
            const box = square.getBoundingClientRect();
            const marks = [...square.children].map((mark) => {
              const r = mark.getBoundingClientRect();
              return {
                dot: mark.getAttribute("data-kind") !== null,
                /* How far in from the square's nearer edges, as shares of its side. */
                in: [
                  Math.min(r.left - box.left, box.right - r.right) / box.width,
                  Math.min(r.top - box.top, box.bottom - r.bottom) / box.height,
                ].map((share) => Math.round(share * 100)),
                size: [Math.round(r.width), Math.round(r.height)],
                right: r.left + r.width / 2 > box.left + box.width / 2,
                upper: r.top + r.height / 2 < box.top + box.height / 2,
              };
            });
            return {
              side: [Math.round(box.width), Math.round(box.height)],
              room: Math.round(room.getBoundingClientRect().width),
              ground: getComputedStyle(square).backgroundColor,
              corners: marks.filter((mark) => !mark.dot),
              dots: marks.filter((mark) => mark.dot),
            };
          };
          return {
            live: read("live"),
            off: read("off"),
            narrow: read("narrow"),
            solid: token("--solid"),
            quiet: token("--off"),
          };
        },
        { face, device },
      );
      const { live, off, narrow } = got;
      /* A square, never wider than its own measure and never wider than its room. */
      expect(live.side[0]).toBe(live.side[1]);
      expect(live.side[0]).toBe(Math.min(live.room, 342));
      expect(narrow.side).toEqual([200, 200]);
      expect(off.side).toEqual(live.side);
      expect([live.ground, off.ground]).toEqual([got.solid, got.quiet]);
      /* Four corners, one in each quarter, each 22 hundredths in from its two edges. */
      for (const state of [live, off, narrow]) {
        expect(state.corners).toHaveLength(4);
        expect(state.corners.map((c) => c.in)).toEqual(Array(4).fill([22, 22]));
        expect(new Set(state.corners.map((c) => `${c.right}${c.upper}`)).size).toBe(4);
        expect(state.corners.map((c) => c.size)).toEqual(Array(4).fill([32, 32]));
      }
      expect(live.dots.map((d) => [d.size, d.right, d.upper])).toEqual([[[10, 10], true, true]]);
      expect(off.dots).toEqual([]);
    },
    60_000,
  );
});

describe("a plan among the plans, on a sheet of settings", () => {
  it.each([
    ["paper", "desktop"],
    ["ohmarchy", "desktop"],
    ["paper", "phone"],
  ] as const)(
    "in %s on a %s: each plan is a line of the sheet as high as the sheet's lines, its mark 18 wide and filled only on the taken plan, its figure ending the line; beside a pointer what it holds stands on the name's line, under a finger under it",
    async (face, device) => {
      const got = await drawn(
        <SettingsSheet title="Plans">
          <RadioLines
            kind="sheet"
            label="Plans"
            value="plus"
            options={[
              { value: "solo", label: "Solo", note: "2 mailboxes · 1,000 credits · 2 GB", figure: "$9" },
              {
                value: "plus",
                label: "Plus",
                tag: "Your plan",
                note: "5 mailboxes · 2,000 credits · 5 GB",
                figure: "$15",
              },
            ]}
          />
          <SettingLine label="Renews" value="Thu 10 Dec" onPress={() => {}} />
        </SettingsSheet>,
        () => {
          const probe = document.createElement("i");
          probe.style.cssText = "display:block;height:var(--h-l)";
          document.querySelector(".oh-root")!.append(probe);
          const least = probe.getBoundingClientRect().height;
          probe.remove();
          const pressed = document.querySelector('[role="group"]')!.getBoundingClientRect();
          const lines = [...document.querySelectorAll('[role="radio"]')].map((line) => {
            const box = line.getBoundingClientRect();
            const mark = line.querySelector('[aria-hidden="true"]')!;
            const m = mark.getBoundingClientRect();
            const [word, note, figure] = ["span", "small", "b"].map((tag) =>
              line.querySelector(tag)!.getBoundingClientRect(),
            ) as [DOMRect, DOMRect, DOMRect];
            const pad = parseFloat(getComputedStyle(line).paddingRight);
            return {
              high: Math.round(box.height * 10) / 10,
              asThePressedLine: [box.left - pressed.left, box.right - pressed.right].map((v) =>
                Math.round(v),
              ),
              mark: [Math.round(m.width), Math.round(m.height)],
              filled: getComputedStyle(mark).backgroundColor !== "rgba(0, 0, 0, 0)",
              figureEnds: Math.round(box.right - pad - figure.right),
              noteUnder: note.top >= word.bottom - 0.5,
              noteBeside: note.left >= word.right - 0.5 && note.right <= figure.left + 0.5,
              heavy: Number(getComputedStyle(line.querySelector("span")!).fontWeight),
            };
          });
          return { lines, least: Math.round(least * 10) / 10 };
        },
        { entry: "mail", face, device },
      );
      const [solo, plus] = got.lines as [(typeof got.lines)[number], (typeof got.lines)[number]];
      for (const line of got.lines) {
        expect(line.asThePressedLine).toEqual([0, 0]);
        expect(line.mark).toEqual([18, 18]);
        expect(line.figureEnds).toBe(0);
        expect([line.noteBeside, line.noteUnder]).toEqual(device === "phone" ? [false, true] : [true, false]);
      }
      if (device !== "phone") expect([solo.high, plus.high]).toEqual([got.least, got.least]);
      else expect(solo.high).toBeGreaterThan(got.least);
      expect([solo.filled, plus.filled]).toEqual([false, true]);
      expect(plus.heavy).toBeGreaterThan(solo.heavy);
    },
    60_000,
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

describe("a rule whose place has a long name, under a finger", () => {
  const rule = (
    <div style={{ padding: "0 16px" }}>
      <RuleLine
        who="rechnung@brennofen-zentrale.example"
        goes={
          <>
            geht nach <Slot label="Ort wählen">Rechnungen und Belege des Brennofen-Zentrallagers</Slot>
          </>
        }
        origin="Entscheid im Screener · 14 Nachrichten"
        act={
          <Button kind="quiet" size="s">
            Aufheben
          </Button>
        }
      />
    </div>
  );
  it.each([
    ["paper", 1],
    ["paper", 1.5],
    ["ohmarchy", 1.5],
  ] as const)(
    "in %s on a phone at Text size %s: the place's name folds inside the sentence's column and nothing leaves the window",
    async (face, zoom) => {
      const seen = await drawn(
        rule,
        () => {
          const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
          const [sentence, slot, act] = [
            ".oh-ruleline-sentence",
            "button[aria-label='Ort wählen']",
            "button:not([aria-label])",
          ].map(box);
          const line = parseFloat(
            getComputedStyle(document.querySelector(".oh-ruleline-sentence")!).lineHeight,
          );
          return {
            sideways: document.documentElement.scrollWidth - innerWidth,
            inColumn: slot!.left >= sentence!.left - 1 && slot!.right <= sentence!.right + 1,
            beforeAct: slot!.right <= act!.left + 1,
            lines: Math.round(slot!.height / line),
          };
        },
        { entry: "mail", face, zoom, device: "phone", lang: "de" },
      );
      expect(seen.sideways).toBe(0);
      expect([seen.inColumn, seen.beforeAct]).toEqual([true, true]);
      /* It did fold: the name is longer than the column at either size. */
      expect(seen.lines).toBeGreaterThanOrEqual(2);
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

describe("the reading column on one column", () => {
  it("draws the way back on a phone as a capsule first in its bar, whole up to six tenths of the bar, then cut; on a desktop the bar is not drawn", async () => {
    const column = (word: string) => (
      <div style={{ display: "flex", flexDirection: "column", height: 300 }}>
        <Sheet kind="reading" label="Conversation" back={{ word }} top={<i id="beside">beside</i>}>
          <p>The first letter</p>
        </Sheet>
      </div>
    );
    const read = () => {
      const button = document.querySelector<HTMLElement>('[role="region"] button')!;
      const [b, bar] = [
        button.getBoundingClientRect(),
        button.parentElement!.parentElement!.getBoundingClientRect(),
      ];
      const word = [...button.children].find((el) => el.textContent)!;
      return {
        shown: b.width > 0,
        height: b.height,
        left: b.left - bar.left,
        share: b.width / bar.width,
        cut: word.scrollWidth > word.clientWidth,
        first: document.getElementById("beside")!.getBoundingClientRect().left >= b.right,
        hit: document.elementFromPoint(b.left + 10, b.top - 6) === button,
      };
    };
    const short = await drawn(column("Ohbox"), read, { entry: "mail", device: "phone" });
    expect(short).toMatchObject({ shown: true, height: 40, cut: false, first: true, hit: true });
    expect(short.left).toBeGreaterThan(0);
    for (const zoom of [1, 1.5]) {
      const long = await drawn(column("Posteingang für Benachrichtigungen und Bestätigungen"), read, {
        entry: "mail",
        device: "phone",
        lang: "de",
        zoom,
      });
      expect(long).toMatchObject({ shown: true, cut: true, first: true });
      expect(long.share).toBeLessThanOrEqual(0.6 + 0.005);
    }
    expect((await drawn(column("Ohbox"), read, { entry: "mail", device: "desktop" })).shown).toBe(false);
  });
});

describe("a letter being written", () => {
  const frame = { label: "New message", head: <p>head</p>, foot: { label: "Add to the message" } };
  /** Where the line that starts with each of `starts` begins, and how wide the page had to scroll. */
  const lines = (starts: readonly string[]) => {
    const tops = new Map<string, DOMRect>();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const start = starts.find((w) => (node!.textContent ?? "").startsWith(w));
      if (!start) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      tops.set(start, range.getBoundingClientRect());
    }
    return starts.map((w) => {
      const r = tops.get(w);
      return r ? { top: r.top, left: r.left } : { top: Number.NaN, left: Number.NaN };
    });
  };

  it.each(["paper", "ohmarchy"] as const)(
    "in %s: a list between lines of text has no gap of its own over or under it, so an empty line is the only air; before a quote it keeps the blocks' own gap",
    async (face) => {
      const L = letterText;
      const got = await drawn(
        <Composer {...frame}>
          <div className={L.text}>
            <p className={L.paragraph}>
              Text
              <br />
              <br />
            </p>
            <ul id="between" className={L.bullets}>
              <li className={L.item}>
                <p className={L.paragraph}>One</p>
              </li>
              <li className={L.item}>
                <p className={L.paragraph}>Two</p>
              </li>
            </ul>
            <p className={L.paragraph}>
              <br />
              After
            </p>
            <ol id="before-quote" className={L.numbers}>
              <li className={L.item}>
                <p className={L.paragraph}>Three</p>
              </li>
            </ol>
            <blockquote className={L.quote}>
              <p className={L.paragraph}>Quoted</p>
            </blockquote>
          </div>
        </Composer>,
        () => {
          const box = (el: Element) => el.getBoundingClientRect();
          const between = document.getElementById("between")!;
          const quoteList = document.getElementById("before-quote")!;
          const gap = document.createElement("i");
          gap.style.cssText = "display:block;height:var(--oh-lettertext-gap)";
          between.parentElement!.append(gap);
          const own = box(gap).height;
          gap.remove();
          const items = [...between.children].map(box);
          return {
            over: Math.round((box(between).top - box(between.previousElementSibling!).bottom) * 100) / 100,
            under: Math.round((box(between.nextElementSibling!).top - box(between).bottom) * 100) / 100,
            items: Math.round((items[1]!.top - items[0]!.bottom) * 100) / 100,
            beforeQuote:
              Math.round((box(quoteList.nextElementSibling!).top - box(quoteList).bottom) * 100) / 100,
            own,
          };
        },
        { entry: "mail", face },
      );
      expect([got.over, got.under, got.items]).toEqual([0, 0, 0]);
      expect(got.own).toBeGreaterThan(0);
      expect(got.beforeQuote).toBe(got.own);
    },
    60_000,
  );

  it.each([
    ["the editor's root", "rich"],
    ["a plain text box", "plain"],
  ] as const)(
    "the box a screen reader calls the text is the padded one, where it is %s: 12 over and under its words and 16 at their sides, as tall as the text's least, and the room around it holds none of its own",
    async (_what, kind) => {
      const got = await drawn(
        <Composer {...frame}>
          {/* The app's editor stands its root in a box of its own, as an editor library does. */}
          <div>
            {kind === "rich" ? (
              <div
                id="text"
                className={letterText.text}
                role="textbox"
                aria-multiline="true"
                aria-label="Message"
              >
                <p className={letterText.paragraph}>Hello</p>
              </div>
            ) : (
              <textarea id="text" className={letterText.plain} aria-label="Message" defaultValue="Hello" />
            )}
          </div>
        </Composer>,
        () => {
          const text = document.getElementById("text")!;
          const room = text.parentElement!.parentElement!;
          const [t, r] = [text.getBoundingClientRect(), room.getBoundingClientRect()];
          const pads = (el: Element) => {
            const cs = getComputedStyle(el);
            return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
          };
          return {
            text: pads(text),
            room: pads(room),
            same: [t.left - r.left, t.top - r.top, t.width - r.width].map((v) => Math.round(v)),
            least: [Math.round(t.height), parseFloat(getComputedStyle(room).minHeight)],
          };
        },
        { entry: "mail" },
      );
      expect(got.text).toEqual(["12px", "16px", "12px", "16px"]);
      expect(got.room).toEqual(["0px", "0px", "0px", "0px"]);
      expect(got.same).toEqual([0, 0, 0]);
      expect(got.least[1]).toBeGreaterThan(100);
      expect(got.least[0]).toBe(got.least[1]);
    },
    60_000,
  );

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: a list stands on the text's own lines, one empty line from the text around it; a quote and code keep air of their own",
    async (face, device, zoom) => {
      const L = letterText;
      const item = (words: string) => (
        <li className={L.item}>
          <p className={L.paragraph}>{words}</p>
        </li>
      );
      /* What an editor holds after lines were pasted with two lists: an invented letter, each line short enough to
         stay one line on a phone at the largest Text size. */
      const letter = (
        <Composer {...frame}>
          <div className={L.text}>
            <p className={L.paragraph}>
              Hello all
              <br />
              <br />
              Third quarter.
              <br />
              Could you look?
              <br />
              <br />
            </p>
            <ul className={L.bullets}>
              {item("Entries numbered.")}
              {item("Transfers booked.")}
              {item("Bank agrees.")}
            </ul>
            <p className={L.paragraph}>
              <br />
              Figures:
            </p>
            <ol className={L.numbers}>
              {item("L303: 100.00")}
              {item("L400: 20.00")}
            </ol>
            <p className={L.paragraph}>
              <br />
              Question: in full?
              <br />
              Anna
            </p>
            <blockquote className={L.quote}>
              <p className={L.paragraph}>Quoted line.</p>
            </blockquote>
            <p className={L.paragraph}>After it.</p>
            <pre className={L.codeBlock}>
              <code>code line</code>
            </pre>
            <p className={L.paragraph}>
              Then <code className={L.code}>inline</code> and{" "}
              <a className={L.link} href="https://lichtgrat.example">
                a link
              </a>
              .
            </p>
          </div>
        </Composer>
      );
      const starts = [
        "Third",
        "Could",
        "Entries",
        "Transfers",
        "Bank",
        "Figures",
        "L303",
        "L400",
        "Question",
        "Anna",
        "Quoted",
        "After it",
        "code line",
      ] as const;
      const [
        third,
        could,
        entries,
        transfers,
        bank,
        figures,
        l303,
        l400,
        question,
        anna,
        quoted,
        after,
        code,
      ] = await opened(letter, { entry: "mail", face, device, zoom }, (tab) =>
        tab.evaluate(lines, [...starts]),
      );
      const pitch = could!.top - third!.top;
      const apart = (from: { top: number }, to: { top: number }) => (to.top - from.top) / pitch;
      expect(pitch).toBeGreaterThan(10);
      /* An empty line between: the next text starts two lines on. */
      expect(apart(could!, entries!)).toBeCloseTo(2, 1);
      expect(apart(bank!, figures!)).toBeCloseTo(2, 1);
      expect(apart(l400!, question!)).toBeCloseTo(2, 1);
      /* Items one line apart, and a list right after a line on the next line. */
      expect(apart(entries!, transfers!)).toBeCloseTo(1, 1);
      expect(apart(transfers!, bank!)).toBeCloseTo(1, 1);
      expect(apart(l303!, l400!)).toBeCloseTo(1, 1);
      expect(apart(figures!, l303!)).toBeCloseTo(1, 1);
      /* A list is set in from the text; a quote too; each has its mark or its line. */
      expect(entries!.left).toBeGreaterThan(third!.left + 8);
      expect(quoted!.left).toBeGreaterThan(third!.left + 8);
      /* A quote and a code block stand off the lines: more than a line from the text before them. */
      expect(apart(anna!, quoted!)).toBeGreaterThan(1.2);
      expect(apart(after!, code!)).toBeGreaterThan(1.2);
    },
  );

  it("draws a list's marks, a quote's line, code on its own ground and a link underlined, from its names alone", async () => {
    const L = letterText;
    const read = () => {
      const of = (id: string) => getComputedStyle(document.getElementById(id)!);
      const ground = of("ground").backgroundColor;
      return {
        bullets: of("ul").listStyleType,
        numbers: of("ol").listStyleType,
        quote: of("quote").boxShadow !== "none" && of("quote").color !== of("text").color,
        code: of("code").backgroundColor !== ground && of("code").fontFamily !== of("text").fontFamily,
        block: of("pre").backgroundColor !== ground && of("pre").whiteSpace,
        link: of("link").textDecorationLine,
        plain: [
          of("plain").borderTopWidth,
          of("plain").backgroundColor,
          of("plain").fontSize,
          of("text").fontSize,
        ],
      };
    };
    for (const face of ["paper", "ohmarchy"] as const) {
      const got = await drawn(
        <Composer {...frame}>
          <div className={L.text} id="text">
            <i id="ground" />
            <ul className={L.bullets} id="ul" />
            <ol className={L.numbers} id="ol" />
            <blockquote className={L.quote} id="quote" />
            <code className={L.code} id="code" />
            <pre className={L.codeBlock} id="pre" />
            <a className={L.link} id="link" href="https://lichtgrat.example" />
          </div>
          <textarea className={L.plain} id="plain" defaultValue="Plain words" />
        </Composer>,
        read,
        { entry: "mail", face },
      );
      expect(got).toMatchObject({
        bullets: "disc",
        numbers: "decimal",
        quote: true,
        code: true,
        link: "underline",
      });
      expect(got.block).toBe("pre-wrap");
      /* A plain text box wears the text's own type, with no line and no ground of its own. */
      expect(got.plain[0]).toBe("0px");
      expect(got.plain[1]).toBe("rgba(0, 0, 0, 0)");
      expect(got.plain[2]).toBe(got.plain[3]);
    }
  });

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: the words for a text not yet written stand where its first line will stand, and a press there reaches the text",
    async (face, device, zoom) => {
      const got = await drawn(
        <>
          <Composer {...frame} placeholder="Schreib deine Nachricht an die Töpferwerkstatt">
            <div id="empty" style={{ minHeight: 40 }} />
          </Composer>
          <Composer {...frame}>
            <div>Schreib deine Nachricht an die Töpferwerkstatt</div>
          </Composer>
        </>,
        () => {
          /* The words are drawn, not written: no reader of text finds them, and they are measured by their box. */
          const drawnWords = document.querySelector<HTMLElement>("[data-words]")!;
          const typed = [...document.querySelectorAll("div")].find(
            (el) => el.children.length === 0 && (el.textContent ?? "").startsWith("Schreib"),
          )!;
          const within = (el: Element) => {
            const [own, box] = [el.getBoundingClientRect(), el.closest("section")!.getBoundingClientRect()];
            return { left: own.left - box.left, top: own.top - box.top, right: box.right - own.right, own };
          };
          const [ph, text] = [within(drawnWords), within(typed)];
          const at = document.elementFromPoint(ph.own.left + 4, ph.own.top + 4)!;
          const said = getComputedStyle(drawnWords, "::before").content;
          return {
            count: document.body.textContent!.split("Schreib").length - 1,
            said,
            dx: ph.left - text.left,
            dy: ph.top - text.top,
            inside: ph.left >= 0 && ph.right >= 0,
            hitsThePlaceholder: drawnWords.contains(at),
            hidden: drawnWords.closest("[aria-hidden='true']") !== null,
            scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      /* Written once, in the letter that holds it as text; drawn once, from the words handed. */
      expect(got.count).toBe(1);
      expect(got.said).toBe('"Schreib deine Nachricht an die Töpferwerkstatt"');
      expect(Math.abs(got.dx)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got.dy)).toBeLessThanOrEqual(0.5);
      expect(got).toMatchObject({ inside: true, hitsThePlaceholder: false, hidden: true, scrolls: false });
    },
  );

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: a formatted signature's two ways stand clear of its words and inside the letter",
    async (face, device, zoom) => {
      const got = await drawn(
        <Composer
          {...frame}
          signature={{
            label: "Signatur",
            text: "Mila Brunner",
            formatted: (
              <p id="signed">
                <strong>Mila Brunner</strong>, Töpferwerkstatt Lichtgrat an der Stadthausstrasse in Winterthur
              </p>
            ),
            asText: { word: "Als Text bearbeiten", label: "Als Text bearbeiten: die Formatierung entfällt" },
            remove: { label: "Signatur entfernen" },
          }}
        >
          Guten Tag
        </Composer>,
        () => {
          const box = document.querySelector("section")!.getBoundingClientRect();
          const words = document.getElementById("signed")!.getBoundingClientRect();
          const ways = [...document.querySelectorAll('[role="group"] ~ * button')].map((b) =>
            b.getBoundingClientRect(),
          );
          const over = (a: DOMRect, b: DOMRect) =>
            a.left < b.right - 0.5 &&
            b.left < a.right - 0.5 &&
            a.top < b.bottom - 0.5 &&
            b.top < a.bottom - 0.5;
          return {
            ways: ways.length,
            clear: ways.every((w) => !over(w, words)) && !over(ways[0]!, ways[1]!),
            inside: ways.every((w) => w.right <= box.right + 0.5 && w.left >= box.left - 0.5),
            wordsWide: words.width,
            scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      expect(got).toMatchObject({ ways: 2, clear: true, inside: true, scrolls: false });
      expect(got.wordsWide).toBeGreaterThan(120);
    },
  );
});

describe("what is fixed at a glass's foot, where the host says what the glass holds", () => {
  const stand = (glass: string) => (
    <>
      <style>{`:root{${glass}}`}</style>
      <div id="column" style={{ position: "relative", height: 400 }}>
        <JumpBack label="Nach oben" to="top" shown />
      </div>
      <Menu open onClose={() => {}} label="Mehr">
        <MenuItem onPress={() => {}}>Als gelesen markieren</MenuItem>
        <MenuItem onPress={() => {}}>Später</MenuItem>
      </Menu>
    </>
  );
  const read = () => {
    const column = document.getElementById("column")!.getBoundingClientRect();
    const jump = document.querySelector("#column button")!.getBoundingClientRect();
    const sheet = document.querySelector("[role='menu']")!.getBoundingClientRect();
    return {
      jump: Math.round((column.bottom - jump.bottom) * 10) / 10,
      sheet: Math.round((window.innerHeight - sheet.bottom) * 10) / 10,
      sheetTop: sheet.top,
    };
  };
  const phone = { entry: "base", device: "phone" } as const;

  it("with no word from the host, and with an inset no larger than their own margins, they keep their margins", async () => {
    const own = await drawn(stand(""), read, phone);
    expect([own.jump, own.sheet]).toEqual([12, 8]);
    expect(await drawn(stand("--sys-b:8px"), read, phone)).toEqual(own);
  });

  it("over a system's bar each keeps the bar's height, never its margin added to it", async () => {
    const bar = await drawn(stand("--sys-b:34px"), read, phone);
    expect([bar.jump, bar.sheet]).toEqual([34, 34]);
  });

  it("while a keyboard is up the bar counts for nothing, and a sheet from the foot stands on the keys, whole inside what is left", async () => {
    const keys = await drawn(stand("--sys-b:0px;--kb:300px"), read, phone);
    expect([keys.jump, keys.sheet]).toEqual([12, 308]);
    expect(keys.sheetTop).toBeGreaterThanOrEqual(8);
  });
});

describe("the reading column's foot at a glass's edge", () => {
  const column = (inset?: string) => (
    <div
      style={{ display: "flex", flexDirection: "column", height: 420, ["--oh-inset-foot" as string]: inset }}
    >
      <Sheet
        kind="reading"
        label="New message"
        foot={
          <ActionPanel label="Message" items={[{ id: "send", label: "Send", icon: "send", kind: "ink" }]} />
        }
      >
        <p>Hello</p>
      </Sheet>
    </div>
  );
  const read = () => {
    const region = document.querySelector('[role="region"]')!;
    const bar = region.querySelector('[role="toolbar"]')!.getBoundingClientRect();
    const scroll = region.querySelector<HTMLElement>('[tabindex="-1"]')!;
    return {
      over: Math.round((region.getBoundingClientRect().bottom - bar.bottom) * 10) / 10,
      room: Number.parseFloat(getComputedStyle(scroll).paddingBottom),
    };
  };

  it.each(["phone", "fold", "desktop"] as const)(
    "on a %s: the panel keeps the larger of its own margin and the inset the system reports, never the two added, and the letter's run ends that much later",
    async (device) => {
      const at = { entry: "mail", device } as const;
      const own = await drawn(column(), read, at);
      /* No system bar, and a keyboard up (the host says the inset counts for nothing): its own margin. */
      expect(own.over).toBeGreaterThanOrEqual(16);
      expect(await drawn(column("0px"), read, at)).toEqual(own);
      /* An inset no larger than the margin changes nothing. */
      expect(await drawn(column("8px"), read, at)).toEqual(own);
      expect(await drawn(column("16px"), read, at)).toEqual(own);
      /* A system's bar of 34: the foot stands 34 over the edge where it stood 16, not 34 more. */
      const bar = await drawn(column("34px"), read, at);
      expect(bar.over - own.over).toBeCloseTo(18, 1);
      expect(bar.room - own.room).toBeCloseTo(18, 1);
    },
  );
});

describe("a place's sections in its list's head", () => {
  const sections = (fit?: "tighter") => (
    <Seg
      label="Bereiche"
      value="waiting"
      fit={fit}
      options={[
        { value: "waiting", label: "Wartend", count: 6 },
        { value: "screened", label: "Aussortiert", count: 2 },
        { value: "spam", label: "Spam", count: 1 },
      ]}
    />
  );
  const read = () => {
    const head = document.querySelector("header")!;
    const box = head.getBoundingClientRect();
    const name = head.querySelector("h1")!.getBoundingClientRect();
    const group = head.querySelector("[role='group']")!;
    const track = group.getBoundingClientRect();
    const items = [...group.querySelectorAll("button")];
    const probe = (css: string) => {
      const el = document.createElement("i");
      el.style.cssText = `display:block;position:absolute;${css}`;
      head.append(el);
      const got = { h: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize };
      el.remove();
      return got;
    };
    const first = getComputedStyle(items[0]!);
    return {
      head: box.height,
      name: name.height,
      line: probe("height:calc(var(--head) - var(--s2))").h,
      phoneLine: probe("height:calc(var(--head) - var(--s3) - var(--s1))").h,
      beside: track.top < name.bottom && track.bottom > name.top,
      under: track.top >= name.bottom - 0.5,
      trackWide: track.width,
      /* A box is read in the window's px, a style's length in the page's own. */
      room:
        box.width -
        (parseFloat(getComputedStyle(head).paddingLeft) + parseFloat(getComputedStyle(head).paddingRight)) *
          (parseFloat(getComputedStyle(document.documentElement).zoom) || 1),
      items: items.map((b) => Math.round(b.getBoundingClientRect().height * 10) / 10),
      font: first.fontSize,
      meta: probe("font-size:var(--t-meta)").font,
      sides: [first.paddingLeft, first.paddingRight],
      inside: items.every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
      }),
      scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  };

  it.each(["paper", "ohmarchy"] as const)(
    "in %s with a pointer: the name keeps a place's first line, the sections stand beside it a size smaller, and in a narrow list they go under it while the name's line stays",
    async (face) => {
      const at = { entry: "mail", face } as const;
      const wide = await drawn(
        <div style={{ width: 420 }}>
          <ListHead title="Screener" hot sections={sections()} />
        </div>,
        read,
        at,
      );
      expect(wide.beside).toBe(true);
      expect(wide.name).toBeCloseTo(wide.line, 1);
      /* The reference (screener.css, the head): 28 high, 10 at the sides, the meta size. */
      expect(wide.items).toEqual([28, 28, 28]);
      expect(wide.sides).toEqual(["10px", "10px"]);
      expect(wide.font).toBe(wide.meta);
      expect(wide.inside).toBe(true);
      /* A list dragged narrower than its sections: the kit has measured them to their closest stand. */
      const narrow = await drawn(
        <div style={{ width: 240 }}>
          <ListHead title="Screener" hot sections={sections("tighter")} />
        </div>,
        read,
        at,
      );
      expect(narrow.under).toBe(true);
      expect(narrow.name).toBeCloseTo(wide.name, 1);
      expect(narrow.inside).toBe(true);
    },
    60_000,
  );

  it.each([
    ["paper", "phone", 1],
    ["ohmarchy", "phone", 1],
    ["paper", "fold", 1],
    ["paper", "phone", 1.5],
    ["ohmarchy", "phone", 1.5],
  ] as const)(
    "in %s on a %s at Text size %s: under a finger the sections are the head's second line, as wide as the list, each a finger high and inside it",
    async (face, device, zoom) => {
      const got = await drawn(
        <div style={{ width: device === "fold" ? 300 : undefined }}>
          <ListHead title="Screener" hot sections={sections(zoom === 1.5 ? "tighter" : undefined)} />
        </div>,
        read,
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      expect(got.under).toBe(true);
      expect(got.name / zoom).toBeCloseTo((device === "phone" ? got.phoneLine : got.line) / zoom, 1);
      expect(got.trackWide).toBeCloseTo(got.room, 0);
      for (const high of got.items) expect(high / zoom).toBeGreaterThanOrEqual(44);
      expect(got.inside).toBe(true);
      expect(got.scrolls).toBe(false);
    },
    60_000,
  );
});

describe("the reading column's head, a sentence that is the control", () => {
  const head = (who: string, address: string, place: string, reason: string) => (
    <ReadingHead
      sentence={
        <>
          <SentencePart>{who}</SentencePart>{" "}
          <SentencePart>
            geht in <Slot>{place}</Slot>
            <Dot kind="hot" />
          </SentencePart>
        </>
      }
      lines={
        <>
          <ReadingLine sign="ok" person={{ label: address }} word={{ text: "Bestätigt" }}>
            <Slot>dieser Absender</Slot>
            <Tag>Abmelden angeboten</Tag>
          </ReadingLine>
          <ReadingLine sign="spark" figure={{ text: "92%", title: "Sicherheit" }} why>
            {reason}
          </ReadingLine>
        </>
      }
    />
  );
  const read = () => {
    const banner = document.querySelector("#sentence header")!;
    const plain = document.querySelector("#subject header")!;
    const box = banner.getBoundingClientRect();
    const [sentence, who, why] = [...banner.children].map((el) => el.getBoundingClientRect());
    const texts: DOMRect[] = [];
    const walk = document.createTreeWalker(banner, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (!(node.textContent ?? "").trim() || node.parentElement!.closest(".oh-vh")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      texts.push(...range.getClientRects());
    }
    const style = (el: Element) => getComputedStyle(el);
    const lines = [...banner.children];
    const parts = [...banner.querySelectorAll(".oh-sentence-part")].map((p) => p.getBoundingClientRect());
    return {
      pads: [style(banner).padding, style(plain).padding],
      ground: [style(banner).backgroundColor, style(plain).backgroundColor],
      sentenceFont: [style(lines[0]!).fontSize, style(plain.firstElementChild!).fontSize],
      whoUnder: Math.round((who!.top - sentence!.bottom) * 10) / 10,
      whyUnder: Math.round((why!.top - who!.bottom) * 10) / 10,
      whySmaller: parseFloat(style(lines[2]!).fontSize) < parseFloat(style(lines[1]!).fontSize),
      sign: banner.querySelectorAll("svg").length,
      partsStacked: parts[1]!.top >= parts[0]!.bottom - 1,
      inside: texts.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
      controlsInside: [...banner.querySelectorAll("button")].every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
      }),
      scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  };
  /* As in its column: the head reaches over the column's ring on both sides. */
  const both = (who: string, address: string, place: string, reason: string) => (
    <div style={{ margin: "0 var(--ringw)" }}>
      <div id="sentence">{head(who, address, place, reason)}</div>
      <div id="subject">
        <ReadingHead subject="Glaze order #2291" names="Giulia Ferrari" people={[]} />
      </div>
    </div>
  );

  it.each(["paper", "ohmarchy"] as const)(
    "in %s with a pointer: it stands on the conversation's head's ground and sides, the sentence in the subject's face, who it is a step under it, why a size smaller under that",
    async (face) => {
      const got = await drawn(
        <div style={{ width: 740 }}>
          {both("Lena Kaufmann", "lena@atelier-eichspan.example", "Ohbox", "Eine persönliche Nachricht")}
        </div>,
        read,
        { entry: "mail", face },
      );
      /* The reference (the Screener's head on a desktop): beside and under them the two heads are one; over it
         the sentence keeps the head's own room, 9, where on paper a subject stands a step closer to the top, 5. */
      const [sentence, subject] = got.pads.map((pad) => pad.split(" "));
      expect(sentence!.slice(1)).toEqual(subject!.slice(1));
      expect([sentence![0], subject![0]]).toEqual(
        face === "paper" ? ["9px", "5px"] : [subject![0], subject![0]],
      );
      expect(got.ground[0]).toBe(got.ground[1]);
      expect(got.sentenceFont[0]).toBe(got.sentenceFont[1]);
      /* The reference (core's byline and the Screener's `why`): 8 under the sentence, then 4. */
      expect(got.whoUnder).toBe(8);
      expect(got.whyUnder).toBe(4);
      expect(got.whySmaller).toBe(true);
      expect(got.sign).toBe(2);
      expect(got.partsStacked).toBe(false);
      expect(got.inside && got.controlsInside).toBe(true);
    },
    60_000,
  );

  it.each([
    ["paper", 1],
    ["ohmarchy", 1],
    ["paper", 1.5],
    ["ohmarchy", 1.5],
  ] as const)(
    "in %s on a phone at Text size %s: a long sentence breaks between its two parts and every word and control stays inside the head",
    async (face, zoom) => {
      const got = await drawn(
        both(
          "Veranstaltungsbüro Winterthur",
          "veranstaltungen-anmeldung@makersfest-winterthur.example",
          "Aussortiert",
          "Eine Massensendung von einer Adresse, die du nie angeschrieben hast",
        ),
        read,
        { entry: "mail", face, device: "phone", zoom, lang: "de" },
      );
      expect(got.partsStacked).toBe(true);
      expect(got.inside).toBe(true);
      expect(got.controlsInside).toBe(true);
      expect(got.scrolls).toBe(false);
    },
    60_000,
  );
});

describe("words that are pressed, under a finger at Text size 1.5", () => {
  const row: RowProps = {
    who: "Töss Energie",
    address: "rechnung@toess-energie.example",
    people: [{ name: "Töss Energie", address: "rechnung@toess-energie.example" }],
    subject: "Ihre Oktober-Rechnung ist bereit",
    preview: "Ihre Rechnung für Oktober liegt bei.",
    when: "06:15",
  };
  it.each([
    ["paper", 1, "News"],
    ["paper", 1.5, "Choose"],
    ["paper", 1.5, "Aussortiert"],
    ["ohmarchy", 1.5, "Belege"],
  ] as const)(
    "in %s at Text size %s the place %s stands whole inside its chip, the chip inside its row, and the list does not scroll sideways",
    async (face, zoom, word) => {
      const got = await drawn(
        <Rows label="Wartend">
          <Row
            {...row}
            place={
              word === "Choose"
                ? { word, choose: { label: "Einen Ort wählen" } }
                : { word, accept: { label: `${word} annehmen` }, choose: { label: "Einen Ort wählen" } }
            }
          />
        </Rows>,
        () => {
          const chip = document.querySelector(".oh-row-beside .oh-row-place-word")!;
          const box = chip.getBoundingClientRect();
          /* The word's own letters: the arrow beside it is drawn, not written. */
          const range = document.createRange();
          range.selectNodeContents(chip.firstChild!);
          const words = [...range.getClientRects()].filter((r) => r.width > 0);
          const slot = document.querySelector(".oh-row-slot")!.getBoundingClientRect();
          const list = document.querySelector("[role='listbox']")!;
          return {
            wordsInside: words.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
            oneLine: new Set(words.map((r) => Math.round(r.top))).size === 1,
            chipInside: box.left >= slot.left - 0.5 && box.right <= slot.right + 0.5,
            listScrolls: list.scrollWidth > list.clientWidth,
            pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        {
          entry: "mail",
          face,
          device: "phone",
          zoom,
          lang: word === "News" || word === "Choose" ? "en" : "de",
        },
      );
      expect(got).toEqual({
        wordsInside: true,
        oneLine: true,
        chipInside: true,
        listScrolls: false,
        pageScrolls: false,
      });
    },
    60_000,
  );

  it.each([
    ["phone", undefined],
    ["fold", [719, 781]],
    ["foldl", [841, 673]],
  ] as const)(
    "on a %s a slot in a line narrower than its words folds them inside the line, and adds nothing to what the page scrolls",
    async (device, window) => {
      const got = await drawn(
        <div id="line" style={{ display: "flex", flexWrap: "wrap", gap: 4, width: 96 }}>
          <Slot>dieser Absender</Slot>
          <Slot>ganze Domain</Slot>
        </div>,
        () => {
          const line = document.getElementById("line")!.getBoundingClientRect();
          return [...document.querySelectorAll("button")].map((slot) => {
            const box = slot.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(slot);
            const words = [...range.getClientRects()].filter((r) => r.width > 0);
            return {
              inLine: box.left >= line.left - 0.5 && box.right <= line.right + 0.5,
              wordsInside: words.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
              scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            };
          });
        },
        { entry: "base", device, zoom: 1.5, lang: "de", window: window ? [...window] : undefined },
      );
      for (const slot of got) expect(slot).toEqual({ inLine: true, wordsInside: true, scrolls: false });
    },
    60_000,
  );

  it.each(["paper", "ohmarchy"] as const)(
    "in %s on a phone a refusal with its way folds its sentence inside the line, the way whole beside or under it",
    async (face) => {
      const got = await drawn(
        <RefusalLine way={{ label: "Erneut versuchen", onPress: () => {} }}>
          Weitere Absender konnten nicht geladen werden: Serververbindungsunterbrechung.
        </RefusalLine>,
        () => {
          const line = document.querySelector("[role='status']")!;
          const box = line.getBoundingClientRect();
          const say = line.querySelector(".oh-refusal-say")!;
          const range = document.createRange();
          range.selectNodeContents(say);
          const words = [...range.getClientRects()].filter((r) => r.width > 0);
          const way = line.querySelector("button")!.getBoundingClientRect();
          /* The way's own letters. */
          const label = document.createRange();
          const letters = document.createTreeWalker(line.querySelector("button")!, NodeFilter.SHOW_TEXT);
          label.selectNodeContents(letters.nextNode()!);
          return {
            wordsInside: words.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
            wayInside: way.left >= box.left - 0.5 && way.right <= box.right + 0.5,
            wayWhole: new Set([...label.getClientRects()].map((r) => Math.round(r.top))).size === 1,
            scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        { entry: "base", face, device: "phone", zoom: 1.5, lang: "de" },
      );
      expect(got).toEqual({ wordsInside: true, wayInside: true, wayWhole: true, scrolls: false });
    },
    60_000,
  );
});

describe("two folders of one name on the shelf", () => {
  it.each(["paper", "ohmarchy"] as const)(
    "in %s: the hint stands after the name, smaller and quieter, and on the open folder in the open folder's own ink; a long one is cut with the name inside the rail",
    async (face) => {
      const got = await drawn(
        <div style={{ width: 232 }}>
          <FolderShelf
            label="Ordner"
            expanded
            folders={[
              { id: "a", name: "Angebote", hint: "Kunden" },
              { id: "b", name: "Angebote", hint: "Privat", current: true },
              { id: "c", name: "Veranstaltungsunterlagen", hint: "Gartenlokal Rosa und Partner" },
            ]}
          />
        </div>,
        () => {
          const rail = document.querySelector(".oh-foldershelf")!.getBoundingClientRect();
          return [...document.querySelectorAll("small")].map((hint) => {
            const entry = hint.closest("button")!;
            const name = hint.parentElement!;
            const range = document.createRange();
            range.selectNodeContents(name.firstChild!);
            const word = range.getBoundingClientRect();
            const [own, around] = [getComputedStyle(hint), getComputedStyle(name)];
            const box = hint.getBoundingClientRect();
            return {
              after: box.left >= word.right - 0.5,
              apart: Math.round(box.left - word.right),
              smaller: parseFloat(own.fontSize) < parseFloat(around.fontSize),
              lighter: Number(own.fontWeight) <= Number(around.fontWeight),
              inkOfEntry: own.color === getComputedStyle(entry).color,
              /* What is longer than the rail is cut inside the name's own box, which ends inside the rail. */
              inside:
                entry.getBoundingClientRect().right <= rail.right + 0.5 &&
                name.getBoundingClientRect().right <= rail.right + 0.5 &&
                getComputedStyle(name).overflow === "hidden",
            };
          });
        },
        { entry: "mail", face },
      );
      expect(got).toHaveLength(3);
      /* The reference (folders.css): 8 after the name, the meta size, the text weight, the second ink. */
      expect(got[0]).toEqual({
        after: true,
        apart: 8,
        smaller: true,
        lighter: true,
        inkOfEntry: false,
        inside: true,
      });
      expect(got[1]).toMatchObject({ after: true, smaller: true, inkOfEntry: true, inside: true });
      expect(got[2]!.inside).toBe(true);
    },
    60_000,
  );
});

describe("the lists and streams of the other places", () => {
  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: a list's head says a quiet line under its name and how many it holds at the line's end, inside its column",
    async (face, device, zoom) => {
      const got = await drawn(
        <div style={{ width: device === "phone" ? undefined : 420 }}>
          <ListHead
            title="Petra Wyss"
            meta="petra.wyss-veranstaltungen@makersfest-winterthur.example"
            count="2 Nachrichten"
            aside={<Button kind="quiet" size="s" icon="more" label="Mehr" />}
            below={<p id="below">darunter</p>}
          />
        </div>,
        () => {
          const head = document.querySelector("header")!;
          const box = head.getBoundingClientRect();
          const text = (words: string) => {
            const walk = document.createTreeWalker(head, NodeFilter.SHOW_TEXT);
            for (let node = walk.nextNode(); node; node = walk.nextNode()) {
              if (!(node.textContent ?? "").startsWith(words)) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              return { rect: range.getBoundingClientRect(), style: getComputedStyle(node.parentElement!) };
            }
            throw new Error(words);
          };
          const [title, meta, count] = [text("Petra"), text("petra.wyss"), text("2 Nachrichten")];
          const tool = head.querySelector("button")!.getBoundingClientRect();
          const below = document.getElementById("below")!.getBoundingClientRect();
          return {
            metaUnderTitle: meta.rect.top >= title.rect.bottom - 4,
            metaOverBelow: meta.rect.bottom <= below.top + 0.5,
            metaStartsWithTitle: Math.abs(meta.rect.left - title.rect.left) <= 1,
            metaQuiet:
              meta.style.color !== title.style.color &&
              parseFloat(meta.style.fontSize) < parseFloat(title.style.fontSize),
            metaInside: meta.rect.right <= box.right + 0.5,
            countOnTitleLine: count.rect.top < title.rect.bottom && count.rect.bottom > title.rect.top,
            countWhole: count.rect.height < title.rect.height && count.rect.left >= box.left,
            countBeforeTool: count.rect.right <= tool.left + 0.5,
            countQuiet: count.style.color !== title.style.color,
            toolInside: tool.right <= box.right + 0.5,
            scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      /* Where the head is too narrow for its name, the count and the tools on one line, they go under the name. */
      expect(got).toEqual({
        metaUnderTitle: true,
        metaOverBelow: true,
        metaStartsWithTitle: true,
        metaQuiet: true,
        metaInside: true,
        countOnTitleLine: !(device === "phone" && zoom === 1.5),
        countWhole: true,
        countBeforeTool: true,
        countQuiet: true,
        toolInside: true,
        scrolls: false,
      });
    },
  );

  it.each(["desktop", "fold", "phone"] as const)(
    "on a %s: the reading column fills the column it stands in, so its panel stands at the column's foot however short the letter",
    async (device) => {
      const got = await drawn(
        <div id="cell" style={{ display: "flex", flexDirection: "column", height: 520 }}>
          <Sheet
            kind="reading"
            label="Conversation"
            foot={<ActionPanel label="Message" items={[{ id: "restore", label: "Restore", kind: "ink" }]} />}
          >
            <Message head={<p>head</p>}>A short letter.</Message>
          </Sheet>
        </div>,
        () => {
          const cell = document.getElementById("cell")!.getBoundingClientRect();
          const column = document.querySelector('[role="region"]')!.getBoundingClientRect();
          const bar = document.querySelector('[role="toolbar"]')!.getBoundingClientRect();
          return {
            fills: Math.round(column.height) === Math.round(cell.height),
            over: cell.bottom - bar.bottom,
          };
        },
        { entry: "mail", device },
      );
      expect(got.fills).toBe(true);
      expect(got.over).toBeGreaterThanOrEqual(16);
      expect(got.over).toBeLessThan(40);
    },
  );

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: a stream's letter is cut after a few lines, its last line fading, and is whole once opened, its control inside the sheet",
    async (face, device, zoom) => {
      const long = Array.from({ length: 30 }, (_, i) => `Zeile ${i + 1} eines langen Briefes.`).join("\n");
      const got = await opened(
        <>
          <Message head={<p>head</p>} clip={{ open: false, word: "Aufklappen" }}>
            {long}
          </Message>
          <Message head={<p>head</p>} clip={{ open: true, word: "Zuklappen" }}>
            {long}
          </Message>
        </>,
        { entry: "mail", face, device, zoom, lang: "de" },
        (tab) =>
          tab.evaluate(() =>
            [...document.querySelectorAll("article")].map((article) => {
              const box = article.getBoundingClientRect();
              const walk = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
              let text: HTMLElement | null = null;
              for (let node = walk.nextNode(); node; node = walk.nextNode())
                if (/^Zeile 1 /.test(node.textContent ?? "")) text = node.parentElement;
              const cut = text!.parentElement!;
              const line = parseFloat(getComputedStyle(text!).lineHeight);
              const c = article.querySelector("button")!.getBoundingClientRect();
              return {
                lines: Math.round((cut.clientHeight / line) * 10) / 10,
                more: cut.scrollHeight > cut.clientHeight + 2,
                fades: getComputedStyle(cut).maskImage !== "none",
                control: article.querySelector("button")!.textContent ?? "",
                inside: c.left >= box.left && c.right <= box.right && c.bottom <= box.bottom,
              };
            }),
          ),
      );
      const [shut, open] = got;
      expect(shut).toMatchObject({ more: true, fades: true, control: "Aufklappen", inside: true });
      expect(shut!.lines).toBeLessThanOrEqual(6.2);
      expect(shut!.lines).toBeGreaterThan(5);
      expect(open).toMatchObject({ more: false, fades: false, control: "Zuklappen", inside: true });
      expect(open!.lines).toBeGreaterThan(29);
    },
  );

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: a month rail stands at its list's right edge while the rows run under it, the rows end before it, and each step takes a finger",
    async (face, device, zoom) => {
      const row = (n: number): RowProps => ({
        who: `Absender ${n}`,
        people: [{ name: `Absender ${n}`, address: `a${n}@lichtgrat.example` }],
        subject: "Betreff einer Nachricht aus dem Archiv",
        when: "12:00",
      });
      const got = await opened(
        <div id="list" style={{ height: 360, overflow: "auto", width: device === "phone" ? undefined : 400 }}>
          <MonthRail
            label="Monat"
            current="2026-10"
            entries={[
              { id: "2026", label: "2026", year: true },
              { id: "2026-11", label: "Nov", title: "November 2026" },
              { id: "2026-10", label: "Okt", title: "Oktober 2026" },
              { id: "2025", label: "2025", year: true },
            ]}
          >
            <Rows label="Verlauf">
              {Array.from({ length: 14 }, (_, n) => (
                <Row key={n} {...row(n)} />
              ))}
            </Rows>
          </MonthRail>
        </div>,
        { entry: "mail", face, device, zoom, lang: "de" },
        async (tab) => {
          const read = () => {
            const list = document.getElementById("list")!.getBoundingClientRect();
            const rail = document.querySelector("nav")!.getBoundingClientRect();
            const steps = [...document.querySelectorAll("nav button")].map((b) => b.getBoundingClientRect());
            const rows = [...document.querySelectorAll('[role="list"] > *, [role="listbox"] > *')];
            const current = document.querySelector('nav [aria-current="true"]')!;
            const other = document.querySelector("nav button:not([aria-current])")!;
            return {
              top: rail.top - list.top,
              atRightEdge: list.right - rail.right,
              rowsClear: rows.every((r) => r.getBoundingClientRect().right <= rail.left + 0.5),
              least: Math.min(...steps.map((s) => s.height)),
              inside: steps.every((s) => s.left >= rail.left - 0.5 && s.right <= rail.right + 0.5),
              marked: getComputedStyle(current).backgroundColor !== getComputedStyle(other).backgroundColor,
              scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            };
          };
          const rest = await tab.evaluate(read);
          await tab.evaluate(() => (document.getElementById("list")!.scrollTop = 300));
          return { rest, moved: await tab.evaluate(read) };
        },
      );
      expect(got.rest.atRightEdge).toBeGreaterThanOrEqual(0);
      expect(got.rest.atRightEdge).toBeLessThan(24);
      expect(got.rest).toMatchObject({ rowsClear: true, inside: true, marked: true, scrolls: false });
      /* It stays where it stood while the rows run under it. */
      expect(Math.abs(got.moved.top - got.rest.top)).toBeLessThanOrEqual(1);
      /* Under a finger a step is as tall as the smallest control a finger takes. */
      if (device === "phone") expect(got.rest.least).toBeGreaterThanOrEqual(44 * 0.99);
    },
  );

  it("draws the folder a dragged row is held over differently from one that only takes it, and that from one at rest", async () => {
    const got = await drawn(
      <FolderShelf
        label="Folders"
        expanded
        folders={[
          { id: "a", name: "Angebote" },
          { id: "b", name: "Belege", drop: "ready" },
          { id: "c", name: "Kunden", drop: "over" },
        ]}
      />,
      () =>
        [...document.querySelectorAll("button")].slice(1).map((b) => {
          const style = getComputedStyle(b);
          return `${style.backgroundColor} ${style.boxShadow} ${style.color}`;
        }),
      { entry: "mail" },
    );
    expect(new Set(got).size).toBe(3);
  });
});

describe("a sheet that counts: storage", () => {
  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: the figure leads its line, larger and in the ink, its word at the line's end; the bar's parts stand by their shares with the mark's label over the mark, inside the sheet",
    async (face, device, zoom) => {
      const got = await drawn(
        <div id="sheet" style={{ padding: 16 }}>
          <FigureLine figure="12,4 GB" of="von 50 GB · Probezeit" tag="Dein Tarif" />
          <ScaleBar
            label="12,4 GB von 50 GB belegt"
            parts={[{ share: 20 }, { share: 5, kind: "second" }, { share: 10, kind: "rest" }]}
            marks={[
              { at: 60, label: "30 GB" },
              { at: 100, label: "50 GB, mit allen Nachrichten" },
            ]}
            scale={[{ label: "0" }, { label: "Noch auf dem Server", rest: true }, { label: "50 GB" }]}
          />
        </div>,
        () => {
          const sheet = document.getElementById("sheet")!.getBoundingClientRect();
          const text = (words: string) => {
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let node = walk.nextNode(); node; node = walk.nextNode()) {
              if ((node.textContent ?? "") !== words) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              return { rect: range.getBoundingClientRect(), style: getComputedStyle(node.parentElement!) };
            }
            throw new Error(words);
          };
          const [figure, of, tag] = [text("12,4 GB"), text("von 50 GB · Probezeit"), text("Dein Tarif")];
          const bar = document.querySelector('[role="img"]')!;
          const b = bar.getBoundingClientRect();
          const parts = [...bar.children]
            .filter((el) => (el.textContent ?? "") === "" && el.getBoundingClientRect().width > 3)
            .map((el) => ({
              r: el.getBoundingClientRect(),
              hatch: getComputedStyle(el).backgroundImage !== "none",
            }));
          const [mid, end] = [text("30 GB"), text("50 GB, mit allen Nachrichten")];
          const share = (r: DOMRect) => Math.round((r.width / b.width) * 100);
          return {
            /* It leads: before what it is of, or over it where the line is too short for both. */
            figureLeads:
              (figure.rect.left < of.rect.left || of.rect.top > figure.rect.top) &&
              parseFloat(figure.style.fontSize) > parseFloat(of.style.fontSize),
            figureInk: figure.style.color !== of.style.color,
            tagAtEnd: tag.rect.left > of.rect.left || tag.rect.top > of.rect.top,
            shares: parts.map((p) => share(p.r)),
            follow: parts.every((p, i) => i === 0 || Math.abs(p.r.left - parts[i - 1]!.r.right) <= 1),
            hatched: parts.map((p) => p.hatch),
            midOverItsMark: Math.abs((mid.rect.left + mid.rect.right) / 2 - (b.left + b.width * 0.6)) <= 2,
            labelsOverBar: mid.rect.bottom <= b.top + 1 && end.rect.bottom <= b.top + 1,
            endInside: end.rect.right <= sheet.right + 0.5 && end.rect.left >= sheet.left - 0.5,
            scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      expect(got).toEqual({
        figureLeads: true,
        figureInk: true,
        tagAtEnd: true,
        shares: [20, 5, 10],
        follow: true,
        hatched: [false, false, true],
        midOverItsMark: true,
        labelsOverBar: true,
        endInside: true,
        scrolls: false,
      });
    },
  );

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: a table of figures keeps each column's figures on one edge under its head with a pointer, and under a finger every figure says its column",
    async (face, device, zoom) => {
      const got = await drawn(
        <div style={{ padding: 16 }}>
          <FigureTable
            label="Was Platz braucht"
            columns={["Postfach", "Nachrichten", "Dateien", "Gesamt"]}
            rows={[
              {
                id: "a",
                name: "mila.brunner-werkstatt@lichtgrat-winterthur.example",
                hue: 210,
                figures: ["8,1 GB", "2,3 GB", "10,4 GB"],
              },
              { id: "b", name: "studio@lichtgrat.example", figures: ["1,5 GB", "0,5 GB", "2,0 GB"] },
            ]}
            sum={{ name: "Alle Postfächer", figures: ["9,6 GB", "2,8 GB", "12,4 GB"] }}
          />
        </div>,
        () => {
          const rows = [...document.querySelectorAll('[role="row"]')];
          const cells = rows.slice(1).map((row) => [...row.querySelectorAll('[role="cell"]')].slice(1));
          const heads = [...document.querySelectorAll('[role="columnheader"]')].map((h) =>
            h.getBoundingClientRect(),
          );
          const said = cells.flat().map((c) => getComputedStyle(c, "::before").content);
          const edges = [0, 1, 2].map((col) =>
            cells.map((row) => Math.round(row[col]!.getBoundingClientRect().right)),
          );
          const table = document.querySelector('[role="table"]')!.getBoundingClientRect();
          return {
            headDrawn: heads.every((h) => h.width > 0 && h.height > 0),
            saysColumn: said.every(
              (content) => content !== "none" && content !== "normal" && content.length > 2,
            ),
            oneEdge: edges.every((col) => new Set(col).size === 1),
            inside: [...document.querySelectorAll('[role="cell"]')].every((c) => {
              const r = c.getBoundingClientRect();
              return r.right <= table.right + 0.5 && r.left >= table.left - 0.5;
            }),
            scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      const touch = device === "phone";
      expect(got).toEqual({
        headDrawn: !touch,
        saysColumn: touch,
        oneEdge: true,
        inside: true,
        scrolls: false,
      });
    },
  );
});

describe("an agenda row the keys are on", () => {
  it.each(["paper", "ohmarchy"] as const)(
    "in %s it wears the ground a row under the pointer wears, and a row at rest does not",
    async (face) => {
      const row = { mark: { kind: "outlined" } as const, title: "Brennofen ausräumen", time: "10:00" };
      const got = await drawn(
        <>
          <AgendaRow {...row} label="rest" />
          <AgendaRow {...row} label="cursor" cursor />
          <AgendaRow {...row} label="open" open cursor />
        </>,
        () =>
          ["rest", "cursor", "open"].map(
            (name) => getComputedStyle(document.querySelector(`[aria-label="${name}"]`)!).backgroundColor,
          ),
        { entry: "calendar", face },
      );
      expect(got[1]).not.toBe(got[0]);
      /* The open row keeps its own ground: the cursor does not repaint it. */
      expect(got[2]).not.toBe(got[1]);
    },
  );
});

describe("a row still owed, among a list's rows", () => {
  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: its shape keeps a row's room, so the list does not move when the row arrives",
    async (face, device, zoom) => {
      const got = await drawn(
        <div style={{ width: device === "phone" ? undefined : 420 }}>
          <Rows>
            <Row
              who="Petra Wyss"
              people={[{ name: "Petra Wyss", address: "petra@makersfest.example" }]}
              subject="Rechnung für den Brennofen"
              preview="Im Anhang die Rechnung vom November."
              when="08:47"
            />
            <RowsShape rows={1} within />
          </Rows>
        </div>,
        () => {
          const list = document.querySelector('[role="list"]')!;
          const [row, shape] = [...list.children].map((el) => el.getBoundingClientRect());
          const inner = list.lastElementChild!.firstElementChild!.getBoundingClientRect();
          return {
            row: row!.height,
            shape: inner.height,
            left: inner.left - row!.left,
            right: row!.right - inner.right,
          };
        },
        { entry: "mail", face, device, zoom },
      );
      expect(Math.abs(got.shape - got.row)).toBeLessThanOrEqual(1);
      expect(Math.abs(got.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(got.right)).toBeLessThanOrEqual(1);
    },
  );
});

describe("people to tick, on a phone", () => {
  const person = (id: string, name: string, address: string, count: string, on: boolean) => ({
    id,
    name,
    address,
    count,
    said: `${count.replace("×", "")} Nachrichten`,
    on,
  });
  it.each([
    ["paper", 1],
    ["paper", 1.5],
    ["ohmarchy", 1],
    ["ohmarchy", 1.5],
  ] as const)(
    "in %s at Text size %s: the count, the field and the press for all stay inside the sheet, the field and the press under the count; a person's address stands under the name inside the row, whole, and the tick stays at the row's end",
    async (face, zoom) => {
      const got = await drawn(
        <TickList
          figure="7"
          words="Personen, denen du geschrieben hast"
          label="Personen, denen du geschrieben hast"
          find={{ label: "Jemanden finden", placeholder: "Jemanden finden", value: "" }}
          all={{ label: "Keine" }}
          people={[
            person("lena", "Lena Kaufmann", "lena.kaufmann@lichtgrat-werkstatt.example", "12×", true),
            person("ben", "Ben Frei", "ben@paperbird.example", "3×", false),
          ]}
        />,
        () => {
          const head = document.querySelector("header")!;
          const h = head.getBoundingClientRect();
          const [count, find, all] = [
            head.querySelector("h2")!,
            head.querySelector("input")!,
            head.querySelector("button")!,
          ].map((part) => part.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect];
          const inside = (box: DOMRect, room: DOMRect) =>
            box.left >= room.left - 0.5 && box.right <= room.right + 0.5;
          const rows = [...document.querySelectorAll('[role="checkbox"]')].map((row) => {
            const box = row.getBoundingClientRect();
            const name = row.querySelector("b")!.getBoundingClientRect();
            const address = [...row.querySelectorAll("span")].find(
              (part) => (part.textContent ?? "").includes("@") && !part.querySelector("span"),
            )!;
            const a = address.getBoundingClientRect();
            const tick = row.lastElementChild!.getBoundingClientRect();
            return {
              addressUnderTheName: a.top >= name.bottom - 0.5,
              addressInside: inside(a, box) && a.bottom <= box.bottom + 0.5,
              addressWhole: address.scrollWidth <= address.clientWidth,
              tickInside: inside(tick, box),
              tickAfterTheWords: tick.left >= Math.max(name.right, a.right) - 0.5,
            };
          });
          return {
            countInside: inside(count, h),
            findInside: inside(find, h),
            allInside: inside(all, h),
            under: [find.top >= count.bottom - 0.5, all.top >= count.bottom - 0.5],
            rows,
            sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        },
        { entry: "mail", face, device: "phone", zoom, lang: "de" },
      );
      expect({ ...got, rows: [] }).toEqual({
        countInside: true,
        findInside: true,
        allInside: true,
        under: [true, true],
        rows: [],
        sideways: 0,
      });
      expect(got.rows).toEqual(
        Array(2).fill({
          addressUnderTheName: true,
          addressInside: true,
          addressWhole: true,
          tickInside: true,
          tickAfterTheWords: true,
        }),
      );
    },
    60_000,
  );
});

describe("a row of a stream, a row's own button and a row's place as a word", () => {
  const sender = { name: "Tonpost", address: "news@tonpost.example" };
  const letter: RowProps = {
    who: "Tonpost",
    people: [sender],
    subject: "Sechs neue Glasuren diese Woche",
    preview: "Dazu zwei neue Engoben.",
    when: "gestern 09:12",
  };

  it.each(["paper", "ohmarchy"] as const)(
    "in %s: a stream's unread row is set bold in the ink as every unread row and draws no dot on its circle",
    async (face) => {
      const got = await drawn(
        <Rows>
          <Row {...letter} unread />
          <Row {...letter} unread stream />
          <Row {...letter} stream />
        </Rows>,
        () =>
          [...document.querySelectorAll('[role="button"]')].map((row) => {
            const who = getComputedStyle(row.querySelector("b")!);
            return {
              weight: Number(who.fontWeight),
              ink: who.color,
              dots: row.querySelectorAll("[data-kind='hot']").length,
            };
          }),
        { entry: "mail", face },
      );
      const [unread, stream, read] = got;
      expect([unread!.dots, stream!.dots, read!.dots]).toEqual([1, 0, 0]);
      expect([stream!.weight, stream!.ink]).toEqual([unread!.weight, unread!.ink]);
      expect(stream!.weight).toBeGreaterThan(read!.weight);
    },
    60_000,
  );

  it.each([
    ["paper", "desktop"],
    ["ohmarchy", "desktop"],
    ["paper", "phone"],
  ] as const)(
    "in %s on a %s: a row's own button that is a word alone keeps 12 at both its sides, one with a sign 8 before the sign; the room the row keeps for it is the button's own box",
    async (face, device) => {
      const got = await drawn(
        <div style={{ width: device === "phone" ? undefined : 460 }}>
          <Rows>
            <Row {...letter} own={{ label: "Senden abbrechen" }} />
            <Row {...letter} own={{ label: "Verwerfen", icon: "trash" }} />
          </Rows>
        </div>,
        () =>
          [...document.querySelectorAll("button")].map((own) => {
            const cs = getComputedStyle(own);
            const room = own.parentElement!.querySelector("[data-room]")!;
            const [o, r] = [own.getBoundingClientRect(), room.getBoundingClientRect()];
            return {
              sides: [cs.paddingLeft, cs.paddingRight],
              overItsRoom: [o.left - r.left, o.right - r.right].map((v) => Math.round(v * 10) / 10),
            };
          }),
        { entry: "mail", face, device },
      );
      expect(got.map((own) => own.sides)).toEqual([
        ["12px", "12px"],
        ["8px", "12px"],
      ]);
      /* With a pointer the button stands exactly over the room the row keeps for it. */
      if (device === "desktop")
        expect(got.map((own) => own.overItsRoom)).toEqual([
          [0, 0],
          [0, 0],
        ]);
    },
    60_000,
  );

  it.each(ASK_LOOKS)(
    "in %s on a %s at Text size %s: a place's word too long for the row gives way before the name is cut, and the time never leaves the row",
    async (face, device, zoom) => {
      const got = await drawn(
        <div style={{ width: device === "phone" ? undefined : 380 }}>
          <Rows>
            <Row {...letter} who="Töss" where="von deinem Mailserver einsortiert" />
            {/* A word that fits: beside a time of the day it does so in the narrowest look too. */}
            <Row {...letter} who="Töss" where="Spam" when="09:12" />
          </Rows>
        </div>,
        () =>
          [...document.querySelectorAll('[role="button"]')].map((row) => {
            const box = row.getBoundingClientRect();
            const pad =
              parseFloat(getComputedStyle(row).paddingRight) * (box.width / (row as HTMLElement).offsetWidth);
            const [who, when] = [row.querySelector("b")!, row.querySelector("time")!];
            const where = [...row.querySelectorAll("span")].find(
              (el) => /Mailserver|Spam/.test(el.textContent ?? "") && el.children.length === 0,
            )!;
            return {
              timeInside: when.getBoundingClientRect().right <= box.right - pad + 0.5,
              timeWhole: when.scrollWidth <= when.clientWidth,
              nameWhole: who.scrollWidth <= who.clientWidth,
              whereInside: where.getBoundingClientRect().right <= when.getBoundingClientRect().left + 0.5,
              whereCut: where.scrollWidth > where.clientWidth,
              sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          }),
        { entry: "mail", face, device, zoom, lang: "de" },
      );
      const [long, short] = got;
      expect(long).toEqual({
        timeInside: true,
        timeWhole: true,
        nameWhole: true,
        whereInside: true,
        whereCut: true,
        sideways: 0,
      });
      /* A word that fits is whole, as before. */
      expect(short).toEqual({ ...long, whereCut: false });
    },
    60_000,
  );
});

it("keeps a tall menu inside the phone and lets a person scroll to its last command", async () => {
  await opened(
    <div style={{ position: "relative", height: "100dvh" }}>
      <Menu open onClose={() => {}} label="More" anchor={{ x: 30, y: 220 }}>
        {Array.from({ length: 16 }, (_, i) => (
          <MenuItem key={i} onPress={() => {}}>
            {`Command ${i + 1}`}
          </MenuItem>
        ))}
      </Menu>
    </div>,
    { device: "phone", window: [360, 460] },
    async (tab) => {
      const menu = tab.getByRole("menu", { name: "More" });
      const last = menu.getByRole("menuitem").last();
      const bounds = (await menu.boundingBox())!;
      const foot = bounds.y + bounds.height;
      const lastFoot = () => last.evaluate((item) => item.getBoundingClientRect().bottom);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(foot).toBeLessThanOrEqual(460);
      expect(await lastFoot()).toBeGreaterThan(foot);
      await menu.hover();
      await tab.mouse.wheel(0, 1200);
      await expect.poll(lastFoot).toBeLessThanOrEqual(foot);
      await last.click({ trial: true });
    },
  );
});

describe("words too long for their room in a menu", () => {
  it.each([
    ["paper", "phone", 1],
    ["paper", "phone", 1.5],
    ["ohmarchy", "phone", 1.5],
    ["paper", "desktop", 1],
    ["ohmarchy", "desktop", 1],
  ] as const)(
    "in %s on a %s at Text size %s: a menu item's words too long for the menu take a second line inside it, its key and its note stay whole, and an item that fits keeps its one line and its height",
    async (face, device, zoom) => {
      const got = await drawn(
        <div style={{ position: "relative", height: 600 }}>
          <Menu open onClose={() => {}} label="Mehr" anchor={{ x: 20, y: 20 }}>
            <MenuItem icon="read" note="3" onPress={() => {}}>
              Ohbox, als gelesen markieren und alle weiteren Nachrichten dieses Absenders dorthin legen
            </MenuItem>
            <MenuItem icon="reply" onPress={() => {}}>
              Antworten
            </MenuItem>
          </Menu>
        </div>,
        () => {
          const menu = document.querySelector('[role="menu"]')!;
          const m = menu.getBoundingClientRect();
          const probe = document.createElement("i");
          /* A menu's line: a pointer's, and on a phone a finger's own height. */
          const finger = document.documentElement.dataset.device === "phone";
          probe.style.cssText = `display:block;height:var(${finger ? "--h-l" : "--h-m"})`;
          menu.append(probe);
          const least = probe.getBoundingClientRect().height;
          probe.remove();
          const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => {
            const box = item.getBoundingClientRect();
            const word = item.querySelector("span")!;
            const w = word.getBoundingClientRect();
            const note = item.querySelector("small")?.getBoundingClientRect();
            /* The lines the words stand on, counted by the words themselves: their box also holds the item's air. */
            const letters = document.createRange();
            letters.selectNodeContents(word);
            const lines = new Set([...letters.getClientRects()].map((line) => Math.round(line.top))).size;
            return {
              inside: box.left >= m.left - 0.5 && box.right <= m.right + 0.5,
              wordInside: w.right <= box.right + 0.5 && w.top >= box.top && w.bottom <= box.bottom,
              noteInside: note ? note.right <= box.right + 0.5 && note.left >= w.right - 0.5 : true,
              lines,
              high: Math.round(box.height * 10) / 10,
            };
          });
          return {
            items,
            least: Math.round(least * 10) / 10,
            menuInside: m.left >= 0 && m.right <= innerWidth + 0.5,
            scrollsSideways: menu.scrollWidth > menu.clientWidth,
            sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        },
        { face, device, zoom, lang: "de" },
      );
      const [long, short] = got.items;
      expect([got.menuInside, got.scrollsSideways, got.sideways]).toEqual([true, false, 0]);
      expect([long!.inside, long!.wordInside, long!.noteInside]).toEqual([true, true, true]);
      expect(long!.lines).toBeGreaterThan(1);
      expect([short!.inside, short!.wordInside, short!.lines]).toEqual([true, true, 1]);
      /* An item of one line is exactly as high as a menu's line ever was; on a phone a finger's own height. */
      expect(short!.high).toBe(got.least);
      expect(long!.high).toBeGreaterThan(short!.high);
    },
    60_000,
  );
});

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

  it.each([
    ["paper", "phone", 1],
    ["ohmarchy", "phone", 1],
    ["paper", "fold", 1],
    ["ohmarchy", "fold", 1],
    ["paper", "phone", 1.5],
    ["ohmarchy", "phone", 1.5],
  ] as const)(
    "in %s on a %s at Text size %s: under a finger the place answers over at least the height a finger needs",
    async (face, device, zoom) => {
      const tall = await drawn(
        <Rows label="Waiting">
          <Row {...sender} place={{ ...place, accept: { label: "Row 1: accept" } }} />
          <Row {...sender} who="Second Sender" place={{ ...place, accept: { label: "Row 2: accept" } }} />
        </Rows>,
        () =>
          [1, 2].map((n) => {
            const chip = document.querySelector(`button[aria-label="Row ${n}: accept"]`)!;
            const r = chip.getBoundingClientRect();
            let answered = 0;
            /* Down the chip's middle, from well over it to well under it: every half pixel that is the chip's. */
            for (let y = r.top - 40; y <= r.bottom + 40; y += 0.5)
              if (document.elementFromPoint(r.left + r.width / 2, y)?.closest("button") === chip)
                answered += 0.5;
            return answered;
          }),
        { entry: "mail", face, device, zoom },
      );
      for (const height of tall) expect(height / zoom).toBeGreaterThanOrEqual(44);
    },
    60_000,
  );

  it.each(["paper", "ohmarchy"] as const)(
    "in %s: under a finger a row with labels draws no address beside them, however wide; with a pointer it does where there is room",
    async (face) => {
      const wide = (
        <div style={{ width: 700 }}>
          <Rows>
            <Row {...sender} labels={["Braucht dich"]} />
            <Row {...sender} who="Ohne Marken" />
          </Rows>
        </div>
      );
      const read = () =>
        [...document.querySelectorAll(".oh-row")].map((row) => {
          const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          for (let node = walk.nextNode(); node; node = walk.nextNode()) {
            if (!(node.textContent ?? "").startsWith("alerts@")) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const r = range.getBoundingClientRect();
            return r.width > 1 && r.height > 1;
          }
          return false;
        });
      const window: [number, number] = [760, 600];
      /* Under a finger: gone beside a label, and there on a row that has none. */
      for (const device of ["phone", "fold"] as const)
        expect(await drawn(wide, read, { entry: "mail", face, device, window })).toEqual([false, true]);
      expect(await drawn(wide, read, { entry: "mail", face, device: "desktop" })).toEqual([true, true]);
      /* What a screen reader is handed follows what is drawn. */
      const said = await spoken(wide, { entry: "mail", face, device: "phone", window });
      const rows = said.filter(
        (n) => n.name.includes("Cinderlock Security") || n.name.includes("Ohne Marken"),
      );
      expect(rows.some((n) => n.name.includes("Braucht dich") && n.name.includes("alerts@"))).toBe(false);
      expect(rows.some((n) => n.name.includes("Ohne Marken") && n.name.includes("alerts@"))).toBe(true);
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

  /* The orders the first walk left out: a word that acts standing OVER a slot, two slots one under the other in
     a line of settings, and two slots on neighbouring lines of one sentence. */
  const stacked = (
    <div style={{ padding: "0 16px" }}>
      <SettingLine label="Endet am" narrow="under">
        <Button kind="quiet" size="s">
          Kein Enddatum festlegen
        </Button>
        <Slot label="Enddatum wählen">Freitag, 21. November 2026</Slot>
      </SettingLine>
      <SettingLine label="Ruhezeit" narrow="under">
        <Slot label="Ruhe ab">22:00 Uhr am Abend des Vortags</Slot>
        <Slot label="Ruhe bis">07:00 Uhr am Morgen danach</Slot>
      </SettingLine>
      <RuleLine
        who="rechnung@brennofen-zentrale.example"
        person={{
          name: "rechnung@brennofen-zentrale.example",
          address: "rechnung@brennofen-zentrale.example",
          label: "Karte",
          onContact: () => {},
        }}
        goes={
          <>
            <Slot label="Erster Ort">News</Slot> zuerst,
            <br />
            <Slot label="Zweiter Ort">Archiv</Slot> danach
          </>
        }
        origin="Entscheid im Screener"
      />
    </div>
  );

  it.each([
    ["paper", "phone", 1],
    ["paper", "phone", 1.5],
    ["ohmarchy", "phone", 1],
    ["ohmarchy", "phone", 1.5],
    ["paper", "fold", 1.5],
    ["ohmarchy", "fold", 1.5],
  ] as const)(
    "in %s on a %s at Text size %s: a press inside a control's own box is that control's where a word that acts stands over a slot, and where two slots stand one under the other",
    async (face, device, zoom) => {
      const window: [number, number] = [DEVICES[device].window[0], 1600];
      const stood = await drawn(stacked, walk, { entry: "mail", face, device, zoom, lang: "de", window });
      /* The stand really holds what it is for: controls close enough under each other for a slot's room to reach
         the other (the word over its slot and the sentence's two slots always; the line's two where it is narrow). */
      const near = await drawn(
        stacked,
        () => {
          const boxes = [...document.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
          let pairs = 0;
          for (const a of boxes)
            for (const b of boxes)
              if (
                a !== b &&
                b.top >= a.bottom - 1 &&
                b.top - a.bottom < 16 &&
                a.left < b.right &&
                b.left < a.right
              )
                pairs++;
          return pairs;
        },
        { entry: "mail", face, device, zoom, lang: "de", window },
      );
      expect(near).toBeGreaterThanOrEqual(2);
      expect(stood.walked).toBeGreaterThanOrEqual(6);
      expect(stood.outside).toEqual([]);
      expect(stood.taken).toEqual([]);
    },
    60_000,
  );
});
