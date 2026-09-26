import { SubscribedScreen } from "./SubscribedScreen";

/**
 * `/subscribed` — where the payment page sends a person back to. PUBLIC: the hand-off may have run
 * in a browser whose cookie jar is not the app's (a home-screen app opens it in a sheet), so this
 * page asks for a session itself and continues to the app when there is one. It makes no claim
 * about the payment; the wall's own fresh read is that claim.
 */
export default function SubscribedPage() {
  return <SubscribedScreen />;
}
