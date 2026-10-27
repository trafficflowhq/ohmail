import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountSettings, trackerEvents } from "@trafficflow/db";
import { TRACKER_HOSTS, hostOf, isBeaconUrl, isKnownTracker } from "@trafficflow/core/mail";
import { canonicalHost } from "@trafficflow/core/net";
import { makePrivacyService, type HostResolver, type RemoteFetch } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";
import { PNG_2X3 } from "../../core/test/fixtures/images.js";

/**
 * EVERY TRACKING HOST SERVES NO PICTURE (SERVER-TRACKER-HOSTS-REFUSE-REAL-PICTURES). The image
 * proxy refuses a listed host's FETCH while the pixel switch stands, and the list held ESP
 * umbrella domains that also serve senders' pictures, so a newsletter's logo on
 * `gallery.mailchimp.com` was a blank box. One row per entry: a tracking url on the entry that no
 * beacon rule would catch (so the HOST refuses it), and the same ESP's picture url, fetched once.
 * An umbrella entry cannot pass: its own picture host is under it.
 */

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
const PICTURE = PNG_2X3; // a real 2×3 picture: sized, and not a pixel

function remote(): RemoteFetch & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetch(url: string) { urls.push(url); return { status: 200, contentType: "image/png", body: PICTURE }; },
  };
}

/** [entry, tracker url on it (no beacon path), the same sender's picture url] */
const ROWS: [string, string, string][] = [
  ["list-manage.com", "https://us1.list-manage.com/r/abc123.jpg", "https://gallery.mailchimp.com/abc123/images/logo.png"],
  ["mandrillapp.com", "https://mandrillapp.com/r/abc123.gif", "https://mcusercontent.com/abc123/images/header.jpg"],
  ["ct.sendgrid.net", "https://u123.ct.sendgrid.net/r/abc.jpg", "https://cdn.mcauto-images-production.sendgrid.net/abc/def/600x200.png"],
  ["hubspotemail.net", "https://t.hubspotemail.net/e2t/c/abc.gif", "https://f.hubspotusercontent00.net/hubfs/123/logo.png"],
  ["mailgun.org", "https://email.mailgun.org/o/abc123", "https://images.shop.example/mail/logo.png"],
  ["mailgun.net", "https://email.mailgun.net/o/abc123", "https://images.shop.example/mail/banner.png"],
  ["sparkpostmail.com", "https://go.sparkpostmail.com/f/a/abc.gif", "https://images.shop.example/mail/hero.png"],
  ["sendibm1.com", "https://r.sendibm1.com/tr/op/abc", "https://img.mailinblue.com/123/images/logo.png"],
  ["doubleclick.net", "https://ad.doubleclick.net/ddm/ad/abc;sz=1x1", "https://s0.2mdn.net/ads/creative.jpg"],
  ["google-analytics.com", "https://www.google-analytics.com/collect?v=1&t=event", "https://www.gstatic.com/images/branding/logo.png"],
  ["awstrack.me", "https://abc.r.us-east-1.awstrack.me/I0/0100/abc=", "https://bucket.s3.amazonaws.com/mail/logo.png"],
  ["rs6.net", "https://r20.rs6.net/on.jsp?a=1&t=2", "https://files.constantcontact.com/abc/banner.jpg"],
  ["api.mixpanel.com", "https://api.mixpanel.com/engage/?data=abc", "https://mixpanel.com/wp-content/uploads/logo.png"],
  ["klaviyomail.com", "https://trk.klaviyomail.com/u/abc.gif", "https://d3k81ch9hvuctc.cloudfront.net/company/abc/images/logo.png"],
  ["track.hubspot.com", "https://track.hubspot.com/__ptq.gif?a=123&k=14&r=https%3A%2F%2Fx", "https://f.hubspotusercontent00.net/hubfs/123/logo.png"],
  ["track-eu1.hubspot.com", "https://track-eu1.hubspot.com/v1/event?_a=123&_n=000000001625", "https://f.hubspotusercontent00.net/hubfs/123/banner.png"],
  ["api-eu.mixpanel.com", "https://api-eu.mixpanel.com/engage/?data=abc&img=1", "https://mixpanel.com/wp-content/uploads/logo.png"],
  ["api-in.mixpanel.com", "https://api-in.mixpanel.com/engage/?data=abc&img=1", "https://mixpanel.com/wp-content/uploads/banner.png"],
];

describe("the tracking-host census", () => {
  it("every entry has exactly one row, and every row names a real entry", () => {
    expect(ROWS.length).toBe(TRACKER_HOSTS.length);
    expect(ROWS.map((r) => r[0]).sort()).toEqual([...TRACKER_HOSTS].sort());
  });

  it("every entry is spelled the way the gate dials it, and none sits under another", () => {
    expect(TRACKER_HOSTS.filter((h) => h !== canonicalHost(h))).toEqual([]);
    const nested = TRACKER_HOSTS.flatMap((a) => TRACKER_HOSTS.filter((b) => a !== b && a.endsWith(`.${b}`)).map((b) => `${a} under ${b}`));
    expect(nested).toEqual([]);
  });

  it.each(ROWS)("%s: its tracker is the host arm's, its picture host is not listed", (entry, trackerUrl, pictureUrl) => {
    expect(isBeaconUrl(trackerUrl), "a beacon rule would refuse this without the host").toBe(false);
    expect(isKnownTracker(hostOf(trackerUrl))).toBe(true);
    expect(hostOf(trackerUrl) === entry || hostOf(trackerUrl).endsWith(`.${entry}`)).toBe(true);
    expect(isKnownTracker(hostOf(pictureUrl)), "the entry swallows its own sender's pictures").toBe(false);
  });

  it.each(ROWS)("%s: through the proxy, the tracker is never fetched and the picture is drawn", async (_entry, trackerUrl, pictureUrl) => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const r = remote();
    const svc = makePrivacyService({ remote: r, resolver: PUBLIC_DNS });
    const stub = await svc.proxyImage(ctx, { messageId, url: trackerUrl });
    expect(r.urls, "a tracking host was fetched while the pixel switch stands").toEqual([]);
    expect(stub.contentType).toBe("image/gif");
    const drawn = await svc.proxyImage(ctx, { messageId, url: pictureUrl });
    expect(r.urls).toEqual([pictureUrl]);
    expect(drawn.body).toEqual(PICTURE);
  });
});

describe("the two readings the ruling named", () => {
  it("a Mailchimp logo on a default account: fetched once, drawn, and no tracker event", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const r = remote();
    const out = await makePrivacyService({ remote: r, resolver: PUBLIC_DNS })
      .proxyImage(ctx, { messageId, url: "https://gallery.mailchimp.com/abc123/images/logo.png" });
    expect(r.urls).toHaveLength(1);
    expect(out.body).toEqual(PICTURE);
    // No event: the feed's `blocked` is the pixel switch, so a row here would call a drawn picture blocked.
    expect(await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId))).toEqual([]);
  });

  it("a percent-encoded beacon on an unlisted host: never fetched", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const r = remote();
    const svc = makePrivacyService({ remote: r, resolver: PUBLIC_DNS });
    await svc.proxyImage(ctx, { messageId, url: "https://t.example/%6Fpen?u=1" });
    await svc.proxyImage(ctx, { messageId, url: "https://t.example/p%69xel.gif" });
    expect(r.urls).toEqual([]);
    // The control: a reserved escape is another url, and it is fetched like any picture.
    await svc.proxyImage(ctx, { messageId, url: "https://t.example/wf%2Fopen?u=1" });
    expect(r.urls).toEqual(["https://t.example/wf%2Fopen?u=1"]);
  });

  it.each([
    ["a root dot", "https://us1.list-manage.com./r/abc123.jpg"],
    ["a root dot in upper case", "https://US1.LIST-MANAGE.COM./r/abc123.jpg"],
  ])("a listed host spelled with %s: never fetched, recorded under the host the gate dials", async (_l, url) => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const r = remote();
    const out = await makePrivacyService({ remote: r, resolver: PUBLIC_DNS }).proxyImage(ctx, { messageId, url });
    expect(r.urls).toEqual([]);
    expect(out.contentType).toBe("image/gif");
    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows.map((x) => x.trackerHost)).toEqual(["us1.list-manage.com"]);
  });

  it.each([
    ["two root dots", "https://us1.list-manage.com../r/abc123.jpg", "host is not a valid dns name"],
    ["a port", "https://us1.list-manage.com:8443/r/abc123.jpg", "port is not allowed"],
  ])("%s: never fetched — refused as a tracker, or by the gate once pixels load", async (_l, url, gate) => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const r = remote();
    const svc = makePrivacyService({ remote: r, resolver: PUBLIC_DNS });
    expect((await svc.proxyImage(ctx, { messageId, url })).contentType).toBe("image/gif");
    await db.insert(accountSettings).values({ accountId, loadTrackingPixelsAt: new Date() });
    await expect(svc.proxyImage(ctx, { messageId, url })).rejects.toThrow(gate);
    expect(r.urls).toEqual([]);
  });

  it.each([
    ["HubSpot's analytics pixel", "https://track.hubspot.com/__ptq.gif?a=123&k=14&r=https%3A%2F%2Fx"],
    ["Mixpanel's EU endpoint", "https://api-eu.mixpanel.com/engage/?data=abc&img=1"],
  ])("%s: never fetched, recorded as the host's", async (_l, url) => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const r = remote();
    await makePrivacyService({ remote: r, resolver: PUBLIC_DNS }).proxyImage(ctx, { messageId, url });
    expect(r.urls).toEqual([]);
    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows.map((x) => x.kind)).toEqual(["remote_image"]);
  });

  it("a Mailchimp open pixel: never fetched, recorded as a pixel", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const r = remote();
    await makePrivacyService({ remote: r, resolver: PUBLIC_DNS })
      .proxyImage(ctx, { messageId, url: "https://us1.list-manage.com/track/open.php?u=1&id=2&e=3" });
    expect(r.urls).toEqual([]);
    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows.map((x) => x.kind)).toEqual(["pixel"]);
  });
});
