'use strict';

const FIELD_LABELS = {
  nom: 'nom',
  ville: 'ville',
  dateDebut: 'date début',
  dateFin: 'date fin',
  niveau: 'niveau',
  niveauLibelle: 'niveau (libellé)',
  championnatFrance: 'championnat de France',
  bassin: 'bassin',
  url: 'URL',
};

const MONTHS_SHORT = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'
];

const MONTHS_FULL = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function safeLiveffnUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('https://www.liveffn.com/')) return url;
  return null;
}

function competitionLiveffnUrl(id) {
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const safeId = String(id).replace(/[^0-9]/g, '');
  if (!safeId) return null;
  return `https://www.liveffn.com/cgi-bin/index.php?competition=${safeId}`;
}

function trackEvent(name) {
  if (window.goatcounter && typeof window.goatcounter.count === 'function') {
    window.goatcounter.count({ path: name, event: true });
  }
}

// Date courte pour la colonne timestamp : "26 avr. 17:49".
// Si plus de 30 jours : "26 avr. 2026".
function formatRunStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso || '');
  const day = d.getDate();
  const month = MONTHS_SHORT[d.getMonth()];
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const diffDays = (Date.now() - d.getTime()) / (24 * 3600 * 1000);
  if (diffDays > 30) return `${day} ${month} ${year}`;
  return `${day} ${month} ${hh}:${mm}`;
}

// Date longue affichée au survol (title).
function formatRunStampFull(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  const day = d.getDate();
  const month = MONTHS_FULL[d.getMonth()];
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const diffH = (Date.now() - d.getTime()) / 3600000;
  let rel;
  if (diffH < 1) rel = 'il y a quelques minutes';
  else if (diffH < 24) rel = `il y a ${Math.floor(diffH)} h`;
  else if (diffH < 48) rel = 'hier';
  else rel = `il y a ${Math.floor(diffH / 24)} jours`;
  return `${day} ${month} ${year}, ${hh}:${mm} — ${rel}`;
}

function formatCompDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return iso;
  const day = parseInt(m[3], 10);
  const month = MONTHS_SHORT[parseInt(m[2], 10) - 1];
  const year = m[1];
  return `${day} ${month} ${year}`;
}

function formatFieldValue(field, value) {
  if (value === null || value === undefined || value === '') return '∅';
  if (field === 'championnatFrance') return value ? 'oui' : 'non';
  if (field === 'bassin') return value + ' m';
  if (field === 'dateDebut' || field === 'dateFin') return formatCompDate(value);
  return String(value);
}

function compTitleHtml(c) {
  const title = c.nom || `Compétition ${c.id}`;
  const url = safeLiveffnUrl(c.url) || competitionLiveffnUrl(c.id);
  return url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
    : escapeHtml(title);
}

function lineMetaInline(parts) {
  return parts.filter(Boolean).map((p) => `<span class="line-meta">${p}</span>`).join(' <span class="line-sep">·</span> ');
}

// Une seule ligne fluide : timestamp · marker · titre · meta — tout inline,
// wrappe naturellement quand la largeur manque.
function lineHtml({ stampIso, type, marker, title, metaInline }) {
  const stamp = formatRunStamp(stampIso);
  const stampFull = formatRunStampFull(stampIso);
  return `<li class="hist-line hist-${type}">
    <time class="hist-stamp" datetime="${escapeHtml(stampIso)}" title="${escapeHtml(stampFull)}">${stamp}</time>
    <span class="hist-marker" aria-hidden="true">${marker}</span>
    <span class="hist-content"><span class="hist-title">${title}</span>${metaInline ? `<span class="hist-meta-row">${metaInline}</span>` : ''}</span>
  </li>`;
}

function addedLine(stampIso, c) {
  const meta = lineMetaInline([
    c.ville ? escapeHtml(c.ville) : '',
    c.dateDebut ? escapeHtml(formatCompDate(c.dateDebut)) : '',
  ]);
  return lineHtml({ stampIso, type: 'added', marker: '✚', title: compTitleHtml(c), metaInline: meta });
}

function removedLine(stampIso, c) {
  const meta = lineMetaInline([
    c.ville ? escapeHtml(c.ville) : '',
    c.dateDebut ? escapeHtml(formatCompDate(c.dateDebut)) : '',
  ]);
  return lineHtml({ stampIso, type: 'removed', marker: '✖', title: compTitleHtml(c), metaInline: meta });
}

function updatedLine(stampIso, u) {
  const changesHtml = (u.changes || []).map((ch) => {
    const label = FIELD_LABELS[ch.field] || ch.field;
    const from = formatFieldValue(ch.field, ch.from);
    const to = formatFieldValue(ch.field, ch.to);
    return `<span class="hist-change"><span class="hist-change-label">${escapeHtml(label)}</span> : <span class="hist-from">${escapeHtml(from)}</span> <span class="hist-arrow">→</span> <span class="hist-to">${escapeHtml(to)}</span></span>`;
  }).join(' <span class="line-sep">·</span> ');
  const meta = lineMetaInline([
    u.ville ? escapeHtml(u.ville) : '',
    changesHtml,
  ]);
  return lineHtml({ stampIso, type: 'updated', marker: '✎', title: compTitleHtml(u), metaInline: meta });
}

// Aplatit tous les runs en lignes plates, ordre antichronologique
// (les runs sont déjà du plus récent au plus ancien). À l'intérieur d'un
// run on ordonne : ajouts, modifs, suppressions.
function flattenRuns(runs) {
  const lines = [];
  for (const run of runs) {
    const stampIso = run.scrapedAt;
    for (const c of (run.added || [])) lines.push(addedLine(stampIso, c));
    for (const u of (run.updated || [])) lines.push(updatedLine(stampIso, u));
    for (const c of (run.removed || [])) lines.push(removedLine(stampIso, c));
  }
  return lines;
}

function totalsHtml(runs) {
  let added = 0, removed = 0, updated = 0;
  for (const r of runs) {
    added += r.counts?.added ?? 0;
    removed += r.counts?.removed ?? 0;
    updated += r.counts?.updated ?? 0;
  }
  return `
    <span class="hist-total-added">+${added} ajout${added > 1 ? 's' : ''}</span>
    <span class="hist-total-updated">~${updated} modif${updated > 1 ? 's' : ''}</span>
    <span class="hist-total-removed">−${removed} suppression${removed > 1 ? 's' : ''}</span>
  `;
}

async function loadHistory() {
  // Cache-bust agressif : certains navigateurs/proxies ignorent
  // `cache: 'no-cache'` quand le fichier a un Last-Modified très récent
  // (ils répondent 304 même si le contenu a changé). Le query param fait
  // l'URL différente à chaque chargement → garanti cache miss.
  const res = await fetch(`data/history.json?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function showError(msg) {
  document.getElementById('statutLoading').hidden = true;
  const err = document.getElementById('statutError');
  err.textContent = msg;
  err.hidden = false;
}

function recentItemHtml(r) {
  const stamp = formatRunStamp(r.scrapedAt);
  const stampFull = formatRunStampFull(r.scrapedAt);
  const c = r.counts || { added: 0, removed: 0, updated: 0 };
  const total = (c.added || 0) + (c.removed || 0) + (c.updated || 0);
  const summary = total === 0
    ? '<span class="recent-zero">aucun changement</span>'
    : [
        c.added > 0 ? `<span class="hist-total-added">+${c.added}</span>` : '',
        c.updated > 0 ? `<span class="hist-total-updated">~${c.updated}</span>` : '',
        c.removed > 0 ? `<span class="hist-total-removed">−${c.removed}</span>` : '',
      ].filter(Boolean).join(' ');
  return `<li class="recent-item">
    <time class="recent-stamp" datetime="${escapeHtml(r.scrapedAt)}" title="${escapeHtml(stampFull)}">${stamp}</time>
    <span class="recent-summary">${summary}</span>
  </li>`;
}

function renderRecent(scraperRuns) {
  const list = document.getElementById('recentList');
  if (!list) return;
  if (!Array.isArray(scraperRuns) || scraperRuns.length === 0) {
    list.innerHTML = '<li class="hist-empty">Aucun passage enregistré pour le moment.</li>';
    return;
  }
  list.innerHTML = scraperRuns.map(recentItemHtml).join('');
}

// Catégorie d'âge du dernier passage du bot (mêmes seuils que l'icône
// horloge du header sur la page principale) :
//   < 36 h  : fresh   / 36-72 h : warn   / > 72 h : stale
function freshnessFromIso(iso) {
  if (!iso) return null;
  const diffH = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (!Number.isFinite(diffH)) return 'fresh';
  if (diffH < 36) return 'fresh';
  if (diffH < 72) return 'warn';
  return 'stale';
}

const STATUS_LABELS = { fresh: 'Fonctionnel', warn: 'Retard', stale: 'En panne' };

function renderBotStatus(scraperRuns) {
  const el = document.getElementById('botStatus');
  const icon = document.getElementById('statusIcon');
  const last = Array.isArray(scraperRuns) && scraperRuns.length > 0
    ? scraperRuns[0]
    : null;

  if (icon) icon.classList.remove('fresh', 'warn', 'stale');
  if (el) {
    el.classList.remove('fresh', 'warn', 'stale');
    el.hidden = true;
  }

  if (!last || !last.scrapedAt) return;
  const cls = freshnessFromIso(last.scrapedAt);
  if (icon) icon.classList.add(cls);
  if (el) {
    el.classList.add(cls);
    el.textContent = STATUS_LABELS[cls];
    el.title = `Dernier passage : ${formatRunStampFull(last.scrapedAt)}`;
    el.hidden = false;
  }
}

function render(data) {
  document.getElementById('statutLoading').hidden = true;
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  const scraperRuns = Array.isArray(data?.scraperRuns) ? data.scraperRuns : [];

  renderBotStatus(scraperRuns);
  renderRecent(scraperRuns);

  const totals = document.getElementById('statutTotals');
  if (totals) totals.innerHTML = totalsHtml(runs);

  const container = document.getElementById('statutLines');
  if (!runs || runs.length === 0) {
    container.innerHTML = '<li class="hist-empty">Aucun changement enregistré pour le moment. La page se remplira après les prochains passages du scraper.</li>';
    return;
  }
  container.innerHTML = flattenRuns(runs).join('');
}

function initTabs() {
  const tabs = document.querySelectorAll('.statut-tab');
  const panes = {
    changes: document.getElementById('paneChanges'),
    runs: document.getElementById('paneRuns'),
  };
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        const isActive = t === tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      Object.entries(panes).forEach(([name, el]) => {
        if (!el) return;
        const isActive = name === target;
        el.classList.toggle('statut-pane-active', isActive);
        el.hidden = !isActive;
      });
      trackEvent('statut:tab:' + target);
    });
  });
}

// --- Modale "À propos" (DOM dupliqué depuis index.html) ------------------
function initInfoModal() {
  const btn = document.getElementById('infoBtn');
  const modal = document.getElementById('infoModal');
  const backdrop = document.getElementById('modalBackdrop');
  const closeBtn = document.getElementById('modalClose');
  const updatedEl = document.getElementById('modalUpdated');
  if (!btn || !modal) return;

  let keyAbort = null;
  let previouslyFocused = null;

  function open() {
    trackEvent('modale:about:open');
    previouslyFocused = document.activeElement;
    modal.hidden = false;
    keyAbort = new AbortController();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    }, { signal: keyAbort.signal });
    setTimeout(() => closeBtn.focus(), 0);
  }
  function close() {
    modal.hidden = true;
    if (keyAbort) { keyAbort.abort(); keyAbort = null; }
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
  }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  modal.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.includes('docs.google.com/forms')) trackEvent('formulaire-ajout:click');
    else if (href.includes('github.com')) trackEvent('github:click');
  });

  fetch('data/competitions.json', { cache: 'no-cache' })
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (!data || !data.generatedAt) return;
      const diffH = (Date.now() - new Date(data.generatedAt).getTime()) / 3600000;
      if (updatedEl) {
        let text;
        if (diffH < 1) text = 'il y a quelques minutes';
        else if (diffH < 24) text = `il y a ${Math.floor(diffH)} h`;
        else if (diffH < 48) text = 'hier';
        else text = `il y a ${Math.floor(diffH / 24)} jours`;
        updatedEl.textContent = text;
      }
    })
    .catch(() => {
      if (updatedEl) updatedEl.textContent = 'date indisponible';
    });
}

function initLegalModal() {
  const openBtn = document.getElementById('openLegalBtn');
  const modal = document.getElementById('legalModal');
  const backdrop = document.getElementById('legalModalBackdrop');
  const closeBtn = document.getElementById('legalModalClose');
  if (!openBtn || !modal) return;

  let keyAbort = null;
  let previouslyFocused = null;

  function open() {
    trackEvent('modale:legal:open');
    previouslyFocused = document.activeElement;
    modal.hidden = false;
    keyAbort = new AbortController();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    }, { signal: keyAbort.signal });
    setTimeout(() => closeBtn.focus(), 0);
  }
  function close() {
    modal.hidden = true;
    if (keyAbort) { keyAbort.abort(); keyAbort = null; }
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
}

async function init() {
  initInfoModal();
  initLegalModal();
  initTabs();
  try {
    const data = await loadHistory();
    render(data);
  } catch (err) {
    showError("Impossible de charger l'historique. Réessayez plus tard.");
  }
}

document.addEventListener('DOMContentLoaded', init);
