import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Message } from "@ohmail/ui/mail";
import "../../../../packages/tokens/src/tokens.css";
import "../../../../packages/tokens/src/faces.css";
import "../../../../packages/tokens/src/ohmarchy.css";
import "@ohmail/tokens/design/fonts.css";
import "@ohmail/ui/base";
import "@ohmail/tokens/design.css";
import "../../../../packages/ui/src/composites/message.css";
import "../../../../packages/app/src/frame/seam.generated.css";
import { letterBody as Letter } from "@ohmail/app/reader/body";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { letterPictures } from "@ohmail/app-logic/reader";
import { RichEditor } from "../../../../packages/app/src/write/editor/RichEditor.js";
import en from "../../messages/en.json" with { type: "json" };

const params = new URLSearchParams(location.search);
const kind = params.get("kind");
const blockBlankTag = params.get("blank");
const blockBlank = blockBlankTag === "div" || blockBlankTag === "p"
  ? `<${blockBlankTag}>&nbsp;</${blockBlankTag}>`
  : "";
const scheme = params.get("scheme") === "dark" ? "dark" : "light";
document.documentElement.dataset.scheme = scheme;
document.documentElement.dataset.face = "paper";
document.documentElement.dataset.device = innerWidth < 600 ? "phone" : "desktop";
const first = "Quartz begins";
const next = "Copper follows";
const third = "Violet returns";
const items = params.has("picture")
  ? [
      "Fold the indigo swatch along the pencilled seam before mounting it in the display case.",
      "Polish the copper disc and place it beside the prism when the afternoon light reaches the shelf.",
    ]
  : ["Fold indigo", "Polish copper"];
const last = "Cobalt closes";
const signed = "Juniper Finch";
const wrap = (s: string) => (kind === "gmail" ? `<div>${s}</div>` : `<p class="MsoNormal">${s}</p>`);
const blank = kind === "gmail" ? "<div><br></div>" : "<p><o:p>&nbsp;</o:p></p>";
const list = `<ul>${items.map((s) => `<li>${wrap(s)}</li>`).join("")}</ul>`;
const text = [first, next, "", third, "", ...items.map((s) => "- " + s), "", last, signed].join("\n");
const html = [
  kind === "outlook" ? "<style>.MsoNormal{margin:0}</style>" : "",
  wrap(params.has("picture") ? "Greetings, workshop crew," : first),
  wrap(params.has("picture") ? "The prism is ready for its first afternoon in the gallery." : next),
  blank,
  ...(params.has("picture")
    ? [wrap("Yesterday the glass cast a violet band across the painted wall."), "<p>&nbsp;</p>"]
    : []),
  wrap(params.has("picture") ? "Please finish these preparations before opening the doors." : third),
  list,
  wrap(last),
  wrap(signed),
  params.has("picture") ? '<blockquote type="cite">Earlier notes about the prism.</blockquote>' : "",
].join("");
const samples: Record<string, { html: string | null; text: string }> = {
  barep: {
    html: "<p>Alpha opens the note and runs long enough to be a real paragraph of a letter.</p><p>Beta is the second paragraph of the same letter.</p><p>Gamma closes it.</p>",
    text: "Alpha opens the note\n\nBeta is the second\n\nGamma closes it.",
  },
  designed: {
    html: '<table width="100%" bgcolor="#eeeeee" cellpadding="0" cellspacing="0"><tr><td align="center"><table width="600" bgcolor="#ffffff" cellpadding="24" cellspacing="0" style="width:600px"><tr><td><img src="https://example.com/logo.png" width="120" height="40" alt="Logo"><h1 style="font-family:Georgia">Weekly letter</h1><p>Alpha opens the weekly letter with a full paragraph of news text.</p><p>Beta is the second paragraph of the weekly letter.</p><p><a href="https://example.com/read" style="background:#0a7;color:#fff;padding:10px 16px;display:inline-block">Read more</a></p></td></tr><tr><td bgcolor="#222222" style="color:#ccc"><p>Gamma footer line one.</p><p>Delta footer line two.</p></td></tr></table></td></tr></table>',
    text: "Weekly letter\n\nAlpha\n\nBeta",
  },
  gmailfold: {
    html: '<div dir="ltr"><div>Alpha thanks for the note.</div><div><br></div><div>Beta last own line.</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Nov 3, 2026 at 10:00 AM Ann Example &lt;ann@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Older words from before.</div></blockquote></div>',
    text: "Alpha thanks for the note.\n\nBeta last own line.\n\nOn Mon, Nov 3, 2026 at 10:00 AM Ann Example <ann@example.com> wrote:\n> Older words from before.\n",
  },
  outlookfold: {
    html: '<style>p.MsoNormal{margin:0}</style><div class="WordSection1"><p class="MsoNormal">Alpha hello Ann,</p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Beta last own line.<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div id="divRplyFwdMsg"><p class="MsoNormal"><b>From:</b> Ann Example &lt;ann@example.com&gt;<br><b>Sent:</b> Monday, November 3, 2026 10:00<br><b>To:</b> Bo Example &lt;bo@example.com&gt;<br><b>Subject:</b> Notes</p></div><p class="MsoNormal">Older words from before.</p></div>',
    text: "Alpha hello Ann,\n\nBeta last own line.\n\nFrom: Ann Example <ann@example.com>\nSent: Monday, November 3, 2026 10:00\nTo: Bo Example <bo@example.com>\nSubject: Notes\n\nOlder words from before.\n",
  },
  plainfold: {
    html: null,
    text: "Alpha thanks.\n\nBeta last own line.\n\nOn Mon, Nov 3, 2026 at 10:00 AM Ann Example <ann@example.com> wrote:\n> Older words from before.\n> More older words.\n",
  },
  units: {
    html: '<p style="margin:0cm">First</p><p style="margin-bottom:0pt">Second</p><ul style="margin:0em 0 0pt"><li>Third</li></ul><div>Fourth</div>',
    text: "Workshop notes",
  },
  filler: {
    html: "<div>First</div><div>\u034f\u200c\u034f\u200c\u00a0\u00ad</div><div>Second</div><div>&nbsp;</div><div>Third</div>",
    text: "Workshop notes",
  },
  blocks: {
    html: `<div>First</div><h2>Heading</h2>${blockBlank}<div>Second</div><blockquote>Quotation</blockquote>${blockBlank}<div>Third</div><table><tr><th>Glass</th><th>Size</th></tr><tr><td>Quartz</td><td>Small</td></tr></table>${blockBlank}<div>Fourth</div><pre>Code</pre>${blockBlank}<div>Fifth</div>`,
    text: "Workshop materials",
  },
  blanks: {
    html: "<div>First</div><p></p><div>Second</div><div>&nbsp;</div><div>Third</div>",
    text: "First\nSecond\n\nThird",
  },
  columns: {
    html: null,
    text: "The materials are ready.\n\nMaterial    Count\nQuartz      4\nCopper      2",
  },
  picture: {
    html: '<p>Here is the sample.</p><p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" width="80" height="40" alt="Quartz sample"></p><p>It is ready for the workshop.</p>',
    text: "Here is the sample.\n\nIt is ready for the workshop.",
  },
};
const sample = samples[kind ?? ""];
const noop = () => {};
const links = { href: () => null, useRendered: noop };
const draft = {
  text: "",
  html: `<p>${first}<br>${next}<br><br>${third}</p>${list}<p>${last}<br>${signed}</p>`,
};

declare global {
  interface Window { deliverLetter(html: string, text: string): Promise<typeof draft> }
}

function Example() {
  const [written, setWritten] = useState(draft);
  const [sent, setSent] = useState({ html: "", text: "" });
  const [original, setOriginal] = useState<(() => void) | undefined>();
  const composing = kind === "composer";
  return (
    <main className="oh-root">
      {composing && (
        <div className="oh-composer-text">
          <RichEditor
            value={written}
            onChange={(value) => {
              setWritten(value);
              void window.deliverLetter(value.html, value.text).then(setSent);
            }}
            links={links}
            editable
            focusAtMount={false}
            onHandle={noop}
            placeholder=""
            label="Draft"
          />
        </div>
      )}
      {kind === "barep" && original && <button onClick={original}>Show original</button>}
      <Message head={null}>
        <div data-read-body="">
          <Letter
            {...letterPictures({ id: "prism", folder: "INBOX" }, false, "none", "none", true, true)}
            messageId="prism"
            subject="Prism notes"
            text={composing ? sent.text : sample?.text ?? text}
            html={composing ? sent.html : sample ? sample.html : kind === "plain" ? null : html}
            owner={null}
            scheme={scheme}
            onBodyLayout={noop}
            onNotice={noop}
            onControls={kind === "barep" ? (controls) => setOriginal(() => controls.find((c) => c.id === "design")?.onPress) : noop}
          />
        </div>
      </Message>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <TextProvider
    locale="en"
    messages={{ mailBody: en.mailBody, bodyText: en.bodyText } as Messages}
    timeZone="UTC"
  >
    <Example />
  </TextProvider>,
);
