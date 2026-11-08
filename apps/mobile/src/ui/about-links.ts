/**
 * SETTINGS › ABOUT's links to the operator's pages, opened in the system browser: the privacy
 * policy, imprint and support on every build and account (App Review 5.1.1(i), Play's User Data
 * policy), and Delete account for a Cloud account, whose deletion page sells nothing (5.1.1(v)).
 * A self-hosted or standalone account is not kept by ohmail.app, so it gets no deletion row.
 */
import { Copy } from "../copy";
import { DELETE_ACCOUNT_URL, IMPRINT_URL, PRIVACY_URL, SUPPORT_URL } from "../net/account";

export interface AboutLink {
  label: string;
  /** The page's address without its scheme, so the row says where it goes. */
  sub: string;
  url: string;
}

export function aboutLinks(session: { standalone: boolean; profile: { flavor?: string } } | null): AboutLink[] {
  const row = (label: string, url: string): AboutLink => ({ label, sub: url.replace(/^https:\/\//, ""), url });
  const cloud = session !== null && !session.standalone && session.profile.flavor === "managed";
  return [
    row(Copy.aboutPrivacy, PRIVACY_URL),
    row(Copy.aboutImprint, IMPRINT_URL),
    row(Copy.aboutSupport, SUPPORT_URL),
    ...(cloud ? [row(Copy.deleteAccountRow, DELETE_ACCOUNT_URL)] : []),
  ];
}
