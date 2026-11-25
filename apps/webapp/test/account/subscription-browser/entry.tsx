import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import { Sheet } from "@ohmail/ui/mail";
import { SubscriptionPane, useSubscription } from "@ohmail/app/account";
import { stampFrameAttributes } from "@ohmail/app/frame/boot";
import { account } from "../../../app/api-client";
import { useSubscriptionDoor } from "../../../app/(product)/mailbox/subscription-door";
import { TextFromIntl } from "../../../app/shell/LocaleContext";
import en from "../../../messages/en.json";
import de from "../../../messages/de.json";
import subscriptionEn from "../../../../../packages/app/messages/account-subscription.en.json";
import subscriptionDe from "../../../../../packages/app/messages/account-subscription.de.json";
import aiEn from "../../../../../packages/app/messages/settings-ai.en.json";
import aiDe from "../../../../../packages/app/messages/settings-ai.de.json";
import "../../../app/app.css";

const lang = new URLSearchParams(location.search).get("lang") === "de" ? "de" : "en";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
const messages = lang === "de" ? { ...de, ...subscriptionDe, ...aiDe } : { ...en, ...subscriptionEn, ...aiEn };
document.documentElement.lang = lang;
stampFrameAttributes(document, window);

function Subscription() {
  const model = useSubscription(useSubscriptionDoor(null, () => {}));
  return (
    <SubscriptionPane
      model={model}
      connectedCount={2}
      addMailbox={{ press: () => {}, busy: false, price: null, most: 10, atLimit: false }}
      addStorage={{ press: () => {}, busy: false, unit: "10 GB" }}
      toStorage={() => {}}
      sheet={(body, foot) => <Sheet kind="reading" foot={foot}>{body}</Sheet>}
    />
  );
}

void account.access({ fresh: true }).then(() => {
  createRoot(document.getElementById("app")!).render(
    <NextIntlClientProvider locale={lang} messages={messages} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}>
      <ThemeProvider defaultPreference={theme} stampPaper>
        <TextFromIntl>
          <Subscription />
        </TextFromIntl>
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
});
