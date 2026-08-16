"""
Build site/map.json: for each gender (male, female) and each geography level
(world = by country, usa = by state), THE ONE COLOR MOST PEOPLE PREFERRED --
the modal hue family, rendered as the within-family mean shade (see colorspace).

Not the average of favorites (that greys out); the mode. Every survey offers a
fresh random palette so no two people pick the identical RGB, hence a mode over
perceptual hue families. Where a place (country OR US state) has fewer than
THIN_THRESHOLD real respondents, its people's pick-model favorites
(data/pick_samples_<gender>.json, from densify.py) are pooled instead of their
single noisy final pick.

    python densify.py --gender male ; python densify.py --gender female   # first
    python aggregate.py                                                    # -> site/map.json

Legend swatches + family order are gender-agnostic (all data) so the legend is
stable when you toggle gender.
"""

import json
import os
import sys
import time
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding="utf-8")

import colorspace as cs  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
GEO_DUMP = os.path.join(HERE, "data", "geo_dump.json")
OUT = os.path.join(HERE, "site", "map.json")
GENDERS = {"male": 0, "female": 1}
THIN_THRESHOLD = 10


def parse_rgb(v):
    if isinstance(v, str):
        v = json.loads(v)
    return (int(v[0]), int(v[1]), int(v[2]))


def summarize(labs, n_real, densified):
    fam_of = [cs.hue_family(l) for l in labs]
    counts = Counter(fam_of)
    total = sum(counts.values())
    ranked = counts.most_common()
    mode_fam, mode_n = ranked[0]
    runner = ranked[1] if len(ranked) > 1 else (None, 0)
    rep_lab = cs.mean_oklab([l for l, f in zip(labs, fam_of) if f == mode_fam])
    return {
        "n": n_real,
        "mode_family": mode_fam,
        "mode_share": round(mode_n / total, 4),
        "hex": cs.rgb_to_hex(cs.oklab_to_rgb(rep_lab)),
        "runner_family": runner[0],
        "runner_share": round(runner[1] / total, 4) if runner[0] else 0,
        "shares": {f: round(counts.get(f, 0) / total, 4) for f in cs.FAMILIES if counts.get(f)},
        "thin": n_real < THIN_THRESHOLD,
        "densified": densified,
    }


def build_places(rows, key_fn, picks):
    """Group rows by key_fn(place); pool pick-model favorites for thin places,
    raw finals otherwise. Returns {place_key: record}."""
    real = Counter()
    for r in rows:
        k = key_fn(r)
        if k:
            real[k] += 1
    labs = defaultdict(list)
    dens = defaultdict(bool)
    for r in rows:
        k = key_fn(r)
        if not k:
            continue
        try:
            final_lab = cs.rgb_to_oklab(parse_rgb(r["final_color_json"]))
        except Exception:
            continue
        ps = picks.get(r.get("id")) if (picks and real[k] < THIN_THRESHOLD) else None
        if ps:
            labs[k].extend(cs.rgb_to_oklab(parse_rgb(c)) for c in ps)
            dens[k] = True
        else:
            labs[k].append(final_lab)
    return {k: summarize(v, real[k], dens[k]) for k, v in labs.items()}


def global_summary(rows):
    counts = Counter()
    n = 0
    for r in rows:
        try:
            counts[cs.hue_family(cs.rgb_to_oklab(parse_rgb(r["final_color_json"])))] += 1
            n += 1
        except Exception:
            pass
    tot = sum(counts.values()) or 1
    return {"n": n, "mode_family": counts.most_common(1)[0][0] if counts else None,
            "shares": {f: round(counts.get(f, 0) / tot, 4) for f in cs.FAMILIES if counts.get(f)}}


def main():
    dump = json.load(open(GEO_DUMP, encoding="utf-8"))
    rows = dump["rows"]

    # gender-agnostic legend: family swatches + order from ALL real finals
    all_rows = [r for r in rows if r.get("confirmed_gender") in (0, 1)]
    gfam = defaultdict(list)
    for r in all_rows:
        try:
            gfam[cs.hue_family(cs.rgb_to_oklab(parse_rgb(r["final_color_json"])))].append(
                cs.rgb_to_oklab(parse_rgb(r["final_color_json"])))
        except Exception:
            pass
    family_swatches = {f: cs.rgb_to_hex(cs.oklab_to_rgb(cs.mean_oklab(gfam[f])))
                       for f in cs.FAMILIES if gfam.get(f)}
    family_order = sorted((f for f in cs.FAMILIES if gfam.get(f)),
                          key=lambda f: -len(gfam[f]))

    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "modal-hue-family",
        "thin_threshold": THIN_THRESHOLD,
        "families": list(cs.FAMILIES),
        "family_order": family_order,
        "family_swatches": family_swatches,
        "genders": {},
    }

    for gname, gcode in GENDERS.items():
        grows = [r for r in rows if r.get("confirmed_gender") == gcode]
        pick_path = os.path.join(HERE, "data", f"pick_samples_{gname}.json")
        picks = json.load(open(pick_path, encoding="utf-8")) if os.path.exists(pick_path) else {}
        world_rows = [r for r in grows if r.get("country")]
        us_rows = [r for r in grows if r.get("country") == "US" and r.get("region")]
        countries = build_places(world_rows, lambda r: r.get("country"), picks)
        us_states = build_places(us_rows, lambda r: r.get("region"), picks)
        out["genders"][gname] = {
            "source": "pick-densified" if picks else "raw-final",
            "world": {"n": len(world_rows), "global": global_summary(world_rows),
                      "n_thin": sum(1 for c in countries.values() if c["thin"]),
                      "places": countries},
            "usa": {"n": len(us_rows), "global": global_summary(us_rows),
                    "n_thin": sum(1 for c in us_states.values() if c["thin"]),
                    "places": us_states},
        }

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    print(f"wrote {OUT}")
    for gname in GENDERS:
        g = out["genders"][gname]
        print(f"\n{gname}: source={g['source']}")
        for lvl in ("world", "usa"):
            L = g[lvl]
            print(f"  {lvl:5s}: {L['n']:>4} people, {len(L['places'])} places "
                  f"({L['n_thin']} thin), global most-preferred = {L['global']['mode_family']}")


if __name__ == "__main__":
    main()
