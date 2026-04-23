// Scraper FFN maîtres → data/competitions.json
// Node 22, stdlib pure, aucune dépendance npm.
//
// Pipeline :
//   1. Fetch 12 mois glissants sur liveffn (HTML AJAX).
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

// User-Agent explicite pour les administrateurs de liveffn.com :
// - nom du projet clairement identifié (MasterMap)
// - lien vers le site live (pour voir ce qu'on fait des données)
// - lien vers le repo (pour comprendre le code)
// - "issues" = canal de contact direct
const USER_AGENT =
  "MasterMap/1.0 (+https://bneel.github.io/master-map/; source https://github.com/bneel/master-map; contact via github issues)";

// Whitelist manuelle : Google Sheet publiée en CSV, une colonne `url`.
// Permet de rattraper des compétitions maîtres rejetées par le filtre titre
// (ex: "19e Meeting de Combs-la-Ville" — pas de mot "maîtres" dans le nom).
// URL en dur par défaut (sheet publique, stable). La variable d'env permet
// de surcharger pour tester avec une autre sheet. Soft-fail si inaccessible.
const MANUAL_SHEET_CSV_URL =
  process.env.MANUAL_SHEET_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTIFM8WzodikCJ26VeRZiSDblryGUuiWRIE4uQNSwPnH9fsJUuLa-Cv_EjA3X7UxnEtpM_Pz13P6SzV/pub?gid=0&single=true&output=csv";

// Drapeau : true pour couvrir saison courante + saison précédente
// (fenêtre de ~24 mois). Le cache pool_sizes.json évite les re-fetch.
const SCRAPE_PREVIOUS_SEASON = true;

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

function previousSeasonStart(now) {
  const cs = seasonStart(now);
  return new Date(cs.getFullYear() - 1, 8, 1);
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

const FORWARD_HORIZON_MONTHS = 12;

// ISO "YYYY-MM-DD" depuis un Date (tz local, ce qui suffit pour des dates journalières)
function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function seasonLabel(startDate) {
  const y = startDate.getFullYear();
  return `${y}/${String(y + 1).slice(2)}`; // "2025/26"
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

// Championnat(s) de France ... maîtres — couvre :
//   - "Championnat de France Interclubs N1/N2 des Maîtres"
//   - "Championnats de France (Hiver|Été) (N2)? (Open)? des Maîtres"
//   - variantes avec/sans accents, capitalisation, tirets.
// Exclut "Championnat de France Universitaire" (pas de "maîtres").
const CHAMPIONNAT_FRANCE_RE = /championnat[s]?\s+de\s+france[\s\S]{0,200}?ma[iî]tres?/i;

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

// --- main ---------------------------------------------------------------

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const now = new Date();
  // Plage : début de la saison (courante, ou précédente si SCRAPE_PREVIOUS_SEASON)
  // jusqu'à now + 12 mois.
  const rangeStart = SCRAPE_PREVIOUS_SEASON
    ? previousSeasonStart(now)
    : seasonStart(now);
  const rangeEnd = new Date(now.getFullYear(), now.getMonth() + FORWARD_HORIZON_MONTHS, 1);
  const months = monthsBetween(rangeStart, rangeEnd);

  // 1. Fetch + parse (throttle 2s entre chaque requête calendrier —
  // courtoisie envers liveffn, reste imperceptible pour un cron quotidien)
  const CAL_DELAY_MS = 2000;
  const rawAll = [];
  const rawMaitres = [];
  for (let i = 0; i < months.length; i++) {
    if (i > 0) await sleep(CAL_DELAY_MS);
    const { month, year } = months[i];
    const html = await fetchMonthHtml(month, year);
    const raw = parseMonthHtml(html, month, year);
    const maitres = raw.filter((r) => isMaitres(r.libelle));
    console.log(
      `[scrape] fetching ${year}-${pad2(month)}... ${raw.length} compétitions brutes, ${maitres.length} maîtres`,
    );
    rawAll.push(...raw);
    rawMaitres.push(...maitres);
  }

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
      console.warn(`[manual] WARN ${missing.length} ids introuvables dans la fenêtre 12 mois: ${missing.join(", ")}`);
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
  let droppedForeign = 0;
  for (const c of filtered) {
    const g = cache[normalizeCityKey(c.ville)];
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
  const ps = previousSeasonStart(now);
  const seasons = [
    {
      id: `${ps.getFullYear()}-${ps.getFullYear() + 1}`,
      label: seasonLabel(ps),
      start: isoDate(ps),
      end: `${ps.getFullYear() + 1}-08-31`,
    },
    {
      id: `${cs.getFullYear()}-${cs.getFullYear() + 1}`,
      label: seasonLabel(cs),
      start: isoDate(cs),
      end: `${cs.getFullYear() + 1}-08-31`,
      current: true,
    },
  ];

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

  const bassin25 = kept.filter(c => c.bassin === 25).length;
  const bassin50 = kept.filter(c => c.bassin === 50).length;
  const bassinNull = kept.filter(c => c.bassin == null).length;
  console.log(
    `[scrape] final: competitions.json (${kept.length} comp : ${bassin25}×25m, ${bassin50}×50m, ${bassinNull}×null), cities.json (${Object.keys(sortedCache).length}), pool_sizes.json (${Object.keys(poolCache).length})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
