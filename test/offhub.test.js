import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchKind, listRepos, normalize } from '../src/github.js';
import { plainText, renderItem } from '../src/render.js';
import { allowedImage, buildRoot, sync } from '../src/sync.js';

const node = (number, updatedAt, extra = {}) => ({
  id: `ID${number}`, number, title: `Item ${number}`, url: `https://github.com/o/r/issues/${number}`,
  createdAt: '2026-01-01T00:00:00Z', updatedAt, bodyHTML: `<p>body ${number}</p>`, author: { login: 'ann' },
  labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
  comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  state: 'OPEN', closedAt: null, ...extra,
});

// A fake GitHub: serves `store[field]` in pages of 2, newest first.
function fakeGql(store, calls = []) {
  return async (query, vars) => {
    calls.push(vars);
    if (vars.id) return { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ author: null, createdAt: '2026-01-03T00:00:00Z', bodyHTML: '<p>second page</p>', url: 'u2' }] } } };
    const field = /(issues|pullRequests|discussions|releases)\(first/.exec(query)[1];
    const all = store[field] ?? [];
    const start = Number(vars.after ?? 0), end = start + 2;
    return { repository: { [field]: { pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }, nodes: all.slice(start, end) } } };
  };
}

async function collect(gen) { const out = []; for await (const x of gen) out.push(x); return out; }

test('fetchKind pages through everything and stops at the since marker', async () => {
  const store = { issues: [node(3, '2026-03-01T00:00:00Z'), node(2, '2026-02-01T00:00:00Z'), node(1, '2026-01-01T00:00:00Z')] };
  assert.deepEqual((await collect(fetchKind(fakeGql(store), 'o', 'r', 'issues'))).map(i => i.number), [3, 2, 1]);
  const incremental = await collect(fetchKind(fakeGql(store), 'o', 'r', 'issues', { since: '2026-02-01T00:00:00Z' }));
  assert.deepEqual(incremental.map(i => i.number), [3, 2]);
  assert.equal((await collect(fetchKind(fakeGql(store), 'o', 'r', 'issues', { limit: 1 }))).length, 1);
});

test('fetchKind follows comment pagination and names deleted authors ghost', async () => {
  const first = { author: { login: 'bob' }, createdAt: '2026-01-02T00:00:00Z', bodyHTML: '<p>first page</p>', url: 'u1' };
  const store = { issues: [node(1, '2026-01-05T00:00:00Z', { comments: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [first] } })] };
  const [item] = await collect(fetchKind(fakeGql(store), 'o', 'r', 'issues'));
  assert.deepEqual(item.comments.map(c => c.author), ['bob', 'ghost']);
});

test('fetchKind reports a missing repository clearly', async () => {
  await assert.rejects(collect(fetchKind(async () => ({ repository: null }), 'o', 'r', 'issues')), /not found/);
});

test('normalize merges pull request reviews into the timeline in date order', () => {
  const c = (createdAt, bodyHTML) => ({ author: { login: 'rev' }, createdAt, bodyHTML, url: 'u' });
  const pr = normalize('pulls', node(7, '2026-01-09T00:00:00Z', {
    state: 'MERGED', baseRefName: 'main', headRefName: 'fix', additions: 3, deletions: 1, changedFiles: 2, isDraft: false, mergedAt: '2026-01-09T00:00:00Z',
    comments: { pageInfo: { hasNextPage: false }, nodes: [c('2026-01-04T00:00:00Z', '<p>late</p>')] },
    reviews: { totalCount: 60, nodes: [
      { ...c('2026-01-02T00:00:00Z', ''), state: 'COMMENTED', comments: { totalCount: 0, nodes: [] } },
      { ...c('2026-01-03T00:00:00Z', '<p>lgtm</p>'), state: 'APPROVED', comments: { totalCount: 1, nodes: [{ ...c('2026-01-03T00:00:00Z', '<p>nit</p>'), path: 'a.js', diffHunk: '@@ -1 +1 @@' }] } },
    ] },
  }));
  assert.deepEqual(pr.comments.map(x => x.review ?? 'comment'), ['APPROVED', 'comment']);
  assert.equal(pr.comments[0].threads[0].path, 'a.js');
  assert.equal(pr.truncated, true); // 60 reviews exist, 2 were fetched
  assert.equal(pr.meta.base, 'main');
});

test('renderItem escapes everything that is not a GitHub-rendered body', () => {
  const it = normalize('issues', node(1, '2026-01-01T00:00:00Z', { title: '<script>alert(1)</script>', author: { login: 'a"b' }, labels: { nodes: [{ name: '<b>x', color: 'red;}' }] } }));
  const html = renderItem(it, 'o/<r>');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('a&quot;b') && html.includes('&lt;b&gt;x') && html.includes('o/&lt;r&gt;'));
  assert.ok(!html.includes('red;}')); // invalid label colour is dropped
  assert.ok(html.includes('<p>body 1</p>'));
});

const release = (number, extra = {}) => ({
  id: `R${number}`, number, title: null, tagName: `v${number}.0`, url: 'https://github.com/o/r/releases/tag/v1',
  createdAt: `2026-0${number}-01T00:00:00Z`, updatedAt: `2026-0${number}-01T00:00:00Z`, publishedAt: `2026-0${number}-02T00:00:00Z`,
  bodyHTML: '<p>notes</p>', author: null, isDraft: false, isPrerelease: false,
  releaseAssets: { totalCount: 1, nodes: [{ name: 'tool<1>.zip', size: 3 * 1048576, downloadUrl: 'https://github.com/o/r/releases/download/v1/tool.zip' }] },
  ...extra,
});

test('releases use the tag as title, list their files and ignore the since marker', async () => {
  const store = { releases: [release(2, { isPrerelease: true }), release(1)] };
  const items = await collect(fetchKind(fakeGql(store), 'o', 'r', 'releases', { since: '2026-09-01T00:00:00Z' }));
  assert.deepEqual(items.map(i => `${i.title}/${i.state}`), ['v2.0/PRERELEASE', 'v1.0/RELEASED']);
  const html = renderItem(items[1], 'o/r');
  assert.ok(html.includes('Release v1.0') && html.includes('tool&lt;1&gt;.zip') && html.includes('3.0 MB'));
  assert.ok(html.includes('published this on 2026-01-02'));
});

test('listRepos pages through an account and leaves forks out', async () => {
  const pages = [
    { pageInfo: { hasNextPage: true, endCursor: 'x' }, nodes: [{ name: 'a', isFork: false }, { name: 'fork', isFork: true }] },
    { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'b', isFork: false }] },
  ];
  assert.deepEqual(await listRepos(async (q, v) => ({ repositoryOwner: { repositories: pages[v.after ? 1 : 0] } }), 'o'), ['a', 'b']);
  await assert.rejects(listRepos(async () => ({ repositoryOwner: null }), 'nobody'), /not found/);
});

test('buildRoot lists every archive found on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'offhub-root-'));
  try {
    const store = { issues: [node(1, '2026-01-01T00:00:00Z')] };
    for (const name of ['one', 'two']) await sync({ owner: 'o', name, out: join(root, 'o', name), gql: fakeGql(store), images: false, log: () => {} });
    assert.equal(buildRoot(root), 2);
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    assert.ok(html.includes('href="o/one/index.html"') && html.includes('href="o/two/index.html"') && html.includes('1 items'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plainText strips tags and lowercases', () => {
  assert.equal(plainText({ html: '<p>Hello <b>World</b></p>', comments: [{ html: '<p>More</p>', replies: [{ html: 'Deep' }] }] }), 'hello world more deep');
});

test('allowedImage only accepts https GitHub hosts', () => {
  assert.ok(allowedImage('https://camo.githubusercontent.com/abc'));
  assert.ok(allowedImage('https://github.com/user-attachments/assets/1'));
  assert.ok(!allowedImage('http://github.com/x.png'));
  assert.ok(!allowedImage('https://evil.example/x.png'));
  assert.ok(!allowedImage('https://githubusercontent.com.evil.example/x.png'));
  assert.ok(!allowedImage('not a url'));
});

test('sync writes pages, an index and local images, then only refetches what changed', async () => {
  const out = mkdtempSync(join(tmpdir(), 'offhub-'));
  try {
    const img = '<p><img alt="a" src="https://camo.githubusercontent.com/pic?x=1&amp;y=2"> <img src="https://evil.example/t.png"></p>';
    const store = {
      issues: [node(2, '2026-02-01T00:00:00Z', { bodyHTML: img }), node(1, '2026-01-01T00:00:00Z')],
      discussions: [node(5, '2026-01-07T00:00:00Z', { state: undefined, closed: true, category: { name: 'Q&A' } })],
    };
    const fetched = [];
    const fetchImpl = async url => { fetched.push(url); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }); };
    const opts = { owner: 'o', name: 'r', out, fetchImpl, log: () => {} };

    assert.equal(await sync({ ...opts, gql: fakeGql(store) }), 3);
    const page = readFileSync(join(out, 'issues', '2.html'), 'utf8');
    const local = /src="\.\.\/assets\/([0-9a-f]{16}\.png)"/.exec(page);
    assert.ok(local && existsSync(join(out, 'assets', local[1])));
    assert.deepEqual(fetched, ['https://camo.githubusercontent.com/pic?x=1&y=2']); // the foreign image was not requested
    assert.ok(page.includes('https://evil.example/t.png'));
    assert.ok(readFileSync(join(out, 'discussions', '5.html'), 'utf8').includes('category: Q&amp;A'));
    const index = JSON.parse(readFileSync(join(out, 'index-data.js'), 'utf8').replace(/^window\.OFFHUB=|;\s*$/g, ''));
    assert.deepEqual(index.items.map(i => `${i.k}/${i.n}/${i.s}`), ['issues/2/OPEN', 'discussions/5/CLOSED', 'issues/1/OPEN']);
    assert.ok(existsSync(join(out, 'index.html')) && existsSync(join(out, 'viewer.js')) && existsSync(join(out, 'fulltext.js')));

    // Second run: one new issue. Old ones must stay in the archive without being fetched again.
    store.issues.unshift(node(3, '2026-03-01T00:00:00Z'));
    // (The item sitting exactly on the marker is fetched again on purpose.)
    const logs = [];
    assert.equal(await sync({ ...opts, gql: fakeGql(store), log: l => logs.push(l) }), 4);
    assert.ok(logs.includes('issues: 2 new or updated'), logs.join('|')); // 3 and 2, not 1
    assert.equal(fetched.length, 1); // the image was reused, not downloaded again
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
