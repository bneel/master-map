// Service worker de Couloir 4 : rend le site installable comme une
// application (PWA) et permet de l'ouvrir sans réseau.
//
// Stratégie :
// - Fichiers du site (HTML, CSS, JS, data/*.json, icônes) : réseau d'abord,
//   cache en secours. Avec du réseau, on a toujours la version du serveur
//   (mêmes règles de cache HTTP qu'avant) ; sans réseau, la dernière copie.
// - Leaflet sur unpkg : URL versionnée, donc cache d'abord.
// - Tuiles de carte et statistiques : non interceptées (pas de cache).
//
// Changer VERSION purge l'ancien cache au prochain chargement.

const VERSION = 'v1';
const CACHE = `couloir4-${VERSION}`;
const UNPKG = 'https://unpkg.com';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Clé de cache sans paramètres (?_r=… du bouton de rechargement,
// ?_=… de statut.js) pour ne pas empiler une copie par chargement.
function cacheKey(request) {
  const url = new URL(request.url);
  return url.origin + url.pathname;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const key = cacheKey(request);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch (err) {
    // /index.html et / sont la même page : l'une sert de secours à l'autre.
    const home = self.location.origin + '/';
    const cached = await cache.match(key)
      || (key === home + 'index.html' ? await cache.match(home) : undefined);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (url.origin === UNPKG) {
    event.respondWith(cacheFirst(request));
  }
});
