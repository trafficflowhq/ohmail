import { useEffect, useRef, useState } from "react";
import { BackHandler, View } from "react-native";
import { Redirect, router } from "expo-router";
import { Copy } from "../src/copy";
import { useLocale } from "../src/i18n/LocaleProvider";
import { useConnection } from "../src/net/connection";
import { refuse, sayRefusal, type Refusal } from "../src/refusal";
import { Field } from "../src/ui/Field";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { points } from "../src/theme/onboarding";
import { Txt } from "../src/ui/base";
import { WelcomeWordmark } from "../src/ui/Icon";
import { usePosture } from "../src/ui/posture";
import { OnboardingButton, OnboardingPage, OnboardingTitle, useOnboardingLook, useOnboardingTitle } from "../src/ui/OnboardingPage";

export default function WelcomeScreen() {
  return (
    <SurfaceBoundary surface="welcome">
      <WelcomeBody />
    </SurfaceBoundary>
  );
}

function WelcomeBody() {
  useLocale();
  const conn = useConnection();
  const { palette, type } = useOnboardingLook();
  const short = usePosture().heightClass === "compact";
  const title = useOnboardingTitle(Copy.welcomeTitle, short, "ink");
  const [way, setWay] = useState<"cloud" | "server" | null>(null);
  const [address, setAddress] = useState("");
  const [waiting, setWaiting] = useState(false);
  const finishing = waiting && conn.state.k === "connecting";
  const [problem, setProblem] = useState<Refusal | null>(null);
  const pending = useRef<AbortController | null>(null);
  const back = () => {
    if (finishing) return;
    pending.current?.abort();
    pending.current = null;
    setWaiting(false);
    setProblem(null);
    setAddress("");
    setWay(null);
  };
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (way === null) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [way, finishing]);

  const signIn = async (target: string | null) => {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setWaiting(true);
    setProblem(null);
    if (target?.includes("#") || target?.includes("@")) setAddress("");
    try {
      const outcome = await conn.signIn(target, request.signal);
      if (request.signal.aborted) return;
      if (outcome.ok) router.replace("/");
      else setProblem(outcome.reason);
    } catch {
      if (!request.signal.aborted) setProblem(refuse("signInRefused"));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setWaiting(false);
      }
    }
  };
  if (conn.state.k === "live" || conn.state.k === "shell") return <Redirect href="/" />;

  if (way !== null) {
    return (
      <OnboardingPage
        back={finishing ? undefined : back}
        actions={way === "server" && !waiting && (
          <OnboardingButton label={Copy.doorSelfGo} onPress={() => void signIn(address)} />
        )}
      >
        <OnboardingTitle text={way === "cloud" ? Copy.welcomeSignIn : Copy.welcomeSignInSelfHosted} compact={short} />
        {waiting ? <Txt accessibilityLiveRegion="polite">{finishing ? Copy.signInFinishing : Copy.signInWaiting}</Txt> : null}
        {problem ? <Txt accessibilityRole="alert">{sayRefusal(problem)}</Txt> : null}
        {way === "server" && !waiting ? (
          <Field value={address} onChange={setAddress} label={Copy.signInServerAddress}
            input={{ autoCapitalize: "none", autoCorrect: false, keyboardType: "url", onSubmitEditing: () => void signIn(address) }} />
        ) : null}
      </OnboardingPage>
    );
  }

  return (
    <OnboardingPage
      centered={!short}
      row={short}
      actionBelow={
        <OnboardingButton label={Copy.welcomeSignInSelfHosted} short kind="quiet" subtle onPress={() => setWay("server")} />
      }
      actions={
        <>
          <OnboardingButton label={Copy.welcomeScan} grow={short} onPress={() => router.push("/scan")} />
          <OnboardingButton label={Copy.welcomeSignIn} grow={short} kind="soft" onPress={() => {
            setWay("cloud");
            void signIn(null);
          }} />
        </>
      }
    >
      <View style={{ gap: 24, maxWidth: 266, paddingTop: short ? 0 : 20 }}>
        <WelcomeWordmark color={palette.ink} dot={palette.hot} em={points(type["t-mark"])} />
        <Txt accessibilityRole="header" {...title} />
      </View>
    </OnboardingPage>
  );
}
