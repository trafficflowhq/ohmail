"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { account } from "../../api-client";
import { StoragePane } from "../../shell/StoragePane";
import { useCloudStorage, useStorageChange } from "./storage-change";

/**
 * Settings → Storage on the browser: the shared pane over the access feed, the change press with its
 * step-up, and the storage mails switch (`PATCH /account/storage {mail}`), which holds what it wrote.
 * Built only where the access answer carries a storage block.
 */
export function StorageSection() {
  const facts = useCloudStorage();
  const change = useStorageChange();
  const [mail, setMail] = useState<{ on: boolean; busy: boolean; failed: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const toggle = useCallback((on: boolean) => {
    setMail({ on, busy: true, failed: false });
    void account.storage({ mail: on }).then(() => {
      if (alive.current) setMail({ on, busy: false, failed: false });
      void account.access({ fresh: true }).catch(() => { /* the switch holds what was written */ });
    }, () => { if (alive.current) setMail({ on: !on, busy: false, failed: true }); });
  }, []);
  if (facts === null) return null;
  return (
    <StoragePane
      facts={facts}
      linksOut
      change={change}
      mail={{ on: mail?.on ?? facts.mail, busy: mail?.busy ?? false, failed: mail?.failed ?? false, onChange: toggle }}
    />
  );
}
