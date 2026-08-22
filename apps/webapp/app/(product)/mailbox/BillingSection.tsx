"use client";

/**
 * SETTINGS → SUBSCRIPTION. The plan, the AI switch, and the way to invoices.
 *
 * None of this had a surface. The first real signup landed on a trial nobody had chosen, found
 * no way to subscribe, no AI control, and no receipts — while every endpoint below already
 * existed and worked. This is wiring, not new capability.
 *
 * ── INVOICES ARE STRIPE'S, DELIBERATELY ─────────────────────────────────────────────────
 *
 * `POST /billing/portal` opens Stripe's hosted Billing Portal, which already lists every
 * invoice with a downloadable PDF, keeps them after cancellation, handles VAT/tax lines, and
 * is the copy a customer's accountant will actually accept. Rebuilding that here would mean
 * holding a second billing history that can disagree with the authoritative one — and being
 * wrong about an invoice is worse than not rendering it.
 *
 * The portal is `stepUp`-gated (it exposes the payment method and the cancel control), so it
 * runs the same in-place ceremony `AccountSection` does. Nothing refreshes
 * `sessions.last_twofa_at` except completing a login, so a person sitting in their mailbox is
 * essentially never step-up fresh and "click it and translate the 403" would fail for
 * everyone.
 *
 * ── THE AI SWITCH IS SHOWN ON EVERY PLAN, INCLUDING TRIAL ───────────────────────────────
 *
 * Hiding a control until somebody pays teaches them the product does not have it. The switch
 * is always rendered; on a plan whose entitlement is off it is disabled and says what would
 * change that. `entitlements.aiEnabled` (the server's answer) and `accounts.ai_enabled` (the
 * user's choice) are different facts and are shown as such — a user may switch managed AI OFF
 * on a plan that allows it, and that is a setting, not a limitation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection, Switch } from "@ohmail/ui";
import {
  aiSettings,
  apiConfigured,
  assertPasskey,
  auth,
  billing,
  codeOf,
  messageOf,
  webauthnAvailable,
  type SubscriptionStatus,
  type TwofaChallenge,
} from "../../api-client";
import { aiCreditMessageKey, aiCreditState } from "./ai-credit-state";
import { formatEmailCount, formatStorageBytes, storageFigures, storageState } from "../../shell/storage-state";

type Plan = "solo" | "plus" | "pro";
type Factor = "webauthn" | "totp" | "recovery_code";
/** `idle` → the pane. `password`/`factor` → the step-up the portal demands. */
type Stage = "idle" | "password" | "factor";

const PLANS: Plan[] = ["solo", "plus", "pro"];

export function BillingSection() {
  const t = useTranslations("billing");
  /** The shared AI-credit vocabulary — the same sentences the Screener's line renders. */
  const tc = useTranslations("aiCredits");

  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  /**
   * A failed read is not an empty result. `GET /billing/subscription` REFUSED. Kept apart from `sub === null`, which
   * this pane also uses for the genuine "no subscription" answer — one value cannot carry
   * both without one of them being rendered as the other.
   */
  const [subFailed, setSubFailed] = useState(false);
  const [ai, setAi] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwofaChallenge | null>(null);
  const [method, setMethod] = useState<Factor>("webauthn");
  const [code, setCode] = useState("");

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await billing.subscription();
      if (alive.current) { setSub(s); setSubFailed(false); }
    } catch (err) {
      /**
       * ── A FAILED READ IS NOT AN EMPTY RESULT — "the card below says what it can" SAID SOMETHING IT COULD NOT KNOW ──
       *
       * `sub` stayed `null`, and `null` is the same value this pane uses for "the account has
       * no subscription" — so `:245` rendered **"No plan yet. Choose one below to start."** to
       * a paying subscriber, with the three plan cards live beneath it and the billing portal
       * (the one control that would have proved otherwise) disabled under **"Available once a
       * plan is active."**
       *
       * That is the most expensive shape this defect takes anywhere in the app: the offered
       * remedy is a SECOND checkout. `subFailed` separates "we asked and were refused" from
       * "we asked and the answer was none", so the pane can say the first instead of
       * asserting the second.
       */
      if (alive.current) { setSubFailed(true); setError(messageOf(err)); }
    }
    try {
      const { aiEnabled } = await aiSettings.get();
      if (alive.current) setAi(aiEnabled);
    } catch {
      if (alive.current) setAi(null);
    }
    try {
      const { user, scope } = await auth.session();
      if (alive.current && scope === "full") setEmail(user.email);
    } catch {
      /* the ceremony reports its own failures */
    }
  }, []);

  useEffect(() => { if (apiConfigured()) void load(); }, [load]);

  const toggleAi = (next: boolean): void => {
    setError(null);
    const previous = ai;
    setAi(next);                                   // optimistic: the switch must feel immediate
    void (async () => {
      try {
        const { aiEnabled } = await aiSettings.set(next);
        if (alive.current) setAi(aiEnabled);       // the SERVER's answer wins, not ours
      } catch (err) {
        if (!alive.current) return;
        setAi(previous);                           // …and a refusal puts the switch back
        setError(messageOf(err));
      }
    })();
  };

  const startCheckout = (plan: Plan): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { url } = await billing.checkout(plan);
        window.location.assign(url);
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setBusy(false);
      }
    })();
  };

  /**
   * SET an add-on's quantity — declarative on the server, so the press is idempotent. The new
   * limits arrive through Stripe's webhook, not this response, so the pane re-reads after a
   * short beat instead of inventing an echo; until then the row shows the old number, which is
   * the honest number.
   */
  const [addonBusy, setAddonBusy] = useState(false);
  const setAddon = (kind: "storage" | "mailbox", quantity: number): void => {
    if (quantity < 0) return;
    setAddonBusy(true);
    setError(null);
    void (async () => {
      try {
        await billing.setAddon(kind, quantity);
        // The webhook mirror usually lands within a couple of seconds; one delayed re-read
        // covers it, and the next natural load covers the stragglers.
        setTimeout(() => { if (alive.current) void load(); }, 2_500);
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
      } finally {
        if (alive.current) setAddonBusy(false);
      }
    })();
  };

  /**
   * PRESSING A PLAN CARD — Checkout, or the portal when a trial is already live.
   *
   * A trial IS a subscription, and `createCheckout`'s front door refuses one to any account that
   * has a live row: `liveSubscriptionOf` matches `trialing`, so every plan card on this pane
   * answered `409 subscription_exists` for a trial user. No checkout opened, no card was
   * collected, and the exhausted-trial CTA that sends people here ("Start a plan", offered
   * precisely when the bounty runs out) led to three buttons that could only fail.
   *
   * That 409 is not a bug to route around — a second subscription for one account is the double
   * -pay this product refuses by design. The route Stripe supports for a live subscription is the
   * Billing Portal: it collects the card a no-card trial never had and switches the price on the
   * SAME subscription. So a trial's press starts the portal's step-up ceremony instead, which is
   * the same one the "Open billing portal" button below runs.
   *
   * The chosen plan is deliberately not carried across. The portal presents its own plan list
   * from the pinned configuration, and pre-selecting one here would be a claim about what the
   * portal is about to offer that this pane cannot keep.
   */
  const pressPlan = (plan: Plan): void => {
    setError(null);
    // Read off `sub` rather than the `trialing` binding below: this is defined above it, and a
    // handler that depends on declaration order is a handler that breaks when somebody moves it.
    if (sub?.subscription?.status === "trialing") { setStage("password"); return; }
    startCheckout(plan);
  };

  /** The portal is step-up gated; the ceremony is run up front, never on a translated 403. */
  const openPortal = async (): Promise<void> => {
    try {
      const { url } = await billing.portal();
      window.location.assign(url);
    } catch (err) {
      if (!alive.current) return;
      setStage("idle");
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const submitPassword = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const out = await auth.login({ email, password });
        setPassword("");
        if (out.status === "enrollment") {
          setError(t("noFactor"));
          setStage("idle");
          setBusy(false);
          return;
        }
        setChallenge(out);
        setMethod(
          out.methods.includes("webauthn") && webauthnAvailable() ? "webauthn"
            : out.methods.includes("totp") ? "totp" : out.methods[0]!,
        );
        setStage("factor");
        setBusy(false);
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        if (codeOf(err) === "step_up_required") setStage("idle");
        setBusy(false);
      }
    })();
  };

  const finishWithPasskey = (): void => {
    if (!challenge) return;
    setBusy(true);
    void (async () => {
      try {
        const { options } = await auth.webauthnAssertOptions({ loginToken: challenge.loginToken });
        const credential = await assertPasskey(options);
        await auth.webauthnAssertVerify({ loginToken: challenge.loginToken, credential });
        await openPortal();
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setBusy(false);
      }
    })();
  };

  const finishWithCode = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    void (async () => {
      try {
        if (method === "recovery_code") {
          await auth.recoveryVerify({ loginToken: challenge.loginToken, code: code.trim() });
        } else {
          await auth.totpVerify({ loginToken: challenge.loginToken, code: code.trim() });
        }
        setCode("");
        await openPortal();
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setBusy(false);
      }
    })();
  };

  if (!apiConfigured()) {
    return <SettingsSection><p className="acct-lead">{t("unavailable")}</p></SettingsSection>;
  }

  const s = sub?.subscription ?? null;
  const ent = sub?.entitlements ?? null;
  const cards = sub?.plans ?? {};
  const aiAllowed = ent?.aiEnabled ?? false;
  /**
   * MAY THE SUBSCRIPTION SPEND — the account's own switch deliberately excluded.
   *
   * `entitlements.aiEnabled` is now the FULL predicate: balance AND `accounts.ai_enabled`. That is
   * right for the sentence beside the switch and wrong for the switch itself — a control disabled
   * because it is off is a control nobody can turn back on. `reason: "ai_disabled"` is emitted
   * only where the subscription WOULD have allowed spending, so it is exactly the missing conjunct
   * and adding it back gives the subscription's half on its own.
   */
  const planAllowsAi = aiAllowed || ent?.reason === "ai_disabled";
  const trialing = s?.status === "trialing";
  /**
   * THE SAME DERIVATION THE SCREENER'S LINE USES — so this pane and that line cannot say
   * different things about one balance.
   *
   * This is the page somebody opens to check what the Screener told them, which makes a
   * disagreement between the two worse than either being wrong alone. `aiCreditState` is a pure
   * function over the DTO already loaded above; nothing is fetched twice and nothing is decided
   * twice.
   *
   * `trial_credits` takes its OWN sublabel rather than the Screener's sentence: the row already
   * renders the number in its value, so "500 AI actions left on your trial" beside a value of 500
   * would say it twice. What this row has to add is the part a plan's balance does not share —
   * these do not refill.
   */
  const creditState = aiCreditState(sub);
  const creditNote = creditState
    ? (creditState.kind === "trial_credits" ? "trialSub" : aiCreditMessageKey(creditState))
    : null;
  /** The storage derivation, pure over the same DTO — `storage-state.ts` carries the argument.
      TWO questions, and the module answers both: `storageFigures` is whether there is a row at
      all, `storageState` is whether the last tenth has something to say about it. The desktop's
      subscription pane reads the same two. */
  const storFigures = storageFigures(sub);
  const storState = storageState(sub);

  return (
    <SettingsSection className="acct">
      <h2 className="acct-h">{t("title")}</h2>

      {error ? <p className="acct-warn" role="alert">{error}</p> : null}

      {/* ── What you are on ─────────────────────────────────────────────────────────── */}
      {s ? (
        <>
          <SettingsRow
            label={t(`plan_${s.plan}`)}
            description={`${t(`status_${s.status}`, { default: s.status })}${
              s.billingInterval === "year" ? ` ${t("billedAnnually")}` : ""}`}
            value={s.currentPeriodEnd
              /* A TRIAL DOES NOT RENEW, and saying it does contradicted `trialNote` below
                 ("no charge until then"). `trialing` is judged before `cancelAtPeriodEnd`
                 because it is true either way: at that date the trial ends — into a plan if a
                 card was added, into nothing if not — and "Trial ends" is the sentence that is
                 right in both futures. */
              ? t(trialing ? "trialEndsOn" : s.cancelAtPeriodEnd ? "endsOn" : "renewsOn", {
                  when: new Date(s.currentPeriodEnd).toLocaleDateString(undefined, { dateStyle: "medium" }),
                })
              : ""}
          />
          <SettingsRow
            label={t("mailboxes")}
            description={t("mailboxesSub")}
            value={`${sub?.balance !== undefined ? "" : ""}${ent?.mailboxLimit ?? s.mailboxLimit}`}
          />
          {/* THE BALANCE, AND WHAT IT MEANS RIGHT NOW.
              "Refilled each billing period" is true of a PLAN and false of a trial — a trial's
              allowance is a one-off bounty that does not come back — so the sublabel is chosen
              from the same derivation the Screener's line uses rather than being one fixed
              sentence. Where nothing unusual is going on (`aiCreditState` returns null) it is
              the original sentence, unchanged. */}
          <SettingsRow
            label={t("credits")}
            description={creditState ? tc(creditNote as never) : t("creditsSub")}
            value={String(sub?.balance ?? 0)}
          />
          {/* THE SETUP POOL — the screening-only credits each connected mailbox brings, spent
              before the balance above. Rendered only while something remains: a row that said
              "0" would demand an explanation of a pool most accounts have already drained. */}
          {sub?.setupCredits && sub.setupCredits.remaining > 0 ? (
            <SettingsRow
              label={t("setupCredits")}
              description={t("setupCreditsSub", {
                when: sub.setupCredits.expiresAt
                  ? new Date(sub.setupCredits.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })
                  : "",
              })}
              value={String(sub.setupCredits.remaining)}
            />
          ) : null}
          {/* ── STORAGE: the numbers, and — from ninety percent — the sentence. ──────────
              Rendered only when the server sent BOTH figures (an older server sends neither,
              and "0 GB of 0 GB" would be a broken claim). The sublabel is scoped to message
              CONTENT deliberately: the mailbox on the user's own server is never counted, and
              a row that just said "Storage" would read as a claim about their mail itself. */}
          {storFigures ? (
            <SettingsRow
              label={t("storage")}
              description={
                `${storState
                  ? t(storState.kind === "at_cap" ? "storageFull" : "storageNear")
                  : t("storageSub")} ${t("storageEmails", {
                  used: formatEmailCount(storFigures.usedBytes),
                  cap: formatEmailCount(storFigures.capBytes),
                })}`
              }
              value={t("storageOf", {
                used: formatStorageBytes(storFigures.usedBytes),
                cap: formatStorageBytes(storFigures.capBytes),
              })}
            />
          ) : null}
        </>
      ) : subFailed ? (
        /* A failed read is not an empty result — the read was refused, so this pane knows of no plan and knows of no
           absence of one. The reason is already on screen in the `role="alert"` above; adding
           "No plan yet." under it would be a contradiction on one card. */
        null
      ) : (
        <p className="acct-lead">{t("noPlan")}</p>
      )}

      {/* ── The AI switch. Always visible, including on trial. ───────────────────────── */}
      <h3 className="acct-sub">{t("aiTitle")}</h3>
      {/* WHY THE SWITCH CANNOT BE USED, FROM THE SAME DERIVATION EVERY OTHER SURFACE USES.
          This read `aiAllowed ? … : trialing ? aiOnTrial : aiNeedsPlan`, which decided the
          explanation from two booleans and got two cases flatly wrong. A SUSPENDED trial with a
          positive balance was told "Your trial's AI actions are used up" — beside the credit row
          on this same card correctly saying the account is suspended — because `aiEnabled` is
          false for a suspension and `trialing` is still true on the row. An account whose owner
          had switched managed AI off was told the same thing.
          `aiCreditState` already holds the whole truth table and `entitlements.reason` is the
          server's own word for it, so the sentence is chosen from that. The two literals stay as
          the fallback for the one state the derivation says nothing about (AI on, nothing
          unusual), where they were always right. */}
      <SettingsRow
        label={t("aiLabel")}
        description={
          // Spending is allowed ⇒ the ordinary sentence. `aiCreditState` would answer
          // `trial_credits` here, whose message takes a `{count}` this row has nowhere to put and
          // whose content the credit row above already renders.
          aiAllowed ? t("aiSub")
            : creditState ? tc(aiCreditMessageKey(creditState) as never)
              : trialing ? t("aiOnTrial") : t("aiNeedsPlan")
        }
        control={
          <Switch
            checked={ai === true && planAllowsAi}
            disabled={ai === null || !planAllowsAi}
            onChange={toggleAi}
            ariaLabel={t("aiLabel")}
          />
        }
      />
      {/* Managed AI is connected in production — the worker wires the classifier whenever
          ANTHROPIC_API_KEY is set (apps/worker/src/config.ts loadAiPorts). This switch is
          `accounts.ai_enabled`: turning it off runs mail on the deterministic rules, which also
          run when the AI credit balance is exhausted or the classifier circuit is open. The note
          states that fallback so a rules-only result never reads as an outage. */}
      <SettingsNote icon="spark">{t("aiBetaNote")}</SettingsNote>

      {/* ── Change plan / subscribe ──────────────────────────────────────────────────── */}
      {stage === "idle" ? (
        <>
          <h3 className="acct-sub">{s ? t("changeTitle") : t("chooseTitle")}</h3>
          {trialing ? <p className="acct-fine">{t("trialNote")}</p> : null}
          <div className="bill-plans">
            {PLANS.map((p) => {
              const card = cards[p];
              const current = s?.plan === p && !trialing;
              return (
                <button
                  key={p}
                  type="button"
                  className={current ? "bill-plan is-current" : "bill-plan"}
                  disabled={busy || current}
                  onClick={() => pressPlan(p)}
                >
                  <span className="bill-plan-name">{t(`plan_${p}`)}</span>
                  {card ? (
                    <>
                      <span className="bill-plan-price">{t("perMonth", { price: card.priceUsd })}</span>
                      <span className="bill-plan-meta">
                        {t("planMeta", { mailboxes: card.mailboxes, credits: card.monthlyCredits })}
                      </span>
                    </>
                  ) : null}
                  {current ? <span className="bill-plan-cur">{t("current")}</span> : null}
                </button>
              );
            })}
          </div>

          {/* ── Add-ons: +10 GB storage and +1 mailbox, each its own line item. ────────
              Only rendered with a subscription on screen; the ACTIVE requirement is stated
              (and enforced server-side — a trial has no card to charge). Quantities come from
              the mirror, so a press updates them when the webhook lands, not optimistically. */}
          {s ? (
            <>
              <h3 className="acct-sub">{t("addonsTitle")}</h3>
              {s.status !== "active" ? <p className="acct-fine">{t("addonNeedsActive")}</p> : null}
              <SettingsRow
                label={t("addonStorage")}
                description={t("addonStorageSub", { price: sub?.addons?.storage.priceUsd ?? 10 })}
                value={String(s.addonStorageUnits ?? 0)}
                control={
                  <span className="bill-addon-ctl">
                    <Button
                      disabled={addonBusy || s.status !== "active" || (s.addonStorageUnits ?? 0) <= 0}
                      onClick={() => setAddon("storage", (s.addonStorageUnits ?? 0) - 1)}
                    >
                      {t("addonRemove")}
                    </Button>
                    <Button
                      disabled={addonBusy || s.status !== "active"}
                      onClick={() => setAddon("storage", (s.addonStorageUnits ?? 0) + 1)}
                    >
                      {t("addonAdd")}
                    </Button>
                  </span>
                }
              />
              <SettingsRow
                label={t("addonMailbox")}
                description={t("addonMailboxSub", { price: sub?.addons?.mailbox.priceUsd ?? 3 })}
                value={String(s.addonMailboxes ?? 0)}
                control={
                  <span className="bill-addon-ctl">
                    <Button
                      disabled={addonBusy || s.status !== "active" || (s.addonMailboxes ?? 0) <= 0}
                      onClick={() => setAddon("mailbox", (s.addonMailboxes ?? 0) - 1)}
                    >
                      {t("addonRemove")}
                    </Button>
                    <Button
                      disabled={addonBusy || s.status !== "active"}
                      onClick={() => setAddon("mailbox", (s.addonMailboxes ?? 0) + 1)}
                    >
                      {t("addonAdd")}
                    </Button>
                  </span>
                }
              />
              <p className="acct-fine">{t("addonNote")}</p>
            </>
          ) : null}

          {/* ── Invoices + payment method: Stripe's portal, not a rebuild. ───────────── */}
          <h3 className="acct-sub">{t("invoicesTitle")}</h3>
          <p className="acct-fine">{t("invoicesBody")}</p>
          <div className="acct-actions">
            <Button
              variant="primary"
              icon="open"
              disabled={busy || !s}
              onClick={() => { setError(null); setStage("password"); }}
            >
              {t("openPortal")}
            </Button>
          </div>
          {!s ? <p className="acct-fine">{t("portalNeedsPlan")}</p> : null}
        </>
      ) : null}

      {/* ── The step-up the portal demands ───────────────────────────────────────────── */}
      {stage === "password" ? (
        <form className="acct-confirm" onSubmit={submitPassword}>
          <h3 className="acct-sub">{t("confirmTitle")}</h3>
          <p className="acct-fine">{t("confirmBody")}</p>
          <label className="join-label" htmlFor="bill-email">{t("accountEmail")}</label>
          <input id="bill-email" className="join-input" type="email" value={email ?? ""} readOnly />
          <label className="join-label" htmlFor="bill-pw">{t("accountPassword")}</label>
          <input
            id="bill-pw" className="join-input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required
          />
          <div className="acct-actions">
            <Button variant="primary" type="submit" disabled={busy || !email}>
              {busy ? t("working") : t("continue")}
            </Button>
            <Button onClick={() => { setStage("idle"); setPassword(""); setError(null); }}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {stage === "factor" ? (
        <div className="acct-confirm">
          <h3 className="acct-sub">{t("factorTitle")}</h3>
          <p className="acct-fine">{t("factorBody")}</p>
          {method === "webauthn" ? (
            <div className="acct-actions">
              <Button variant="primary" icon="shield" onClick={finishWithPasskey} disabled={busy}>
                {busy ? t("working") : t("passkey")}
              </Button>
            </div>
          ) : (
            <form onSubmit={finishWithCode}>
              <label className="join-label" htmlFor="bill-code">
                {method === "recovery_code" ? t("recoveryLabel") : t("totpLabel")}
              </label>
              <input
                id="bill-code" className="join-input join-code"
                inputMode={method === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                value={code} onChange={(e) => setCode(e.target.value)}
              />
              <div className="acct-actions">
                <Button variant="primary" type="submit" disabled={busy || code.trim().length === 0}>
                  {busy ? t("working") : t("verifyOpen")}
                </Button>
              </div>
            </form>
          )}
          <div className="acct-methods">
            {challenge?.methods.includes("totp") && method !== "totp" ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("totp"); setCode(""); }}>
                {t("totpToggle")}
              </button>
            ) : null}
            {challenge?.methods.includes("recovery_code") && method !== "recovery_code" ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("recovery_code"); setCode(""); }}>
                {t("useRecovery")}
              </button>
            ) : null}
            <button
              type="button" className="join-alt"
              onClick={() => { setStage("idle"); setChallenge(null); setCode(""); setError(null); setBusy(false); }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
