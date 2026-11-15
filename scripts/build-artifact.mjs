#!/usr/bin/env node
/*
 * Builds the single-page version used when the app is published as a Claude artifact.
 *
 * The artifact host wraps the page in its own <html>/<head>/<body>, so this takes the
 * marked regions of index.html, inlines the stylesheet and the app scripts, and leaves
 * the chart library as a separate file published next to the page.
 *
 *   node scripts/build-artifact.mjs [outDir]     (default: dist)
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || join(root, 'dist'));
const read = (p) => readFileSync(join(root, p), 'utf8');

function region(html, name) {
  const m = html.match(new RegExp(`<!-- page:${name} -->([\\s\\S]*?)<!-- /page:${name} -->`));
  if (!m) throw new Error(`index.html is missing the page:${name} markers`);
  return m[1].trim();
}

const html = read('index.html');
const head = region(html, 'head').split('\n').filter((l) => !/rel="preconnect"/.test(l)).join('\n');
let body = region(html, 'body');

body = body.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, src) => {
  const code = read(src);
  if (/<\/script/i.test(code)) throw new Error(`${src} contains a closing script tag and cannot be inlined`);
  return `<script>\n${code}\n</script>`;
});

const page = `${head}\n<style>\n${read('css/app.css')}\n</style>\n${body}\n`;

mkdirSync(join(outDir, 'vendor'), { recursive: true });
writeFileSync(join(outDir, 'trade-forex.html'), page);
copyFileSync(join(root, 'vendor/chart.umd.min.js'), join(outDir, 'vendor/chart.umd.min.js'));
console.log(`built ${join(outDir, 'trade-forex.html')} (${(Buffer.byteLength(page) / 1024).toFixed(0)} KB)`);
