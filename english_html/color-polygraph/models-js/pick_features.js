// JS mirror of training/taste-cube/pick_features.py for the colour-pick model:
// person (prod features, delivered by the worker) + one candidate colour ->
// probability the person would pick it.
//
// Only the candidate + interaction blocks are computed in the browser; the
// person vector is assembled verbatim from the worker's `features` response.
// Depends on taste_features.js (TasteFeatures) for the shared colour math,
// session context and the 17 interaction features. train_pick.py emits
// pick_parity.json; checkParity(fixture) must stay < 1e-5.
(function (global) {
  'use strict';

  var TF = global.TasteFeatures;

  function rgbToCmyk(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var k = 1 - Math.max(r, g, b);
    if (k >= 1) return [0, 0, 0, 1];
    return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
  }

  function rgbToYuv(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    return [
      0.299 * r + 0.587 * g + 0.114 * b,
      -0.169 * r - 0.331 * g + 0.500 * b,
      0.500 * r - 0.419 * g - 0.081 * b,
    ];
  }

  // Same 12 reference colours as taste_features.py / features.py.
  var REFERENCE_NORM = [
    [255, 182, 193], [220, 40, 40], [255, 140, 0], [250, 220, 20],
    [50, 170, 60], [20, 200, 220], [40, 60, 220], [140, 60, 200],
    [140, 90, 50], [128, 128, 128], [20, 20, 20], [240, 240, 240],
  ].map(function (c) { return [c[0] / 255, c[1] / 255, c[2] / 255]; });

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

  // ~33 floats describing one new colour. MUST match pick_features.py order:
  // rgb, hsl, hue sin/cos, warmth, chroma, lab, cmyk, yuv, 12 ref dists, argmin.
  function candidateVector(rgb) {
    var hsl = TF.rgbToHsl(rgb);
    var lab = TF.srgbToLab(rgb);
    var refs = refDistances(rgb);
    var out = [
      rgb[0] / 255, rgb[1] / 255, rgb[2] / 255,
      hsl[0], hsl[1], hsl[2],
      Math.sin(2 * Math.PI * hsl[0]), Math.cos(2 * Math.PI * hsl[0]),
      (rgb[0] - rgb[2]) / 255,
      (Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])) / 255,
      lab[0], lab[1], lab[2],
    ];
    out = out.concat(rgbToCmyk(rgb)).concat(rgbToYuv(rgb)).concat(refs);
    out.push(argmin(refs));
    return out;
  }

  // The person vector exactly as trained: worker features.gender (477) +
  // the age and mood bucket totals (last element of each vector).
  function personVector(features) {
    return features.gender.concat([
      features.age[features.age.length - 1],
      features.mood[features.mood.length - 1],
    ]);
  }

  // Full model row. `person` from personVector(features); `ctx` from
  // TasteFeatures.sessionContext(r1Winners, r2Winners, final).
  function featureRow(person, ctx, rgb) {
    return person.concat(candidateVector(rgb)).concat(TF.interactionVector(rgb, ctx));
  }

  function checkParity(fixture) {
    var maxDelta = 0;
    fixture.samples.forEach(function (s) {
      var ctx = TF.sessionContext(s.r1, s.r2, s.final);
      s.candidates.forEach(function (c) {
        var cand = candidateVector(c.rgb);
        var inter = TF.interactionVector(c.rgb, ctx);
        for (var i = 0; i < cand.length; i++) maxDelta = Math.max(maxDelta, Math.abs(cand[i] - c.cand[i]));
        for (var k = 0; k < inter.length; k++) maxDelta = Math.max(maxDelta, Math.abs(inter[k] - c.inter[k]));
      });
    });
    return maxDelta;
  }

  global.PickFeatures = {
    candidateVector: candidateVector,
    personVector: personVector,
    featureRow: featureRow,
    checkParity: checkParity,
  };
})(typeof window !== 'undefined' ? window : globalThis);
