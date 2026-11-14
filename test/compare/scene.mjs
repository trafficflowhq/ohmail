/**
 * The scene reader: what is on a rendered page, where it sits and how it is drawn.
 *
 * ONE function, run inside the page (`page.evaluate(readScene, variant)`), for the reference and for the
 * product alike, so the two data files can only differ where the two pages do. It must stay self-contained:
 * no import, no closure, nothing the page does not have. It is plain JavaScript on purpose: a transpiler's
 * helpers do not exist in the page.
 *
 * It reads three things, in document order, and only what the picture shows:
 *
 *   nodes     landmarks, headings and controls: role, name, box, the state a person sees it in, and the
 *             values a token carries
 *   text      the words inside each node, a field's value among them, with the colour and the type they
 *             are drawn in
 *   surfaces  every element that paints something (a fill, a border, a shadow, an icon's strokes and shapes), with its box
 *             and with the box of what a stylesheet draws before or after it
 *
 * Which computed properties the words, the boxes and an icon's shapes say is not written here: the
 * reader is handed the lists of `paint-properties.json` and says each listed property where its value is
 * not the initial one, so a plain thing says nothing and nothing painted depends on a property picked by
 * hand.
 *
 * Each of them also says how it is turned on the screen, when it is (`turnOf`): one reading for a node, for
 * words, for a surface and for a generated box, and the one an icon's ink makes of each of its shapes.
 *
 * A sheet is a plain element and a row's words sit in spans inside its button: the last two are where
 * their tokens show. Left out: what is hidden, transparent, clipped away by a scroller, outside the
 * window, or wholly under something opaque. Text and surfaces belong to the nearest node around them
 * (`loose` holds those that have none), so a comparison can pair them node by node.
 */

/**
 * @param {{ variant: import("./scene.d.mts").Variant, lists: import("./scene.d.mts").PaintLists }} ask the variant is echoed
 *   into the scene, so a data file says what it was read in; the lists are `paint-properties.json`
 * @returns {import("./scene.d.mts").Scene}
 */
export function readScene(ask) {
  const variant = ask.variant, lists = ask.lists;
  if (!lists || !Array.isArray(lists.words) || !Array.isArray(lists.boxes) || !Array.isArray(lists.shapes)) throw new Error("scene: no lists of what to say were handed in (paint-properties.json)");
  /* An element that carries a state a person sees is a node, whatever else it is: its state is never dropped. */
  const STATES = ["aria-checked", "aria-pressed", "aria-expanded", "aria-selected", "aria-current", "aria-disabled", "aria-invalid", "aria-readonly"];
  const SELECTOR =
    `[role],h1,h2,h3,h4,h5,h6,button,a[href],input,select,textarea,[aria-label],[aria-labelledby],main,nav,header,aside,details,summary,progress,meter,${STATES.map((a) => `[${a}]`).join(",")}`;
  const IMPLICIT = {
    MAIN: "main", NAV: "navigation", HEADER: "banner", ASIDE: "complementary", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
    SECTION: "region", FOOTER: "contentinfo", FORM: "form", ARTICLE: "article", UL: "list", OL: "list", LI: "listitem", IMG: "img", DIALOG: "dialog",
    DETAILS: "group", SUMMARY: "button", PROGRESS: "progressbar", METER: "meter",
  };
  const INPUT = { button: "button", submit: "button", reset: "button", checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox", number: "spinbutton" };
  /* The roles whose name is their own text; every other role is named by its author or not at all. */
  const FROM_TEXT = new Set([
    "button", "link", "heading", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio",
    "switch", "treeitem", "cell", "columnheader", "rowheader", "gridcell", "tooltip",
  ]);
  /* A name is one line and no longer than a person would read as a name: a row's whole text is cut, with a mark. */
  const NAME = 160;
  const squash = (s) => {
    const one = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return one.length > NAME ? `${one.slice(0, NAME)}…` : one;
  };
  const round = (n) => Math.round(n * 10) / 10;
  const num = (n) => String(Math.round(n * 1000) / 1000);

  const roleOf = (el) => {
    const explicit = squash(el.getAttribute("role")).split(" ")[0];
    if (explicit) return explicit;
    if (/^H[1-6]$/.test(el.tagName)) return "heading";
    if (el.tagName === "A") return "link";
    if (el.tagName === "INPUT") return INPUT[kindOf(el)] || "textbox";
    return IMPLICIT[el.tagName] || "generic";
  };

  const nameOf = (el, role) => {
    const by = squash(el.getAttribute("aria-labelledby"));
    if (by) {
      const said = squash(by.split(" ").map((id) => { const t = document.getElementById(id); return t ? t.textContent : ""; }).join(" "));
      if (said) return said;
    }
    const label = squash(el.getAttribute("aria-label"));
    if (label) return label;
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
      /* A button written as an input is named by the words on it. */
      if (role === "button") return squash(shownOf(el).said);
      const own = el.labels && el.labels.length ? squash(el.labels[0].textContent) : "";
      return own || squash(el.getAttribute("placeholder")) || squash(el.getAttribute("title"));
    }
    /* The text as it is rendered: nothing that is not displayed, and a break where the layout has one. Words the browser draws as discs are named by as many discs. */
    if (!FROM_TEXT.has(role)) return "";
    const text = squash(typeof el.innerText === "string" ? el.innerText : el.textContent);
    return text && getComputedStyle(el).getPropertyValue("-webkit-text-security") !== "none" ? "•".repeat([...text].length) : text;
  };

  /* The kind the browser made of a field, not its attribute as written: a type it does not know (`string`, the retired `datetime`, `text ` with a space) is a text field. */
  const kindOf = (el) => (el.tagName === "INPUT" ? el.type : "");
  /* The kinds of field that show their value as words. */
  const WORDED = new Set(["text", "search", "email", "url", "tel", "number", "date", "time", "datetime-local", "month", "week"]);
  /* A field whose words are drawn as discs: it never says them. */
  const secret = (el) => kindOf(el) === "password" || getComputedStyle(el).getPropertyValue("-webkit-text-security") !== "none";
  /**
   * The words a control shows that are no text of the page: a field's value, or its hint while that is
   * what shows; the words on a button written as an input; the option a closed select shows. Nothing
   * that is not on the page is read: not a value drawn as discs, not a field nobody sees. Its white space
   * is kept as the control draws it: a value and a button's words as they are held, a field's hint
   * without the line breaks the browser leaves out of it, an option's label as the browser gives it.
   */
  const shownOf = (el) => {
    const kind = kindOf(el);
    if (el.tagName === "SELECT") return el.multiple || el.size > 1 ? { said: "" } : { said: el.selectedOptions[0] ? el.selectedOptions[0].label : "" };
    if (kind === "button" || kind === "submit" || kind === "reset") return { said: el.value || (kind === "submit" ? "Submit" : kind === "reset" ? "Reset" : "") };
    if (el.tagName !== "TEXTAREA" && !WORDED.has(kind) && kind !== "password") return { said: "" };
    const written = el.getAttribute("placeholder") || "";
    const hint = el.tagName === "TEXTAREA" ? written : written.replace(/[\r\n]/g, "");
    if (el.value === "") return hint.trim() ? { said: hint, hint: true } : { said: "" };
    return secret(el) ? { said: "" } : { said: el.value };
  };
  /**
   * The state a person sees a control in, as a screen reader would say it, in one order: what is on,
   * open, chosen, current, and what cannot be used or is wrong; what a field holds when that is no words
   * (a range's value, how many characters a field of discs holds), and that a field shows its hint.
   */
  const stateOf = (el) => {
    const said = [];
    const a = (n) => (el.getAttribute(n) || "").trim().toLowerCase();
    const kind = kindOf(el), tag = el.tagName;
    if (kind === "checkbox" || kind === "radio") { if (el.indeterminate) said.push("mixed"); else if (el.checked) said.push("checked"); }
    else if (a("aria-checked") === "true") said.push("checked");
    else if (a("aria-checked") === "mixed") said.push("mixed");
    if (a("aria-pressed") === "true") said.push("pressed"); else if (a("aria-pressed") === "mixed") said.push("half pressed");
    if (tag === "DETAILS") { if (el.open) said.push("open"); }
    else if (tag === "SUMMARY" && el.parentElement && el.parentElement.tagName === "DETAILS") said.push(el.parentElement.open ? "expanded" : "collapsed");
    else if (a("aria-expanded") === "true") said.push("expanded");
    else if (a("aria-expanded") === "false") said.push("collapsed");
    if (a("aria-selected") === "true") said.push("selected");
    if (tag === "SELECT" && (el.multiple || el.size > 1)) said.push(`chosen ${[...el.selectedOptions].map((o) => `"${squash(o.label)}"`).join(", ") || "nothing"}`);
    const current = a("aria-current");
    if (current && current !== "false") said.push(current === "true" ? "current" : `current ${current}`);
    let off = a("aria-disabled") === "true";
    try { off = off || el.matches(":disabled"); } catch { /* an element that cannot be disabled */ }
    if (off) said.push("disabled");
    const wrong = a("aria-invalid");
    if (wrong && wrong !== "false") said.push(wrong === "true" ? "invalid" : `invalid ${wrong}`);
    if (((tag === "INPUT" || tag === "TEXTAREA") && el.readOnly) || a("aria-readonly") === "true") said.push("read-only");
    if (kind === "range") said.push(`value ${el.value} of ${el.min || "0"} to ${el.max || "100"}`);
    else if (kind === "color") said.push(`value ${el.value}`);
    else if (kind === "file") said.push(`files ${el.files ? el.files.length : 0}`);
    else if (tag === "PROGRESS") said.push(el.hasAttribute("value") ? `value ${el.value} of ${el.max}` : "busy");
    else if (tag === "METER") said.push(`value ${el.value} of ${el.min} to ${el.max}`);
    else if (el.hasAttribute("aria-valuetext") || el.hasAttribute("aria-valuenow")) said.push(`value ${squash(el.getAttribute("aria-valuetext") || el.getAttribute("aria-valuenow"))}`);
    if (tag === "INPUT" || tag === "TEXTAREA") {
      /* A field of discs says that it is filled and with how many characters: what the picture shows of it, and never which. */
      if (el.value !== "" && secret(el) && (tag === "TEXTAREA" || WORDED.has(kind) || kind === "password")) said.push(`filled ${el.value.length}`);
      if (shownOf(el).hint) said.push("shows its hint");
    }
    return said;
  };

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  /* How much of a colour covers what is under it: 1 hides it, 0 paints nothing. */
  const alpha = (c) => {
    if (!c || c === "transparent") return 0;
    const slash = c.lastIndexOf("/");
    if (slash >= 0) { const a = c.slice(slash + 1).replace(")", "").trim(); return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a); }
    if (c.startsWith("rgba(") || c.startsWith("hsla(")) return parseFloat(c.slice(c.lastIndexOf(",") + 1));
    return 1;
  };

  /* A short digest of a string: twelve hex digits, the same in every page. */
  const digest = (s) => {
    let a = 0xdeadbeef, b = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return ((b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
  };
  /* An address as it is written down: cut to its file's name, so a data file holds no host; a picture written into the page is a digest of itself, and one the page made is only that. */
  const fileOf = (u) => (u.startsWith("data:") ? `data ${digest(u)}` : u.startsWith("blob:") ? "blob" : u.split(/[?#]/)[0].split("/").pop());
  /* A value as it is written down: every address inside it by its file. */
  const image = (v) => v.replace(/url\((["']?)(.*?)\1\)/g, (_m, _q, u) => `url(${fileOf(u)})`);

  /* A property's name as a reading says it: `fontVariantNumeric`, `webkitTextStrokeWidth`. */
  const keyOf = (p) => p.replace(/^-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  /* The elements that are a picture. */
  const PICTURE = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "EMBED", "OBJECT"]);
  /**
   * A control the browser draws itself whatever a stylesheet fills it with: a tick, a dot, a slider, a
   * menu's arrow, a meter. A button, a text field and a text area are not: the browser draws them by
   * their own fill and border as soon as a stylesheet sets either, and those are said.
   */
  const OWN_LOOK = new Set(["checkbox", "radio", "range", "color", "file", "date", "time", "datetime-local", "month", "week", "search", "number"]);
  const native = (el) => el.tagName === "SELECT" || el.tagName === "PROGRESS" || el.tagName === "METER" || (el.tagName === "INPUT" && OWN_LOOK.has(kindOf(el)));
  const cuts = (cs) => cs.overflowX !== "visible" || cs.overflowY !== "visible";
  /**
   * The conditions a row of the lists may name (`when`), each asked of what the row is read on: `cs` its
   * computed style, `el` its element (null for a box a stylesheet draws), and for words `line`, the style
   * of the box that lays out their line, `spaced`, that they hold white space a browser may keep, and
   * `content`, what a stylesheet wrote them as.
   */
  const WHEN = {
    words: {
      "the words hold white space": (x) => x.spaced,
      "the line's box cuts what runs over": (x) => x.line.overflowX !== "visible",
      "drawn words name a quote": (x) => /quote/.test(x.content || ""),
      "inside math": (x) => !!x.el.closest("math"),
    },
    boxes: {
      "the box has a fill or a picture behind it": (x) => alpha(x.cs.backgroundColor) > 0 || x.cs.backgroundImage !== "none",
      "the box paints": (x) => x.painted,
      "something inside the box blends": (x) => !!x.el && [...x.el.querySelectorAll("*")].some((d) => getComputedStyle(d).mixBlendMode !== "normal"),
      "the box is a picture": (x) => !!x.el && PICTURE.has(x.el.tagName),
      "the box is or holds a picture": (x) => (!!x.el && PICTURE.has(x.el.tagName)) || x.cs.backgroundImage !== "none",
      "the box is an element": (x) => !!x.el,
      "the browser draws the box itself": (x) => !!x.el && native(x.el),
      "the box is the page, or the browser draws it itself": (x) => !!x.el && (x.el === document.documentElement || native(x.el)),
      "the box cuts what runs over": (x) => cuts(x.cs),
      "a box that is no picture cuts what runs over": (x) => cuts(x.cs) && !(x.el && (PICTURE.has(x.el.tagName) || x.el.tagName === "svg" || native(x.el))),
      "the box is a list item": (x) => x.cs.display.split(" ").includes("list-item"),
      "the box is a table": (x) => x.cs.display === "table" || x.cs.display === "inline-table",
      "the box is a table's cell": (x) => x.cs.display === "table-cell",
      "the box is turned": (x) => x.cs.transform !== "none" || x.cs.rotate !== "none" || x.cs.scale !== "none",
    },
    shapes: {},
  };
  /** The rows of one list as the reader asks them; a row that names something the reader does not know is refused, never skipped. */
  const rowsOf = (list) => {
    const initial = new Map(lists[list].map((r) => [r.property, r.initial]));
    return lists[list].map((r) => {
      if (r.when && !WHEN[list][r.when]) throw new Error(`scene: ${list}, ${r.property}: the reader knows no condition "${r.when}"`);
      if (r.with && !initial.has(r.with)) throw new Error(`scene: ${list}, ${r.property}: "${r.with}" is not on the list`);
      if (r.from && !["line", "around", "decorating"].includes(r.from)) throw new Error(`scene: ${list}, ${r.property}: the reader knows no place "${r.from}"`);
      if (r.said !== "always" && typeof r.initial !== "string") throw new Error(`scene: ${list}, ${r.property}: no initial value`);
      return {
        name: r.property, key: r.as || keyOf(r.property), always: r.said === "always", own: !r.as && r.said !== "always", initial: r.initial, from: r.from || "",
        when: r.when ? WHEN[list][r.when] : null, spaced: r.when === "the words hold white space", lead: r.with || "", leadInitial: r.with ? initial.get(r.with) : "", quiet: r.quietOnTheBoxOfTheLine || [], middle: r.initialIsTheMiddleOfTheBox === true,
      };
    });
  };
  const ROWS = { words: rowsOf("words"), boxes: rowsOf("boxes"), shapes: rowsOf("shapes") };
  /* A property's computed value where it is other than its initial one, and "" where it is not; `currentcolor` is the colour of the words there. */
  const set = (cs, name, initial) => { const v = cs.getPropertyValue(name); return v === (initial === "currentcolor" ? cs.color : initial) ? "" : v; };
  /**
   * What some rows say of one style, written into `into` in the rows' order: a row is said where its
   * value is not the initial one, the property it paints with is set there too, and its condition holds.
   */
  const say = (rows, cs, x, into, prefix) => {
    const leads = new Map();
    for (const row of rows) {
      if (row.lead) {
        let on = leads.get(row.lead);
        if (on === undefined) { on = !!set(cs, row.lead, row.leadInitial); leads.set(row.lead, on); }
        if (!on) continue;
      }
      let v = set(cs, row.name, row.initial);
      /* A value the browser computes from the box: its initial one is the middle of that box, whatever its size. */
      if (row.middle) {
        v = cs.getPropertyValue(row.name);
        const at = v.split(" ").map(parseFloat);
        if (x.el ? Math.abs(at[0] - x.el.offsetWidth / 2) <= 1 && Math.abs(at[1] - x.el.offsetHeight / 2) <= 1 : !at[0] && !at[1]) continue;
      }
      if (!v || (row.when && !row.when(x))) continue;
      into[prefix + row.key] = v.includes("url(") ? image(v) : v;
    }
  };
  const BOX_ROWS = ROWS.boxes.filter((r) => r.own), SHAPE_ROWS = ROWS.shapes.filter((r) => r.own);
  const WORD_ROWS = ROWS.words.filter((r) => r.own && !r.from), LINE_ROWS = ROWS.words.filter((r) => r.own && r.from === "line"), AROUND_ROWS = ROWS.words.filter((r) => r.own && r.from === "around");
  /* The rows that make up a line under, over or through words: the line itself first, then what it is drawn with. */
  const DECORATING = ROWS.words.filter((r) => r.from === "decorating");
  if (DECORATING.length && DECORATING[0].name !== "text-decoration-line") throw new Error("scene: words, the first decorating row must be text-decoration-line");

  /**
   * What each element inherits from those around it, read once: whether it is displayed at all, whether
   * a screen reader is kept from it, how see-through it is, and the box its descendants are cut to. A
   * fixed box is cut by the window alone.
   */
  const facts = new Map();
  const factsOf = (el) => {
    let f = facts.get(el);
    if (f) return f;
    const up = el.parentElement ? factsOf(el.parentElement) : { gone: false, unsaid: false, through: 1, kids: [0, 0, vw, vh] };
    const cs = getComputedStyle(el);
    const own = cs.position === "fixed" ? [0, 0, vw, vh] : up.kids;
    let kids = own;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const c = el.getBoundingClientRect();
      kids = own.slice();
      if (cs.overflowX !== "visible") { kids[0] = Math.max(kids[0], c.left); kids[2] = Math.min(kids[2], c.right); }
      if (cs.overflowY !== "visible") { kids[1] = Math.max(kids[1], c.top); kids[3] = Math.min(kids[3], c.bottom); }
    }
    f = {
      cs,
      gone: up.gone || cs.display === "none" || cs.opacity === "0",
      unsaid: up.unsaid || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden") || el.hasAttribute("inert"),
      through: up.through * Number(cs.opacity),
      own,
      kids,
    };
    facts.set(el, f);
    return f;
  };

  /* What of an element's box the picture can show: the box cut by the window and by every clipping ancestor. */
  const visible = (el) => {
    const f = factsOf(el);
    /* Visibility is inherited and a child may turn it back on, so only the element's own computed value counts. */
    if (f.gone || f.cs.visibility !== "visible") return null;
    /* The browser's own answer for what it does not draw though it has a box: a closed details' content, content under `content-visibility: hidden` or `hidden="until-found"`. */
    if (!el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return null;
    const r = el.getBoundingClientRect();
    const x0 = Math.max(f.own[0], r.left), y0 = Math.max(f.own[1], r.top), x1 = Math.min(f.own[2], r.right), y1 = Math.min(f.own[3], r.bottom);
    return x1 - x0 > 0 && y1 - y0 > 0 ? [x0, y0, x1, y1] : null;
  };

  /* An element nothing shows through: a solid fill, in nothing see-through. */
  const solid = (el) => { const f = factsOf(el); return f.through === 1 && f.cs.visibility === "visible" && alpha(f.cs.backgroundColor) === 1; };

  /**
   * Whether something opaque lies over the element at one point. Null where the element is not hit there
   * (a round corner, a gap between its lines): such a point says nothing.
   */
  const under = (el, x, y) => {
    const stack = document.elementsFromPoint(x, y);
    let at = -1;
    for (let i = 0; i < stack.length; i++) if (stack[i] === el || el.contains(stack[i])) { at = i; break; }
    if (at < 0) return null;
    for (let i = 0; i < at; i++) if (!stack[i].contains(el) && solid(stack[i])) return true;
    return false;
  };

  /* Covered: at its middle and at eight more points of its visible box, something opaque that is neither around it nor inside it lies above it. */
  const covered = (el, b) => {
    const mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
    const mid = under(el, mx, my);
    if (mid === false) return false;
    const ex = Math.min(1.5, (b[2] - b[0]) / 4), ey = Math.min(1.5, (b[3] - b[1]) / 4);
    let said = mid === true ? 1 : 0;
    for (const x of [b[0] + ex, mx, b[2] - ex]) {
      for (const y of [b[1] + ey, my, b[3] - ey]) {
        if (x === mx && y === my) continue;
        const u = under(el, x, y);
        if (u === false) return false;
        if (u === true) said++;
      }
    }
    return said > 0;
  };

  const sights = new Map();
  /* Seen: the picture shows at least a part of it. */
  const seen = (el) => {
    let s = sights.get(el);
    if (s === undefined) { const b = visible(el); s = !!b && !covered(el, b); sights.set(el, s); }
    return s;
  };

  /**
   * How a thing is turned, from the linear part [a, b, c, d] of the matrix the browser puts it on the screen
   * with. Where it is and how large it is drawn are taken out (its box says those), so the same thing moved,
   * zoomed or at another scale says the same, and one turn says the same however and wherever it is written.
   * A turn says its angle, a mirror that it is one, anything else (a slant, a squash) its matrix. Upright
   * says nothing.
   */
  const turnOf = (m) => {
    const unit = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    if (!(unit > 0)) return "";
    let a = m[0] / unit, b = m[1] / unit;
    const c = m[2] / unit, d = m[3] / unit;
    const mirrored = a * d - b * c < 0;
    if (mirrored) { a = -a; b = -b; }
    const at = Math.atan2(b, a), cos = Math.cos(at), sin = Math.sin(at);
    const near = (x, y) => Math.abs(x - y) < 0.002;
    if (!near(a, cos) || !near(b, sin) || !near(c, -sin) || !near(d, cos)) return `matrix ${m.map((v) => num(v / unit)).join(" ")}`;
    let deg = Math.round(at * 18000 / Math.PI) / 100;
    if (deg === -180) deg = 180;
    return `${mirrored ? "mirrored" : ""}${mirrored && deg ? " " : ""}${deg ? `${deg}deg` : ""}`;
  };
  /* One matrix after another: what `o` does, then what `p` does. */
  const times = (p, o) => [p[0] * o[0] + p[2] * o[1], p[1] * o[0] + p[3] * o[1], p[0] * o[2] + p[2] * o[3], p[1] * o[2] + p[3] * o[3]];
  const UPRIGHT = [1, 0, 0, 1];
  /* The elements that are a box of their own though a line holds them. */
  const OWN_BOX = new Set(["IMG", "svg", "VIDEO", "CANVAS", "IFRAME", "EMBED", "OBJECT", "INPUT", "TEXTAREA", "SELECT", "AUDIO", "METER", "PROGRESS"]);
  /**
   * What a box's own rules turn it by: `rotate`, `scale` and `transform`, in the order the browser applies
   * them; null when they turn nothing. A box that is a part of a line takes none, whatever its rule says.
   */
  const ownTurn = (cs, ownBox) => {
    if (cs.transform === "none" && cs.rotate === "none" && cs.scale === "none") return null;
    if (cs.display === "contents" || (cs.display === "inline" && !ownBox)) return null;
    try {
      let m = new DOMMatrix();
      if (cs.rotate !== "none") {
        const p = cs.rotate.split(" ");
        const axis = p.length === 1 ? "0,0,1" : p.length === 2 ? { x: "1,0,0", y: "0,1,0", z: "0,0,1" }[p[0]] : p.slice(0, 3).join(",");
        m = m.multiply(new DOMMatrix(`rotate3d(${axis},${p[p.length - 1]})`));
      }
      if (cs.scale !== "none") { const p = cs.scale.split(" "); m = m.multiply(new DOMMatrix(`scale3d(${p[0]},${p[1] || p[0]},${p[2] || 1})`)); }
      if (cs.transform !== "none") m = m.multiply(new DOMMatrix(cs.transform));
      return [m.m11, m.m12, m.m21, m.m22];
    } catch { return null; }
  };
  /* An element the browser lifts out of the page and draws over it: nothing around it turns it. */
  const lifted = (el) => { try { return el.matches(":modal,:popover-open"); } catch { return false; } };
  const matrices = new Map();
  /**
   * The linear part of the matrix an element is put on the screen with, everything around it folded in. A
   * shape inside an `svg` is asked of the browser; an element of the page has no such question, so its
   * own turn is read from its computed rules and folded into that of the element around it.
   */
  const matrixOf = (el) => {
    let m = matrices.get(el);
    if (m) return m;
    if (el.ownerSVGElement && el.getScreenCTM) { const s = el.getScreenCTM(); m = s ? [s.a, s.b, s.c, s.d] : UPRIGHT; }
    else {
      const up = !el.parentElement || lifted(el) ? UPRIGHT : matrixOf(el.parentElement);
      const own = ownTurn(factsOf(el).cs, OWN_BOX.has(el.tagName));
      m = own ? times(up, own) : up;
    }
    matrices.set(el, m);
    return m;
  };
  /* How words are turned: with the box they stand in, and by the way their line is written. */
  const wordsTurn = (m, cs) => [turnOf(m), cs.writingMode === "horizontal-tb" ? "" : `${cs.writingMode}${cs.textOrientation === "mixed" ? "" : ` ${cs.textOrientation}`}`].filter(Boolean).join(" ");

  /* The box that lays out the line an element's words stand in: the element itself, unless it is a part of a line or makes no box. */
  const lineOf = (el) => {
    for (let at = el; ; at = at.parentElement) {
      const d = factsOf(at).cs.display;
      if ((d !== "inline" && d !== "contents") || !at.parentElement) return at;
    }
  };
  /**
   * A line under, over or through words, as the box that draws it says it: which lines, their colour, and
   * what else of them is not as the browser draws a plain one (the rows the list reads `from` the
   * decorating box). A box that makes no box draws none.
   */
  const lineSaid = (cs) => {
    if (!DECORATING.length || cs.display === "contents") return "";
    let said = set(cs, DECORATING[0].name, DECORATING[0].initial);
    if (!said) return "";
    for (let i = 1; i < DECORATING.length; i++) {
      const row = DECORATING[i];
      /* The line's colour is the decorating box's, not the words': it is said whatever it is. */
      if (row.initial === "currentcolor") { said += ` ${cs.getPropertyValue(row.name)}`; continue; }
      const v = set(cs, row.name, row.initial);
      if (v) said += ` ${row.name.replace(/^text-(decoration-)?/, "")} ${v}`;
    }
    return said;
  };
  /* A box that keeps the lines of the boxes around it out of its words: one lifted out of the flow, or one set in a line as a box of its own. */
  const keepsOut = (cs) => cs.display !== "contents" && (cs.position === "absolute" || cs.position === "fixed" || cs.float !== "none" || /^(inline-|ruby-text)/.test(cs.display));
  const decorations = new Map();
  /**
   * Every line drawn under, over or through the words that stand in an element, nearest box first. A line
   * is drawn by the box that declares it, through the words of every box inside it that the browser
   * passes it on to; a child's own computed value says none there.
   */
  const decorationOf = (el) => {
    let d = decorations.get(el);
    if (d !== undefined) return d;
    const cs = factsOf(el).cs;
    const own = lineSaid(cs), up = keepsOut(cs) || !el.parentElement ? "" : decorationOf(el.parentElement);
    d = own && up ? `${own}; ${up}` : own || up;
    decorations.set(el, d);
    return d;
  };
  const SPACED = /[\t\n\r\f]|\s{2,}/;
  /**
   * What the lists say of words beyond their type, as [key, value, only of words that hold white space] in
   * the list's order. `cs` is the style the words stand in: an element's own, or that of a box a
   * stylesheet draws on `el` (`drawn`: before or after it, or a field's hint); `content` is what a
   * stylesheet wrote the words as.
   */
  const wordsMore = (cs, el, drawn, content) => {
    const inLine = cs.display === "inline" || cs.display === "contents";
    const holder = !drawn || inLine ? lineOf(el) : null;
    const line = holder ? factsOf(holder).cs : cs;
    const x = { cs, el, line, spaced: true, content };
    /** @type {[string, string, boolean][]} */
    const out = [];
    const leads = new Map();
    let lined = false;
    for (const row of ROWS.words) {
      if (row.from === "decorating") {
        if (lined) continue;
        lined = true;
        const own = drawn ? lineSaid(cs) : "", up = drawn && keepsOut(cs) ? "" : decorationOf(el);
        if (own || up) out.push([row.key, own && up ? `${own}; ${up}` : own || up, false]);
        continue;
      }
      if (!row.own) continue;
      if (row.from === "around") {
        /* The boxes of the line around the words, from their own out to the one that lays the line out. */
        const said = [];
        const ask = (style, laysOut) => { const v = set(style, row.name, row.initial); if (v && !(laysOut && row.quiet.includes(v))) said.push(v); };
        if (drawn) ask(cs, !inLine);
        if (holder) for (let at = el; ; at = at.parentElement) { ask(factsOf(at).cs, at === holder); if (at === holder) break; }
        if (said.length) out.push([row.key, said.join(" / "), false]);
        continue;
      }
      const style = row.from === "line" ? line : cs;
      if (row.lead) {
        let on = leads.get(row.lead);
        if (on === undefined) { on = !!set(style, row.lead, row.leadInitial); leads.set(row.lead, on); }
        if (!on) continue;
      }
      const v = set(style, row.name, row.initial);
      if (!v || (row.when && !row.when(x))) continue;
      out.push([row.key, v.includes("url(") ? image(v) : v, row.spaced]);
    }
    return out;
  };
  const mores = new Map();
  const moreOf = (el) => { let m = mores.get(el); if (!m) { m = wordsMore(factsOf(el).cs, el, false, ""); mores.set(el, m); } return m; };
  const ALWAYS = ROWS.words.filter((r) => r.always);
  /** The type words are drawn in: the values every type says, what the lists say beyond them, and how the words are turned. */
  const typeOf = (cs, more, spaced, turn) => {
    /** @type {Record<string, string>} */
    const style = {};
    for (const row of ALWAYS) style[row.key] = cs.getPropertyValue(row.name);
    for (const [key, value, onlySpaced] of more) if (!onlySpaced || spaced) style[key] = value;
    if (turn) style.turn = turn;
    return style;
  };
  /* Words as they are said: white space squashed; words the browser draws as discs are that many discs. */
  const wordsSaid = (text, cs) => { const one = text.replace(/\s+/g, " ").trim(); return one && cs.getPropertyValue("-webkit-text-security") !== "none" ? "•".repeat([...one].length) : one; };

  /* A hit test asks where the pointer would land, and many a drawn thing lets the pointer through. For the length of this read, nothing does. */
  const probe = document.createElement("style");
  probe.textContent = "*,*::before,*::after{pointer-events:auto!important}";
  document.documentElement.append(probe);

  try {
    /** @type {any[]} */
    const nodes = [];
    const nodeOf = new Map();
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (factsOf(el).unsaid || !seen(el)) continue;
      const role = roleOf(el);
      const r = el.getBoundingClientRect();
      const cs = factsOf(el).cs;
      const node = {
        role,
        name: nameOf(el, role),
        box: [round(r.left), round(r.top), round(r.width), round(r.height)],
        drawn: {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing,
          borderRadius: cs.borderRadius,
          paddingTop: cs.paddingTop,
          paddingRight: cs.paddingRight,
          paddingBottom: cs.paddingBottom,
          paddingLeft: cs.paddingLeft,
          borderColor: cs.borderColor,
        },
      };
      if (role === "heading") node.level = Number(el.getAttribute("aria-level")) || Number(el.tagName.slice(1)) || 2;
      const state = stateOf(el);
      if (state.length) node.state = state;
      const turn = turnOf(matrixOf(el));
      if (turn) node.turn = turn;
      nodes.push(node);
      nodeOf.set(el, node);
    }
    const loose = { text: [], surfaces: [] };
    /* The nearest node around an element, itself included; `loose` when there is none. */
    const ownerOf = (el) => { for (let at = el; at; at = at.parentElement) { const n = nodeOf.get(at); if (n) return n; } return loose; };

    /* A table of each: a page draws its words in a handful of styles and its surfaces in a handful of paints. */
    const table = () => { const rows = [], at = new Map(); return { rows, of: (row) => { const k = JSON.stringify(row); let i = at.get(k); if (i === undefined) { i = rows.length; rows.push(row); at.set(k, i); } return i; } }; };
    const types = table(), paints = table();

    /* The words: every piece of text the picture shows, with the style of the element it stands in. */
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    /* A page's words in one style are one run however the page cut them; what a control shows is a run of its own (`shown`), with its white space. */
    const put = (owner, said, type, shown) => {
      const runs = owner.text || (owner.text = []);
      const last = runs[runs.length - 1];
      if (shown) runs.push({ said, type, shown: true });
      else if (last && last.type === type && !last.shown) last.said += ` ${said}`;
      else runs.push({ said, type });
    };
    /*
     * Words the browser lays out nowhere are not drawn: what is written inside a progress, a meter, a canvas,
     * a video or a loaded object in its place. The one exception: a list box draws its options' words itself,
     * and lays out no text of them.
     */
    const range = document.createRange();
    const laidOut = (t) => { if (t.parentElement.closest("option")) return true; range.selectNodeContents(t); return range.getClientRects().length > 0; };
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      /* What a field or a closed select shows is its value, not the text it was written with: said below. */
      if (!el || !t.data.trim() || el.closest("script,style,noscript,template") || !laidOut(t)) continue;
      const field = el.closest("textarea,select");
      if (field && (field.tagName === "TEXTAREA" || !(field.multiple || field.size > 1))) continue;
      const cs = factsOf(el).cs;
      const said = wordsSaid(t.data, cs);
      /* An element with `display: contents` makes no box: its words stand in the nearest one around it that does. */
      let box = el;
      while (box.parentElement && factsOf(box).cs.display === "contents") box = box.parentElement;
      if (cs.visibility !== "visible" || !seen(box)) continue;
      put(ownerOf(el), said, types.of(typeOf(cs, moreOf(el), SPACED.test(t.data), wordsTurn(matrixOf(el), cs))));
    }
    /* What a control shows is its words: a field's value, its hint while that is what shows, the option a closed select shows. */
    for (const [el, node] of nodeOf) {
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") continue;
      const shown = shownOf(el);
      if (!shown.said.trim()) continue;
      const own = factsOf(el).cs;
      const cs = shown.hint ? getComputedStyle(el, "::placeholder") : own;
      const said = cs.getPropertyValue("-webkit-text-security") !== "none" ? "•".repeat([...shown.said].length) : shown.said;
      put(node, said, types.of(typeOf(cs, shown.hint ? wordsMore(cs, el, true, "") : moreOf(el), SPACED.test(shown.said), wordsTurn(matrixOf(el), own))), true);
    }

    const SIDES = ["Top", "Right", "Bottom", "Left"];
    /* A shadow's layers that paint: one with no colour, or with no offset, blur or spread, draws nothing. */
    const shadowOf = (v) => {
      if (v === "none") return "";
      const layers = [];
      let depth = 0, from = 0;
      for (let i = 0; i <= v.length; i++) {
        const c = v[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (i === v.length || (c === "," && depth === 0)) { layers.push(v.slice(from, i).trim()); from = i + 1; }
      }
      return layers.filter((l) => {
        const close = l.lastIndexOf(")");
        const colour = close >= 0 ? l.slice(l.search(/[a-z-]+\(/), close + 1) : "";
        const lengths = (close >= 0 ? l.slice(0, l.search(/[a-z-]+\(/)) + l.slice(close + 1) : l).match(/-?[\d.]+px/g) || [];
        return alpha(colour || "x") > 0 && lengths.some((n) => parseFloat(n) !== 0);
      }).join(", ");
    };
    /**
     * What an element (`el`), or one of its two generated boxes (no `el`), paints: the readings that are
     * made of several properties, then every other row of the boxes' list that is said there. True when
     * its box paints anything by itself: a fill, a border, a shadow or an outline.
     * @param {CSSStyleDeclaration} cs
     */
    const paintOf = (cs, into, prefix, el) => {
      const before = Object.keys(into).length;
      if (alpha(cs.backgroundColor) > 0) into[`${prefix}backgroundColor`] = cs.backgroundColor;
      if (cs.backgroundImage !== "none") into[`${prefix}backgroundImage`] = image(cs.backgroundImage);
      const sides = SIDES.map((s) => (cs[`border${s}Style`] !== "none" && cs[`border${s}Style`] !== "hidden" && parseFloat(cs[`border${s}Width`]) > 0 && alpha(cs[`border${s}Color`]) > 0
        ? `${cs[`border${s}Width`]} ${cs[`border${s}Style`]} ${cs[`border${s}Color`]}` : ""));
      if (sides.every((s) => s && s === sides[0])) into[`${prefix}border`] = sides[0];
      else SIDES.forEach((s, i) => { if (sides[i]) into[`${prefix}border${s}`] = sides[i]; });
      const shadow = shadowOf(cs.boxShadow);
      if (shadow) into[`${prefix}boxShadow`] = shadow;
      if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && alpha(cs.outlineColor) > 0) into[`${prefix}outline`] = `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor} ${cs.outlineOffset}`;
      const painted = Object.keys(into).length > before;
      if (cs.opacity !== "1") into[`${prefix}opacity`] = cs.opacity;
      say(BOX_ROWS, cs, { cs, el, painted }, into, prefix);
      return painted;
    };
    /**
     * The box of what a stylesheet draws before or after an element, before any turn and in the picture's
     * pixels: its size, and ahead of it where it lies from its element's corner when the element holds it.
     * Null where it has no box of its own (a part of a line).
     */
    const partBox = (el, own, cs) => {
      const px = (v) => parseFloat(v) || 0;
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
      const inner = cs.boxSizing !== "border-box";
      const m = matrixOf(el);
      const unit = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) * (el.currentCSSZoom || 1);
      const size = [w + (inner ? px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth) : 0), h + (inner ? px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) : 0)];
      const place = cs.position === "absolute" && own.position !== "static" ? [px(own.borderLeftWidth) + px(cs.left) + px(cs.marginLeft), px(own.borderTopWidth) + px(cs.top) + px(cs.marginTop)] : [];
      return [...place, ...size].map((v) => round(v * unit));
    };
    const SHAPES = "path,circle,rect,line,polyline,polygon,ellipse,text,use,image";
    /* Where a shape is kept for something else to draw: it is not drawn where it stands. */
    const KEPT = "defs,symbol,clipPath,mask,marker,pattern,linearGradient,radialGradient";
    /* That something cuts or filters a shape is said; what the cut is, the picture shows. */
    const cutOf = (c) => `${c.clipPath !== "none" ? " clip" : ""}${c.maskImage && c.maskImage !== "none" ? " mask" : ""}${c.filter !== "none" ? " filter" : ""}${c.mixBlendMode !== "normal" ? ` blend ${c.mixBlendMode}` : ""}`;
    /**
     * What a shape paints where it stands under `top`, and what is done to it on the way up: null when
     * nobody sees it. Not displayed and fully see-through are asked of every element between the two, a
     * group's as much as its own; `entry` is the one kept thing a `use` may enter.
     */
    const paintedBy = (shape, top, entry) => {
      const cs = getComputedStyle(shape);
      if (cs.visibility !== "visible") return null;
      let through = 1, cut = "";
      for (let at = shape; at && at !== top; at = at.parentElement) {
        if (at !== shape && at !== entry && at.matches(KEPT)) return null;
        const c = at === shape ? cs : getComputedStyle(at);
        if (c.display === "none") return null;
        through *= Number(c.opacity);
        cut += cutOf(c);
      }
      if (!(through > 0)) return null;
      /* A picture inside an icon has no fill and no stroke: it is there, and its geometry says which. */
      if (shape.tagName.toLowerCase() === "image") return { cs, said: `image${through === 1 ? "" : `, opacity ${num(through)}`}`, cut };
      const parts = [];
      const fill = Number(cs.fillOpacity), stroke = Number(cs.strokeOpacity);
      if (cs.fill !== "none" && alpha(cs.fill) > 0 && fill > 0) parts.push(`fill ${cs.fill}${cs.fillRule === "nonzero" ? "" : ` ${cs.fillRule}`}${fill === 1 ? "" : ` at ${num(fill)}`}`);
      if (cs.stroke !== "none" && alpha(cs.stroke) > 0 && parseFloat(cs.strokeWidth) > 0 && stroke > 0) {
        /* Dashes of no length are a whole line. */
        const dash = /[1-9]/.test(cs.strokeDasharray) ? ` dash ${cs.strokeDasharray}${parseFloat(cs.strokeDashoffset) ? ` from ${cs.strokeDashoffset}` : ""}${shape.hasAttribute("pathLength") ? ` of ${shape.getAttribute("pathLength")}` : ""}` : "";
        /* A stroke that keeps its width however large the icon is drawn. */
        const kept = cs.vectorEffect === "non-scaling-stroke" ? " unscaled" : "";
        parts.push(`stroke ${cs.stroke} ${cs.strokeWidth} ${cs.strokeLinecap} ${cs.strokeLinejoin}${cs.strokeLinejoin.startsWith("miter") ? ` ${cs.strokeMiterlimit}` : ""}${kept}${dash}${stroke === 1 ? "" : ` at ${num(stroke)}`}`);
      }
      if (!parts.length) return null;
      /* The stroke is painted over the fill unless the shape asks for the other order. */
      const order = String(cs.paintOrder || "normal").split(" ");
      if (parts.length === 2 && order.includes("stroke") && (!order.includes("fill") || order.indexOf("stroke") < order.indexOf("fill"))) parts.push("stroke under fill");
      if (through !== 1) parts.push(`opacity ${num(through)}`);
      return { cs, said: parts.join(", "), cut };
    };
    /* A shape's geometry as the browser resolved it: a path reads the same however its commands are written. */
    const geometryOf = (el, cs, depth) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "path") return cs.d && cs.d !== "none" ? cs.d : String(el.getAttribute("d"));
      if (tag === "circle") return `${cs.cx} ${cs.cy} ${cs.r}`;
      if (tag === "ellipse") return `${cs.cx} ${cs.cy} ${cs.rx} ${cs.ry}`;
      if (tag === "rect") return `${cs.x} ${cs.y} ${cs.width} ${cs.height} ${cs.rx} ${cs.ry}`;
      if (tag === "line") return [el.x1, el.y1, el.x2, el.y2].map((v) => num(v.baseVal.value)).join(" ");
      if (tag === "polyline" || tag === "polygon") return [...el.points].map((p) => `${num(p.x)},${num(p.y)}`).join(" ");
      if (tag === "text") return `${el.getAttribute("x")} ${el.getAttribute("y")}${cs.textAnchor && cs.textAnchor !== "start" ? ` ${cs.textAnchor}` : ""} ${String(el.textContent).replace(/\s+/g, " ").trim()}`;
      if (tag === "image") { const src = el.href ? el.href.baseVal : ""; return `${cs.x} ${cs.y} ${cs.width} ${cs.height} ${src.startsWith("data:") ? `data ${digest(src)}` : src.split(/[?#]/)[0].split("/").pop()}`; }
      /* A `use` draws what it points at: that thing's shapes that are seen, each with its paint, where its own definition puts it. */
      const to = el.href && el.href.baseVal.startsWith("#") ? document.getElementById(el.href.baseVal.slice(1)) : null;
      const drawn = [];
      const from = to && to.parentElement && to.parentElement.getCTM ? to.parentElement.getCTM() : null;
      for (const d of !to || depth > 3 ? [] : to.matches(SHAPES) ? [to] : [...to.querySelectorAll(SHAPES)].slice(0, 64)) {
        const p = paintedBy(d, to.parentElement, to);
        if (!p) continue;
        const own = from && d.getCTM ? d.getCTM() : null;
        const m = own ? from.inverse().multiply(own) : null;
        const placed = m && [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite) ? [m.a, m.b, m.c, m.d, m.e, m.f].map(num).join(" ") : p.cs.transform;
        drawn.push(`${d.tagName.toLowerCase()} ${geometryOf(d, p.cs, depth + 1)} ${placed}${p.cut} ${p.said}`);
      }
      return `${cs.x} ${cs.y} ${cs.width} ${cs.height} ${to ? to.getAttribute("viewBox") || "" : el.href ? el.href.baseVal : ""}[${drawn.join("|")}]`;
    };
    /**
     * An icon's ink: the fills and strokes of the shapes a person sees, each said once, a stroke with its
     * cap, its join and its dashes; then how many such shapes it draws and a digest of their kind, their
     * geometry and where the browser puts each on the screen, in order. That last is one matrix a shape,
     * with everything that turns, mirrors or skews it folded in, wherever it is written: on the shape, on a
     * group, on the svg or on anything around it. The matrix is read from the icon's middle and in the
     * icon's own units, so the same icon moved, zoomed or drawn larger says the same; its box says those.
     * It is the reading `turnOf` makes of everything else that paints, kept whole here: a shape's place
     * inside its icon is a part of the drawing. So an icon's turn is said once, by its ink.
     */
    const inkOf = (svg) => {
      const said = new Set();
      const shapes = svg.querySelectorAll(SHAPES);
      const view = svg.viewBox.baseVal;
      const drawn = [`${view ? [view.x, view.y, view.width, view.height].map(num).join(" ") : ""}${cutOf(getComputedStyle(svg))}`];
      const whole = svg.getScreenCTM(), r = svg.getBoundingClientRect();
      /* One of the icon's units on the screen, whatever sized it: a turn or a mirror leaves it as it is. */
      const unit = whole ? Math.sqrt(Math.abs(whole.a * whole.d - whole.b * whole.c)) : 0;
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      for (let i = 0; i < shapes.length && i < 512; i++) {
        const shape = shapes[i];
        const p = paintedBy(shape, svg, null);
        if (!p) continue;
        said.add(p.said);
        const m = unit > 0 ? shape.getScreenCTM() : null;
        const placed = m ? [m.a / unit, m.b / unit, m.c / unit, m.d / unit, (m.e - cx) / unit, (m.f - cy) / unit].map(num).join(" ") : "flat";
        /* What the shapes' list says beyond a fill and a stroke: a marker at a line's end, how an edge is drawn, where a word in the icon stands. */
        /** @type {Record<string, string>} */
        const more = {};
        say(SHAPE_ROWS, p.cs, { cs: p.cs, el: shape }, more, "");
        drawn.push(`${shape.tagName.toLowerCase()} ${geometryOf(shape, p.cs, 0)} ${placed}${p.cut}${Object.keys(more).map((k) => ` ${k} ${more[k]}`).join("")}`);
      }
      if (!said.size) return "";
      return `${[...said].sort().join("; ")}; shapes ${drawn.length - 1}${shapes.length > 512 ? ` of ${shapes.length}` : ""} ${digest(drawn.join("\n"))}`;
    };

    /* A fill of the very colour it stands on shows nothing: the first painted thing under its middle is a solid fill of that colour and holds its whole box. */
    const showsOn = (el, fill, r) => {
      const b = visible(el);
      if (!b) return true;
      const stack = document.elementsFromPoint((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
      let at = 0;
      while (at < stack.length && stack[at] !== el && !el.contains(stack[at])) at++;
      for (let i = at + 1; i < stack.length; i++) {
        if (stack[i] === el || el.contains(stack[i])) continue;
        const cs = factsOf(stack[i]).cs;
        if (cs.backgroundImage !== "none") return true;
        const a = alpha(cs.backgroundColor);
        if (a === 0) continue;
        if (a < 1 || cs.backgroundColor !== fill) return true;
        const o = stack[i].getBoundingClientRect();
        return !(r.left >= o.left && r.top >= o.top && r.right <= o.right && r.bottom <= o.bottom);
      }
      return true;
    };

    /* The surfaces: every element that paints, itself or through one of its two generated boxes. */
    const all = [document.documentElement, ...document.documentElement.querySelectorAll("*")];
    for (const el of all) {
      if (el === probe || el.ownerSVGElement) continue;
      const f = factsOf(el);
      if (f.gone) continue;
      /** @type {Record<string, string>} */
      const paint = {};
      paintOf(f.cs, paint, "", el);
      /* A picture that is no inline svg says which it is: its file's name, or a digest of one written into the page. What a canvas, a video or a frame shows is the picture's to say. */
      if (PICTURE.has(el.tagName)) paint.shows = el.tagName === "IMG" ? `img ${fileOf(el.currentSrc || el.getAttribute("src") || "")}`.trim() : el.tagName === "IFRAME" || el.tagName === "EMBED" || el.tagName === "OBJECT" ? "frame" : el.tagName.toLowerCase();
      const r = el.getBoundingClientRect();
      const fill = paint.backgroundColor;
      /* A node's own fill is among its drawn values already. */
      if (fill && (nodeOf.has(el) || (Object.keys(paint).length === 1 && alpha(fill) === 1 && !showsOn(el, fill, r)))) delete paint.backgroundColor;
      /* Its own box paints: something of it is left that is more than how see-through it is. */
      const boxed = Object.keys(paint).some((k) => k !== "opacity");
      if (el instanceof SVGSVGElement) { const ink = inkOf(el); if (ink) paint.ink = ink; }
      /** @type {Record<string, number[]> | null} */
      let parts = null;
      for (const part of ["before", "after"]) {
        const cs = getComputedStyle(el, `::${part}`);
        if (cs.content === "none" || cs.content === "normal" || cs.display === "none") continue;
        /** @type {Record<string, string>} */
        const made = {};
        const drawn = paintOf(cs, made, `${part}.`, null);
        /* Words, or what a stylesheet names in their place (a picture, a count, a quote): anything but nothing at all. */
        const words = cs.content.length > 2;
        /* A box that neither paints nor says anything leaves nothing behind, whatever else is set on it. */
        if (!drawn && !words) continue;
        if (words) {
          made[`${part}.content`] = image(cs.content);
          made[`${part}.color`] = cs.color;
          made[`${part}.font`] = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`;
          /* The rest of what the words' list says, as it is said of the page's words: nothing where it is plain. */
          for (const row of ALWAYS) { if (typeof row.initial !== "string") continue; const v = set(cs, row.name, row.initial); if (v) made[`${part}.${row.key}`] = v; }
          for (const [key, value, onlySpaced] of wordsMore(cs, el, true, cs.content)) if (!onlySpaced || SPACED.test(cs.content)) made[`${part}.${key}`] = value;
        }
        if (drawn && cs.borderRadius !== "0px") made[`${part}.borderRadius`] = cs.borderRadius;
        Object.assign(paint, made);
        const own = ownTurn(cs, false);
        const m = own ? times(matrixOf(el), own) : matrixOf(el);
        const turn = words ? wordsTurn(m, cs) : turnOf(m);
        if (turn) paint[`${part}.turn`] = turn;
        const box = drawn ? partBox(el, f.cs, cs) : null;
        if (box) (parts || (parts = {}))[part] = box;
      }
      if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.placeholder && !el.value) paint.placeholder = getComputedStyle(el, "::placeholder").color;
      /* Round corners show on a box that paints, and on one that cuts what runs over it though it paints nothing itself. */
      const rounded = f.cs.borderRadius !== "0px";
      if (rounded && cuts(f.cs)) paint.borderRadius = f.cs.borderRadius;
      if (!Object.keys(paint).length || !seen(el)) continue;
      if (rounded) paint.borderRadius = f.cs.borderRadius;
      /* An icon's ink says how each of its shapes is turned; the box around it says its own turn only when it paints. */
      const turn = boxed ? turnOf(matrixOf(el)) : "";
      if (turn) paint.turn = turn;
      const owner = ownerOf(el);
      const surface = { box: [round(r.left), round(r.top), round(r.width), round(r.height)], paint: paints.of(paint) };
      if (parts) surface.parts = parts;
      (owner.surfaces || (owner.surfaces = [])).push(surface);
    }

    /* The faces that arrived. One that is declared and did not load is not here, whatever a font-family says. */
    const faces = new Map();
    for (const f of document.fonts) {
      if (f.status !== "loaded") continue;
      const face = { family: f.family.replace(/^["']|["']$/g, ""), weight: f.weight, style: f.style };
      faces.set(`${face.family} ${face.weight} ${face.style}`, face);
    }

    return {
      reader: 7,
      variant,
      page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw, scrollHeight: document.documentElement.scrollHeight },
      fonts: [...faces.keys()].sort().map((k) => faces.get(k)),
      types: types.rows,
      paints: paints.rows,
      nodes,
      loose,
    };
  } finally {
    probe.remove();
  }
}
