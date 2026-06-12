// JS mirror of training/taste-cube/taste_features.py — the single source of
// truth for the taste-cube model's inputs at SERVE time. It must match the
// Python extractor bit-for-bit; train_taste.py emits taste_parity.json, and
// TasteFeatures.checkParity(fixture) verifies the match within 1e-5.
//
// Fingerprint uses WINNERS ONLY (r1 / r2 / final), so it works on both the
// fresh-completion path and the shared ?id= path (which has no offered options).
(function (global) {
  'use strict';

  // Same 12 reference colours as taste_features.py / features.py.
  var REFERENCE_NORM = [
    [255, 182, 193], [220, 40, 40], [255, 140, 0], [250, 220, 20],
    [50, 170, 60], [20, 200, 220], [40, 60, 220], [140, 60, 200],
    [140, 90, 50], [128, 128, 128], [20, 20, 20], [240, 240, 240],
  ].map(function (c) { return [c[0] / 255, c[1] / 255, c[2] / 255]; });

  var N_R0 = 16;

  // Python's % is always non-negative for a positive modulus; JS % is not.
  function pymod(a, n) { return ((a % n) + n) % n; }

  function mean(xs) {
    if (!xs.length) return 0;
    var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }
  function std(xs) {
    if (!xs.length) return 0;
    var m = mean(xs), s = 0;
    for (var i = 0; i < xs.length; i++) s += (xs[i] - m) * (xs[i] - m);
    return Math.sqrt(s / xs.length);
  }
  function polyfitSlope(ys) {
    var n = ys.length;
    if (n < 2) return 0;
    var mx = (n - 1) / 2, my = mean(ys), num = 0, den = 0;
    for (var i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) * (i - mx); }
    return den ? num / den : 0;
  }

  function rgbToHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    var d = mx - mn;
    var s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    var h;
    if (mx === r) h = pymod((g - b) / d, 6);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function gamma(c) { return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; }
  function srgbToLab(rgb) {
    var r = gamma(rgb[0] / 255), g = gamma(rgb[1] / 255), b = gamma(rgb[2] / 255);
    var x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    var y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.00000;
    var z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : (7.787 * t + 16 / 116); }
    var fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labDist(a, b) {
    return Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
  }
  function rgbDistNorm(a, b) {
    var dr = (a[0] - b[0]) / 255, dg = (a[1] - b[1]) / 255, db = (a[2] - b[2]) / 255;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }
  function hueCircDiff(h1, h2) { var d = pymod(h1 - h2, 1); return Math.min(d, 1 - d); }
  function refDistances(rgb) {
    var rn = rgb[0] / 255, gn = rgb[1] / 255, bn = rgb[2] / 255, out = [];
    for (var i = 0; i < REFERENCE_NORM.length; i++) {
      var c = REFERENCE_NORM[i];
      out.push(Math.sqrt((c[0] - rn) * (c[0] - rn) + (c[1] - gn) * (c[1] - gn) + (c[2] - bn) * (c[2] - bn)));
    }
    return out;
  }
  function argmin(xs) {
    var best = 0, bv = xs[0];
    for (var i = 1; i < xs.length; i++) if (xs[i] < bv) { bv = xs[i]; best = i; }
    return best;
  }

  function sessionContext(r1Winners, r2Winners, final) {
    var r1 = r1Winners.map(function (c) { return [c[0], c[1], c[2]]; });
    var r2 = r2Winners.map(function (c) { return [c[0], c[1], c[2]]; });
    var fin = [final[0], final[1], final[2]];

    var r1Hsl = r1.map(rgbToHsl);
    var r1Lab = r1.map(srgbToLab);
    var r1_r = r1.map(function (c) { return c[0] / 255; });
    var r1_g = r1.map(function (c) { return c[1] / 255; });
    var r1_b = r1.map(function (c) { return c[2] / 255; });
    var r1_h = r1Hsl.map(function (c) { return c[0]; });
    var r1_s = r1Hsl.map(function (c) { return c[1]; });
    var r1_l = r1Hsl.map(function (c) { return c[2]; });

    var sinSum = 0, cosSum = 0;
    for (var i = 0; i < r1_h.length; i++) { sinSum += Math.sin(2 * Math.PI * r1_h[i]); cosSum += Math.cos(2 * Math.PI * r1_h[i]); }
    var prefHue = pymod(Math.atan2(sinSum, cosSum) / (2 * Math.PI), 1);

    var r1MeanRgb = [mean(r1_r) * 255, mean(r1_g) * 255, mean(r1_b) * 255];
    var r1MeanLab = [mean(r1Lab.map(function (c) { return c[0]; })),
                     mean(r1Lab.map(function (c) { return c[1]; })),
                     mean(r1Lab.map(function (c) { return c[2]; }))];
    var r2MeanRgb = r2.length
      ? [mean(r2.map(function (c) { return c[0]; })), mean(r2.map(function (c) { return c[1]; })), mean(r2.map(function (c) { return c[2]; }))]
      : r1MeanRgb.slice();

    var warmth = r1.map(function (c) { return (c[0] - c[2]) / 255; });
    var finLab = srgbToLab(fin), finHsl = rgbToHsl(fin);

    var r2Lab = r2.length ? r2.map(srgbToLab) : [r1MeanLab];
    var r2MeanLab = [mean(r2Lab.map(function (c) { return c[0]; })),
                     mean(r2Lab.map(function (c) { return c[1]; })),
                     mean(r2Lab.map(function (c) { return c[2]; }))];

    var voxSet = {};
    for (var j = 0; j < r1.length; j++) voxSet[(r1[j][0] >> 5) + ',' + (r1[j][1] >> 5) + ',' + (r1[j][2] >> 5)] = 1;
    var voxDiv = Object.keys(voxSet).length / Math.max(1, r1.length);

    var spread = 0, npair = 0;
    for (var a = 0; a < r1.length; a++) for (var bIdx = a + 1; bIdx < r1.length; bIdx++) { spread += rgbDistNorm(r1[a], r1[bIdx]); npair++; }
    spread = npair ? spread / npair : 0;

    return {
      r1: r1, r1Lab: r1Lab, r2: r2,
      r1_r: r1_r, r1_g: r1_g, r1_b: r1_b, r1_h: r1_h, r1_s: r1_s, r1_l: r1_l,
      final: fin, finLab: finLab, finHsl: finHsl, warmth: warmth,
      prefHue: prefHue, meanSat: mean(r1_s), meanLight: mean(r1_l), meanWarmth: mean(warmth),
      r1MeanRgb: r1MeanRgb, r1MeanLab: r1MeanLab, r2MeanRgb: r2MeanRgb, r2MeanLab: r2MeanLab,
      voxDiv: voxDiv, spread: spread, finRefArgmin: argmin(refDistances(fin)),
    };
  }

  function fingerprintVector(ctx) {
    var out = [];
    out.push(mean(ctx.r1_r), mean(ctx.r1_g), mean(ctx.r1_b),
             std(ctx.r1_r), std(ctx.r1_g), std(ctx.r1_b),
             mean(ctx.r1_h), mean(ctx.r1_s), mean(ctx.r1_l),
             std(ctx.r1_h), std(ctx.r1_s), std(ctx.r1_l));
    var r2 = ctx.r2;
    if (r2.length) {
      out.push(mean(r2.map(function (c) { return c[0]; })) / 255,
               mean(r2.map(function (c) { return c[1]; })) / 255,
               mean(r2.map(function (c) { return c[2]; })) / 255);
      var r2Hsl = r2.map(rgbToHsl);
      out.push(mean(r2Hsl.map(function (c) { return c[0]; })),
               mean(r2Hsl.map(function (c) { return c[1]; })),
               mean(r2Hsl.map(function (c) { return c[2]; })));
    } else {
      out.push(0, 0, 0, 0, 0, 0);
    }
    var fin = ctx.final, fh = ctx.finHsl, flab = ctx.finLab;
    out.push(fin[0] / 255, fin[1] / 255, fin[2] / 255,
             fh[0], fh[1], fh[2],
             flab[0], flab[1], flab[2],
             (fin[0] - fin[2]) / 255,
             (Math.max(fin[0], fin[1], fin[2]) - Math.min(fin[0], fin[1], fin[2])) / 255);
    out.push(polyfitSlope(ctx.warmth), polyfitSlope(ctx.r1_l), polyfitSlope(ctx.r1_s), ctx.spread, ctx.voxDiv);
    return out;
  }

  function candidateVector(rgb) {
    var hsl = rgbToHsl(rgb), lab = srgbToLab(rgb);
    var out = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255,
               hsl[0], hsl[1], hsl[2],
               (rgb[0] - rgb[2]) / 255,
               (Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])) / 255,
               lab[0], lab[1], lab[2]];
    return out.concat(refDistances(rgb));
  }

  function interactionVector(rgb, ctx) {
    var hsl = rgbToHsl(rgb), lab = srgbToLab(rgb), refs = refDistances(rgb);
    var minLab = Infinity;
    for (var i = 0; i < ctx.r1Lab.length; i++) { var d = labDist(lab, ctx.r1Lab[i]); if (d < minLab) minLab = d; }
    if (!ctx.r1Lab.length) minLab = 0;
    var minRgb = Infinity;
    for (var j = 0; j < ctx.r1.length; j++) { var dr = rgbDistNorm(rgb, ctx.r1[j]); if (dr < minRgb) minRgb = dr; }
    if (!ctx.r1.length) minRgb = 0;
    var warmth = (rgb[0] - rgb[2]) / 255;
    var signedHue = pymod(hsl[0] - ctx.prefHue + 0.5, 1) - 0.5;
    return [
      rgbDistNorm(rgb, ctx.r1MeanRgb),
      rgbDistNorm(rgb, ctx.r2MeanRgb),
      rgbDistNorm(rgb, ctx.final),
      labDist(lab, ctx.r1MeanLab),
      labDist(lab, ctx.finLab),
      minLab,
      hueCircDiff(hsl[0], ctx.prefHue),
      hsl[1] - ctx.meanSat,
      hsl[2] - ctx.meanLight,
      refs[ctx.finRefArgmin],
      argmin(refs) === ctx.finRefArgmin ? 1 : 0,
      // --- added interactions (must match taste_features.py order) ---
      signedHue,
      hueCircDiff(hsl[0], ctx.finHsl[0]),
      minRgb,
      labDist(lab, ctx.r2MeanLab),
      warmth - ctx.meanWarmth,
      minLab / (ctx.spread + 0.05),
    ];
  }

  function featureRow(ctx, rgb) {
    return fingerprintVector(ctx).concat(candidateVector(rgb)).concat(interactionVector(rgb, ctx));
  }

  // Verify this mirror against the Python-emitted fixture. Returns the max abs
  // difference across all sample feature rows (should be < 1e-5).
  function checkParity(fixture) {
    var maxDelta = 0;
    fixture.samples.forEach(function (s) {
      var ctx = sessionContext(s.r1, s.r2, s.final);
      var fp = fingerprintVector(ctx);
      for (var i = 0; i < fp.length; i++) maxDelta = Math.max(maxDelta, Math.abs(fp[i] - s.fingerprint[i]));
      s.candidates.forEach(function (c) {
        var row = featureRow(ctx, c.rgb);
        for (var k = 0; k < row.length; k++) maxDelta = Math.max(maxDelta, Math.abs(row[k] - c.row[k]));
      });
    });
    return maxDelta;
  }

  global.TasteFeatures = {
    N_R0: N_R0,
    sessionContext: sessionContext,
    fingerprintVector: fingerprintVector,
    candidateVector: candidateVector,
    interactionVector: interactionVector,
    featureRow: featureRow,
    checkParity: checkParity,
    // exposed for tests / reuse
    rgbToHsl: rgbToHsl, srgbToLab: srgbToLab,
  };
})(typeof window !== 'undefined' ? window : globalThis);
