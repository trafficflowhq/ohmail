"use client";

/**
 * `/verify-email` as the web serves it: the email confirmation's page over the confirmation's own ceremony
 * (`use-verify-door.ts`). The link's code stays in the ceremony: the page gets a blank for it only where the link
 * brought none. Sign in, and the sign-in for a fresh link, leave as a document; the ceremony's own way on to `/join`
 * is its router's, as it was.
 */
import { useTranslations } from "next-intl";
import { VerifyPage, type VerifyDoor, type VerifyField, type VerifyState } from "@ohmail/app/doors/verify";
import { WebDoor } from "../door-device";
import { usePendingDoor } from "../login/use-pending-door";
import { useVerifyDoor, type VerifyCeremony } from "./use-verify-door";

const toSignIn = (): void => { window.location.assign("/login"); };
/** The sign-in that carries on into the setup: where a fresh link is sent. */
const toNewLink = (): void => { window.location.assign("/login?next=join"); };

/** `wrongPassword`: the ceremony's own sentence for a refused password, so the page marks that blank. */
function stateOf(c: VerifyCeremony, asksCode: boolean, wrongPassword: string): VerifyState {
  if (!c.configured) return { at: "unavailable" };
  if (c.handedOff) return { at: "handed" };
  if (c.done) return { at: "done" };
  return {
    at: "form",
    asksCode,
    codeHeld: c.token.trim().length > 0,
    busy: c.busy,
    refusal: c.error,
    passwordRefused: c.error !== null && c.error === wrongPassword,
  };
}

export function VerifyRoute({ initialToken }: { initialToken: string }) {
  const c = useVerifyDoor({ initialToken });
  const t = useTranslations("verify");
  const pending = usePendingDoor(c.pending);
  /* The code is typed back only where the link brought none; the link's own never reaches the page. */
  const asksCode = !initialToken;
  const set: Record<VerifyField, (v: string) => void> = { code: c.setToken, password: c.setPassword };
  const door: VerifyDoor = {
    state: stateOf(c, asksCode, t("refusedPassword")),
    fields: { code: asksCode ? c.token : "", password: c.password },
    type: (field, value) => set[field](value),
    submit: () => c.submit({ preventDefault() {} }),
    signIn: toSignIn,
    newLink: toNewLink,
    pending,
  };
  return (
    <WebDoor>
      <VerifyPage door={door} />
    </WebDoor>
  );
}
