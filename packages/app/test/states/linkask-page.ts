/**
 * THE ASK BEFORE A LINK OPENS, as the web shows it: the body's own page for one marked address, in the shipped
 * English words, written over this document as the browser opens it in a tab of its own.
 */
import { askPage } from "../../../letter-body/src/link-ask.js";
import readerEn from "../../messages/reader.en.json" with { type: "json" };

/** The reference's address: a tracking link whose text names the shop. */
const URL_ASKED = "https://klick.versandbote.example/t/8f2c61a0?o=5521";

/* The shipped English sentences, from the catalogue the body reads them from. */
const words = readerEn.mailBody;
const html = askPage(URL_ASKED, {
  lang: "en",
  title: words.linkAskTitle,
  elsewhere: words.linkAskElsewhere,
  goes: (host) => words.linkAskGoes.replace("{host}", host),
  open: (host) => words.linkAskOpen.replace("{host}", host),
  stay: words.linkAskStay,
});
document.open();
document.write(html);
document.close();
