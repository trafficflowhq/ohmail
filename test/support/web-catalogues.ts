import en from "../../apps/webapp/messages/en.json";
import de from "../../apps/webapp/messages/de.json";
import { fillFrom, setActiveCatalog } from "../../apps/webapp/app/shell/locale";

/** The web catalogue is also the source of the Desktop renderer's words. */
export { en, de };

export function installTestCatalogue(locale: "en" | "de") {
  const messages = locale === "de" ? fillFrom(en, de) as typeof en : en;
  setActiveCatalog(locale, messages);
  return messages;
}

export function clearTestCatalogue(): void {
  setActiveCatalog("en", null);
}
