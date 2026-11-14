/**
 * What the switch's native module offers, as types: the seam the node suite drives with doubles. `switch-native.ts` is
 * the one file that reaches the real module. No call takes a package, an address or a key: native reads the sibling,
 * its store page and its link from the app's own configuration, and checks the sibling's signature before each call.
 *
 * A call only one system has is optional here, and present exactly where that system's module defines it: the sibling's
 * provider and this app's pairings' file are Android's, the further legs of one sign-in are the iPhone's.
 */

/** Whether the other app is on this phone and signed alike; `unknown` where the system cannot say before a press. */
export type NativeOtherState = "here" | "absent" | "unknown";

export interface SwitchNative {
  /** The identifier this app was installed under. */
  readonly appId: string;
  otherState(): NativeOtherState;
  /** Opens the sibling with these fields (the payload codec's); false when no app took them. */
  open(fields: Readonly<Record<string, string>>): Promise<boolean>;
  /** The sibling's store page by the store's own app; false where there is none. */
  openStore(): Promise<boolean>;
  /** The one arrival native holds, handed over once and then forgotten; null when none waits. */
  takeArrival(): Promise<Record<string, string> | null>;
  /**
   * The verifier of this app's one pending challenge, handed over once and only for that challenge (`{ verifier }`,
   * on the iPhone with the digest `d` and the place `p` its ask was made for); null for any other challenge, after two
   * minutes, or once taken. Native made it from the platform's own random source and never hands it over otherwise.
   */
  takeVerifier?(challenge: string): Promise<Record<string, string> | null>;
  /**
   * ANDROID: the sibling's provider, asked about this app's pairing by its digest (none from an app that holds no
   * pairing): `{ a: "same" }`, `{ a: "other" }`, or `{ a: "none", c }` with the challenge it made; null for an absent
   * or untrusted sibling and for any other answer.
   */
  askSibling?(digest: string | null): Promise<Record<string, string> | null>;
  /** ANDROID: the digests of this app's live pairings, written for its own provider; an empty list says none. */
  notePairings?(digests: readonly string[]): Promise<boolean>;
  /**
   * THE IPHONE: asks the sibling back once, in direct answer to the opening leg just handed over: native makes a
   * verifier, keeps it with this digest and place, and opens the sibling's link with its challenge. False when it
   * did not open, or this app has asked already.
   */
  askBack?(digest: string, place: string): Promise<boolean>;
  /**
   * THE IPHONE: answers the sibling's ask with the link of the code minted for its challenge, once, and only while
   * this app's own press armed it and that ask spent the arm. False otherwise.
   */
  answer?(challenge: string, link: string): Promise<boolean>;
  addListener(event: "onArrival", listener: () => void): { remove(): void };
}
