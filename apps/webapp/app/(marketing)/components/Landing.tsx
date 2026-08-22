import { Nav } from "./Nav";
import { Hero } from "./Hero";
import { DemoSection } from "./DemoSection";
import { Views } from "./Views";
import { Screener, InPlace, Fast, DarkMode } from "./FeatureSections";
import { AiSection } from "./AiSection";
import { Everyday } from "./Everyday";
import { GetOhmail } from "./GetOhmail";
import { Compare } from "./Compare";
import { DataOwnership } from "./DataOwnership";
import { FolderShowcase } from "./FolderShowcase";
import { Providers } from "./Providers";
import { Trial } from "./Trial";
import { Pricing } from "./Pricing";
import { Downloads } from "./Downloads";
import { Faq } from "./Faq";
import { Footer } from "./Footer";

/**
 * THE LANDING PAGE'S COMPOSITION — ONE OF THEM, FOR EVERY LOCALE.
 *
 * It used to be the body of `(marketing)/page.tsx`. It moved here when the site became
 * bilingual, and the move is the point: `/` and `/de` are two root layouts over ONE
 * composition, so a section added to the English landing cannot be missing from the German
 * one. Two copies of this list would compile, render, and drift on the first slice that
 * touched only the file it happened to open.
 *
 * The sections themselves take no locale. Every one of them reads the catalogue the enclosing
 * root layout provided — `useTranslations` on the server through `i18n/request.ts`, on the
 * client through `NextIntlClientProvider` — so translating the page is entirely a matter of
 * which layout mounted it.
 *
 * `publicSignup` is passed rather than read here so the read stays in the page, where it is a
 * BUILD-time constant on a prerendered route (see `app/signup-mode.ts` for why that is the
 * right trade rather than asking the API per request).
 *
 * ── THE ORDER IS THE STORY ────────────────────────────────────────────────────────────
 *
 * promise → model → mechanism → compatibility → trust → speed → polish:
 *
 *  1. Hero — only consent-first mail in your Ohbox (the promise), then the live demo as
 *     its proof.
 *  2. Views — Ohbox / Reads / Receipts, the three-view model the promise lands in.
 *  3. Screener + AI — the mechanism: who gets in, and the gated help deciding.
 *  4. Providers — all your mailboxes: Gmail, Microsoft, iCloud, any IMAP.
 *  5. InPlace + FolderShowcase — your mail keeps living in your IMAP folders; then
 *     Compare and DataOwnership carry the same trust argument to its end.
 *  6. Fast — search.
 *  7. DarkMode — polish, last.
 *  8. GetOhmail — the four ways to run it, free ones first; it opens the acting
 *     cluster (trial → pricing → download) and is where the nav's "Get ohmail."
 *     button lands.
 *
 * The feat-shaped sections sit in `.l-features` blocks (the shared grid rhythm); the
 * wide sections stand between them. A story-order guard holds this sequence.
 */
export function Landing({ publicSignup }: { publicSignup: boolean }) {
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />
        <DemoSection />
        <div className="l-features" id="product">
          <Views />
          <Screener />
          <AiSection />
        </div>
        <Providers />
        <div className="l-features is-cont">
          <InPlace />
        </div>
        {/* the concrete proof of "organize in place": the real folder tree a person
            finds in their own mailbox, in any mail app */}
        <FolderShowcase />
        <Compare />
        <DataOwnership />
        <div className="l-features is-cont">
          <Fast />
          <DarkMode />
          <Everyday />
        </div>
        {/* the four ways to run ohmail — self-run first, managed as the convenience;
            everything below this is the detail of the choices it lays out */}
        <GetOhmail />
        {/* the trial stands before the price, not after it */}
        <Trial />
        <Pricing publicSignup={publicSignup} />
        {/* the download follows the price: the free tier is the one you can act on
            immediately, and this is where acting on it happens */}
        <Downloads />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
