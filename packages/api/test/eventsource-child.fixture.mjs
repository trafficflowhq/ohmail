// Run as `node --experimental-eventsource eventsource-child.fixture.mjs <url> <types json> <ms>`: Node's
// own EventSource (undici, a WHATWG implementation) listens for exactly the named types until its first
// `error` (the server ending the stream) or, as a backstop, <ms>; then prints one JSON line of what each
// listener heard, plus `message` for any unnamed dispatch.
const [url, typesJson, msRaw] = process.argv.slice(2);
const types = JSON.parse(typesJson);
const heard = [];
const es = new EventSource(url);
for (const t of types) es.addEventListener(t, () => { heard.push(t); });
es.onmessage = () => { heard.push("message"); };
const done = () => {
  es.close();
  process.stdout.write(`${JSON.stringify({ heard })}\n`);
  process.exit(0);
};
es.addEventListener("error", done);
setTimeout(done, Number(msRaw));
