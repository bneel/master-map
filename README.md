# Couloir 4

Site non-officiel qui recense les compétitions de natation **maîtres** en France sur une carte interactive, triées par distance ou par date.

En ligne : https://www.couloir4.fr/

## Comment ça marche

Un scraper Node parse le calendrier public de [liveffn.com](https://www.liveffn.com) et géocode les villes via [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap). Pour chaque compétition, il fetche aussi la page détail pour récupérer la taille du bassin (25 m / 50 m). Le résultat est sérialisé en JSON statique dans `data/`. Le front (HTML/JS vanilla, Leaflet) lit ces JSON et affiche carte + liste.

Hébergement : GitHub Pages, servi depuis la racine du repo. Un cron GitHub Actions mettra à jour les données automatiquement (étape 3).

## Développement local

```bash
# 1. Générer/rafraîchir les données
node scripts/scrape.mjs

# 2. Lancer un serveur statique depuis la racine
python3 -m http.server 8000

# 3. Ouvrir http://localhost:8000
```

Node ≥ 20 et Python 3 suffisent. Pas de `npm install`, zéro dépendance.

Raccourcis `make` disponibles : `make scrape` et `make serve`.

## Structure du projet

```
├── index.html                      # Page unique (SEO meta + Open Graph)
├── app.js                          # Logique carte/liste/filtres/position
├── app.css                         # Styles
├── robots.txt                      # SEO
├── sitemap.xml                     # SEO
├── data/
│   ├── competitions.json           # 2 saisons de compétitions maîtres
│   ├── cities.json                 # Cache géocodage Nominatim
│   └── pool_sizes.json             # Cache tailles de bassin (25/50)
├── scripts/
│   └── scrape.mjs                  # Scrape liveffn + géocode + bassins -> data/*.json
├── Makefile
└── README.md
```

## Déploiement

Settings → Pages → source = `main`, dossier `/ (root)`. Custom domain `www.couloir4.fr` (fichier `CNAME`). SSL automatique (Let's Encrypt via GitHub).

## Sources et attributions

- Données compétitions : [liveffn.com](https://www.liveffn.com) (calendrier public FFN).
- Géocodage : [Nominatim](https://nominatim.openstreetmap.org) / © OpenStreetMap contributors.
- Fonds de carte : [CARTO basemaps](https://carto.com/basemaps/) + OpenStreetMap.

Ce site est **non officiel** et **non affilié à la FFN** ni à liveffn. Il agrège des données publiques à des fins d'information, avec un scraping extrêmement léger (quelques appels par jour).

## Licence

MIT — `LICENSE` à ajouter.

## Auteur

Benjamin Néel · [Instagram](https://www.instagram.com/benjamin_darneel/) · [LinkedIn](https://www.linkedin.com/in/benjaminneel/)
