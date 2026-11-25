import { useEffect, useState } from "react";
import { Notice } from "@ohmail/ui/base";
import { copyText } from "../../host/clipboard.js";
import { useText } from "../../text/index.js";

export function MicrosoftApproval({ read }: { read: () => Promise<string | null> }) {
  const t = useText("frame");
  const [link, setLink] = useState<string | null>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    setLink(undefined);
    setCopied(false);
    void read()
      .catch(() => null)
      .then((url) => {
        if (current) setLink(url);
      });
    return () => {
      current = false;
    };
  }, [read]);

  if (link === undefined) return null;
  if (link === null) return <Notice place="bar" title={t("microsoftApproval.fallback")} />;
  return (
    <Notice
      place="bar"
      title={t("microsoftApproval.title")}
      line={<span>{t("microsoftApproval.forward")}</span>}
      related={
        <>
          <a href={link} target="_blank" rel="noreferrer">
            {t("microsoftApproval.link")}
          </a>
          <span aria-live="polite">{copied ? t("microsoftApproval.copied") : null}</span>
        </>
      }
      acts={[
        {
          label: t("microsoftApproval.copy"),
          onPress: (event) => {
            const view = event.currentTarget.ownerDocument.defaultView;
            if (view) void copyText(view, link).then(setCopied);
          },
        },
      ]}
    />
  );
}
