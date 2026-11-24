/**
 * THE WEB'S PICTURE WIRE: a letter's remote pictures through this origin's own proxy, as the page's server client
 * reaches it. The address is same-origin and absolute (`/api/*` is a rewrite, so the session rides the GET, and the
 * letter's frame derives its `img-src` from exactly this address); the press is recorded by the server client, and
 * a refusal is said in the server's own sentence. Handed in by the web's supplies where the page has a server client,
 * and by the host only where the server says it fetches pictures.
 */
import { API_BASE, messageOf, privacy } from "../../api-client";
import { imageProxyUrl, type ImageDoor } from "../../shell/remote-images";

export const WEB_IMAGES: ImageDoor = {
  address: (messageId, url) => imageProxyUrl(API_BASE ?? "", window.location.origin, messageId, url),
  record: async (messageId) => {
    try {
      await privacy.loadRemote(messageId);
    } catch (err) {
      throw new Error(messageOf(err));
    }
  },
};
