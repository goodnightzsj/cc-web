#!/usr/bin/env node
// Compute sha256[:10] for app.js / style.css, copy to hashed filenames,
// rewrite public/index.html references. Idempotent: cleans previous hashed
// outputs of each asset before writing the new one.
//
// Usage: node scripts/build-assets.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ASSETS = [
  { file: 'app.js', tag: 'script-app' },
  { file: 'style.css', tag: 'link-style' },
];

function shortHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

function cleanOldHashed(base, ext, keepHash) {
  const re = new RegExp(`^${base}\\.[0-9a-f]{10}\\.${ext}$`);
  for (const f of fs.readdirSync(PUBLIC_DIR)) {
    if (re.test(f) && !f.includes(`.${keepHash}.`)) {
      fs.unlinkSync(path.join(PUBLIC_DIR, f));
      console.log(`  removed stale ${f}`);
    }
  }
}

function rewriteIndex(replacements) {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  for (const { from, to } of replacements) {
    // match exact unquoted/quoted src or href filename references
    const re = new RegExp(`(href|src)="${from.replace(/[.]/g, '\\.')}"`, 'g');
    html = html.replace(re, `$1="${to}"`);
    // also match the case where it's already a hashed version of the same base
    const baseRe = new RegExp(`(href|src)="${from.replace(/\.[^.]+$/, '').replace(/[.]/g, '\\.')}\\.[0-9a-f]{10}\\.${from.split('.').pop()}"`, 'g');
    html = html.replace(baseRe, `$1="${to}"`);
  }
  fs.writeFileSync(indexPath, html);
}

const replacements = [];
for (const { file } of ASSETS) {
  const fullPath = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(fullPath)) {
    console.warn(`skip: ${file} not found`);
    continue;
  }
  const buf = fs.readFileSync(fullPath);
  const hash = shortHash(buf);
  const dotIdx = file.lastIndexOf('.');
  const base = file.slice(0, dotIdx);
  const ext = file.slice(dotIdx + 1);
  const hashed = `${base}.${hash}.${ext}`;
  cleanOldHashed(base, ext, hash);
  const hashedPath = path.join(PUBLIC_DIR, hashed);
  if (!fs.existsSync(hashedPath)) {
    fs.copyFileSync(fullPath, hashedPath);
    console.log(`  wrote ${hashed} (${buf.length} bytes)`);
  } else {
    console.log(`  reuse ${hashed}`);
  }
  replacements.push({ from: file, to: hashed });
}

rewriteIndex(replacements);
console.log(`✓ index.html updated with ${replacements.length} hashed asset(s)`);
