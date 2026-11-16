# MarkdownFast

[![competition](https://make.fun/bounty/markdown-render-speed-02)](https://make.fun/bounty/markdown-render-speed-02)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![parser](https://img.shields.io/badge/parser-marked--compatible-green.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free JavaScript module whose `parse(markdown)` returns exactly
the HTML [marked 18.1.3](https://github.com/markedjs/marked) renders with its
default options (GFM on).

```js
import { parse } from './parse.js';
parse('# Hello\n\nHello *world*.');
// '<h1>Hello</h1>\n<p>Hello <em>world</em>.</p>\n'
```

## Files

- `parse.js` — the renderer (ES module, no dependencies).
- `main.ts` — the harness driver: reads `/input/cases.json`, writes
  `/output/html.json`.

## Design

- Block parser: container stack (blockquote / list / item) with column-based
  tab handling, lazy continuation, link reference definitions, GFM tables.
- Inline parser: delimiter stack for emphasis / strong / strikethrough,
  links (inline, full / collapsed / shortcut reference), images, code spans,
  autolinks (bracketed and extended), entities, backslash escapes.
- Renderer: HTML5 (no slash on void tags).
