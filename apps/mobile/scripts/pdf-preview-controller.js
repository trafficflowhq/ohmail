/*
 * The attachment preview's PDF controller: a classic script the page runs before pdf.js
 * (`src/mail/attachment-preview.ts` writes it in under the document's nonce; the phone build carries
 * it in `generated/pdf-frame.js`). It removes the WebRTC constructors, which no CSP directive covers,
 * then, once the document is parsed, hands pdf.js the bytes from the body's `data-pdf` with no URL
 * of any kind and draws each page to a canvas: no text layer, no annotations, no form, no script of
 * the PDF's own. At most `data-pages` pages, each at most `data-px` pixels wide. Any failure shows
 * the `cant` sentence; more pages than drawn show the `more` one.
 */
(function () {
  "use strict";
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"].forEach(function (k) {
    try { delete window[k]; } catch (e) {}
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
  var failed = false;
  function say(id) {
    var p = document.getElementById(id);
    if (p) p.hidden = false;
    if (id === "cant") failed = true;
  }
  document.addEventListener("DOMContentLoaded", function () {
    var lib = globalThis.pdfjsLib;
    var body = document.body;
    var maxPages = Number(body.getAttribute("data-pages"));
    var maxPx = Number(body.getAttribute("data-px"));
    if (!lib || typeof lib.getDocument !== "function" || !(maxPages > 0) || !(maxPx > 0)) { say("cant"); return; }
    var bytes;
    try {
      var bin = atob(body.getAttribute("data-pdf") || "");
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) { say("cant"); return; }
    var task;
    try {
      task = lib.getDocument({
        data: bytes, isEvalSupported: false, disableAutoFetch: true, disableStream: true,
        disableRange: true, enableXfa: false, useWasm: false
      });
    } catch (e) { say("cant"); return; }
    var host = document.getElementById("pages");
    Promise.resolve(task.promise).then(function (doc) {
      var count = Math.min(doc.numPages, maxPages);
      var at = 1;
      function next() {
        if (failed || at > count) {
          if (!failed && doc.numPages > maxPages) say("more");
          return undefined;
        }
        return doc.getPage(at++).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var room = Math.max(1, document.documentElement.clientWidth || window.innerWidth || base.width);
          var scale = Math.min(room * (window.devicePixelRatio || 1), maxPx) / base.width;
          if (base.height * scale > maxPx * 2) scale = (maxPx * 2) / base.height;
          var view = page.getViewport({ scale: scale });
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(view.width));
          canvas.height = Math.max(1, Math.floor(view.height));
          host.appendChild(canvas);
          return page.render({ canvas: canvas, canvasContext: canvas.getContext("2d"), viewport: view, annotationMode: 0 }).promise;
        }).then(next);
      }
      return next();
    }).catch(function () { say("cant"); });
  });
})();
