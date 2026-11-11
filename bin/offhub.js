#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listRepos, makeGql } from '../src/github.js';
import { build, buildRoot, mirror, sync } from '../src/sync.js';

const HELP = `offhub - archive GitHub repositories as searchable offline websites

Usage:  offhub <owner>/<repo> [options]     one repository
        offhub <owner> [options]            every repository of a user or organization (no forks)
        offhub <a>/<b> <c>/<d> ... [options]  several at once

  -o, --out <dir>    output folder. One repository: the archive itself
                     (default ./<repo>-archive). Several: a folder holding
                     <owner>/<repo>/ archives and a start page (default ./github-archive)
      --limit <n>    only the n most recently updated items per kind (a sample)
      --no-images    do not download images
      --no-git       do not mirror the code and wiki with git
      --rebuild      only re-render pages from existing archives, no network
  -h, --help         show this help

Run it again on the same folder to fetch only what changed.
The token is read from GITHUB_TOKEN, GH_TOKEN or "gh auth token".`;

function findToken() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

async function main() {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      limit: { type: 'string' },
      'no-images': { type: 'boolean' },
      'no-git': { type: 'boolean' },
      rebuild: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (o.help || !positionals.length) { console.log(HELP); return o.help ? 0 : 1; }
  const limit = o.limit === undefined ? undefined : Number(o.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit needs a positive whole number.');

  const token = o.rebuild ? '' : findToken();
  if (!o.rebuild && !token) throw new Error('No GitHub token found. Set GITHUB_TOKEN, or install the GitHub CLI and run "gh auth login".');
  const gql = o.rebuild ? null : makeGql(token);

  const targets = [];
  let many = positionals.length > 1;
  for (const arg of positionals) {
    const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)(?:\/([\w.-]+?))?(?:\.git)?\/?$/.exec(arg);
    if (!m) throw new Error(`"${arg}" is not an <owner>/<repo> or <owner> name.`);
    const [, owner, name] = m;
    if (name) { targets.push({ owner, name }); continue; }
    if (o.rebuild) throw new Error('--rebuild needs <owner>/<repo> names.');
    many = true;
    for (const repo of await listRepos(gql, owner)) targets.push({ owner, name: repo });
  }

  const root = resolve(o.out ?? (many ? 'github-archive' : `${targets[0].name}-archive`));
  let failed = 0;
  for (const { owner, name } of targets) {
    const out = many ? join(root, owner, name) : root;
    if (many) console.log(`\n== ${owner}/${name}`);
    try {
      if (o.rebuild) { console.log(`Rebuilt ${build(out, `${owner}/${name}`)} pages in ${out}`); continue; }
      await sync({ owner, name, out, limit, images: !o['no-images'], gql });
      if (!o['no-git']) mirror({ owner, name, out, token });
    } catch (e) {
      if (!many) throw e;
      failed++; // one broken repository must not stop the backup of the others
      console.error(`offhub: ${owner}/${name} failed: ${e.message}`);
    }
  }
  if (many) console.log(`\n${buildRoot(root)} archives listed in ${join(root, 'index.html')}`);
  return failed ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, e => { console.error(`offhub: ${e.message}`); process.exitCode = 1; });
