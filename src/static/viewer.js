// Runs in the browser on index.html. Data comes from index-data.js as a global,
// because pages opened from disk (file://) cannot fetch JSON.
(() => {
  const D = window.OFFHUB, $ = id => document.getElementById(id);
  const KIND = { issues: 'Issue', pulls: 'PR', discussions: 'Discussion' };
  const MAX = 1000;
  let text = null;

  document.title = `${D.repo} · offline archive`;
  $('repo').textContent = D.repo;
  $('gen').textContent = `Archived ${D.generated.slice(0, 16).replace('T', ' ')} UTC · ${D.items.length} items`;
  for (const i of D.items) i.h = `#${i.n} ${i.t} ${i.a} ${i.l.join(' ')}`.toLowerCase();

  const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };

  function row(i) {
    const li = el('li');
    li.append(el('span', `state ${i.s.toLowerCase()}`, i.s.toLowerCase()), ' ');
    const a = el('a', '', i.t);
    a.href = `${i.k}/${i.n}.html`;
    li.append(a, ' ', el('span', 'num', `${KIND[i.k]} #${i.n}`));
    for (const l of i.l) li.append(' ', el('span', 'label', l));
    li.append(el('div', 'facts', `${i.a} · updated ${i.u.slice(0, 10)} · ${i.c} comments`));
    return li;
  }

  function draw() {
    const words = $('q').value.toLowerCase().split(/\s+/).filter(Boolean);
    const kind = $('kind').value, state = $('state').value;
    const hits = D.items.filter(i =>
      (!kind || i.k === kind)
      && (!state || (state === 'open') === (i.s === 'OPEN'))
      && words.every(w => i.h.includes(w) || (text && (text[`${i.k}/${i.n}`] || '').includes(w))));
    $('count').textContent = hits.length > MAX
      ? `${hits.length} matches, showing the ${MAX} most recently updated`
      : `${hits.length} matches`;
    $('list').replaceChildren(...hits.slice(0, MAX).map(row));
  }

  $('full').addEventListener('change', () => {
    if (!$('full').checked) { text = null; return draw(); }
    if (window.OFFHUB_TEXT) { text = window.OFFHUB_TEXT; return draw(); }
    const s = document.createElement('script');
    s.src = 'fulltext.js';
    s.onload = () => { text = window.OFFHUB_TEXT; draw(); };
    document.head.append(s);
  });
  for (const id of ['q', 'kind', 'state']) $(id).addEventListener('input', draw);
  draw();
})();
