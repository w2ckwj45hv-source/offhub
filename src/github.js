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
const KINDS = {
  issues: {
    field: 'issues', type: 'Issue', page: 50,
    comment: C,
    fields: 'state closedAt',
  },
  pulls: {
    field: 'pullRequests', type: 'PullRequest', page: 20,
    comment: C,
    fields: `state closedAt mergedAt isDraft baseRefName headRefName additions deletions changedFiles
      reviews(first:50){totalCount nodes{${C} state comments(first:30){totalCount nodes{${C} path diffHunk}}}}`,
  },
  discussions: {
    field: 'discussions', type: 'Discussion', page: 30,
    comment: `${C} isAnswer replies(first:50){totalCount nodes{${C}}}`,
    fields: 'closed closedAt category{name}',
  },
};
export const KIND_NAMES = Object.keys(KINDS);

const listQuery = k => `query($owner:String!,$name:String!,$n:Int!,$after:String){
  repository(owner:$owner,name:$name){
    ${k.field}(first:$n,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      ${PAGE}
      nodes{ id number title url createdAt updatedAt bodyHTML author{login}
        labels(first:30){nodes{name color}}
        comments(first:100){${PAGE} nodes{${k.comment}}}
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
  const comments = n.comments.nodes.filter(Boolean).map(c => {
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
  return {
    kind, number: n.number, title: n.title, url: n.url,
    state: n.state ?? (n.closed ? 'CLOSED' : 'OPEN'),
    author: who(n), createdAt: n.createdAt, updatedAt: n.updatedAt, closedAt: n.closedAt ?? null,
    labels: n.labels.nodes.map(l => ({ name: l.name, color: l.color })),
    html: n.bodyHTML, comments, truncated, meta,
  };
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
      if (since && node.updatedAt < since) return;
      let page = node.comments.pageInfo;
      while (page.hasNextPage) {
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
