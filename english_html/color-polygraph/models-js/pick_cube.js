// Personal colour cube, driven by the colour-pick model.
//
// The model answers brand-new survey questions, generated EXACTLY the way the
// real survey makes them (farthest-point sampling in Oklab over a random
// pool), bracket and all: 64 colours -> 16 questions -> 4 questions -> final.
// Every answer tallies into the same [offered, r1, r2, final] voxel arrays the
// population cube uses, and the canvas renders live while the AI is still
// answering -- the render loop reads the tallies every frame, so the cube
// fills in front of the user. A progress callback drives the page's bar.
//
// Depends on TreeWalker, TasteFeatures (session context + interactions) and
// PickFeatures (candidate descriptors + person vector).
(function (global) {
  'use strict';

  var GRID = 8;
  var N_VOXELS = GRID * GRID * GRID;          // 512
  // How many questions the AI answers. Single source of truth -- the result
  // page reads this; override per-visit with ?answers=NNNN.
  var TOTAL_ANSWERS = 200000;
  // Each question eliminates 3 colours, so a full bracket is (n-1)/3 answers:
  // short (64) -> 21, long (256) -> 85.
  function answersPerBracket(numColors) { return (numColors - 1) / 3; }
  // Display weights (project-page defaults). Overridable from the URL for
  // testing: ?w1=0.5&w2=0.5&wf=0.5&wrej=0
  var WEIGHTS = { w1: 0.5, w2: 0.5, wF: 0.5, wRej: 0 };
  (function () {
    try {
      var p = new URLSearchParams(global.location.search);
      var f = function (key, cur) {
        var v = parseFloat(p.get(key));
        return isNaN(v) ? cur : v;
      };
      WEIGHTS.w1 = f('w1', WEIGHTS.w1);
      WEIGHTS.w2 = f('w2', WEIGHTS.w2);
      WEIGHTS.wF = f('wf', WEIGHTS.wF);
      WEIGHTS.wRej = f('wrej', WEIGHTS.wRej);
    } catch (_e) {}
  })();

  // Diff-mode denoising, in mean-profile units. Two near-identical surveys
  // differ only by Monte-Carlo noise (measured: typical |d| ~0.2, maxAbs
  // ~0.5-0.65 at the 200k default); strangers' real differences reach 2.5-2.9.
  //  * DIFF_NOISE_FLOOR soft-thresholds every diff toward zero by the noise
  //    scale -- it alone decides WHAT is real enough to show, so identical
  //    surveys genuinely die.
  //  * Whatever survives is normalised to the pair's own strongest difference
  //    (auto-gain), so a high-likeness pair's few real disagreements still
  //    render at full size instead of as unreadable specks. MIN_DIFF_SCALE is
  //    only a denominator guard against renormalising tiny residuals.
  var DIFF_NOISE_FLOOR = 0.6;
  var MIN_DIFF_SCALE = 0.5;

  // The model answers PROBABILISTICALLY, like the humans it learned from: each
  // candidate's sigmoid output is its pick-probability, and the answer is
  // sampled from those (an argmax answer would make the single favourite win
  // every quad, collapsing the cube to a handful of voxels after the display
  // normalisation). SHARPNESS > 1 makes the model more decisive, < 1 more
  // scattered. 1.5 measured well: ~170 love orbs with clear favourites
  // (1 -> ~245 but flatter, 2 -> ~135 and starker).
  var SHARPNESS = 1.5;

  // ---- survey-identical colour generation (copied from survey.html) ----

  function rgbToOklab(r, g, b) {
    var r_ = r / 255, g_ = g / 255, b_ = b / 255;
    r_ = r_ > 0.04045 ? Math.pow((r_ + 0.055) / 1.055, 2.4) : r_ / 12.92;
    g_ = g_ > 0.04045 ? Math.pow((g_ + 0.055) / 1.055, 2.4) : g_ / 12.92;
    b_ = b_ > 0.04045 ? Math.pow((b_ + 0.055) / 1.055, 2.4) : b_ / 12.92;
    var l = 0.4122214708 * r_ + 0.5363325363 * g_ + 0.0514459929 * b_;
    var m = 0.2119034982 * r_ + 0.6806995451 * g_ + 0.1073969566 * b_;
    var s = 0.0883024619 * r_ + 0.2817188376 * g_ + 0.6299787005 * b_;
    var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return [
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ];
  }

  function distanceOklab(c1, c2) {
    return Math.sqrt(
      Math.pow(c1[0] - c2[0], 2) + Math.pow(c1[1] - c2[1], 2) + Math.pow(c1[2] - c2[2], 2));
  }

  function generatePalette(numColors, poolSize) {
    if (!poolSize) poolSize = Math.max(3000, numColors * 50);
    var poolRgb = [], poolOklab = [];
    for (var i = 0; i < poolSize; i++) {
      var r = Math.floor(Math.random() * 256);
      var g = Math.floor(Math.random() * 256);
      var b = Math.floor(Math.random() * 256);
      poolRgb.push([r, g, b]);
      poolOklab.push(rgbToOklab(r, g, b));
    }
    var firstIdx = Math.floor(Math.random() * poolSize);
    var selected = [firstIdx];
    var isSelected = new Uint8Array(poolSize);
    isSelected[firstIdx] = 1;
    var minDistances = new Array(poolSize).fill(Infinity);
    while (selected.length < numColors) {
      var lastOklab = poolOklab[selected[selected.length - 1]];
      var maxMinDist = -1, bestIdx = -1;
      for (var k = 0; k < poolSize; k++) {
        if (isSelected[k]) continue;
        var d = distanceOklab(poolOklab[k], lastOklab);
        if (d < minDistances[k]) minDistances[k] = d;
        if (minDistances[k] > maxMinDist) { maxMinDist = minDistances[k]; bestIdx = k; }
      }
      selected.push(bestIdx);
      isSelected[bestIdx] = 1;
    }
    return selected.map(function (idx) { return poolRgb[idx]; });
  }

  // ---- model answering + tallying ----

  function voxelId(rgb) {
    return ((rgb[0] >> 5) << 6) | ((rgb[1] >> 5) << 3) | (rgb[2] >> 5);
  }

  function makeScorer(model, person, ctx) {
    var cache = new Map();  // colours repeat as winners advance the bracket
    return function (rgb) {
      var key = rgb[0] * 65536 + rgb[1] * 256 + rgb[2];
      var v = cache.get(key);
      if (v === undefined) {
        // Pick-probability for this colour (sigmoid of the model logit),
        // sharpened; cached because winners are re-scored as they advance.
        v = Math.pow(
          TreeWalker.sigmoid(TreeWalker.score(model, PickFeatures.featureRow(person, ctx, rgb))),
          SHARPNESS);
        cache.set(key, v);
      }
      return v;
    };
  }

  // Sample one winner from a quad, proportional to pick-probability.
  function answerQuestion(round, qs, score) {
    var p0 = score(round[qs]), p1 = score(round[qs + 1]),
        p2 = score(round[qs + 2]), p3 = score(round[qs + 3]);
    var r = Math.random() * (p0 + p1 + p2 + p3);
    if (r < p0) return round[qs];
    if (r < p0 + p1) return round[qs + 1];
    if (r < p0 + p1 + p2) return round[qs + 2];
    return round[qs + 3];
  }

  // One synthetic survey (64 colours short, 256 long), answered by the model.
  // Mutates counts. Tallies map onto the population cube's 4 stages:
  // round 0 -> off + r1, round 1 -> r2, the final question -> fn. The long
  // survey's extra middle round (16 -> 4) gets no extra tier of its own --
  // the counts structure (and the display weights) only know 4 stages.
  function runBracket(score, counts, numColors) {
    var palette = generatePalette(numColors || 64);
    var round = palette;
    var stage = 0;
    while (round.length > 1) {
      var winners = [];
      var isFinalQuestion = round.length === 4;
      for (var qs = 0; qs < round.length; qs += 4) {
        var best = answerQuestion(round, qs, score);
        if (stage === 0) {
          for (var j = 0; j < 4; j++) counts.off[voxelId(round[qs + j])] += 1;
          counts.r1[voxelId(best)] += 1;
        } else if (stage === 1) {
          counts.r2[voxelId(best)] += 1;
        } else if (isFinalQuestion) {
          counts.fn[voxelId(best)] += 1;
        }
        winners.push(best);
      }
      round = winners;
      stage += 1;
    }
  }

  // ---- love / reject scores (mirrors the project page's bucketScores) ----

  function voxelScores(counts, invert) {
    var scores = new Map();
    var w = WEIGHTS;
    for (var vid = 0; vid < N_VOXELS; vid++) {
      var o = counts.off[vid];
      if (o <= 0) continue;
      var r1 = counts.r1[vid];
      if (invert) {
        var reject = (o - r1) / o;
        if (reject > 0) scores.set(vid, reject);
      } else {
        var s = (w.w1 * r1 + w.w2 * counts.r2[vid] + w.wF * counts.fn[vid] - w.wRej * (o - r1)) / o;
        scores.set(vid, s);
      }
    }
    return scores;
  }

  // Signed comparison, same semantics as the project page's "diff" mode
  // (triangle: side A likes it more, circle: side B). Each side is normalised
  // to its own MEAN first, so what gets compared is the relative preference
  // profile. This matters when one side is an individual (selective, spiky)
  // and the other a population aggregate (flat): max-normalising left the flat
  // side "winning" nearly every voxel (~37 vs ~394 at the cutoff), while
  // mean-normalising balances it (~125 vs ~170).
  function diffScores(countsA, countsB, invert) {
    var sa = voxelScores(countsA, invert);
    var sb = voxelScores(countsB, invert);
    function meanOf(s) {
      var sum = 0, n = 0;
      s.forEach(function (v) { sum += v; n++; });
      return (n && sum / n) || 1;
    }
    var ma = meanOf(sa), mb = meanOf(sb);
    var out = new Map();
    for (var vid = 0; vid < N_VOXELS; vid++) {
      var d = (sa.get(vid) || 0) / ma - (sb.get(vid) || 0) / mb;
      // soft-threshold: shrink toward zero by the Monte-Carlo noise scale
      var mag = Math.abs(d) - DIFF_NOISE_FLOOR;
      if (mag <= 0) continue;
      out.set(vid, d > 0 ? mag : -mag);
    }
    return out;
  }

  // "In common": what BOTH sides like (or, inverted, both reject) -- the
  // project page's "both" mode, which takes the min of the two scores. Sides
  // are mean-normalised like diffScores so individual-vs-population works.
  function sameScores(countsA, countsB, invert) {
    var sa = voxelScores(countsA, invert);
    var sb = voxelScores(countsB, invert);
    function meanOf(s) {
      var sum = 0, n = 0;
      s.forEach(function (v) { sum += v; n++; });
      return (n && sum / n) || 1;
    }
    var ma = meanOf(sa), mb = meanOf(sb);
    var out = new Map();
    for (var vid = 0; vid < N_VOXELS; vid++) {
      var m = Math.min((sa.get(vid) || 0) / ma, (sb.get(vid) || 0) / mb);
      if (m > 0) out.set(vid, m);
    }
    return out;
  }

  function voxelCenter(vid) {
    var rr = (vid >>> 6) & 7, gg = (vid >>> 3) & 7, bb = vid & 7;
    return [rr * 32 + 16, gg * 32 + 16, bb * 32 + 16];
  }

  function voxelHex(vid) {
    var c = voxelCenter(vid);
    return '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
  }

  // Likeness + fun facts for a comparison. The score is the Jaccard overlap of
  // the two mean-normalised love profiles (sum of mins / sum of maxes),
  // stretched onto a friendly 0-100 scale calibrated from measurements at the
  // 200k default: same person re-simulated ~0.92 -> ~98%, random strangers
  // ~0.40 -> ~45%, vs the population aggregates ~0.46 -> ~52%.
  // Cheap (two 512-loops), safe to call repeatedly while the counts are still
  // filling in -- the page refreshes these live during simulation.
  function compareStats(countsA, countsB) {
    function profile(c, invert) {
      var m = new Float64Array(N_VOXELS), sum = 0, n = 0;
      var w = WEIGHTS;
      for (var v = 0; v < N_VOXELS; v++) {
        var o = c.off[v];
        if (o <= 0) continue;
        var s = invert
          ? (o - c.r1[v]) / o
          : (w.w1 * c.r1[v] + w.w2 * c.r2[v] + w.wF * c.fn[v] - w.wRej * (o - c.r1[v])) / o;
        m[v] = s; sum += s; n++;
      }
      var mean = n ? (sum / n) || 1 : 1;
      for (var k = 0; k < N_VOXELS; k++) m[k] /= mean;
      return m;
    }
    var a = profile(countsA, false), b = profile(countsB, false);
    var ra = profile(countsA, true), rb = profile(countsB, true);
    var sMin = 0, sMax = 0;
    var bothLikeVid = 0, bothLikeBest = -Infinity;
    var bothHateVid = 0, bothHateBest = -Infinity;
    var youLikeVid = 0, youLikeBest = -Infinity;   // you like it, they don't
    var theyLikeVid = 0, theyLikeBest = -Infinity; // they like it, you don't
    for (var v = 0; v < N_VOXELS; v++) {
      var lo = Math.min(a[v], b[v]);
      sMin += lo; sMax += Math.max(a[v], b[v]);
      if (lo > bothLikeBest) { bothLikeBest = lo; bothLikeVid = v; }
      var loHate = Math.min(ra[v], rb[v]);
      if (loHate > bothHateBest) { bothHateBest = loHate; bothHateVid = v; }
      var d = a[v] - b[v];
      if (d > youLikeBest) { youLikeBest = d; youLikeVid = v; }
      if (-d > theyLikeBest) { theyLikeBest = -d; theyLikeVid = v; }
    }
    var jaccard = sMax > 0 ? sMin / sMax : 0;
    var percent = Math.max(0, Math.min(100, Math.round(101 * jaccard + 5)));
    return {
      jaccard: jaccard,
      percent: percent,
      bothLikeVid: bothLikeVid, bothLikeHex: voxelHex(bothLikeVid),
      bothHateVid: bothHateVid, bothHateHex: voxelHex(bothHateVid),
      youLikeVid: youLikeVid, youLikeHex: voxelHex(youLikeVid),
      theyLikeVid: theyLikeVid, theyLikeHex: voxelHex(theyLikeVid),
    };
  }

  // Population aggregates (project-page summary.json `buckets.*.v`:
  // voxelId -> [off, r1, r2, fn]) as a counts object.
  function countsFromPopulation(vMap) {
    var counts = {
      off: new Float64Array(N_VOXELS), r1: new Float64Array(N_VOXELS),
      r2: new Float64Array(N_VOXELS), fn: new Float64Array(N_VOXELS),
    };
    for (var k in vMap) {
      var vid = +k;
      if (!(vid >= 0 && vid < N_VOXELS)) continue;
      var arr = vMap[k];
      counts.off[vid] = arr[0]; counts.r1[vid] = arr[1];
      counts.r2[vid] = arr[2]; counts.fn[vid] = arr[3];
    }
    return counts;
  }

  // ---- 3D render (lifted from main/projects/color-polygraph.html) ----

  function mountRenderer(canvas, counts) {
    var ctx2d = canvas.getContext('2d');
    var yaw = 0.6, pitch = -0.45, autoRotate = true, dragging = false, lastX = 0, lastY = 0;
    var inverted = false;
    var compareCounts = null;  // when set, render against the other side
    var compareKind = 'diff';  // 'diff' (signed) | 'same' (what both agree on)
    var raf = null;

    function rotateVec(x, y, z) {
      var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      var x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
      var y1 = cp * y - sp * z1, z2 = sp * y + cp * z1;
      return [x1, y1, z2];
    }
    function project(x, y, z, cx, cy, scale) {
      var dist = 4.2, f = scale / (dist + z);
      return [cx + x * f, cy - y * f, f];
    }
    function resize() {
      var dpr = global.devicePixelRatio || 1;
      var rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    }

    function frame(ts) {
      if (autoRotate) yaw = (ts || 0) * 0.00018;
      var w = canvas.width, h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);
      var cx = w / 2, cy = h / 2, scale = Math.min(w, h) * 0.88;

      var corners = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
      var proj = corners.map(function (c) { var r = rotateVec(c[0], c[1], c[2]); return project(r[0], r[1], r[2], cx, cy, scale); });
      var edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
      ctx2d.strokeStyle = 'rgba(235, 230, 218, 0.10)';
      ctx2d.lineWidth = 1;
      edges.forEach(function (e) { ctx2d.beginPath(); ctx2d.moveTo(proj[e[0]][0], proj[e[0]][1]); ctx2d.lineTo(proj[e[1]][0], proj[e[1]][1]); ctx2d.stroke(); });

      var axes = [
        { from: [-1,-1,-1], to: [1,-1,-1], color: 'rgba(255, 100, 100, 0.45)' },
        { from: [-1,-1,-1], to: [-1,1,-1], color: 'rgba(102, 221, 110, 0.45)' },
        { from: [-1,-1,-1], to: [-1,-1,1], color: 'rgba(106, 166, 255, 0.45)' },
      ];
      ctx2d.lineWidth = 1.4;
      axes.forEach(function (ax) {
        var a = rotateVec(ax.from[0], ax.from[1], ax.from[2]);
        var bb = rotateVec(ax.to[0], ax.to[1], ax.to[2]);
        var pa = project(a[0], a[1], a[2], cx, cy, scale), pb = project(bb[0], bb[1], bb[2], cx, cy, scale);
        ctx2d.strokeStyle = ax.color; ctx2d.beginPath(); ctx2d.moveTo(pa[0], pa[1]); ctx2d.lineTo(pb[0], pb[1]); ctx2d.stroke();
      });

      // Compare modes: 'diff' renders the signed difference (circle = this
      // survey likes it more, triangle = the other side does), 'same' renders
      // what both agree on (project page's "both" mode, plain dots).
      var signed = !!compareCounts && compareKind === 'diff';
      var scores = !compareCounts ? voxelScores(counts, inverted)
        : compareKind === 'same' ? sameScores(counts, compareCounts, inverted)
        : diffScores(counts, compareCounts, inverted);
      var step = 2 / GRID, maxAbs = 0;
      scores.forEach(function (v) {
        if (!signed && v <= 0) return;
        var a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
      });
      if (maxAbs === 0) maxAbs = 1;
      // In diff mode, never normalise up pure noise: equal tastes -> empty cube.
      if (signed && maxAbs < MIN_DIFF_SCALE) maxAbs = MIN_DIFF_SCALE;

      var points = [];
      scores.forEach(function (score, vid) {
        if (!signed && score <= 0) return;
        var rr = (vid >>> 6) & 7, gg = (vid >>> 3) & 7, bb2 = vid & 7;
        var x = -1 + (rr + 0.5) * step, y = -1 + (gg + 0.5) * step, z = -1 + (bb2 + 0.5) * step;
        var rot = rotateVec(x, y, z), p = project(rot[0], rot[1], rot[2], cx, cy, scale);
        points.push({ x: p[0], y: p[1], depth: rot[2], cr: rr * 32 + 16, cg: gg * 32 + 16, cb: bb2 * 32 + 16, score: score });
      });
      points.sort(function (a, b) { return b.depth - a.depth; });

      var baseRadius = Math.min(w, h) * 0.026;
      var CUTOFF = signed ? 0.12 : (inverted ? 0.72 : 0.32);
      points.forEach(function (pt) {
        var norm = pt.score / maxAbs;
        var mag = Math.abs(norm);
        if (mag < CUTOFF) return;
        var shaped = (mag - CUTOFF) / (1 - CUTOFF);
        var persp = 1 / (1 + pt.depth * 0.18);
        var radius = Math.max(1.0, Math.pow(shaped, 1.6) * baseRadius * persp);
        var alpha = Math.min(0.98, 0.55 + shaped * 0.45);
        ctx2d.beginPath();
        ctx2d.fillStyle = 'rgba(' + pt.cr + ',' + pt.cg + ',' + pt.cb + ',' + alpha + ')';
        if (signed && norm < 0) {
          // triangle = the OTHER side likes it more; circle = this survey
          var r = radius * 1.5551;
          ctx2d.moveTo(pt.x, pt.y - r);
          ctx2d.lineTo(pt.x + r * 0.866, pt.y + r * 0.5);
          ctx2d.lineTo(pt.x - r * 0.866, pt.y + r * 0.5);
          ctx2d.closePath();
        } else {
          ctx2d.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        }
        ctx2d.fill();
      });

      raf = global.requestAnimationFrame(frame);
    }

    canvas.addEventListener('pointerdown', function (e) { dragging = true; autoRotate = false; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', function (e) { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (_e) {} });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      yaw += (e.clientX - lastX) * 0.008; pitch += (e.clientY - lastY) * 0.008;
      pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('dblclick', function () { autoRotate = true; });
    global.addEventListener('resize', resize);

    resize();
    raf = global.requestAnimationFrame(frame);

    return {
      setInverted: function (v) { inverted = !!v; },
      // kind: 'diff' (default) | 'same'. counts may still be filling in -- the
      // render loop reads them live every frame.
      setCompare: function (otherCounts, kind) {
        compareCounts = otherCounts || null;
        compareKind = kind === 'same' ? 'same' : 'diff';
      },
      stop: function () { if (raf) global.cancelAnimationFrame(raf); global.removeEventListener('resize', resize); },
    };
  }

  // ---- simulation plumbing (shared by mount + simulateCounts) ----

  function emptyCounts() {
    return {
      off: new Float64Array(N_VOXELS), r1: new Float64Array(N_VOXELS),
      r2: new Float64Array(N_VOXELS), fn: new Float64Array(N_VOXELS),
    };
  }

  async function buildScorer(opts) {
    var history = opts.history;
    var r1 = history[0].map(function (q) { return q.winner.rgb; });
    var r2 = history.length > 1 ? history[1].map(function (q) { return q.winner.rgb; }) : [];
    var final = history[history.length - 1][0].winner.rgb;
    var ctx = TasteFeatures.sessionContext(r1, r2, final);
    var person = PickFeatures.personVector(opts.features);
    var model = await TreeWalker.load(opts.modelUrl);
    return makeScorer(model, person, ctx);
  }

  // Answer brackets in setTimeout-sized chunks (one bracket ~10-15ms short,
  // ~40-80ms long) so the page and render loop stay responsive while the
  // counts fill in.
  function runChunked(score, counts, total, numColors, onProgress, onDone, isStopped) {
    var perBracket = answersPerBracket(numColors);
    var answered = 0;
    function tick() {
      if (isStopped && isStopped()) return;
      runBracket(score, counts, numColors);
      answered += perBracket;
      if (onProgress) onProgress(Math.min(answered, total), total);
      if (answered < total) setTimeout(tick, 0);
      else if (onDone) onDone();
    }
    setTimeout(tick, 0);
  }

  // ---- public entry points ----
  //
  // mount(canvas, opts): build + render this person's cube live.
  // opts: {
  //   history:      survey history (rounds of {winner:{rgb}})
  //   features:     worker feature response {gender, age, mood}
  //   modelUrl:     URL of pick_trees.json / pick_long_trees.json
  //   long:         true -> simulate 256-colour long brackets
  //   totalAnswers: how many questions the AI answers (default TOTAL_ANSWERS)
  //   onProgress:   function(answered, total)
  //   onDone:       function()
  // }
  // Resolves to a controller {setInverted, setCompare, stop, counts} as soon
  // as the cube is mounted; answering continues in the background.
  async function mount(canvas, opts) {
    var score = await buildScorer(opts);
    var counts = emptyCounts();
    var controller = mountRenderer(canvas, counts);

    var total = opts.totalAnswers || TOTAL_ANSWERS;
    var numColors = opts.long ? 256 : 64;
    // Sanity line for tweaking via URL/console: confirms which build + config
    // is actually running (a cached old script won't print this shape).
    console.info('[PickCube v8]', 'answers=' + total, 'colors=' + numColors,
      'weights=' + JSON.stringify(WEIGHTS), 'sharpness=' + SHARPNESS);
    var stopped = false;
    var origStop = controller.stop;
    controller.stop = function () { stopped = true; origStop(); };
    controller.counts = counts;  // exposed for debugging / tests

    runChunked(score, counts, total, numColors, opts.onProgress, opts.onDone,
               function () { return stopped; });
    return controller;
  }

  // simulateCounts(opts): run the same simulation for ANOTHER survey (no
  // canvas). Resolves {counts, done} as soon as the scorer is ready: `counts`
  // fills in live (hand it to setCompare immediately so the comparison renders
  // while it simulates, same as the main cube), `done` resolves on completion.
  // Same opts as mount minus the canvas; opts.isStopped() aborts silently
  // (`done` then never resolves -- guard with your own staleness token).
  async function simulateCounts(opts) {
    var score = await buildScorer(opts);
    var counts = emptyCounts();
    var total = opts.totalAnswers || TOTAL_ANSWERS;
    var numColors = opts.long ? 256 : 64;
    var done = new Promise(function (resolve) {
      runChunked(score, counts, total, numColors, opts.onProgress,
                 function () { resolve(counts); }, opts.isStopped);
    });
    return { counts: counts, done: done };
  }

  // WEIGHTS is live: changing it (URL params above, or PickCube.WEIGHTS.w1 = x
  // in the console) re-shapes the cube on the next rendered frame.
  global.PickCube = {
    mount: mount,
    simulateCounts: simulateCounts,
    countsFromPopulation: countsFromPopulation,
    compareStats: compareStats,
    voxelHex: voxelHex,
    TOTAL_ANSWERS: TOTAL_ANSWERS,
    GRID: GRID,
    WEIGHTS: WEIGHTS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
