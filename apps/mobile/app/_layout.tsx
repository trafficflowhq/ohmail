/**
 * The shell: providers, then a stack of screens on the Blanc canvas. Theme
 * preference lives in the prefs store, read inside that provider — hence the
 * `Shell` split. The language sits outermost: the copy deck is a module
 * import, so the provider resolves the deck before any screen renders
 * (`useLocale()` subscribes). The face resolves there too via `resolveFace`
 * (`src/theme/face.ts`), device pin + synced consent read — why `Shell` sits
 * inside `WorldProvider`. The engine registers at module scope: the chooser
 * reads the registry at render time, so a later registration shows three doors.
 */
import { useMemo } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, resolveFace, useTheme } from "../src/theme";
import { ConnectionProvider } from "../src/net/connection";
import { PrefsProvider, usePrefs } from "../src/state/store";
import { WorldProvider, useWorld } from "../src/state/world";
import { WakeProvider } from "../src/state/wake";
import { Toast } from "../src/ui/chrome";
import { LocaleProvider, useLocale } from "../src/i18n/LocaleProvider";
import { secureKV } from "../src/state/servers-native";
import { registerBundledPhoneEngine } from "../src/engine/engine-bundle-native";

/* Before the first render, for the reason in the header. The answer is the registry's — `false`
   would mean a second engine, which one artifact cannot produce — and it is read by nothing, so
   the call stands alone rather than pretending to a decision. */
registerBundledPhoneEngine();

export default function RootLayout() {
  /* One keystore binding for the app's lifetime, like the profile store's. The provider holds it
     in a ref, so a fresh object per render would be harmless — this is tidiness, not correctness. */
  const kv = useMemo(secureKV, []);
  return (
    <SafeAreaProvider>
      <LocaleProvider kv={kv}>
      <PrefsProvider>
        {/* The connection layer sits at the root so a live session survives every screen.
            The world layer above the screens renders its mirror; with nothing connected
            the tabs gate hands the screen to the connect flow instead. */}
        <ConnectionProvider>
          <WorldProvider>
            {/* The wake lifecycle sits HERE, not in Settings. It owns the one subscription that
                turns a delivered wake into a sync, and the app's copy promises that works
                "while ohmail is running — open or in the background". Mounted on a screen, it
                existed only while that screen did: a launch that never opened Settings had no
                listener, and pressing Back tore down the one there was. */}
            <WakeProvider>
              <Shell />
            </WakeProvider>
          </WorldProvider>
        </ConnectionProvider>
      </PrefsProvider>
      </LocaleProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const prefs = usePrefs();
  const world = useWorld();
  return (
    <ThemeProvider pref={prefs.themePref} face={resolveFace(prefs.facePin, world.face.account)}>
      <Screens />
    </ThemeProvider>
  );
}

function Screens() {
  const t = useTheme();
  /* Subscribed so the stack's own options — nothing worded today, but the screen titles a later
     header would read — rebuild on a language switch along with everything below. */
  useLocale();
  return (
    <>
      <StatusBar style={t.scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.c.canvas },
          // The stack slides; the tab switch does not. Reduced motion turns the
          // slide off entirely rather than slowing it down.
          animation: t.reduceMotion ? "none" : "slide_from_right",
        }}
      >
        <Stack.Screen name="(tabs)" />
      </Stack>
      <Toast />
    </>
  );
}
