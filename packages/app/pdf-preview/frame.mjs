function startPdfFrame(host, workerCode, fonts) {
  const { getDocument, PDFWorker } = host.pdfjsLib;
  const canvas = host.document.querySelector("canvas");
  const decode = (encoded) => Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0));

  class StandardFonts {
    async fetch({ kind, filename }) {
      const font =
        kind === "standardFontDataUrl" && Object.hasOwn(fonts, filename) ? fonts[filename] : undefined;
      if (!font) throw new Error("Unknown PDF font");
      return decode(font);
    }
  }

  function connect(event) {
    if (event.source !== host.parent || event.data !== "pdf-preview" || event.ports.length !== 1) return;
    host.removeEventListener("message", connect);
    const [port] = event.ports;
    let documentProxy;
    let loading = false;
    let render;
    let generation = 0;
    let worker;
    let workerPort;
    let workerUrl;
    let task;
    const fail = () => port.postMessage("failed");

    host.addEventListener(
      "pagehide",
      () => {
        render?.cancel();
        void task?.destroy().catch(() => undefined);
        worker?.destroy();
        workerPort?.terminate();
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        port.close();
      },
      { once: true },
    );

    async function paint(number) {
      if (!documentProxy || !Number.isInteger(number) || number < 1 || number > documentProxy.numPages)
        return;
      const stamp = ++generation;
      render?.cancel();
      try {
        const page = await documentProxy.getPage(number);
        if (stamp !== generation) return;
        const view = page.getViewport({ scale: 1 });
        const scale = Math.min(900 / view.width, 4096 / Math.max(view.width, view.height), 3);
        const viewport = page.getViewport({ scale });
        const density = Math.min(host.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.floor(viewport.width * density));
        canvas.height = Math.max(1, Math.floor(viewport.height * density));
        render = page.render({
          canvas: null,
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: [density, 0, 0, density, 0, 0],
        });
        await render.promise;
        if (stamp === generation) port.postMessage({ page: number, total: documentProxy.numPages });
      } catch {
        if (stamp === generation) fail();
      }
    }

    port.onmessage = async ({ data }) => {
      if (Number.isInteger(data)) {
        await paint(data);
        return;
      }
      if (loading || !(data instanceof ArrayBuffer)) return;
      loading = true;
      try {
        workerUrl = URL.createObjectURL(new Blob([decode(workerCode)], { type: "text/javascript" }));
        workerPort = new Worker(workerUrl);
        workerPort.addEventListener("error", fail);
        workerPort.addEventListener("messageerror", fail);
        worker = PDFWorker.create({ port: workerPort });
        task = getDocument({
          data,
          worker,
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
          useWorkerFetch: false,
          BinaryDataFactory: StandardFonts,
        });
        documentProxy = await task.promise;
        await paint(1);
      } catch {
        fail();
      }
    };
    port.postMessage("ready");
  }

  if (host.origin === "null" && host.parent !== host && host.pdfjsLib)
    host.addEventListener("message", connect);
}
