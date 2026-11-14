/**
 * THE DEMO'S PAGE, BUNDLED FOR A REAL BROWSER: the product's providers, the intl shell over the English catalogue, and
 * the demo's shell (today's views in the frame over invented mail), with the product page's stylesheets. The page's
 * address carries the route as the product's does.
 */
import { createRoot } from "react-dom/client";
import { Providers } from "../../../app/(product)/providers";
import { LocaleShell } from "../../../app/(product)/LocaleShell";
import { DemoShell } from "../../../app/(product)/demo/DemoShell";
import en from "../../../messages/en.json";
import "../../../app/app.css";
import "../../../app/zero-layout.css";

const SAYS = { service: "managed", sendCeiling: "strict" } as const;

document.documentElement.lang = "en";
createRoot(document.getElementById("app")!).render(
  <Providers>
    <LocaleShell initialLocale="en" initialMessages={en}>
      <DemoShell serverDemo says={SAYS} />
    </LocaleShell>
  </Providers>,
);
