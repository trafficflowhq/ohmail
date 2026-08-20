"use client";

/**
 * SETTINGS → DEVICES — pair another device with this account, see what is signed in, take one
 * back.
 *
 * The Cloud half of the one pairing mechanism every flavor shares: mint (`POST /pair`,
 * device-pair grant, step-up gated) → ONE link, `<apiOrigin>/pair#<token>` → shown once, as a
 * QR for the ohmail app's scanner plus the raw link for typed entry → the app redeems it
 * anonymously for a bearer pair and starts reading mail. `GET /devices` below is what makes the
 * offer safe: every session is visible here and revocable here.
 *
 * Injected as a ReactNode by `CloudShell` — the `InvitesSection` seam exactly — and injected
 * only when `/hello` answers `features.pairing: true` ({@link useDevicePairing}). Unlike the
 * Invites pane there is NO compiled flavor gate: the managed service mounts the device-pair
 * ceremony too (its invite arms stay refused server-side), so the runtime capability word is
 * the whole gate, on both builds, and an older server that does not announce pairing gets no
 * pane rather than a pane whose verbs would bounce.
 *
 * ── THE LINK'S ORIGIN IS THE API'S, NOT THIS PAGE'S ───────────────────────────────────────
 *
 * The scanning device redeems at `${origin}/pair/redeem` and then lives on `${origin}/sync`,
 * so the origin in the link must be one where the API answers at the ROOT. On a self-host
 * install that IS the page origin (the reference Caddyfile routes `/hello`, `/pair*`, `/auth*`
 * at the root to the api container). On the managed deployment it is NOT: ohmail.app serves
 * the API under the `/api` rewrite only, and the address a device talks to is
 * `https://api.ohmail.app` — the single member of the compiled allow-list, imported from
 * `app/api-origin.ts` so this file cannot drift from the origin the deployment actually pins.
 * A link minted on the page origin instead would scan, negotiate against a Next 404 and refuse
 * — the wrong door discovered by whoever is holding the phone.
 *
 * The token rides the FRAGMENT (`#<token>`), never the path or query: a fragment is not sent
 * in any request, so it cannot land in an access log and never rides a `Referer`. The raw
 * token appears exactly once (this mint response); the list below carries metadata only, and
 * the server stores only a hash. Unlike the Invites pane, the raw LINK is printed beside the
 * QR deliberately: the ordinary redeemer is the ohmail app's scanner, but a device without a
 * camera path needs the link typed, and five minutes of single-use lifetime is what bounds
 * that exposure.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSection, SettingsSubhead, useToast } from "@ohmail/ui";
import {
  ApiError, devices as devicesApi, messageOf, pair, type DeviceDTO, type PairingTokenDTO,
} from "../../api-client";
import { ALLOWED_API_ORIGINS } from "../../api-origin";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { QrCode } from "../../shell/QrCode";

/**
 * Should this client offer the Devices pane? One gate, the server's own runtime word —
 * `features.pairing` from `/hello` — because the capability handshake exists so a client
 * learns a ceremony's presence from the descriptor, never from a 404 mid-flow. `false` while
 * the answer is pending: a nav entry appearing a beat after mount is cheaper than one that
 * appears instantly and opens onto refusals.
 */
export function useDevicePairing(): boolean {
  const [pairing, setPairing] = useState(false);
  useEffect(() => {
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

/** Where the scanned link points — the origin the API answers at the root. See the header. */
function pairOrigin(): string {
  return SELF_HOST_BUILD ? window.location.origin : ALLOWED_API_ORIGINS[0]!;
}

type Busy = null | "mint" | `revoke:${string}` | `remove:${string}`;

export function DevicesSection() {
  const t = useTranslations("devices");
  const format = useFormatter();
  const toast = useToast();

  /** Live sessions (`GET /devices`). `null` = not read yet. */
  const [items, setItems] = useState<DeviceDTO[] | null>(null);
  /** Open pairing codes — the caller's own, `grant === "device-pair"`, live only. */
  const [codes, setCodes] = useState<PairingTokenDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  /** The one appearance of a raw token, dressed as the link it is scanned or typed as. */
  const [minted, setMinted] = useState<{ link: string; label: string } | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  /** The device whose sign-out is awaiting confirmation, or `null`. */
  const [removing, setRemoving] = useState<string | null>(null);

  /** Strict Mode re-arms setup on the same instance — armed in the effect, InvitesSection's fix. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [{ items: sessions }, { items: mints }] = await Promise.all([
        devicesApi.list(),
        pair.list(),
      ]);
      if (!alive.current) return;
      setItems(sessions);
      // Live device-pair codes only. Spent and expired rows are history, and invite tokens
      // belong to the Invites pane on the build that has one.
      setCodes(mints.filter((m) => m.grant === "device-pair" && m.status === "live"));
    } catch (err) {
      if (alive.current) setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * A step-up-gated call, reported honestly — `InvitesSection.run`'s exact shape: 401/403 is
   * "your confirmation window closed, sign in again", said instead of swallowed.
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
      const out = await pair.mintDevice(label ? { label } : {});
      if (!alive.current) return;
      // The link, assembled ONCE, here — the frozen fragment idiom. See the module header for
      // why the origin is the API's and why the token rides the fragment.
      setMinted({ link: `${pairOrigin()}/pair#${out.token}`, label: out.label });
      setLabelDraft("");
      await refresh();
    });

  const revokeCode = (id: string) =>
    run(`revoke:${id}`, async () => {
      try {
        await pair.revoke(id);
      } catch (err) {
        // 404 is every kind of already-gone (spent, expired, revoked elsewhere) — the row is
        // leaving the list either way, so the refresh below is the honest answer.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      if (!alive.current) return;
      toast(t("revoked"));
      await refresh();
    });

  const removeDevice = (id: string) =>
    run(`remove:${id}`, async () => {
      await devicesApi.revoke(id);
      if (!alive.current) return;
      setRemoving(null);
      toast(t("removed"));
      await refresh();
    });

  const copy = () => {
    if (!minted) return;
    const link = minted.link;
    // NOT fire-and-forget: the toast speaks only after the clipboard write fulfilled, and a
    // refusal names the paths that still work — the QR, and the link printed beside it.
    void (async () => {
      try {
        await navigator.clipboard.writeText(link);
        if (alive.current) toast(t("copied"));
      } catch {
        if (alive.current) setError(t("copyFailed"));
      }
    })();
  };

  const day = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: "medium" });
  /** A five-minute code's deadline is a TIME — the date would be today three ways out of three. */
  const clock = (iso: string): string => format.dateTime(new Date(iso), { timeStyle: "short" });
  const kindWord = (kind: DeviceDTO["kind"]): string =>
    kind === "macos" ? t("kindMac") : t("kindWeb");

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
          <div className="join-qr">
            <QrCode value={minted.link} ariaLabel={t("qrAria")} />
          </div>
          {/* The raw link, FOR TYPED ENTRY, beside the QR — a device without a camera path
              types this into the app's server field. Selectable in one press; broken anywhere
              because a pairing token has no natural word boundary. */}
          <p className="set-note-inline">{t("typedEntry")}</p>
          <p
            className="set-note-inline"
            style={{ wordBreak: "break-all", userSelect: "all", fontFamily: "var(--font-mono, monospace)" }}
            data-testid="pair-link"
          >
            {minted.link}
          </p>
          <div className="acct-actions">
            <Button variant="primary" onClick={copy}>
              {t("copyLink")}
            </Button>
            {/* Done re-reads the lists: in the ordinary scan-then-Done sequence the code was
                just consumed and the paired device just appeared. */}
            <Button
              onClick={() => {
                setMinted(null);
                void refresh();
              }}
            >
              {t("mintedDone")}
            </Button>
          </div>
          <p className="acct-fine">{t("mintedOnce")}</p>
        </div>
      ) : (
        <>
          {/* The add-a-device row — the Invites mint's shape: the (optional) name is the one
              input, the button is the verb, Enter submits. */}
          <div className="set-row set-tag-edit invites-mint">
            <input
              className="join-input set-tag-input"
              value={labelDraft}
              placeholder={t("addFor")}
              aria-label={t("addFor")}
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
                {busy === "mint" ? t("working") : t("addAction")}
              </Button>
            </span>
          </div>
          <p className="set-note-inline">{t("addHint")}</p>
        </>
      )}

      {codes.length > 0 ? (
        <>
          <SettingsSubhead>{t("codesTitle")}</SettingsSubhead>
          {codes.map((c) => (
            <SettingsRow
              key={c.id}
              label={c.label || t("codeFallback")}
              description={t("codeMeta", { time: clock(c.expiresAt) })}
              control={
                <span className="acct-row-act">
                  <Button onClick={() => revokeCode(c.id)} disabled={busy === `revoke:${c.id}`}>
                    {busy === `revoke:${c.id}` ? t("working") : t("revoke")}
                  </Button>
                </span>
              }
            />
          ))}
        </>
      ) : null}

      {items && items.length > 0 ? (
        <>
          <SettingsSubhead>{t("devicesTitle")}</SettingsSubhead>
          {items.map((d) =>
            removing === d.id ? (
              <SettingsRow
                key={d.id}
                label={t("removeAsk", { name: d.label || kindWord(d.kind) })}
                description={t("removeWhat")}
                control={
                  <span className="set-tag-acts">
                    <Button
                      variant="primary"
                      className="danger"
                      onClick={() => removeDevice(d.id)}
                      disabled={busy === `remove:${d.id}`}
                    >
                      {busy === `remove:${d.id}` ? t("working") : t("remove")}
                    </Button>
                    <Button variant="ghost" onClick={() => setRemoving(null)}>
                      {t("cancel")}
                    </Button>
                  </span>
                }
              />
            ) : (
              <SettingsRow
                key={d.id}
                label={d.label || kindWord(d.kind)}
                description={
                  d.current
                    ? t("thisDevice")
                    : t("deviceMeta", { kind: kindWord(d.kind), created: day(d.createdAt), seen: day(d.lastSeenAt) })
                }
                control={
                  // The current session's verb already exists and is called signing out; a
                  // remove here would be the same action wearing a costume.
                  d.current ? undefined : (
                    <span className="acct-row-act">
                      <Button onClick={() => setRemoving(d.id)}>{t("remove")}</Button>
                    </span>
                  )
                }
              />
            ),
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}
