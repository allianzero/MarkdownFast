// Driver for the markdown-render-speed-02 harness: reads every case from
// /input/cases.json (MAKEFUN_INPUT_DIR outside a container) and writes the
// HTML for each case, in the cases' order, to /output/html.json
// (MAKEFUN_OUTPUT_DIR outside a container). Each case is rendered alone by
// parse() from parse.js, a dependency-free drop-in for marked 18.1.3.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{ id: string; markdown: string }>;
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
