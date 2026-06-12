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
  var TOTAL_ANSWERS = 20000;
  var ANSWERS_PER_BRACKET = 21;                // 16 + 4 + 1, same as a short survey
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

  // One synthetic short survey, answered by the model. Mutates counts.
  function runBracket(score, counts) {
    var palette = generatePalette(64);
    var round = palette;
    var stage = 0;  // 0 -> tally off+r1, 1 -> tally r2, 2 -> tally final
    while (round.length > 1) {
      var winners = [];
      for (var qs = 0; qs < round.length; qs += 4) {
        var best = answerQuestion(round, qs, score);
        if (stage === 0) {
          for (var j = 0; j < 4; j++) counts.off[voxelId(round[qs + j])] += 1;
          counts.r1[voxelId(best)] += 1;
        } else if (stage === 1) {
          counts.r2[voxelId(best)] += 1;
        } else {
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

  // ---- 3D render (lifted from main/projects/color-polygraph.html) ----

  function mountRenderer(canvas, counts) {
    var ctx2d = canvas.getContext('2d');
    var yaw = 0.6, pitch = -0.45, autoRotate = true, dragging = false, lastX = 0, lastY = 0;
    var inverted = false;
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

      var scores = voxelScores(counts, inverted);
      var step = 2 / GRID, maxAbs = 0;
      scores.forEach(function (v) { if (v > maxAbs) maxAbs = v; });
      if (maxAbs === 0) maxAbs = 1;

      var points = [];
      scores.forEach(function (score, vid) {
        if (score <= 0) return;
        var rr = (vid >>> 6) & 7, gg = (vid >>> 3) & 7, bb2 = vid & 7;
        var x = -1 + (rr + 0.5) * step, y = -1 + (gg + 0.5) * step, z = -1 + (bb2 + 0.5) * step;
        var rot = rotateVec(x, y, z), p = project(rot[0], rot[1], rot[2], cx, cy, scale);
        points.push({ x: p[0], y: p[1], depth: rot[2], cr: rr * 32 + 16, cg: gg * 32 + 16, cb: bb2 * 32 + 16, score: score });
      });
      points.sort(function (a, b) { return b.depth - a.depth; });

      var baseRadius = Math.min(w, h) * 0.026;
      var CUTOFF = inverted ? 0.72 : 0.32;
      points.forEach(function (pt) {
        var mag = pt.score / maxAbs;
        if (mag < CUTOFF) return;
        var shaped = (mag - CUTOFF) / (1 - CUTOFF);
        var persp = 1 / (1 + pt.depth * 0.18);
        var radius = Math.max(1.0, Math.pow(shaped, 1.6) * baseRadius * persp);
        var alpha = Math.min(0.98, 0.55 + shaped * 0.45);
        ctx2d.beginPath();
        ctx2d.fillStyle = 'rgba(' + pt.cr + ',' + pt.cg + ',' + pt.cb + ',' + alpha + ')';
        ctx2d.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
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
      stop: function () { if (raf) global.cancelAnimationFrame(raf); global.removeEventListener('resize', resize); },
    };
  }

  // ---- public entry point ----
  //
  // opts: {
  //   history:      survey history (rounds of {winner:{rgb}})
  //   features:     worker feature response {gender, age, mood}
  //   modelUrl:     URL of pick_trees.json
  //   totalAnswers: how many questions the AI answers (default 5000)
  //   onProgress:   function(answered, total)
  //   onDone:       function()
  // }
  // Resolves to a controller {setInverted, stop} as soon as the cube is
  // mounted; the AI keeps answering in the background, one bracket (21
  // answers, ~10ms) per timeout tick, so the page never stutters.
  async function mount(canvas, opts) {
    var history = opts.history;
    var r1 = history[0].map(function (q) { return q.winner.rgb; });
    var r2 = history.length > 1 ? history[1].map(function (q) { return q.winner.rgb; }) : [];
    var final = history[history.length - 1][0].winner.rgb;

    var ctx = TasteFeatures.sessionContext(r1, r2, final);
    var person = PickFeatures.personVector(opts.features);
    var model = await TreeWalker.load(opts.modelUrl);
    var score = makeScorer(model, person, ctx);

    var counts = {
      off: new Float64Array(N_VOXELS), r1: new Float64Array(N_VOXELS),
      r2: new Float64Array(N_VOXELS), fn: new Float64Array(N_VOXELS),
    };
    var controller = mountRenderer(canvas, counts);

    var total = opts.totalAnswers || TOTAL_ANSWERS;
    var answered = 0;
    var stopped = false;
    var origStop = controller.stop;
    controller.stop = function () { stopped = true; origStop(); };
    controller.counts = counts;  // exposed for debugging / tests

    function tick() {
      if (stopped) return;
      runBracket(score, counts);
      answered += ANSWERS_PER_BRACKET;
      if (opts.onProgress) opts.onProgress(Math.min(answered, total), total);
      if (answered < total) {
        setTimeout(tick, 0);   // yield to the render loop between brackets
      } else if (opts.onDone) {
        opts.onDone();
      }
    }
    setTimeout(tick, 0);

    return controller;
  }

  // WEIGHTS is live: changing it (URL params above, or PickCube.WEIGHTS.w1 = x
  // in the console) re-shapes the cube on the next rendered frame.
  global.PickCube = { mount: mount, TOTAL_ANSWERS: TOTAL_ANSWERS, GRID: GRID, WEIGHTS: WEIGHTS };
})(typeof window !== 'undefined' ? window : globalThis);
