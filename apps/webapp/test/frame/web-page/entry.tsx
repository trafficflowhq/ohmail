/** The signed-in web entry over the comparison’s local API fixture, with the product’s providers and styles. */
import { createRoot } from "react-dom/client";
import { Providers } from "../../../app/(product)/providers";
import { LocaleShell } from "../../../app/(product)/LocaleShell";
import { CloudShell } from "../../../app/(product)/mailbox/CloudShell";
import en from "../../../messages/en.json";
import "../../../app/app.css";
import "../../../app/zero-layout.css";

document.documentElement.lang = "en";
createRoot(document.getElementById("app")!).render(
  <Providers>
    <LocaleShell initialLocale="en" initialMessages={en}>
      <CloudShell demo={false} drawMail="now" />
    </LocaleShell>
  </Providers>,
);
