import { renderToStaticMarkup } from "react-dom/server";
import { ActionPanel, Composer, DraftControl, Sheet } from "@ohmail/ui/mail";
import { entryCss } from "../../../ui/test/compare/harness.js";

export async function replyControlsPage(phone: boolean): Promise<string> {
  const css = await entryCss("mail");
  const markup = renderToStaticMarkup(
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <Sheet
        kind="reading"
        flushFoot
        foot={
          <ActionPanel
            label="Letter actions"
            items={[
              { id: "send", label: "Send", kind: "ink", icon: "send" },
              { id: "discard", label: "Discard", icon: "trash" },
            ]}
            more={{ label: "More", behind: true }}
          />
        }
      >
        <p style={{ minHeight: "100dvh" }}>The letter being answered.</p>
        <Composer
          reply
          head="Reply to the workshop"
          foot={{
            label: "Reply tools",
            format: { label: "Show formatting", word: "Aa", pressed: false },
            draft: <DraftControl label="Draft again" title="Draft again · 15 credits" cost="15 credits" />,
          }}
        >
          <p>
            Tuesday works.
            <br />
            <br />
            I'll bring the notes.
          </p>
        </Composer>
      </Sheet>
    </div>,
  );

  return `<!doctype html><html data-face="paper" data-scheme="light" data-device="${phone ? "phone" : "desktop"}" data-touch="${phone ? 1 : 0}"><style>body { margin: 0 } ${css}</style><body><div class="oh-root">${markup}</div></body></html>`;
}
