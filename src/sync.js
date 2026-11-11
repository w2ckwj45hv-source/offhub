// Orchestrates one run: fetch changed items, store them as JSON, download their
// images, then rebuild the HTML pages and the search index from the JSON.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKind, KIND_NAMES } from './github.js';
import { plainText, renderItem } from './render.js';

const STATIC = fileURLToPath(new URL('./static', import.meta.url));
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
const IMG = /<img\b[^>]*?\ssrc="([^"]+)"/g;
const MAX_IMAGE = 25 * 1024 * 1024;

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const dir = (...parts) => { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; };

// Only images GitHub itself serves are downloaded; anything else stays a link.
export function allowedImage(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'github.com' || hostname.endsWith('.githubusercontent.com'));
  } catch { return false; }
}

async function localizeImages(item, out, fetchImpl, have) {
  const assets = dir(out, 'assets');
  const fix = async html => {
    if (!html) return html;
    for (const raw of new Set([...html.matchAll(IMG)].map(m => m[1]))) {
      const url = raw.replaceAll('&amp;', '&');
      if (!allowedImage(url)) continue;
      // Private-repo image URLs carry a short-lived token in the query string,
      // so the file name is derived from the URL without it.
      const key = createHash('sha1').update(url.split('?')[0]).digest('hex').slice(0, 16);
      let file = have.get(key);
      if (!file) {
        try {
          const res = await fetchImpl(url);
          const ext = EXT[(res.headers.get('content-type') ?? '').split(';')[0].trim()];
          if (!res.ok || !ext) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > MAX_IMAGE) continue;
          file = `${key}.${ext}`;
          writeFileSync(join(assets, file), buf);
          have.set(key, file);
        } catch { continue; } // a failed download keeps the online link
      }
      html = html.replaceAll(`src="${raw}"`, `src="../assets/${file}"`);
    }
    return html;
  };
  item.html = await fix(item.html);
  for (const c of item.comments) {
    c.html = await fix(c.html);
    for (const r of c.replies ?? []) r.html = await fix(r.html);
    for (const t of c.threads ?? []) t.html = await fix(t.html);
  }
}

// Rebuilds every page and the index from data/. Needs no network, so it also
// serves to re-render an old archive with a newer offhub.
// shortcut: rewrites all pages on every run, fine up to tens of thousands of
// items; render only changed ones if that gets slow.
export function build(out, repo) {
  const items = [], text = {};
  for (const kind of KIND_NAMES) {
    const data = join(out, 'data', kind);
    if (!existsSync(data)) continue;
    const pages = dir(out, kind);
    for (const f of readdirSync(data)) {
      const it = JSON.parse(readFileSync(join(data, f), 'utf8'));
      writeFileSync(join(pages, `${it.number}.html`), renderItem(it, repo));
      items.push({ k: kind, n: it.number, t: it.title, s: it.state, a: it.author, u: it.updatedAt, l: it.labels.map(l => l.name), c: it.comments.length });
      text[`${kind}/${it.number}`] = plainText(it);
    }
  }
  items.sort((a, b) => (a.u < b.u ? 1 : a.u > b.u ? -1 : 0));
  const index = { repo, generated: new Date().toISOString(), items };
  writeFileSync(join(out, 'index-data.js'), `window.OFFHUB=${JSON.stringify(index)};\n`);
  writeFileSync(join(out, 'fulltext.js'), `window.OFFHUB_TEXT=${JSON.stringify(text)};\n`);
  cpSync(STATIC, out, { recursive: true });
  return items.length;
}

export async function sync({ owner, name, out, gql, limit, images = true, fetchImpl = fetch, log = console.log }) {
  dir(out);
  const stateFile = join(out, 'state.json');
  const state = readJson(stateFile, { since: {} });
  const have = new Map();
  if (images) for (const f of readdirSync(dir(out, 'assets'))) have.set(f.split('.')[0], f);

  for (const kind of KIND_NAMES) {
    const data = dir(out, 'data', kind);
    // A --limit run is a sample: it neither uses nor moves the incremental
    // marker, otherwise a later full run would skip everything older.
    const since = limit ? undefined : state.since[kind];
    let newest, n = 0;
    for await (const it of fetchKind(gql, owner, name, kind, { since, limit })) {
      newest ??= it.updatedAt;
      if (images) await localizeImages(it, out, fetchImpl, have);
      writeFileSync(join(data, `${it.number}.json`), JSON.stringify(it));
      if (++n % 100 === 0) log(`  ${kind}: ${n} ...`);
    }
    log(`${kind}: ${n} new or updated`);
    // Written only after the kind finished, so an interrupted run starts over
    // for that kind instead of leaving a gap.
    if (!limit && newest) { state.since[kind] = newest; writeFileSync(stateFile, JSON.stringify(state)); }
  }
  const total = build(out, `${owner}/${name}`);
  log(`Archive has ${total} items: ${join(out, 'index.html')}`);
  return total;
}

// Mirrors the code and the wiki with git. The token is passed through the
// environment so it is neither written into the mirror's config nor visible
// in the process list.
export function mirror({ owner, name, out, token, log = console.log }) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
  for (const [label, suffix] of [['code', ''], ['wiki', '.wiki']]) {
    const target = join(out, `${label}.git`);
    const args = existsSync(target)
      ? ['-C', target, 'remote', 'update', '--prune']
      : ['clone', '--quiet', '--mirror', `https://github.com/${owner}/${name}${suffix}.git`, target];
    try {
      execFileSync('git', args, { env, stdio: 'pipe' });
      log(`${label}: mirrored to ${target}`);
    } catch (e) {
      if (label === 'wiki') log('wiki: none found');
      else log(`code: git mirror failed (${String(e.stderr || e.message).trim().split('\n').pop()})`);
    }
  }
}
