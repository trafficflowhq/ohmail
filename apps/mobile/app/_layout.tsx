/**
 * The shell. Providers, then a stack of screens on the Blanc canvas.
 *
 * Theme preference lives in the prefs store, so it has to be read *inside* that
 * provider and handed to the theme provider — hence the small `Shell` split.
 *
 * The LANGUAGE sits outermost, above everything that draws a word. It has to: the copy deck is
 * reached through a module import rather than through React, so the provider's job is to resolve
 * which deck that is (the phone's own language, or an override stored on this device) before any
 * screen renders — and to publish a switch afterwards. Screens subscribe with `useLocale()`.
 *
 * The FACE (paper / ohmarchy) is resolved in the same place and for the same reason, from the
 * two scopes that decide it: this device's pin (the prefs store) and the account's synced
 * answer (the world layer's consent read). `resolveFace` is the whole of the order and lives in
 * `src/theme/face.ts`, where the node suite can drive it — the provider only receives the
 * verdict. That is also why `Shell` sits INSIDE `WorldProvider`: the account half of the
 * appearance comes off the mirror's own consent read.
 *
 * THE PHONE'S ENGINE REGISTERS HERE, at module scope, above the router. `engine-artifact.ts` makes
 * that a requirement rather than a preference: the chooser reads the registry at render time and
 * holds no subscription, so an engine registered after the door list is drawn leaves a build that
 * HAS an engine showing three doors until something else re-renders. Module scope is the only place
 * that cannot be late.
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
