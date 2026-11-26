import { useEffect, useRef, useState, type ReactNode } from "react";
import { cssRect, cssViewport, uiZoom, type CssRect } from "@ohmail/app-logic/geometry";
import { KeyHint } from "@ohmail/ui/base";
import { chordKeys, useModGlyph } from "@ohmail/app-logic/keys";
import { HeldChips } from "./HeldChips.js";
import { TOUCH_ONLY } from "./availability.js";
import "./keyboard-cues.css";

const HOLD_MS = 450;
const TARGET = "[aria-keyshortcuts]";
const CONTROLS = `button, a[href], input, label, textarea, [contenteditable="true"], [role="button"], [role="tab"], [role="option"], ${TARGET}`;

function capsOf(control: HTMLElement, mod: string): string {
  if (control.dataset.shortcutHint) return control.dataset.shortcutHint;
  const chord = control.getAttribute("aria-keyshortcuts")?.trim().split(" ")[0];
  if (!chord) return "";
  const parts = chord.split("+");
  const key = parts.pop()!;
  const modifiers: Record<string, string> = {
    Control: "Ctrl",
    Meta: "⌘",
    Alt: mod === "⌘" ? "⌥" : "Alt",
    Shift: "⇧",
  };
  const printed = parts.length > 0 && key.length === 1 ? key.toUpperCase() : key;
  return (
    parts.map((part) => modifiers[part] ?? part).join("") +
    (key === "Escape" ? "Esc" : chordKeys(printed, mod).join(""))
  );
}

function bounds(control: HTMLElement, view: Window): CssRect | null {
  const viewport = cssViewport(view);
  if (
    control.closest("[hidden], [inert], [aria-hidden='true']") ||
    view.getComputedStyle(control).visibility !== "visible"
  )
    return null;
  const rect = cssRect(control);
  if (rect.width === 0 || rect.height === 0) return null;
  // Hit testing takes viewport pixels even though the cue is placed in page CSS pixels.
  const zoom = uiZoom(control.ownerDocument);
  const x = Math.max(0, Math.min(viewport.width * zoom - 1, (rect.x + rect.width / 2) * zoom));
  const y = Math.max(0, Math.min(viewport.height * zoom - 1, (rect.y + rect.height / 2) * zoom));
  const hit = control.ownerDocument.elementFromPoint?.(x, y);
  return hit &&
    control.contains(hit) &&
    rect.bottom > 0 &&
    rect.top < viewport.height &&
    rect.right > 0 &&
    rect.left < viewport.width
    ? rect
    : null;
}

function alreadyShown(control: HTMLElement, view: Window): boolean {
  return [...control.querySelectorAll(".oh-key")].some(
    (chip) => chip.getClientRects().length > 0 && view.getComputedStyle(chip).opacity !== "0",
  );
}

function heldChips(host: HTMLDivElement, view: Window, mod: string) {
  const visible = [...host.ownerDocument.querySelectorAll<HTMLElement>(CONTROLS)].flatMap((control) => {
    const rect = bounds(control, view);
    return rect ? [{ control, rect }] : [];
  });
  const entries = visible.flatMap(({ control, rect }) => {
    const cap = control.matches(TARGET) ? capsOf(control, mod) : "";
    return cap && !alreadyShown(control, view) ? [{ control, rect, cap }] : [];
  });
  return <HeldChips entries={entries} controls={visible} view={view} />;
}

function Chip({ cap, rect, width, title }: { cap: string; rect: CssRect; width: number; title?: string }) {
  const center = rect.x + rect.width / 2;
  const margin = title === undefined ? 28 : 142;
  const align = center < margin ? "start" : center > width - margin ? "end" : undefined;
  const below = rect.top < 34;
  const left =
    align === "start" ? Math.max(4, rect.left) : align === "end" ? Math.min(width - 4, rect.right) : center;
  return (
    <span
      className={title === undefined ? "fr-shortcut-chip" : "fr-shortcut-chip fr-shortcut-tooltip"}
      data-below={below ? "" : undefined}
      data-align={align}
      style={{ left, top: below ? rect.bottom : rect.top }}
    >
      {title === undefined ? null : <>{title} · </>}
      <KeyHint shown unsaid quiet>
        {cap}
      </KeyHint>
    </span>
  );
}

function watchHold(
  view: Window,
  mod: string,
  media: MediaQueryList,
  setHeld: (held: boolean) => void,
  hideTooltip: () => void,
  capture: AddEventListenerOptions,
): () => void {
  const modifier = mod === "⌘" ? "Meta" : "Control";
  const down = new Set<string>();
  let timer: number | undefined;
  let held = false;
  const stop = () => {
    view.clearTimeout(timer);
    if (!held) return;
    held = false;
    setHeld(false);
  };
  const reset = () => {
    down.clear();
    stop();
  };
  view.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat) {
        if (event.key !== modifier) stop();
        return;
      }
      down.add(event.code || event.key);
      hideTooltip();
      stop();
      if (
        media.matches ||
        event.isComposing ||
        event.key !== modifier ||
        down.size !== 1 ||
        event.altKey ||
        event.shiftKey ||
        (modifier === "Meta" ? event.ctrlKey : event.metaKey)
      )
        return;
      timer = view.setTimeout(() => {
        held = true;
        setHeld(true);
      }, HOLD_MS);
    },
    capture,
  );
  view.addEventListener(
    "keyup",
    (event) => {
      down.delete(event.code || event.key);
      // macOS can drop keyup for keys used in a Command chord.
      if (event.key === "Meta") down.clear();
      stop();
    },
    capture,
  );
  view.addEventListener("blur", reset, { signal: capture.signal });
  return reset;
}

function watchHints(host: HTMLDivElement, view: Window, mod: string, setChips: (chips: ReactNode) => void) {
  const media = view.matchMedia(TOUCH_ONLY);
  let tooltipTimer: number | undefined;
  let frame = 0;
  let held = false;
  let hovered: HTMLElement | null = null;
  let tooltip: { control: HTMLElement; title: string; native: string | null; ready: boolean } | null = null;
  const observer = new MutationObserver((records) => {
    if (records.some(({ target }) => !host.contains(target))) schedule();
  });

  const render = () => {
    view.cancelAnimationFrame(frame);
    frame = 0;
    host.toggleAttribute("data-held-shortcuts", held);
    host.toggleAttribute("data-shortcut-tooltip", !held && tooltip?.ready === true);
    if (held) {
      setChips(heldChips(host, view, mod));
    } else if (tooltip?.ready) {
      const { control, title } = tooltip;
      const rect = bounds(control, view);
      const cap = capsOf(control, mod);
      setChips(
        rect && cap ? <Chip cap={cap} rect={rect} width={cssViewport(view).width} title={title} /> : null,
      );
    } else setChips(null);
  };
  const schedule = () => {
    if ((held || tooltip) && !frame) frame = view.requestAnimationFrame(render);
  };
  const hideTooltip = () => {
    view.clearTimeout(tooltipTimer);
    if (tooltip?.native && tooltip.control.getAttribute("title") === "")
      tooltip.control.setAttribute("title", tooltip.native);
    tooltip = null;
    if (host.hasAttribute("data-shortcut-tooltip")) render();
  };
  const setHeld = (next: boolean) => {
    held = next;
    if (held)
      observer.observe(host.ownerDocument.body, {
        childList: true,
        subtree: true,
        attributeFilter: ["aria-keyshortcuts", "data-shortcut-hint", "hidden", "inert", "aria-hidden"],
      });
    else observer.disconnect();
    render();
  };
  const reset = () => {
    hovered = null;
    hideTooltip();
  };
  const targetOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>(TARGET) : null;
  const hover = (e: PointerEvent) => {
    const next = e.type === "pointerout" ? targetOf(e.relatedTarget) : targetOf(e.target);
    if (next === hovered) return;
    hovered = next;
    hideTooltip();
    if (!next || held || media.matches || e.pointerType === "touch") return;
    const cap = capsOf(next, mod);
    if (!cap) return;
    const native = next.getAttribute("title");
    const name =
      next.getAttribute("aria-label") ?? next.querySelector(".oh-menu-word")?.textContent ?? next.innerText;
    const title =
      native
        ?.split(" · ")
        .filter(
          (part) =>
            part !== next.dataset.shortcutHint && part.replaceAll(" ", "") !== cap.replaceAll(" ", ""),
        )
        .join(" · ") || name;
    if (!title) return;
    // Keep the control's own tooltip copy and suppress the native tooltip while drawing its styled equivalent.
    if (native && name) next.setAttribute("title", "");
    const pending = { control: next, title, native, ready: false };
    tooltip = pending;
    tooltipTimer = view.setTimeout(() => {
      pending.ready = true;
      render();
    }, 550);
  };
  const listeners = new AbortController();
  const capture = { capture: true, signal: listeners.signal };
  const cancelHold = watchHold(view, mod, media, setHeld, hideTooltip, capture);
  view.addEventListener("blur", reset, { signal: listeners.signal });
  view.addEventListener("scroll", schedule, capture);
  view.addEventListener("focusin", schedule, capture);
  view.addEventListener("focusout", schedule, capture);
  view.addEventListener("resize", schedule, { signal: listeners.signal });
  view.addEventListener("pointerover", hover, capture);
  view.addEventListener("pointerout", hover, capture);
  view.addEventListener("pointerdown", hideTooltip, capture);
  const inputChanged = () => {
    cancelHold();
    reset();
  };
  media.addEventListener?.("change", inputChanged);
  return () => {
    listeners.abort();
    media.removeEventListener?.("change", inputChanged);
    observer.disconnect();
    cancelHold();
    view.clearTimeout(tooltipTimer);
    view.cancelAnimationFrame(frame);
    if (tooltip?.native && tooltip.control.getAttribute("title") === "")
      tooltip.control.setAttribute("title", tooltip.native);
    host.removeAttribute("data-held-shortcuts");
    host.removeAttribute("data-shortcut-tooltip");
  };
}

/** The frame’s visual layer reads the shortcut already described on each control. */
export function ShortcutHints({ enabled }: { enabled: boolean }) {
  const mod = useModGlyph();
  const layer = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<ReactNode>(null);
  useEffect(() => {
    const host = layer.current;
    const view = host?.ownerDocument.defaultView;
    if (!enabled || !host || !view || typeof view.matchMedia !== "function") return;
    return watchHints(host, view, mod, setChips);
  }, [enabled, mod]);

  return (
    <div ref={layer} className="fr-keyboard-cues" aria-hidden="true">
      {chips}
    </div>
  );
}
