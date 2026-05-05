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

// Ligne d'un changement : marker · titre · meta — pas de timestamp (la date
// est portée par la ligne « passage du bot » qui ouvre le groupe).
function lineHtml({ type, marker, title, metaInline, groupCls }) {
  return `<li class="hist-line hist-${type} ${groupCls}">
    <span class="hist-marker" aria-hidden="true">${marker}</span>
    <span class="hist-content"><span class="hist-title">${title}</span>${metaInline ? `<span class="hist-meta-row">${metaInline}</span>` : ''}</span>
  </li>`;
}

function addedLine(c, groupCls) {
  const meta = lineMetaInline([
    c.ville ? escapeHtml(c.ville) : '',
    c.dateDebut ? escapeHtml(formatCompDate(c.dateDebut)) : '',
  ]);
  return lineHtml({ type: 'added', marker: '✚', title: compTitleHtml(c), metaInline: meta, groupCls });
}

function removedLine(c, groupCls) {
  const meta = lineMetaInline([
    c.ville ? escapeHtml(c.ville) : '',
    c.dateDebut ? escapeHtml(formatCompDate(c.dateDebut)) : '',
  ]);
  return lineHtml({ type: 'removed', marker: '✖', title: compTitleHtml(c), metaInline: meta, groupCls });
}

function updatedLine(u, groupCls) {
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
  return lineHtml({ type: 'updated', marker: '✎', title: compTitleHtml(u), metaInline: meta, groupCls });
}

// Ligne d'en-tête « passage du bot » : seule à porter le timestamp + résumé
// +N ~N −N (ou « aucun changement »). Les lignes added/updated/removed du
// même timestamp sont rattachées visuellement par la couleur de fond de groupe.
function runHeaderLine(scraperRun, groupCls) {
  const stampIso = scraperRun.scrapedAt;
  const stamp = formatRunStamp(stampIso);
  const stampFull = formatRunStampFull(stampIso);
  const c = scraperRun.counts || { added: 0, removed: 0, updated: 0 };
  const total = (c.added || 0) + (c.removed || 0) + (c.updated || 0);
  const isNoop = total === 0;
  const summary = isNoop
    ? '<span class="recent-zero">aucun changement</span>'
    : [
        c.added > 0 ? `<span class="hist-total-added">+${c.added}</span>` : '',
        c.updated > 0 ? `<span class="hist-total-updated">~${c.updated}</span>` : '',
        c.removed > 0 ? `<span class="hist-total-removed">−${c.removed}</span>` : '',
      ].filter(Boolean).join(' ');
  const noopCls = isNoop ? ' hist-run-noop' : '';
  return `<li class="hist-run${noopCls} ${groupCls}">
    <time class="hist-stamp" datetime="${escapeHtml(stampIso)}" title="${escapeHtml(stampFull)}">${stamp}</time>
    <span class="hist-marker" aria-hidden="true">⏱</span>
    <span class="hist-content"><span class="hist-run-label">passage du bot</span> <span class="hist-run-summary">${summary}</span></span>
  </li>`;
}

// Construit la timeline fusionnée : pour chaque passage du bot des 30 derniers
// jours (antichronologique), une ligne d'en-tête, puis si ce passage a des
// changements pertinents on intercale les lignes détaillées (added/updated/
// removed). Toutes les lignes d'un même groupe partagent la même classe
// hist-g-odd / hist-g-even pour matérialiser le rattachement par fond.
function buildTimeline(scraperRuns, runs) {
  const runsByStamp = new Map();
  for (const r of runs) runsByStamp.set(r.scrapedAt, r);
  const lines = [];
  scraperRuns.forEach((sr, i) => {
    const groupCls = (i % 2 === 0) ? 'hist-g-even' : 'hist-g-odd';
    lines.push(runHeaderLine(sr, groupCls));
    const run = runsByStamp.get(sr.scrapedAt);
    if (!run) return;
    for (const c of (run.added || [])) lines.push(addedLine(c, groupCls));
    for (const u of (run.updated || [])) lines.push(updatedLine(u, groupCls));
    for (const c of (run.removed || [])) lines.push(removedLine(c, groupCls));
  });
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

  // Fenêtre d'affichage : 30 j. Les scraperRuns sont déjà purgés à 30 j côté
  // scraper, mais on filtre aussi les runs (qui ont une fenêtre 3 mois côté
  // backend) pour aligner les totaux sur la timeline fusionnée affichée.
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const runsInWindow = runs.filter((r) => {
    const t = new Date(r.scrapedAt).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });

  const totals = document.getElementById('statutTotals');
  if (totals) totals.innerHTML = totalsHtml(runsInWindow);

  const container = document.getElementById('statutLines');
  if (!scraperRuns || scraperRuns.length === 0) {
    container.innerHTML = '<li class="hist-empty">Aucun passage enregistré pour le moment. La page se remplira après les prochains passages du scraper.</li>';
    return;
  }
  container.innerHTML = buildTimeline(scraperRuns, runsInWindow).join('');
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
  try {
    const data = await loadHistory();
    render(data);
  } catch (err) {
    showError("Impossible de charger l'historique. Réessayez plus tard.");
  }
}

document.addEventListener('DOMContentLoaded', init);
