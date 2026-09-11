import { Nav } from "./Nav";
import { FaceToggle } from "./FaceToggle";
import { Hero } from "./Hero";
import { HeroSplit } from "./HeroSplit";
import { DemoSection } from "./DemoSection";
import { Views } from "./Views";
import { Screener, InPlace, Fast, DarkMode } from "./FeatureSections";
import { AiSection } from "./AiSection";
import { Everyday } from "./Everyday";
import { GetOhmail } from "./GetOhmail";
import { Compare } from "./Compare";
import { DataOwnership } from "./DataOwnership";
import { FolderShowcase } from "./FolderShowcase";
import { LeaveAnytime } from "./LeaveAnytime";
import { Providers } from "./Providers";
import { Pricing } from "./Pricing";
import { Downloads } from "./Downloads";
import { Faq } from "./Faq";
import { Footer } from "./Footer";

/**
 * The landing page's composition — one of them, for every locale. It moved out of
 * `(marketing)/page.tsx` when the site became bilingual, and the move is the point: `/` and `/de`
 * are two root layouts over ONE composition, so a section added to the English landing cannot be
 * missing from the German one. The sections take no locale — each reads the catalogue its root
 * layout provided. `publicSignup` is passed rather than read here so the read stays a build-time
 * constant on a prerendered route (`app/signup-mode.ts`).
 */

/**
 * The order is the story — promise → model → mechanism → compatibility → trust → speed → polish:
 * FaceToggle (flips presentation, never story); Hero with the live demo as the promise's proof
 * (HeroSplit is PARKED, not deleted — `SHOW_HERO_SPLIT`); Views — the three-view model; Screener +
 * AI — the mechanism; Providers — all your mailboxes; InPlace + FolderShowcase + LeaveAnytime +
 * Compare + DataOwnership — the trust run; Fast — search; DarkMode — polish; GetOhmail — the four
 * ways to run it, free ones first, where the nav's "Get ohmail." button lands. The feat-shaped
 * sections sit in `.l-features` blocks; a story-order guard holds this sequence.
 */

/**
 * The hero split is HIDDEN, not deleted (owner review, 2026-08-31): with the split gone the
 * live demo is the first thing under the headline, and the face story the split told is
 * carried by the toggle itself — its two halves are rendered in the two faces' own idioms
 * (see FaceToggle). The component, its gesture tests (`landing-faces.test.tsx`), its four
 * captures and the pipeline that regenerates them all stay live, so flipping this back on
 * is one word — which is the point of a gate over a deletion.
 */
const SHOW_HERO_SPLIT = false;

export function Landing({ publicSignup }: { publicSignup: boolean }) {
  return (
    <>
      <Nav />
      <main id="main">
        <FaceToggle />
        <Hero />
        {SHOW_HERO_SPLIT ? <HeroSplit /> : null}
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
        {/* the consequence of the two sections above, with a heading of its own: the
            mailbox is the source of truth, so switching hosting or leaving costs nothing */}
        <LeaveAnytime />
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
        {/* The trial band ("Fourteen days, free. No card.") is REMOVED from the flow (owner
            review, 2026-08-31): the trial's terms live on the pricing section's managed panel
            — `pricing.trialNote` under the tiers, `trialBadge` on each — and nowhere else at
            section scale. The component and its catalogue keys stay for the pins that read
            them (`trial-credits.test.ts`, landing-mailbox-truth §11). */}
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
