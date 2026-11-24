"use client";

import { BrowserHelpContactPane, type BrowserHelpContactProps } from "../../shell/browser-mail";
import { TextFromIntl } from "../../shell/LocaleContext";

export type { SupportHost } from "@ohmail/app-logic/writing/support";
export { navigatorOs } from "@ohmail/app-logic/writing/support";
export type { SupportSeed } from "@ohmail/app-logic/writing/composer-types";

export function HelpContactPane(props: BrowserHelpContactProps) {
  return (
    <TextFromIntl>
      <BrowserHelpContactPane {...props} />
    </TextFromIntl>
  );
}
