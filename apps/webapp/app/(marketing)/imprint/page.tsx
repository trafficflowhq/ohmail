import type { Metadata } from "next";
import { Wordmark } from "../components/Wordmark";
import { refuseOnSelfHost } from "../../self-host-marketing";

export const metadata: Metadata = {
  title: "Imprint — ohmail",
  // TODO at public launch: drop `robots`. The imprint is noindex only while the
  // site is a pre-launch waitlist page; a published Swiss imprint is meant to be
  // findable, and a search engine that cannot see it is not being served.
  robots: { index: false },
};

/* Legal content is intentionally NOT routed through i18n — it is the binding
 * legal text of the Swiss operator and changes only deliberately. */
export default function ImprintPage() {
  /* NOT SERVED ON A SELF-HOST BUILD. The first heading below is "Operator of this website" and
     the name under it is TrafficFlow GmbH — true on ohmail.app and false on every origin an
     operator runs themselves. Measured serving 200 there before this guard existed. */
  refuseOnSelfHost();
  return (
    <main className="l-legal">
      <a className="l-legal-brand" href="/">
        <Wordmark />
      </a>
      <h1 className="l-legal-title">Imprint</h1>

      <div className="l-legal-body">
        <h2>Operator of this website</h2>
        <p>
          TrafficFlow GmbH
          <br />
          Staubstrasse 1
          <br />
          8038 Zürich
          <br />
          Switzerland
        </p>
        <p>
          Email: <a href="mailto:support@ohmail.app">support@ohmail.app</a>
        </p>

        <h2>Company information</h2>
        <p>
          TrafficFlow GmbH is a Gesellschaft mit beschränkter Haftung (GmbH), a
          limited-liability company incorporated under Swiss law.
        </p>
        <p>
          Commercial Register: Canton of Zurich, Switzerland (CH-ID:
          CH&#8209;020&#8209;4079687&#8209;9)
          <br />
          UID: CHE&#8209;364.165.705
          <br />
          VAT identification number: CHE&#8209;364.165.705
        </p>

        <h2>Liability for content</h2>
        <p>
          The contents of this website were created with care. TrafficFlow GmbH
          assumes no liability for the accuracy, completeness, or timeliness of
          the content provided.
        </p>

        <h2>Liability for external links</h2>
        <p>
          This website may contain links to external websites of third parties.
          TrafficFlow GmbH has no influence on their content and accepts no
          responsibility for such external content. The respective provider or
          operator of the linked pages is always responsible for their content.
        </p>

        <h2>Copyright</h2>
        <p>
          The ohmail name, wordmark, website design, and marketing content are
          the property of TrafficFlow GmbH. All rights reserved.
        </p>
      </div>

      <a className="btn" href="/">
        Back to ohmail.app
      </a>
    </main>
  );
}
