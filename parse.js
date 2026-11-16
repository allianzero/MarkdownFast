// MarkdownFast — a fast, dependency-free CommonMark 0.31.2 + GFM 0.29 parser.
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its default
// options (GFM on, breaks off, pedantic off, async off), but faster.
// Written from scratch for the make.fun "Make Markdown rendering faster" bounty.
// The CommonMark spec examples and the GFM extension examples are the correctness
// oracle; the parser is a single-pass block parser + delimiter-stack inline parser
// with no regexes in the hot paths and no per-token object allocation in the
// common case.

export function parse(markdown) {
  return renderDoc(normalize(markdown));
}

// ---------------------------------------------------------------------------
// Small helpers (char codes, no regex in hot paths)
// ---------------------------------------------------------------------------

const CC_SPACE = 32, CC_TAB = 9, CC_LF = 10, CC_CR = 13;
const CC_LT = 60, CC_GT = 62, CC_AMP = 38, CC_QUOT = 34, CC_SQ = 39;
const CC_BSLASH = 92, CC_BTICK = 96, CC_STAR = 42, CC_US = 95, CC_TILDE = 126;
const CC_LBR = 91, CC_RBR = 93, CC_LPAR = 40, CC_RPAR = 41, CC_BANG = 33;
const CC_HASH = 35, CC_DASH = 45, CC_PLUS = 43, CC_DOT = 46, CC_COLON = 58;
const CC_SEMI = 59, CC_SLASH = 47, CC_EQ = 61, CC_PIPE = 124, CC_CARET = 94;

function isSpace(c) { return c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
// ASCII punctuation (for backslash escapes and link destinations).
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode punctuation for flanking (marked's _punctuation, \p{P}\p{S}).
// GFM emphasis treats '~' as NOT punctuation (_punctuationGfmStrongEm).
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctFlankChar(ch) {
  if (ch.length === 1) {
    const c = ch.charCodeAt(0);
    if (c < 128) return c !== 126 && isPunct(c);
    return UNICODE_PUNCT_RE.test(ch);
  }
  return UNICODE_PUNCT_RE.test(ch);
}
function isWhitespaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0' || ch === '\u1680' ||
    (ch >= '\u2000' && ch <= '\u200a') || ch === '\u2028' || ch === '\u2029' || ch === '\u202f' ||
    ch === '\u205f' || ch === '\u3000' || ch === '\ufeff';
}

// Normalize line endings: \r\n and \r become \n (marked does this first).
function normalize(src) {
  if (src.indexOf('\r') === -1) return src;
  return src.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// HTML escaping (marked escapes & < > " ' in text and in attribute values)
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape &, <, >, ", ' unconditionally (marked's escape with encode=true),
// used for code spans and code blocks, where an & is always &amp; even when
// it looks like an entity reference (`f&ouml;` -> `f&amp;ouml;` in code).
function escapeHtmlEncode(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const r = ESCAPE_MAP[s[i]];
    if (r !== undefined) {
      if (i > start) out += s.slice(start, i);
      out += r;
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

function escapeHtml(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      // marked's escape (encode=false) leaves an & alone when it starts a
      // valid entity reference: &#digits; (1-7), &#x hex; (1-6), or &word;
      if (isEntityRef(s, i)) continue;
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
      continue;
    }
    const r = ESCAPE_MAP[ch];
    if (r !== undefined) {
      if (i > start) out += s.slice(start, i);
      out += r;
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Is s[i] ('&') the start of a valid entity reference (per marked's escape)?
function isEntityRef(s, i) {
  const len = s.length;
  let j = i + 1;
  if (j < len && s.charCodeAt(j) === CC_HASH) {
    j++;
    if (j < len && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const start = j;
      while (j < len) {
        const h = s.charCodeAt(j);
        if ((h >= 48 && h <= 57) || (h >= 97 && h <= 102) || (h >= 65 && h <= 70)) j++;
        else break;
      }
      if (j === start || j - start > 6) return false;
      return j < len && s.charCodeAt(j) === CC_SEMI;
    }
    const start = j;
    while (j < len && isDigit(s.charCodeAt(j))) j++;
    if (j === start || j - start > 7) return false;
    return j < len && s.charCodeAt(j) === CC_SEMI;
  }
  const start = j;
  while (j < len) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 95) j++;
    else break;
  }
  if (j === start) return false;
  return j < len && s.charCodeAt(j) === CC_SEMI;
}

// ---------------------------------------------------------------------------
// Entities: marked decodes ONLY numeric character references.
// A named reference (&copy; &nbsp; &hellip; ...) passes through unchanged.
// A bare & not starting a valid reference is escaped to &amp;.
// Numeric: &#123; &#x1F600; &#X41; -> the character; 0, surrogates and
// values > 0x10FFFF become U+FFFD.
// ---------------------------------------------------------------------------

function decodeNumericEntity(body) {
  // body is like "#123" or "#x1F600" (without & and ;)
  let cp;
  if (body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88) {
    cp = parseInt(body.slice(2), 16);
  } else {
    cp = parseInt(body.slice(1), 10);
  }
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// If s[pos] is '&', try to read an entity reference starting there.
// Returns {text, next} where text is what to emit and next the index after it,
// or null when no valid reference starts at pos (caller then escapes the &).
function readEntity(s, pos) {
  const len = s.length;
  if (pos + 1 >= len) return null;
  let i = pos + 1;
  const c = s.charCodeAt(i);
  if (c === CC_HASH) {
    i++;
    if (i < len && (s.charCodeAt(i) === 120 || s.charCodeAt(i) === 88)) {
      i++;
      const start = i;
      while (i < len) {
        const h = s.charCodeAt(i);
        if ((h >= 48 && h <= 57) || (h >= 97 && h <= 102) || (h >= 65 && h <= 70)) i++;
        else break;
      }
      if (i === start || i - start > 6 || i >= len || s.charCodeAt(i) !== CC_SEMI) return null;
      return { text: decodeNumericEntity(s.slice(pos + 1, i)), next: i + 1 };
    }
    const start = i;
    while (i < len && isDigit(s.charCodeAt(i))) i++;
    if (i === start || i - start > 7 || i >= len || s.charCodeAt(i) !== CC_SEMI) return null;
    return { text: decodeNumericEntity(s.slice(pos + 1, i)), next: i + 1 };
  }
  if (!isAlpha(c)) return null;
  i++;
  while (i < len && (isAlnum(s.charCodeAt(i)) || s.charCodeAt(i) === 95)) i++;
  if (i >= len || s.charCodeAt(i) !== CC_SEMI) return null;
  return { text: s.slice(pos, i + 1), next: i + 1 };
}

// ---------------------------------------------------------------------------
// Link reference definitions (marked's `def` rule, ported as a regex over the
// joined paragraph lines so labels, destinations and titles may span lines).
// [label]: destination "title"  (destination may be <...> or bare, and may sit
// on the next line; title may be "..." '...' or (...) on the same or next line,
// and needs whitespace separation from the destination; a definition cannot
// interrupt a paragraph, so only leading definitions of a paragraph count).
// Collected in a first scan: Map label-normalized -> {dest, title}.
// Label normalization: collapse internal whitespace to single spaces, then
// Unicode case folding (toLowerCase().toUpperCase().toLowerCase()).
// ---------------------------------------------------------------------------

function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// Decode backslash escapes in a link destination or code info word:
// `\` + ASCII punctuation yields the punctuation; other `\` stay literal.
function unescapeDest(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === CC_BSLASH && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

const DEF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
const DEF_RE = new RegExp(
  '^ {0,3}\\[(' + DEF_LABEL + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)' +
  '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + DEF_TITLE + '))? *(?:\\n+|$)'
);

// Match one link reference definition at the start of `text` (the remaining
// paragraph lines joined with '\n'). Returns {label, dest, title, linesUsed}
// or null. linesUsed counts the lines the definition spans.
function matchLinkDef(text) {
  const m = DEF_RE.exec(text);
  if (!m) return null;
  const label = m[1];
  if (label.length === 0 || label.length > 999) return null;
  let dest = m[2];
  if (dest.charCodeAt(0) === CC_LT) {
    dest = dest.slice(1, -1);
    if (dest.indexOf('\n') !== -1 || dest.indexOf('<') !== -1) return null;
  }
  dest = unescapeDest(dest);
  let title = null;
  if (m[3] !== undefined) {
    const raw = m[3];
    const inner = raw.slice(1, -1);
    title = unescapeDest(inner);
  }
  // lines spanned: count newlines in the matched text, ignoring the trailing
  // separator newlines (they belong to the next line, not the definition)
  const stripped = m[0].replace(/\n+$/, '');
  const linesUsed = (stripped.match(/\n/g) || []).length + 1;
  return { label, dest, title, linesUsed };
}

// ---------------------------------------------------------------------------
// Block parser
// Lines are handled with tab-aware indentation. A tab advances to the next
// multiple of 4 columns. Content is emitted directly as HTML (no token tree).
// ---------------------------------------------------------------------------

// Expanded indent width of the leading whitespace of a line.
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE) col++;
    else if (c === CC_TAB) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Index in `line` where the expanded column first reaches `col`.
// (Used to find where content starts after stripping indentation.)
function indexAtCol(line, col) {
  let c = 0;
  for (let i = 0; i < line.length; i++) {
    if (c >= col) return i;
    const ch = line.charCodeAt(i);
    if (ch === CC_SPACE) c++;
    else if (ch === CC_TAB) c += 4 - (c % 4);
    else return i;
  }
  return line.length;
}

// Remove `n` columns of indentation from the start of a line (tab-aware:
// a tab straddling the cut becomes the remaining spaces).
function stripIndent(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else {
        // tab straddles the cut: keep the leftover as spaces
        return ' '.repeat(col + w - n) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return false;
  }
  return true;
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'title', 'tr', 'track', 'ul',
]);

// Read an HTML tag starting at s[i] (must be '<'). Returns {name, closing, end}
// or null. Strict, mirroring marked's inline tag grammar: the tag name is
// [a-zA-Z][a-zA-Z0-9-]*; after it only space/tab/newline, '/' (immediately
// followed by '>') or '>' is allowed; attribute names are
// [a-zA-Z:_][a-zA-Z0-9_.:-]*, with an optional =value (quoted or unquoted);
// a closing tag allows only whitespace then '>'. Comments match
// <!--(?:-?>|[\s\S]*?(?:-->|$)) so <!--> and <!---> are single comments.
function readHtmlTag(s, i) {
  const len = s.length;
  if (i + 1 >= len) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === CC_BANG) {
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> end at their own '>'
      if (s.charCodeAt(i + 4) === CC_GT) return { name: '', closing: false, end: i + 5, kind: 'comment' };
      if (s.charCodeAt(i + 4) === CC_DASH && s.charCodeAt(i + 5) === CC_GT) return { name: '', closing: false, end: i + 6, kind: 'comment' };
      const end = s.indexOf('-->', i + 4);
      return end === -1 ? null : { name: '', closing: false, end: end + 3, kind: 'comment' };
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      return end === -1 ? null : { name: '', closing: false, end: end + 3, kind: 'cdata' };
    }
    // declaration <!A ... > : letter right after !
    if (i + 2 < len && isAlpha(s.charCodeAt(i + 2))) {
      const end = s.indexOf('>', i + 2);
      return end === -1 ? null : { name: '', closing: false, end: end + 1, kind: 'decl' };
    }
    return null;
  }
  if (c1 === 63) { // <? ... ?>
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? null : { name: '', closing: false, end: end + 2, kind: 'pi' };
  }
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === CC_SLASH) { closing = true; j++; }
  if (j >= len || !isAlpha(s.charCodeAt(j))) return null;
  const nameStart = j;
  while (j < len && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === CC_DASH)) j++;
  const name = s.slice(nameStart, j).toLowerCase();
  if (closing) {
    // closing tag: only whitespace, then '>'
    while (j < len && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB || s.charCodeAt(j) === CC_LF)) j++;
    if (j < len && s.charCodeAt(j) === CC_GT) return { name, closing, end: j + 1, kind: 'tag' };
    return null;
  }
  // open tag: attributes, then '>' or '/>'. An attribute must be preceded
  // by whitespace (cm-609 <m:abc>, cm-622 <a href='bar'title=title>), and a
  // quoted value may span lines (cm-642/643 <a href="foo\nbar">). The
  // whitespace skipped while looking for '=' after a valueless attribute is
  // the separator before the next attribute (cm-616 <a b='x'\n_c=d />), so
  // it is carried over as pendingWs.
  let pendingWs = false;
  while (true) {
    const w0 = j;
    while (j < len && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB || s.charCodeAt(j) === CC_LF)) j++;
    const hadWs = pendingWs || j > w0;
    pendingWs = false;
    if (j >= len) return null;
    const c = s.charCodeAt(j);
    if (c === CC_GT) return { name, closing, end: j + 1, kind: 'tag' };
    if (c === CC_SLASH) {
      if (j + 1 < len && s.charCodeAt(j + 1) === CC_GT) return { name, closing, end: j + 2, kind: 'tag' };
      return null;
    }
    if (!hadWs) return null;
    // attribute name: [a-zA-Z:_][a-zA-Z0-9_.:-]*
    if (!(isAlpha(c) || c === CC_COLON || c === CC_US)) return null;
    j++;
    while (j < len) {
      const a = s.charCodeAt(j);
      if (isAlnum(a) || a === CC_US || a === CC_DOT || a === CC_COLON || a === CC_DASH) j++;
      else break;
    }
    const w1 = j;
    while (j < len && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB || s.charCodeAt(j) === CC_LF)) j++;
    if (j < len && s.charCodeAt(j) === CC_EQ) {
      j++;
      while (j < len && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB || s.charCodeAt(j) === CC_LF)) j++;
      if (j >= len) return null;
      const v = s.charCodeAt(j);
      if (v === CC_QUOT || v === CC_SQ) {
        const q = v;
        j++;
        while (j < len && s.charCodeAt(j) !== q) j++;
        if (j >= len || s.charCodeAt(j) !== q) return null;
        j++;
      } else {
        // unquoted value: no space, ", ', =, <, >, ` allowed
        const start = j;
        while (j < len) {
          const u = s.charCodeAt(j);
          if (u === CC_SPACE || u === CC_TAB || u === CC_LF || u === CC_QUOT || u === CC_SQ ||
              u === CC_EQ || u === CC_LT || u === CC_GT || u === CC_BTICK) break;
          j++;
        }
        if (j === start) return null;
      }
    } else {
      // no value: the whitespace after the name separates this attribute
      // from the next one
      pendingWs = j > w1;
    }
  }
}

// Classify an HTML block start at the beginning of `content` (already stripped
// of up to 3 spaces indent). Returns the end condition:
//   {type: 1..7, endTag} for types 1-5 (end when a line contains endTag),
//   {type: 6|7} for types 6-7 (end at a blank line), or null.
// Type 6 needs a block tag followed by space/tab/EOL/'>'/'/>' (htmlBeginRegex);
// type 7 needs any complete tag alone on the line.
function htmlBlockStart(content) {
  if (content.charCodeAt(0) !== CC_LT) return null;
  const lower = content.toLowerCase();
  if (lower.startsWith('<script') && (lower.length === 7 || isSpace(lower.charCodeAt(7)) || lower.charCodeAt(7) === CC_GT)) return { type: 1, endTag: '</script' };
  if (lower.startsWith('<pre') && (lower.length === 4 || isSpace(lower.charCodeAt(4)) || lower.charCodeAt(4) === CC_GT)) return { type: 1, endTag: '</pre' };
  if (lower.startsWith('<style') && (lower.length === 6 || isSpace(lower.charCodeAt(6)) || lower.charCodeAt(6) === CC_GT)) return { type: 1, endTag: '</style' };
  if (lower.startsWith('<textarea') && (lower.length === 9 || isSpace(lower.charCodeAt(9)) || lower.charCodeAt(9) === CC_GT)) return { type: 1, endTag: '</textarea' };
  if (content.startsWith('<!--')) return { type: 2, endTag: '-->' };
  if (content.startsWith('<?')) return { type: 3, endTag: '?>' };
  if (content.startsWith('<!') && content.length > 2 && isAlpha(content.charCodeAt(2))) return { type: 4, endTag: '>' };
  if (content.startsWith('<![CDATA[')) return { type: 5, endTag: ']]>' };
  // type 6: a block-level tag (open or close) followed by space/tab/EOL/'>'
  // or '/>' — the tag need not be complete or alone on the line (cm-148
  // <table><tr><td>, cm-153/154 <div id="foo" spanning lines, cm-159
  // <div><a href="bar">*foo*</a></div>, cm-160 <table><tr><td>foo)
  {
    let q = 0;
    if (content.charCodeAt(0) === CC_LT) {
      q = 1;
      if (content.charCodeAt(q) === CC_SLASH) q++;
      if (q < content.length && isAlpha(content.charCodeAt(q))) {
        const ns = q;
        while (q < content.length && (isAlnum(content.charCodeAt(q)) || content.charCodeAt(q) === CC_DASH)) q++;
        const nm = content.slice(ns, q).toLowerCase();
        if (BLOCK_TAGS.has(nm)) {
          if (q >= content.length) return { type: 6 };
          const nc = content.charCodeAt(q);
          if (nc === CC_SPACE || nc === CC_TAB || nc === CC_GT) return { type: 6 };
          if (nc === CC_SLASH && content.charCodeAt(q + 1) === CC_GT) return { type: 6 };
        }
      }
    }
  }
  // type 7: any complete tag alone on the line
  const tag = readHtmlTag(content, 0);
  if (tag && tag.kind === 'tag') {
    let k = tag.end;
    while (k < content.length && (content.charCodeAt(k) === CC_SPACE || content.charCodeAt(k) === CC_TAB)) k++;
    if (k === content.length) return { type: 7 };
  }
  return null;
}

// ATX heading: returns {level, text} or null. The closing sequence is a run
// of #'s preceded by a space (the space after the opening hashes counts),
// so `### ###` has empty content.
function atxHeading(content) {
  let i = 0;
  while (i < content.length && content.charCodeAt(i) === CC_HASH) i++;
  if (i === 0 || i > 6) return null;
  if (i < content.length) {
    const c = content.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return null;
  }
  let rest = content.slice(i);
  rest = rest.replace(/[ \t]+#+[ \t]*$/, '');
  const text = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: i, text };
}

// Fenced code start: returns {fence, len, info} or null.
function fenceStart(content) {
  const c = content.charCodeAt(0);
  if (c !== CC_BTICK && c !== CC_TILDE) return null;
  let i = 0;
  while (i < content.length && content.charCodeAt(i) === c) i++;
  if (i < 3) return null;
  const info = content.slice(i).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (c === CC_BTICK && info.indexOf('`') !== -1) return null;
  return { fence: c === CC_BTICK ? '`' : '~', len: i, info };
}

// Thematic break: 3+ of -, _, * with only spaces between.
function thematicBreak(content) {
  const c = content.charCodeAt(0);
  if (c !== CC_DASH && c !== CC_US && c !== CC_STAR) return null;
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    if (ch === c) n++;
    else if (ch !== CC_SPACE && ch !== CC_TAB) return null;
  }
  return n >= 3 ? c : null;
}

// Setext underline: returns 1 for ===, 2 for ---, else 0. The run must be
// contiguous (no spaces inside) with only trailing spaces/tabs after it.
function setextLevel(content) {
  const c = content.charCodeAt(0);
  if (c !== CC_EQ && c !== CC_DASH) return 0;
  let i = 0;
  while (i < content.length && content.charCodeAt(i) === c) i++;
  if (i === 0) return 0;
  while (i < content.length) {
    const ch = content.charCodeAt(i);
    if (ch !== CC_SPACE && ch !== CC_TAB) return 0;
    i++;
  }
  return c === CC_EQ ? 1 : 2;
}

// Table delimiter row: returns array of alignments ('left'|'center'|'right'|null)
// or null. A cell is 0+ spaces, 0-1 colon, 1+ dashes, 0-1 colon, 0+ spaces.
// The row must contain a ':' or '|' or it is a setext underline, not a table.
function tableDelimiter(content) {
  if (content.indexOf(':') === -1 && content.indexOf('|') === -1) return null;
  let s = content;
  if (s.charCodeAt(0) === CC_PIPE) s = s.slice(1);
  if (s.length && s.charCodeAt(s.length - 1) === CC_PIPE) s = s.slice(0, -1);
  const cells = s.split('|');
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (t.length < 1) return null;
    let left = false, right = false, k = 0;
    if (t.charCodeAt(0) === CC_COLON) { left = true; k++; }
    let dashes = 0;
    while (k < t.length && t.charCodeAt(k) === CC_DASH) { dashes++; k++; }
    if (dashes === 0) return null;
    if (k < t.length && t.charCodeAt(k) === CC_COLON) { right = true; k++; }
    if (k !== t.length) return null;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Split a table row into cells, marked's splitCells: an unescaped '|' becomes
// ' |' (an escaped one stays '|'), the row is split on ' |', an empty first
// or last cell is dropped, the cells are padded/truncated to `count`, and
// each cell is trimmed with '\|' turned into '|'. An escaped pipe is one
// preceded by an odd number of backslashes.
function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str.charCodeAt(curr) === CC_BSLASH) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(' |');
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Parse a list marker at the start of `content` (indent already stripped).
// Returns {bullet, ch, ordered, start, delim, markerLen, spaces, empty} or null.
function listMarker(content) {
  const c0 = content.charCodeAt(0);
  if (c0 === CC_DASH || c0 === CC_PLUS || c0 === CC_STAR) {
    if (content.length === 1) return { bullet: true, ch: c0, markerLen: 1, spaces: 0, empty: true };
    const c1 = content.charCodeAt(1);
    if (c1 !== CC_SPACE && c1 !== CC_TAB) return null;
    let j = 1, w = 0;
    while (j < content.length) {
      const c = content.charCodeAt(j);
      if (c === CC_SPACE) { w++; j++; }
      else if (c === CC_TAB) { w += 4 - (w % 4); j++; }
      else break;
    }
    if (w === 0) return null;
    return { bullet: true, ch: c0, markerLen: 1, spaces: w, empty: j >= content.length };
  }
  if (isDigit(c0)) {
    let j = 0;
    while (j < content.length && isDigit(content.charCodeAt(j))) j++;
    if (j === 0 || j > 9) return null;
    const d = content.charCodeAt(j);
    if (d !== CC_DOT && d !== CC_RPAR) return null;
    const start = parseInt(content.slice(0, j), 10);
    if (content.length === j + 1) return { ordered: true, start, delim: d === CC_DOT ? '.' : ')', markerLen: j + 1, spaces: 0, empty: true };
    const c1 = content.charCodeAt(j + 1);
    if (c1 !== CC_SPACE && c1 !== CC_TAB) return null;
    let k = j + 1, w = 0;
    while (k < content.length) {
      const c = content.charCodeAt(k);
      if (c === CC_SPACE) { w++; k++; }
      else if (c === CC_TAB) { w += 4 - (w % 4); k++; }
      else break;
    }
    if (w === 0) return null;
    return { ordered: true, start, delim: d === CC_DOT ? '.' : ')', markerLen: j + 1, spaces: w, empty: k >= content.length };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block parsing -> block nodes, then rendering.
// Node shapes (arrays): ['p', text] ['h', level, text] ['code', text, info]
//   ['html', text] ['hr'] ['quote', children] ['list', ordered, start, delim,
//   tight, items] (items: array of children arrays)
//   ['table', aligns, headerCells, rows] (cells: raw strings)
// `top` is true for the outermost parseBlocks call and inside a blockquote
// (marked's blockquote tokenizer sets state.top = true, so an indented
// paragraph continuation keeps its spaces there); inside a list item an
// indented paragraph continuation loses 4 columns (marked merges an
// indented code block into the preceding paragraph).
// `endsWithNL` tells whether the source this level parses ends with '\n'.
// `state` (optional {blankSep}) reports whether a blank line separated two
// blocks at this level (list looseness).
// ---------------------------------------------------------------------------

function renderDoc(src) {
  const endsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  // marked's lexer state.inLink persists across blocks: an inline <a ...>
  // tag (startATag /^<a /i) sets it, and only a </a> (endATag) clears it.
  // While it is set, the GFM url/email autolink is disabled for the rest
  // of the document. Reset per document.
  docInLink = false;
  const blocks = parseBlocks(lines, 0, lines.length, refs, true, endsWithNL, null, false);
  return renderBlocks(blocks, refs);
}

// Does `content` (a line with up to 3 spaces of indent stripped) start a block
// that can interrupt a paragraph? Returns 'fence' | 'atx' | 'html' | 'quote' |
// 'list' | 'hr' | null. `inPara` matters for lists.
function interruptKind(content, inPara) {
  if (content.length === 0) return null;
  const c = content.charCodeAt(0);
  if (c === CC_BTICK || c === CC_TILDE) {
    if (fenceStart(content)) return 'fence';
    return null;
  }
  if (c === CC_HASH) {
    if (atxHeading(content)) return 'atx';
    return null;
  }
  if (c === CC_LT) {
    const h = htmlBlockStart(content);
    if (h && h.type !== 7) return 'html';
    return null;
  }
  if (c === CC_GT) return 'quote';
  if (c === CC_DASH || c === CC_PLUS || c === CC_STAR) {
    if (thematicBreak(content)) return 'hr';
    const m = listMarker(content);
    if (m && !m.empty) {
      if (!inPara) return 'list';
      // a bullet list can interrupt a paragraph if its first item is non-empty
      if (m.bullet) return 'list';
      // an ordered list can interrupt only when it starts with 1
      if (m.ordered && m.start === 1) return 'list';
    }
    return null;
  }
  if (isDigit(c)) {
    const m = listMarker(content);
    if (m && !m.empty) {
      if (!inPara) return 'list';
      if (m.ordered && m.start === 1) return 'list';
    }
    return null;
  }
  if (c === CC_US) {
    if (thematicBreak(content)) return 'hr';
    return null;
  }
  return null;
}

function parseBlocks(lines, start, end, refs, top, endsWithNL, state, inItem) {
  const out = [];
  let i = start;
  let pendingBlank = false;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      if (out.length > 0) pendingBlank = true;
      i++;
      continue;
    }
    if (pendingBlank && state) state.blankSep = true;
    pendingBlank = false;
    const ind = indentOf(line);
    if (ind >= 4) {
      // Indented code block: consecutive lines with indent >= 4 (or blank),
      // each stripped of 4 columns. A blank line inside keeps
      // stripIndent(line, 4) (e.g. 6 spaces -> 2 spaces). Trailing blank
      // lines are dropped.
      const codeLines = [];
      let j = i;
      let lastNonBlank = -1;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) { codeLines.push(stripIndent(l, 4)); j++; continue; }
        if (indentOf(l) >= 4) {
          codeLines.push(stripIndent(l, 4));
          lastNonBlank = codeLines.length - 1;
          j++;
          continue;
        }
        break;
      }
      codeLines.length = lastNonBlank + 1;
      out.push(['code', codeLines.join('\n') + (codeLines.length ? '\n' : ''), null]);
      i = j;
      continue;
    }
    const content = stripIndent(line, ind);
    // Fenced code
    const fence = fenceStart(content);
    if (fence) {
      const fenceCh = fence.fence;
      const flen = fence.len;
      // marked's indentCodeCompensation counts the fence's indent in
      // CHARACTERS (the leading whitespace string), not columns: a fence
      // indented by 3 spaces strips a whole leading tab from a content line
      // (min(1 tab char, 3) = 1 char), it does not leave 1 space behind.
      let openIndChars = 0;
      while (openIndChars < line.length && (line.charCodeAt(openIndChars) === CC_SPACE || line.charCodeAt(openIndChars) === CC_TAB)) openIndChars++;
      const codeLines = [];
      let j = i + 1;
      while (j < end) {
        const l = lines[j];
        const li = indentOf(l);
        const lc = li <= 3 ? stripIndent(l, li) : l;
        // closing fence: same char, length >= opening, only spaces after
        if (li <= 3) {
          let k = 0;
          const fch = lc.charCodeAt(0);
          if (fch === fenceCh.charCodeAt(0)) {
            while (k < lc.length && lc.charCodeAt(k) === fch) k++;
            if (k >= flen) {
              let m = k;
              while (m < lc.length && (lc.charCodeAt(m) === CC_SPACE || lc.charCodeAt(m) === CC_TAB)) m++;
              if (m === lc.length) { j++; break; }
            }
          }
        }
        // indent compensation is only for backtick fences (marked's
        // indentCodeCompensation regex is /^(\s+)(?:```)/): a tilde fence
        // keeps its content lines' indentation. The strip is in characters,
        // not columns (see above).
        let cl = l;
        if (fenceCh === '`' && openIndChars > 0) {
          let k = 0;
          while (k < cl.length && k < openIndChars && (cl.charCodeAt(k) === CC_SPACE || cl.charCodeAt(k) === CC_TAB)) k++;
          cl = cl.slice(k);
        }
        codeLines.push(cl);
        j++;
      }
      // the text is the content lines joined (marked's cap[3] has no trailing
      // newline; the renderer adds exactly one)
      out.push(['code', codeLines.join('\n'), fence.info]);
      i = j;
      continue;
    }
    // ATX heading
    const atx = atxHeading(content);
    if (atx) {
      out.push(['h', atx.level, atx.text]);
      i++;
      continue;
    }
    // HTML block (types 1-7; type 7 cannot interrupt a paragraph, but it can
    // start a block here, at a block boundary). The text is the lines joined
    // with '\n' (marked's trimTrailingBlankLines): a trailing '\n' is kept
    // only when the block is at EOF and the source ends with '\n', or for
    // types 1-5 when the end-tag line is followed by a non-blank line.
    const hb = htmlBlockStart(content);
    if (hb) {
      const htmlLines = [line];
      let j = i + 1;
      let endTagLine = -1;
      if (hb.endTag !== undefined) {
        // ends at a line containing endTag (the start line itself may contain it)
        if (line.toLowerCase().indexOf(hb.endTag.toLowerCase()) !== -1) {
          endTagLine = i;
        } else {
          while (j < end) {
            htmlLines.push(lines[j]);
            if (lines[j].toLowerCase().indexOf(hb.endTag.toLowerCase()) !== -1) { endTagLine = j; j++; break; }
            j++;
          }
        }
      } else {
        while (j < end && !isBlankLine(lines[j])) { htmlLines.push(lines[j]); j++; }
      }
      let text = htmlLines.join('\n');
      let keepNL = false;
      if (hb.endTag !== undefined) {
        // types 1-5: the regex takes the newline after the end-tag line, and
        // trimTrailingBlankLines keeps a single trailing newline; it only
        // drops it when the next line is empty (the regex then takes 2+
        // newlines, which get trimmed). A whitespace-only next line (tab or
        // spaces) still keeps the single newline.
        if (j < end) {
          if (lines[j].length !== 0) keepNL = true;
        } else if (endsWithNL) {
          keepNL = true;
        }
      } else {
        // types 6-7: only at EOF with the source ending in '\n'
        if (j >= end && endsWithNL) keepNL = true;
      }
      if (keepNL) text += '\n';
      out.push(['html', text]);
      i = j;
      continue;
    }
    // Blockquote
    if (content.charCodeAt(0) === CC_GT) {
      const inner = [];
      let j = i;
      let inPara = false;
      // an open fence inside the quote: while one is open, a lazy line (no
      // '>') ends the quote (the fence chunk ends and the lazy line becomes
      // a separate top-level paragraph)
      let fence = null;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) break; // a plain blank line ends the quote
        const li = indentOf(l);
        if (li <= 3) {
          const lc = stripIndent(l, li);
          if (lc.charCodeAt(0) === CC_GT) {
            // content after '>' plus one optional space; a tab there expands
            // to spaces based on its original column (li + 1)
            const afterGt = lc.slice(1);
            const expanded = expandLeadingTabs(afterGt, li + 1);
            const rest = expanded.length > 0 && expanded.charCodeAt(0) === CC_SPACE
              ? expanded.slice(1) : expanded;
            if (rest === '') { inner.push(''); inPara = false; }
            else {
              inner.push(rest);
              inPara = endsInOpenPara(rest);
              // a fence opened by this line, or closed by it
              const ri = indentOf(rest);
              if (ri <= 3) {
                const rc = stripIndent(rest, ri);
                if (fence) {
                  const fc = fenceStart(rc);
                  if (fc && fc.fence === fence.ch && fc.len >= fence.len) {
                    let m = fc.len;
                    while (m < rc.length && (rc.charCodeAt(m) === CC_SPACE || rc.charCodeAt(m) === CC_TAB)) m++;
                    if (m === rc.length) fence = null;
                  }
                } else {
                  const fs = fenceStart(rc);
                  if (fs) fence = { ch: fs.fence, len: fs.len };
                }
              }
            }
            j++;
            continue;
          }
        }
        // a lazy line while a fence is open ends the quote
        if (fence) break;
        // lazy continuation: only when inside a paragraph. A lazy setext
        // line is checked FIRST (before canInterruptPara, which would
        // reject it) and is preceded by 4 spaces so it stays paragraph
        // text (blockquoteSetextReplace); any other lazy line keeps its
        // text, and an indented one is handled by parseParagraph's
        // container code-merge rule.
        if (inPara) {
          const slc = stripIndent(l, indentOf(l));
          const sl = setextLevel(slc);
          // a lazy setext line is checked FIRST (before canInterruptPara,
          // which would reject it) and is preceded by 4 spaces so it stays
          // paragraph text (blockquoteSetextReplace) — but a `---` line is a
          // thematic break, not a setext continuation: it ends the quote
          // (cm-092/101/234: `> foo\n---` -> <hr>)
          if (sl && !thematicBreak(slc)) {
            inner.push('    ' + l.replace(/^[ \t]+/, ''));
            j++;
            continue;
          }
          if (!canInterruptPara(l)) {
            // a lazy line indented by 4+ loses 4 columns and merges into
            // the preceding paragraph text (marked's indented-code merge):
            // it is appended to the previous inner line, so it is never
            // re-read as a block start (a stripped `- bar` stays paragraph
            // text, cm-238). A less-indented lazy line keeps its text.
            if (indentOf(l) >= 4) {
              inner[inner.length - 1] += '\n' + stripIndent(l, 4);
            } else {
              inner.push(l);
            }
            j++;
            continue;
          }
        }
        break;
      }
      // drop trailing blank inner lines
      while (inner.length && inner[inner.length - 1] === '') inner.pop();
      out.push(['quote', parseBlocks(inner, 0, inner.length, refs, true, false, null, false)]);
      i = j;
      continue;
    }
    // Thematic break
    if (thematicBreak(content)) {
      out.push(['hr']);
      i++;
      continue;
    }
    // List
    const lm = listMarker(content);
    if (lm) {
      const res = parseList(lines, i, end, refs);
      out.push(res.node);
      i = res.next;
      continue;
    }
    // Paragraph (may become setext heading, table, or link-def-only)
    const pres = parseParagraph(lines, i, end, refs, top, endsWithNL, inItem);
    if (pres.node) out.push(pres.node);
    i = pres.next;
  }
  return out;
}

// Collect a paragraph starting at lines[i]. Returns {node, next}.
// Link reference definitions are stripped FIRST (they precede setext/table:
// cm-216 [foo]: /url then === then [foo] is one paragraph ===\n[foo]),
// then setext headings, then tables, then a plain paragraph. A
// whitespace-only line that is the last line of this level, when the level's
// source does not end with a newline, is a paragraph continuation, not a
// blank line (cm-241: the trailing ' ' inside a blockquote).
function parseParagraph(lines, i, end, refs, top, endsWithNL, inItem) {
  // strip leading link ref defs first: match over the lines from i up to the
  // next blank line (a def cannot span one), so labels, destinations and
  // titles may span lines
  let p = i;
  {
    let blk = i;
    while (blk < end && !isBlankLine(lines[blk])) blk++;
    const rest0 = lines.slice(i, blk).join('\n');
    let cut = 0;
    while (p < blk) {
      const def = matchLinkDef(rest0.slice(cut));
      if (!def) break;
      const key = normalizeLabel(def.label);
      if (!refs.has(key)) refs.set(key, { dest: def.dest, title: def.title });
      p += def.linesUsed;
      for (let n = 0; n < def.linesUsed; n++) {
        const nl = rest0.indexOf('\n', cut);
        cut = nl === -1 ? rest0.length : nl + 1;
      }
    }
  }
  if (p >= end || isBlankLine(lines[p])) return { node: null, next: p };
  // after the defs, if the next line starts a block, there is no paragraph
  // here (the defs were a standalone token; the block is parsed next)
  {
    const ind0 = indentOf(lines[p]);
    const c0 = stripIndent(lines[p], ind0);
    if (ind0 >= 4) return { node: null, next: p };
    if (fenceStart(c0) || atxHeading(c0) || thematicBreak(c0)) return { node: null, next: p };
    if (c0.charCodeAt(0) === CC_GT) return { node: null, next: p };
    if (htmlBlockStart(c0)) return { node: null, next: p };
    if (listMarker(c0)) return { node: null, next: p };
  }
  const paraLines = [];
  let j = p;
  let tableMode = false;
  while (j < end) {
    const l = lines[j];
    if (isBlankLine(l)) {
      // marked's table rows stop at a blank line of spaces only (` *\n`):
      // a line of tabs is still a table row (an empty row).
      if (tableMode && l.indexOf('\t') !== -1) { paraLines.push(l); j++; continue; }
      if (j === end - 1 && !endsWithNL) { paraLines.push(l); j++; continue; }
      break;
    }
    const ind = indentOf(l);
    const content = stripIndent(l, ind);
    if (tableMode) {
      // table rows stop at a blank line, hr, heading, blockquote, indented
      // code, fences, a list marker (any bullet or 1./1) at the top level,
      // any list marker inside a list item), or html types 1-6
      if (ind >= 4) break;
      if (thematicBreak(content) || atxHeading(content)) break;
      if (content.charCodeAt(0) === CC_GT) break;
      if (fenceStart(content)) break;
      const m = listMarker(content);
      if (m && (inItem || m.bullet || (m.ordered && m.start === 1))) break;
      const h = htmlBlockStart(content);
      if (h && h.type !== 7) break;
      paraLines.push(l);
      j++;
      continue;
    }
    if (j > p) {
      // an indented line is a continuation, never a block start: at the top
      // level it keeps its spaces; inside a container it loses 4 columns
      // (marked's indented-code merge into the preceding paragraph), unless
      // stripping 4 would leave a setext underline (a setext continuation
      // keeps its 4 spaces).
      if (ind >= 4) {
        if (top) {
          paraLines.push(l);
        } else {
          const stripped = stripIndent(l, 4);
          if (setextLevel(stripped)) paraLines.push(l);
          else paraLines.push(stripped);
        }
        j++;
        continue;
      }
      // setext underline takes precedence over a thematic break: `---`
      // after a paragraph is a level-2 heading underline, not an <hr>
      const sl = setextLevel(content);
      if (sl) {
        paraLines.push(l);
        j++;
        break;
      }
      // a line that interrupts the paragraph ends it. Inside a list item,
      // ANY list marker interrupts (marked parses list-item content as
      // merged text tokens, so the list tokenizer runs first); at the top
      // level and inside a blockquote, only a bullet list or an ordered
      // list starting with 1 interrupts.
      // BUT the table delimiter on the second line wins over a list
      // interrupt: `a | b\n- | -\nx | y` is a table (the `-` cells are a
      // valid delimiter), not a paragraph plus a list.
      if (paraLines.length === 1 && tableDelimiter(content)) {
        paraLines.push(l);
        j++;
        tableMode = true;
        continue;
      }
      if (inItem) {
        const m2 = listMarker(content);
        if (m2 && !m2.empty) break;
      }
      if (interruptKind(content, true)) break;
    }
    paraLines.push(l);
    j++;
  }
  const body = paraLines;
  // Setext heading: last collected line is the underline (checked before
  // table, so `foo\n---` is an h2, not a one-column table). The heading text
  // is the paragraph text trimmed. But when the paragraph IS a table with
  // body rows, the last line is a table row, not an underline: a table
  // whose last row is `=========` stays a table.
  if (body.length >= 2 && !(tableMode && body.length > 2)) {
    const last = body[body.length - 1];
    const li = indentOf(last);
    if (li < 4) {
      const sl = setextLevel(stripIndent(last, li));
      if (sl) {
        const text = body.slice(0, -1).join('\n').trim();
        return { node: ['h', sl, text], next: j };
      }
    }
  }
  // Table: first line header, second line delimiter, following lines rows.
  if (body.length >= 2) {
    const dInd = indentOf(body[1]);
    if (dInd < 4) {
      const aligns = tableDelimiter(stripIndent(body[1], dInd));
      if (aligns) {
        const header = splitCells(stripIndent(body[0], indentOf(body[0])));
        if (header.length === aligns.length) {
          const rows = [];
          // marked's tableRowBlankLine (/\n[ \t]*$/) only strips the
          // trailing newline of the captured body, NOT a trailing tab-only
          // line: a `\t` row at the end of a table IS an empty row
          let last = body.length;
          for (let k = 2; k < last; k++) {
            rows.push(splitCells(stripIndent(body[k], indentOf(body[k])), header.length));
          }
          return { node: ['table', aligns, header, rows], next: j };
        }
      }
    }
  }
  const text = body.join('\n');
  return { node: ['p', text], next: j };
}

// Parse a list starting at lines[i]. Returns {node, next}.
function parseList(lines, i, end, refs) {
  const firstLine = lines[i];
  const firstInd = indentOf(firstLine);
  const firstContent = stripIndent(firstLine, firstInd);
  const firstMarker = listMarker(firstContent);
  const isOrdered = !!firstMarker.ordered;
  const bulletCh = isOrdered ? null : firstContent.charCodeAt(0);
  const delim = isOrdered ? firstMarker.delim : null;
  const startNum = isOrdered ? firstMarker.start : null;

  const items = [];
  let loose = false;
  let j = i;
  let prevItemEndedBlank = false;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // count the blank lines; they belong to the current item (one '' per
      // blank line, never collapsed) unless the next non-blank line starts
      // a new item of this list (then the blank separates items)
      let k = j;
      while (k < end && isBlankLine(lines[k])) k++;
      const blanks = k - j;
      if (k >= end) { j = k; break; }
      const nInd = indentOf(lines[k]);
      let newItem = false;
      // a line indented enough to be content of the last item is a sub-list
      // item, not a new item of this list (even if its marker matches):
      // `- a\n  - sub1\n\n  - sub2` keeps the outer list tight and makes
      // the SUB-list loose, it does not start a new outer item
      const lastIt = items.length > 0 ? items[items.length - 1] : null;
      const isItemContent = lastIt !== null && nInd >= lastIt.contentIndent + lastIt.baseIndent;
      if (!isItemContent && nInd <= 3) {
        const nContent = stripIndent(lines[k], nInd);
        const nm = listMarker(nContent);
        if (nm && markersMatch(nm, isOrdered, bulletCh, delim)) newItem = true;
      }
      if (newItem) {
        loose = true;
        prevItemEndedBlank = true;
        j = k;
        continue;
      }
      if (items.length === 0) { j = k; break; }
      const last = items[items.length - 1];
      if (last.lines.length === 0) {
        // an empty item followed by a blank line ends the list (endEarly)
        j = k;
        break;
      }
      // if the next non-blank line is not item content of the last item
      // (and not a new item), the list ends at the blank line: the blank is
      // NOT consumed, so the outer level sees it as a separator (cm-325: a
      // sub-list followed by a blank line and more outer-item text makes the
      // OUTER list loose; after a blank there is no lazy continuation)
      if (nInd < last.contentIndent + last.baseIndent) break;
      for (let b = 0; b < blanks; b++) last.lines.push('');
      last.inPara = false;
      j = k;
      continue;
    }
    const ind = indentOf(line);
    // A line indented enough to be content of the current item belongs to
    // that item (this is how sub-lists are recognised: their markers are
    // indented by at least the item's content indent).
    if (items.length > 0) {
      const last = items[items.length - 1];
      if (ind >= last.contentIndent + last.baseIndent) {
        const stripped = expandAndStrip(line, last.contentIndent + last.baseIndent);
        last.lines.push(stripped);
        last.inPara = endsInOpenPara(stripped);
        j++;
        continue;
      }
    }
    if (ind <= 3) {
      const content = stripIndent(line, ind);
      // a thematic break ends the list
      if (thematicBreak(content)) break;
      const m = listMarker(content);
      if (m && markersMatch(m, isOrdered, bulletCh, delim)) {
        // new item
        if (prevItemEndedBlank) loose = true;
        prevItemEndedBlank = false;
        const ci = contentIndentOf(m);
        const itemLines = [];
        let inPara = false;
        if (!m.empty) {
          // content after the marker on this line
          const firstContent = contentAfterMarker(content, m.markerLen, ci);
          itemLines.push(firstContent);
          inPara = endsInOpenPara(firstContent);
        }
        items.push({ lines: itemLines, contentIndent: ci, baseIndent: ind, inPara });
        j++;
        continue;
      }
      // a different list marker ends the list (it is not a lazy continuation)
      if (m) break;
      // not a new item: the list ends (unless lazy continuation of a paragraph
      // inside the last item). A lazy setext line is checked FIRST (before
      // canInterruptPara, which would reject it) and is preceded by 4 spaces
      // so it stays paragraph text (marked's list setextContinuation).
      if (items.length === 0) break;
      const last = items[items.length - 1];
      if (last.inPara) {
        // a lazy `---` is a thematic break (it ends the list), not a setext
        // continuation; a lazy `===`/`--` is a setext continuation
        if (setextLevel(content) && !thematicBreak(content)) {
          last.lines.push('    ' + content);
          last.inPara = true;
          j++;
          continue;
        }
        if (!canInterruptPara(line)) {
          last.lines.push(line);
          last.inPara = true;
          j++;
          continue;
        }
      }
      break;
    }
    // indented line, but not enough to be item content: lazy continuation of
    // the item's paragraph, or the list ends
    if (items.length === 0) break;
    const last = items[items.length - 1];
    if (last.inPara) {
      const slc2 = stripIndent(line, indentOf(line));
      if (setextLevel(slc2) && !thematicBreak(slc2)) {
        last.lines.push('    ' + slc2);
        last.inPara = true;
        j++;
        continue;
      }
      if (!canInterruptPara(line)) {
        last.lines.push(line);
        last.inPara = true;
        j++;
        continue;
      }
    }
    break;
  }
  // parse each item's lines; looseness comes from the parsed blocks: a blank
  // line separating two blocks inside an item makes the list loose
  const parsedItems = [];
  for (const item of items) {
    // drop leading/trailing blank lines of the item
    while (item.lines.length && item.lines[0] === '') item.lines.shift();
    while (item.lines.length && item.lines[item.lines.length - 1] === '') item.lines.pop();
    const itemState = { blankSep: false };
    parsedItems.push(parseBlocks(item.lines, 0, item.lines.length, refs, false, false, itemState, true));
    if (itemState.blankSep) loose = true;
  }
  return {
    node: ['list', isOrdered, startNum, delim, !loose, parsedItems],
    next: j,
  };
}

// Index in `content` (a line whose first `markerLen` chars are a list marker)
// just after skipping `skipCols` columns of whitespace following the marker.
// Tab-aware, consistent with how listMarker measures `spaces`.
function afterMarker(content, markerLen, skipCols) {
  let col = markerLen;
  let i = markerLen;
  const target = markerLen + skipCols;
  while (i < content.length && col < target) {
    const c = content.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) { col += 4 - (col % 4); i++; }
    else break;
  }
  return i;
}

// Expand the leading whitespace run of `line` to spaces (a tab expands to
// the next multiple of 4, based on the column), then drop the first `n` of
// those spaces. This is how list-item and blockquote content indentation is
// removed: a tab in the stripped region becomes spaces, so a later tab keeps
// the width it had in the original line (e.g. `\t\tbar` in a list item with
// content indent 2 leaves 6 spaces, i.e. a code block of `  bar`).
function expandAndStrip(line, n) {
  let col = 0, i = 0;
  let spaces = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE) { spaces += ' '; col++; i++; }
    else if (c === CC_TAB) { const w = 4 - (col % 4); spaces += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (spaces.length <= n) return line.slice(i);
  return spaces.slice(n) + line.slice(i);
}

// Expand the leading whitespace run of `s` (whose first char is at document
// column `col`) to spaces, based on the original columns.
function expandLeadingTabs(s, col) {
  let out = '', i = 0, c = col;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === CC_SPACE) { out += ' '; c++; i++; }
    else if (ch === CC_TAB) { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; }
    else break;
  }
  return out + s.slice(i);
}

// Can `line` (in document coordinates) start a block that interrupts a
// paragraph, or end it as a setext underline? (A line indented 4+ cannot
// start such a block, so it is a plain paragraph continuation.)
function canInterruptPara(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const content = stripIndent(line, ind);
  if (interruptKind(content, true)) return true;
  if (setextLevel(content)) return true;
  return false;
}

// Content after a list marker on the marker line: expand the whitespace
// following the marker to spaces (based on the original columns), then drop
// (contentIndent - markerLen) of them. With 5+ spaces only 1 is dropped.
function contentAfterMarker(content, markerLen, contentIndent) {
  let i = markerLen;
  let col = markerLen;
  let spaces = '';
  while (i < content.length) {
    const c = content.charCodeAt(i);
    if (c === CC_SPACE) { spaces += ' '; col++; i++; }
    else if (c === CC_TAB) { const w = 4 - (col % 4); spaces += ' '.repeat(w); col += w; i++; }
    else break;
  }
  const drop = contentIndent - markerLen;
  if (spaces.length <= drop) return content.slice(i);
  return spaces.slice(drop) + content.slice(i);
}

function markersMatch(m, isOrdered, bulletCh, delim) {
  if (isOrdered) return !!m.ordered && m.delim === delim;
  return !!m.bullet && m.ch === bulletCh;
}

// Is `line` (a raw line, already known non-blank) a paragraph continuation
// line (i.e. it does not start a block and is not a setext underline)?
function isParaLine(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  const content = stripIndent(line, ind);
  if (interruptKind(content, true)) return false;
  if (setextLevel(content)) return false;
  return true;
}

// Does `line` (a blockquote/list item content line) end inside an open
// paragraph, looking through nested blockquotes and list items? A lazy line
// must propagate through nested containers (cm-250/251/292/293: `> > > foo`
// then a lazy `bar` is still paragraph text).
function endsInOpenPara(line) {
  let s = line;
  for (;;) {
    const ind = indentOf(s);
    if (ind > 3) return false;
    const c = stripIndent(s, ind);
    if (c.length === 0) return false;
    if (c.charCodeAt(0) === CC_GT) {
      const after = c.slice(1);
      const expanded = expandLeadingTabs(after, ind + 1);
      s = expanded.length > 0 && expanded.charCodeAt(0) === CC_SPACE ? expanded.slice(1) : expanded;
      if (s === '') return false;
      continue;
    }
    const m = listMarker(c);
    if (m) {
      if (m.empty) return false;
      s = contentAfterMarker(c, m.markerLen, contentIndentOf(m));
      if (s === '') return false;
      continue;
    }
    return isParaLine(s);
  }
}

// Content indent of a list item: marker width + following spaces (1-4),
// or marker width + 1 when 5+ spaces follow, or the item is empty.
function contentIndentOf(m) {
  if (m.empty) return m.markerLen + 1;
  if (m.spaces >= 5) return m.markerLen + 1;
  return m.markerLen + m.spaces;
}

// ---------------------------------------------------------------------------
// Inline parsing: tokenize into nodes, process emphasis with a delimiter
// stack (CommonMark Appendix A), render to HTML.
// Node shapes (arrays): ['t', text] ['code', text] ['br'] ['html', raw]
//   ['link', href, title, children] ['img', src, title, alt]
//   ['em', children] ['strong', children] ['del', children]
//   ['delim', ch, len, canOpen, canClose]  (temporary, removed by emphasis)
// ---------------------------------------------------------------------------

function inline(s, refs) {
  const st = newInlineState(s, refs);
  tokenizeInline(st, 0, s.length, false);
  processEmphasis(st);
  return renderNodes(st.nodes);
}

// `~` runs: marked matches strikethrough by scanning forward from the opener
// (opener and closer must be the same length, 1 or 2; a left-only `~` run adds
// to the total so nested `~~...~~` pairs with the LAST closer, not the first).
// Returns the index after the closer, or 0.
function tryDel(st, i, end, start) {
  const s = st.s;
  let j = i;
  while (j < end && s.charCodeAt(j) === CC_TILDE) j++;
  const lLength = j - i;
  if (lLength > 2) return 0; // 3+ tildes: not a del opener
  // opener must be left-flanking (char after is not whitespace / '~')
  const [before, after] = flank(s, i, j, start, end);
  const leftFlanking = after !== 'ws' && (after !== 'punct' || before === 'ws' || before === 'punct');
  if (!leftFlanking) return 0;
  let delimTotal = lLength;
  let p = j;
  while (p < end) {
    if (s.charCodeAt(p) !== CC_TILDE) { p++; continue; }
    // an escaped tilde (odd number of backslashes before it) is content,
    // not a delimiter: `~~run \~~~` closes on the last two tildes
    let bs = 0;
    for (let b = p - 1; b >= start && s.charCodeAt(b) === 92; b--) bs++;
    if (bs % 2 === 1) { p++; continue; }
    let q = p;
    while (q < end && s.charCodeAt(q) === CC_TILDE) q++;
    const runLen = q - p;
    // a 3+ run starting at an unescaped tilde is no delimiter at all
    // (marked's regex never matches inside it); an escaped first tilde
    // was already skipped above, so the run from here is genuine
    if (runLen > 2) { p = q; continue; }
    if (runLen !== lLength) { p = q; continue; } // closer must match opener length
    const [b2, a2] = flank(s, p, q, start, end);
    const lf = a2 !== 'ws' && (a2 !== 'punct' || b2 === 'ws' || b2 === 'punct');
    const rf = b2 !== 'ws' && (b2 !== 'punct' || a2 === 'ws' || a2 === 'punct');
    if (lf && !rf) {
      delimTotal += runLen; // left-only: nested opener
    } else if (rf) {
      delimTotal -= runLen; // right or either: closer
      if (delimTotal <= 0) {
        const rLen = Math.min(runLen, runLen + delimTotal);
        const sub = newInlineState(s, st.refs);
        // inside a link label, extended autolinks stay disabled (marked's
        // state.inLink) even inside a nested del
        sub.noUrl = st.noUrl;
        tokenizeInline(sub, i + lLength, p, false);
        processEmphasis(sub);
        st.nodes.push(['del', sub.nodes]);
        return p + rLen;
      }
    }
    // neither left nor right flanking: not a delimiter
    p = q;
  }
  return 0;
}

function newInlineState(s, refs) {
  return { s, refs, nodes: [], delims: [], nodeToDelim: new Map(), noUrl: false };
}

// Document-level inLink (marked's lexer state.inLink): set by an inline
// `<a ...>` tag, cleared by `</a>`, and never reset between blocks. While
// set, the GFM url/email autolink is disabled.
let docInLink = false;

function pushText(st, text) {
  if (text === '') return;
  const nodes = st.nodes;
  const last = nodes[nodes.length - 1];
  if (last && last[0] === 't') last[1] += text;
  else nodes.push(['t', text]);
}

// Is the char at s[i] the start of a flanking boundary? Returns [before, after]
// where each is 'ws' (whitespace or string boundary), 'punct', or 'other'.
// Punctuation is Unicode P/S (marked's _punctuation), with '~' excluded for
// GFM emphasis. Astral characters are tested as whole code points.
function flank(s, i, j, lo, hi) {
  let before, after;
  if (i <= lo) before = 'ws';
  else {
    const ch = String.fromCodePoint(s.codePointAt(i - 1));
    before = isWhitespaceChar(ch) ? 'ws' : isPunctFlankChar(ch) ? 'punct' : 'other';
  }
  if (j >= hi) after = 'ws';
  else {
    const ch = String.fromCodePoint(s.codePointAt(j));
    after = isWhitespaceChar(ch) ? 'ws' : isPunctFlankChar(ch) ? 'punct' : 'other';
  }
  return [before, after];
}

// Is s[j] the start of an email local part (local-part chars followed by '@')?
// Used to stop a plain-text run before an email autolink.
const EMAIL_LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
function emailStartsAt(s, j, end) {
  let k = j;
  while (k < end && EMAIL_LOCAL_CHARS.indexOf(s[k]) !== -1) k++;
  return k > j && k < end && s.charCodeAt(k) === 64;
}

function tokenizeInline(st, start, end, noLink) {
  const s = st.s;
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === CC_BSLASH) {
      if (i + 1 < end && s.charCodeAt(i + 1) === CC_LF) {
        // hard break (backslash + newline): consume following spaces/tabs
        // too, but only when non-whitespace content follows (?!\s*$)
        let k = i + 2;
        while (k < end && (s.charCodeAt(k) === CC_SPACE || s.charCodeAt(k) === CC_TAB)) k++;
        if (k < end) { st.nodes.push(['br']); i = k; continue; }
        pushText(st, '\\');
        i++;
        continue;
      }
      if (i + 1 < end && isPunct(s.charCodeAt(i + 1))) {
        // a backslash-escaped char is literal text, but it must not merge
        // with following text: an escaped `&` is `&amp;`, never the start of
        // an entity reference (marked: `\&ouml;` -> `&amp;ouml;`)
        st.nodes.push(['esc', s[i + 1]]);
        i += 2;
        continue;
      }
      pushText(st, '\\');
      i++;
      continue;
    }
    if (c === CC_BTICK) {
      const r = codeSpan(st, i, end);
      if (r) { i = r.next; continue; }
      // no matching run: the whole backtick run is literal text
      let j = i;
      while (j < end && s.charCodeAt(j) === CC_BTICK) j++;
      pushText(st, s.slice(i, j));
      i = j;
      continue;
    }
    if (c === CC_STAR || c === CC_US) {
      const ch = String.fromCharCode(c);
      let j = i;
      while (j < end && s.charCodeAt(j) === c) j++;
      const len = j - i;
      const [before, after] = flank(s, i, j, start, end);
      const leftFlanking = after !== 'ws' && (after !== 'punct' || before === 'ws' || before === 'punct');
      const rightFlanking = before !== 'ws' && (before !== 'punct' || after === 'ws' || after === 'punct');
      let canOpen, canClose;
      if (c === CC_US) {
        canOpen = leftFlanking && (!rightFlanking || before === 'punct');
        canClose = rightFlanking && (!leftFlanking || after === 'punct');
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      const node = ['delim', ch, len, canOpen, canClose];
      const rec = { node, ch, len, origLen: len, canOpen, canClose };
      st.nodes.push(node);
      st.delims.push(rec);
      st.nodeToDelim.set(node, rec);
      i = j;
      continue;
    }
    if (c === CC_TILDE) {
      const r = tryDel(st, i, end, start);
      if (r) { i = r; continue; }
      // no strikethrough: the whole tilde run is literal text
      let j = i;
      while (j < end && s.charCodeAt(j) === CC_TILDE) j++;
      pushText(st, s.slice(i, j));
      i = j;
      continue;
    }
    if (c === CC_LBR || (c === CC_BANG && i + 1 < end && s.charCodeAt(i + 1) === CC_LBR)) {
      // links are disabled inside link text, but images are allowed there
      const isImage = c === CC_BANG;
      if (!noLink || isImage) {
        const r = tryLink(st, i, end);
        if (r) { i = r; continue; }
      }
      pushText(st, c === CC_BANG ? '!' : '[');
      i += 1;
      continue;
    }
    if (c === CC_LT) {
      const r = angleInline(st, i, end);
      if (r) { i = r; continue; }
      pushText(st, '<');
      i++;
      continue;
    }
    if (c === CC_AMP) {
      const e = readEntity(s, i);
      if (e) { pushText(st, e.text); i = e.next; continue; }
      pushText(st, '&');
      i++;
      continue;
    }
    if (c === CC_LF) {
      // soft break, unless preceded by 2+ spaces (hard break); a hard break
      // also consumes the following spaces/tabs (marked's br regex), but
      // only when non-whitespace content follows (?!\s*$)
      const nodes = st.nodes;
      const last = nodes[nodes.length - 1];
      if (last && last[0] === 't') {
        const t = last[1];
        let k = t.length;
        while (k > 0 && t.charCodeAt(k - 1) === CC_SPACE) k--;
        if (t.length - k >= 2) {
          let m = i + 1;
          while (m < end && (s.charCodeAt(m) === CC_SPACE || s.charCodeAt(m) === CC_TAB)) m++;
          if (m < end) {
            last[1] = t.slice(0, k);
            nodes.push(['br']);
            i = m;
            continue;
          }
        }
      }
      pushText(st, '\n');
      i++;
      continue;
    }
    // extended autolinks (GFM): www., http(s)://, email. www. needs a
    // boundary (start / whitespace / * _ ~ (), http(s):// and email do not.
    // Disabled inside a link label (st.noUrl) and while the document-level
    // inLink is set by an unclosed inline <a ...> tag (marked's state.inLink).
    if (!st.noUrl && !docInLink && (c === 119 || c === 104 || isAlpha(c))) {
      const r = extAutolink(st, i, end);
      if (r) { i = r; continue; }
    }
    // plain text run until the next special char
    let j = i + 1;
    while (j < end) {
      const d = s.charCodeAt(j);
      if (d === CC_BSLASH || d === CC_BTICK || d === CC_STAR || d === CC_US || d === CC_TILDE ||
          d === CC_LBR || d === CC_BANG || d === CC_LT || d === CC_AMP || d === CC_LF) break;
      if (!st.noUrl && !docInLink && (d === 119 || d === 104 || d === 72 || d === 70)) {
        // possible www./http(s)://ftp:// autolink start (the protocol is
        // case-insensitive, so Https:// and FTP:// link too); stop the run
        // and let the loop check
        if (s.startsWith('www.', j) || schemeLen(s, j) > 0) break;
      }
      // a mailto:/xmpp: autolink starts here (the previous char is a
      // non-alnum, so it is not part of a word like xmailto:); stop the run
      // so the loop can try it at j
      if (!st.noUrl && !docInLink && (s.startsWith('mailto:', j) || s.startsWith('xmpp:', j)) &&
          !isAlnum(s.charCodeAt(j - 1))) break;
      if (!st.noUrl && !docInLink && d === 64) break; // possible email autolink
      // an email local part starts here (previous char is not a local-part
      // char, so this is a word boundary): stop the run so the loop can try
      // the email autolink at j
      if (!st.noUrl && !docInLink && j > i && EMAIL_LOCAL_CHARS.indexOf(s[j]) !== -1 &&
          EMAIL_LOCAL_CHARS.indexOf(s[j - 1]) === -1 && emailStartsAt(s, j, end)) break;
      j++;
    }
    pushText(st, s.slice(i, j));
    i = j;
  }
}

// Code span: backtick run at i; find a matching run of the same length.
// Returns {next} or null.
function codeSpan(st, i, end) {
  const s = st.s;
  let j = i;
  while (j < end && s.charCodeAt(j) === CC_BTICK) j++;
  const len = j - i;
  const closer = findBacktickRun(s, j, end, len);
  if (closer === -1) return null;
  let content = s.slice(j, closer);
  content = content.replace(/\n/g, ' ');
  if (content.length >= 2 && content.charCodeAt(0) === CC_SPACE &&
      content.charCodeAt(content.length - 1) === CC_SPACE &&
      content.trim() !== '') {
    content = content.slice(1, -1);
  }
  st.nodes.push(['code', content]);
  return { next: closer + len };
}

function findBacktickRun(s, from, end, len) {
  let i = from;
  while (i < end) {
    if (s.charCodeAt(i) === CC_BTICK) {
      let j = i;
      while (j < end && s.charCodeAt(j) === CC_BTICK) j++;
      if (j - i === len) return i;
      i = j;
    } else i++;
  }
  return -1;
}

// `<...>` : autolink (scheme: or email), or a raw HTML tag, or nothing.
function angleInline(st, i, end) {
  const s = st.s;
  // autolink: <scheme:...> or <email>
  let j = i + 1;
  if (j < end && (isAlpha(s.charCodeAt(j)))) {
    // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
    let k = j + 1;
    while (k < end && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === CC_DOT || s.charCodeAt(k) === CC_DASH)) k++;
    if (k - j >= 2 && k - j <= 32 && k < end && s.charCodeAt(k) === CC_COLON) {
      // destination until '>' (no space, no <, no control). The autolink
      // regex's dest is [^\s\x00-\x1f<>]*: a backslash does NOT escape the
      // '>', so <https://example.com/\[\\> ends at the first '>' (cm-603).
      let m = k + 1;
      let found = false;
      while (m < end) {
        const c = s.charCodeAt(m);
        if (c === CC_GT) { found = true; break; }
        if (c === CC_SPACE || c === CC_LT || c < 32) break;
        m++;
      }
      if (found) {
        const dest = s.slice(j, m);
        st.nodes.push(['autolink', dest, null, [['t', dest]]]);
        return m + 1;
      }
    }
    // email: local@domain.tld
    const em = matchEmail(s, j, end);
    if (em !== -1) {
      const addr = s.slice(j, em);
      st.nodes.push(['autolink', 'mailto:' + addr, null, [['t', addr]]]);
      return em + 1;
    }
  }
  // HTML tag (strict: <https://...> and <m:abc> are not tags)
  const tag = readHtmlTag(s, i);
  if (tag) {
    const raw = s.slice(i, tag.end);
    // marked's tag tokenizer: a start <a ...> tag sets lexer inLink, and
    // only </a> clears it (startATag /^<a /i, endATag /^<\/a>/i). The
    // state persists across blocks, disabling GFM autolinks afterwards.
    if (!docInLink && /^<a /i.test(raw)) docInLink = true;
    else if (docInLink && /^<\/a>/i.test(raw)) docInLink = false;
    st.nodes.push(['html', raw]);
    return tag.end;
  }
  return 0;
}

// Match an email address starting at s[i] (inside <...>). Returns the index of
// the closing '>' (i.e. end of address) or -1. Marked's autolink email regex
// has no TLD length requirement (so <a@b.c> is an autolink), but every domain
// label must start and end with an alnum (max 63 chars) and there must be at
// least one dot.
function matchEmail(s, i, end) {
  // local part: [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+
  let j = i;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || '.!#$%&\'*+/=?^_`{|}~-'.indexOf(s[j]) !== -1) j++;
    else break;
  }
  if (j === i || j >= end || s.charCodeAt(j) !== 64) return -1;
  j++; // past '@'
  // domain: first label + 1+ dot-labels; each label starts+ends with alnum
  let dots = 0;
  while (true) {
    if (j >= end || !isAlnum(s.charCodeAt(j))) return -1;
    // consume the alnum/dash run, then backtrack trailing dashes (a label
    // must end with an alnum)
    let m = j;
    while (m < end && (isAlnum(s.charCodeAt(m)) || s.charCodeAt(m) === CC_DASH)) m++;
    let le = m;
    while (le > j && s.charCodeAt(le - 1) === CC_DASH) le--;
    if (le - j > 63) le = j + 63;
    // if the run continues past the label (trailing dashes or over-length),
    // the label cannot end cleanly here -> no match
    if (le < m) return -1;
    j = le;
    if (j < end && s.charCodeAt(j) === CC_DOT) {
      if (j + 1 >= end || !isAlnum(s.charCodeAt(j + 1))) return -1;
      dots++;
      j++;
      continue;
    }
    break;
  }
  if (dots === 0) return -1;
  if (j >= end || s.charCodeAt(j) !== CC_GT) return -1;
  return j;
}

// Length of a case-insensitive http://, https:// or ftp:// at s[i]
// (marked's _caseInsensitiveProtocol), or 0.
function schemeLen(s, i) {
  const sub = s.slice(i, i + 8).toLowerCase();
  if (sub.startsWith('https://')) return 8;
  if (sub.startsWith('http://')) return 7;
  if (sub.startsWith('ftp://')) return 6;
  return 0;
}

// Match an email [A-Za-z0-9._+-]+@domain starting at s[i] (the part after a
// mailto:/xmpp: prefix). Returns the end index or -1.
function matchEmailProto(s, i, end) {
  let j = i;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === CC_DOT || c === CC_DASH || c === CC_US || c === 43) j++;
    else break;
  }
  if (j === i || j >= end || s.charCodeAt(j) !== 64) return -1;
  return matchExtEmailDomain(s, j + 1, end);
}

// GFM extended autolinks in plain text: www., http(s)://, email.
// www. needs a boundary (start, whitespace, or * _ ~ (); http(s):// and
// email have no boundary check (marked links xhttps://foo.com and
// afoo@bar.com as a whole). Returns the index after the autolink, or 0.
function extAutolink(st, i, end) {
  const s = st.s;
  // mailto:/xmpp: extended autolinks (marked's _extendedEmailProtocol):
  // mailto:email or xmpp:email[/resource]; the whole thing (including the
  // lowercase-only prefix) is the link text and href (gfm-633..635)
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const isMailto = s.startsWith('mailto:', i);
    const protoLen = isMailto ? 7 : 5;
    let e = matchEmailProto(s, i + protoLen, end);
    if (e !== -1) {
      if (!isMailto && e < end && s.charCodeAt(e) === CC_SLASH) {
        // xmpp resource: /[A-Za-z0-9@.]+ (no '/' inside, so /txt/bin only
        // takes /txt)
        let k = e + 1;
        while (k < end) {
          const c = s.charCodeAt(k);
          if (isAlnum(c) || c === 64 || c === CC_DOT) k++;
          else break;
        }
        if (k > e + 1) e = k;
      }
      const dest = s.slice(i, e);
      st.nodes.push(['autolink', dest, null, [['t', dest]]]);
      return e;
    }
    return 0;
  }
  if (s.startsWith('www.', i)) {
    if (i > 0) {
      const prev = s[i - 1];
      if (!(isWhitespaceChar(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(')) return 0;
    }
    const e = matchDomain(s, i + 4, end);
    if (e !== -1) {
      const dest = s.slice(i, e);
      st.nodes.push(['autolink', 'http://' + dest, null, [['t', dest]]]);
      return e;
    }
    return 0;
  }
  if (schemeLen(s, i) > 0) {
    const schemeEnd = i + schemeLen(s, i);
    const e = matchDomain(s, schemeEnd, end);
    if (e !== -1) {
      const dest = s.slice(i, e);
      st.nodes.push(['autolink', dest, null, [['t', dest]]]);
      return e;
    }
    return 0;
  }
  // email: local@domain (the caller already stopped the text run at the
  // start of the local part). The extended-autolink email (marked's url-rule
  // email) has a smaller local part [A-Za-z0-9._+-]+ and a domain of
  // [a-zA-Z0-9-_]+ with dot-labels ending in an alnum, no TLD length
  // requirement (so a.b-c_d@a.b is an autolink, gfm-632..635).
  if (isAlnum(s.charCodeAt(i))) {
    let j = i;
    while (j < end) {
      const c = s.charCodeAt(j);
      if (isAlnum(c) || s.charCodeAt(j) === CC_DOT || s.charCodeAt(j) === CC_DASH || s.charCodeAt(j) === CC_US || s.charCodeAt(j) === 43) j++;
      else break;
    }
    if (j < end && s.charCodeAt(j) === 64) {
      const e = matchExtEmailDomain(s, j + 1, end, st.delims);
      if (e !== -1) {
        const addr = s.slice(i, e);
        st.nodes.push(['autolink', 'mailto:' + addr, null, [['t', addr]]]);
        return e;
      }
    }
  }
  return 0;
}

// Match the domain of an extended-autolink email starting at s[i] (marked's
// url-rule email: [a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])).
// No TLD length requirement; a dot-label ends with an alnum; if the lookahead
// fails (the domain is followed by a word char or '-'), drop the last
// dot-group and retry (0 dot-groups left -> fail). Returns the end index or -1.
// Is the `*`/`_` run at p a delimiter that can close an emphasis AND has a
// matching opener collected so far (delims)? Marked tokenizes nested content
// (inside em/strong/del) as a separate string, so an autolink lookahead at the
// end of such content sees end-of-string; here the whole paragraph is
// tokenized in one pass, so a closing delimiter right after an autolink must
// count as end-of-string for the lookahead, not as a word character. A `_`/`*`
// with no opener (e.g. a trailing `_` in `a.b-c_d@a.b_`, gfm-632) is not a
// closer, so the lookahead still fails there.
function isEmphasisCloser(s, p, end, delims) {
  const c = s.charCodeAt(p);
  if (c !== CC_STAR && c !== CC_US) return false;
  let q = p;
  while (q < end && s.charCodeAt(q) === c) q++;
  const [before, after] = flank(s, p, q, 0, end);
  const leftFlanking = after !== 'ws' && (after !== 'punct' || before === 'ws' || before === 'punct');
  const rightFlanking = before !== 'ws' && (before !== 'punct' || after === 'ws' || after === 'punct');
  const canClose = c === CC_US ? rightFlanking && (!leftFlanking || after === 'punct') : rightFlanking;
  if (!canClose) return false;
  if (!delims) return false;
  for (let k = delims.length - 1; k >= 0; k--) {
    const d = delims[k];
    if (d && d.ch === String.fromCharCode(c) && d.canOpen && d.len > 0) return true;
  }
  return false;
}

function matchExtEmailDomain(s, i, end, delims) {
  let j = i;
  // first label: [a-zA-Z0-9-_]+
  if (j >= end || !(isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === CC_DASH || s.charCodeAt(j) === CC_US)) return -1;
  while (j < end && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === CC_DASH || s.charCodeAt(j) === CC_US)) {
    if (s.charCodeAt(j) === CC_US && isEmphasisCloser(s, j, end, delims)) break;
    j++;
  }
  // dot-label ends (the end index of each valid dot-label)
  const ends = [];
  let badTail = false; // a dot-label was followed by '-'/'_' (lookahead fails)
  while (j < end && s.charCodeAt(j) === CC_DOT) {
    const k = j + 1;
    let m = k;
    while (m < end && (isAlnum(s.charCodeAt(m)) || s.charCodeAt(m) === CC_DASH || s.charCodeAt(m) === CC_US)) {
      if (s.charCodeAt(m) === CC_US && isEmphasisCloser(s, m, end, delims)) break;
      m++;
    }
    let le = m;
    while (le > k && (s.charCodeAt(le - 1) === CC_DASH || s.charCodeAt(le - 1) === CC_US)) le--;
    if (le === k) break; // empty label (a trailing dot)
    ends.push(le);
    if (le < m) { badTail = true; break; } // followed by '-'/'_'
    j = le;
  }
  if (ends.length === 0) return -1;
  if (badTail) {
    // the lookahead fails at the last dot-group: drop it
    if (ends.length === 1) return -1;
    return ends[ends.length - 2];
  }
  const e = ends[ends.length - 1];
  if (e < end) {
    const c = s.charCodeAt(e);
    if (isAlnum(c) || c === CC_DASH) {
      if (ends.length === 1) return -1;
      return ends[ends.length - 2];
    }
    // a `_`/`*` that closes an emphasis counts as end-of-string (marked
    // tokenizes the emphasis content separately); a `_` inside a word does not
    if (c === CC_US && !isEmphasisCloser(s, e, end, delims)) {
      if (ends.length === 1) return -1;
      return ends[ends.length - 2];
    }
  }
  return e;
}

// Match a domain starting at s[i] for www./http(s):// extended autolinks:
// marked's url regex domain is (?:[a-zA-Z0-9-]+\.?)+ — labels of
// [a-zA-Z0-9-]+ each optionally followed by '.', no dot required (www.foo
// and http://foo are autolinks) and no TLD requirement. Then an optional
// path (any chars except whitespace and '<'), with trailing punctuation
// trimmed per the GFM autolink rules. Returns the end index or -1.
function matchDomain(s, i, end) {
  let j = i;
  let any = false;
  while (j < end) {
    if (!(isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === CC_DASH)) break;
    while (j < end && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === CC_DASH)) j++;
    any = true;
    if (j < end && s.charCodeAt(j) === CC_DOT) j++;
  }
  if (!any) return -1;
  // optional path: any run of non-space, non-'<' chars
  let k = j;
  while (k < end) {
    const c = s.charCodeAt(k);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_LT) break;
    k++;
  }
  let e = k;
  // marked's _backpedal: trim the URL the way the GFM url rule does
  e = backpedal(s, i, e);
  return e;
}

// Punctuation in marked's _backpedal character class [^?!.,:;*_'\"~()&].
function isBackpedalPunct(c) {
  return c === 63 || c === 33 || c === CC_DOT || c === 44 || c === CC_COLON || c === CC_SEMI || c === CC_STAR || c === CC_US || c === 39 || c === 34 || c === CC_TILDE || c === CC_LPAR || c === CC_RPAR || c === CC_AMP;
}

// Punctuation in _backpedal's trailing-run class [?!.,:;*_'\"~)] (no '(' or '&').
function isBackpedalPunctTail(c) {
  return c === 63 || c === 33 || c === CC_DOT || c === 44 || c === CC_COLON || c === CC_SEMI || c === CC_STAR || c === CC_US || c === 39 || c === 34 || c === CC_TILDE || c === CC_RPAR;
}

// marked's _backpedal regex for extended autolinks, as a function:
// /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/
// Consumes the URL from `start` (up to `e`), stopping at trailing
// punctuation, at an unmatched '(' (no ')' after it), and before a trailing
// &name; entity. An unmatched '(' in the middle ends the URL there, so
// `https://sub.domain.example.io)](https://npmjs.com/heading` backpedals to
// `https://sub.domain.example.io)]`.
function backpedal(s, start, e) {
  let p = start;
  while (p < e) {
    const c = s.charCodeAt(p);
    if (!isBackpedalPunct(c)) {
      let q = p;
      while (q < e && !isBackpedalPunct(s.charCodeAt(q))) q++;
      p = q;
      continue;
    }
    // \([^)]*\): a balanced paren group; an unmatched '(' ends the URL
    if (c === CC_LPAR) {
      let q = p + 1;
      while (q < e && s.charCodeAt(q) !== CC_RPAR) q++;
      if (q < e) { p = q + 1; continue; }
      break;
    }
    // &(?![a-zA-Z0-9]+;$): a bare '&'; an &name; at the very end is not one
    if (c === CC_AMP) {
      let q = p + 1;
      while (q < e && isAlnum(s.charCodeAt(q))) q++;
      if (q < e && s.charCodeAt(q) === CC_SEMI && q + 1 === e && q > p + 1) break;
      p++;
      continue;
    }
    // [?!.,:;*_'\"~)]+(?!$): a punctuation run, but not reaching the end
    let q = p;
    while (q < e && isBackpedalPunctTail(s.charCodeAt(q))) q++;
    if (q < e) { p = q; continue; }
    break;
  }
  return p;
}

// Try to parse a link or image starting at s[i] ('[' or '![').
// Returns the index after the link, or 0. An inline-link parse failure falls
// through to the reference checks (so [foo](not a link) can still be a
// shortcut reference); a failed reference lookup also falls through. The
// collapsed reference [foo][] is checked before the full reference.
function tryLink(st, i, end) {
  const s = st.s;
  let isImage = false;
  let p = i;
  if (s.charCodeAt(p) === CC_BANG) { isImage = true; p++; }
  if (p >= end || s.charCodeAt(p) !== CC_LBR) return 0;
  const textEnd = findLinkTextEnd(s, p, end);
  if (textEnd === -1) return 0;
  const textStart = p + 1;
  const after = textEnd + 1;
  // inline link: (dest "title")
  if (after < end && s.charCodeAt(after) === CC_LPAR) {
    const r = parseInlineLink(st, after, end);
    if (r) return finishLink(st, isImage, textStart, textEnd, r.dest, r.title, r.next);
    // fall through to the reference checks
  }
  // collapsed reference: [label][]
  if (after + 1 < end && s.charCodeAt(after) === CC_LBR && s.charCodeAt(after + 1) === CC_RBR) {
    const label = s.slice(textStart, textEnd);
    const ref = lookupRef(st.refs, label);
    if (ref) return finishLink(st, isImage, textStart, textEnd, ref.dest, ref.title, after + 2);
    // a collapsed ref was attempted and failed: the label is NOT a shortcut
    // (marked's reflink matches [label][] and, on a failed lookup, emits
    // just '[' as text)
    return 0;
  }
  // full reference: [label][ref]
  if (after < end && s.charCodeAt(after) === CC_LBR) {
    const le = findLinkTextEnd(s, after, end);
    if (le !== -1) {
      const label = s.slice(after + 1, le);
      const ref = lookupRef(st.refs, label);
      if (ref) return finishLink(st, isImage, textStart, textEnd, ref.dest, ref.title, le + 1);
      // a full ref was attempted and failed: the label is NOT a shortcut
      // (cm-571: [foo][bar][baz] leaves [foo] literal when 'bar' is
      // undefined, and [bar][baz] links instead)
      return 0;
    }
    // no closing ']' after the '[': fall through to the shortcut
  }
  // shortcut reference: [label]
  const label = s.slice(textStart, textEnd);
  const ref = lookupRef(st.refs, label);
  if (ref) return finishLink(st, isImage, textStart, textEnd, ref.dest, ref.title, after);
  return 0;
}

// Find the index of the ']' closing the link text that starts at s[p] ('[').
// Handles nested brackets and code spans. A '<...>' (tag or autolink) that
// starts inside the label and would extend past the ']' rejects the link, so
// brackets inside such a span do not close the label. Returns -1 if none.
function findLinkTextEnd(s, p, end) {
  let depth = 0;
  let i = p + 1;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === CC_BSLASH && i + 1 < end) { i += 2; continue; }
    if (c === CC_BTICK) {
      let j = i;
      while (j < end && s.charCodeAt(j) === CC_BTICK) j++;
      // marked's _inlineLabel tries the code-span alternative first, but
      // it backtracks: a run whose closer would swallow the ']' cannot end
      // the label, so the ``+(?=\]) alternative wins. That alternative is
      // TWO or more backticks (``+ = a backtick followed by one or more),
      // so only a run of length >= 2 immediately before ']' is literal;
      // a single backtick there is a code-span opener with no closer and
      // the label cannot match ([foo`](/uri) is no link).
      if (j - i >= 2 && j < end && s.charCodeAt(j) === CC_RBR) { i = j; continue; }
      // loose code span (marked's _inlineLabel: `+(?!`)[^`]*?`+(?!`)):
      // the closer is the NEXT backtick run of ANY length, and a ']'
      // between opener and closer is inside the span, so it does not end
      // the label. `[a ``b](url) more ``c`` end` is no link (the span
      // swallows the ']'); `[docs each ``url`](url)` IS a link (the
      // single '`' after `url` closes the span before the ']').
      // With NO closer at all, the backticks are literal only when
      // immediately before ']' (``+(?=\])); otherwise the label cannot
      // match and the link is rejected ([a `b c](url) is no link).
      let k = j;
      while (k < end && s.charCodeAt(k) !== CC_BTICK) k++;
      if (k >= end) {
        // no closer at all and not immediately before ']' (checked above):
        // the label cannot match, so the link is rejected.
        return -1;
      }
      let m = k;
      while (m < end && s.charCodeAt(m) === CC_BTICK) m++;
      i = m;
      continue;
    }
    if (c === CC_LT) {
      // a '<...>' span: if it closes before any ']' it is fine; if it
      // runs past the label's ']' the link is rejected, so skip the span
      // and let the ']' inside it not count as the label end
      const tag = readHtmlTag(s, i);
      if (tag) { i = tag.end; continue; }
      // an autolink <scheme:...> or <email>
      let j = i + 1;
      if (j < end && isAlpha(s.charCodeAt(j))) {
        let k = j + 1;
        while (k < end && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === CC_DOT || s.charCodeAt(k) === CC_DASH)) k++;
        if (k - j >= 2 && k - j <= 32 && k < end && s.charCodeAt(k) === CC_COLON) {
          let m = k + 1;
          while (m < end && s.charCodeAt(m) !== CC_GT && s.charCodeAt(m) !== CC_SPACE && s.charCodeAt(m) !== CC_LT && s.charCodeAt(m) >= 32) m++;
          if (m < end && s.charCodeAt(m) === CC_GT) { i = m + 1; continue; }
        }
        const em = matchEmail(s, j, end);
        if (em !== -1) { i = em + 1; continue; }
      }
      i++;
      continue;
    }
    if (c === CC_LBR) depth++;
    else if (c === CC_RBR) {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return -1;
}

function lookupRef(refs, label) {
  if (!refs) return null;
  return refs.get(normalizeLabel(label)) || null;
}

// Parse an inline link destination/title starting at s[i] ('(').
// Returns {dest, title, next} or null.
function parseInlineLink(st, i, end) {
  const s = st.s;
  let p = i + 1;
  while (p < end && (s.charCodeAt(p) === CC_SPACE || s.charCodeAt(p) === CC_TAB || s.charCodeAt(p) === CC_LF)) p++;
  if (p >= end) return null;
  let dest = '';
  if (s.charCodeAt(p) === CC_LT) {
    let j = p + 1;
    while (j < end && s.charCodeAt(j) !== CC_GT) {
      const c = s.charCodeAt(j);
      if (c === CC_LF) return null;
      if (c === CC_BSLASH && j + 1 < end && isPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; continue; }
      dest += s[j];
      j++;
    }
    if (j >= end) return null;
    p = j + 1;
  } else {
    // bare destination: no spaces; balanced parens allowed
    let depth = 0;
    let j = p;
    while (j < end) {
      const c = s.charCodeAt(j);
      if (c === CC_SPACE || c === CC_TAB || c === CC_LF) break;
      if (c === CC_BSLASH && j + 1 < end && isPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; continue; }
      if (c === CC_LPAR) depth++;
      else if (c === CC_RPAR) {
        if (depth === 0) break;
        depth--;
      }
      dest += s[j];
      j++;
    }
    if (depth !== 0) return null;
    p = j;
  }
  while (p < end && (s.charCodeAt(p) === CC_SPACE || s.charCodeAt(p) === CC_TAB || s.charCodeAt(p) === CC_LF)) p++;
  let title = null;
  if (p < end && s.charCodeAt(p) !== CC_RPAR) {
    const t = parseTitleInString(s, p, end);
    if (!t) return null;
    title = t.title;
    p = t.next;
    while (p < end && (s.charCodeAt(p) === CC_SPACE || s.charCodeAt(p) === CC_TAB || s.charCodeAt(p) === CC_LF)) p++;
  }
  if (p >= end || s.charCodeAt(p) !== CC_RPAR) return null;
  return { dest, title, next: p + 1 };
}

// parseTitle but on the inline string s with bounds [i, end).
function parseTitleInString(s, i, end) {
  const open = s.charCodeAt(i);
  let close;
  if (open === CC_QUOT) close = CC_QUOT;
  else if (open === CC_SQ) close = CC_SQ;
  else if (open === CC_LPAR) close = CC_RPAR;
  else return null;
  let j = i + 1;
  let title = '';
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === CC_BSLASH && j + 1 < end) {
      const n = s.charCodeAt(j + 1);
      if (isPunct(n)) { title += s[j + 1]; j += 2; continue; }
      title += s[j]; j++; continue;
    }
    if (c === close) return { title, next: j + 1 };
    title += s[j];
    j++;
  }
  return null;
}

// Does a node list contain a link node (recursively, through em/strong/del)?
function nodesContainLink(nodes) {
  for (const n of nodes) {
    if (n[0] === 'link') return true;
    if (n[0] === 'em' || n[0] === 'strong' || n[0] === 'del') {
      if (nodesContainLink(n[1])) return true;
    }
  }
  return false;
}

// Build the link/image node from the parsed bracket text.
// The label is tokenized with links enabled: a link inside a link's label
// rejects the outer link (its inner link then renders on its own); an image
// inside a link's label is kept. An image's alt text is the label tokenized
// with links enabled, flattened to plain text.
function finishLink(st, isImage, textStart, textEnd, dest, title, next) {
  const s = st.s;
  const sub = newInlineState(s, st.refs);
  // inside a link label, extended autolinks are disabled (marked's
  // state.inLink), but inner links are still parsed so that a label
  // containing a link rejects the outer link (links may not contain links)
  sub.noUrl = true;
  tokenizeInline(sub, textStart, textEnd, false);
  processEmphasis(sub);
  if (!isImage && nodesContainLink(sub.nodes)) return 0;
  if (isImage) {
    const alt = plainText(sub.nodes);
    st.nodes.push(['img', dest, title, alt]);
  } else {
    st.nodes.push(['link', dest, title, sub.nodes]);
  }
  return next;
}

// Plain text of a node list (for image alt text): emphasis markers removed,
// code kept as its content, entities already decoded.
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n[0] === 't') out += n[1];
    else if (n[0] === 'esc') out += n[1];
    else if (n[0] === 'code') out += n[1];
    else if (n[0] === 'br') out += '\n';
    else if (n[0] === 'em' || n[0] === 'strong' || n[0] === 'del') out += plainText(n[1]);
    else if (n[0] === 'link' || n[0] === 'autolink') out += plainText(n[3]);
    else if (n[0] === 'img') out += n[3];
    else if (n[0] === 'delim') out += n[1].repeat(n[2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis: CommonMark Appendix A delimiter-stack algorithm, as in
// commonmark.js's processEmphasis. The odd-match test uses the ORIGINAL
// delimiter lengths (origLen) and the closer's length mod 3; an odd match
// only skips that opener for this closer (the search continues). The lower
// bound for future opener searches is tracked per slot
// (char, closer-can-open, closer-origLen mod 3), and is set to the delimiter
// before the closer when no opener is found. A delimiter that ends up inside
// an emphasis node can no longer match a closer outside that node (marked:
// `*a _b* c_` stays literal), so wrapping deactivates the delimiters strictly
// between the opener and the closer.
// ---------------------------------------------------------------------------

function processEmphasis(st) {
  const delims = st.delims;
  const bottom = new Map(); // slot -> delimiter record (exclusive lower bound)
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer || closer.len === 0 || !closer.canClose) { ci++; continue; }
    const slot = closer.ch + '|' + (closer.canOpen ? 1 : 0) + '|' + (closer.origLen % 3);
    const bottomRec = bottom.get(slot) || null;
    while (closer.len > 0) {
      let oi = -1;
      for (let j = ci - 1; j >= 0; j--) {
        const o = delims[j];
        if (o === bottomRec) break;
        if (!o || o.len === 0 || !o.canOpen || o.ch !== closer.ch) continue;
        // odd match (rule 9/10): skip this opener, keep looking
        const odd = (closer.canOpen || o.canClose) &&
          (closer.origLen % 3 !== 0) &&
          ((o.origLen + closer.origLen) % 3 === 0);
        if (odd) continue;
        oi = j;
        break;
      }
      if (oi === -1) {
        // no opener: set the lower bound for this slot to the nearest live
        // delimiter before the closer
        let b = ci - 1;
        while (b >= 0 && (!delims[b] || delims[b].len === 0)) b--;
        bottom.set(slot, b >= 0 ? delims[b] : null);
        if (!closer.canOpen) {
          // a closer that cannot open will never match anything
          closer.len = 0;
          if (closer.node) {
            st.nodeToDelim.delete(closer.node);
            closer.node = null;
          }
        }
        break;
      }
      const opener = delims[oi];
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      wrapEmphasis(st, opener, closer, use);
      if (closer.len === 0) break;
    }
    ci++;
  }
}

function wrapEmphasis(st, opener, closer, use) {
  const nodes = st.nodes;
  const oIdx = nodes.indexOf(opener.node);
  const cIdx = nodes.indexOf(closer.node);
  if (oIdx === -1 || cIdx === -1 || cIdx <= oIdx) return;
  // delimiters strictly between opener and closer are now inside the new
  // emphasis node and can no longer match a closer outside it
  for (let k = oIdx + 1; k < cIdx; k++) {
    const n = nodes[k];
    if (n[0] === 'delim') {
      const rec = st.nodeToDelim.get(n);
      if (rec) { rec.len = 0; rec.node = null; st.nodeToDelim.delete(n); }
    }
  }
  const children = nodes.slice(oIdx + 1, cIdx);
  const emNode = [use === 2 ? 'strong' : 'em', children];
  opener.len -= use;
  closer.len -= use;
  const repl = [];
  if (opener.len > 0) {
    const nn = ['delim', opener.ch, opener.len, opener.canOpen, opener.canClose];
    st.nodeToDelim.delete(opener.node);
    opener.node = nn;
    st.nodeToDelim.set(nn, opener);
    repl.push(nn);
  } else {
    st.nodeToDelim.delete(opener.node);
    opener.node = null;
  }
  repl.push(emNode);
  if (closer.len > 0) {
    const nn = ['delim', closer.ch, closer.len, closer.canOpen, closer.canClose];
    st.nodeToDelim.delete(closer.node);
    closer.node = nn;
    st.nodeToDelim.set(nn, closer);
    repl.push(nn);
  } else {
    st.nodeToDelim.delete(closer.node);
    closer.node = null;
  }
  nodes.splice(oIdx, cIdx - oIdx + 1, ...repl);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// marked's URL cleaning for href/src attributes: encodeURI, then turn the
// encoded `%` back into a literal `%` (so a literal % is never double-encoded).
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    const t = n[0];
    if (t === 't') out += escapeHtml(n[1]);
    else if (t === 'esc') out += escapeHtml(n[1]);
    else if (t === 'code') out += '<code>' + escapeHtmlEncode(n[1]) + '</code>';
    else if (t === 'br') out += '<br>';
    else if (t === 'html') out += n[1];
    else if (t === 'delim') out += escapeHtml(n[1].repeat(n[2]));
    else if (t === 'em') out += '<em>' + renderNodes(n[1]) + '</em>';
    else if (t === 'strong') out += '<strong>' + renderNodes(n[1]) + '</strong>';
    else if (t === 'del') out += '<del>' + renderNodes(n[1]) + '</del>';
    else if (t === 'link' || t === 'autolink') {
      out += '<a href="' + escapeHtml(cleanHref(n[1])) + '"';
      if (n[2] !== null && n[2] !== undefined) out += ' title="' + escapeHtml(n[2]) + '"';
      out += '>' + renderNodes(n[3]) + '</a>';
    } else if (t === 'img') {
      out += '<img src="' + escapeHtml(cleanHref(n[1])) + '" alt="' + escapeHtml(n[3]) + '"';
      if (n[2] !== null && n[2] !== undefined) out += ' title="' + escapeHtml(n[2]) + '"';
      out += '>';
    }
  }
  return out;
}

const TASK_RE = /^\[([ xX])\][ \t]+/;
function renderItemBlocks(blocks, tight, refs) {
  let out = '';
  for (const b of blocks) {
    if (b[0] === 'p' && tight) {
      out += inline(b[1], refs);
    } else {
      out += renderBlocks([b], refs);
    }
  }
  return out;
}

function renderList(b, refs) {
  const ordered = b[1], start = b[2], tight = b[4], items = b[5];
  let out = ordered ? (start !== 1 ? '<ol start="' + start + '">\n' : '<ol>\n') : '<ul>\n';
  for (const item of items) {
    out += '<li>';
    const blocks = item;
    let first = blocks[0];
    let task = null;
    if (first && first[0] === 'p') {
      const m = TASK_RE.exec(first[1]);
      if (m && first[1].slice(m[0].length).trim() !== '') {
        task = m[1] !== ' ';
        first = ['p', first[1].slice(m[0].length)];
      }
    }
    if (task !== null) {
      const checkbox = task
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      if (tight) {
        // tight: the checkbox is unshifted into the item's tokens (before
        // the first block, rendered as bare inline text)
        out += checkbox + ' ' + renderItemBlocks([first].concat(blocks.slice(1)), true, refs);
      } else if (first && first[0] === 'p') {
        // loose + first block is a paragraph: the checkbox goes INSIDE the
        // <p>, as its first inline token (marked unshifts it into the
        // paragraph's tokens)
        out += '<p>' + checkbox + ' ' + inline(first[1], refs) + '</p>\n' +
          renderItemBlocks(blocks.slice(1), false, refs);
      } else {
        // loose + first block is not a paragraph: the checkbox is its own <p>
        out += '<p>' + checkbox + ' </p>\n' + renderItemBlocks(blocks, false, refs);
      }
    } else {
      out += renderItemBlocks(blocks, tight, refs);
    }
    out += '</li>\n';
  }
  out += ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

function renderTable(b, refs) {
  const aligns = b[1], header = b[2], rows = b[3];
  let out = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < header.length; i++) {
    out += '<th' + (aligns[i] ? ' align="' + aligns[i] + '"' : '') + '>' +
      inline(header[i], refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (rows.length > 0) {
    out += '<tbody>';
    for (const row of rows) {
      out += '<tr>\n';
      for (let i = 0; i < header.length; i++) {
        const cell = i < row.length ? row[i] : '';
        out += '<td' + (aligns[i] ? ' align="' + aligns[i] + '"' : '') + '>' +
          inline(cell, refs) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) {
    const t = b[0];
    if (t === 'p') out += '<p>' + inline(b[1], refs) + '</p>\n';
    else if (t === 'h') out += '<h' + b[1] + '>' + inline(b[2], refs) + '</h' + b[1] + '>\n';
    else if (t === 'code') {
      const info = b[2] || '';
      const first = unescapeDest(info.split(/\s+/)[0]);
      out += first
        ? '<pre><code class="language-' + escapeHtml(first) + '">'
        : '<pre><code>';
      // marked's renderer: text ? text.replace(/\n$/, '') + '\n' : ''
      // (an empty fence renders with no newline inside)
      const ct = b[1] ? b[1].replace(/\n$/, '') + '\n' : '';
      out += escapeHtmlEncode(ct) + '</code></pre>\n';
    }
    else if (t === 'html') out += b[1];
    else if (t === 'hr') out += '<hr>\n';
    else if (t === 'quote') out += '<blockquote>\n' + renderBlocks(b[1], refs) + '</blockquote>\n';
    else if (t === 'list') out += renderList(b, refs);
    else if (t === 'table') out += renderTable(b, refs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point: parse() is defined at the top of this file; it normalizes the
// input, splits it into lines, parses blocks, and renders them to HTML.
// ---------------------------------------------------------------------------
