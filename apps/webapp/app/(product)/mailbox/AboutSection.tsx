"use client";

import { useEffect, useState } from "react";
import { AboutPane, aboutMailboxesOf, aboutPoliciesOf, type AboutModel } from "@ohmail/app/settings/about";
import { accountHeaderCapability, apiConfigured, mailboxes as mailboxApi, messageOf, type MailboxDTO } from "../../api-client";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { TextFromIntl } from "../../shell/LocaleContext";

const PUBLISHER = {
  lines: ["TrafficFlow GmbH", "Staubstrasse 1, 8038 Zürich, Switzerland", "UID CHE\u2011364.165.705 · Commercial Register, Canton of Zurich"],
  address: "support@ohmail.app",
};

export function AboutSection({ owner }: { owner?: string | null } = {}) {
  const [items, setItems] = useState<MailboxDTO[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [namesAccount, setNamesAccount] = useState<boolean | null>(() => accountHeaderCapability());

  useEffect(() => {
    if (owner === null || !apiConfigured()) return;
    let live = true;
    void mailboxApi.list({}, owner).then(({ items }) => {
      if (live) setItems(items);
    }, (error: unknown) => {
      if (live) setFailure(messageOf(error));
    });
    return () => { live = false; };
  }, [owner]);

  useEffect(() => {
    let live = true;
    void serverHello().then(() => { if (live) setNamesAccount(accountHeaderCapability()); });
    return () => { live = false; };
  }, []);

  const model: AboutModel = {
    mailboxes: failure === null ? aboutMailboxesOf(items) : { kind: "failed", said: failure },
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
    build: process.env.NEXT_PUBLIC_BUILD ?? "dev",
    namesAccount,
    publisher: PUBLISHER,
    policies: aboutPoliciesOf({ service: SELF_HOST_BUILD ? "self" : "managed" }),
  };
  return (
    <TextFromIntl>
      <AboutPane model={model} />
    </TextFromIntl>
  );
}
