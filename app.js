/* global L */
'use strict';

// Clé localStorage pour la position utilisateur.
// La position ne quitte jamais le navigateur : on ne l'envoie nulle part,
// on la garde juste pour éviter de redemander à chaque visite.
const USER_POS_STORAGE_KEY = 'master-map.userPos.v1';

// Centre approximatif de la France métropolitaine, utilisé UNIQUEMENT
// comme centrage initial de la carte tant que l'utilisateur n'a pas
// fourni sa position. Aucun calcul de distance n'est fait avec.
const FRANCE_CENTER = { lat: 46.5, lon: 2.5 };

// Couleur par niveau effectif.
// "F" (championnat de France maîtres) est un niveau virtuel dérivé du flag
// championnatFrance — tous les F sont aussi des N au sens FFN.
const NIVEAU_COLORS = {
  F: '#DC2626', // Championnat de France maîtres — rouge vif
  I: '#7C2D12', // International — bordeaux
  N: '#EA580C', // National hors CdF — orange
  Z: '#CA8A04', // Interrégional — jaune
  R: '#2563EB', // Régional — bleu
  D: '#64748B'  // Départemental — gris
};

// Priorité pour choisir la couleur d'un marqueur qui regroupe
// plusieurs compétitions (le plus prestigieux gagne).
const LEVEL_PRIORITY = { F: 6, I: 5, N: 4, Z: 3, R: 2, D: 1 };

const MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
];

const state = {
  all: [],              // [{c, dist}, ...] (toutes les comp géolocalisées)
  mode: 'upcoming',     // 'upcoming' | 'season'
  horizonMonths: 3,     // n'a de sens que si mode === 'upcoming'
  seasonIndex: 1,       // indice dans state.seasons[] quand mode === 'season'
  sortMode: 'distance', // 'distance' | 'date' (revient à 'date' si pas de position)
  search: '',           // chaîne normalisée
  bassinFilter: 'all',  // 'all' | '25' | '50'
  seasons: [],          // [{id, label, start, end, current?}, ...]
  userPos: null,
  pickingLocation: false,
  map: null,
  markers: {}
};

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seasonLabel(s) {
  // "2025-09-01" → "2025-2026"
  if (!s) return '';
  const y = parseInt(s.slice(0, 4), 10);
  return `${y}-${y + 1}`;
}

// --- Position utilisateur (localStorage + géoloc + pick sur carte) --------

function loadUserPos() {
  try {
    const raw = localStorage.getItem(USER_POS_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return null;
    return { lat: p.lat, lon: p.lon };
  } catch {
    return null;
  }
}

function saveUserPos(pos) {
  try {
    localStorage.setItem(USER_POS_STORAGE_KEY, JSON.stringify(pos));
  } catch {
    // Stockage indispo (mode privé) — on continue sans persister.
  }
}

function clearUserPos() {
  try { localStorage.removeItem(USER_POS_STORAGE_KEY); } catch {}
}

// Enclenche l'un des chemins pour obtenir une position.
function requestGeolocation() {
  if (!navigator.geolocation) {
    setLocationPromptMsg("Géolocalisation indisponible sur ce navigateur. Utilise le clic sur la carte.");
    return;
  }
  setLocationPromptMsg("Demande de position en cours…");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      applyUserPos(pos);
    },
    (err) => {
      setLocationPromptMsg(
        err.code === 1
          ? "Permission refusée. Clique sur la carte pour indiquer ta position."
          : "Position introuvable. Clique sur la carte pour la choisir."
      );
      enableMapPicking();
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60 * 60 * 1000 }
  );
}

function enableMapPicking() {
  state.pickingLocation = true;
  const overlay = document.getElementById('mapPickOverlay');
  if (overlay) overlay.hidden = false;
  document.getElementById('map').classList.add('picking');
}

function disableMapPicking() {
  state.pickingLocation = false;
  const overlay = document.getElementById('mapPickOverlay');
  if (overlay) overlay.hidden = true;
  document.getElementById('map').classList.remove('picking');
}

function applyUserPos(pos) {
  state.userPos = pos;
  saveUserPos(pos);
  disableMapPicking();
  hideLocationPrompt();
  recomputeDistances();
  addUserMarker();
  render();
  // Recentrer sur la position de l'utilisateur
  if (state.map) state.map.setView([pos.lat, pos.lon], 7);
}

// Marqueur spécifique pour la position utilisateur (distinct des compétitions).
// Étiquette permanente "Ma position" à côté + marqueur et étiquette cliquables :
// clic = même comportement que le bouton "Ma position" du header
// (ouvre le prompt de redéfinition).
function addUserMarker() {
  if (!state.map || !state.userPos) return;
  if (state.userMarker) state.map.removeLayer(state.userMarker);
  const icon = L.divIcon({
    className: 'marker-wrapper',
    html: '<div class="marker-user clickable" title="Changer ma position">📍</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 28]
  });
  state.userMarker = L.marker([state.userPos.lat, state.userPos.lon], {
    icon, zIndexOffset: 1000
  }).addTo(state.map);
  state.userMarker.bindTooltip('Ma position', {
    permanent: true,
    direction: 'right',
    offset: [10, -14],
    className: 'user-tooltip',
    interactive: true
  });
  state.userMarker.on('click', triggerChangePosition);
}

function recomputeDistances() {
  if (!state.userPos) {
    for (const item of state.all) item.dist = Infinity;
    return;
  }
  for (const item of state.all) {
    item.dist = haversineKm(state.userPos, { lat: item.c.lat, lon: item.c.lon });
  }
}

function showLocationPrompt() {
  const el = document.getElementById('locationPrompt');
  if (el) el.hidden = false;
  setLocationPromptMsg(null); // message par défaut
}

function hideLocationPrompt() {
  const el = document.getElementById('locationPrompt');
  if (el) el.hidden = true;
}

function setLocationPromptMsg(msg) {
  const el = document.getElementById('locationPromptMsg');
  if (!el) return;
  el.textContent = msg || "Indique ta position pour trier les compétitions par distance.";
}

function initLocation() {
  // Boutons du prompt
  document.getElementById('geolocateBtn').addEventListener('click', requestGeolocation);
  document.getElementById('pickMapBtn').addEventListener('click', () => {
    enableMapPicking();
    setLocationPromptMsg("Clique sur la carte pour placer ta position.");
    if (window.innerWidth < 960) activateTab('map');
  });
  document.getElementById('dismissPromptBtn').addEventListener('click', () => {
    hideLocationPrompt();
    disableMapPicking();
    // Pas de position → tri par date par défaut
    state.sortMode = 'date';
    document.querySelectorAll('.sort-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.sort === 'date');
    });
    render();
  });

  // Bouton "Ma position" dans le header — voir triggerChangePosition()
  document.getElementById('changeLocationBtn').addEventListener('click', triggerChangePosition);
}

// Point d'entrée unique pour "redéfinir ma position".
// Appelé depuis le bouton header ET depuis le clic sur le marqueur/label
// "Ma position" sur la carte.
function triggerChangePosition() {
  if (window.innerWidth < 960) activateTab('map');
  if (state.userPos && state.map) {
    state.map.setView([state.userPos.lat, state.userPos.lon], 7);
  }
  showLocationPrompt();

  // Clic sur la carte en mode pick
  // (Attaché plus tard, dans init(), après création de la carte)
}


// --- Helpers ---------------------------------------------------------------

function haversineKm(a, b) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Normalise pour recherche insensible à la casse ET aux accents.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function formatDateRange(startStr, endStr) {
  const s = new Date(startStr + 'T00:00:00');
  const e = new Date(endStr + 'T00:00:00');
  const sd = s.getDate(), sm = s.getMonth(), sy = s.getFullYear();
  const ed = e.getDate(), em = e.getMonth(), ey = e.getFullYear();
  if (sd === ed && sm === em && sy === ey) return `${sd} ${MONTHS[sm]} ${sy}`;
  if (sm === em && sy === ey) return `${sd} – ${ed} ${MONTHS[sm]} ${sy}`;
  if (sy === ey) return `${sd} ${MONTHS[sm]} – ${ed} ${MONTHS[em]} ${sy}`;
  return `${sd} ${MONTHS[sm]} ${sy} – ${ed} ${MONTHS[em]} ${ey}`;
}

function formatUpdated(iso) {
  const diffH = (Date.now() - new Date(iso).getTime()) / 3600000;
  let text;
  if (diffH < 1) text = 'il y a quelques minutes';
  else if (diffH < 24) text = `il y a ${Math.floor(diffH)} h`;
  else if (diffH < 48) text = 'hier';
  else text = `il y a ${Math.floor(diffH / 24)} jours`;
  const cls = diffH >= 72 ? 'stale' : diffH >= 36 ? 'warn' : '';
  return { text, cls, stale: diffH >= 72 };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Whitelist stricte pour les URLs sortantes injectées dans des <a href>.
// Défense en profondeur : empêche un éventuel `javascript:...` ou autre
// schéma exotique même si l'URL venait un jour d'une source non maîtrisée.
function safeExternalUrl(url) {
  if (typeof url !== 'string') return '#';
  if (url.startsWith('https://www.liveffn.com/')) return url;
  return '#';
}

function effectiveNiveau(c) {
  return c.championnatFrance ? 'F' : c.niveau;
}

function niveauLabel(c) {
  if (c.championnatFrance) return 'Championnat de France Maîtres';
  return c.niveauLibelle || c.niveau;
}

// --- Groupes de marqueurs & popups ----------------------------------------

// Regroupe les compétitions par couple (lat, lon) arrondi à 4 décimales
// (~11 m), ce qui permet de fusionner les points identiques d'une même
// ville (cas Châteauroux : CdF N1 et N2 au même endroit, même jour).
function groupByLocation(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.c.lat.toFixed(4)},${item.c.lon.toFixed(4)}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(item);
  }
  return [...groups.values()];
}

// Compétition la plus prestigieuse d'un groupe → détermine la couleur.
function topCompetition(group) {
  return group.reduce((best, cur) => {
    const pBest = LEVEL_PRIORITY[effectiveNiveau(best.c)] || 0;
    const pCur = LEVEL_PRIORITY[effectiveNiveau(cur.c)] || 0;
    return pCur > pBest ? cur : best;
  }).c;
}

function popupItemHtml(c) {
  const dates = formatDateRange(c.dateDebut, c.dateFin);
  const cfBadge = c.championnatFrance
    ? '<span class="champ-france">CHAMPIONNAT DE FRANCE</span>'
    : '';
  const pastTag = isPast(c)
    ? '<span class="past-tag">TERMINÉE</span>'
    : '';
  const bassinTag = c.bassin
    ? `<span class="bassin-tag">${c.bassin} m</span>`
    : '';
  const tags = [cfBadge, bassinTag, pastTag].filter(Boolean).join(' ');
  return `<div class="popup-item">
    ${tags ? `<div class="item-tags">${tags}</div>` : ''}
    <div class="item-title">${escapeHtml(c.nom)}</div>
    <div class="item-meta">${escapeHtml(dates)} · ${escapeHtml(niveauLabel(c))}</div>
    <a class="item-link" href="${escapeHtml(safeExternalUrl(c.url))}" target="_blank" rel="noopener">🏊 Détails FFN</a>
  </div>`;
}

function popupGroupHtml(group) {
  const first = group[0].c;
  // La distance est la même pour toutes les comp du groupe (même point GPS)
  const distHtml = state.userPos
    ? `<span class="distance-pin"><span class="distance-pin-ico" aria-hidden="true">📍</span>${Math.round(group[0].dist)} km</span>`
    : '';
  const header = `<div class="popup-head">
    <span class="popup-head-main">
      <strong>${escapeHtml(first.ville)}</strong>
      ${group.length > 1 ? `<span class="count-badge">${group.length} compétitions</span>` : ''}
    </span>
    ${distHtml}
  </div>`;
  // Trie les compétitions du popup : championnats d'abord, puis par date.
  const sorted = group.slice().sort((a, b) => {
    const pa = LEVEL_PRIORITY[effectiveNiveau(a.c)] || 0;
    const pb = LEVEL_PRIORITY[effectiveNiveau(b.c)] || 0;
    if (pa !== pb) return pb - pa;
    return a.c.dateDebut.localeCompare(b.c.dateDebut);
  });
  const items = sorted.map(({ c }) => popupItemHtml(c)).join('');
  return `<div class="popup popup-group">${header}${items}</div>`;
}

// Icône HTML (divIcon) : cercle coloré, badge numérique si groupe > 1,
// transparence si toutes les compétitions du lieu sont passées.
function markerIcon(group) {
  const top = topCompetition(group);
  const code = effectiveNiveau(top);
  const color = NIVEAU_COLORS[code] || '#64748B';
  const allPast = group.every(({ c }) => isPast(c));
  const isMulti = group.length > 1;
  const isCdF = top.championnatFrance;
  const size = isCdF || isMulti ? 26 : 20;
  const border = isCdF ? 3 : 2;
  const label = isMulti ? String(group.length) : '';
  return L.divIcon({
    className: 'marker-wrapper',
    html: `<div class="marker-pill${allPast ? ' past' : ''}" style="width:${size}px;height:${size}px;background:${color};border-width:${border}px">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2]
  });
}

// --- Erreurs ---------------------------------------------------------------

function setError(msg) {
  const mapErr = document.getElementById('mapError');
  const listErr = document.getElementById('listError');
  mapErr.textContent = msg;
  listErr.textContent = msg;
  mapErr.hidden = false;
  listErr.hidden = false;
  document.getElementById('map').style.display = 'none';
}

// --- Tabs ------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
  });
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.getElementById('mapPane').classList.toggle('active', name === 'map');
  document.getElementById('listPane').classList.toggle('active', name === 'list');
  if (name === 'map' && state.map) {
    setTimeout(() => state.map.invalidateSize(), 50);
  }
}

// --- Sélecteur période (mode + horizon) -----------------------------------

function initHorizon() {
  const sel = document.getElementById('horizon');
  sel.addEventListener('change', () => {
    const v = sel.value; // "upcoming:3" | "season:<index>"
    if (v.startsWith('upcoming:')) {
      state.mode = 'upcoming';
      state.horizonMonths = parseInt(v.slice(9), 10);
    } else if (v.startsWith('season:')) {
      state.mode = 'season';
      state.seasonIndex = parseInt(v.slice(7), 10);
    }
    render();
  });
}

// Peuple dynamiquement les options "Saison XXXX/YY" depuis state.seasons.
// Les saisons sont listées de la plus récente à la plus ancienne
// (cohérent avec ce que l'utilisateur attend dans un menu déroulant).
function populateSeasonOptions() {
  const group = document.getElementById('seasonGroup');
  if (!group || state.seasons.length === 0) return;
  group.innerHTML = '';
  // Ordre : courante en premier, puis précédente
  const ordered = [...state.seasons].sort((a, b) => (a.start < b.start ? 1 : -1));
  for (const s of ordered) {
    const idx = state.seasons.indexOf(s);
    const opt = document.createElement('option');
    opt.value = `season:${idx}`;
    opt.textContent = `Saison ${s.label}`;
    group.appendChild(opt);
  }
}

// Borne supérieure de la fenêtre "à venir".
function upcomingUpperIso() {
  const d = new Date();
  d.setMonth(d.getMonth() + state.horizonMonths);
  return d.toISOString().slice(0, 10);
}

// --- Recherche ------------------------------------------------------------

function initSearch() {
  const input = document.getElementById('search');
  const form = document.getElementById('searchForm');
  input.addEventListener('input', () => {
    state.search = normalize(input.value).trim();
    render();
  });
  // Clavier mobile : le submit du <form> est le seul événement fiable pour
  // détecter l'appui sur la loupe/Entrée du clavier virtuel.
  // On empêche la navigation et on défocuse l'input → le clavier se ferme.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    input.blur();
  });
}

function initBassinFilter() {
  document.querySelectorAll('.bassin-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      state.bassinFilter = btn.dataset.bassin;
      document.querySelectorAll('.bassin-pill').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      render();
    });
  });
}

// Bouton "actualiser" : reload TOTAL avec cache-bust.
// Remplace le pull-to-refresh natif (impossible depuis qu'on a overflow: hidden).
// Sur mobile, c'est le seul moyen de forcer la re-récupération de tous les
// fichiers (HTML, CSS, JS, JSON, favicon) sans devoir passer par les menus
// du navigateur.
function initReload() {
  const btn = document.getElementById('reloadBtn');
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.classList.add('spinning');
    btn.disabled = true;

    // 1. Re-télécharge chaque asset en forçant l'origine (bypass du cache
    //    navigateur). Cela MET À JOUR le cache local avec la version fraîche
    //    du serveur, que le reload HTML va ensuite utiliser.
    const assets = ['app.css', 'app.js', 'favicon.svg', 'data/competitions.json'];
    await Promise.all(
      assets.map(url => fetch(url, { cache: 'reload' }).catch(() => null))
    );

    // 2. Reload le HTML avec un query param unique → force la ré-interprétation
    //    complète de la page depuis le cache fraîchement mis à jour.
    const u = new URL(location.href);
    u.searchParams.set('_r', Date.now());
    location.href = u.toString();
  });
}

// Fonction de chargement de données, appelée au boot.
async function loadData() {
  const res = await fetch('data/competitions.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();

  if (data.generatedAt) {
    const u = formatUpdated(data.generatedAt);
    const btn = document.getElementById('infoBtn');
    btn.classList.remove('warn', 'stale');
    if (u.cls) btn.classList.add(u.cls);
    state.updatedText = u.text;
    state.updatedClass = u.cls;
  }

  state.seasons = Array.isArray(data.seasons) ? data.seasons : [];
  const currentIdx = state.seasons.findIndex((s) => s.current);
  state.seasonIndex = currentIdx >= 0 ? currentIdx : state.seasons.length - 1;
  populateSeasonOptions();

  const comps = Array.isArray(data.competitions) ? data.competitions : [];
  state.all = comps.map(c => ({ c, dist: Infinity }));
  recomputeDistances();

  render();
}

// --- Tri par boutons radio ------------------------------------------------

function initSort() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      // Si l'utilisateur tente "distance" sans avoir fourni sa position,
      // on lui montre le prompt au lieu de changer l'état silencieusement.
      if (btn.dataset.sort === 'distance' && !state.userPos) {
        showLocationPrompt();
        if (window.innerWidth < 960) activateTab('map');
        return;
      }
      state.sortMode = btn.dataset.sort;
      document.querySelectorAll('.sort-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      renderList();
    });
  });
}

// --- Render ---------------------------------------------------------------

function filteredCompetitions() {
  const today = todayIso();
  const q = state.search;

  let lower, upper;
  if (state.mode === 'upcoming') {
    lower = today;
    upper = upcomingUpperIso();
  } else if (state.mode === 'season') {
    const s = state.seasons[state.seasonIndex];
    lower = s ? s.start : '0000-00-00';
    upper = s ? s.end + '~' : '9999-12-31'; // on inclut le 31 août
  }

  return state.all.filter(({ c }) => {
    if (c.dateDebut < lower || c.dateDebut > upper) return false;
    if (q && !normalize(c.nom + ' ' + c.ville).includes(q)) return false;
    // Filtre bassin :
    //   - 'all'     : tout (25, 50, null)
    //   - '25'/'50' : uniquement cette taille (null exclu)
    if (state.bassinFilter !== 'all') {
      if (c.bassin == null || String(c.bassin) !== state.bassinFilter) return false;
    }
    return true;
  });
}

// Une compétition est "passée" si sa date de fin est avant aujourd'hui.
function isPast(c) {
  return c.dateFin < todayIso();
}

function render() {
  renderMap();
  renderList();
}

function renderMap() {
  // Nettoyer les marqueurs précédents (un seul par groupe, mais on garde
  // une référence par compétition pour que le clic liste trouve son marqueur).
  const seen = new Set();
  for (const id in state.markers) {
    const m = state.markers[id];
    if (!seen.has(m)) {
      state.map.removeLayer(m);
      seen.add(m);
    }
  }
  state.markers = {};

  const groups = groupByLocation(filteredCompetitions());
  for (const group of groups) {
    const first = group[0].c;
    const marker = L.marker([first.lat, first.lon], {
      icon: markerIcon(group)
    }).addTo(state.map);
    marker.bindPopup(popupGroupHtml(group), {
      maxWidth: 320,
      maxHeight: 400,
      autoPan: true
    });
    for (const { c } of group) {
      state.markers[c.id] = marker;
    }
  }
}

function renderList() {
  const list = document.getElementById('list');
  const countEl = document.getElementById('listCount');
  const items = filteredCompetitions().slice();

  // Sans position utilisateur, le tri par distance n'a pas de sens :
  // on bascule silencieusement sur date.
  const effectiveSort = state.userPos ? state.sortMode : 'date';

  if (effectiveSort === 'date') {
    items.sort((a, b) => a.c.dateDebut.localeCompare(b.c.dateDebut));
  } else {
    items.sort((a, b) => a.dist - b.dist);
  }

  countEl.textContent = items.length > 0
    ? `${items.length} compétition${items.length > 1 ? 's' : ''}`
    : '';

  list.innerHTML = '';
  if (items.length === 0) {
    const msg = state.search
      ? 'Aucune compétition ne correspond à votre recherche.'
      : 'Aucune compétition maîtres dans cette fenêtre.';
    list.innerHTML = `<li class="empty">${msg}</li>`;
    return;
  }

  items.forEach(({ c, dist }) => {
    const li = document.createElement('li');
    if (isPast(c)) li.classList.add('past');
    const dates = formatDateRange(c.dateDebut, c.dateFin);
    const code = effectiveNiveau(c);
    const bassinHtml = c.bassin
      ? `<span class="bassin-tag">${c.bassin} m</span>`
      : '';
    const distHtml = state.userPos
      ? `<span class="distance-pin"><span class="distance-pin-ico" aria-hidden="true">📍</span>${Math.round(dist)} km</span>`
      : '';
    li.innerHTML = `
      <span class="badge badge-${escapeHtml(code)}" title="${escapeHtml(niveauLabel(c))}">${escapeHtml(code)}</span>
      <div class="info">
        <p class="name">${escapeHtml(c.nom)}</p>
        <p class="meta">
          <span class="meta-text">${escapeHtml(c.ville)} &middot; ${escapeHtml(dates)}</span>
          ${bassinHtml}
          ${distHtml}
        </p>
      </div>
    `;
    li.addEventListener('click', () => {
      if (window.innerWidth < 960) activateTab('map');
      state.map.setView([c.lat, c.lon], 10);
      const m = state.markers[c.id];
      if (m) setTimeout(() => m.openPopup(), 100);
    });
    list.appendChild(li);
  });
}

// --- Boot -----------------------------------------------------------------

// --- Modal "À propos" -----------------------------------------------------

function initInfoModal() {
  const btn = document.getElementById('infoBtn');
  const modal = document.getElementById('infoModal');
  const backdrop = document.getElementById('modalBackdrop');
  const closeBtn = document.getElementById('modalClose');
  const updatedEl = document.getElementById('modalUpdated');

  function open() {
    updatedEl.textContent = state.updatedText || 'date indisponible';
    updatedEl.classList.remove('warn', 'stale');
    if (state.updatedClass) updatedEl.classList.add(state.updatedClass);
    modal.hidden = false;
  }
  function close() { modal.hidden = true; }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });
}

async function init() {
  initTabs();
  initHorizon();
  initSearch();
  initBassinFilter();
  initSort();
  initLocation();
  initInfoModal();
  initReload();

  // Charge la position depuis le cache si disponible.
  state.userPos = loadUserPos();
  const initialCenter = state.userPos || FRANCE_CENTER;
  const initialZoom = state.userPos ? 7 : 6;

  state.map = L.map('map').setView([initialCenter.lat, initialCenter.lon], initialZoom);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19
  }).addTo(state.map);

  // Clic sur la carte : seulement actif en mode "pick location"
  state.map.on('click', (e) => {
    if (!state.pickingLocation) return;
    applyUserPos({ lat: e.latlng.lat, lon: e.latlng.lng });
  });

  // Pas de position en cache → afficher le prompt
  if (!state.userPos) {
    showLocationPrompt();
    state.sortMode = 'date';
    document.querySelectorAll('.sort-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.sort === 'date');
    });
  } else {
    // Petit marqueur pour matérialiser la position utilisateur
    addUserMarker();
  }

  try {
    await loadData();
  } catch (e) {
    setError('Impossible de charger les données. Réessayez.');
  }
}

document.addEventListener('DOMContentLoaded', init);
