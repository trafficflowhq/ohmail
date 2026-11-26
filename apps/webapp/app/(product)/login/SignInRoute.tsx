"use client";

/**
 * `/login`: the sign-in's page over the sign-in's own ceremony (`use-sign-in-door.ts`, lifted word for word from the
 * old card, which has left); `page.tsx` hands it what it handed the card. The login token never leaves the ceremony,
 * and neither do the blanks: the page draws the ceremony's own, hands each change back and presses its acts, so the
 * lifted line that empties the password once the server has answered empties the blank a person sees. Only the
 * factors the account enrolled are offered, a passkey only where this browser can run the ceremony. The ways out to
 * the join and the demo are links, as the card's were, to the addresses written here.
 */
import { useTranslations } from "next-intl";
import { signupPosture } from "@ohmail/app/doors";
import { SignInPage, type SignInDoor, type SignInState } from "@ohmail/app/doors/sign-in";
import { webauthnAvailable } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { WebDoor } from "../door-device";
import { MANAGE_ROUTE, type Continuation } from "./continuation";
import { usePendingDoor } from "./use-pending-door";
import { FACTOR_OF, METHOD_OF, useSignInDoor, type SignInCeremony } from "./use-sign-in-door";

/** The submit a form would carry: the page holds the press itself, and the ceremony reads its own blanks. */
const PRESS = { preventDefault() {} };

function stateOf(c: SignInCeremony): SignInState {
  if (!c.configured) return { at: "unavailable" };
  if (c.stage === "password") return { at: "password", busy: c.busy, refusal: c.refusal };
  const offered = c.methods.filter((m) => m !== "webauthn" || webauthnAvailable()).map((m) => FACTOR_OF[m]);
  return { at: "factor", factor: FACTOR_OF[c.method], offered, busy: c.busy, refusal: c.refusal };
}

export function SignInRoute({ publicSignup = false, next = null, handoff = null, freshJoinSignIn = false }: {
  publicSignup?: boolean;
  next?: Continuation | null;
  handoff?: string | null;
  freshJoinSignIn?: boolean;
}) {
  const c = useSignInDoor({ next, handoff, freshJoinSignIn });
  const t = useTranslations("gate");
  const pending = usePendingDoor(c.pending);
  const door: SignInDoor = {
    state: stateOf(c),
    /* What this deployment asks a stranger for: read on the server and handed down; invite-only unless said. */
    note: signupPosture(SELF_HOST_BUILD, publicSignup),
    continues: next === null ? null : next === MANAGE_ROUTE ? "manage" : "join",
    why: c.signedOut,
    pending,
    fields: { email: c.email, password: c.password, code: c.code },
    type: (field, value) => ({ email: c.setEmail, password: c.setPassword, code: c.setCode })[field](value),
    begin: () => c.submitPassword(PRESS),
    passkey: c.finishWithPasskey,
    finish: () => c.finishWithCode(PRESS),
    use: (factor) => {
      c.setMethod(METHOD_OF[factor]);
      c.setCode("");
    },
    restart: c.restart,
    join: { href: "/join" },
    forgotPassword: { href: "/forgot-password" },
    back: SELF_HOST_BUILD ? undefined : "/",
    demo: { href: "/?demo=1" },
  };
  return (
    <WebDoor>
      {handoff !== null && <p role={c.invalidHandoff ? "alert" : undefined}>
        {t(c.invalidHandoff ? "settingsHandoffInvalid" : "settingsHandoffSignIn")}
      </p>}
      {c.invalidHandoff ? null : <SignInPage door={door} />}
    </WebDoor>
  );
}
