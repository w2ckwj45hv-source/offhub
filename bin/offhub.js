#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { makeGql } from '../src/github.js';
import { build, mirror, sync } from '../src/sync.js';

const HELP = `offhub - archive a GitHub repository as a searchable offline website

Usage:  offhub <owner>/<repo> [options]

  -o, --out <dir>    output folder (default: ./<repo>-archive)
      --limit <n>    only the n most recently updated items per kind (a sample)
      --no-images    do not download images
      --no-git       do not mirror the code and wiki with git
      --rebuild      only re-render pages from an existing archive, no network
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
  if (o.help || positionals.length !== 1) { console.log(HELP); return o.help ? 0 : 1; }

  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(positionals[0]);
  if (!m) throw new Error(`"${positionals[0]}" is not an <owner>/<repo> name.`);
  const [, owner, name] = m;
  const limit = o.limit === undefined ? undefined : Number(o.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit needs a positive whole number.');
  const out = resolve(o.out ?? `${name}-archive`);

  if (o.rebuild) { console.log(`Rebuilt ${build(out, `${owner}/${name}`)} pages in ${out}`); return 0; }

  const token = findToken();
  if (!token) throw new Error('No GitHub token found. Set GITHUB_TOKEN, or install the GitHub CLI and run "gh auth login".');
  await sync({ owner, name, out, limit, images: !o['no-images'], gql: makeGql(token) });
  if (!o['no-git']) mirror({ owner, name, out, token });
  return 0;
}

main().then(code => { process.exitCode = code; }, e => { console.error(`offhub: ${e.message}`); process.exitCode = 1; });
