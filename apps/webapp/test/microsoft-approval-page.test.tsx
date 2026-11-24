import { createTranslator } from "next-intl";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { headers } from "next/headers";
import MicrosoftApprovalPage from "../app/(product)/microsoft-approval/page";
import { LOCALE_COOKIE, type AppLocale } from "../app/shell/locale";
import { loadCatalog } from "../i18n/catalog";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale, namespace }: { locale: AppLocale; namespace: string }) =>
    createTranslator({ locale, namespace, messages: await loadCatalog(locale) }),
}));

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["en", "approved", "ohmail is approved for your organisation. The person can connect now."],
  ["en", "declined", "The approval was cancelled. You can open the approval link again when you’re ready."],
  ["de", "approved", "ohmail ist für deine Organisation genehmigt. Die Person kann ihr Postfach jetzt verbinden."],
  ["de", "declined", "Die Genehmigung wurde abgebrochen. Du kannst den Genehmigungslink erneut öffnen."],
])("renders the %s administrator result for %s", async (locale, oauth, message) => {
  vi.stubGlobal("React", React);
  vi.mocked(headers).mockResolvedValue(new Headers({ cookie: `${LOCALE_COOKIE}=${locale}` }));

  const page = await MicrosoftApprovalPage({ searchParams: Promise.resolve({ oauth }) });
  expect(renderToStaticMarkup(page)).toContain(`<p role="status">${message}</p>`);
});
