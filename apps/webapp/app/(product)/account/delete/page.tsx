import { DeleteAccountRoute } from "./DeleteAccountRoute";

/**
 * `/account/delete` — deleting the account, a page of its own (`DeleteAccountRoute.tsx`, over
 * `use-delete-account-door.ts`). It reads nothing from the request: the address is typed back by the person, never
 * carried in a URL, and nothing in the query or the fragment fills it. `middleware.ts` serves it as a credential page
 * (the strict nonce policy, no-referrer, no-store): a second factor and an address are typed here. The website's
 * `/delete-account` is a different page, the stores' account-deletion address; this one acts on the session.
 */
export default function DeleteAccountPage() {
  return <DeleteAccountRoute />;
}
