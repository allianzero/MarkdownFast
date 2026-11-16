# BUILD_LOG — MarkdownFast (markdown-render-speed-02)

Entry for the make.fun bounty **markdown-render-speed-02** ("Make Markdown
rendering faster", $250). A dependency-free ES module `parse.js` whose
`parse(markdown)` returns exactly the HTML that marked 18.1.3's
`marked.parse` returns with default options, plus `main.ts`, the harness
driver that reads every case from `/input/cases.json` and writes
`/output/html.json`.

## What was built

The entry is a from-scratch rewrite of a marked-compatible parser in a
single file (`parse.js`, ~103 KB), written in this recorded session:

- **Block parser**: ATX/setext headings, thematic breaks, indented and
  fenced code, HTML blocks (types 1–7), blockquotes (lazy lines, fences,
  setext), lists (tight/loose, task checkboxes, nested, lazy
  continuations), GFM tables, link reference definitions, paragraphs.
- **Inline parser**: code spans, emphasis/strong (delimiter stack),
  strikethrough (scan-forward del), links/images (inline, full/collapsed/
  shortcut references), angle and extended autolinks (www/http/mailto/
  email, with marked's `_backpedal` URL trimming), HTML tags, entities
  (numeric references only, as marked does), hard/soft breaks.
- **Fidelity work** (all verified against the vendored marked 18.1.3):
  HTML block type 6 tag rules, fenced-code indent compensation
  (per-character, backtick fences only), table rows without `|` and
  tab-only rows, list looseness from space tokens (a blank line inside a
  nested list does not loosen the outer list), lazy setext continuations,
  emphasis closers at range boundaries, autolinks as a distinct node type
  (not gated by `inLink`), `noUrl` propagation into nested del content,
  escaped tildes in del, setext-vs-table precedence, and the loose
  code-span rule for link labels.

## Score

Practice set (`practice/input/cases.json`, 720 cases: 680 CommonMark/GFM
spec examples + 40 generated docs), via `/tmp/diffcheck.mjs`:

- Draft (previous builder, unwitnessed): 551/720
- Rewrite in this session: 651 → 669 → 677 → 680 → 684 → 687 → 689 →
  691 → 695 → 696 → 697 → 698 → 699 → 704 → **706/720**
- All 680 spec cases (cm-001..cm-652 + gfm) pass. Remaining 14 failures
  are all in generated docs and all emphasis edge cases where marked's
  opener-driven `emStrong` (delimTotal / rules 9–10, opener scans forward
  and recurses into the matched span) differs from the CommonMark
  delimiter-stack algorithm used here.

## Fixes in the final stretch (704 → 706)

- **Document-level `inLink` (doc-06 fixed).** Marked's `tag` tokenizer
  sets lexer `state.inLink` on an inline start `<a ...>` tag
  (`startATag` `/^<a /i` — `<a` followed by a space, so a bare `<a>`
  does not trigger it) and only a `</a>` (`endATag`) clears it; the
  state persists across blocks, so after an unclosed inline `<a>`
  tag no GFM url/email autolink may form anywhere later in the
  document. Implemented as a module-level `docInLink` (reset per
  document in `renderDoc`, set/cleared in `angleInline` when an HTML
  tag is tokenized), gating `extAutolink` and the text-run breaks.
  This fixed doc-06 (`https://example.com;` inside a list item after
  a fenced code block) and doc-03's autolink part.
- **Link-label backticks before `]` (doc-33 fixed).** Marked's
  `_inlineLabel` backtracks: a backtick run whose code-span closer
  would swallow the `]` cannot end the label, so the `` ``+(?=\]) ``
  alternative wins — but that alternative is TWO or more backticks
  (`` ``+ `` = a backtick followed by one or more), so only a run of
  length >= 2 immediately before `]` is literal; a single backtick
  there is a code-span opener with no closer and the label cannot
  match (`[foo`](/uri)` is no link, while `[foo``](/uri)` links).
  `findLinkTextEnd` now checks the `]`-after-run condition first and
  only for runs of length >= 2. This fixed doc-33's huge-label bug
  (`[less `` a ` b ``](./docs/value.md)` was swallowing the `]` and
  linking to the next paragraph's URL).
- **Opener-driven emphasis rewrite attempted and REVERTED.** A
  direct port of marked's `emStrong` (opener scans forward with
  `delimTotal`) fixed the targeted cases (`**public as *so*other*
  option html**`, `*browser in so **change**in*`, `**a *b*c**`) but
  dropped the score to 640/720: it does not re-tokenize the matched
  span's inner content, so nested emphasis inside an outer em/strong
  never forms (e.g. `*a **b** c*` lost the inner `<strong>`), and it
  broke many spec cases. The 704/720 version was restored from
  backup (`/tmp/parse-704.js`) and the two fixes above were applied
  on top of it instead. A correct opener-driven port would need the
  recursive inner tokenization marked does
  (`lexer.inlineTokens(text)` on the matched span) — left as known
  future work; the remaining 14 docs all hinge on it.

## Verification

- `node --check parse.js` and `node --check main.ts` pass.
- `node /tmp/diffcheck.mjs` → **706/720** (all 680 spec cases pass).
- `grade-local` (official, `--driver process --worktree`):
  `cases_passed 706 / cases_total 720`; `eligible ranked yes, prize
  no, efficiency no (failed_tests, no_transcripts,
  coverage_below_gate, cost_unpriced)` — expected for a local
  process-driver run without transcripts; the server grades with
  docker + the recording. `L1 regrade reproduced byte for byte`.
- Speed (practice set, 720 cases, this machine): parse.js 1424 ms vs
  marked 2029 ms — ~1.4x faster than the baseline. Only entries
  passing all 720 can be timed/ranked, so this does not earn a prize
  by itself; the 14 emphasis docs are the blocker.
- No network references in the entry; no dependencies.
- Secret scan clean: no API keys, passwords, emails, or phone numbers
  in the shipped files.
- Repo size is well under the 1 MiB cap (~136 KB total: parse.js
  ~103 KB + main.ts + README + LICENSE + owner.json).

## Notes for the submit step

- Recording id: `01a1e223-070e-73cf-9846-9d0bc2969f2e` (started 2026-11-16
  09:15 WIB; the lead stops it, pushes, and submits with `--recording`).
- Do NOT push or submit from this session; the lead owns that step.
- The kit's practice set is intentionally kept OUT of the repo (1 MiB cap).
- Deadline: entries close 17 Nov 2026 03:30 WIB.
