"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button, Page } from "@ohmail/ui/base";
import { DoorForm, Said, SaidWith, SentenceBlank, WayButton } from "@ohmail/app/doors/stage";
import { auth, codeOf } from "../../api-client";
import { WebDoor } from "../door-device";

export function ForgotPasswordRoute() {
  const t = useTranslations("passwordReset");
  const locale = useLocale();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    const address = sent ?? email.trim();
    if (!address) {
      setRefusal(t("emailRequired"));
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await auth.requestPasswordReset({ email: address, locale: locale === "de" ? "de" : "en" });
      setSent(address);
    } catch (error) {
      switch (codeOf(error)) {
        case "validation_failed": setRefusal(t("emailRequired")); break;
        case "rate_limited": setRefusal(t("rateLimited")); break;
        default: setRefusal(t("sendRefused"));
      }
    } finally {
      setBusy(false);
    }
  }

  const signIn = <WayButton way={{ href: "/login" }} kind="quiet">{t("signIn")}</WayButton>;
  return (
    <WebDoor>
      {sent === null ? (
        <DoorForm onSubmit={() => void submit()}>
          <Page
            refusal={refusal ? [refusal] : undefined}
            back={signIn}
            acts={<Button type="submit" size="l" keyHint="↵" label={t(busy ? "sending" : "send")} disabled={busy}>{t(busy ? "sending" : "send")}</Button>}
          >
            <SaidWith level={1} parts={t.rich("sendTo", {
              blank: () => (
                <SentenceBlank
                  label={t("emailLabel")}
                  placeholder={t("emailHint")}
                  size={t("emailHint").length}
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(value) => { setEmail(value); setRefusal(null); }}
                />
              ),
            })} />
          </Page>
        </DoorForm>
      ) : (
        <Page
          line={t("expires")}
          refusal={refusal ? [refusal] : undefined}
          back={signIn}
          acts={<Button size="l" kind="quiet" disabled={busy} onPress={() => void submit()}>{t(busy ? "sending" : "sendAgain")}</Button>}
        >
          <Said level={1} text={t("sent", { email: sent })} dot="ink" />
        </Page>
      )}
    </WebDoor>
  );
}
