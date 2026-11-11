// Turns archived items into static HTML pages.
// Titles, names and labels are escaped here. Bodies (`html`) are GitHub's own
// sanitized bodyHTML and are inserted as-is.
export const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const when = iso => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '');
const KIND = { issues: 'Issue', pulls: 'Pull request', discussions: 'Discussion', releases: 'Release' };
const size = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

function comment(c) {
  const tags = [
    c.review && `<span class="tag">${esc(c.review.toLowerCase().replaceAll('_', ' '))}</span>`,
    c.answer && '<span class="tag ok">answer</span>',
  ].filter(Boolean).join(' ');
  const date = c.url ? `<a href="${esc(c.url)}">${when(c.createdAt)}</a>` : when(c.createdAt);
  const threads = (c.threads ?? []).map(t => `<div class="thread">
<div class="path">${esc(t.path)}</div>${t.diffHunk ? `<pre>${esc(t.diffHunk)}</pre>` : ''}
<div class="by"><b>${esc(t.author)}</b> · ${when(t.createdAt)}</div><div class="md">${t.html ?? ''}</div></div>`).join('');
  const replies = (c.replies ?? []).map(comment).join('');
  return `<article class="c"><header><b>${esc(c.author)}</b> · ${date} ${tags}</header>
<div class="md">${c.html ?? ''}</div>${threads}${replies ? `<div class="replies">${replies}</div>` : ''}</article>`;
}

export function renderItem(it, repo) {
  const m = it.meta ?? {};
  const labels = it.labels.map(l => {
    const color = /^[0-9a-f]{6}$/i.test(l.color) ? ` style="border-color:#${l.color}"` : '';
    return `<span class="label"${color}>${esc(l.name)}</span>`;
  }).join(' ');
  const facts = [
    `<span class="state ${esc(it.state.toLowerCase())}">${esc(it.state.toLowerCase())}</span>`,
    m.draft && '<span class="tag">draft</span>',
    `<b>${esc(it.author)}</b> ${m.tag ? 'published' : 'opened'} this on ${when(m.publishedAt ?? it.createdAt)}`,
    it.closedAt && `closed ${when(it.closedAt)}`,
    m.base && `<code>${esc(m.base)}</code> ← <code>${esc(m.head)}</code>`,
    m.changedFiles != null && `+${m.additions} −${m.deletions} in ${m.changedFiles} files`,
    m.category && `category: ${esc(m.category)}`,
    `<a href="${esc(it.url)}">original</a>`,
  ].filter(Boolean).join(' · ');
  const ref = `${KIND[it.kind]} ${m.tag ?? `#${it.number}`}`;
  const title = `${it.title} · ${ref}`;
  // Release files can be huge, so they stay links to GitHub.
  const assets = m.assets?.length
    ? `<h2>Files</h2><ul>${m.assets.map(a => `<li><a href="${esc(a.url)}">${esc(a.name)}</a> <span class="num">${size(a.size)}</span></li>`).join('')}</ul>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="../style.css"></head><body>
<nav><a href="../index.html">← ${esc(repo)}</a></nav>
<h1>${esc(it.title)} <span class="num">${esc(ref)}</span></h1>
<p class="facts">${facts}</p>
${labels ? `<p>${labels}</p>` : ''}
${it.truncated ? '<p class="note">Some review comments or replies were not archived. See the original for the full thread.</p>' : ''}
<article class="c first"><div class="md">${it.html ?? ''}</div></article>
${assets}
${it.comments.map(comment).join('\n')}
</body></html>
`;
}

// Lowercased plain text of an item, for the optional full-text search.
export function plainText(it) {
  const parts = [it.html];
  for (const c of it.comments) {
    parts.push(c.html, ...(c.replies ?? []).map(r => r.html), ...(c.threads ?? []).map(t => t.html));
  }
  return parts.filter(Boolean).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 20000);
}
