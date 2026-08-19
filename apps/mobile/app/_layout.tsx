/**
 * The shell. Providers, then a stack of screens on the Blanc canvas.
 *
 * Theme preference lives in the store, so it has to be read *inside* the store
 * provider and handed to the theme provider — hence the small `Shell` split.
 */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "../src/theme";
import { ConnectionProvider } from "../src/net/connection";
import { StoreProvider, useApp } from "../src/state/store";
import { WorldProvider } from "../src/state/world";
import { Toast } from "../src/ui/chrome";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        {/* The connection layer sits at the root so a live session survives every screen —
            the demo world (fixtures) keeps rendering untouched until a profile goes live.
            The world layer above the screens is what switches them between the two. */}
        <ConnectionProvider>
          <WorldProvider>
            <Shell />
          </WorldProvider>
        </ConnectionProvider>
      </StoreProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const s = useApp();
  return (
    <ThemeProvider pref={s.themePref}>
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
