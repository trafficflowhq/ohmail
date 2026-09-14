import { createLogger, type Logger } from "@trafficflow/core/mail";
// TYPE-ONLY, as in `drafting-service.ts`: this module is compiled into the desktop engine, which
// carries no hosted half. It names an access reader it may be handed and builds none.
import type { AccessPort, AiRefusalReason } from "@trafficflow/db";
import { ServiceError } from "./errors.js";

/**
 * ONE ANSWER FOR AN AI SPEND REFUSAL, FOR BOTH CALL SITES THAT MAKE ONE.
 *
 * The Screener's press and the drafting route decided this separately and drifted: both collapsed
 * every `state` reason — a subscription the program could not classify included — into 402 "no AI
 * actions remain on this account", and neither wrote a line saying so. A funded account was told
 * to buy credits it already had, and the server's own logs could not say which reason had done
 * it. The rule lives here so the two cannot disagree again.
 *
 * WHAT A 402 NOW REQUIRES. A payment demand is the one answer that cannot be taken back — the
 * person goes and buys something — so it is the one answer that has to be corroborated. `quantity`
 * (an empty balance) is its own corroboration and is unchanged. A `state` refusal is cross-checked
 * against a FRESH read of the account's access: if that read says AI is available on this account,
 * the two halves of the credit check disagree and we do not know which is right — which is a
 * fault, answered 503 and never a bill.
 */

/** The class of refusal the wire already carries. `fault` is never a payment demand. */
export type AiRefusalClass = "quantity" | "state" | "fault";

/** What the gate answered and why, as the caller read it. */
export interface AiRefusalFacts {
  /** The class this caller derived from the port's verdict. */
  refusal: AiRefusalClass;
  /** The port's own word — `insufficient`, `refused`, `fault` — kept for the log line. */
  verdict: string;
  /** The program's reason, when it named one. */
  reason?: AiRefusalReason;
}

/** The two events this module emits, one per call site. */
export type AiRefusalEvent = "screener_suggest_refused" | "draft_refused";

export interface AiRefusalOptions {
  /** Which call site refused. */
  event: AiRefusalEvent;
  /** The account, for the log line. The logger's own field census decides what it does with it. */
  accountId: string;
  /**
   * The access half, when this host composed one. ABSENT means the cross-check cannot run, and
   * then a `state` refusal answers exactly what it answered before this module existed — an
   * unmetered host reaches no refusal at all, and a metered one that never wired the reader is
   * no worse off than it was.
   */
  access?: AccessPort;
  /** The 503 sentence this surface says. The two differ ("suggestions" / "drafting"). */
  unavailable: string;
  /** Injectable for tests; the module's own logger otherwise. */
  log?: Logger;
}

const defaultLog = createLogger({ service: "ai-refusal" });

/**
 * Log the refusal, then throw the answer this account has earned. ALWAYS throws.
 *
 * The order matters: the line is written for every refusal, including the ones that go on to be
 * 402s, because the question an operator arrives with is "why did this account see that", and a
 * line written only on the interesting branch answers it only when somebody already knew.
 */
export async function refuseAiSpend(facts: AiRefusalFacts, opts: AiRefusalOptions): Promise<never> {
  const log = opts.log ?? defaultLog;
  const fields = {
    accountId: opts.accountId,
    verdict: facts.verdict,
    refusal: facts.refusal,
    ...(facts.reason ? { reason: facts.reason } : {}),
  };
  log.warn(opts.event, fields);

  // OUR fault. 503, and not because of the cross-check: we do not bill for our own outage.
  if (facts.refusal === "fault") throw new ServiceError("ai_unavailable", 503, opts.unavailable);

  // The ACCOUNT'S OWN off switch — 409, never 402. Fully funded, and nothing they could buy
  // changes it. Checked by REASON rather than class, which is how both call sites already read
  // it: the switch arrives as `refused` from one implementation and `insufficient` from another.
  if (facts.reason === "ai_disabled") {
    throw new ServiceError(
      "ai_disabled", 409, "managed AI is switched off for this account", { reason: facts.reason },
    );
  }

  // A STATE REFUSAL THE ACCESS VIEW CONTRADICTS IS A FAULT, NOT A BILL.
  //
  // `quantity` never comes here: an empty balance is a fact about the ledger, the one refusal a
  // payment fixes, and asking a second question about it would only add a way to get it wrong.
  if (facts.refusal === "state" && opts.access) {
    // `fresh`, because the held verdict is the very thing under suspicion: a refusal cached a
    // minute ago is exactly what outlives the condition that produced it.
    const view = await opts.access.access(opts.accountId, { fresh: true }).catch(() => null);
    if (view?.ok === true && view.limits.aiEnabled) {
      log.warn("refusal_contradicted_by_access", fields);
      throw new ServiceError("ai_unavailable", 503, opts.unavailable);
    }
  }

  // `details` carries the reason exactly as both call sites carried it before this module: the
  // client tells "buy more" from "fix your subscription" with it, and an absent reason stays an
  // absent key rather than becoming a second shape.
  throw new ServiceError(
    "insufficient_credits", 402, "no AI actions remain on this account", { reason: facts.reason },
  );
}
