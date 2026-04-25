/* global L */
'use strict';

// Clé localStorage pour la position utilisateur.
// La position ne quitte jamais le navigateur : on ne l'envoie nulle part,
// on la garde juste pour éviter de redemander à chaque visite.
const USER_POS_STORAGE_KEY = 'couloir4.userPos.v1';

// Centre approximatif de la France métropolitaine, utilisé UNIQUEMENT
// comme centrage initial de la carte tant que l'utilisateur n'a pas
// fourni sa position. Aucun calcul de distance n'est fait avec.
const FRANCE_CENTER = { lat: 46.5, lon: 2.5 };

// Couleur par niveau effectif.
// "F" (championnat de France maîtres) est un niveau virtuel dérivé du flag
// championnatFrance — tous les F sont aussi des N au sens FFN.
const NIVEAU_COLORS = {
  F: '#7c3aed', // Championnat de France maîtres — violet
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
  predictions: [],      // [{...}] compés "habituelles" récurrentes non encore confirmées
  mode: 'upcoming',     // 'upcoming' | 'past' | 'season' | 'habituelles'
  seasonIndex: -1,      // fixé au boot via findCurrentSeasonIndex() ; utilisé quand mode === 'season'
  sortMode: 'distance', // 'distance' | 'date' (revient à 'date' si pas de position)
  search: '',           // chaîne normalisée
  bassinFilter: 'all',  // 'all' | '25' | '50'
  seasons: [],          // [{id, label, start, end, current?}, ...]
  userPos: null,
  pickingLocation: false,
  map: null,
  // Map<locationKey ("lat,lon"), Leaflet marker> — clé stable par lieu :
  // on réutilise le marqueur tant que le lieu reste à l'écran (évite
  // le flash et le travail inutile sur simple changement de filtre).
  markerGroups: new Map(),
  // Index id compétition → marqueur (utilisé par le clic liste pour
  // ouvrir le popup de la bonne comp).
  markers: {}
};

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Envoie un événement custom à GoatCounter. No-op si le script n'est pas
// encore chargé (async) : c'est sans conséquence, les events ratés concernent
// uniquement les premières ms après le boot.
function trackEvent(name) {
  if (window.goatcounter && typeof window.goatcounter.count === 'function') {
    window.goatcounter.count({ path: name, event: true });
  }
}

// Saison courante (flag `current` côté data) avec fallback sur la dernière
// en date — évite d'avoir cette règle dupliquée dans plusieurs fonctions.
function findCurrentSeasonIndex() {
  if (state.seasons.length === 0) return -1;
  const i = state.seasons.findIndex((s) => s.current);
  return i >= 0 ? i : state.seasons.length - 1;
}
function findCurrentSeason() {
  const i = findCurrentSeasonIndex();
  return i >= 0 ? state.seasons[i] : null;
}

// Met à jour les 3 éléments DOM qui affichent le nombre de compétitions filtrées
// (pastille des tabs + pastille toolbar + libellé texte "N compétitions").
function setCompetitionCount(n) {
  const pillText = n > 0 ? String(n) : '';
  const label = n > 0 ? ` compétition${n > 1 ? 's' : ''}` : '';
  const listPill = document.getElementById('listCountPill');
  const listText = document.getElementById('listCountText');
  const tabsPill = document.getElementById('tabsCount');
  if (listPill) listPill.textContent = pillText;
  if (listText) listText.textContent = label;
  if (tabsPill) tabsPill.textContent = pillText;
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

// Enclenche l'un des chemins pour obtenir une position.
function requestGeolocation() {
  trackEvent('geoloc:click');
  if (!navigator.geolocation) {
    setLocationPromptMsg("Géolocalisation indisponible sur ce navigateur. Utilise le clic sur la carte.");
    return;
  }
  setLocationPromptMsg("Demande de position en cours…");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      applyUserPos(pos);
      trackEvent('geoloc:success');
    },
    (err) => {
      setLocationPromptMsg(
        err.code === 1
          ? "Permission refusée. Clique sur la carte pour indiquer ta position."
          : "Position introuvable. Clique sur la carte pour la choisir."
      );
      enableMapPicking();
      trackEvent(err.code === 1 ? 'geoloc:refus' : 'geoloc:echec');
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
  el.textContent = msg || "Position requise pour le tri par distance.";
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
// Retourne une Map<key, group> (la clé est stable et sert à réutiliser
// les marqueurs Leaflet d'un render à l'autre).
function groupByLocation(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.c.lat.toFixed(4)},${item.c.lon.toFixed(4)}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(item);
  }
  return groups;
}

// Signature d'un groupe : change chaque fois que quelque chose susceptible
// d'affecter l'icône ou le popup change (composition, ordre, statut passé).
// Permet de savoir quand mettre à jour un marqueur réutilisé.
function groupSignature(group) {
  const ids = group.map(({ c }) => c.id).sort().join('|');
  const past = group.map(({ c }) => isPast(c) ? '1' : '0').join('');
  return `${ids}#${past}`;
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
  // Défense en profondeur : ces valeurs viennent de constantes internes
  // (couleurs hex fixes, entiers), mais on garde une assertion stricte
  // pour refuser toute injection CSS si la source changeait un jour.
  if (!/^#[0-9a-f]{3,8}$/i.test(color)) {
    throw new Error('markerIcon: couleur invalide');
  }
  if (!Number.isFinite(border)) {
    throw new Error('markerIcon: border invalide');
  }
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
    t.addEventListener('click', () => {
      activateTab(t.dataset.tab);
      trackEvent('tab:' + t.dataset.tab);
    });
  });
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    const isActive = t.dataset.tab === name;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
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
    const v = sel.value; // "upcoming" | "past" | "habituelles" | "season:<index>"
    if (v === 'upcoming') {
      state.mode = 'upcoming';
      trackEvent('periode:a-venir');
    } else if (v === 'past') {
      state.mode = 'past';
      trackEvent('periode:passees');
    } else if (v === 'habituelles') {
      state.mode = 'habituelles';
      trackEvent('periode:habituelles');
      // Mode liste seul : si on est sur l'onglet Carte, basculer Liste auto.
      activateTab('list');
    } else if (v.startsWith('season:')) {
      state.mode = 'season';
      state.seasonIndex = parseInt(v.slice(7), 10);
      const label = state.seasons[state.seasonIndex]?.label || state.seasonIndex;
      trackEvent('periode:' + String(label).replace('/', '-'));
    }
    applyModeUI();
    render();
  });
}

// Active/désactive les éléments d'UI selon le mode courant.
// Mode 'habituelles' : carte affiche les ville-centrées + centroïdes des
// tournantes locales (R/D), liste avec en-tête explicatif. Filtre bassin
// et tri distance cachés (pas pertinents pour des compés non confirmées).
function applyModeUI() {
  const isHab = state.mode === 'habituelles';
  document.body.classList.toggle('mode-habituelles', isHab);
}

// Peuple dynamiquement les options "Saison XXXX/YY" depuis state.seasons.
// Les saisons sont listées de la plus récente à la plus ancienne
// (cohérent avec ce que l'utilisateur attend dans un menu déroulant).
function populateSeasonOptions() {
  const sel = document.getElementById('horizon');
  if (!sel || state.seasons.length === 0) return;
  // Retire les anciennes options de saison (idempotent en cas de reload data)
  sel.querySelectorAll('option[value^="season:"]').forEach((o) => o.remove());
  // Ordre : courante en premier, puis précédente
  const ordered = [...state.seasons].sort((a, b) => (a.start < b.start ? 1 : -1));
  for (const s of ordered) {
    const idx = state.seasons.indexOf(s);
    const opt = document.createElement('option');
    opt.value = `season:${idx}`;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
}

// --- Recherche ------------------------------------------------------------

function initSearch() {
  const input = document.getElementById('search');
  const form = document.getElementById('searchForm');
  // Debounce du tracking : 1 event par session de frappe, pas par touche.
  let searchTrackTimer = null;
  input.addEventListener('input', () => {
    state.search = normalize(input.value).trim();
    render();
    if (searchTrackTimer) clearTimeout(searchTrackTimer);
    if (state.search) {
      searchTrackTimer = setTimeout(() => trackEvent('recherche'), 1200);
    }
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
      trackEvent('bassin:' + btn.dataset.bassin);
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
    trackEvent('reload:click');
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
  // Timeout de 10 s : sur réseau mobile capricieux, mieux vaut afficher
  // une erreur claire que de laisser l'utilisateur regarder un spinner.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch('data/competitions.json', {
      cache: 'no-cache',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
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
  state.seasonIndex = findCurrentSeasonIndex();
  populateSeasonOptions();

  const comps = Array.isArray(data.competitions) ? data.competitions : [];
  state.all = comps.map(c => ({ c, dist: Infinity }));
  recomputeDistances();

  // Charger les prédictions "habituelles" en parallèle (ne bloque pas le rendu)
  // Soft-fail : si le fichier est absent ou invalide, on désactive l'onglet.
  loadPredictions().catch((err) => console.warn('predictions:', err.message));

  render();
}

async function loadPredictions() {
  try {
    const res = await fetch('data/predictions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.predictions = Array.isArray(data.predictions) ? data.predictions : [];
    if (state.mode === 'habituelles') render();
  } catch (err) {
    state.predictions = [];
  }
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
      trackEvent('tri:' + btn.dataset.sort);
    });
  });
}

// --- Render ---------------------------------------------------------------

function filteredCompetitions() {
  const today = todayIso();
  const q = state.search;

  let lower, upper;
  let onlyPast = false;
  if (state.mode === 'upcoming') {
    lower = today;
    upper = '9999-12-31';
  } else if (state.mode === 'past') {
    const cur = findCurrentSeason();
    lower = cur ? cur.start : '0000-00-00';
    upper = cur ? cur.end + '~' : '9999-12-31'; // on inclut le 31 août
    onlyPast = true;
  } else if (state.mode === 'season') {
    const s = state.seasons[state.seasonIndex];
    lower = s ? s.start : '0000-00-00';
    upper = s ? s.end + '~' : '9999-12-31'; // on inclut le 31 août
  }

  return state.all.filter(({ c }) => {
    if (c.dateDebut < lower || c.dateDebut > upper) return false;
    if (onlyPast && !(c.dateFin < today)) return false;
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
  if (state.mode === 'habituelles') {
    renderHabituellesMap();
    renderHabituelles();
    return;
  }
  renderMap();
  renderList();
}

function renderMap() {
  // Stratégie diff : on garde les marqueurs dont la clé lat,lon reste
  // visible et on ne touche qu'au nécessaire. Évite le flash sur un
  // simple changement de filtre et accélère le rendu mobile.
  const groupsMap = groupByLocation(filteredCompetitions());

  // 1. Retire les marqueurs des lieux qui ne sont plus visibles.
  for (const [key, entry] of state.markerGroups) {
    if (!groupsMap.has(key)) {
      state.map.removeLayer(entry.marker);
      state.markerGroups.delete(key);
    }
  }

  // 2. Pour chaque lieu visible : crée le marqueur s'il n'existe pas,
  //    sinon ne met à jour icône/popup que si la signature a changé.
  state.markers = {};
  for (const [key, group] of groupsMap) {
    const first = group[0].c;
    const sig = groupSignature(group);
    let entry = state.markerGroups.get(key);
    if (!entry) {
      const marker = L.marker([first.lat, first.lon], {
        icon: markerIcon(group)
      }).addTo(state.map);
      marker.bindPopup(popupGroupHtml(group), {
        maxWidth: 320,
        maxHeight: 400,
        autoPan: true
      });
      entry = { marker, sig };
      state.markerGroups.set(key, entry);
    } else if (entry.sig !== sig) {
      entry.marker.setIcon(markerIcon(group));
      entry.marker.setPopupContent(popupGroupHtml(group));
      entry.sig = sig;
    }
    for (const { c } of group) {
      state.markers[c.id] = entry.marker;
    }
  }
}

function renderList() {
  const list = document.getElementById('list');
  const items = filteredCompetitions().slice();

  // Sans position utilisateur, le tri par distance n'a pas de sens :
  // on bascule silencieusement sur date.
  const effectiveSort = state.userPos ? state.sortMode : 'date';

  if (effectiveSort === 'date') {
    items.sort((a, b) => a.c.dateDebut.localeCompare(b.c.dateDebut));
  } else {
    items.sort((a, b) => a.dist - b.dist);
  }

  setCompetitionCount(items.length);

  list.innerHTML = '';
  if (items.length === 0) {
    if (state.search) {
      list.innerHTML = `<li class="empty"><p class="empty-msg-1">Aucune compétition ne correspond à votre recherche.</p><p class="empty-msg-2"><span aria-hidden="true">⚠️</span> Elle n'est peut-être pas encore sur liveFFN.</p><button type="button" class="btn-secondary empty-info-btn">En savoir plus</button></li>`;
      const btnInfo = list.querySelector('.empty-info-btn');
      if (btnInfo) btnInfo.addEventListener('click', () => {
        document.getElementById('infoBtn').click();
      });
    } else {
      list.innerHTML = `<li class="empty">Aucune compétition maîtres dans cette fenêtre.</li>`;
    }
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
      trackEvent('liste:click');
      if (window.innerWidth < 960) activateTab('map');
      state.map.setView([c.lat, c.lon], 8);
      const m = state.markers[c.id];
      if (m) setTimeout(() => m.openPopup(), 100);
    });
    list.appendChild(li);
  });

  // Pied de liste : rappelle toujours que liveFFN est la source de vérité,
  // y compris quand aucun filtre/recherche n'est actif (ça couvre le cas où
  // l'utilisateur parcourt la liste sans requête précise).
  const hint = document.createElement('li');
  hint.className = 'search-hint';
  hint.innerHTML = `<p class="empty-msg-2"><span aria-hidden="true">⚠️</span> Si une compétition est manquante, c'est qu'elle n'est pas encore sur liveFFN.</p><button type="button" class="btn-secondary empty-info-btn">En savoir plus</button>`;
  hint.querySelector('.empty-info-btn').addEventListener('click', () => {
    document.getElementById('infoBtn').click();
  });
  list.appendChild(hint);
}

// Rendu de l'onglet "Habituelles" : compétitions récurrentes (présentes en
// N-1 + au moins 2 fois sur les 4 dernières saisons) non encore confirmées
// sur liveFFN pour la saison courante. Filtre bassin et tri distance cachés.
function renderHabituelles() {
  const list = document.getElementById('list');
  const search = state.search || '';
  let items = state.predictions.slice();
  if (search) {
    items = items.filter((p) => {
      const hay = `${p.nom} ${p.ville || ''} ${(p.recentCities || []).join(' ')}`.toLowerCase();
      return hay.includes(search);
    });
  }
  if (state.bassinFilter === '25') items = items.filter((p) => p.bassin === 25);
  else if (state.bassinFilter === '50') items = items.filter((p) => p.bassin === 50);
  items.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  setCompetitionCount(items.length);
  list.innerHTML = '';

  // En-tête explicatif au-dessus de la liste
  const header = document.createElement('li');
  header.className = 'habituelles-header';
  header.innerHTML = `<strong>Compétitions habituelles</strong> — récurrentes selon l'historique des 4 dernières saisons, mais pas encore confirmées sur liveFFN pour cette saison. Lieu et date estimés à partir des éditions précédentes.`;
  list.appendChild(header);

  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.innerHTML = `<p class="empty-msg-1">Aucune compétition habituelle attendue pour cette fin de saison.</p><p class="empty-msg-2">Les compétitions récurrentes ont déjà été ajoutées par leurs organisateurs sur liveFFN, ou la saison touche à sa fin.</p>`;
    list.appendChild(empty);
    return;
  }
  for (const p of items) {
    const li = document.createElement('li');
    li.className = 'habituelle-item';
    if (p.type === 'tournant') li.classList.add('habituelle-tournant');
    const code = p.championnatFrance ? 'F' : p.niveau;
    // Affiche la ville si présente (CF easter egg "Lapinland" ou ville-centrée).
    // Sinon "Lieu à confirmer" pour les tournantes locales sans hôte fixé.
    const lieuHtml = p.ville
      ? escapeHtml(p.ville)
      : `<span class="habituelle-lieu-tbd">Lieu à confirmer</span>`;
    const bassinHtml = p.bassin
      ? `<span class="bassin-tag">${p.bassin} m</span>`
      : '';
    const dateApprox = `${escapeHtml(p.moment)} ${escapeHtml(p.monthLabel)}`;
    // Pour les tournantes : montrer où ça a eu lieu les éditions précédentes
    let recentCitiesHtml = '';
    if (p.type === 'tournant' && Array.isArray(p.recentCities) && p.recentCities.length > 0) {
      const list = p.recentCities.map((v) => escapeHtml(v.toLowerCase().replace(/\b(\w)/g, (m) => m.toUpperCase()))).join(', ');
      recentCitiesHtml = `<p class="habituelle-recent">Précédentes éditions : ${list}</p>`;
    }
    li.innerHTML = `
      <span class="badge badge-${escapeHtml(code)}" title="${escapeHtml(p.niveauLibelle || code)}">${escapeHtml(code)}</span>
      <div class="info">
        <p class="name">${escapeHtml(p.nom)}</p>
        <p class="meta">
          <span class="meta-text">${lieuHtml} &middot; ${dateApprox}</span>
          ${bassinHtml}
        </p>
        ${recentCitiesHtml}
        <p class="habituelle-note">Compétition récurrente (vue en ${escapeHtml(p.seasonsLabel || p.confidence || '')}) — pas encore confirmée sur liveFFN.</p>
      </div>
    `;
    list.appendChild(li);
  }
}

// Carte en mode "Habituelles" : marqueurs orange pour les ville-centrées
// (à leur ville) et les tournantes locales (au centroïde des dernières
// éditions). Les CF ne sont pas placées sur la carte.
function renderHabituellesMap() {
  // Vide les marqueurs existants (transition depuis un autre mode)
  for (const [key, entry] of state.markerGroups) {
    state.map.removeLayer(entry.marker);
    state.markerGroups.delete(key);
  }
  state.markers = {};

  // Filtres recherche + bassin identiques à la liste
  const search = state.search || '';
  let items = state.predictions.slice();
  if (search) {
    items = items.filter((p) => {
      const hay = `${p.nom} ${p.ville || ''} ${(p.recentCities || []).join(' ')}`.toLowerCase();
      return hay.includes(search);
    });
  }
  if (state.bassinFilter === '25') items = items.filter((p) => p.bassin === 25);
  else if (state.bassinFilter === '50') items = items.filter((p) => p.bassin === 50);
  // Garde uniquement celles avec lat/lon (= excluant CF)
  items = items.filter((p) => p.lat != null && p.lon != null);

  for (const p of items) {
    const key = `hab:${p.id}`;
    const marker = L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: 'marker-wrapper',
        html: '<div class="marker-pill marker-habituelle" style="width:22px;height:22px;border-width:2px;font-size:0.85rem;display:flex;align-items:center;justify-content:center;border-radius:50%;border-style:solid;">?</div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -10],
      }),
    }).addTo(state.map);
    marker.bindPopup(habituellePopupHtml(p), { maxWidth: 320, autoPan: true });
    state.markerGroups.set(key, { marker, sig: 'hab' });
  }
}

function habituellePopupHtml(p) {
  const lieuTxt = p.ville
    ? escapeHtml(p.ville)
    : '<span class="habituelle-lieu-tbd">Lieu à confirmer</span>';
  const recentTxt = p.type === 'tournant' && Array.isArray(p.recentCities) && p.recentCities.length > 0
    ? `<div class="popup-recent">Précédentes éditions : ${escapeHtml(p.recentCities.map((v) => v.toLowerCase().replace(/\b(\w)/g, (m) => m.toUpperCase())).join(', '))}</div>`
    : '';
  const bassinTxt = p.bassin ? `<span class="bassin-tag">${p.bassin} m</span>` : '';
  return `
    <div class="popup popup-habituelle">
      <div class="popup-head">
        <strong>${escapeHtml(p.nom)}</strong>
      </div>
      <div>${lieuTxt} · ${escapeHtml(p.moment)} ${escapeHtml(p.monthLabel)} ${bassinTxt}</div>
      ${recentTxt}
      <div class="habituelle-note">Compétition récurrente (vue en ${escapeHtml(p.seasonsLabel || '')}) — pas encore confirmée sur liveFFN.</div>
    </div>
  `;
}

// --- Boot -----------------------------------------------------------------

// --- Modal "À propos" -----------------------------------------------------

function initInfoModal() {
  const btn = document.getElementById('infoBtn');
  const modal = document.getElementById('infoModal');
  const backdrop = document.getElementById('modalBackdrop');
  const closeBtn = document.getElementById('modalClose');
  const updatedEl = document.getElementById('modalUpdated');

  // AbortController dédié au listener keydown de la modal : à la fermeture
  // on abort() pour retirer proprement le listener (auto-nettoyant).
  let keyAbort = null;
  // Pour restaurer le focus après fermeture (accessibilité clavier).
  let previouslyFocused = null;

  function open() {
    trackEvent('modale:about:open');
    updatedEl.textContent = state.updatedText || 'date indisponible';
    updatedEl.classList.remove('warn', 'stale');
    if (state.updatedClass) updatedEl.classList.add(state.updatedClass);
    previouslyFocused = document.activeElement;
    modal.hidden = false;
    keyAbort = new AbortController();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    }, { signal: keyAbort.signal });
    // Focus sur le bouton fermer pour la navigation clavier.
    setTimeout(() => closeBtn.focus(), 0);
  }
  function close() {
    modal.hidden = true;
    if (keyAbort) { keyAbort.abort(); keyAbort = null; }
    // Restaure le focus sur l'élément qui a ouvert la modal.
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
  }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  // Tracking des liens sortants de la modale (formulaire, GitHub).
  modal.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.includes('docs.google.com/forms')) trackEvent('formulaire-ajout:click');
    else if (href.includes('github.com')) trackEvent('github:click');
  });
}

function initLegendClose() {
  const legend = document.getElementById('legend');
  const btn = document.getElementById('legendClose');
  if (!legend || !btn) return;
  btn.addEventListener('click', () => { legend.hidden = true; });
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
  initLegendClose();

  // Envoie un événement "device" une fois le script GoatCounter chargé
  // (async → on laisse 1.5 s pour être tranquille).
  setTimeout(() => {
    const isDesktop = window.matchMedia('(min-width: 960px)').matches;
    trackEvent(isDesktop ? 'device:desktop' : 'device:mobile');
  }, 1500);

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

  // Clic dans un popup : ferme le popup sauf si on a cliqué sur un lien
  // (le lien doit pouvoir ouvrir la page liveffn dans un nouvel onglet).
  // Motif : sur mobile le popup prend presque tout l'écran et masque la carte.
  state.map.on('popupopen', (e) => {
    trackEvent('popup:open');
    const el = e.popup.getElement();
    if (!el) return;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('a.item-link')) trackEvent('details-ffn:click');
      if (ev.target.closest('a')) return;
      state.map.closePopup();
    });
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
    console.error('[MasterMap] Échec du chargement de data/competitions.json', e);
    const msg = e && e.name === 'AbortError'
      ? 'Impossible de charger les données (délai dépassé). Réessayez plus tard.'
      : 'Impossible de charger les données, réessayez plus tard.';
    setError(msg);
    showLoadErrorBanner(msg);
  }
}

// Bannière d'erreur persistante en haut de page quand les données
// ne se chargent pas : plus visible qu'un simple message dans les panes.
function showLoadErrorBanner(msg) {
  let banner = document.getElementById('loadErrorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'loadErrorBanner';
    banner.className = 'load-error-banner';
    banner.setAttribute('role', 'alert');
    document.body.insertBefore(banner, document.body.firstChild);
  }
  banner.textContent = msg;
}

document.addEventListener('DOMContentLoaded', init);
