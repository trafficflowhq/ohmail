/**
 * THE WEB'S PAGE, BUNDLED FOR A REAL BROWSER: the product's providers, the intl shell over the English catalogue, and
 * the web's shell through the tests' door (`_todays-shell`) over an empty engine of its own, with the product page's
 * stylesheets. What the web's rail draws and the demo's does not (the offer of the desktop app) is read on it by the
 * real-app measure (`test/compare/real/`).
 */
import { createRoot } from "react-dom/client";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { Providers } from "../../../app/(product)/providers";
import { LocaleShell } from "../../../app/(product)/LocaleShell";
import { AppShell } from "../../_todays-shell";
import en from "../../../messages/en.json";
import "../../../app/app.css";
import "../../../app/zero-layout.css";

const NOW = new Date("2026-11-17T09:00:00.000Z");
const store = new MemoryMirrorStore();
const engine = new OhmailEngine({
  store,
  now: () => NOW,
  adapter: {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: store.getCursor(),
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
  },
} as never);

document.documentElement.lang = "en";
void store.load().then(() =>
  createRoot(document.getElementById("app")!).render(
    <Providers>
      <LocaleShell initialLocale="en" initialMessages={en}>
        <AppShell engine={engine as never} />
      </LocaleShell>
    </Providers>,
  ),
);
