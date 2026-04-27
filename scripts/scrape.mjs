// Scraper FFN maîtres → data/competitions.json
// Node 22, stdlib pure, aucune dépendance npm.
//
// Pipeline :
//   1. Fetch les pages calendrier liveffn pour la fenêtre [N saisons précédentes,
//      now + FORWARD_HORIZON_MONTHS]. Cache mensuel pour les mois figés.
//   2. Parse HTML par regex, associe chaque compétition au dernier libelle_jour vu.
//   3. Filtre "maîtres" sur le libellé.
//   4. Dédoublonne par competitionId, calcule plage [dateDebut, dateFin].
//   5. Marque championnatFrance : regex "Championnat(s) de France ... maîtres".
//   6. Géocode les villes via Nominatim (cache persistant, 1 req/sec).
//   7. Écrit data/competitions.json + data/cities.json.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Résolution portable : la racine du projet est le parent du dossier scripts/.
// Fonctionne sur ton poste ET sur le runner GitHub Actions (chemins différents).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DATA_DIR = path.join(ROOT, "data");
const COMPETITIONS_PATH = path.join(DATA_DIR, "competitions.json");
const CITIES_PATH = path.join(DATA_DIR, "cities.json");
const POOL_SIZES_PATH = path.join(DATA_DIR, "pool_sizes.json");
const OVERRIDES_PATH = path.join(DATA_DIR, "cities_overrides.json");
const CALENDAR_CACHE_DIR = path.join(DATA_DIR, "calendar_cache");
const PREDICTIONS_PATH = path.join(DATA_DIR, "predictions.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");

// Fenêtre glissante de l'historique des runs (en millisecondes).
// Un run plus ancien que cette fenêtre est purgé à chaque écriture.
const HISTORY_WINDOW_MS = 3 * 30 * 24 * 60 * 60 * 1000; // ~3 mois

// Fenêtre glissante des passages du scraper conservés en tête de
// history.json (champ scraperRuns), affichée dans l'onglet "Passages"
// de la page Statut. À 2 passages/jour, 30 j ≈ 60 entrées (≈ 4 KB).
const SCRAPER_RUNS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Champs comparés entre 2 snapshots de competitions.json pour détecter les
// updates. lat/lon exclus volontairement : dérivés du géocodage, peuvent
// bouger sur reload du cache Nominatim sans qu'il y ait eu de vraie évolution.
const HISTORY_TRACKED_FIELDS = [
  "nom",
  "ville",
  "dateDebut",
  "dateFin",
  "niveau",
  "niveauLibelle",
  "championnatFrance",
  "bassin",
  "url",
];

// Cut-off de pertinence pour l'historique : on n'enregistre un changement
// (ajout/retrait/modif) que si la compétition concernée a lieu au plus
// HISTORY_RELEVANCE_DAYS jours avant la date du run (donc compés futures
// + tout juste passées). Évite que l'élargissement de la fenêtre de
// scraping crée des "ajouts" massifs de compés des saisons antérieures.
const HISTORY_RELEVANCE_DAYS = 7;

// User-Agent explicite pour les administrateurs de liveffn.com :
// - nom du projet clairement identifié (Couloir 4)
// - lien vers le site live (pour voir ce qu'on fait des données)
// - lien vers le repo (pour comprendre le code)
// - "issues" = canal de contact direct
const USER_AGENT =
  "Couloir4/1.0 (+https://www.couloir4.fr/; source https://github.com/bneel/master-map; contact via github issues)";

// Whitelist manuelle : Google Sheet publiée en CSV, une colonne `url`.
// Permet de rattraper des compétitions maîtres rejetées par le filtre titre
// (ex: "19e Meeting de Combs-la-Ville" — pas de mot "maîtres" dans le nom).
// URL en dur par défaut (sheet publique, stable). La variable d'env permet
// de surcharger pour tester avec une autre sheet. Soft-fail si inaccessible.
const MANUAL_SHEET_CSV_URL =
  process.env.MANUAL_SHEET_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTIFM8WzodikCJ26VeRZiSDblryGUuiWRIE4uQNSwPnH9fsJUuLa-Cv_EjA3X7UxnEtpM_Pz13P6SzV/pub?gid=0&single=true&output=csv";

// Nombre de saisons précédentes à inclure (en plus de la courante).
// 2 = saison N-2 + N-1 + courante → ~36 mois côté passé pour les stats.
// Le cache pool_sizes.json + calendar_cache/ évitent les re-fetch coûteux.
const SCRAPE_PREVIOUS_SEASONS = 2;

// Cache mensuel des pages calendrier liveffn : un mois M est immuable
// après M + 30 jours. Bypass via env RESCRAPE_FROZEN=1 (pour reprendre
// une éventuelle correction rétroactive côté liveffn).
const FROZEN_GRACE_DAYS = 30;
const RESCRAPE_FROZEN =
  process.env.RESCRAPE_FROZEN === "1" || process.env.RESCRAPE_FROZEN === "true";

// Pool sizes : endpoint sensible (a déjà déclenché un ban IP).
// Throttle conservateur : 10 s ± jitter entre chaque requête.
const POOL_DELAY_MS = 10000;
const POOL_JITTER_MS = 2000;
const POOL_403_BACKOFF_MS = 5 * 60 * 1000; // 5 min
const POOL_MAX_403_STREAK = 3;              // 3 × 403 consécutifs → stop
const POOL_FLUSH_EVERY = 30;                // re-write competitions.json tous les N fetches

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(base, amp) { return base + (Math.random() * 2 - 1) * amp; }

// Fetch avec timeout 30s et retry en backoff exponentiel sur 5xx/429/throw.
// Usage pour endpoints externes "best-effort" (liveffn calendrier, Nominatim).
// NE PAS utiliser pour fetchPoolSize : il gère lui-même les 403 (ban IP).
async function fetchWithRetry(url, options = {}, { retries = 3, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < retries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.warn(`[http] retry ${attempt + 1}/${retries} pour ${url} (status: ${res.status}), pause ${delay}ms`);
          await sleep(delay);
          continue;
        }
        return res; // dernier essai : on renvoie la réponse, l'appelant gère le !ok
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[http] retry ${attempt + 1}/${retries} pour ${url} (error: ${err.message}), pause ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Écriture atomique : write dans un .tmp puis rename. Évite un fichier
// tronqué/corrompu si le process crashe en plein writeFile.
async function atomicWriteFile(filePath, content) {
  const tmp = filePath + ".tmp";
  await writeFile(tmp, content);
  await rename(tmp, filePath);
}

// Clé d'indexation canonique pour le cache villes.
// La source peut envoyer "PARIS", "Paris", "Paris " — on unifie pour éviter
// les doublons cache et les cache miss à tort.
function normalizeCityKey(s) {
  return String(s ?? "").trim().toUpperCase();
}

// Overrides manuels de géocodage : pour les rares villes homonymes où
// Nominatim tombe sur la mauvaise (ex: Belleville Nancy vs Beaujolais).
// Fichier data/cities_overrides.json, format { "VILLE": { lat, lon, note } }.
// Soft-fail : fichier absent ou mal formé → pas d'override.
async function loadOverrides() {
  try {
    const txt = await readFile(OVERRIDES_PATH, "utf8");
    const raw = JSON.parse(txt);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.lat === "number" && typeof v.lon === "number") {
        out[normalizeCityKey(k)] = { lat: v.lat, lon: v.lon };
      }
    }
    return out;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.warn(`[overrides] lecture échouée: ${err.message}, skip`);
    return {};
  }
}

const NIVEAU_LIBELLE = {
  I: "International",
  N: "National",
  Z: "Interrégional (Zone)",
  R: "Régional",
  D: "Départemental",
};

// --- Utilitaires dates ---------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Retourne [{month, year}, ...] pour mois courant + (n-1) suivants.
function nextMonths(now, n) {
  const out = [];
  let m = now.getMonth(); // 0..11
  let y = now.getFullYear();
  for (let i = 0; i < n; i++) {
    out.push({ month: m + 1, year: y });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

// Début de la saison natation en cours (1er septembre).
// Saison = [1er sept Y, 31 août Y+1]. Si on est en sept-déc → saison = Y.
// Si on est en jan-août → saison = Y-1.
function seasonStart(now) {
  const m = now.getMonth();
  const y = now.getFullYear();
  return m >= 8 ? new Date(y, 8, 1) : new Date(y - 1, 8, 1);
}

// Début de la n-ème saison précédente (n=1 → saison juste avant la courante).
function nthPreviousSeasonStart(now, n) {
  const cs = seasonStart(now);
  return new Date(cs.getFullYear() - n, 8, 1);
}

// Génère la liste [{month, year}] de startDate à endDate inclus (par mois).
function monthsBetween(startDate, endDate) {
  const out = [];
  let y = startDate.getFullYear();
  let m = startDate.getMonth();
  while (y < endDate.getFullYear() || (y === endDate.getFullYear() && m <= endDate.getMonth())) {
    out.push({ month: m + 1, year: y });
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    if (out.length > 60) break; // garde-fou
  }
  return out;
}

// Horizon futur : analyse du 25/04/2026 → 90 % des compés maîtres futures
// sont annoncées ≤ 5 mois avant l'événement, max observé 160 j. 8 mois donne
// une marge confortable sans fetcher pour rien. Voir analyse dans la PR.
const FORWARD_HORIZON_MONTHS = 8;

// ISO "YYYY-MM-DD" depuis un Date (tz local, ce qui suffit pour des dates journalières)
function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function seasonLabel(startDate) {
  const y = startDate.getFullYear();
  return `${y}/${String(y + 1).slice(2)}`; // "2025/26"
}

// --- Cache mensuel des pages calendrier ---------------------------------
// Une fois passé M + FROZEN_GRACE_DAYS jours, le calendrier d'un mois ne
// bouge plus (aucune création post-événement détectée dans l'historique).
// On stocke un snapshot par mois figé dans data/calendar_cache/YYYY-MM.json
// et on évite ainsi 25-30 fetches HTTP par run au régime stationnaire.

function lastDayOfMonthDate(year, month) {
  // month = 1..12 → on prend le jour 0 du mois suivant = dernier jour de M.
  return new Date(year, month, 0);
}

function isMonthFrozen(year, month, today) {
  const cutoff = new Date(lastDayOfMonthDate(year, month));
  cutoff.setDate(cutoff.getDate() + FROZEN_GRACE_DAYS);
  return today > cutoff;
}

function calendarCachePath(year, month) {
  return path.join(CALENDAR_CACHE_DIR, `${year}-${pad2(month)}.json`);
}

async function loadCalendarMonthCache(year, month) {
  try {
    const txt = await readFile(calendarCachePath(year, month), "utf8");
    const data = JSON.parse(txt);
    if (!Array.isArray(data?.raw)) return null;
    return data.raw;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    console.warn(`[cache] lecture ${year}-${pad2(month)} échouée: ${err.message}, fallback fetch`);
    return null;
  }
}

async function saveCalendarMonthCache(year, month, raw) {
  await mkdir(CALENDAR_CACHE_DIR, { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    year,
    month,
    count: raw.length,
    raw,
  };
  await atomicWriteFile(
    calendarCachePath(year, month),
    JSON.stringify(payload, null, 2) + "\n",
  );
}

// --- Fetch + parse HTML liveffn -----------------------------------------

async function fetchMonthHtml(month, year) {
  const url =
    "https://www.liveffn.com/cgi-bin/calendrier_live_ajax.php" +
    `?action=select_mois&calendrier_mois=${pad2(month)}&calendrier_annee=${year}`;
  const res = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`FFN fetch ${pad2(month)}/${year} HTTP ${res.status}`);
  }
  return await res.text();
}

// Parse un mois de HTML → liste brute de compétitions.
// Un seul passage regex global qui matche alternativement :
//   - libelle_jour : "Samedi 04"
//   - ancre compétition : href avec competition=ID + classe calendrier_liveX + libelle_live
// On garde le dernier libelle_jour vu comme contexte.
function parseMonthHtml(html, month, year) {
  const pattern = new RegExp(
    [
      // Groupe 1 : libelle_jour
      `<span class="libelle_jour">([^<]+)</span>`,
      "|",
      // Groupes 2..4 : competitionId, niveau, libelle
      `<a[^>]*href="[^"]*competition=(\\d+)[^"]*"[\\s\\S]{0,2000}?`,
      `<div class="calendrier_live([INZRD])">`,
      `\\s*<span class="libelle_live">([^<]+)</span>`,
    ].join(""),
    "g",
  );

  const out = [];
  let currentJour = null; // string ex "Samedi 04"
  let m;
  while ((m = pattern.exec(html)) !== null) {
    if (m[1] !== undefined) {
      currentJour = m[1].trim();
      continue;
    }
    const competitionId = m[2];
    const niveau = m[3];
    const libelle = decodeEntities(m[4].trim());
    // Extraire le "04" de "Samedi 04"
    const dayMatch = currentJour ? currentJour.match(/(\d{1,2})/) : null;
    if (!dayMatch) continue;
    const day = pad2(parseInt(dayMatch[1], 10));
    const dateIso = `${year}-${pad2(month)}-${day}`;
    out.push({ competitionId, niveau, libelle, dateIso });
  }
  return out;
}

// Décodage minimal des entités HTML qu'on peut croiser dans les libellés.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&ecirc;/g, "ê")
    .replace(/&agrave;/g, "à")
    .replace(/&acirc;/g, "â")
    .replace(/&ccedil;/g, "ç")
    .replace(/&ocirc;/g, "ô")
    .replace(/&ucirc;/g, "û")
    .replace(/&ugrave;/g, "ù")
    .replace(/&icirc;/g, "î")
    .replace(/&iuml;/g, "ï");
}

// --- Whitelist manuelle (Google Sheet en CSV) ---------------------------

async function loadManualIds() {
  if (!MANUAL_SHEET_CSV_URL) {
    console.log("[manual] MANUAL_SHEET_CSV_URL non défini, skip");
    return new Set();
  }
  let csv;
  try {
    const res = await fetch(MANUAL_SHEET_CSV_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[manual] HTTP ${res.status} sur la sheet, skip`);
      return new Set();
    }
    csv = await res.text();
  } catch (err) {
    console.warn(`[manual] fetch sheet échoué: ${err.message}, skip`);
    return new Set();
  }
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ids = new Set();
  let isHeader = true;
  for (const line of lines) {
    if (isHeader) { isHeader = false; continue; }
    const url = line.replace(/^"|"$/g, "");
    const m = url.match(/competition=(\d+)/);
    if (m) ids.add(m[1]);
    else console.warn(`[manual] ligne ignorée (pas d'id liveffn): ${line}`);
  }
  console.log(`[manual] ${ids.size} ids chargés depuis la sheet`);
  return ids;
}

// --- Filtrage maîtres + parsing libellé ---------------------------------

const MAITRES_RE = /\b(ma[iî]tres?|masters?)\b/i;

// Championnat(s) de France — sur une compétition déjà filtrée comme "maîtres"
// (soit par le filtre titre liveffn, soit via la whitelist manuelle). On n'a
// donc plus besoin d'exiger "maîtres" dans le nom : ça permet de badger F
// les CF dont le nom ne mentionne pas explicitement "maîtres"
// (ex. "XXXVIIIe Championnats de France Été Open" à Mulhouse, validé manuellement).
const CHAMPIONNAT_FRANCE_RE = /championnat[s]?\s+de\s+france\b/i;

// Marqueurs textuels de compétition hors France dans le libellé.
// Les compétitions matchant ce pattern sont inscrites au calendrier FFN
// mais se déroulent à l'étranger (ex. "Tunisian Open Masters - RADES").
const FOREIGN_RE =
  /\b(tunisien|tunisian|tunisie|maroc|morocc|marocain|algér|algerien|belg|suisse|swiss|luxembourg|québec|quebec|canad|espagn|spanish|italien|italian|britann|britis|allemand|german|néerland|dutch)/i;

function isMaitres(libelle) {
  return MAITRES_RE.test(libelle);
}

function isChampionnatFrance(libelle) {
  return CHAMPIONNAT_FRANCE_RE.test(libelle);
}

function isForeign(libelle) {
  return FOREIGN_RE.test(libelle);
}

// Seuil d'importance Nominatim en dessous duquel on considère que la ville
// n'est probablement pas vraiment en France (match sur hameau obscur).
const MIN_IMPORTANCE = 0.3;

// Split sur la DERNIÈRE occurrence de " - ".
function splitNomVille(libelle) {
  const idx = libelle.lastIndexOf(" - ");
  if (idx === -1) {
    return { nom: libelle.trim(), ville: "" };
  }
  return {
    nom: libelle.slice(0, idx).trim(),
    ville: libelle.slice(idx + 3).trim(),
  };
}

// --- Dédoublonnage ------------------------------------------------------

function dedupeCompetitions(raw) {
  const byId = new Map();
  for (const r of raw) {
    const existing = byId.get(r.competitionId);
    if (!existing) {
      const { nom, ville } = splitNomVille(r.libelle);
      byId.set(r.competitionId, {
        id: r.competitionId,
        nom,
        ville,
        dateDebut: r.dateIso,
        dateFin: r.dateIso,
        niveau: r.niveau,
        niveauLibelle: NIVEAU_LIBELLE[r.niveau] ?? "Inconnu",
        championnatFrance: isChampionnatFrance(r.libelle),
        foreign: isForeign(r.libelle),
        url: `https://www.liveffn.com/cgi-bin/index.php?competition=${r.competitionId}`,
      });
    } else {
      if (r.dateIso < existing.dateDebut) existing.dateDebut = r.dateIso;
      if (r.dateIso > existing.dateFin) existing.dateFin = r.dateIso;
    }
  }
  return [...byId.values()];
}

// --- Géocodage Nominatim ------------------------------------------------

async function loadCitiesCache() {
  let raw;
  try {
    const txt = await readFile(CITIES_PATH, "utf8");
    raw = JSON.parse(txt);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  // Ré-indexe les clés via normalizeCityKey. En cas de collision
  // ("PARIS" vs "Paris"), on garde l'entrée avec la plus grande importance
  // (fallback : la première rencontrée si importance null).
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const nk = normalizeCityKey(k);
    if (!(nk in out)) {
      out[nk] = v;
      continue;
    }
    const existing = out[nk];
    const ei = existing && existing.importance != null ? existing.importance : -Infinity;
    const ni = v && v.importance != null ? v.importance : -Infinity;
    if (ni > ei) out[nk] = v;
  }
  return out;
}

async function geocodeCity(city) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?city=${encodeURIComponent(city)}&countrycodes=fr&format=json&limit=1`;
  const res = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Nominatim HTTP ${res.status} pour ${city}`);
  }
  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) {
    return { lat: null, lon: null, importance: null };
  }
  const top = json[0];
  return {
    lat: parseFloat(top.lat),
    lon: parseFloat(top.lon),
    importance:
      typeof top.importance === "number"
        ? top.importance
        : top.importance != null
          ? parseFloat(top.importance)
          : null,
  };
}

// --- Cache des tailles de bassin (page détail de chaque compétition) ----

async function loadPoolSizesCache() {
  try {
    const txt = await readFile(POOL_SIZES_PATH, "utf8");
    return JSON.parse(txt);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

// Regex sur le titre : "… - 25 m" ou "… - 50 m"
const POOL_SIZE_RE = / - (25|50) m(?!\w)/;

async function fetchPoolSize(competitionId) {
  const url = `https://www.liveffn.com/cgi-bin/index.php?competition=${competitionId}`;
  // On n'envoie PAS de Referer bidon (pointer sur liveffn serait mentir).
  // Le User-Agent identifie clairement le projet.
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (res.status === 403) throw new Error("HTTP 403");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const m = POOL_SIZE_RE.exec(html);
  return m ? parseInt(m[1], 10) : null;
}

async function flushPoolCache(cache) {
  const sorted = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
  await atomicWriteFile(POOL_SIZES_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

// `writeCompetitions` : callback fournie par main() qui re-génère
// competitions.json avec l'état actuel des bassins. Permet de flusher
// périodiquement pendant un long run.
async function enrichPoolSizes(competitions, cache, writeCompetitions) {
  // Attacher bassin depuis le cache AVANT le fetch (null pour les nouveaux)
  for (const c of competitions) {
    c.bassin = c.id in cache ? cache[c.id] : null;
  }

  const toFetch = competitions.filter((c) => !(c.id in cache));
  const hits = competitions.length - toFetch.length;
  console.log(`[pool] cache hit: ${hits} compétitions`);
  if (toFetch.length === 0) return;
  const estMin = Math.ceil((toFetch.length * (POOL_DELAY_MS / 1000)) / 60);
  console.log(`[pool] cache miss: ${toFetch.length} pages à fetcher (~${estMin} min au throttle ${POOL_DELAY_MS / 1000}s)`);

  let consecutive403 = 0;
  let fetchedThisRun = 0;
  let i = 0;
  while (i < toFetch.length) {
    const c = toFetch[i];
    if (fetchedThisRun > 0 || i > 0) {
      await sleep(jitter(POOL_DELAY_MS, POOL_JITTER_MS));
    }
    try {
      const size = await fetchPoolSize(c.id);
      cache[c.id] = size;
      c.bassin = size;
      await flushPoolCache(cache);
      consecutive403 = 0;
      fetchedThisRun++;
      const tag = size == null ? "null" : `${size} m`;
      console.log(`[pool] ${c.id} (${c.ville}) → ${tag}  [${fetchedThisRun}/${toFetch.length}]`);
      // Flush competitions.json périodiquement pour que l'utilisateur
      // voie les bassins apparaître progressivement sans attendre la fin.
      if (fetchedThisRun % POOL_FLUSH_EVERY === 0) {
        await writeCompetitions();
        console.log(`[pool] flush competitions.json (progression visible côté site)`);
      }
      i++;
    } catch (err) {
      if (err.message === "HTTP 403") {
        consecutive403++;
        console.log(`[pool] 403 sur ${c.id} (streak ${consecutive403}/${POOL_MAX_403_STREAK})`);
        if (consecutive403 >= POOL_MAX_403_STREAK) {
          console.log(`[pool] ${POOL_MAX_403_STREAK} × 403 consécutifs → arrêt propre. Progression sauvegardée, reprendra au prochain run.`);
          break;
        }
        console.log(`[pool] pause ${POOL_403_BACKOFF_MS / 60000} min avant retry de la même page…`);
        await sleep(POOL_403_BACKOFF_MS);
        // Ne pas incrémenter i : on retente la même compétition.
      } else {
        console.log(`[pool] erreur ${c.id}: ${err.message} (pas de cache, retenté au prochain run)`);
        i++; // on passe à la suivante
      }
    }
  }
  // Flush final
  await writeCompetitions();
}

async function geocodeAll(cities, cache) {
  const hits = [];
  const misses = [];
  for (const city of cities) {
    if (!city) continue;
    if (Object.prototype.hasOwnProperty.call(cache, normalizeCityKey(city))) {
      hits.push(city);
    } else {
      misses.push(city);
    }
  }
  console.log(`[geo] cache hit: ${hits.length} villes`);
  const estimatedSec = Math.ceil(misses.length * 2);
  console.log(
    `[geo] cache miss: ${misses.length} villes à géocoder (~${estimatedSec} sec)`,
  );

  // Throttle 2s entre requêtes Nominatim (plus respectueux que les 1s
  // minimum de leur ToS, aligné avec le throttle du calendrier liveffn).
  const GEO_DELAY_MS = 2000;
  for (let i = 0; i < misses.length; i++) {
    const city = misses[i];
    if (i > 0) await sleep(GEO_DELAY_MS);
    try {
      const r = await geocodeCity(city);
      cache[normalizeCityKey(city)] = r;
      if (r.lat == null) {
        console.log(`[geo] ${city} → aucun résultat`);
      } else {
        console.log(
          `[geo] ${city} → ${r.lat}, ${r.lon} (importance ${
            r.importance != null ? r.importance.toFixed(2) : "?"
          })`,
        );
        if (r.importance != null && r.importance < 0.3) {
          console.log(
            `[geo] warning: ${city} importance ${r.importance.toFixed(2)} (vérifier)`,
          );
        }
      }
    } catch (err) {
      console.log(`[geo] erreur ${city}: ${err.message} (pas de cache)`);
    }
  }
}

// --- Historique des runs ------------------------------------------------
// Suit les ajouts/retraits/modifications de compétitions entre 2 runs
// successifs du scraper. Alimente data/history.json, lu par statut.html.

// Lit le snapshot précédent de competitions.json pour servir de base au
// diff. Soft-fail : fichier absent, JSON invalide, schéma surprenant → on
// part avec une liste vide (le diff produira potentiellement des "added"
// pour tout ce qui existe, ce qui reste vrai au sens de "ce qu'on n'avait
// pas avant").
async function loadPreviousCompetitions() {
  try {
    const txt = await readFile(COMPETITIONS_PATH, "utf8");
    const data = JSON.parse(txt);
    return Array.isArray(data?.competitions) ? data.competitions : [];
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[history] lecture snapshot précédent échouée: ${err.message}, on part de vide`);
    }
    return [];
  }
}

// Construit le payload "compact" d'une compétition pour l'historique.
// Champs HISTORY_TRACKED_FIELDS uniquement → garde history.json léger.
function historyEntryFor(c) {
  const out = { id: c.id };
  for (const f of HISTORY_TRACKED_FIELDS) out[f] = c[f] ?? null;
  return out;
}

// Calcule added/removed/updated entre 2 listes de compétitions.
function diffCompetitions(prev, next) {
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const nextById = new Map(next.map((c) => [c.id, c]));
  const added = [];
  const removed = [];
  const updated = [];
  for (const [id, c] of nextById) {
    if (!prevById.has(id)) added.push(historyEntryFor(c));
  }
  for (const [id, c] of prevById) {
    if (!nextById.has(id)) removed.push(historyEntryFor(c));
  }
  for (const [id, after] of nextById) {
    const before = prevById.get(id);
    if (!before) continue;
    const changes = [];
    for (const f of HISTORY_TRACKED_FIELDS) {
      const a = before[f] ?? null;
      const b = after[f] ?? null;
      if (a !== b) changes.push({ field: f, from: a, to: b });
    }
    if (changes.length > 0) {
      updated.push({
        id,
        nom: after.nom,
        ville: after.ville,
        dateDebut: after.dateDebut,
        changes,
      });
    }
  }
  return { added, removed, updated };
}

// Cutoff "compé pertinente au moment du run" :
// dateDebut >= (jour du run - HISTORY_RELEVANCE_DAYS).
function relevanceCutoffIso(runDate) {
  const d = new Date(runDate);
  d.setUTCDate(d.getUTCDate() - HISTORY_RELEVANCE_DAYS);
  return d.toISOString().slice(0, 10);
}

function isCompRelevantAtRun(entry, cutoffIso) {
  // Pas de date connue : on garde par sécurité (cas rare).
  if (!entry || !entry.dateDebut) return true;
  return entry.dateDebut >= cutoffIso;
}

async function updateHistory(previousCompetitions, currentCompetitions, now) {
  const rawDiff = diffCompetitions(previousCompetitions, currentCompetitions);
  const cutoffIso = relevanceCutoffIso(now);
  const diff = {
    added:   rawDiff.added.filter((c) => isCompRelevantAtRun(c, cutoffIso)),
    removed: rawDiff.removed.filter((c) => isCompRelevantAtRun(c, cutoffIso)),
    updated: rawDiff.updated.filter((u) => isCompRelevantAtRun(u, cutoffIso)),
  };
  const counts = {
    added: diff.added.length,
    removed: diff.removed.length,
    updated: diff.updated.length,
  };
  const totalChanges = counts.added + counts.removed + counts.updated;

  // Charge l'historique existant : runs détaillés + 5 derniers passages.
  let history = { generatedAt: null, scraperRuns: [], runs: [] };
  try {
    const txt = await readFile(HISTORY_PATH, "utf8");
    const data = JSON.parse(txt);
    history = {
      generatedAt: data?.generatedAt ?? null,
      scraperRuns: Array.isArray(data?.scraperRuns) ? data.scraperRuns : [],
      runs: Array.isArray(data?.runs) ? data.runs : [],
    };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[history] lecture échouée: ${err.message}, on repart de vide`);
    }
  }

  // Toujours mettre à jour scraperRuns (tous les passages dans la fenêtre
  // glissante, même sans changement), pour l'onglet "Passages" de la page
  // Statut.
  const runsCutoffMs = now.getTime() - SCRAPER_RUNS_WINDOW_MS;
  const scraperRuns = [
    { scrapedAt: now.toISOString(), counts },
    ...history.scraperRuns,
  ].filter((r) => {
    const t = Date.parse(r.scrapedAt);
    return Number.isFinite(t) && t >= runsCutoffMs;
  });

  // runs détaillés : on n'ajoute une entrée que s'il y a au moins un
  // changement pertinent, et on purge ce qui dépasse la fenêtre.
  const cutoffMs = now.getTime() - HISTORY_WINDOW_MS;
  let runs = history.runs.filter((r) => {
    const t = Date.parse(r.scrapedAt);
    return Number.isFinite(t) && t >= cutoffMs;
  });
  if (totalChanges > 0) {
    runs = [
      {
        scrapedAt: now.toISOString(),
        counts,
        added: diff.added,
        removed: diff.removed,
        updated: diff.updated,
      },
      ...runs,
    ];
  }

  const output = {
    generatedAt: now.toISOString(),
    scraperRuns,
    runs,
  };
  await atomicWriteFile(HISTORY_PATH, JSON.stringify(output, null, 2) + "\n");
  if (totalChanges > 0) {
    console.log(
      `[history] run enregistré (+${counts.added} -${counts.removed} ~${counts.updated}), ${runs.length} runs en fenêtre`,
    );
  } else {
    console.log("[history] aucun changement pertinent, scraperRuns mis à jour");
  }
}

// --- main ---------------------------------------------------------------

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  // Snapshot précédent lu AVANT toute écriture, pour produire le diff
  // (added/removed/updated) qui alimente data/history.json à la fin du run.
  const previousSnapshot = await loadPreviousCompetitions();

  const now = new Date();
  // Plage : début de la N-ième saison précédente (SCRAPE_PREVIOUS_SEASONS)
  // jusqu'à now + FORWARD_HORIZON_MONTHS mois.
  const rangeStart =
    SCRAPE_PREVIOUS_SEASONS > 0
      ? nthPreviousSeasonStart(now, SCRAPE_PREVIOUS_SEASONS)
      : seasonStart(now);
  const rangeEnd = new Date(now.getFullYear(), now.getMonth() + FORWARD_HORIZON_MONTHS, 1);
  const months = monthsBetween(rangeStart, rangeEnd);

  // 1. Fetch + parse, avec cache mensuel pour les mois figés
  // (cf. CALENDAR_CACHE_DIR). Throttle 2s entre fetches HTTP réels uniquement,
  // pas entre cache hits.
  if (RESCRAPE_FROZEN) {
    console.log("[cache] RESCRAPE_FROZEN=1 → bypass du cache mensuel, refetch complet");
  }
  const CAL_DELAY_MS = 2000;
  const rawAll = [];
  const rawMaitres = [];
  let cacheHits = 0;
  let httpFetches = 0;
  for (let i = 0; i < months.length; i++) {
    const { month, year } = months[i];
    const frozen = isMonthFrozen(year, month, now);
    let raw = null;

    if (frozen && !RESCRAPE_FROZEN) {
      raw = await loadCalendarMonthCache(year, month);
      if (raw) {
        cacheHits++;
        console.log(
          `[cache] ${year}-${pad2(month)} (figé)  ${raw.length} compétitions brutes (cache)`,
        );
      }
    }
    if (raw === null) {
      if (httpFetches > 0) await sleep(CAL_DELAY_MS);
      const html = await fetchMonthHtml(month, year);
      raw = parseMonthHtml(html, month, year);
      httpFetches++;
      console.log(
        `[fetch] ${year}-${pad2(month)} ${frozen ? "(figé)" : "(actif)"}  ${raw.length} compétitions brutes`,
      );
      if (frozen) {
        await saveCalendarMonthCache(year, month, raw);
      }
    }
    const maitres = raw.filter((r) => isMaitres(r.libelle));
    rawAll.push(...raw);
    rawMaitres.push(...maitres);
  }
  console.log(
    `[scrape] calendrier : ${months.length} mois (${cacheHits} cache, ${httpFetches} HTTP)`,
  );

  // 1b. Rattrapage manuel : ré-injecter les ids présents dans la whitelist
  // Sheet mais filtrés par isMaitres (faux négatifs du filtre par nom).
  const manualIds = await loadManualIds();
  if (manualIds.size > 0) {
    const collected = new Set(rawMaitres.map((r) => r.competitionId));
    let added = 0;
    const missing = [];
    for (const id of manualIds) {
      if (collected.has(id)) continue;
      const found = rawAll.find((r) => r.competitionId === id);
      if (found) {
        rawMaitres.push(found);
        collected.add(id);
        added++;
        console.log(`[manual] +${id} : ${found.libelle}`);
      } else {
        missing.push(id);
      }
    }
    console.log(`[manual] ${added} compétitions ajoutées (rattrapage filtre titre)`);
    if (missing.length > 0) {
      console.warn(`[manual] WARN ${missing.length} ids introuvables dans la fenêtre scrapée: ${missing.join(", ")}`);
    }
  }

  // 2. Dédoublonnage
  const competitions = dedupeCompetitions(rawMaitres);
  console.log(
    `[scrape] ${competitions.length} compétitions maîtres après dédoublonnage`,
  );

  // 3. Fenêtre temporelle : [début de saison précédente, borne sup du scrape)
  const lower = isoDate(rangeStart);
  const upper = isoDate(rangeEnd);
  const filtered = competitions.filter(
    (c) => c.dateDebut >= lower && c.dateDebut < upper,
  );
  if (filtered.length !== competitions.length) {
    console.log(
      `[scrape] ${competitions.length - filtered.length} compétitions hors fenêtre écartées`,
    );
  }

  // 4. Géocodage
  const cache = await loadCitiesCache();
  const uniqueCities = [...new Set(filtered.map((c) => c.ville).filter(Boolean))];
  await geocodeAll(uniqueCities, cache);

  // 5. Enrichissement : lat/lon depuis le cache, avec filtre France.
  // Une compétition est considérée hors France si :
  //   - son libellé mentionne explicitement un autre pays (isForeign), OU
  //   - l'importance Nominatim est trop basse (hameau bricolé par
  //     countrycodes=fr alors que la vraie ville est ailleurs).
  // Dans ces deux cas on écarte la compétition (lat/lon restent null,
  // et le filtrage final la retire du JSON).
  const overrides = await loadOverrides();
  if (Object.keys(overrides).length > 0) {
    console.log(`[overrides] ${Object.keys(overrides).length} villes avec coordonnées forcées`);
  }
  let droppedForeign = 0;
  let overridden = 0;
  for (const c of filtered) {
    const key = normalizeCityKey(c.ville);
    const ov = overrides[key];
    if (ov && !c.foreign) {
      c.lat = ov.lat;
      c.lon = ov.lon;
      overridden++;
      continue;
    }
    const g = cache[key];
    const importanceTooLow =
      g && g.importance != null && g.importance < MIN_IMPORTANCE;
    if (c.foreign || importanceTooLow || !g || g.lat == null) {
      c.lat = null;
      c.lon = null;
      if (c.foreign || importanceTooLow) droppedForeign++;
    } else {
      c.lat = g.lat;
      c.lon = g.lon;
    }
  }
  if (overridden > 0) {
    console.log(`[overrides] ${overridden} compétitions repositionnées`);
  }

  // 6. Filtrage final : on retire les compétitions sans géocodage France.
  const kept = filtered.filter((c) => c.lat != null && c.lon != null);
  if (droppedForeign > 0) {
    console.log(
      `[scrape] ${droppedForeign} compétitions hors France retirées`,
    );
  }
  kept.sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));

  // 6b. Préparation des métadonnées saisons + sauvegarde PRÉCOCE de
  // competitions.json (sans bassins encore, pour que le site voie les données
  // tout de suite). Le fetch des bassins peut ensuite prendre des dizaines
  // de minutes sans gêner l'utilisateur.
  const cs = seasonStart(now);
  // Liste : N saisons précédentes (de la plus ancienne à la plus récente)
  // puis la saison courante. Ordre = chronologique croissant.
  const seasons = [];
  for (let i = SCRAPE_PREVIOUS_SEASONS; i >= 1; i--) {
    const s = nthPreviousSeasonStart(now, i);
    seasons.push({
      id: `${s.getFullYear()}-${s.getFullYear() + 1}`,
      label: seasonLabel(s),
      start: isoDate(s),
      end: `${s.getFullYear() + 1}-08-31`,
    });
  }
  seasons.push({
    id: `${cs.getFullYear()}-${cs.getFullYear() + 1}`,
    label: seasonLabel(cs),
    start: isoDate(cs),
    end: `${cs.getFullYear() + 1}-08-31`,
    current: true,
  });

  async function writeCompetitions() {
    const output = {
      generatedAt: new Date().toISOString(),
      seasons,
      competitions: kept.map((c) => ({
        id: c.id,
        nom: c.nom,
        ville: c.ville,
        dateDebut: c.dateDebut,
        dateFin: c.dateFin,
        niveau: c.niveau,
        niveauLibelle: c.niveauLibelle,
        championnatFrance: c.championnatFrance,
        bassin: c.bassin ?? null,
        lat: c.lat,
        lon: c.lon,
        url: c.url,
      })),
    };
    await atomicWriteFile(COMPETITIONS_PATH, JSON.stringify(output, null, 2) + "\n");
  }

  // Pré-charger les bassins déjà en cache (pour l'écriture précoce)
  const poolCache = await loadPoolSizesCache();
  for (const c of kept) {
    c.bassin = c.id in poolCache ? poolCache[c.id] : null;
  }

  // Flush cities.json tout de suite (pas coûteux)
  const sortedCache = {};
  for (const k of Object.keys(cache).sort()) sortedCache[k] = cache[k];
  await atomicWriteFile(CITIES_PATH, JSON.stringify(sortedCache, null, 2) + "\n");

  // Première écriture de competitions.json → le site voit tout de suite.
  await writeCompetitions();
  console.log(`[scrape] competitions.json écrit tôt (${kept.length} comp, bassins depuis cache)`);

  // 6c. Enrichissement bassins (long, peut durer ~40 min au throttle 10s).
  await enrichPoolSizes(kept, poolCache, writeCompetitions);

  // 7. Écriture finale (au cas où le dernier flush périodique n'a pas eu lieu)
  await writeCompetitions();
  await flushPoolCache(poolCache);

  // 7b. Mise à jour de l'historique : diff entre l'ancien et le nouveau
  // snapshot. N'enregistre un run que s'il y a au moins un changement.
  // Filet : un bug ici ne doit pas faire planter le scraper, les données
  // principales (competitions.json, pool_sizes.json) sont déjà écrites.
  try {
    await updateHistory(previousSnapshot, kept, now);
  } catch (err) {
    console.warn(`[history] erreur updateHistory: ${err.message} (ignoré)`);
  }

  const bassin25 = kept.filter(c => c.bassin === 25).length;
  const bassin50 = kept.filter(c => c.bassin === 50).length;
  const bassinNull = kept.filter(c => c.bassin == null).length;
  console.log(
    `[scrape] final: competitions.json (${kept.length} comp : ${bassin25}×25m, ${bassin50}×50m, ${bassinNull}×null), cities.json (${Object.keys(sortedCache).length}), pool_sizes.json (${Object.keys(poolCache).length})`,
  );

  // 8. Prédictions des compétitions "habituelles" (récurrentes non encore confirmées
  //    sur liveffn pour la saison courante). Lit l'ensemble des snapshots
  //    calendar_cache/ pour bénéficier d'un historique étendu (jusqu'à 6 saisons).
  await generatePredictions(kept, poolCache, cache, overrides, now);
}

// --- Prédictions "Habituelles" -------------------------------------------
// Une compétition récurrente est identifiée par sa présence sur ≥ 4 saisons
// (sur 6 max disponibles). On match différemment selon le type :
//   - Tournante (championnat, régional, départemental, interclub, finale,
//     coupe de france) : la ville change chaque année → match (niveau,
//     fingerprint nom, mois) ±21 j de tolérance.
//   - Ville-centrée (meeting de club, etc.) : la ville est l'identité →
//     match (ville, niveau) ±21 j.
// On filtre ensuite les séries déjà confirmées dans la saison courante
// (pour éviter le doublon avec "À venir") et celles dont la date estimée
// est passée depuis > FROZEN_GRACE_DAYS jours (probablement annulées).

const TOURNANT_RE =
  /championn?at?s?|régional|regional|départemental|departemental|interclub|finale|coupe de france/i;

function isTournant(c) {
  if (c.championnatFrance === true) return true;
  return TOURNANT_RE.test(c.nom || "");
}

function canonicalize(nom) {
  return String(nom)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    // numéros arabes : "1er", "12e", "12ème", "12es"
    .replace(/^\d+\s*(?:es|ères?|ieres?|ière?|eme|ème|er|nd|rd|st|th|e)\b\s*/i, "")
    // numéros romains : "Ve", "XIVe", "XXXVIIes", "IIIèmes"
    .replace(/^[ivx]+\s*(?:es|èmes?|emes?|e)?\b\s*/i, "")
    .replace(/[.,;:'"()\[\]\-]/g, " ")
    .replace(/\b(maîtres?|maitres?|masters?|open|france|de|du|des|d|la|le|les|en|au|aux|et|nat|natation)\b/gi, "")
    .replace(/\s+/g, " ").trim();
}

function fingerprint(nom) {
  // Retire le "s" final de chaque mot (championnat/championnats → championnat)
  // pour rendre singulier/pluriel équivalents au matching.
  return canonicalize(nom)
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => w.replace(/s$/, ""))
    .slice(0, 5)
    .sort()
    .join("_");
}

function dayOfYear(iso) {
  const d = new Date(iso);
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

function circDist(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 365 - d);
}

function splitNomVilleLocal(libelle) {
  const idx = libelle.lastIndexOf(" - ");
  if (idx === -1) return { nom: libelle.trim(), ville: "" };
  return { nom: libelle.slice(0, idx).trim(), ville: libelle.slice(idx + 3).trim().toUpperCase() };
}

// Charge tous les snapshots calendar_cache + extrait les compés maîtres dédupliquées
async function loadHistoricalMaitres() {
  const { readdir } = await import("node:fs/promises");
  let files = [];
  try {
    files = (await readdir(CALENDAR_CACHE_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const dedup = new Map();
  for (const f of files) {
    let payload;
    try {
      payload = JSON.parse(await readFile(path.join(CALENDAR_CACHE_DIR, f), "utf8"));
    } catch (err) {
      console.warn(`[predict] snapshot ${f} illisible: ${err.message}`);
      continue;
    }
    if (!Array.isArray(payload?.raw)) continue;
    for (const r of payload.raw) {
      if (!isMaitres(r.libelle)) continue;
      const decoded = decodeEntities(r.libelle);
      if (isForeign(decoded)) continue; // exclut Tunisian Open, etc.
      const { nom, ville } = splitNomVilleLocal(decoded);
      const id = r.competitionId;
      if (!dedup.has(id)) {
        dedup.set(id, {
          id,
          niveau: r.niveau,
          nom,
          ville,
          dateDebut: r.dateIso,
          dateFin: r.dateIso,
          championnatFrance: isChampionnatFrance(nom),
        });
      } else {
        const e = dedup.get(id);
        if (r.dateIso < e.dateDebut) e.dateDebut = r.dateIso;
        if (r.dateIso > e.dateFin) e.dateFin = r.dateIso;
      }
    }
  }
  return [...dedup.values()];
}

// Saison ID au format "YYYY-YYYY" pour une date ISO donnée
function seasonIdOf(dateIso) {
  const d = new Date(dateIso);
  const y = d.getFullYear();
  const m = d.getMonth();
  const start = m >= 8 ? y : y - 1;
  return `${start}-${start + 1}`;
}

function momentOfMonth(dayOfMonth) {
  if (dayOfMonth <= 10) return "début";
  if (dayOfMonth <= 20) return "mi";
  return "fin";
}

const FR_MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

async function generatePredictions(currentSeasonComps, poolCache, citiesCache, overrides, now) {
  console.log("[predict] génération des prédictions 'Habituelles'...");

  // 1. Charger l'historique complet (depuis les snapshots calendar_cache)
  const historical = await loadHistoricalMaitres();
  console.log(`[predict] ${historical.length} compés historiques chargées (snapshots cache)`);

  // 2. Combiner avec la saison courante (qui n'est pas encore figée)
  // currentSeasonComps : objets enrichis lat/lon/bassin (kept dans main)
  const combined = [...historical];
  const currentIds = new Set(currentSeasonComps.map((c) => c.id));
  for (const c of currentSeasonComps) {
    if (!combined.find((h) => h.id === c.id)) {
      combined.push({
        id: c.id,
        niveau: c.niveau,
        nom: c.nom,
        ville: c.ville,
        dateDebut: c.dateDebut,
        dateFin: c.dateFin,
        championnatFrance: c.championnatFrance,
      });
    }
  }

  // 3. Enrichir chaque compé avec saison + doy
  const enriched = combined
    .map((c) => ({
      ...c,
      season: seasonIdOf(c.dateDebut),
      doy: dayOfYear(c.dateDebut),
    }))
    .filter((c) => c.ville && c.dateDebut); // sanity

  // 4. Group par clé adaptée au type
  const groups = new Map();
  for (const c of enriched) {
    const key = isTournant(c)
      ? `T|${c.niveau}|${fingerprint(c.nom)}`
      : `V|${c.ville}|${c.niveau}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  // 5. Union-Find ±45j pour clusterer en séries annuelles. 21j initialement
  //    était trop strict — une compé peut bouger de 4-6 semaines entre 2
  //    éditions (changement de calendrier, weekend de Pâques mobile, etc.).
  //    45j reste assez petit pour distinguer une "édition Printemps" d'une
  //    "édition Automne" dans la même ville (>3 mois d'écart).
  const series = [];
  const THRESHOLD_DAYS = 45;
  for (const [k, list] of groups) {
    if (list.length === 1) { series.push({ key: k, items: list }); continue; }
    const parent = list.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].season === list[j].season) continue;
        if (circDist(list[i].doy, list[j].doy) <= THRESHOLD_DAYS) union(i, j);
      }
    }
    const cmap = new Map();
    for (let i = 0; i < list.length; i++) {
      const r = find(i);
      if (!cmap.has(r)) cmap.set(r, []);
      cmap.get(r).push(list[i]);
    }
    for (const g of cmap.values()) series.push({ key: k, items: g });
  }

  // 6. Saison courante (id "YYYY-YYYY") et fenêtre de validité
  const currentSeasonId = seasonIdOf(isoDate(now));
  const todayIso = isoDate(now);
  const seasonEnd = `${parseInt(currentSeasonId.split("-")[1], 10)}-08-31`;

  // 7. Garder les séries éligibles. Règle :
  //    - PRÉSENCE en N-1 obligatoire (signal récent fort = "elle existait
  //      l'an dernier")
  //    - + au moins 1 autre saison d'historique (pour distinguer une vraie
  //      récurrente d'un one-shot)
  //    - + pas encore confirmée dans la saison courante
  //    On expose aussi le streak consécutif (combien d'années d'affilée
  //    finissant en N-1) à titre de "force" du signal.
  const startYearCurrent = parseInt(currentSeasonId.split("-")[0], 10);
  const sN1 = `${startYearCurrent - 1}-${startYearCurrent}`;
  const sN2 = `${startYearCurrent - 2}-${startYearCurrent - 1}`;
  const sN3 = `${startYearCurrent - 3}-${startYearCurrent - 2}`;
  const sN4 = `${startYearCurrent - 4}-${startYearCurrent - 3}`;

  function consecutiveStreakFromN1(seasonsSet) {
    // compte les saisons d'affilée en partant de N-1 vers le passé
    let n = 0;
    for (let y = startYearCurrent; y >= startYearCurrent - 5; y--) {
      const sId = `${y - 1}-${y}`;
      if (seasonsSet.has(sId)) n++;
      else break;
    }
    return n;
  }

  // Convertit "2024-2025" → "2025" (l'année finale, la plus parlante)
  function seasonShortLabel(seasonId) {
    return seasonId.split("-")[1];
  }

  const predictions = [];
  for (const s of series) {
    const seasonsSeen = new Set(s.items.map((c) => c.season));
    const presentInCurrent = seasonsSeen.has(currentSeasonId);
    if (presentInCurrent) continue; // déjà sur liveffn → exclu

    if (!seasonsSeen.has(sN1)) continue; // N-1 OBLIGATOIRE (l'an dernier)
    // Au moins 2 présences sur les 4 saisons récentes (N-1, N-2, N-3, N-4).
    // Toulouse (N-1 + N-4) passe ici, mais une compé vue uniquement en N-1
    // sans aucune autre récurrence dans les 4 dernières années est exclue.
    const recentCount =
      (seasonsSeen.has(sN1) ? 1 : 0) +
      (seasonsSeen.has(sN2) ? 1 : 0) +
      (seasonsSeen.has(sN3) ? 1 : 0) +
      (seasonsSeen.has(sN4) ? 1 : 0);
    if (recentCount < 2) continue;

    const historicalSeasons = [...seasonsSeen].filter((id) => id !== currentSeasonId);

    const streak = consecutiveStreakFromN1(seasonsSeen);

    // Date estimée : on privilégie les éditions consécutives finissant en
    // N-1 (plus représentatives de la date probable cette année). Si pas
    // de streak (toutes les saisons d'historique sont éparses), on prend
    // simplement les 3 dernières par dateDebut.
    const consecSeasonIds = new Set();
    for (let y = startYearCurrent, n = 0; n < streak; y--, n++) {
      consecSeasonIds.add(`${y - 1}-${y}`);
    }
    let historicalItems = s.items.filter((c) => consecSeasonIds.has(c.season));
    if (historicalItems.length === 0) {
      // fallback : si la sélection consécutive est vide (cas limite),
      // prendre les 3 occurrences les plus récentes
      historicalItems = [...s.items]
        .filter((c) => c.season !== currentSeasonId)
        .sort((a, b) => b.dateDebut.localeCompare(a.dateDebut))
        .slice(0, 3);
    }
    const meanDoy = Math.round(
      historicalItems.reduce((a, b) => a + b.doy, 0) / historicalItems.length,
    );
    const dispersion = (() => {
      const m = meanDoy;
      return Math.sqrt(
        historicalItems.reduce((s2, c) => s2 + (c.doy - m) ** 2, 0) / historicalItems.length,
      );
    })();

    // Date civile : choisir l'année correcte (sept-déc → start, jan-août → start+1)
    const startYear = parseInt(currentSeasonId.split("-")[0], 10);
    const endYear = parseInt(currentSeasonId.split("-")[1], 10);
    const expectedYear = meanDoy >= 244 ? startYear : endYear; // doy 244 = ~1er sept
    const dRef = new Date(expectedYear, 0, meanDoy);
    const expectedIso = isoDate(dRef);
    if (expectedIso > seasonEnd) continue; // hors saison courante
    // Filtre : on retire celles dont la date estimée est strictement passée.
    // Pas de grâce : si on est le 25 avril, une compé estimée au 27 mars est
    // visiblement passée pour l'utilisateur, même si elle pourrait théoriquement
    // arriver dans la "tolérance" du modèle.
    if (expectedIso < todayIso) continue;

    const example = s.items[s.items.length - 1]; // exemple le plus récent
    const tournant = isTournant(example);
    const isCF = example.championnatFrance === true;

    // Helper pour récupérer lat/lon d'une ville (override > cache)
    const cityCoords = (ville) => {
      const k = normalizeCityKey(ville);
      const ov = overrides[k];
      if (ov) return { lat: ov.lat, lon: ov.lon };
      const c = citiesCache[k];
      if (c && c.lat != null) return { lat: c.lat, lon: c.lon };
      return null;
    };

    // Coordonnées + bassin :
    //   - Ville-centrée : ville/bassin stables d'une saison à l'autre.
    //   - Tournante Régional/Départemental : centroïde des dernières villes
    //     hôtes (rotation locale, donc moyenne représentative).
    //   - CF (champ. France) : pas de carte, rotation nationale.
    let lat = null, lon = null, bassin = null;
    if (!tournant) {
      // Ville-centrée
      const coords = cityCoords(example.ville);
      if (coords) { lat = coords.lat; lon = coords.lon; }
    } else if (isCF) {
      // Championnat de France : rotation nationale, lieu impossible à
      // prédire à partir des éditions précédentes. Easter egg : on les
      // place à Nîmes avec un nom de ville fictif.
      lat = 43.836699; lon = 4.360054; // Nîmes
    } else {
      // Tournante régionale/départementale : centroïde des 3 derniers hôtes connus
      const lastHosts = [...historicalItems]
        .sort((a, b) => b.dateDebut.localeCompare(a.dateDebut))
        .slice(0, 3);
      const coordsList = lastHosts
        .map((h) => cityCoords(h.ville))
        .filter(Boolean);
      if (coordsList.length > 0) {
        lat = coordsList.reduce((s2, c) => s2 + c.lat, 0) / coordsList.length;
        lon = coordsList.reduce((s2, c) => s2 + c.lon, 0) / coordsList.length;
      }
    }
    // Bassin : prendre celui du membre de série qui en a un (cohérent à 100%
    // pour les ville-centrées ; pour les tournantes c'est juste indicatif).
    for (const item of [...s.items].sort((a, b) => b.dateDebut.localeCompare(a.dateDebut))) {
      if (poolCache[item.id] != null) { bassin = poolCache[item.id]; break; }
    }

    predictions.push({
      id: `habituelle-${s.key.replace(/[^a-zA-Z0-9_]/g, "_")}-${expectedYear}-${pad2(dRef.getMonth() + 1)}`,
      type: tournant ? "tournant" : "ville",
      nom: example.nom,
      ville: !tournant ? example.ville : (isCF ? "LAPINLAND" : null),
      // Pour les tournantes R/D : lat/lon = centroïde des derniers hôtes,
      // affichables sur la carte. Pour les CF : null (pas mappable).
      lat,
      lon,
      niveau: example.niveau,
      niveauLibelle: NIVEAU_LIBELLE[example.niveau] || example.niveau,
      championnatFrance: example.championnatFrance,
      bassin,
      month: pad2(dRef.getMonth() + 1),
      monthLabel: FR_MONTHS[dRef.getMonth()],
      moment: momentOfMonth(dRef.getDate()),
      expectedDate: expectedIso, // pour le tri
      dispersionDays: Math.round(dispersion),
      seasonsSeen: historicalSeasons.sort(),
      consecutiveStreak: streak,
      // Libellé "Vue en 2025, 2024, 2022" (3 dernières années d'historique)
      seasonsLabel: (() => {
        const years = historicalSeasons
          .sort()
          .reverse()
          .slice(0, 4)
          .map(seasonShortLabel);
        return years.join(", ");
      })(),
      // 3 dernières villes hôtes connues (ordre récent → ancien). Surtout
      // utile pour les tournantes : permet à l'utilisateur de visualiser où
      // la compé a eu lieu les éditions précédentes.
      recentCities: (() => {
        const seen = new Set();
        const out = [];
        const sortedItems = [...historicalItems].sort((a, b) => b.dateDebut.localeCompare(a.dateDebut));
        for (const it of sortedItems) {
          if (it.ville && !seen.has(it.ville)) {
            seen.add(it.ville);
            out.push(it.ville);
            if (out.length >= 3) break;
          }
        }
        return out;
      })(),
    });
  }

  // 8. Trier par date estimée croissante
  predictions.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));

  // 9. Écrire data/predictions.json
  const output = {
    generatedAt: new Date().toISOString(),
    season: currentSeasonId,
    rule: "N-1 obligatoire + au moins 2 présences sur les 4 dernières saisons",
    predictions,
  };
  await atomicWriteFile(PREDICTIONS_PATH, JSON.stringify(output, null, 2) + "\n");

  const tournantes = predictions.filter((p) => p.type === "tournant").length;
  const villes = predictions.filter((p) => p.type === "ville").length;
  console.log(
    `[predict] ${predictions.length} prédictions écrites (${villes} ville-centrées, ${tournantes} tournantes)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
