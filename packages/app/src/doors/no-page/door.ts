/**
 * THE NO-PAGE'S DOOR. The page is drawn on the server, so its words come in with it (the server file reads them), and
 * each way on is an act of the shell. There is no `none`: this page is itself what a build says when there is nothing
 * at an address, or no server behind it.
 */
export type NoPageDoor =
  /** No page at this address. */
  | {
      readonly at: "missing";
      readonly words: { readonly title: string; readonly note: string; readonly home: string };
      home(): void;
    }
  /** This build has no server behind it. */
  | {
      readonly at: "noserver";
      readonly words: {
        readonly title: string;
        /** What this build runs, and (`note`) where the person's own mailboxes are. */
        readonly body: string;
        readonly note: string;
        readonly demo: string;
        readonly signIn: string;
      };
      demo(): void;
      signIn(): void;
    };
