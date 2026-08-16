# Color Map · the color each place prefers

A white map where every place is painted **the one color the most people there
chose as their favorite**, from the [color-polygraph](../color-polygraph/)
survey. Toggles: **Men / Women** and **World (by country) / United States (by
state)**.

Finding: men's most-preferred color is **purple**, women's is **red** — women
lean warm (red/magenta), men cool (purple/blue/green).

Not the *average* of everyone's favorites (that averages to gray mush — diverse
hues cancel). The **mode**: since every survey offers a fresh random palette, no
two people pick the identical RGB, so "most preferred" is counted over perceptual
**hue families** (red…purple + neutral, in Oklab), and each country is rendered
as the *within-family mean shade* of its winning family — a real, specific, vivid
color (US → purple `#2f3399`, Nordics → near-black, Australia → green).

Where a place has too few real respondents for a stable mode, the **pick model**
(color-polygraph's `taste-cube/pick_*`) expands each person's single survey into
a full color-preference distribution, pooled so the winner reflects taste, not
noise.

## Data

Favorite color + gender are in the local training files, but **geography is
not** — it lives only in the live Cloudflare **D1** database. The worker's
`/export` endpoint strips geo by default; we added an opt-in, token-gated
`?include_geo=1` flag ([worker.py](../color-polygraph/cloudflare/worker.py)) and
pull with it here.

Cohort (Jul-2026 pull): **1,352 men** + **701 women** completed sessions.
World: men 65 countries / women 39. US: men 48 states (653 people) / women 43
(393). Thin places (<10 respondents) are the pick model's densification targets
— 49 male + 31 female countries, 26 male + 29 female US states.

## Pipeline

```
python fetch_geo.py                 # pull geo+gender+color from D1 -> data/geo_dump.json
python densify.py --gender male     # pick-model favorites for thin-place men  -> data/pick_samples_male.json
python densify.py --gender female   #                             ... women    -> data/pick_samples_female.json
python aggregate.py                 # modes per gender x {country, US state} -> site/map.json
python densify.py --validate        # smoke test: real-question pick accuracy (~0.5+, chance 0.25)
```

### View the map
```
python -m http.server 8123 --directory site
# open http://localhost:8123/
```
`site/index.html` loads `map.json` + `world.geojson` + `us-states.geojson` and
renders a D3 choropleth (Natural-Earth for world, Albers-USA w/ AK+HI insets for
states; light by default = white map, dark toggle). Toggles for Men/Women and
World/US; hover tooltip shows each place's full family breakdown, respondent
count, and a "pick-model densified · n<10" badge on hatched thin places.
`?gender=&view=&demo=<placeKey>` deep-links a view / pops a tooltip (press shots).

## Files
```
color-map/
  fetch_geo.py     pull live DB with geo (needs color-polygraph/.env token; deployed worker)
  densify.py       run the pick model on thin-place people (--gender, --validate)
  aggregate.py     modes per gender x geography -> site/map.json
  colorspace.py    sRGB<->Oklab, hue families, perceptual mean (shared)
  data/            geo_dump.json + pick_samples_*.json  (all gitignored, per-session)
  site/
    index.html         the map page (Men/Women x World/US toggles)
    map.json           per-gender, per-place modes + family swatches (what the page reads)
    world.geojson      simplified Natural Earth (ISO A2), 79 KB
    us-states.geojson  simplified US states by name, 22 KB
    vendor/d3.min.js
```

## Status
- [x] worker `include_geo` flag + deploy + `fetch_geo.py`
- [x] mode-based aggregation (hue families, Oklab within-family shade)
- [x] pick-model densification (short + long), validated at 0.78 real-question accuracy
- [x] D3 choropleth: white map, thin-place hatching, tooltip, legend, dark toggle
- [x] Men/Women toggle · World + US-state views
- [ ] optional: all-gender view, city-dot layer, deploy to ai.andreaslindeman.com
