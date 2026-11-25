"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MAX_LENGTH, MIN_LENGTH } from "@ohmail/app/account/password";
import { DoorForm, Said, SaidWith, SentenceBlank, WayButton } from "@ohmail/app/doors/stage";
import { Button, Page } from "@ohmail/ui/base";
import { auth, codeOf } from "../../api-client";
import { WebDoor } from "../door-device";

export function ResetPasswordRoute({ initialToken }: { initialToken: string }) {
  const t = useTranslations("passwordReset");
  const [state, setState] = useState<"form" | "done" | "refused">(initialToken ? "form" : "refused");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  async function submit() {
    if (busy) return;
    const length = [...password].length;
    if (length < MIN_LENGTH) { setRefusal(t("tooShort")); return; }
    if (length > MAX_LENGTH) { setRefusal(t("tooLong")); return; }
    if (password !== again) { setRefusal(t("mismatch")); return; }
    setBusy(true);
    setRefusal(null);
    try {
      await auth.completePasswordReset({ token: initialToken, password });
      setState("done");
    } catch (error) {
      const code = codeOf(error);
      if (code === "invalid_token") setState("refused");
      else setRefusal(t(code === "session_conflict" ? "otherAccount" : "changeRefused"));
    } finally {
      setPassword("");
      setAgain("");
      setBusy(false);
    }
  }

  const done = state === "done";
  const signIn = <WayButton way={{ href: "/login" }} kind="quiet">{t("signIn")}</WayButton>;
  return (
    <WebDoor>
      {state === "form" ? (
        <DoorForm onSubmit={() => void submit()}>
          <Page
            refusal={refusal ? [refusal] : undefined}
            back={signIn}
            acts={<Button type="submit" size="l" keyHint="↵" label={t(busy ? "changing" : "setPassword")} disabled={busy}>{t(busy ? "changing" : "setPassword")}</Button>}
          >
            <SaidWith level={1} parts={t.rich("myPassword", {
              blank: () => (
                <SentenceBlank
                  type="password"
                  autoComplete="new-password"
                  label={t("passwordLabel")}
                  placeholder={t("minimum")}
                  size={t("minimum").length}
                  value={password}
                  onChange={(value) => { setPassword(value); setRefusal(null); }}
                />
              ),
            })} />
            <SaidWith parts={t.rich("onceMore", {
              blank: () => (
                <SentenceBlank
                  type="password"
                  autoComplete="new-password"
                  label={t("repeatLabel")}
                  placeholder={t("repeatHint")}
                  size={t("repeatHint").length}
                  value={again}
                  onChange={(value) => { setAgain(value); setRefusal(null); }}
                />
              ),
            })} />
          </Page>
        </DoorForm>
      ) : (
        <Page
          back={done ? undefined : signIn}
          line={t(done ? "doneLine" : "refusedLine")}
          acts={<WayButton way={{ href: done ? "/login" : "/forgot-password" }} size="l">{t(done ? "signIn" : "newLink")}</WayButton>}
        >
          <Said level={1} text={t(done ? "done" : "refused")} dot="ink" />
        </Page>
      )}
    </WebDoor>
  );
}
