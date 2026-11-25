import { headers } from "next/headers";
import { FIRST_PAGE_OWNER_HEADER } from "../../session-gate";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE } from "../../shell/locale";
import { NoPageEntry } from "../NoPageEntry";
import { SETTINGS_HANDOFF, settingsReference } from "../../settings-handoff";
import { SettingsHandoffGate } from "./SettingsHandoffGate";
import { CloudMailbox, ReturningMailbox, WakeMailbox } from "./MailboxEntry";
import { showMailboxOpening } from "./show-opening";
import { isDemoBuild, isDemoRequested, type SearchParamsLike } from "../../demo-mode";

/**
 * The mail client. Reached ONLY as `/` — `middleware.ts` rewrites the root here when the gate answers `app` or
 * `demo`, and 308s a direct request for this path back to `/`, so the product has exactly one public URL. `?demo=1`
 * boots the shell on the FixturesAdapter; with an API base it runs on the HttpAdapter.
 */

/**
 * What is decided HERE is only a FLOOR, deliberately re-decided: `EngineProvider` asks the same question a third time
 * on the client, from `window.location.search`, and may only turn the demo ON, never off — `app/demo-mode.ts` says
 * why (a repeated `demo` parameter arrives as an ARRAY, and a prerender bakes `searchParams = {}` into the emitted
 * HTML, so the runtime query never reaches this function). The honest gate at the bottom is a FALLBACK no request
 * reaches through the front door; it stays because the alternative, if the middleware were ever configured away, is
 * an app shell wired to nothing.
 */
export default async function Page(props: { searchParams?: Promise<SearchParamsLike> }) {
  const searchParams = await props.searchParams;
  if (searchParams && Object.hasOwn(searchParams, SETTINGS_HANDOFF)) {
    return <SettingsHandoffGate key={String(searchParams[SETTINGS_HANDOFF])} reference={settingsReference(searchParams[SETTINGS_HANDOFF]) ?? ""} />;
  }
  const wakeEntry = searchParams !== undefined && Object.hasOwn(searchParams, "wake");
  const serverDemo = isDemoBuild(process.env) || isDemoRequested(searchParams);
  const apiConfigured = Boolean(process.env.NEXT_PUBLIC_API_BASE);

  // `CloudShell` is `AppShell` plus the one thing the shared shell may not import: how this
  // deployment asks the API whose mailbox it is holding. See its header — the account id
  // names the persistent mirror, and the shell refuses to render one without it.
  // The edge's word for the first frame. Only the exact word `now` draws a remembered mailbox before the browser's own
  // session check; absent, forged or unknown is `wait` (`middleware.ts` deletes any the client sent).
  const request = await headers();
  const edgeOwner = request.get(FIRST_PAGE_OWNER_HEADER);
  const drawMail = request.get("x-ohmail-first-page") === "now" && edgeOwner !== null ? "now" : "wait";
  if (wakeEntry && apiConfigured) return <WakeMailbox />;
  if (apiConfigured && !serverDemo && showMailboxOpening(request)) {
    return <ReturningMailbox demo={false} drawMail={drawMail} edgeOwner={edgeOwner} showOpening />;
  }
  if (serverDemo || apiConfigured) return <CloudMailbox demo={serverDemo} drawMail={drawMail} edgeOwner={edgeOwner} />;

  /* English explicitly — the request config resolves `requestLocale` since the bilingual
     marketing slice, and no layout pins one for this route. Same string as before. */
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: "gate" });
  return <NoPageEntry at="noserver" words={{ title: t("lede"), body: t("body"), note: t("note"), demo: t("openDemo"), signIn: t("signIn") }} />;
}
