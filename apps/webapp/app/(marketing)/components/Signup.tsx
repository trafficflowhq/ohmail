"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";

/**
 * The waitlist flow: email → tier preselect → success.
 *
 * ── THIS NOW REACHES A DATABASE ───────────────────────────────────────────
 *
 * It used to call `persist()`, which wrote to `localStorage` and nothing else — so the
 * dialog said "you're on the list" to a list that did not exist. `join()` POSTs to
 * `/api/waitlist`, a route handler on THIS origin that forwards to the API server-side
 * (see `app/api/waitlist/route.ts` for why the browser must not call the API directly:
 * `ohmail.app` can never be an auth origin, and `withRequestGuard` refuses it).
 *
 * **The success state is no longer optimistic.** That is the whole change of behaviour,
 * and it is deliberate: claiming success when the row was never written would be the one
 * lie this dialog is capable of telling. A failure gets its own step with a retry and a
 * human address, and the email + tier the visitor already typed are still there.
 *
 * **The success copy promised no confirmation, and that changed — because the reason it
 * was hedged has gone.** It used to say "we'll send you a short confirmation now", which was
 * false: the deployed API had `RESEND_API_KEY` but no `MAIL_FROM`, so `loadMailConfig`
 * returned null, `WaitlistService.join` reported `mailed: false`, and nothing arrived. The
 * hedge that replaced it ("if a confirmation arrives, that's us") was the honest sentence
 * while `MAIL_FROM` was an undecided OPERATOR decision — three options were open, and the
 * chosen one puts transactional reputation on the apex domain irreversibly.
 *
 * That decision is now made and armed: `MAIL_FROM` is `ohmail <no-reply@ohmail.app>` — the
 * mail vendor's plan makes a dedicated subdomain unavailable, so the apex carries it — and
 * a delivered confirmation has been observed in production. So the
 * hedge is now UNDERSTATED rather than careful: it describes a mail that does send as though
 * it might not. The copy states the confirmation plainly.
 *
 * What it still does NOT promise is a schedule for anything else, and the "we write when there
 * is something to say" clause is unchanged. The rule this file follows in both directions is
 * the same one: say what the deployment actually does today.
 *
 * `localStorage` is gone entirely rather than kept as a fallback. A "fallback" that
 * nothing ever reads is not a fallback, it is a copy of a stranger's email address left
 * in their browser for no reason.
 */

export type SignupTier = "desktop" | "solo" | "plus" | "pro" | "undecided";
type Step = "email" | "tier" | "sending" | "done" | "error";

const TIERS: SignupTier[] = ["desktop", "solo", "plus", "pro", "undecided"];

/* Honest-enough shape check; the confirmation mail is the real validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Same-origin, so no CORS and no credentials. The 202 the API answers is a CONSTANT
 * `{status:"ok"}` and carries no transport detail — it used to carry `mailed`, which this
 * dialog already declined to surface and which the API has since stopped emitting, because
 * a field that flips with the per-recipient mail limiter is an oracle about an address the
 * caller may not own. See the header of `packages/api/src/routes/waitlist.ts`.
 *
 * Only `res.ok` is read, so the 429 the per-IP limiter can now answer lands in the same
 * error step as any other failure — which is right: "too many signups from this
 * connection" is not a sentence to put in front of the fourth person in an office.
 */
async function submitWaitlist(email: string, tier: SignupTier): Promise<boolean> {
  try {
    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, tier }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const SignupContext = createContext<{ open: (tier?: SignupTier) => void } | null>(null);

export function useSignup() {
  const ctx = useContext(SignupContext);
  if (!ctx) throw new Error("useSignup must be used inside <SignupProvider>");
  return ctx;
}

export function SignupProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("signup");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("email");
  const [tier, setTier] = useState<SignupTier>("undecided");
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState(false);

  const open = useCallback((preselect?: SignupTier) => {
    setStep("email");
    setInvalid(false);
    if (preselect) setTier(preselect);
    dialogRef.current?.showModal();
  }, []);

  const close = useCallback(() => dialogRef.current?.close(), []);

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setStep("tier");
  };

  const join = async (e: FormEvent) => {
    e.preventDefault();
    setStep("sending");
    const ok = await submitWaitlist(email.trim(), tier);
    setStep(ok ? "done" : "error");
  };

  return (
    <SignupContext.Provider value={{ open }}>
      {children}
      <dialog
        ref={dialogRef}
        className="l-signup"
        aria-labelledby="signup-title"
        onClick={(e) => {
          /* click on the backdrop (the dialog element itself) closes */
          if (e.target === dialogRef.current) close();
        }}
      >
        <div className="l-signup-panel">
          <button
            type="button"
            className="l-signup-x"
            onClick={close}
            aria-label={t("close")}
          >
            <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>

          {step === "email" && (
            <form onSubmit={submitEmail} noValidate>
              <h2 id="signup-title" className="l-signup-title">
                {t("title")}
              </h2>
              <p className="l-signup-lead">{t("stepEmail")}</p>
              <label className="l-signup-label" htmlFor="signup-email">
                {t("emailLabel")}
              </label>
              {/* `suppressHydrationWarning` is for ONE thing here, and it is not our
                  markup: browsers and password managers decorate an `autocomplete="email"`
                  field before React hydrates — Chrome's autofill stamps a `style` attribute
                  on it — and React then logs "Extra attributes from the server: style"
                  against a node the server rendered perfectly. It fires nondeterministically
                  (it depends on what the visitor's browser has saved), which is exactly the
                  kind of warning that trains people to ignore the console.
                  Safe to suppress on THIS node specifically: every attribute below is a
                  literal, and the only dynamic one is `value`, which React reconciles as a
                  property rather than an attribute and so is unaffected. Nothing else in the
                  dialog carries it. */}
              <input
                suppressHydrationWarning
                id="signup-email"
                className="l-signup-input"
                type="email"
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (invalid) setInvalid(false);
                }}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? "signup-email-err" : undefined}
              />
              {invalid && (
                <p id="signup-email-err" className="l-signup-err" role="alert">
                  {t("emailError")}
                </p>
              )}
              <div className="l-signup-row">
                <button type="submit" className="btn primary l-btn-lg l-signup-go">
                  {t("continue")}
                </button>
              </div>
            </form>
          )}

          {(step === "tier" || step === "sending") && (
            <form onSubmit={join}>
              <h2 id="signup-title" className="l-signup-title">
                {t("stepTier")}
              </h2>
              <p className="l-signup-lead">{t("tierHint")}</p>
              <div className="l-tier-list" role="radiogroup" aria-label={t("stepTier")}>
                {TIERS.map((id) => (
                  <label
                    key={id}
                    className="l-tier-opt"
                    data-checked={tier === id || undefined}
                  >
                    <input
                      type="radio"
                      name="tier"
                      value={id}
                      checked={tier === id}
                      onChange={() => setTier(id)}
                    />
                    <b>{t(`tier${cap(id)}`)}</b>
                    <span className="num">{t(`tier${cap(id)}Sub`)}</span>
                  </label>
                ))}
              </div>
              <div className="l-signup-row">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setStep("email")}
                  disabled={step === "sending"}
                >
                  {t("back")}
                </button>
                <button
                  type="submit"
                  className="btn primary l-btn-lg l-signup-go"
                  disabled={step === "sending"}
                  aria-busy={step === "sending" || undefined}
                >
                  {step === "sending" ? t("joining") : t("join")}
                </button>
              </div>
            </form>
          )}

          {step === "error" && (
            <div className="l-signup-done">
              <h2 id="signup-title" className="l-signup-title">
                {t("errorTitle")}
              </h2>
              <p className="l-signup-lead" role="alert">
                {t("errorBody")}
              </p>
              <div className="l-signup-row">
                <button type="button" className="btn ghost" onClick={close}>
                  {t("close")}
                </button>
                <button
                  type="button"
                  className="btn primary l-btn-lg l-signup-go"
                  onClick={() => setStep("tier")}
                >
                  {t("retry")}
                </button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="l-signup-done">
              <span className="l-done-disc" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <path d="M3.2 8.6l3.2 3.2 6.4-7.6" />
                </svg>
              </span>
              <h2 id="signup-title" className="l-signup-title">
                {t("successTitle")}
              </h2>
              <p className="l-signup-lead">{t("successBody", { email: email.trim() })}</p>
              <div className="l-signup-row">
                <button type="button" className="btn primary l-btn-lg l-signup-go" onClick={close}>
                  {t("done")}
                </button>
              </div>
            </div>
          )}
        </div>
      </dialog>
    </SignupContext.Provider>
  );
}

function cap(id: SignupTier): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
