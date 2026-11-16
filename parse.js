// MarkdownFast — dependency-free ES module.
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with
// default options (GFM on). Written from scratch in this session.

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isPunct = (c) => c !== undefined && PUNCT.indexOf(c) >= 0;
const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '\x80' && c <= '\uFFFF' && /\p{L}/u.test(c));
const isAlnum = (c) => isAlpha(c) || isDigit(c);

// ---- numeric character references: decode only valid ones ----
// decimal 1-7 digits, hex 1-6 digits; 0 / surrogate / >0x10FFFF -> U+FFFD
const NUM_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g;
function decodeNum(s) {
  return s.replace(NUM_RE, (m, d, h) => {
    let cp = d !== undefined ? +d : parseInt(h, 16);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return String.fromCodePoint(cp);
  });
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// encode=true: escape every & < > " '
// encode=false: leave &...; alone when it looks like an entity ref
//   (&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);) — marked's no-encode rule
const ESC_NOENC = /[<>"']|&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)/g;
const ESC_ENC = /[&<>"']/g;
function esc(s, encode) {
  s = decodeNum(s);
  if (encode) return s.replace(ESC_ENC, (c) => ESC_MAP[c]);
  return s.replace(ESC_NOENC, (c) => ESC_MAP[c] || '&amp;');
}

// label normalisation for link references: collapse whitespace, fold case,
// ß/ẞ -> ss; backslash escapes are NOT resolved when matching labels.
function normalizeLabel(s) {
  return s.replace(/[\t\n\r ]+/g, ' ').trim().toLowerCase()
    .replace(/\u00DF/g, 'ss').replace(/\u1E9E/g, 'ss');
}

// Resolve backslash escapes (only before ASCII punctuation) in a string.
function resolveEscapes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += c;
  }
  return out;
}

// ---- link destination / title / label parsing (CommonMark) ----
// Parse a link destination starting at i (s[i] is '<' or a non-space char).
// Returns {dest, next} or null. Backslash escapes resolved in dest.
// allowEmpty: an empty bare destination is valid (inline links only).
function parseDest(s, i, allowEmpty) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n') return null;
      if (c === '<') return null;
      if (c === '>') return { dest: out, next: j + 1 };
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = i, out = '', depth = 0;
  while (j < n) {
    const c = s[j];
    if (isSpace(c)) break;
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    if (c < ' ') return null;
    out += c; j++;
  }
  if (j === i && !allowEmpty) return null;
  return { dest: out, next: j };
}

// Parse a link title starting at i (s[i] is '"', '\'' or '(').
// Returns {title, next} or null. Title may span lines but not blank lines.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1, out = '';
  while (j < n) {
    const c = s[j];
    if (c === '\n') {
      // blank line ends title
      if (j + 1 < n && s[j + 1] === '\n') return null;
      out += c; j++; continue;
    }
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === close) return { title: out, next: j + 1 };
    if (q === '(' && c === '(') return null;
    out += c; j++;
  }
  return null;
}

// Parse a link label starting at i (s[i] === '['). Returns {label, next}
// where next is the index just after the matching ']'. Rejects nested
// '[' (unescaped) and empty labels.
function parseLabel(s, i) {
  const n = s.length;
  let j = i + 1, depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === '\n') {
      if (j + 1 < n && s[j + 1] === '\n') return null; // blank line ends a label
      j++; continue; // a single newline is allowed inside a label
    }
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') {
      if (depth === 0) {
        const label = s.slice(i + 1, j);
        if (label.length === 0) return null;
        return { label, next: j + 1 };
      }
      depth--;
    }
    j++;
  }
  return null;
}

// ===================== block tree =====================
function newBlock(t) {
  return {
    t, open: true, children: [], parent: null,
    strings: [], literal: '', info: '', level: 0,
    listData: null, fenceChar: '', fenceLen: 0, fenceOffset: 0,
    htmlType: 0, isFenced: false, tableData: null,
    lastLineBlank: false, lastLineChecked: false, blankInBQ: false,
    startLine: 0,
  };
}
function addChild(tag, parent, offset) {
  const b = newBlock(tag);
  b.parent = parent;
  parent.children.push(b);
  return b;
}
function lastChild(b) { return b.children.length ? b.children[b.children.length - 1] : null; }

// ===================== parser state =====================
class Parser {
  constructor() {
    this.doc = newBlock('Document');
    this.tip = this.doc;
    this.line = '';
    this.offset = 0; this.column = 0;
    this.nextNonspace = 0; this.nextNonspaceColumn = 0;
    this.indent = 0; this.blank = false;
    this.partiallyConsumedTab = false;
    this.lineNumber = 0;
    this.lastLineLength = 0;
    this.refmap = new Map();
    this.allClosed = true;
  }

  findNextNonspace() {
    const line = this.line;
    let offset = this.offset, column = this.column;
    this.partiallyConsumedTab = false;
    while (offset < line.length) {
      const c = line[offset];
      if (c === ' ') { offset++; column++; }
      else if (c === '\t') {
        const w = 4 - (column % 4);
        // tab that would carry us to/past column 4 of indent counts as
        // partially consumed for list content-indent purposes
        offset++; column += w;
      } else break;
    }
    this.blank = offset >= line.length;
    this.nextNonspace = offset;
    this.nextNonspaceColumn = column;
    this.indent = column - this.column;
  }

  advanceOffset(count, columns) {
    const line = this.line;
    let cols = 0;
    const colLimit = columns === null || columns === undefined ? Infinity : columns;
    while (count > 0 && cols < colLimit && this.offset < line.length) {
      const c = line[this.offset];
      if (c === '\t') {
        const w = 4 - (this.column % 4);
        if (cols + w > colLimit) {
          // partially consume the tab: leave the rest as spaces; the
          // offset stays on the first replacement space
          const adv = colLimit - cols;
          this.line = line.slice(0, this.offset) + ' '.repeat(w - adv) + line.slice(this.offset + 1);
          this.column += adv;
          return;
        }
        cols += w;
        this.offset++;
        this.column += w;
      } else {
        cols++;
        this.offset++;
        this.column++;
      }
      count--;
    }
  }

  // advance up to n columns, but only over spaces/tabs; stops at the
  // first non-whitespace character (used for stripping code indentation)
  stripIndent(n) {
    let cols = 0;
    while (cols < n && this.offset < this.line.length) {
      const c = this.line[this.offset];
      if (c === ' ') { this.offset++; this.column++; cols++; }
      else if (c === '\t') {
        const w = 4 - (this.column % 4);
        if (cols + w > n) {
          const adv = n - cols;
          this.line = this.line.slice(0, this.offset) + ' '.repeat(w - adv) + this.line.slice(this.offset + 1);
          this.column += adv;
          return;
        }
        cols += w; this.offset++; this.column += w;
      } else break;
    }
  }

  advanceNextNonspace() {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
  }

  // add a raw line to a leaf block
  addLine(line, container) {
    const b = container;
    if (b.t === 'CodeBlock') {
      if (b.isFenced) {
        b.strings.push(line);
      } else {
        b.strings.push(line);
      }
    } else if (b.t === 'HtmlBlock') {
      b.strings.push(line);
    } else {
      b.strings.push(line);
    }
  }

  // check whether a container block can contain the current line;
  // advances offset/column past the container marker when it can.
  checkOpen(block) {
    if (!block.open) return false;
    switch (block.t) {
      case 'BlockQuote': {
        if (this.nextNonspace < this.line.length && this.line[this.nextNonspace] === '>') {
          this.advanceNextNonspace(); // jump to the '>' first
          this.advanceOffset(1, 1);
          // at most one following space (or one column of a tab) is consumed
          if (this.offset < this.line.length && (this.line[this.offset] === ' ' || this.line[this.offset] === '\t')) {
            this.advanceOffset(1, 1);
          }
          this.findNextNonspace();
        } else {
          return false;
        }
        return true;
      }
      case 'ListItem': {
        const d = block.listData;
        // an empty item followed by a blank line is closed to content
        if (!block.children.length && block.lastLineBlank && !this.blank) return false;
        // compare indent RELATIVE to the content start on this line
        // (absolute columns break when container markers shift)
        const rel = this.nextNonspaceColumn - this.column;
        if (rel >= d.paddingRel) {
          const adv = d.paddingRel;
          if (adv > 0) this.advanceOffset(adv, adv);
          this.findNextNonspace();
          return true;
        }
        if (!this.blank) return false;
        // blank line inside item: allowed, container stays open
        this.advanceNextNonspace();
        this.findNextNonspace();
        return true;
      }
      default:
        return true;
    }
  }

  // open a new leaf/container block; returns the new block
  openNewBlock(tag, container, offset) {
    const b = addChild(tag, container, offset);
    this.tip = b;
    return b;
  }

  // ---------- list marker ----------
  parseListMarker() {
    const line = this.line;
    const i = this.nextNonspace, col = this.nextNonspaceColumn;
    if (i >= line.length) return null;
    const c = line[i];
    let type, bullet = null, start = 0, delim = null, width = 0;
    if (c === '-' || c === '+' || c === '*') {
      type = 'bullet'; bullet = c; width = 1;
    } else if (isDigit(c)) {
      let j = i;
      while (j < line.length && isDigit(line[j])) j++;
      if (j - i > 9) return null;
      if (j < line.length && (line[j] === '.' || line[j] === ')')) {
        type = 'ordered'; start = +line.slice(i, j); delim = line[j]; width = j - i + 1;
      } else return null;
    } else return null;
    const after = line[i + width];
    if (after !== undefined && after !== ' ' && after !== '\t') return null;
    // count visual spaces after the marker
    let j = i + width, c2 = col + width, spaces = 0;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      if (line[j] === ' ') { j++; c2++; spaces++; }
      else { const w = 4 - (c2 % 4); j++; c2 += w; spaces += w; }
    }
    const blankAfter = j >= line.length;
    let padding;
    if (blankAfter) padding = col + width + 1;
    else if (spaces >= 1 && spaces <= 4) padding = col + width + spaces;
    else padding = col + width + 1;
    // padding relative to the content start on this line (the column
    // after the container markers): the absolute padding is wrong on
    // later lines whose markers sit at different columns
    const paddingRel = padding - this.column;
    return { type, bullet, start, delim, width, markerOffset: col, padding, paddingRel, blankAfter };
  }

  // ---------- main line incorporation ----------
  incorporateLine(rawLine) {
    this.line = rawLine;
    this.offset = 0;
    this.column = 0;
    this.consumed = false;
    this.findNextNonspace();
    // whether the raw line is blank (before container matching)
    const rawBlank = this.blank;
    let container = this.doc;
    let allMatched = true;
    // descend into open containers only
    while (true) {
      const last = lastChild(container);
      if (!last || !last.open) break;
      if (last.t === 'List') { container = last; continue; }
      if (last.t !== 'BlockQuote' && last.t !== 'ListItem') break;
      this.findNextNonspace();
      if (!this.checkOpen(last)) { allMatched = false; break; }
      container = last;
    }
    this.lastMatchedContainer = container;
    // blank if the raw line was blank, or nothing remains after the
    // container markers (a line like ">  " still has content: one space)
    const blank = rawBlank || this.offset >= this.line.length;

    if (blank) {
      // blank line: add to an open code block or a type 1-5 HTML block
      // (with its indent stripped), else end paragraphs and mark
      // looseness on the container
      const last = lastChild(container);
      if (last && last.open && last.t === 'HtmlBlock' && last.htmlType <= 5 && !last.endedOnOpen) {
        this.addLine(this.line.slice(this.offset), last);
      } else if (last && last.open && last.t === 'CodeBlock') {
        if (last.isFenced) {
          const strip = last.fenceOffset - this.column;
          if (strip > 0) this.stripIndent(strip);
          this.addLine(this.line.slice(this.offset), last);
        } else {
          this.stripIndent(4);
          this.addLine(this.line.slice(this.offset), last);
        }
      } else {
        // a blank line ends an HTML block without a trailing newline
        if (last && last.open && last.t === 'HtmlBlock') last.keepTrailingNl = false;
        // end any open paragraph under the container
        this.finalizeUnmatched(container);
        container.lastLineBlank = true;
        const p = lastChild(container);
        if (p) p.lastLineBlank = true;
        // propagate up only for a truly empty line: a line that is
        // blank merely because container markers consumed it (e.g.
        // "  >") is blank only for the innermost container, not for
        // the outer ones (their content — the blockquote — is present)
        if (rawBlank) {
          let cur = container;
          while (cur.parent && lastChild(cur.parent) === cur) {
            cur.parent.lastLineBlank = true;
            cur = cur.parent;
          }
        }
      }
      return;
    }

    // non-blank line: open new blocks as needed, then add the line
    container = this.openNewBlocks(container);
    if (this.consumed) {
      // a closing fence / HTML end is still content: reset looseness
      let cur = this.tip;
      while (cur) { cur.lastLineBlank = false; cur = cur.parent; }
      return;
    }
    // add the line to the leaf block
    const leaf = this.tip;
    if (leaf.t === 'Paragraph' || leaf.t === 'Heading') {
      // lazy continuation: strip 4 columns if the line is indented >= 4
      if (leaf.t === 'Paragraph' && this.lastMatchedContainer !== leaf.parent && this.indent >= 4) {
        this.stripIndent(4);
      }
      let content = this.line.slice(this.offset);
      // a lazy continuation line that looks like a setext underline is
      // indented by 4 so it stays literal text
      if (leaf.t === 'Paragraph' && this.lastMatchedContainer !== leaf.parent && /^[ \t]*(=+|-+)[ \t]*$/.test(content)) {
        content = '    ' + content;
      }
      this.addLine(content, leaf);
    } else if (leaf.t === 'CodeBlock') {
      if (leaf.isFenced) {
        // strip up to the opening fence's indent
        const strip = leaf.fenceOffset - this.column;
        if (strip > 0) this.stripIndent(strip);
        this.addLine(this.line.slice(this.offset), leaf);
      } else {
        // indented code: strip 4 columns
        this.stripIndent(4);
        this.addLine(this.line.slice(this.offset), leaf);
      }
    } else if (leaf.t === 'HtmlBlock') {
      this.addLine(this.line.slice(this.offset), leaf);
    } else if (leaf.t === 'Table') {
      this.addLine(this.line.slice(this.offset), leaf);
    }
    // a non-blank line resets looseness on the tip and its ancestors:
    // a blank line followed by more content is inside the block,
    // not after it
    let cur = this.tip;
    while (cur) { cur.lastLineBlank = false; cur = cur.parent; }
  }

  // strip leading link reference definitions from a paragraph's
  // strings, registering them in the refmap; returns true if any were
  // stripped
  stripRefDefs(block) {
    const text = block.strings.join('\n');
    let pos = 0;
    while (true) {
      const r = tryRefDef(text, pos);
      if (!r) break;
      if (!this.refmap.has(r.label)) this.refmap.set(r.label, { dest: r.dest, title: r.title });
      pos = r.next;
    }
    if (pos > 0) {
      const rest = text.slice(pos).replace(/^\n/, '');
      if (rest.trim() === '') {
        block.strings = [];
        block.removed = true;
      } else {
        block.strings = rest.split('\n');
      }
      return true;
    }
    return false;
  }

  // finalize (close) every open block from the tip up to (not including)
  // `container`
  finalizeUnmatched(container) {
    while (this.tip !== container && this.tip !== this.doc) {
      const b = this.tip;
      this.tip = b.parent;
      this.finalize(b);
    }
  }

  // if the container is an open List, close it and return its parent
  closeList(container) {
    if (container.t === 'List' && container.open) {
      this.finalize(container);
      this.tip = container.parent;
      return container.parent;
    }
    return container;
  }

  openNewBlocks(container) {
    while (true) {
      this.findNextNonspace();
      // if the container's last open child is a fenced code block, the
      // line either closes it or is literal content
      let last = lastChild(container);
      if (last && last.open && last.t === 'CodeBlock' && last.isFenced) {
        const m = this.line.slice(this.nextNonspace).match(/^(`{3,}|~{3,})[ \t]*$/);
        if (m && this.indent < 4 && m[1][0] === last.fenceChar && m[1].length >= last.fenceLen) {
          last.open = false;
          this.finalize(last);
          this.tip = container;
          // the closing fence line is consumed; nothing more to do
          return container;
        }
        return container; // literal line, added by caller
      }
      // indented code continuation
      if (last && last.open && last.t === 'CodeBlock' && !last.isFenced) {
        if (this.indent >= 4) return container; // added by caller (strips 4)
        this.finalize(last);
        this.tip = container;
        // fall through: the code block is closed, try other blocks
      }
      // HTML block continuation (types 1-5 end on a matching line;
      // types 6-7 end at a blank line, handled in incorporateLine)
      if (last && last.open && last.t === 'HtmlBlock') {
        if (last.endedOnOpen) {
          // the block already ended on its opening line
          this.finalize(last);
          this.tip = container;
          // fall through: the HTML block is closed, try other blocks
        } else if (htmlBlockEnd(this.line, last.htmlType)) {
          // the closing line belongs to the block; add it, then close
          this.addLine(this.line.slice(this.offset), last);
          this.finalize(last);
          this.tip = container;
          this.consumed = true;
          return container;
        } else {
          return container; // literal line, added by caller
        }
      }
      if (this.blank) return container;
      const line = this.line, off = this.nextNonspace, col = this.nextNonspaceColumn;
      const rest = line.slice(off);
      // ---- ATX heading ----
      let m = rest.match(/^(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/);
      if (m && this.indent < 4) {
        container = this.closeList(container);
        this.finalizeUnmatched(container);
        const h = this.openNewBlock('Heading', container);
        h.level = m[1].length;
        let text = m[2] || '';
        text = text.replace(/[ \t]+$/, '');
        text = text.replace(/[ \t]+#+$/, '');
        if (/^#+$/.test(text)) text = '';
        if (text) h.strings.push(text);
        this.tip = h;
        this.finalize(h);
        this.tip = container;
        return container;
      }
      // ---- fenced code ----
      m = rest.match(/^(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/);
      if (m && this.indent < 4 && !(m[1][0] === '`' && m[2].includes('`'))) {
        container = this.closeList(container);
        this.finalizeUnmatched(container);
        const b = this.openNewBlock('CodeBlock', container);
        b.isFenced = true; b.fenceChar = m[1][0]; b.fenceLen = m[1].length;
        b.fenceOffset = col;
        b.info = resolveEscapes(m[2] || '');
        this.tip = b;
        this.consumed = true;
        return container;
      }
      // ---- HTML block ----
      const ht = htmlBlockType(line, off);
      if (ht && this.indent < 4 && !(ht === 7 && this.tip.t === 'Paragraph' && this.tip.open && this.tip.parent === container)) {
        container = this.closeList(container);
        this.finalizeUnmatched(container);
        const b = this.openNewBlock('HtmlBlock', container);
        b.htmlType = ht;
        this.tip = b;
        // a type 1-5 block whose opening line already contains its end
        // is complete; the next line must not be added to it
        if (ht <= 5) b.endedOnOpen = htmlBlockEnd(line, ht);
        return container;
      }
      // ---- setext heading (paragraph must be open) ----
      if (this.tip.t === 'Paragraph' && this.tip.open && this.tip.parent === container) {
        m = rest.match(/^(=+|-+)[ \t]*$/);
        if (m && this.indent < 4) {
          const p = this.tip;
          // strip leading link reference definitions first; if nothing
          // is left, this is not a setext heading at all
          this.stripRefDefs(p);
          if (p.removed || p.strings.length === 0 || p.strings.join('').trim() === '') {
            p.removed = false;
            // fall through: the line joins the paragraph as content
          } else {
            // setext heading content: strip leading/trailing whitespace
            p.strings[0] = p.strings[0].replace(/^[ \t]+/, '');
            const li = p.strings.length - 1;
            p.strings[li] = p.strings[li].replace(/[ \t]+$/, '');
            p.t = 'Heading'; p.level = m[1][0] === '=' ? 1 : 2;
            this.finalize(p);
            this.tip = container;
            return container;
          }
        }
      }
      // ---- thematic break ----
      if (this.indent < 4 && /^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) {
        container = this.closeList(container);
        this.finalizeUnmatched(container);
        const b = this.openNewBlock('ThematicBreak', container);
        this.finalize(b);
        this.tip = container;
        return container;
      }
      // ---- blockquote ----
      if (rest[0] === '>' && this.indent < 4) {
        this.finalizeUnmatched(container);
        const b = this.openNewBlock('BlockQuote', container);
        this.offset = off; this.column = col;
        this.advanceOffset(1, 1);
        // at most one following space (or one column of a tab)
        if (this.offset < this.line.length && (this.line[this.offset] === ' ' || this.line[this.offset] === '\t')) {
          this.advanceOffset(1, 1);
        }
        this.findNextNonspace();
        container = b;
        continue;
      }
      // ---- list item ----
      const lm = this.parseListMarker();
      // a list can interrupt a paragraph only if the item is not empty,
      // and (for ordered lists) it starts with 1
      const interruptsPara = this.tip.t === 'Paragraph' && this.tip.open && this.tip.parent === container;
      const cantInterrupt = interruptsPara && (lm && (lm.blankAfter || (lm.type === 'ordered' && lm.start !== 1)));
      if (lm && this.indent < 4 && !cantInterrupt) {
        this.finalizeUnmatched(container);
        const matches = (l) => l && l.open && l.t === 'List' &&
          l.listData.type === lm.type &&
          (lm.type === 'bullet' ? l.listData.bullet === lm.bullet : l.listData.delim === lm.delim);
        let list = null;
        if (container.t === 'List') {
          if (matches(container)) {
            list = container;
          } else {
            // a different list type: close this list, start a new one in its parent
            this.finalize(container);
            container = container.parent;
            this.tip = container;
          }
        }
        if (!list) {
          const prev = lastChild(container);
          if (matches(prev)) list = prev;
          else {
            list = this.openNewBlock('List', container);
            list.listData = { type: lm.type, bullet: lm.bullet, delim: lm.delim, start: lm.start, tight: true };
          }
          container = list;
        }
        const item = this.openNewBlock('ListItem', container);
        item.listData = { padding: lm.padding, paddingRel: lm.paddingRel, markerOffset: lm.markerOffset, blankAfter: lm.blankAfter };
        // advance past the marker, then to the content indent position
        this.offset = off; this.column = col;
        this.advanceOffset(lm.width, lm.width);
        const adv = lm.padding - col - lm.width;
        if (adv > 0) this.advanceOffset(adv, adv);
        container = item;
        continue;
      }
      // ---- indented code ----
      // (an open paragraph blocks indented code, even lazily)
      if (this.indent >= 4 && !(this.tip.t === 'Paragraph' && this.tip.open)) {
        container = this.closeList(container);
        this.finalizeUnmatched(container);
        const b = this.openNewBlock('CodeBlock', container);
        b.isFenced = false;
        this.tip = b;
        return container;
      }
      // ---- paragraph ----
      if (this.tip.t === 'Paragraph' && this.tip.open) {
        // lazy continuation (or same-container continuation): keep the tip
        return container;
      }
      // a non-list-item line closes an open list
      container = this.closeList(container);
      const p = this.openNewBlock('Paragraph', container);
      this.tip = p;
      return container;
    }
  }
}

// ===================== HTML block types =====================
const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));
function htmlBlockType(line, off) {
  if (line[off] !== '<') return 0;
  const s = line.slice(off);
  let m = s.match(/^<(script|pre|style|textarea)(?:[ \t>]|\/>|$)/i);
  if (m) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  m = s.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|\/>|$)/);
  if (m) {
    if (BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
    // type 7 needs a complete tag, alone on the line (only whitespace
    // may follow it)
    const tm = matchTag(s);
    if (tm && /^[ \t]*$/.test(s.slice(tm.length))) return 7;
    return 0;
  }
  return 0;
}
function htmlBlockEnd(line, type) {
  switch (type) {
    case 1: return /<\/(script|pre|style|textarea)>/i.test(line);
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
    default: return false; // types 6-7 end at a blank line
  }
}

// ===================== link reference definitions =====================
function skipWsNoBlank(s, i) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t') { j++; continue; }
    if (c === '\n') {
      if (j + 1 < n && s[j + 1] === '\n') return null;
      j++; continue;
    }
    break;
  }
  return j;
}

function tryRefDef(s, pos) {
  const n = s.length;
  let i = pos;
  // skip a single newline to reach the next line (consecutive refdefs)
  if (i < n && s[i] === '\n') {
    if (i + 1 < n && s[i + 1] === '\n') return null; // blank line ends refdefs
    i++;
  }
  let ind = 0;
  while (i < n && s[i] === ' ' && ind < 4) { i++; ind++; }
  if (ind === 4 || s[i] !== '[') return null;
  const lab = parseLabel(s, i);
  if (!lab) return null;
  i = lab.next;
  while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  if (s[i] !== ':') return null;
  i++;
  i = skipWsNoBlank(s, i);
  if (i === null) return null;
  const dest = parseDest(s, i);
  if (!dest) return null;
  i = dest.next;
  let title = null;
  // try a title (must be preceded by whitespace); if the title is
  // invalid (trailing content follows it), fall back to dest-only
  const j = skipWsNoBlank(s, i);
  if (j !== null && j > i && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const t = parseTitle(s, j);
    if (t) {
      let k = t.next;
      while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= n || s[k] === '\n') {
        title = t.title;
        i = t.next;
      }
    }
  }
  while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i < n && s[i] !== '\n') return null;
  const label = normalizeLabel(lab.label);
  if (!label) return null;
  return { label, dest: dest.dest, title, next: i };
}

// ===================== finalize =====================
Parser.prototype.finalize = function (block) {
  block.open = false;
  switch (block.t) {
    case 'Paragraph': {
      // strip link reference definitions from the start
      this.stripRefDefs(block);
      // table conversion: header + delimiter as 2nd line
      if (!block.removed && block.strings.length >= 2) {
        const tbl = tryTable(block.strings);
        if (tbl) {
          block.t = 'Table';
          block.tableData = tbl;
          block.strings = [];
        }
      }
      break;
    }
    case 'CodeBlock': {
      if (!block.isFenced) {
        while (block.strings.length && block.strings[block.strings.length - 1].trim() === '') block.strings.pop();
      } else {
        // fenced code: drop exactly one trailing blank line
        if (block.strings.length && block.strings[block.strings.length - 1] === '') block.strings.pop();
      }
      block.literal = block.strings.map((s) => s + '\n').join('');
      break;
    }
    case 'HtmlBlock': {
      // a top-level HTML block keeps its trailing newline unless it
      // ended at a blank line; a nested one never has one
      const topLevel = block.parent && block.parent.t === 'Document';
      block.literal = block.strings.join('\n') + (topLevel && block.keepTrailingNl !== false ? '\n' : '');
      break;
    }
    case 'List': {
      block.listData.tight = true;
      const items = block.children;
      for (let ii = 0; ii < items.length; ii++) {
        const item = items[ii];
        if (item.lastLineBlank && ii + 1 < items.length) { block.listData.tight = false; break; }
        const subs = item.children;
        for (let si = 0; si < subs.length; si++) {
          if (subs[si].lastLineBlank && si + 1 < subs.length) { block.listData.tight = false; break; }
        }
        if (!block.listData.tight) break;
      }
      break;
    }
    default:
      break;
  }
};

// set next-sibling links (used by finalize List and rendering)
function linkSiblings(b) {
  for (let i = 0; i < b.children.length; i++) {
    b.children[i].next = b.children[i + 1] || null;
    b.children[i].prev = b.children[i - 1] || null;
    linkSiblings(b.children[i]);
  }
}

// try to interpret paragraph lines as a GFM table; null if not a table
function lineIndent(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') col++;
    else if (s[i] === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function tryTable(lines) {
  const head = splitRow(lines[0]);
  if (!head) return null;
  // the delimiter row must not be indented 4+ columns
  if (lineIndent(lines[1]) >= 4) return null;
  const delimCells = splitRow(lines[1]);
  if (!delimCells || delimCells.length !== head.length) return null;
  const aligns = [];
  for (const c of delimCells) {
    const t = c.trim();
    if (!/^:?-{1,}:?$/.test(t)) return null;
    aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : null);
  }
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells === null) return null;
    rows.push(cells);
  }
  return { head, aligns, rows };
}

// split a table row line into cells; returns null for an empty line
function splitRow(line) {
  let s = line.trim();
  if (s === '') return null;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && (s[i + 1] === '|' || s[i + 1] === '\\')) {
      cur += s[i + 1] === '|' ? '|' : '\\';
      i += 2;
      continue;
    }
    if (c === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur.trim());
  return cells;
}

// ===================== driver =====================
export function parse(src) {
  const p = new Parser();
  src = src.replace(/\r\n?/g, '\n');
  const srcEndsNl = src.endsWith('\n');
  const lines = src.split('\n');
  // a trailing newline does not create an extra blank line
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    p.lineNumber++;
    p.incorporateLine(line);
  }
  let b = p.tip;
  while (b !== p.doc) {
    const parent = b.parent;
    // an HTML block still open at EOF keeps its trailing newline only
    // if the source ends with one
    if (b.t === 'HtmlBlock') b.keepTrailingNl = srcEndsNl;
    p.finalize(b);
    b = parent;
  }
  p.finalize(p.doc);
  // drop paragraphs that turned out to be pure reference definitions
  pruneRemoved(p.doc);
  linkSiblings(p.doc);
  const out = renderDoc(p.doc, p.refmap);
  // add a trailing newline only when the source ends with one
  // (the renderer already ends most blocks with one; do not strip)
  if (srcEndsNl && out && !out.endsWith('\n')) return out + '\n';
  return out;
}

function pruneRemoved(b) {
  b.children = b.children.filter((c) => !c.removed);
  for (const c of b.children) pruneRemoved(c);
}

// ===================== block renderer =====================
function isTightPara(b) {
  return b.parent && b.parent.t === 'ListItem' && b.parent.parent && b.parent.parent.t === 'List' && b.parent.parent.listData.tight;
}

function renderDoc(doc, refmap) {
  return renderChildren(doc, refmap);
}
function renderChildren(b, refmap) {
  let out = '';
  for (const c of b.children) out += renderBlock(c, refmap);
  return out;
}

function renderBlock(b, refmap) {
  switch (b.t) {
    case 'Document':
      return renderChildren(b, refmap);
    case 'Paragraph': {
      if (b.removed) return '';
      const s = renderInlineText(b.strings.join('\n'), refmap);
      if (isTightPara(b)) return s;
      return '<p>' + (b.checkboxPrefix || '') + s + '</p>\n';
    }
    case 'Heading': {
      const s = renderInlineText(b.strings.join('\n'), refmap);
      return '<h' + b.level + '>' + s + '</h' + b.level + '>\n';
    }
    case 'ThematicBreak':
      return '<hr>\n';
    case 'CodeBlock': {
      let info = '';
      if (b.isFenced && b.info) {
        const w = b.info.split(/[ \t]+/)[0];
        if (w) info = ' class="language-' + esc(w, false) + '"';
      }
      return '<pre><code' + info + '>' + esc(b.literal, true) + '</code></pre>\n';
    }
    case 'HtmlBlock':
      return b.literal;
    case 'BlockQuote':
      return '<blockquote>\n' + renderChildren(b, refmap) + '</blockquote>\n';
    case 'List': {
      const tag = b.listData.type === 'bullet' ? 'ul' : 'ol';
      const start = tag === 'ol' && b.listData.start !== 1 ? ' start="' + b.listData.start + '"' : '';
      return '<' + tag + start + '>\n' + renderChildren(b, refmap) + '</' + tag + '>\n';
    }
    case 'ListItem': {
      let cb = '';
      const first = b.children[0];
      if (first && first.t === 'Paragraph' && first.strings.length) {
        const m = first.strings[0].match(/^\[([ xX])\][ \t]/);
        if (m) {
          const tag = '<input' + (m[1] !== ' ' ? ' checked=""' : '') + ' disabled="" type="checkbox">';
          first.strings[0] = first.strings[0].replace(/^\[[ xX]\][ \t]+/, '');
          if (b.parent && b.parent.listData.tight) cb = tag + ' ';
          else first.checkboxPrefix = tag + ' ';
        }
      }
      return '<li>' + cb + renderChildren(b, refmap) + '</li>\n';
    }
    case 'Table': {
      const d = b.tableData;
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < d.head.length; i++) {
        const a = d.aligns[i] ? ' align="' + d.aligns[i] + '"' : '';
        out += '<th' + a + '>' + renderInlineText(d.head[i], refmap) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (d.rows.length) {
        out += '<tbody>';
        for (const row of d.rows) {
          out += '<tr>\n';
          for (let i = 0; i < d.head.length; i++) {
            const a = d.aligns[i] ? ' align="' + d.aligns[i] + '"' : '';
            out += '<td' + a + '>' + renderInlineText(row[i] || '', refmap) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
  }
  return '';
}

// ===================== inline parsing =====================
function renderInlineText(src, refmap) {
  const nodes = parseInline(src, refmap);
  processEmphasis(nodes);
  return renderInline(nodes);
}

// flanking helpers (CommonMark)
const WS_RE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isWS(c) { return c === undefined || WS_RE.test(c); }
function isPunctU(c) { return c !== undefined && PUNCT_RE.test(c); }
function delimInfo(src, pos, len) {
  const before = pos > 0 ? src[pos - 1] : undefined;
  const after = pos + len < src.length ? src[pos + len] : undefined;
  const beforeWS = isWS(before), afterWS = isWS(after);
  const beforeP = isPunctU(before), afterP = isPunctU(after);
  const leftFlank = !afterWS && (!afterP || beforeWS || beforeP);
  const rightFlank = !beforeWS && (!beforeP || afterWS || afterP);
  return { leftFlank, rightFlank };
}

function parseInline(src, refmap) {
  const nodes = [];
  const brackets = []; // {image, active, nodeIdx, srcPos}
  let text = '';
  const flush = () => { if (text) { nodes.push({ t: 'text', s: text }); text = ''; } };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    // ---- newline: softbreak / hardbreak ----
    if (c === '\n') {
      const m = text.match(/ {2,}$/);
      if (m) { text = text.slice(0, text.length - m[0].length); flush(); nodes.push({ t: 'br' }); i++; while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; }
      else { flush(); nodes.push({ t: 'soft' }); i++; }
      continue;
    }
    // ---- backslash ----
    if (c === '\\') {
      if (i + 1 < n && isPunct(src[i + 1])) {
        // the escaped char is its own text node, so a following
        // "ouml;" can never re-form an entity with it
        flush();
        nodes.push({ t: 'text', s: src[i + 1] });
        i += 2;
        continue;
      }
      if (i + 1 < n && src[i + 1] === '\n') {
        flush(); nodes.push({ t: 'br' }); i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      text += c; i++; continue;
    }
    // ---- code span ----
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const len = j - i;
      const close = findCodeClose(src, j, len);
      if (close === -1) { text += src.slice(i, j); i = j; continue; }
      let content = src.slice(j, close);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = close + len;
      continue;
    }
    // ---- emphasis delimiters ----
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const len = j - i;
      const { leftFlank, rightFlank } = delimInfo(src, i, len);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || isPunctU(i > 0 ? src[i - 1] : undefined));
        canClose = rightFlank && (!leftFlank || isPunctU(j < n ? src[j] : undefined));
      } else {
        canOpen = leftFlank; canClose = rightFlank;
      }
      flush();
      const d = { t: 'delim', char: c, len, canOpen, canClose, prev: null, next: null };
      // a run of 3+ tildes is never a strikethrough delimiter
      if (c === '~' && len >= 3) { d.canOpen = false; d.canClose = false; }
      nodes.push(d);
      i = j;
      continue;
    }
    // ---- brackets (links/images) ----
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const image = c === '!';
      flush();
      const nodeIdx = nodes.length;
      nodes.push({ t: 'bracket', image });
      brackets.push({ image, active: true, nodeIdx, srcPos: image ? i + 1 : i });
      i += image ? 2 : 1;
      continue;
    }
    if (c === ']') {
      flush();
      const link = tryLink(src, i, nodes, brackets, refmap);
      if (link) { i = link.next; continue; }
      text += c; i++; continue;
    }
    // ---- autolink / raw HTML ----
    if (c === '<') {
      const al = parseAutolink(src, i);
      if (al) { flush(); nodes.push(al.node); i = al.next; continue; }
      const tag = parseHtmlTag(src, i);
      if (tag) { flush(); nodes.push({ t: 'html', s: tag.text }); i = tag.next; continue; }
      text += c; i++; continue;
    }
    // ---- entity ----
    if (c === '&') {
      const m = src.slice(i).match(/^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/);
      if (m) {
        let cp = m[1] !== undefined ? +m[1] : parseInt(m[2], 16);
        if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
        text += String.fromCodePoint(cp);
        i += m[0].length;
        continue;
      }
      const m2 = src.slice(i).match(/^&(\w+);/);
      if (m2) { text += m2[0]; i += m2[0].length; continue; }
      text += c; i++; continue;
    }
    // ---- extended autolink (GFM) ----
    const ext = parseExtAutolink(src, i, refmap);
    if (ext) { flush(); nodes.push(ext.node); i = ext.next; continue; }
    text += c; i++;
  }
  flush();
  // leftover brackets that never formed a link render as literal text
  for (let k = 0; k < nodes.length; k++) {
    if (nodes[k].t === 'bracket') nodes[k] = { t: 'text', s: nodes[k].image ? '![' : '[' };
  }
  return nodes;
}

function findCodeClose(src, from, len) {
  const n = src.length;
  let i = from;
  while (i < n) {
    if (src[i] === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      if (j - i === len) return i;
      i = j;
    } else i++;
  }
  return -1;
}

// ---- link formation ----
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

function parseInlineLink(s, i) {
  let j = skipWsNoBlank(s, i + 1);
  if (j === null) return null;
  const dest = parseDest(s, j, true);
  if (!dest) return null;
  j = dest.next;
  let title = null;
  const k = skipWsNoBlank(s, j);
  if (k !== null && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const t = parseTitle(s, k);
    if (!t) return null;
    title = t.title;
    j = t.next;
  }
  j = skipWsNoBlank(s, j);
  if (j === null || s[j] !== ')') return null;
  return { dest: dest.dest, title, next: j + 1 };
}

function tryLink(src, closePos, nodes, brackets, refmap) {
  if (brackets.length === 0) return null;
  // the ']' closes the innermost bracket, active or not
  const bi = brackets.length - 1;
  const br = brackets[bi];
  if (!br.active) {
    // closed as literal text (it can no longer form a link); remove it
    // so the next ']' closes the bracket below it
    brackets.splice(bi, 1);
    return null;
  }
  const labelRaw = src.slice(br.srcPos + 1, closePos);
  let j = closePos + 1;
  let dest = null, title = null;
  // inline link: '(' must follow ']' immediately (no whitespace)
  if (src[j] === '(') {
    const inl = parseInlineLink(src, j);
    if (inl) { dest = inl.dest; title = inl.title; j = inl.next; }
  }
  // full reference
  if (dest === null && src[j] === '[') {
    const lab = parseLabel(src, j);
    if (lab) {
      const ref = refmap.get(normalizeLabel(lab.label));
      if (ref) { dest = ref.dest; title = ref.title; j = lab.next; }
    }
  }
  // collapsed reference
  if (dest === null && src[j] === '[' && src[j + 1] === ']') {
    const ref = refmap.get(normalizeLabel(labelRaw));
    if (ref) { dest = ref.dest; title = ref.title; j = j + 2; }
  }
  // shortcut reference (also the fallback when an inline link failed).
  // NOT a fallback after a full/collapsed reference attempt: if the
  // ']' is followed by '[', a failed reference means no link at all
  if (dest === null && src[j] !== '[') {
    const ref = refmap.get(normalizeLabel(labelRaw));
    if (ref) { dest = ref.dest; title = ref.title; }
  }
  if (dest === null) {
    // no link formed: this ']' closes the bracket, so it can never
    // be used again by a later ']' (it stays literal text)
    brackets.splice(bi, 1);
    return null;
  }
  const href = cleanUrl(dest);
  if (href === null) return null;
  // forming a link deactivates earlier LINK brackets (image brackets stay)
  if (!br.image) {
    for (let x = 0; x < bi; x++) if (!brackets[x].image) brackets[x].active = false;
  }
  brackets.splice(bi, 1);
  nodes.splice(br.nodeIdx);
  let node;
  if (br.image) {
    const altNodes = parseInline(labelRaw, refmap);
    processEmphasis(altNodes);
    node = { t: 'image', src: href, title: title || null, alt: plainText(altNodes) };
  } else {
    const children = parseInline(labelRaw, refmap);
    processEmphasis(children);
    node = { t: 'link', href, title: title || null, children };
  }
  nodes.push(node);
  return { next: j };
}

function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.s;
    else if (n.t === 'soft') out += '\n';
    else if (n.t === 'br') out += '\n';
    else if (n.t === 'image') out += n.alt;
    else if (n.children) out += plainText(n.children);
  }
  return out;
}

// ---- autolinks and raw HTML ----
function parseAutolink(s, i) {
  const m = s.slice(i).match(/^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/);
  if (m) {
    const href = cleanUrl(m[1]);
    if (href === null) return null;
    return { node: { t: 'link', href, title: null, children: [{ t: 'text', s: m[1] }] }, next: i + m[0].length };
  }
  const m2 = s.slice(i).match(/^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/);
  if (m2) {
    const email = m2[1];
    return { node: { t: 'link', href: 'mailto:' + email, title: null, children: [{ t: 'text', s: email }] }, next: i + m2[0].length };
  }
  return null;
}

// a complete HTML tag: open tag (attributes allowed, may self-close)
// or closing tag (NO attributes allowed, only whitespace then '>')
function matchTag(s) {
  let m = s.match(/^<\/[A-Za-z][A-Za-z0-9-]*[ \t\n]*>/);
  if (m) return m[0];
  m = s.match(/^<[A-Za-z][A-Za-z0-9-]*(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\n]*\/?>/);
  if (m) return m[0];
  return null;
}

function parseHtmlTag(s, i) {
  const rest = s.slice(i);
  if (rest.startsWith('<!--')) {
    if (rest.startsWith('<!-->')) return { text: '<!-->', next: i + 5 };
    if (rest.startsWith('<!--->')) return { text: '<!--->', next: i + 6 };
    const end = rest.indexOf('-->', 4);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 3), next: i + end + 3 };
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>', 2);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 2), next: i + end + 2 };
  }
  if (/^<![A-Za-z]/.test(rest)) {
    const end = rest.indexOf('>', 2);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 1), next: i + end + 1 };
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>', 9);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 3), next: i + end + 3 };
  }
  const m = matchTag(rest);
  if (m) return { text: m, next: i + m.length };
  return null;
}

// ---- extended autolinks (GFM) ----
function trimExtUrl(url) {
  let changed = true;
  while (changed && url.length) {
    changed = false;
    const opens = (url.match(/\(/g) || []).length;
    const closes = (url.match(/\)/g) || []).length;
    if (url.endsWith(')') && closes > opens) { url = url.slice(0, -1); changed = true; continue; }
    const em = url.match(/&(?:[A-Za-z][A-Za-z0-9]+|#[0-9]+|#[xX][0-9a-fA-F]+);$/);
    if (em) { url = url.slice(0, url.length - em[0].length); changed = true; continue; }
    if (/[?!,.:*_~]$/.test(url)) { url = url.slice(0, -1); changed = true; continue; }
  }
  return url;
}

function validDomain(d) {
  // strip userinfo and port
  const at = d.lastIndexOf('@');
  if (at >= 0) d = d.slice(at + 1);
  const colon = d.indexOf(':');
  if (colon >= 0) {
    if (!/^\d+$/.test(d.slice(colon + 1))) return false;
    d = d.slice(0, colon);
  }
  if (!d) return false;
  const labels = d.split('.');
  if (labels.length < 2) return false;
  for (const lab of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return false;
  }
  const tld = labels[labels.length - 1];
  if (!/^[A-Za-z]{2,}$/.test(tld)) return false;
  return true;
}

function matchExtUrl(s, i) {
  let j = i;
  while (j < s.length && !isSpace(s[j]) && s[j] !== '<') j++;
  let url = trimExtUrl(s.slice(i, j));
  if (!url) return null;
  // split off the scheme/www prefix to find the domain
  let rest = url;
  const sm = url.match(/^[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\//);
  if (sm) rest = url.slice(sm[0].length);
  else if (url.startsWith('www.')) rest = url.slice(4);
  else return null;
  const domEnd = rest.search(/[\/?#]/);
  const domain = domEnd === -1 ? rest : rest.slice(0, domEnd);
  if (!validDomain(domain)) return null;
  return { url, len: url.length };
}

function parseExtAutolink(s, i) {
  if (i > 0) {
    const prev = s[i - 1];
    if (!(prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '<')) return null;
  }
  if (s.startsWith('www.', i)) {
    const m = matchExtUrl(s, i);
    if (!m) return null;
    return { node: { t: 'link', href: 'http://' + m.url, title: null, children: [{ t: 'text', s: m.url }] }, next: i + m.len };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\//.test(s.slice(i))) {
    const m = matchExtUrl(s, i);
    if (!m) return null;
    return { node: { t: 'link', href: m.url, title: null, children: [{ t: 'text', s: m.url }] }, next: i + m.len };
  }
  // scheme:email (mailto:, xmpp:) with an optional single path segment
  const sm2 = s.slice(i).match(/^([A-Za-z][A-Za-z0-9+.-]{1,31}):/);
  if (sm2) {
    const afterScheme = i + sm2[0].length;
    const em2 = s.slice(afterScheme).match(/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/);
    if (em2) {
      let end = afterScheme + em2[0].length;
      // optional single path segment (/txt, but not /txt/bin)
      const seg = s.slice(end).match(/^\/[^\s<>\/]+/);
      if (seg) end += seg[0].length;
      let url = trimExtUrl(s.slice(i, end));
      if (!url) return null;
      // a URL ending in '-' or '_' (the next char) is not an autolink
      const after = s[i + url.length];
      if (after === '-' || after === '_') return null;
      return { node: { t: 'link', href: url, title: null, children: [{ t: 'text', s: url }] }, next: i + url.length };
    }
  }
  // email (needs a dot in the domain)
  const em = s.slice(i).match(/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/);
  if (em) {
    let email = em[0];
    // an email ending in '-' or '_' (the next char) is not an autolink
    const after = s[i + email.length];
    if (after === '-' || after === '_') return null;
    return { node: { t: 'link', href: 'mailto:' + email, title: null, children: [{ t: 'text', s: email }] }, next: i + email.length };
  }
  return null;
}

// ---- emphasis / strikethrough (delimiter-stack algorithm) ----
function processEmphasis(nodes) {
  // link delimiters into a doubly-linked list
  let head = null, tail = null;
  for (const n of nodes) {
    if (n.t !== 'delim') continue;
    n.prev = tail; n.next = null;
    if (tail) tail.next = n; else head = n;
    tail = n;
  }
  const removeDelim = (d) => {
    if (d.prev) d.prev.next = d.next; else head = d.next;
    if (d.next) d.next.prev = d.prev; else tail = d.prev;
    d.prev = d.next = null;
  };
  let cur = head;
  while (cur) {
    const next = cur.next;
    if (cur.canClose) {
      let o = cur.prev;
      let found = null;
      while (o) {
        if (o.char === cur.char && o.canOpen) {
          const odd = (o.canClose || cur.canOpen) && ((o.len + cur.len) % 3 === 0) && (o.len % 3 !== 0 || cur.len % 3 !== 0);
          if (!odd) { found = o; break; }
        }
        o = o.prev;
      }
      if (found) {
        const use = found.len >= 2 && cur.len >= 2 ? 2 : 1;
        const type = use === 2 ? (cur.char === '~' ? 'del' : 'strong') : (cur.char === '~' ? 'del' : 'em');
        const i1 = nodes.indexOf(found);
        const i2 = nodes.indexOf(cur);
        // delimiters wrapped inside the new node can no longer match
        for (let k = i1 + 1; k < i2; k++) {
          if (nodes[k].t === 'delim') removeDelim(nodes[k]);
        }
        const children = nodes.slice(i1 + 1, i2);
        const node = { t: type, children };
        found.len -= use;
        cur.len -= use;
        const repl = [];
        if (found.len > 0) repl.push(found);
        repl.push(node);
        if (cur.len > 0) repl.push(cur);
        nodes.splice(i1, i2 - i1 + 1, ...repl);
        if (found.len === 0) removeDelim(found);
        if (cur.len === 0) removeDelim(cur);
        cur = cur.len > 0 ? cur : next;
        continue;
      }
      if (!cur.canOpen) {
        // unlink it from the delimiter list; it stays in the nodes
        // array and the final sweep turns it into literal text
        removeDelim(cur);
      }
      cur = next;
      continue;
    }
    cur = next;
  }
  // leftover delimiters become literal text (recursive: delimiters
  // wrapped inside a formed emphasis node also become literal)
  const sweep = (arr) => {
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (n.t === 'delim') arr[i] = { t: 'text', s: n.char.repeat(n.len) };
      else if (n.children) sweep(n.children);
    }
  };
  sweep(nodes);
}

function renderInline(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += esc(n.s, false);
        break;
      case 'code':
        out += '<code>' + esc(n.s, true) + '</code>';
        break;
      case 'em':
        out += '<em>' + renderInline(n.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInline(n.children) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInline(n.children) + '</del>';
        break;
      case 'link': {
        const title = n.title !== null && n.title !== undefined ? ' title="' + esc(n.title, false) + '"' : '';
        out += '<a href="' + esc(n.href, false) + '"' + title + '>' + renderInline(n.children) + '</a>';
        break;
      }
      case 'image': {
        const title = n.title !== null && n.title !== undefined ? ' title="' + esc(n.title, false) + '"' : '';
        out += '<img src="' + esc(n.src, false) + '" alt="' + esc(n.alt, true) + '"' + title + '>';
        break;
      }
      case 'html':
        out += n.s;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'soft':
        out += '\n';
        break;
      default:
        break;
    }
  }
  return out;
}
