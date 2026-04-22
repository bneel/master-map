.PHONY: scrape serve

scrape:
	node scripts/scrape.mjs

serve:
	python3 -m http.server 8000
