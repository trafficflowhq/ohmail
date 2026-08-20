/**
 * The shell. Providers, then a stack of screens on the Blanc canvas.
 *
 * Theme preference lives in the prefs store, so it has to be read *inside* that
 * provider and handed to the theme provider — hence the small `Shell` split.
 */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "../src/theme";
import { ConnectionProvider } from "../src/net/connection";
import { PrefsProvider, usePrefs } from "../src/state/store";
import { WorldProvider } from "../src/state/world";
import { Toast } from "../src/ui/chrome";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <PrefsProvider>
        {/* The connection layer sits at the root so a live session survives every screen.
            The world layer above the screens renders its mirror; with nothing connected
            the tabs gate hands the screen to the connect flow instead. */}
        <ConnectionProvider>
          <WorldProvider>
            <Shell />
          </WorldProvider>
        </ConnectionProvider>
      </PrefsProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const prefs = usePrefs();
  return (
    <ThemeProvider pref={prefs.themePref}>
      <Screens />
    </ThemeProvider>
  );
}

function Screens() {
  const t = useTheme();
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
