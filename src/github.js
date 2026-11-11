// GitHub GraphQL access. Every kind is listed newest-updated first, so an
// incremental run can stop at the first item it has already archived.
const API = 'https://api.github.com/graphql';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function makeGql(token, { fetchImpl = fetch, log = console.error } = {}) {
  return async function gql(query, variables) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'offhub' },
        body: JSON.stringify({ query, variables }),
      });
      const body = await res.text();
      let json;
      try { json = JSON.parse(body); } catch { /* non-JSON error page, handled below */ }

      if (res.status === 401) throw new Error('GitHub rejected the token (HTTP 401). Check GITHUB_TOKEN or run "gh auth login".');
      const limited = res.status === 429
        || (res.status === 403 && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0'))
        || json?.errors?.some(e => e.type === 'RATE_LIMITED');
      if (limited && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const untilReset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
        const wait = Math.max(retryAfter || untilReset || 60_000, 1000) + 1000;
        log(`Rate limited by GitHub, waiting ${Math.ceil(wait / 1000)}s ...`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < 3) { await sleep(2000 * 2 ** attempt); continue; }
      if (!res.ok || !json) throw new Error(`GitHub API error ${res.status}: ${body.slice(0, 300)}`);
      if (json.errors?.length) {
        if (!json.data) throw new Error(`GitHub API error: ${json.errors[0].message}`);
        log(`Warning from GitHub: ${json.errors[0].message}`);
      }
      return json.data;
    }
  };
}

const C = 'author{login} createdAt bodyHTML url';
const PAGE = 'pageInfo{hasNextPage endCursor}';
const THREAD = 'number title bodyHTML labels(first:30){nodes{name color}}';
const KINDS = {
  issues: {
    field: 'issues', type: 'Issue', page: 50, order: 'UPDATED_AT',
    comment: C,
    fields: `${THREAD} state closedAt`,
  },
  pulls: {
    field: 'pullRequests', type: 'PullRequest', page: 20, order: 'UPDATED_AT',
    comment: C,
    fields: `${THREAD} state closedAt mergedAt isDraft baseRefName headRefName additions deletions changedFiles
      reviews(first:50){totalCount nodes{${C} state comments(first:30){totalCount nodes{${C} path diffHunk}}}}`,
  },
  discussions: {
    field: 'discussions', type: 'Discussion', page: 30, order: 'UPDATED_AT',
    comment: `${C} isAnswer replies(first:50){totalCount nodes{${C}}}`,
    fields: `${THREAD} closed closedAt category{name}`,
  },
  // Releases cannot be listed by update time, so every run fetches all of them.
  releases: {
    field: 'releases', type: 'Release', page: 50, order: 'CREATED_AT',
    comment: null,
    fields: `number: databaseId title: name tagName bodyHTML: descriptionHTML isDraft isPrerelease publishedAt
      releaseAssets(first:100){totalCount nodes{name size downloadUrl}}`,
  },
};
export const KIND_NAMES = Object.keys(KINDS);

const listQuery = k => `query($owner:String!,$name:String!,$n:Int!,$after:String){
  repository(owner:$owner,name:$name){
    ${k.field}(first:$n,after:$after,orderBy:{field:${k.order},direction:DESC}){
      ${PAGE}
      nodes{ id url createdAt updatedAt author{login}
        ${k.comment ? `comments(first:100){${PAGE} nodes{${k.comment}}}` : ''}
        ${k.fields} }
    }
  }
}`;
const moreCommentsQuery = k => `query($id:ID!,$after:String){
  node(id:$id){ ... on ${k.type}{ comments(first:100,after:$after){${PAGE} nodes{${k.comment}}} } }
}`;

const who = n => n?.author?.login ?? 'ghost';
const entry = c => ({ author: who(c), createdAt: c.createdAt, html: c.bodyHTML, url: c.url });

// One common shape for issues, pull requests and discussions.
export function normalize(kind, n) {
  let truncated = false;
  const comments = (n.comments?.nodes ?? []).filter(Boolean).map(c => {
    const out = entry(c);
    if (c.isAnswer) out.answer = true;
    if (c.replies) {
      out.replies = c.replies.nodes.map(entry);
      truncated ||= c.replies.totalCount > c.replies.nodes.length;
    }
    return out;
  });
  if (n.reviews) {
    // shortcut: only the first 50 reviews / 30 comments per review / 50 replies
    // per discussion comment are fetched; the page says so when that cuts
    // something off. Paginate these if large reviews matter to users.
    truncated ||= n.reviews.totalCount > n.reviews.nodes.length;
    for (const r of n.reviews.nodes) {
      truncated ||= r.comments.totalCount > r.comments.nodes.length;
      if (r.state === 'COMMENTED' && !r.bodyHTML && !r.comments.nodes.length) continue;
      comments.push({
        ...entry(r),
        review: r.state,
        threads: r.comments.nodes.map(t => ({ ...entry(t), path: t.path, diffHunk: t.diffHunk })),
      });
    }
    comments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  const meta = {};
  if (kind === 'pulls') Object.assign(meta, {
    base: n.baseRefName, head: n.headRefName, additions: n.additions, deletions: n.deletions,
    changedFiles: n.changedFiles, draft: n.isDraft, mergedAt: n.mergedAt,
  });
  if (n.category) meta.category = n.category.name;
  let state = n.state ?? (n.closed ? 'CLOSED' : 'OPEN');
  if (kind === 'releases') {
    state = n.isDraft ? 'DRAFT' : n.isPrerelease ? 'PRERELEASE' : 'RELEASED';
    truncated ||= n.releaseAssets.totalCount > n.releaseAssets.nodes.length;
    Object.assign(meta, {
      tag: n.tagName, publishedAt: n.publishedAt,
      assets: n.releaseAssets.nodes.map(a => ({ name: a.name, size: a.size, url: a.downloadUrl })),
    });
  }
  return {
    kind, number: n.number, title: n.title || n.tagName, url: n.url, state,
    author: who(n), createdAt: n.createdAt, updatedAt: n.updatedAt, closedAt: n.closedAt ?? null,
    labels: (n.labels?.nodes ?? []).map(l => ({ name: l.name, color: l.color })),
    html: n.bodyHTML, comments, truncated, meta,
  };
}

// Names of all repositories an account owns, forks left out.
export async function listRepos(gql, owner) {
  const query = `query($owner:String!,$after:String){
    repositoryOwner(login:$owner){
      repositories(first:100,after:$after,ownerAffiliations:OWNER,orderBy:{field:NAME,direction:ASC}){
        ${PAGE} nodes{name isFork}
      }
    }
  }`;
  const names = [];
  for (let after = null; ;) {
    const data = await gql(query, { owner, after });
    if (!data.repositoryOwner) throw new Error(`GitHub user or organization "${owner}" not found.`);
    const conn = data.repositoryOwner.repositories;
    names.push(...conn.nodes.filter(r => r && !r.isFork).map(r => r.name));
    if (!conn.pageInfo.hasNextPage) return names;
    after = conn.pageInfo.endCursor;
  }
}

// Yields normalized items, newest-updated first. Stops at `since` (an
// updatedAt value from the previous run) or after `limit` items.
export async function* fetchKind(gql, owner, name, kind, { since, limit = Infinity } = {}) {
  const k = KINDS[kind];
  let after = null, count = 0;
  for (;;) {
    const data = await gql(listQuery(k), { owner, name, n: Math.min(k.page, limit - count), after });
    if (!data.repository) throw new Error(`Repository ${owner}/${name} not found, or the token cannot see it.`);
    const conn = data.repository[k.field];
    for (const node of conn.nodes) {
      if (!node) continue;
      if (since && k.order === 'UPDATED_AT' && node.updatedAt < since) return;
      let page = node.comments?.pageInfo;
      while (page?.hasNextPage) {
        const more = (await gql(moreCommentsQuery(k), { id: node.id, after: page.endCursor })).node.comments;
        node.comments.nodes.push(...more.nodes);
        page = more.pageInfo;
      }
      yield normalize(kind, node);
      if (++count >= limit) return;
    }
    if (!conn.pageInfo.hasNextPage) return;
    after = conn.pageInfo.endCursor;
  }
}
