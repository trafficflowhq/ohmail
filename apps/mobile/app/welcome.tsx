import { View } from "react-native";
import { Redirect, router } from "expo-router";
import { Copy } from "../src/copy";
import { phoneEngineStart } from "../src/engine/engine-artifact";
import { standaloneAvailable } from "../src/engine/standalone-door";
import { useLocale } from "../src/i18n/LocaleProvider";
import { useConnection } from "../src/net/connection";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { points } from "../src/theme/onboarding";
import { Txt } from "../src/ui/base";
import { WelcomeWordmark } from "../src/ui/Icon";
import { usePosture } from "../src/ui/posture";
import { OnboardingButton, OnboardingPage, useOnboardingLook, useOnboardingTitle } from "../src/ui/OnboardingPage";

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
  if (conn.state.k === "live") return <Redirect href="/" />;

  const canOrganize = standaloneAvailable({ startEngine: phoneEngineStart() });
  return (
    <OnboardingPage
      centered={!short}
      row={short}
      aside={<OnboardingButton label={Copy.serversTitle} short kind="quiet" onPress={() => router.push("/servers")} />}
      actions={
        <>
          {canOrganize ? (
            <OnboardingButton label={Copy.welcomeConnect} grow={short} onPress={() => router.push("/standalone")} />
          ) : null}
          <OnboardingButton
            label={Copy.welcomeScan}
            grow={short}
            kind={canOrganize ? "quiet" : "ink"}
            onPress={() => router.push("/scan")}
          />
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
