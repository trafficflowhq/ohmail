import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { DemoSection } from "./components/DemoSection";
import { Views } from "./components/Views";
import { Screener, InPlace, Fast, DarkMode } from "./components/FeatureSections";
import { AiSection } from "./components/AiSection";
import { Everyday } from "./components/Everyday";
import { GetOhmail } from "./components/GetOhmail";
import { Compare } from "./components/Compare";
import { DataOwnership } from "./components/DataOwnership";
import { FolderShowcase } from "./components/FolderShowcase";
import { Providers } from "./components/Providers";
import { Trial } from "./components/Trial";
import { Pricing } from "./components/Pricing";
import { Downloads } from "./components/Downloads";
import { Faq } from "./components/Faq";
import { Footer } from "./components/Footer";
import { publicSignupEnabled } from "../signup-mode";

/**
 * The landing reads the signup posture ONCE, here, and hands it to the one section
 * that changes because of it.
 *
 * This is a server component and `/` is prerendered, so the read happens at build time and
 * the page stays a CDN-cacheable static route. See `app/signup-mode.ts` for why
 * that is the right trade rather than asking the API per request.
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
export default function Page() {
  const publicSignup = publicSignupEnabled();
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
