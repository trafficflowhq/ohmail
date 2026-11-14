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
 *   nodes     landmarks, headings and controls: role, name, box, and the values a token carries
 *   text      the words inside each node, with the colour and the type they are drawn in
 *   surfaces  every element that paints something (a fill, a border, a shadow, an icon's strokes and shapes), with its box
 *             and with the box of what a stylesheet draws before or after it
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
 * @param {import("./scene.d.mts").Variant} variant echoed into the scene, so a data file says what it was read in
 * @returns {import("./scene.d.mts").Scene}
 */
export function readScene(variant) {
  const SELECTOR =
    "[role],h1,h2,h3,h4,h5,h6,button,a[href],input,select,textarea,[aria-label],[aria-labelledby],main,nav,header,aside";
  const IMPLICIT = {
    MAIN: "main", NAV: "navigation", HEADER: "banner", ASIDE: "complementary", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
    SECTION: "region", FOOTER: "contentinfo", FORM: "form", ARTICLE: "article", UL: "list", OL: "list", LI: "listitem", IMG: "img", DIALOG: "dialog",
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
    if (el.tagName === "INPUT") return INPUT[(el.getAttribute("type") || "text").toLowerCase()] || "textbox";
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
      const own = el.labels && el.labels.length ? squash(el.labels[0].textContent) : "";
      return own || squash(el.getAttribute("placeholder")) || squash(el.getAttribute("title"));
    }
    /* The text as it is rendered: nothing that is not displayed, and a break where the layout has one. */
    return FROM_TEXT.has(role) ? squash(typeof el.innerText === "string" ? el.innerText : el.textContent) : "";
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
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const said = t.data.replace(/\s+/g, " ").trim();
      const el = t.parentElement;
      if (!said || !el || el.closest("script,style,noscript,template")) continue;
      const cs = factsOf(el).cs;
      /* An element with `display: contents` makes no box: its words stand in the nearest one around it that does. */
      let box = el;
      while (box.parentElement && factsOf(box).cs.display === "contents") box = box.parentElement;
      if (cs.visibility !== "visible" || !seen(box)) continue;
      const style = {
        color: cs.color, fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
        lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, fontVariationSettings: cs.fontVariationSettings, textTransform: cs.textTransform,
      };
      const turn = wordsTurn(matrixOf(el), cs);
      if (turn) style.turn = turn;
      const type = types.of(style);
      const owner = ownerOf(el);
      const runs = owner.text || (owner.text = []);
      const last = runs[runs.length - 1];
      if (last && last.type === type) last.said += ` ${said}`;
      else runs.push({ said, type });
    }

    /* A paint as it is written down: an address inside it is cut to its file's name, so a data file holds no host. */
    const image = (v) => v.replace(/url\((["']?)(.*?)\1\)/g, (_m, _q, u) => (u.startsWith("data:") ? "url(data)" : `url(${u.split(/[?#]/)[0].split("/").pop()})`));
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
    /** What an element, or one of its two generated boxes, paints; true when its box paints anything. @param {CSSStyleDeclaration} cs */
    const paintOf = (cs, into, prefix) => {
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
    /* A short digest of a string: twelve hex digits, the same in every page. */
    const digest = (s) => {
      let a = 0xdeadbeef, b = 0x41c6ce57;
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
      a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
      b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
      return ((b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
    };
    /* That something cuts or filters a shape is said; what the cut is, the picture shows. */
    const cutOf = (c) => `${c.clipPath !== "none" ? " clip" : ""}${c.maskImage && c.maskImage !== "none" ? " mask" : ""}${c.filter !== "none" ? " filter" : ""}`;
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
        drawn.push(`${shape.tagName.toLowerCase()} ${geometryOf(shape, p.cs, 0)} ${placed}${p.cut}`);
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
      paintOf(f.cs, paint, "");
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
        const drawn = paintOf(cs, paint, `${part}.`);
        const words = cs.content.length > 2 && /^["']/.test(cs.content);
        if (words) { paint[`${part}.content`] = cs.content; paint[`${part}.color`] = cs.color; paint[`${part}.font`] = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`; }
        if (!drawn && !words) continue;
        const own = ownTurn(cs, false);
        const m = own ? times(matrixOf(el), own) : matrixOf(el);
        const turn = words ? wordsTurn(m, cs) : turnOf(m);
        if (turn) paint[`${part}.turn`] = turn;
        const box = drawn ? partBox(el, f.cs, cs) : null;
        if (box) (parts || (parts = {}))[part] = box;
      }
      if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.placeholder && !el.value) paint.placeholder = getComputedStyle(el, "::placeholder").color;
      if (!Object.keys(paint).length || !seen(el)) continue;
      if (f.cs.borderRadius !== "0px") paint.borderRadius = f.cs.borderRadius;
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
      reader: 5,
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
