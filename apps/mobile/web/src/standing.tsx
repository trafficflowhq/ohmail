/**
 * What the page draws until the frame mounts here: nothing a person reads. The app's native side
 * holds the one waiting sentence over the web view until the page says it is ready, so the words
 * stay in the phone's catalogue and a page that never starts still leaves that sentence standing.
 */
export function Standing() {
  return <main aria-busy="true" />;
}
