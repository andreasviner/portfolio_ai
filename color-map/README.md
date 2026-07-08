# Color Map · favorite color by place

A white world map where every place people answered the
[color-polygraph](../color-polygraph/) survey is filled with the **mean favorite
color** of the people there. Phase 1: **male respondents only**.

Where a place has too few real respondents to trust its mean, we run the
**pick model** (color-polygraph's `taste-cube/pick_*`) to expand each person's
single survey into a full personal color-taste distribution, then aggregate —
so a place with 2 real people still gets a stable color instead of noise.

## Data situation (the important part)

The favorite color + gender live in the local training files, but **the
geography does not**:

| Source | color | gender | geo (country/region/city) |
|---|---|---|---|
| `color-polygraph/training/raw/*` (local) | yes | yes | **no** (ip is a placeholder) |
| `refresh/remote_dump.json` (local) | yes | yes | **no** (export strips geo) |
| live Cloudflare **D1 database** | yes | yes | **yes** |

The worker's `/color-polygraph/export` endpoint *deliberately* omits the geo
columns (`worker.py` line ~464). So the geo has to be pulled from D1 directly.
That needs a one-time `wrangler login` (interactive) — see the two options
below.

### Cohort size (from the Jul-6 dump, gender present even though geo isn't)
- 2173 completed sessions total · **1351 male** · 701 female · 121 non-binary
- male split: 1009 long-survey, 342 short — all have a final color

The big 2020 dataset (`save.ligma`, ~6710 sessions, Oslo-dominated) has **no
geo** and is not in the live DB, so the map is built from the ~1351 live male
sessions. Most are expected to cluster in a few countries → the pick-model
densification matters for everywhere else.

## Getting the geo out of D1 (pick one — both need `wrangler login` once)

**Option A — extend the export endpoint (repeatable).**
Add an opt-in `?include_geo=1` (token-gated) to `worker.py`'s export, redeploy
(`wrangler deploy`), then `fetch_geo.py` pulls over HTTP with the token already
in `.env`. The map refreshes like the rest of the pipeline. Touches production.

**Option B — one-off read-only D1 query (least invasive).**
No prod change. After `wrangler login`:
```
npx wrangler d1 execute color-polygraph --remote --json \
  --command "SELECT id, confirmed_gender, long_survey, final_color_json, country, region, city FROM surveys WHERE confirmed_gender IS NOT NULL" \
  > color-map/data/geo_dump.json
```

## Pipeline (planned)

1. **fetch** geo + gender + final color from D1 → `data/geo_dump.json`
2. **aggregate** (`aggregate.py`): filter male; group by place; mean favorite
   color in a **perceptual space (Oklab/LAB)**, not raw RGB, so means don't turn
   to mud; record respondent count per place.
3. **densify** sparse places: run the pick model on each person's fingerprint to
   simulate thousands of picks → a robust per-person color, then aggregate.
4. **render** (`site/index.html`): white map, each place filled by its mean
   color; hover shows count + swatch. Country choropleth and/or city points.

## Layout
```
color-map/
  README.md
  data/          fetched dumps + computed aggregates (raw dumps gitignored)
  site/          the map page (self-contained HTML)
  fetch_geo.py   pull geo from D1 (written once fetch method is chosen)
  aggregate.py   mean-color-per-place + pick-model densification
```
