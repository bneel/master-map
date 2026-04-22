.PHONY: scrape serve

scrape:
	node scripts/scrape.mjs

serve:
	cd public && python3 -m http.server 8000
