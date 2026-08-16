"""
Densify thin countries with the pick model.

For every male respondent in a country with < THIN_THRESHOLD real respondents,
run color-polygraph's colour-pick model (taste-cube/pick_*) the way pick_cube.js
does: score the 512 colour-cube voxel centres once for that person, then
Monte-Carlo bracket questions using those cached scores and tally the winners.
The winners are that person's model-generated favorite colours -- "more data
from the survey" -- which aggregate.py then pools so the country's most-preferred
color reflects taste, not the noise of two or three raw picks.

Two models: short survey -> pick_trees.json (person 479), long -> pick_long_trees
(person 239). We pick per session by its long_survey flag. Inference uses the
REAL session untouched (the probe/overwrite scheme is a *training* device only).

    python densify.py --validate     # smoke test: real-question pick accuracy (~0.5, chance 0.25)
    python densify.py                # write data/pick_samples.json for thin-country men
    python aggregate.py --picks data/pick_samples.json   # then re-aggregate

Output: data/pick_samples.json = {survey_id: [[r,g,b], ... B favorites]}
"""

import argparse
import json
import os
import random
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.normpath(os.path.join(HERE, "..", "color-polygraph"))
CF = os.path.join(CP, "cloudflare")
TC = os.path.join(CP, "training", "taste-cube")
MODELS = os.path.normpath(os.path.join(CP, "..", "english_html", "color-polygraph", "models-js"))
for p in (CF, TC):
    sys.path.insert(0, p)

import features as prod           # cloudflare/features.py       (short person vector)  # noqa: E402
import features_long as fl        # cloudflare/features_long.py  (long person vector)   # noqa: E402
import pick_features as pf        # candidate descriptors (shared)                      # noqa: E402
import taste_features as tfeat    # session_context + interaction descriptors           # noqa: E402

GEO_DUMP = os.path.join(HERE, "data", "geo_dump.json")
GENDER_CODES = {"male": 0, "female": 1}
def out_path(gender):
    return os.path.join(HERE, "data", f"pick_samples_{gender}.json")
THIN_THRESHOLD = 10               # must match aggregate.py
N_BRACKETS = 500                  # model-generated favorites per person
OFFER = 64                        # colours offered per simulated bracket (short-survey size)
SEED = 42

# 8x8x8 RGB voxel centres = the candidate colour grid pick_cube.js scores.
VOX = [(i * 32 + 16, j * 32 + 16, k * 32 + 16)
       for i in range(8) for j in range(8) for k in range(8)]
CAND = [pf.candidate_vector(c) for c in VOX]   # candidate block is person-independent


def load_model(name):
    with open(os.path.join(MODELS, name), encoding="utf-8") as fh:
        return json.load(fh)


def tree_score(model, feats):
    """Port of tree_walker.js score(): sum of leaf values over the flat trees."""
    total = 0.0
    for tree in model["trees"]:
        i = 0
        while tree[i * 4] != -1:
            if feats[tree[i * 4]] <= tree[i * 4 + 1]:
                i = tree[i * 4 + 2]
            else:
                i = tree[i * 4 + 3]
        total += tree[i * 4 + 1]
    return total


def _pj(v):
    return json.loads(v) if isinstance(v, str) else v


def reconstruct(row):
    """geo_dump DB row -> (payload, is_long, submit_unix). Payload shape matches
    what compute_features / compute_features_long expect."""
    is_long = int(row.get("long_survey") or 0) == 1
    submit_ms = row.get("client_submitted_at") or row.get("server_received_at") or 0
    try:
        t = int(submit_ms) // 1000
    except (TypeError, ValueError):
        t = 0
    payload = {
        "offered": _pj(row["offered_json"]),
        "r1": _pj(row["r1_json"]),
        "r2": _pj(row["r2_json"]),
        "final": _pj(row["final_color_json"]),
        "valg": str(row["valg"]),
        "tider": [int(x) for x in _pj(row["tider_json"])],
    }
    if is_long:
        payload["r3"] = _pj(row["r3_json"])
    return payload, is_long, t


def person_and_ctx(row):
    """Build (person_vector, interaction_ctx, model) for a real session."""
    payload, is_long, t = reconstruct(row)
    if is_long:
        f = fl.compute_features_long(payload, t)
        model = LONG
    else:
        f = prod.compute_features(payload, t)
        model = SHORT
    person = f["gender"] + [f["age"][-1], f["mood"][-1]]
    ctx = tfeat.session_context(payload["r1"], payload["r2"], payload["final"])
    return person, ctx, model


def voxel_scores(person, ctx, model):
    """Desirability logit for each of the 512 voxel centres, for this person."""
    scores = [0.0] * len(VOX)
    for v in range(len(VOX)):
        row = person + CAND[v] + tfeat.interaction_vector(VOX[v], ctx)
        scores[v] = tree_score(model, row)
    return scores


def favorite_colors(scores, rng):
    """Monte-Carlo the bracket: each round offers OFFER random voxels and the
    person keeps the most desirable; with a single-elimination bracket the final
    is just the argmax over the offered set. Returns N_BRACKETS voxel-centre RGBs."""
    out = []
    n = len(VOX)
    for _ in range(N_BRACKETS):
        offered = rng.sample(range(n), OFFER)
        best = offered[0]
        bs = scores[best]
        for v in offered[1:]:
            if scores[v] > bs:
                bs = scores[v]; best = v
        out.append(list(VOX[best]))
    return out


# ---------- validation: does the pipeline predict real picks above chance? ----------

def validate(rows, n_sessions=250):
    """For real round-0 questions, does argmax model score == the actual pick?
    A correct pipeline lands well above chance (0.25); ~chance means the feature
    vector or tree walk is wrong."""
    rng = random.Random(SEED)
    sample = rng.sample(rows, min(n_sessions, len(rows)))
    hit = tot = 0
    for row in sample:
        try:
            payload, is_long, t = reconstruct(row)
            f = (fl.compute_features_long if is_long else prod.compute_features)(payload, t)
            person = f["gender"] + [f["age"][-1], f["mood"][-1]]
            ctx = tfeat.session_context(payload["r1"], payload["r2"], payload["final"])
            model = LONG if is_long else SHORT
            n_r0 = 64 if is_long else 16
            offered, valg = payload["offered"], payload["valg"]
            for q in rng.sample(range(n_r0), min(4, n_r0)):
                quad = offered[q * 4:(q + 1) * 4]
                try:
                    pick = int(valg[q])
                except (ValueError, IndexError):
                    continue
                if not (0 <= pick <= 3) or len(quad) < 4:
                    continue
                sc = [tree_score(model, person + pf.candidate_vector(quad[i])
                                 + tfeat.interaction_vector(quad[i], ctx)) for i in range(4)]
                best = max(range(4), key=lambda i: sc[i])
                hit += (best == pick); tot += 1
        except Exception as exc:
            print("  skip session:", exc)
    print(f"\npick accuracy on {tot} real questions: {hit/tot:.3f}  (chance 0.25)")
    return hit / tot if tot else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gender", choices=list(GENDER_CODES), default="male")
    ap.add_argument("--validate", action="store_true", help="smoke-test pick accuracy and exit")
    ap.add_argument("--all", action="store_true", help="densify everyone, not only thin places")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    gcode = GENDER_CODES[args.gender]
    out = args.out or out_path(args.gender)

    dump = json.load(open(GEO_DUMP, encoding="utf-8"))
    ppl = [r for r in dump["rows"] if r.get("confirmed_gender") == gcode]

    global SHORT, LONG
    print("loading pick models ...")
    SHORT = load_model("pick_trees.json")
    LONG = load_model("pick_long_trees.json")
    print(f"  short: {SHORT['n_trees']} trees / {SHORT['n_features']} feats | "
          f"long: {LONG['n_trees']} / {LONG['n_features']}")

    if args.validate:
        validate(ppl)
        return

    # A person needs densifying if their place is thin at EITHER level we render:
    # a thin country, or (for US) a thin state. Covers both maps with one pass.
    from collections import Counter
    ccount = Counter(r.get("country") for r in ppl if r.get("country"))
    scount = Counter(r.get("region") for r in ppl if r.get("country") == "US")
    def needs(r):
        cc = r.get("country")
        if not cc:
            return False
        if ccount[cc] < THIN_THRESHOLD:
            return True
        return cc == "US" and scount.get(r.get("region"), 0) < THIN_THRESHOLD
    targets = ppl if args.all else [r for r in ppl if needs(r)]
    print(f"{args.gender}: {len(ppl)} people; densifying {len(targets)} in thin "
          f"countries/US-states ({N_BRACKETS} favorites each) ...")

    rng = random.Random(SEED)
    samples, t0, done = {}, time.time(), 0
    for row in targets:
        sid = row.get("id")
        if not sid:
            continue
        try:
            person, ctx, model = person_and_ctx(row)
            assert len(person) + len(CAND[0]) + 17 == model["n_features"], \
                f"feature length {len(person)}+{len(CAND[0])}+17 != {model['n_features']}"
            scores = voxel_scores(person, ctx, model)
            samples[sid] = favorite_colors(scores, rng)
        except Exception as exc:
            print(f"  skip {sid}: {exc}")
        done += 1
        if done % 25 == 0:
            print(f"  {done}/{len(targets)}  ({time.time()-t0:.0f}s)")

    with open(out, "w", encoding="utf-8") as fh:
        json.dump(samples, fh, separators=(",", ":"))
    print(f"\nwrote {len(samples)} people x {N_BRACKETS} favorites to {out} "
          f"({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
