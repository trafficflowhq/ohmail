"use client";

/**
 * `/setup` as the web serves it: the server setup's page over the setup's own ceremony (`use-setup-door.ts`). Sign in
 * leaves as a document; the ceremony's own way on to `/join` is its router's, as it was.
 */
import { useTranslations } from "next-intl";
import { SetupPage, type SetupDoor, type SetupField, type SetupState } from "@ohmail/app/doors/setup";
import { WebDoor } from "../door-device";
import { useSetupDoor, type SetupCeremony } from "./use-setup-door";

const toSignIn = (): void => { window.location.assign("/login"); };
/** The log command to the clipboard, where the browser grants one. */
const copy = (text: string): Promise<boolean> =>
  navigator.clipboard ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);

/** `badToken`: the ceremony's own sentence for a refused token, so the page marks that blank. */
function stateOf(c: SetupCeremony, badToken: string): SetupState {
  if (c.phase === "setup") {
    return { at: "form", busy: c.busy, refusal: c.error, tokenRefused: c.error !== null && c.error === badToken };
  }
  return { at: c.phase };
}

export function SetupRoute() {
  const c = useSetupDoor();
  const t = useTranslations("setup");
  const set: Record<SetupField, (v: string) => void> = {
    token: c.setToken, email: c.setEmail, name: c.setDisplayName, password: c.setPassword,
  };
  const door: SetupDoor = {
    state: stateOf(c, t("badToken")),
    fields: { token: c.token, email: c.email, name: c.displayName, password: c.password },
    type: (field, value) => set[field](value),
    submit: () => c.submit({ preventDefault() {} }),
    retry: () => { void c.checkServer(); },
    signIn: toSignIn,
    copy,
  };
  return (
    <WebDoor>
      <SetupPage door={door} />
    </WebDoor>
  );
}
