/**
 * Toast with the true-undo pattern: the toast carries the action, the
 * action fires exactly once, and firing it dismisses the toast.
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
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
}

export type ToastFn = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ToastFn | null>(null);

interface ActiveToast {
  message: string;
  action?: string;
  onAction?: () => void;
  key: number;
}

export interface ToastHostProps {
  children?: ReactNode;
}

/**
 * Mount once near the app root. Children get `useToast()`; the host
 * renders the single toast capsule (a new toast replaces the current
 * one, exactly like the prototype).
 */
export function ToastHost({ children }: ToastHostProps) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef<ActiveToast | null>(null);
  const seq = useRef(0);

  const show = useCallback<ToastFn>((message, options) => {
    if (timer.current) clearTimeout(timer.current);
    const next: ActiveToast = {
      message,
      action: options?.action,
      onAction: options?.onAction,
      key: ++seq.current,
    };
    live.current = next;
    setToast(next);
    setOn(true);
    timer.current = setTimeout(
      () => setOn(false),
      options?.duration ?? 2600,
    );
  }, []);

  const fireAction = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOn(false);
    // Fires at most once: the live toast is consumed with the press.
    const current = live.current;
    live.current = null;
    setToast(null);
    current?.onAction?.();
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={on ? "toast on" : "toast"} role="status" aria-live="polite">
        {toast ? (
          <>
            {toast.message}
            {toast.action ? (
              <button type="button" className="toast-act" onClick={fireAction}>
                {toast.action}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastHost>");
  return ctx;
}
