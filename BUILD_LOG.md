# MarkdownFast — build log (resubmit #4)

Workdir `~/workspace/makefun/markdown-resubmit`, repo
`https://github.com/allianzero/MarkdownFast`. Kit level 18. Deadline
2026-11-17 03:30 WIB.

## Result

- Local test harness (`node test-parse.mjs` over the kit's 720 practice
  cases): **680/680 spec cases pass** (cm-001..cm-652 + all 28 GFM cases).
  Total 680/720; the 40 generated documents (doc-01..doc-40) are a bonus
  and were not chased, per the brief.
- `parse.js` is a dependency-free ES module written from scratch in this
  session, in small chunks. No code was copied in from any earlier build.

## Architecture

- Block parser: container stack (blockquote / list / item), column-based tab
  handling, lazy continuation, blank-line handling, paragraph, setext,
  table, fenced and indented code, HTML blocks (types 1–7), ATX, thematic
  breaks. Link reference definitions are stripped from paragraphs at
  finalize time; a paragraph whose 2nd line is a table delimiter becomes a
  table.
- Inline parser: delimiter stack for emphasis/strong, plus strikethrough
  (`~` / `~~` → `<del>`), links (inline, full/collapsed/shortcut reference),
  images, bracket and extended autolinks, code spans, entities, backslash
  escapes.
- Renderer: HTML5 (no slash on void tags).

## Notable behaviours

- Entities: named entities pass through verbatim; numeric references are
  decoded (1–7 decimal digits, 1–6 hex digits; 0 / surrogate / >0x10FFFF
  become U+FFFD).
- Loose lists: a blank line inside a blockquote only loosens the list when
  the next block stays in the same item.
- Emphasis: closers processed in document order; an opener inside an
  already-formed emphasis cannot match a closer outside it; odd-match rule
  for em only.
- Links: empty destinations valid; `"` in a destination is percent-encoded
  (`%22`); label matching without backslash resolution, folding ß→ss;
  nested `[` in labels rejected; a failed inline link falls back to a
  shortcut reference; an image may contain a link (alt = plain text).
- Tables: `<tbody>` has no newline after it and is omitted when empty;
  `\|` becomes a literal `|` in cells; delimiter row must match the header
  cell count.
- GFM: task-list checkboxes, strikethrough (`~`/`~~`; runs of 3+ tildes are
  literal), extended autolinks with balanced-paren and entity trimming,
  `mailto:`/`xmpp:` scheme autolinks, email trailing `-`/`_` rejection.
- Hard breaks strip the next line's leading spaces.
- Lazy lines: list-item padding is compared relative to the content start
  on the current line (absolute columns break when blockquote markers
  shift); an indented-code block never opens for a lazy line.
- Loose lists: `lastLineBlank` propagates up only for truly empty lines and
  is reset when a block gains content after the blank line.
- Emphasis: no `openers_bottom` barrier (it blocked valid matches such as
  `*foo**bar*`); leftover delimiters inside a formed emphasis become
  literal text (recursive sweep).
- Links: an inline link needs `(` immediately after `]`; a failed
  full/collapsed reference does not fall back to a shortcut; a `]` closes
  the innermost bracket even when it is inactive, so nested images resolve
  to the outermost one.
- HTML tags: a closing tag takes no attributes; an attribute value must be
  preceded by whitespace; a run of 3+ tildes is not strikethrough.
- Fenced code drops exactly one trailing blank line; an HTML block open at
  EOF keeps its trailing newline only when the source ends with one.

## Files

- `parse.js` — the renderer.
- `main.ts` — the harness driver (reads `/input/cases.json`, writes
  `/output/html.json`).
- `README.md`, `LICENSE` (MIT), `BUILD_LOG.md`, `.makefun/owner.json`.
