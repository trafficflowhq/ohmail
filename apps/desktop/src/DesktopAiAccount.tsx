/**
 * SETTINGS → AI ON THE CLOUD DOOR — the account's off switch, over the bridge. The twin of
 * the browser tab's pane, a separate file for `DesktopMailboxes`'s reason: this window cannot
 * call `app/api-client` (aliased to a refusing module), so the same two routes are reached
 * through `bridgeFetch`. Same flag, same routes, same two sentences from the `settings`
 * catalogue. NOT `DesktopAiSettings` — that is the standalone door's local-model form; this
 * is `accounts.ai_enabled` on a hosted account, and that file's header says why they are
 * different panes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useText } from "@ohmail/app/text";
import { AiPane, type AiCredits } from "@ohmail/app/settings/ai";
import { useConsent } from "@ohmail/app-logic/consent";
import { useFrame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";

import { bridgeFetch } from "./bridge-fetch.js";
import { useWindowReturn } from "./window-return.js";

/**
 * The hosted route this pane addresses, root-relative like every path in this window.
 *
 * Exported for the reason the panes beside it export theirs: the engine must FORWARD it on this
 * door rather than answer it from the mirror, which holds no account flag.
 */
export const ACCOUNT_AI_PATH = "/account/ai";

const online = () => typeof navigator === "undefined" || navigator.onLine !== false;

export function DesktopAiAccount({ credits }: { credits?: AiCredits | null }) {
  const { host, commands } = useFrame();
  const { draftReplies, setDraftReplies } = useConsent();
  const t = useText("settings");
  /** `null` = not answered. Drawn, not pressable — never a guessed position. See the web twin. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const writing = useRef(false);
  const revision = useRef(0);
  const load = useCallback(() => {
    if (!online()) {
      revision.current++;
      setEnabled(null);
      setProblem(t("aiUnreadable"));
      return;
    }
    if (writing.current) return;
    const at = ++revision.current;
    const current = () => alive.current && revision.current === at;
    void (async () => {
      try {
        const res = await bridgeFetch(ACCOUNT_AI_PATH);
        if (!current()) return;
        if (!res.ok) throw new Error("AI setting unreadable");
        const body = (await res.json()) as { aiEnabled?: unknown };
        if (!current()) return;
        if (typeof body.aiEnabled !== "boolean") throw new Error("Missing AI setting");
        setEnabled(body.aiEnabled);
        setProblem(null);
      } catch {
        if (current()) {
          setEnabled(null);
          setProblem(t("aiUnreadable"));
        }
      }
    })();
  }, [t]);
  useEffect(() => {
    load();
    window.addEventListener("online", load);
    window.addEventListener("offline", load);
    return () => {
      window.removeEventListener("online", load);
      window.removeEventListener("offline", load);
    };
  }, [load]);
  useWindowReturn(load);

  const toggle = useCallback((next: boolean) => {
    if (enabled === null || writing.current || !online()) return;
    const at = ++revision.current;
    const current = () => alive.current && revision.current === at && online();
    setProblem(null);
    const previous = enabled;
    setEnabled(next);
    writing.current = true;
    void (async () => {
      try {
        const res = await bridgeFetch(ACCOUNT_AI_PATH, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aiEnabled: next }),
        });
        if (!current()) return;
        if (!res.ok) throw new Error("AI setting refused");
        const body = (await res.json()) as { aiEnabled?: unknown };
        // The SERVER's answer wins — it is what every AI call site will read.
        if (!current()) return;
        if (typeof body.aiEnabled !== "boolean") throw new Error("Missing AI setting");
        setEnabled(body.aiEnabled);
      } catch {
        if (!current()) return;
        setEnabled(previous);
        setProblem(t("aiUnreadable"));
      } finally {
        writing.current = false;
        // A connection break invalidates the write's echo. Reconcile after the request settles.
        if (alive.current && (revision.current !== at || !online())) load();
      }
    })();
  }, [enabled, load, t]);

  return <AiPane
    model={{ enabled, problem, noModel: false, toggle }}
    noModelSaid=""
    credits={credits}
    cloudModel={host.capabilities.service === "managed" && enabled === true && problem === null}
    toPlans={host.features.subscription === NONE ? undefined : () => commands.go({ place: "settings", sub: "billing" })}
    draftReplies={draftReplies === null || !setDraftReplies ? undefined : {
      enabled: draftReplies,
      toggle: (next) => {
        setProblem(null);
        void setDraftReplies(next).catch(() => {
          if (alive.current) setProblem(t("aiUnreadable"));
        });
      },
    }}
  />;
}
