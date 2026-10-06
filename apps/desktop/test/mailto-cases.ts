/**
 * THE LINKS EVERY SURFACE'S ADAPTER IS DRIVEN BY — one table, read by the desktop's, the web shell's
 * and the phone's tests, so each carries to, cc, bcc, subject and body from the one parser into its
 * composer the same way. Each row is the five fields the parser answers for its link.
 */
export interface MailtoSurfaceCase {
  name: string;
  link: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export const MAILTO_SURFACE_CASES: readonly MailtoSurfaceCase[] = [
  {
    name: "every field",
    link: "mailto:a@x.example,b@y.example?cc=c@z.example&bcc=d@w.example&subject=Hello%20there&body=Line1%0D%0ALine2",
    to: ["a@x.example", "b@y.example"], cc: ["c@z.example"], bcc: ["d@w.example"], subject: "Hello there", body: "Line1\nLine2",
  },
  {
    name: "copies only, no To",
    link: "mailto:?cc=c@z.example;e@z.example&bcc=d@w.example",
    to: [], cc: ["c@z.example", "e@z.example"], bcc: ["d@w.example"], subject: "", body: "",
  },
  {
    name: "an encoded separator stays text",
    link: "mailto:x@y.example?subject=A%26cc%3Devil@z.example",
    to: ["x@y.example"], cc: [], bcc: [], subject: "A&cc=evil@z.example", body: "",
  },
  {
    name: "a header injection collapses",
    link: "mailto:x@y.example?subject=Hi%0D%0ABcc:%20evil@z.example",
    to: ["x@y.example"], cc: [], bcc: [], subject: "Hi Bcc: evil@z.example", body: "",
  },
];
