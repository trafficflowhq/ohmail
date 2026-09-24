/**
 * Toast with the true-undo pattern: the toast carries the action, the
 * action fires exactly once, and firing it dismisses the toast.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import "./toast.css";

export interface ToastOptions {
  /** Action label (e.g. "Undo"). */
  action?: string;
  /** Fired at most once, when the action is pressed. */
  onAction?: () => void;
  /** Auto-dismiss in ms; defaults to 2600 (6000+ recommended with an action). */
  duration?: number;
  /**
   * Aborted by the caller when its window closes EARLY — leaving the Screener commits every
   * pending decision — and the Undo capsule is withdrawn at once if it still holds the slot, so a
   * dead Undo never stands above the act's own outcome.
   */
  signal?: AbortSignal;
  /**
   * A notice nobody pressed for, such as a background batch's summary. It never replaces a notice
   * the person's own act raised: it waits for that notice's window, then draws after the fade, and
   * a newer one waiting replaces it. It replaces a standing notice of its own class. Every other
   * notice still replaces whatever notice stands, so a refusal is never held back.
   */
  yields?: boolean;
}

export type ToastFn = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ToastFn | null>(null);

interface ActiveToast {
  message: string;
  action?: string;
  onAction?: () => void;
  yields?: boolean;
  key: number;
}

export interface ToastHostProps {
  children?: ReactNode;
}

/** The capsule's fade in `toast.css`; a finished Undo capsule leaves the tree after it. */
const FADE_MS = 300;
/** The gap between the Undo capsule and a notice standing beneath it. */
const STACK_GAP = 8;
/** A one-line capsule plus the gap, for a notice the layout has not measured (jsdom). */
const LIFT_FALLBACK = 44;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Mount once near the app root; children get `useToast()`. TWO SLOTS in one corner: a toast
 * carrying `action` holds the Undo slot for its whole duration, and a notice arriving meanwhile
 * shows beneath it on its own timer instead of replacing it. A notice replaces a notice and an
 * action an action, except that a `yields` notice waits behind one the person's act raised. A
 * notice's arrival lifts the Undo capsule clear of it, once and never while it is pressed. Both
 * slots are polite live regions, mounted at rest so neither is lost.
 */
export function ToastHost({ children }: ToastHostProps) {
  const [held, setHeld] = useState<ActiveToast | null>(null);
  const [heldOn, setHeldOn] = useState(false);
  const [lift, setLift] = useState(0);
  const [notice, setNotice] = useState<ActiveToast | null>(null);
  const [noticeOn, setNoticeOn] = useState(false);
  const heldTimer = useRef<Timer | null>(null);
  const noticeTimer = useRef<Timer | null>(null);
  const live = useRef<ActiveToast | null>(null);
  const noticeEl = useRef<HTMLDivElement>(null);
  /* What the timers and handlers read between renders: which capsule is on, whether the Undo
     capsule is being pressed, and a lift that waits for that press to end. */
  const at = useRef({ heldOn: false, noticeOn: false, noticeYields: false, arrived: false, pressing: false, pending: 0, noticeLift: 0 });
  const seq = useRef(0);
  /* The one `yields` notice waiting for the notice slot; a newer one replaces it. */
  const waiting = useRef<{ toast: ActiveToast; duration: number } | null>(null);

  const release = useCallback(() => {
    if (heldTimer.current) clearTimeout(heldTimer.current);
    heldTimer.current = null;
    live.current = null;
    Object.assign(at.current, { heldOn: false, pressing: false, pending: 0 });
    setHeldOn(false);
    setHeld(null);
    setLift(0);
  }, []);

  // Draws into the notice slot on its own timer; when that window ends, a waiting notice follows the fade.
  const drawNotice = useCallback((next: ActiveToast, duration: number) => {
    const s = at.current;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (next.yields) waiting.current = null;
    Object.assign(s, { noticeOn: true, noticeYields: next.yields === true, arrived: true });
    setNotice(next);
    setNoticeOn(true);
    noticeTimer.current = setTimeout(() => {
      s.noticeOn = false;
      setNoticeOn(false);
      const w = waiting.current;
      if (w) noticeTimer.current = setTimeout(() => drawNotice(w.toast, w.duration), FADE_MS);
    }, duration);
  }, []);

  const show = useCallback<ToastFn>((message, options) => {
    const next: ActiveToast = {
      message,
      action: options?.action,
      onAction: options?.onAction,
      yields: options?.yields,
      key: ++seq.current,
    };
    const duration = options?.duration ?? 2600;
    const s = at.current;
    if (next.action) {
      if (heldTimer.current) clearTimeout(heldTimer.current);
      live.current = next;
      options?.signal?.addEventListener("abort", () => { if (live.current === next) release(); }, { once: true });
      Object.assign(s, { heldOn: true, pressing: false, pending: 0 });
      setHeld(next);
      setHeldOn(true);
      // PLACED above a notice already standing, never moved into place.
      setLift(s.noticeOn ? s.noticeLift || LIFT_FALLBACK : 0);
      heldTimer.current = setTimeout(() => {
        s.heldOn = false;
        setHeldOn(false);
        // Faded, then gone: the Undo button leaves the tree with its capsule.
        heldTimer.current = setTimeout(release, FADE_MS);
      }, duration);
      return;
    }
    if (next.yields && s.noticeOn && !s.noticeYields) {
      waiting.current = { toast: next, duration };
      return;
    }
    drawNotice(next, duration);
  }, [release, drawNotice]);

  // The notice's height is known once it is in the tree; its ARRIVAL lifts a standing Undo capsule.
  useEffect(() => {
    const s = at.current;
    const h = noticeEl.current?.offsetHeight ?? 0;
    s.noticeLift = h > 0 ? h + STACK_GAP : LIFT_FALLBACK;
    if (!s.arrived) return;
    s.arrived = false;
    if (!s.heldOn) return;
    if (s.pressing) s.pending = Math.max(s.pending, s.noticeLift);
    else setLift((was) => Math.max(was, s.noticeLift));
  }, [notice]);

  useEffect(() => () => {
    if (heldTimer.current) clearTimeout(heldTimer.current);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const fireAction = useCallback(() => {
    // Fires at most once: the live toast is consumed with the press.
    const current = live.current;
    release();
    current?.onAction?.();
  }, [release]);

  const pressStart = useCallback(() => { at.current.pressing = true; }, []);
  const pressEnd = useCallback(() => {
    const s = at.current;
    const pending = s.pending;
    s.pressing = false;
    s.pending = 0;
    if (pending > 0 && s.heldOn) setLift((was) => Math.max(was, pending));
  }, []);

  const lifted = lift > 0 ? ({ "--toast-lift": `${lift}px` } as CSSProperties) : undefined;
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        className={held ? (heldOn ? "toast toast-held on" : "toast toast-held") : "toast-slot"}
        role="status"
        aria-live="polite"
        style={lifted}
        onPointerDown={pressStart}
        onPointerUp={pressEnd}
        onPointerCancel={pressEnd}
        onPointerLeave={pressEnd}
      >
        {held ? (
          <>
            {held.message}
            <button type="button" className="toast-act" onClick={fireAction}>
              {held.action}
            </button>
          </>
        ) : null}
      </div>
      <div ref={noticeEl} className={noticeOn ? "toast on" : "toast"} role="status" aria-live="polite">
        {notice ? notice.message : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastHost>");
  return ctx;
}

/**
 * The same reader where a host may legitimately be absent — `null` rather than a throw.
 *
 * `useToast`'s throw is a real guard and stays: a surface that MEANS to say something and says it
 * into nowhere is a bug, silently. This variant is for a caller that can answer "then I will not
 * act": a view mounted bare in a test or on a surface with no toast layer must still render, and a
 * caller here has to decide what a missing host means rather than being handed a no-op that hides
 * the question. Never a stand-in `show` that drops the message on the floor.
 */
export function useOptionalToast(): ToastFn | null {
  return useContext(ToastContext) ?? null;
}
