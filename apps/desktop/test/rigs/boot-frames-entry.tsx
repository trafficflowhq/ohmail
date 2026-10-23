/* The window's first frames as `boot-sync-line-frames.test.ts` drives them in Chromium: the boot
 * surface exactly as `DesktopGate` draws it (the silhouette behind its real grace, the boot line at
 * the rail's foot), and the steady rail the shell then stands on (`RailNav` in `.deck`, a busy sync
 * line in its slot). Every animation frame from the mount records where the boot line is painted
 * and where the rail silhouette is, so a frame the line spends outside the rail cannot hide
 * between two screenshots. The stylesheets are the window's own, in `main.tsx`'s order. */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { RailNav, Spinner } from "@ohmail/ui";
import "../../../webapp/app/app.css";
import "../../../webapp/app/zero-layout.css";
import { BootSkeleton } from "../../../webapp/app/shell/BootSkeleton";
import { BootStatus } from "../../src/BootStatus.js";

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

/** The steady shell's rail with a sync line busy in its slot, as `AppShell` hands it to `RailNav`. */
function shell(): { rail: Box | null; line: Box | null } {
  mount(
    <div className="app-root">
      <div className="shell">
        <div className="deck">
          <RailNav
            onCompose={() => {}} composeLabel="Compose" mailboxesLabel="Mailboxes" ariaLabel="Main" id="shell-rail"
            groups={[{ items: [{ id: "ohbox", label: "Ohbox" }, { id: "screener", label: "Screener" }, { id: "settings", label: "Settings" }] }]}
            activeId="ohbox" mailboxes={[{ name: "you@probe.invalid", hint: "imap" }]}
            sync={
              <div className="rail-sync busy" role="status">
                <div className="rs-line"><Spinner className="mbx-spin" /><b>Syncing your mail</b></div>
                <span className="rs-track" aria-hidden="true"><i /></span>
              </div>
            }
          />
          <main className="stage"><section className="view split view-ohbox"><div className="list-col" /></section></main>
        </div>
      </div>
    </div>,
  );
  return { rail: box(document.querySelector(".deck > .rail")), line: box(document.querySelector(".deck .rail-sync")) };
}

type Frame = { t: number; line: Box | null; rail: Box | null };
/** The boot surface for `ms`, one reading per animation frame from the frame of the mount. */
function boot(ms: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  const t0 = performance.now();
  return new Promise((done) => {
    const tick = (): void => {
      frames.push({
        t: performance.now() - t0,
        line: box(document.querySelector(".gate-boot .rail-sync")),
        rail: box(document.querySelector(".gate-boot .boot-sk-rail")),
      });
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else done(frames);
    };
    mount(
      <div className="gate gate-boot">
        <BootSkeleton active rail />
        <BootStatus phase="opening_store" />
      </div>,
    );
    tick();
    requestAnimationFrame(tick);
  });
}

(window as unknown as { rig: unknown }).rig = { shell, boot };
