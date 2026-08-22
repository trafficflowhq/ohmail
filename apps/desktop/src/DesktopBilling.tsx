/**
 * SETTINGS → SUBSCRIPTION, on the hosted door — the plan this account is on, the AI switch, and
 * the way out to the place where money is moved.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────
 *
 * The pane did not exist. An install mirroring a hosted account had no way to see which plan it
 * was on, how many AI actions were left, when the period renews, or whether managed AI was on —
 * and no way to turn managed AI off, which is a control the same account has in a browser tab.
 * The nav simply had one fewer entry than the web client's and nothing said why.
 *
 * ── FACTS HERE, MONEY IN THE BROWSER, AND THE LINE BETWEEN THEM IS NOT ARBITRARY ────────────
 *
 * `GET /billing/subscription` and `GET/PATCH /account/ai` are ordinary reads and one ordinary
 * write. The engine serves none of them locally on this door — they are not in `cloud-read.ts` —
 * so all three are relayed to the account with its bearer, and what is shown and switched is the
 * account's own row. There is nothing about them a browser could do that this window cannot.
 *
 * CHECKOUT AND THE BILLING PORTAL are different in kind. Both are `stepUp`-gated: they expose the
 * payment method and the cancel control, so the account demands a second factor asserted within
 * the last few minutes, and nothing this app can do re-asserts one — it holds no password, no
 * authenticator secret, and a passkey ceremony needs a real browser origin this window does not
 * have. So they are a door out, not a form. Stripe's portal is also where invoices live, which is
 * deliberate on the web side too: it holds the authoritative record, and a second copy of billing
 * history is a copy that can disagree with the one an accountant will ask for.
 *
 * ── A FAILED READ IS NOT AN EMPTY RESULT ────────────────────────────────────────────────────
 *
 * The web pane learned this expensively: `sub === null` meant both "this account has no
 * subscription" and "we could not ask", so a refused read told a paying subscriber they had no
 * plan and offered them a second checkout. The states are kept apart here for the same reason,
 * and this door has a third that a browser tab does not — an install that is simply OFFLINE,
 * whose engine answers `503` before it forwards anything. That is a plan that exists and cannot
 * be reached right now, which is not the same sentence as either of the others.
 *
 * ── THE STORAGE ROW, AND WHY THE DERIVATION IS IMPORTED RATHER THAN WRITTEN ──────────────────
 *
 * The hosted tier stores message bodies so a browser tab and this account's other devices can
 * read mail without reaching the mail server themselves, and that store has a per-account byte
 * cap. This row is the account's own two numbers against it — in BOTH forms, because they answer
 * different questions: bytes are the figure the cap is actually enforced in, and an email count
 * is the figure a person can picture. Neither is a substitute for the other, so both are shown.
 *
 * `storageFigures`, `storageState`, `formatStorageBytes` and `formatEmailCount` come from
 * `apps/webapp/app/shell/storage-state.ts` — the same four the browser tab's billing pane calls,
 * over the same `GET /billing/subscription` fields. Nothing about storage is computed here: the
 * threshold, the byte formatter and the bytes-per-email estimate all have exactly one definition
 * in the tree, and a person comparing this window against a browser tab on the same account is
 * comparing one derivation with itself. A copy of the arithmetic would be a second thing to keep
 * true, and the number it would eventually get wrong is one somebody paid for.
 *
 * WHAT THE COPY IS CAREFUL ABOUT. The cap counts stored message BODY text, and nothing else:
 * attachment bytes are never stored server-side at all, so they can never count against it, and
 * the mailbox on the account's own server is not a hosted copy and is never counted either. At
 * the cap the store is a rolling window — the oldest stored copies make room and mail keeps
 * arriving and keeps being organized — so the sentence must not read as a threat to mail that
 * already exists, because nothing is deleted from the mailbox. The catalogue strings say all of
 * that; this note is here so a future edit to them knows which parts are load-bearing.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection, SettingsSubhead, Switch } from "@ohmail/ui";

import { bridgeFetch } from "./bridge-fetch.js";
import { openWeb } from "./native.js";
import type { SubscriptionStatus } from "../../webapp/app/api-client";
import {
  formatEmailCount,
  formatStorageBytes,
  storageFigures,
  storageState,
} from "../../webapp/app/shell/storage-state";

/**
 * The hosted routes this pane addresses, root-relative like every path in this window.
 *
 * Exported for the same reason `local-away.ts` exports its one: the engine must FORWARD all three
 * on this door rather than answer them out of the mirror, which holds no ledger and no plan.
 */
export const BILLING_PATH = "/billing/subscription";
export const AI_PATH = "/account/ai";

/** The engine answers this before it forwards anything, while the account is out of reach. */
const OFFLINE = 503;

type Read =
  | { state: "loading" }
  | { state: "ready"; sub: SubscriptionStatus }
  /** The account holds a plan and this install cannot reach it at the moment. */
  | { state: "offline" }
  /** We asked and were refused — never rendered as "no plan". */
  | { state: "failed" };

/** Milliseconds → the date this locale writes. The same shape the rest of the window uses. */
function when(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "—" : at.toLocaleDateString();
}

/**
 * The statuses the catalogue has a word for. A CLOSED list, checked before it is asked for.
 *
 * Stripe's status vocabulary is Stripe's and can grow; `useTranslations` THROWS on a key it does
 * not hold, so asking for `webStatus_<whatever-arrived>` would turn one unfamiliar subscription
 * state into a settings pane that does not render at all. An unknown status falls back to the
 * server's own word, which is at worst untranslated and at best exactly right.
 */
const KNOWN_STATUS = ["active", "trialing", "past_due", "canceled", "incomplete", "unpaid"] as const;
const isKnownStatus = (s: string): s is (typeof KNOWN_STATUS)[number] =>
  (KNOWN_STATUS as readonly string[]).includes(s);

/**
 * The tier names, here rather than in the catalogue, because they are the same word in every
 * language it holds — `billing.plan_solo` is "Solo" in both `en.json` and `de.json`. A key whose
 * two translations are identical is a key that invites one of them to drift.
 */
const PLAN_NAME: Record<string, string> = { solo: "Solo", plus: "Plus", pro: "Pro" };

export function DesktopBilling() {
  /**
   * THE `settings` NAMESPACE, NOT `billing`, AND THAT IS NOT A FILING PREFERENCE.
   *
   * The web pane's namespace carries the plan cards, the three prices and the whole step-up
   * ceremony — none of which this pane renders, because checkout and the portal are a door out.
   * Pulling it in would put all of it in the desktop binary: `SHELL_MESSAGE_NAMESPACES` in
   * `vite.config.ts` ships whole namespaces, and `desktop-messages.test.ts` bans a price and the
   * metering unit from what survives that filter — a rule written after `strings` on a shipped
   * `.deb` printed `$9 a month` for an app with no account. The ban is right and it caught this:
   * one build serves BOTH doors, so a standalone install would carry the plan-card vocabulary it
   * can never render. What this pane needs is a dozen strings, and they live where the rest of the
   * desktop's settings copy lives.
   */
  const ts = useTranslations("settings");

  const [read, setRead] = useState<Read>({ state: "loading" });
  /** `null` while unknown — the switch is drawn but not pressable until the account has answered. */
  const [ai, setAi] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await bridgeFetch(BILLING_PATH);
        if (cancelled) return;
        if (res.status === OFFLINE) { setRead({ state: "offline" }); return; }
        if (!res.ok) { setRead({ state: "failed" }); return; }
        setRead({ state: "ready", sub: (await res.json()) as SubscriptionStatus });
      } catch {
        if (!cancelled) setRead({ state: "failed" });
      }
      try {
        const res = await bridgeFetch(AI_PATH);
        if (!cancelled && res.ok) setAi(((await res.json()) as { aiEnabled: boolean }).aiEnabled);
      } catch {
        /* Left unknown. The switch says so by being unpressable rather than by guessing a
           position — a managed-AI switch drawn OFF for an account that has it ON is a claim
           about what that account is spending. */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Flip managed AI and render what the account answered.
   *
   * Not optimistic, unlike the web pane's copy of this switch, and the difference is the transport
   * rather than the policy: a forwarded write can be refused by a `503` this window produces
   * itself, and a switch that had already moved would be showing a setting that is not in force.
   */
  const toggleAi = (next: boolean): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void (async () => {
      try {
        const res = await bridgeFetch(AI_PATH, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aiEnabled: next }),
        });
        if (!res.ok) throw new Error("refused");
        setAi(((await res.json()) as { aiEnabled: boolean }).aiEnabled);
      } catch {
        setProblem(ts("webSaveFailed"));
      } finally {
        setBusy(false);
      }
    })();
  };

  const sub = read.state === "ready" ? read.sub : null;
  /* The SERVER's answer about whether this account MAY spend on AI, kept apart from the switch's
     own position, because they are two different facts: a plan can allow managed AI while the
     account has it switched off. Collapsing them would draw a control that is off because it was
     turned off exactly like one that is off because the plan does not include it — and only the
     second has a remedy. The web pane draws them as two for the same reason. */
  const planAllowsAi = sub?.entitlements.aiEnabled ?? false;
  /* TWO QUESTIONS, both answered by the shared module and neither by this file. `storageFigures`
     is whether there is a row at all — an older server sends neither number and a zero cap is
     the suspended-account shape, and in both cases the honest row is no row rather than "0 of 0".
     `storageState` is what the last tenth adds: below ninety percent the numbers say everything
     worth saying, so the sublabel stays the plain description. */
  const storFigures = storageFigures(sub);
  const storState = storageState(sub);
  const row = sub?.subscription ?? null;
  const planLine = row
    ? `${PLAN_NAME[row.plan] ?? row.plan} · ${isKnownStatus(row.status) ? ts(`webStatus_${row.status}` as never) : row.status}`
    : "—";

  return (
    <SettingsSection>
      {problem ? <p className="join-error">{problem}</p> : null}

      {read.state === "loading" ? <p className="set-note-inline">{ts("webLoading")}</p> : null}
      {/* THE TWO ABSENCES, SAID DIFFERENTLY — see the header. Neither is "no plan". */}
      {read.state === "offline" ? <p className="set-note-inline">{ts("webOffline")}</p> : null}
      {read.state === "failed" ? <p className="set-note-inline">{ts("webUnavailable")}</p> : null}

      {sub ? (
        <>
          <SettingsRow
            label={ts("billing")}
            description={
              row
                ? row.cancelAtPeriodEnd
                  ? ts("webPlanEnds", { when: when(row.currentPeriodEnd) })
                  : ts("webPlanRenews", { when: when(row.currentPeriodEnd) })
                : ts("webPlanNone")
            }
            value={planLine}
          />
          <SettingsRow
            label={ts("webMailboxes")}
            description={ts("webMailboxesSub")}
            value={String(sub.entitlements.mailboxLimit)}
          />
          <SettingsRow
            label={ts("webBudget")}
            description={ts("webBudgetSub")}
            value={String(sub.balance)}
          />
          {/* THE SETUP POOL — the screening-only credits each connected mailbox brings, spent
              before the budget above. Rendered only while something remains, exactly as in the
              browser tab: a row reading "0" would demand an explanation of a pool most accounts
              have already drained. It is an ordinary field of the same read, so withholding it
              here was a lag rather than a decision. */}
          {sub.setupCredits && sub.setupCredits.remaining > 0 ? (
            <SettingsRow
              label={ts("webSetupCredits")}
              description={ts("webSetupCreditsSub", { when: when(sub.setupCredits.expiresAt) })}
              value={String(sub.setupCredits.remaining)}
            />
          ) : null}
          {/* STORAGE — the numbers, in both forms, and from ninety percent the sentence too.
              Same shape as the browser tab's row and the same four functions behind it; see the
              header for why none of the arithmetic is written out here. */}
          {storFigures ? (
            <SettingsRow
              label={ts("webStorage")}
              description={`${
                storState
                  ? ts(storState.kind === "at_cap" ? "webStorageFull" : "webStorageNear")
                  : ts("webStorageSub")
              } ${ts("webStorageEmails", {
                used: formatEmailCount(storFigures.usedBytes),
                cap: formatEmailCount(storFigures.capBytes),
              })}`}
              value={ts("webStorageOf", {
                used: formatStorageBytes(storFigures.usedBytes),
                cap: formatStorageBytes(storFigures.capBytes),
              })}
            />
          ) : null}

          <SettingsSubhead>{ts("webAiTitle")}</SettingsSubhead>
          <SettingsRow
            label={ts("webAiLabel")}
            description={planAllowsAi ? ts("webAiSub") : ts("webAiNeedsPlan")}
            control={
              <Switch
                checked={ai === true && planAllowsAi}
                disabled={ai === null || !planAllowsAi || busy}
                onChange={toggleAi}
                ariaLabel={ts("webAiLabel")}
              />
            }
          />
        </>
      ) : null}

      {/* THE DOOR OUT. Rendered whatever the read did — an account that could not be reported on
          is exactly the account somebody most wants to go and look at, and the browser can reach
          it when this window's engine cannot. */}
      <SettingsSubhead>{ts("webInvoicesTitle")}</SettingsSubhead>
      <SettingsRow
        label={ts("webBillingTitle")}
        description={ts("webBillingWhy")}
        control={
          <Button onClick={() => void openWeb("billing").catch(() => setProblem(ts("webNoBrowser")))}>
            {ts("webOpen")}
          </Button>
        }
      />
      <SettingsNote>{ts("webBillingNote")}</SettingsNote>
    </SettingsSection>
  );
}
