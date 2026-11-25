/** Drives the desktop opening surface and the steady shell's column layout in Chromium. */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Frame as MailFrame, layoutPlan, type PlaceEntry } from "@ohmail/app/frame";
import { browserWindowFacts } from "@ohmail/app/host/browser";
import { BlankColumn, Rail } from "@ohmail/ui/mail";
import { ThemeProvider } from "@ohmail/ui/theme";
import { TextProvider } from "@ohmail/app/text";
import { fakeHost, NO_ENGINE } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAppearance, fakeWindow } from "../../../../packages/app/test/support/fake-window.js";
import { FRAME_WORDS } from "../../../../packages/app/test/support/frame-words.js";
import { Columns } from "../../../../packages/app/src/frame/Columns.js";
import "../../../webapp/app/app.css";
import "../../../webapp/app/zero-layout.css";
import { BootStatus } from "../../src/BootStatus.js";
import { WindowOpening } from "../../../webapp/app/shell/BootSkeleton";

type Box = { l: number; r: number; t: number; b: number };
const box = (el: Element | null): Box | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0 ? null : { l: r.left, r: r.right, t: r.top, b: r.bottom };
};

let root: Root | null = null;
function mount(node: React.ReactNode): void {
  root?.unmount();
  const el = document.getElementById("root")!;
  root = createRoot(el);
  flushSync(() => root!.render(node));
}

const on = document.documentElement;
const scheme = () => on.dataset.theme === "dark" ? "dark" : "light";
const layout = () => on.dataset.layout === "zero" ? "zero" : undefined;
const storage = {
  get(key: string) {
    if (key === "ohmail.face") return on.dataset.face ?? "paper";
    return key === "ohmail.layout" ? layout() ?? null : null;
  },
  set: () => "stored" as const,
  remove: () => "stored" as const,
};

function railPaint(el: Element | null) {
  if (!el) return null;
  const { backgroundColor, boxShadow, padding } = getComputedStyle(el);
  return { backgroundColor, boxShadow, padding };
}

function shell() {
  const plan = layoutPlan(browserWindowFacts(window).read(), layout());
  on.dataset.device = plan.device;
  on.dataset.scheme = scheme();
  mount(
    <div className="oh-root fr-root">
      <div className="fr-frame" data-rail={plan.rail}>
        <Columns
          plan={plan}
          rail={plan.rail === "dock" ? null : (
            <div className={plan.rail === "words" ? "steady-rail fr-railzone" : "steady-rail"}>
              {plan.rail === "words" ? <Rail label="Places" switcher={<div />} groups={[]} /> : null}
            </div>
          )}
          listKeys={false}
          list={null}
          reading={plan.columns === 2 ? <BlankColumn>Nothing open</BlankColumn> : null}
          wide={null}
          above={null}
          labels={{ list: "List", reading: "Reading", railWidth: "Rail width", listWidth: "List width" }}
        />
      </div>
    </div>,
  );
  return {
    rail: box(document.querySelector(".steady-rail > .oh-rail") ?? document.querySelector(".steady-rail")),
    paint: railPaint(document.querySelector(".steady-rail > .oh-rail")),
    list: box(document.querySelector(".fr-list")),
    reader: box(document.querySelector(".fr-reading")),
  };
}

type Frame = {
  t: number;
  line: Box | null;
  rail: Box | null;
  list: Box | null;
  reader: Box | null;
  shaped: boolean;
  railInset: number;
  paint: ReturnType<typeof railPaint>;
};

function boot(ms: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  const t0 = performance.now();
  return new Promise((done) => {
    const tick = (): void => {
      const rail = document.querySelector(".fr-opening-rail > .oh-rail") ?? document.querySelector(".fr-opening-rail");
      frames.push({
        t: performance.now() - t0,
        line: box(document.querySelector(".boot-foot")),
        rail: box(rail),
        railInset: rail ? parseFloat(getComputedStyle(rail).paddingBottom) : 0,
        list: box(document.querySelector(".fr-list")),
        reader: box(document.querySelector(".fr-reading")),
        shaped: document.querySelector(".fr-opening-rows") !== null,
        paint: railPaint(rail),
      });
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else done(frames);
    };
    mount(
      <ThemeProvider faces defaultPreference={scheme()} storage={storage}>
        <WindowOpening><BootStatus phase="opening_store" /></WindowOpening>
      </ThemeProvider>,
    );
    tick();
  });
}

const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: {
    kind: "columns",
    List: () => <p>Loaded mail</p>,
    Reading: () => <BlankColumn>Nothing open</BlankColumn>,
  },
};

async function handoff() {
  await boot(500);
  const { host } = fakeHost({
    engine: NO_ENGINE, service: "self", scope: "mailbox", places: { ohbox },
    window: fakeWindow(browserWindowFacts(window).read()),
    appearance: fakeAppearance({ scheme: scheme(), face: on.dataset.face === "ohmarchy" ? "ohmarchy" : "paper" }),
  });
  const read = () => {
    const list = document.querySelector(".fr-list");
    const sheet = list?.querySelector(".oh-sheet");
    const reader = document.querySelector(".fr-reading");
    const rail = document.querySelector(".fr-columns .oh-rail");
    const paint = railPaint(rail);
    return {
      list: box(list ?? null),
      reader: box(reader),
      rail: box(rail),
      railFill: paint?.backgroundColor ?? null,
      railRing: paint?.boxShadow ?? null,
      background: sheet ? getComputedStyle(sheet).backgroundColor : null,
      opacity: list && sheet ? Number(getComputedStyle(list).opacity) * Number(getComputedStyle(sheet).opacity) : 0,
      readerOpacity: reader ? Number(getComputedStyle(reader).opacity) : 0,
    };
  };
  const opening = read();
  mount(
    <TextProvider locale="en" messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }} timeZone="UTC">
      <MailFrame host={host} />
    </TextProvider>,
  );
  const frames = [read()];
  const start = performance.now();
  await new Promise<void>((done) => {
    function tick() {
      frames.push(read());
      if (performance.now() - start < 350) requestAnimationFrame(tick);
      else done();
    }
    requestAnimationFrame(tick);
  });
  return { opening, frames };
}

(window as unknown as { rig: unknown }).rig = { shell, boot, handoff };
