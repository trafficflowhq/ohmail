"use client";

/**
 * SETTINGS → INVITES — the self-host household pane: invite a user onto the server, see the
 * invites still open, take one back.
 *
 * A self-host server never opens signup to strangers; every account after the operator's
 * arrives by invitation (`docs/self-host/VPS.md` §8). This pane is that flow's whole surface:
 *
 *   mint (`POST /pair`, invite grant, step-up gated) → ONE link, `<origin>/join/invite#<token>`
 *   → shown once, as a QR for a phone camera and a copy button for everything else → the
 *   invited person opens it, sets a password, done.
 *
 * Injected as a ReactNode by `CloudShell` — the `SecuritySection` seam exactly — and injected
 * ONLY on the self-host build with `/hello` announcing `features.pairing`
 * ({@link useUserInvites}): the managed service deliberately does not mount the mint routes
 * (an invite redeem there would bypass the billing funnel), so on the managed bundle every
 * branch of this pane is compiled out and the Settings nav never grows the entry.
 *
 * ── THE LINK'S SHAPE, AND WHY THE TOKEN RIDES THE FRAGMENT ────────────────────────────────
 *
 * The token goes in the URL FRAGMENT (`#<token>`), never the path or query: a fragment is not
 * sent in the page request, so it cannot land in the server's or a proxy's access log, and it
 * never rides a `Referer`. Possession of the link IS the invitation — the operator hands it
 * over a channel they already trust, the same standing as handing over a house key — and the
 * server-side bounds do the rest: single-use, seven-day default expiry, revocable right here.
 * The raw token appears exactly once (this mint response); the list below carries metadata
 * only, and the server stores only a hash.
 *
 * ── WHAT THE PANE DELIBERATELY DOES NOT SAY ───────────────────────────────────────────────
 *
 * No role talk, no admin talk: there is no RBAC on a household server, so anyone with an
 * account here can invite (and can only see and revoke their OWN invites — the list is
 * creator-scoped in the service). The one privacy fact worth a sentence is in the lead: each
 * person gets their own account and their own mail.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSection, SettingsSubhead, useToast } from "@ohmail/ui";
import { ApiError, messageOf, pair, type PairingTokenDTO } from "../../api-client";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { QrCode } from "../../shell/QrCode";

/**
 * Should this client offer the Invites pane at all? Two gates, one per kind of truth:
 *
 *  · `SELF_HOST_BUILD` is COMPILED (`app/hello.ts`) — on the managed bundle the effect body is
 *    a constant `return`, so no `/hello` round-trip is ever paid and the answer is `false`
 *    forever, structurally.
 *  · `features.pairing` is the SERVER's runtime word — the capability handshake exists so a
 *    client learns a ceremony's absence from the descriptor, never from a 404 mid-flow. An
 *    older or oddly-composed server that does not announce pairing gets no pane rather than a
 *    pane whose every verb would bounce.
 *
 * `false` while the answer is pending: the nav entry appearing a beat after mount is cheaper
 * than an entry that appears instantly and opens onto refusals.
 */
export function useUserInvites(): boolean {
  const [pairing, setPairing] = useState(false);
  useEffect(() => {
    if (!SELF_HOST_BUILD) return;
    let alive = true;
    void serverHello().then((h) => {
      if (alive) setPairing(h?.features?.pairing === true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return pairing;
}

type Busy = null | "mint" | `revoke:${string}`;

export function InvitesSection() {
  const t = useTranslations("invites");
  const format = useFormatter();
  const toast = useToast();

  /** Open invites — the caller's own, `grant === "invite"`, live only. `null` = not read yet. */
  const [items, setItems] = useState<PairingTokenDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  /** The one appearance of a raw token, dressed as the link it is sent as. */
  const [minted, setMinted] = useState<{ link: string; label: string } | null>(null);
  const [labelDraft, setLabelDraft] = useState("");

  /** The pane can be navigated away from mid-ceremony; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { items: all } = await pair.list();
      if (!alive.current) return;
      // Live invites only. Spent and expired rows are history, and device-pair tokens belong
      // to the device flow's own surface — an invites pane listing them would be naming a
      // credential class its copy never explains.
      setItems(all.filter((i) => i.grant === "invite" && i.status === "live"));
    } catch (err) {
      if (alive.current) setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * A step-up-gated call, reported honestly — `SecuritySection.run`'s exact shape: 401/403 is
   * "your confirmation window closed, sign in again", said instead of swallowed, because
   * swallowing it is how "invites don't work" becomes the report instead of the truth.
   */
  const run = useCallback(
    (kind: Exclude<Busy, null>, fn: () => Promise<void>) => {
      void (async () => {
        setBusy(kind);
        setError(null);
        try {
          await fn();
        } catch (err) {
          if (!alive.current) return;
          setError(
            err instanceof ApiError && (err.status === 401 || err.status === 403)
              ? t("stepUpExpired")
              : messageOf(err),
          );
        } finally {
          if (alive.current) setBusy(null);
        }
      })();
    },
    [t],
  );

  const mint = () =>
    run("mint", async () => {
      const label = labelDraft.trim();
      const out = await pair.mint(label ? { label } : {});
      if (!alive.current) return;
      // The link, assembled ONCE, here: this settings pane and the `/join/invite` page are the
      // two halves of one address, and this is the only place the client writes it. The token
      // rides the FRAGMENT — see the module header for the whole threat posture.
      setMinted({ link: `${window.location.origin}/join/invite#${out.token}`, label: out.label });
      setLabelDraft("");
      await refresh();
    });

  const revoke = (id: string) =>
    run(`revoke:${id}`, async () => {
      try {
        await pair.revoke(id);
      } catch (err) {
        // 404 is every kind of already-gone (spent, expired, revoked elsewhere) — the row is
        // leaving the list either way, so the refresh below is the honest answer, not an error.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      if (!alive.current) return;
      toast(t("revoked"));
      await refresh();
    });

  const copy = () => {
    if (!minted) return;
    // Fire-and-forget, `ContactPopover`'s posture: a refused clipboard leaves the QR as the
    // path that still works, and a thrown error here would take the whole pane down for it.
    void navigator.clipboard?.writeText(minted.link);
    toast(t("copied"));
  };

  const day = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: "medium" });

  return (
    <SettingsSection className="acct">
      <h2 className="acct-h">{t("title")}</h2>
      <p className="acct-lead">{t("intro")}</p>

      {error ? (
        <p className="acct-warn" role="alert">
          {error}
        </p>
      ) : null}

      {minted ? (
        <div className="acct-confirm">
          <p className="acct-lead">
            {minted.label ? t("mintedLeadFor", { name: minted.label }) : t("mintedLead")}
          </p>
          {/* The QR is the primary hand-over — a phone camera on the operator's screen — and
              the copy button is the rest. The raw link is deliberately NOT printed: a hundred
              characters of token is exactly the thing the design rules say never to show where
              a scan or a copy would do. */}
          <div className="join-qr">
            <QrCode value={minted.link} ariaLabel={t("qrAria")} />
          </div>
          <div className="acct-actions">
            <Button variant="primary" onClick={copy}>
              {t("copyLink")}
            </Button>
            <Button onClick={() => setMinted(null)}>{t("mintedDone")}</Button>
          </div>
          <p className="acct-fine">{t("mintedOnce")}</p>
        </div>
      ) : (
        <>
          {/* The mint row, `TagCreateRow`'s shape: the (optional) name is the one input, the
              button is the verb, Enter submits. The name is the minter's own word for the row
              in the list below — without one, two open invites read as "Invite / Invite". */}
          <div className="set-row set-tag-edit fam-mint">
            <input
              className="join-input set-tag-input"
              value={labelDraft}
              placeholder={t("mintFor")}
              aria-label={t("mintFor")}
              maxLength={100}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (busy === null) mint();
                }
              }}
            />
            <span className="set-tag-acts">
              <Button variant="primary" onClick={mint} disabled={busy === "mint"}>
                {busy === "mint" ? t("working") : t("mintAction")}
              </Button>
            </span>
          </div>
          <p className="set-note-inline">{t("mintHint")}</p>
        </>
      )}

      {items && items.length > 0 ? (
        <>
          <SettingsSubhead>{t("liveTitle")}</SettingsSubhead>
          {items.map((i) => (
            <SettingsRow
              key={i.id}
              label={i.label || t("rowFallback")}
              description={t("rowMeta", { created: day(i.createdAt), expires: day(i.expiresAt) })}
              control={
                <span className="acct-row-act">
                  <Button onClick={() => revoke(i.id)} disabled={busy === `revoke:${i.id}`}>
                    {busy === `revoke:${i.id}` ? t("working") : t("revoke")}
                  </Button>
                </span>
              }
            />
          ))}
        </>
      ) : null}
    </SettingsSection>
  );
}
