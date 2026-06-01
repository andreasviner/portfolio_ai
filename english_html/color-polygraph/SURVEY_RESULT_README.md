# Color Polygraph - `survey-result.html` technical reference

This document explains everything the results page does, end to end: how it is
reached, what data it reads, how it talks to the backend, how it runs the
machine-learning models in the browser, every screen it shows, and the full DOM
and CSS surface a designer can work against. It is meant to be self-contained:
hand it to a person or a model and they should understand the page completely
without reading the source.

File: `ai/english_html/color-polygraph/survey-result.html`
Served at: `https://ai.andreaslindeman.com/color-polygraph/survey-result`
Norwegian twin (not yet built): `ai/norwegian_html/color-polygraph/survey-result.html`

---

## 1. What this page is

The survey ([`survey.html`](survey.html)) is a color-elimination bracket: the
user repeatedly picks their favorite of four color swatches until one winner
remains. `survey.html` does NOT talk to the server. When the bracket finishes it
writes the whole session to `localStorage` and redirects here.

`survey-result.html` is the payoff screen. It:

1. Reads the saved session (or loads a shared one by id).
2. Sends the raw picks to a Cloudflare Worker API, which returns engineered
   feature vectors and a survey id.
3. Runs three pretrained models **in the browser** (LightGBM trees walked by
   `tree_walker.js`) to predict the user's gender, age, and current mood from
   nothing but their color choices.
4. Reveals each prediction one screen at a time, asking the user to confirm or
   correct it (the corrections are the ground-truth labels for future training).
5. Shows a final stats screen (favorite color, a hue strip of every pick, a
   "model got X of 3 correct" score) with retake / share actions.

There are two survey lengths that share this page:

- short survey: 64 colors, 21 questions
- long survey: 256 colors, 85 questions (structurally 4x the short survey plus
  one extra final question)

They use **separate trained models**. The only difference on this page is the
model filename suffix (`_long`) and which length was stored; the UI is identical.

---

## 2. How the page is reached (two run modes)

The entry point (`init()`, bottom of the inline script) decides the mode:

### Mode A - fresh result (the normal path)
The user just finished a survey. `survey.html` did:

```js
localStorage.setItem('cpgResult', JSON.stringify({
  winner,        // {hex, rgb} of the final chosen color
  history,       // per-round picks (see schema below)
  picks,         // per-question position + cumulative time
  startMs,       // Date.now() when the survey started
  long,          // true for the 256-color survey, false/absent for short
}));
window.location.href = 'survey-result';
```

On load, `init()` finds no `?id=` query param, reads `cpgResult`, removes it
from `localStorage` (so a refresh does not re-submit), and runs the full
interactive flow `runRevealFlow(savedState)`.

If `cpgResult` is missing or has no `winner`, it shows a "No survey data found"
error with a link back to `survey`.

### Mode B - shared link (read-only replay)
A finished survey can be shared. After submission the page rewrites its URL to
`survey-result?id=<uuid>`. Opening that URL takes the `?id` branch: `init()`
calls `runIdFlow(id)`, which `GET`s the stored result from the API and jumps
straight to the stats screen (no model run, no questions). Used for share links.

### URL parameters
- `?id=<uuid>` - load a stored result (Mode B).
- `?api=<url>` - override the API base (used for local/staging testing). Trailing
  slash is stripped.
- `window.COLOR_POLYGRAPH_API` - alternative API override via a global.

Default API base: `https://api.andreaslindeman.com/color-polygraph`.

---

## 3. The `cpgResult` localStorage schema (input to Mode A)

```jsonc
{
  "winner": { "hex": "#3FA9F5", "rgb": [63, 169, 245] },
  "history": [            // one array per bracket ROUND, in order
    [                     // round 0: each entry is one question
      { "winner": {hex,rgb}, "options": [ {hex,rgb} x4 ] },
      ...                 // short: 16 questions, long: 64 questions
    ],
    [ ... ],              // round 1 (short: 4 q, long: 16 q)
    [ ... ],              // round 2 (short: 1 q = final, long: 4 q)
    // long only:
    [ { "winner": {...}, "options": [4] } ]   // round 3: 1 q = final
  ],
  "picks": [              // one entry per question, in answer order
    { "position": 0..3,   // which of the 4 swatches was clicked
      "cumulativeMs": 1234 }  // ms since startMs at the moment of the pick
  ],
  "startMs": 1700000000000,
  "long": false
}
```

Short survey: `history` has 3 rounds, `picks` has 21 entries.
Long survey: `history` has 4 rounds, `picks` has 85 entries.

A color object is always `{ hex: "#RRGGBB", rgb: [r, g, b] }`.

---

## 4. End-to-end flow (Mode A, `runRevealFlow`)

```
read cpgResult
   |
   v
LOADING slide  --->  POST /survey {payload, metadata}
   |                      returns { id, features:{gender,age,mood} }
   |                      page rewrites URL to ?id=<id>
   v
GENDER slide  (load gender model, score features.gender, confirm)  --> POST /survey/:id/gender
   v
AGE slide     (load age model, score features.age, confirm)        --> POST /survey/:id/age
   v
MOOD slide    (load mood model, score features.mood, confirm)      --> POST /survey/:id/mood
   v
STATS slide   (favorite color, pills, hue strip, score, actions)
```

Each step loads its model lazily and caches it. A failure in any single
prediction step is caught and logged; the flow continues to the next step (the
page never hard-crashes mid-reveal). A failure of the initial `POST /survey`
shows an error slide and stops.

The model name helper is:
```js
const M = (name) => isLong ? name + '_long' : name;   // 'gender' -> 'gender_long'
```
so the long survey loads `gender_long_trees.json`, etc.

---

## 5. The slide engine

All screens render into a single container `<div class="rv-wrap" id="rvWrap">`.
There is exactly one visible slide at a time.

```js
function goSlide(buildFn) {
  // 1. mark the current slide .is-leaving and remove it after 400ms
  // 2. create a fresh <div class="rv-slide">, append, call buildFn(slideEl)
  // 3. on next animation frame add .is-current to trigger the enter transition
}
```

Slide lifecycle classes (drive the CSS transitions):
- `.rv-slide` - base: absolutely positioned, `opacity:0`, shifted right 56px.
- `.rv-slide.is-current` - visible: `opacity:1`, `translateX(0)`, interactive.
- `.rv-slide.is-leaving` - exiting: `opacity:0`, shifted left 56px, then removed.

Enter transition: 0.4s ease (opacity) + 0.42s cubic-bezier (slide-in from right).
Leave transition: 0.28s (slide-out to left). Net effect: horizontal card swap.

A winner-colored ambient glow is painted behind every slide via the CSS variable
`--winner-color`, set once near the start of the flow:
```js
document.documentElement.style.setProperty('--winner-color', winner.hex);
```

### Step indicator
`makeDots(activeKey)` returns the dot row HTML. Steps are
`['gender','age','mood','stats']`. Dots before the active one get `.is-done`,
the active one `.is-active`, and the active key is printed as a small label.
Classes: `.rv-dots`, `.rv-dot`, `.rv-dot.is-done`, `.rv-dot.is-active`,
`.rv-dot-label`.

---

## 6. Every screen in detail

### 6.1 Loading
```html
<div class="rv-center">
  <div class="rv-spinner"></div>
  <p class="rv-loading-label">Sending picks to model...</p>
</div>
```
Shown during `POST /survey` and again briefly before each model loads
("Loading gender model...", etc.). `.rv-spinner` is a CSS keyframe spinner.

### 6.2 Gender (binary classifier)
- Loads model `M('gender')`, computes `raw = TreeWalker.score(model, features.gender)`,
  then `prob = TreeWalker.sigmoid(raw)` = P(woman).
- `predGenderLabel = prob >= 0.5 ? 'woman' : 'man'`.
- Confidence shown = `round(max(prob, 1-prob) * 100)%`.
- Content: dots + eyebrow "We think you are a" + big italic label + confidence +
  two buttons: "That's right" (`#rvGY`, confirms prediction) and
  "Actually I'm a {other}" (`#rvGN`, confirms the opposite).
- On confirm: if the user agreed, `summary.correct += 1`. Posts
  `POST /survey/:id/gender { pred_prob: prob, confirmed_label: 'man'|'woman' }`.
- Classes: `.rv-eyebrow`, `.rv-big`, `.rv-conf`, `.rv-btns`, `.rv-btn.is-yes`,
  `.rv-btn.is-no`.

Note: the stylesheet contains `.rv-censor*` rules (a blurred "censored" bar).
These are NOT rendered by the current JS - vestigial styles, safe to ignore or
remove.

### 6.3 Age (regression)
- Loads model `M('age')`, `predAge = clamp(score, 6, 80)`, `rounded = round(predAge)`.
- Content: dots + "We think you are about" + big number (`rounded`) +
  "years old - enter your actual age below" + a number input + "Confirm age".
- The input **defaults to `0`** and is auto-selected. Save logic:
  ```js
  resolve(parseInt(inp.value, 10) || 0);
  ```
  The value is sent **verbatim, with no clamp or range check** (client or
  server). Rationale:
  - Leaving it at 0 (a click-through who does not engage) stores `0`.
  - Any real number is stored as-is, including nonsense like `-20`, so junk can
    be filtered out later.
  - This makes two groups separable in the data: pure click-throughs
    (`confirmed_age == 0`) versus genuinely-correct predictions
    (`confirmed_age == round(pred_age)`, nonzero).
- Scoring: counts as correct if `abs(confirmedAge - predAge) <= 3`.
- Posts `POST /survey/:id/age { pred_value: predAge, confirmed_value: confirmedAge }`.
- Classes: `.rv-age-wrap`, `input[type=number]`, `.rv-hint`, `.rv-btns`,
  `.rv-btn.is-yes`.

### 6.4 Mood (regression, 0-60 scale)
- Loads model `M('mood')`, `predMood = clamp(score, 0, 60)`, `rounded = round(predMood)`.
- Mood scale: 0 = sad, 60 = happy. `moodLabel(v)`: `>=45 happy`, `>=30 okay`,
  `>=15 down`, else `glum`.
- Content: dots + "How are you feeling right now?" + big mood word (live-updates
  as the slider moves) + a range slider (`min 0`, `max 60`) with the labels
  Glum / Down / Okay / Happy + "Confirm mood".
- Save: `resolve(parseInt(slider.value, 10))` (slider, so always 0-60).
- Scoring: correct if `abs(confirmedMood - predMood) <= 10`.
- Posts `POST /survey/:id/mood { pred_value: predMood, confirmed_value: confirmedMood }`.
- Classes: `.rv-slider-wrap`, `input[type=range]`, `.rv-slider-labels`.

### 6.5 Stats (final screen, `showStatsSlide`)
Layout `.rv-stats-layout` is a two-column grid (color swatch | details), stacking
to one column under 600px.

Contents:
- `.rv-winner-swatch` - large square filled with the winning color.
- `.rv-eyebrow` "Your favourite color" + `.rv-winner-hex` (uppercased hex) +
  `.rv-winner-rgb` (`rgb(r, g, b)`).
- `.rv-pills` - a row of `.rv-pill` chips, each rendered only if its value
  exists: Gender, Age, Mood (as a word), Palette tone, Time. The bold value uses
  `.rv-pill b`.
- Hue strip (`buildHueStrip`): every picked winner across all rounds, sorted by
  hue, rendered as thin colored columns. Classes `.rv-hue-strip` (the bar) and
  `.rv-hue-strip-label` ("All your picks sorted by hue").
- Score line `.rv-score` "The model got X of 3 correct." (only when a score is
  known; absent in the shared-link flow if confirmations are incomplete).
- `.rv-actions` row:
  - `.rv-retake` button -> navigates to `survey?type=long` (if this was a long
    survey) or `survey?type=short`. `?type=...` makes `survey.html` start that
    mode immediately, skipping its start buttons.
  - `.rv-share` button -> `navigator.share` if available, else copies the share
    text + URL to the clipboard and flashes `.rv-share-toast` "Link copied".
  - Share text: "My favourite color is {HEX}. The AI guessed {X/3 of | my}
    gender, age & mood from {N} colour picks."
- Short-survey-only call to action (hidden when `long` is true): a small line
  linking to `survey?type=long` - "Want a sharper read? Take the long test - it's
  highly accurate."
- A `.project-back` link "More about the project".

`paletteTone(history)`: averages the hue of all picked winners and labels the
palette `warm` / `cool` / `mixed`.

---

## 7. Shared-link flow (Mode B, `runIdFlow`)

```
LOADING ("Loading results...")
   |
   v
GET /survey/:id  -->  { winner_hex, winner_rgb,
                        confirmed_gender, confirmed_age, confirmed_mood,
                        correct_count, history, picks, long_survey }
   |
   v
STATS slide (same showStatsSlide, score = correct_count, long = long_survey)
```

No model is run and no questions are asked - it is a read-only replay of a
previously completed survey. On a failed GET it shows "Could not load results for
this ID" with a link to take the survey.

---

## 8. Backend API contract (Cloudflare Worker)

Base: `https://api.andreaslindeman.com/color-polygraph`. All responses are JSON
and CORS-enabled for the site origins. Errors come back as `{ "error": "..." }`
with a 4xx/5xx status; `postJson`/`getJson` throw `HTTP <status> - <error>`.

### POST `/survey`
Request body: `{ payload, metadata }` (see exact shapes below). The worker
validates the bracket shape, computes the feature vectors server-side, stores the
row in a D1 (SQLite) database, and returns:
```json
{ "id": "uuid", "features": { "gender": [..], "age": [..], "mood": [..] } }
```
Short survey feature lengths: gender 477, age 475, mood 475.
Long survey feature lengths: gender 237, age 235, mood 235 (a different,
separately trained feature set).

### POST `/survey/:id/gender`  body `{ pred_prob, confirmed_label }`
### POST `/survey/:id/age`     body `{ pred_value, confirmed_value }`
### POST `/survey/:id/mood`    body `{ pred_value, confirmed_value }`
Each records the prediction plus the user's confirmed truth; return `{ ok: true }`.
No range validation on age (any integer is stored).

### GET `/survey/:id`
Returns the stored result for the share-link replay (shape in section 7).

---

## 9. Exact request shapes built on this page

### `buildPayload(savedState)`
RGB triples, derived from `history`:
```jsonc
{
  "offered": [[r,g,b], ...],  // every color shown in round 0 (short 64 / long 256)
  "r1":      [[r,g,b], ...],  // round-0 winners (short 16 / long 64)
  "r2":      [[r,g,b], ...],  // round-1 winners (short 4 / long 16)
  "final":   [r,g,b],         // the single overall winner
  "valg":    "0312...",       // one digit 0-3 per question (short 21 / long 85)
  "tider":   [123, 456, ...], // cumulative ms per question
  // long survey only:
  "r3":      [[r,g,b] x4],    // round-2 winners (the 4 finalists)
  "long":    true
}
```
`valg` (Norwegian for "choices") is the clicked position 0-3 per question;
`tider` ("times") are the cumulative millisecond timestamps. The server uses
these for timing/behavioral features.

### `buildMetadata(savedState)`
```jsonc
{
  "client_started_at": 1700000000000,   // savedState.startMs
  "client_submitted_at": 1700000123456, // Date.now() now
  "client_local_time": "2026-06-01T12:00:00.000Z",
  "user_agent": "...", "referrer": "...",
  "language": "en-US", "locale": "en-US,en",
  "is_mobile": true,
  "screen_w": 1920, "screen_h": 1080,
  "viewport_w": 1200, "viewport_h": 800,
  "timezone_client": "Europe/Oslo"
}
```
The server adds its own fields (hashed IP, Cloudflare geo) - those are not sent
from the browser.

---

## 10. In-browser inference (`tree_walker.js`)

The page loads `./models-js/tree_walker.js`, then per prediction lazily fetches a
JSON model from `./models-js/<name>_trees.json` (cached after first load):

- short: `gender_trees.json`, `age_trees.json`, `mood_trees.json`
- long:  `gender_long_trees.json`, `age_long_trees.json`, `mood_long_trees.json`

Each JSON is a LightGBM gradient-boosted forest flattened into arrays. The walker:
```js
const raw  = TreeWalker.score(model, featureVector);  // sum of leaf values
const prob = TreeWalker.sigmoid(raw);                  // only for the binary gender head
```
- gender: `score` is a logit -> `sigmoid` -> P(woman).
- age / mood: `score` is the value directly (years, or 0-60), then clamped.

The model files are large (roughly 1.5-3.6 MB each) and fetched with
`cache: 'force-cache'`. The feature vectors themselves are computed server-side
and arrive in the `POST /survey` response, so the browser only does the cheap
tree walk, never feature engineering.

---

## 11. Scoring ("X of 3")

`summary.correct` increments when:
- gender: the user confirms the predicted label.
- age: `abs(confirmedAge - predAge) <= 3` years.
- mood: `abs(confirmedMood - predMood) <= 10` points.

Shown on the stats slide as "The model got X of 3 correct." Because age defaults
to 0 and 0 stores literally, a click-through who never enters an age will usually
NOT score the age point (0 is far from the prediction) - which is intentional.

---

## 12. Full CSS class reference (for design)

The page ships its own `<style>` block plus the shared site stylesheet
`../style.css`. Design tokens (CSS variables) used: `--bg`, `--text`,
`--text-mute`, `--text-dim`, `--hairline`, `--hairline-2`, `--surface`,
`--hobby` (the accent/gold), `--serif`, `--mono`, plus `--winner-color` set at
runtime.

Structure:
- `.rv-wrap#rvWrap` - full-bleed flex container that holds the single slide.
- `.rv-slide` / `.is-current` / `.is-leaving` - the swapping cards (section 5).
- `.rv-slide::after` - ambient `--winner-color` glow.

Reusable pieces:
- `.rv-dots`, `.rv-dot`, `.rv-dot.is-done`, `.rv-dot.is-active`, `.rv-dot-label`
- `.rv-center`, `.rv-spinner`, `.rv-loading-label`, `.rv-error` (+ `.rv-error a`)

Prediction screens:
- `.rv-eyebrow` (small caps label above), `.rv-big` (huge serif italic value),
  `.rv-conf` (confidence/subtext)
- `.rv-btns`, `.rv-btn`, `.rv-btn.is-yes` (accent), `.rv-btn.is-no` (ghost)
- `.rv-age-wrap` + `input[type=number]` + `.rv-hint`
- `.rv-slider-wrap` + `input[type=range]` + `.rv-slider-labels`
- `.rv-censor`, `.rv-censor::before`, `.rv-censor-bar` (DEFINED BUT UNUSED)

Stats screen:
- `.rv-stats-layout` (grid 160px | 1fr, collapses < 600px)
- `.rv-winner-swatch`, `.rv-winner-hex`, `.rv-winner-rgb`
- `.rv-pills`, `.rv-pill`, `.rv-pill b`
- `.rv-hue-strip`, `.rv-hue-strip-label`
- `.rv-score` (+ `.rv-score b`)
- `.rv-actions`, `.rv-retake` (accent button), `.rv-share` (ghost button),
  `.rv-share-toast`

Site chrome (from `../style.css`): `.site-nav`, `.brand`, `.nav-toggle`,
`.nav-links`, `.lang-switch`, `.project-back`.

Responsive: a `@media (max-width: 600px)` block collapses the stats grid, shrinks
`.rv-big`, tightens padding.

---

## 13. States, edge cases, and failure handling

- No `cpgResult` and no `?id`: "No survey data found" + link to `survey`.
- `POST /survey` fails: "Could not reach the inference server. Try again in a
  moment." Flow stops (no partial reveal).
- An individual model step throwing: caught, `console.warn`, flow continues; that
  prediction is simply skipped and not counted.
- `GET /survey/:id` fails (Mode B): "Could not load results for this ID" + link.
- Refresh safety: `cpgResult` is deleted from `localStorage` as soon as it is
  read, so reloading the page will not re-submit; after the first submit the URL
  carries `?id`, so a reload becomes a clean Mode B replay.
- The page is full-height and non-scrolling by design (`html, body { height:100%;
  overflow:hidden }`); each slide scrolls internally if it overflows.

---

## 14. Quick design guidance (what is safe to change)

Safe to restyle freely: all `.rv-*` classes, colors (prefer the existing CSS
variables), typography, the slide transition timings, spacing, and the layout of
each screen. The dot indicator, pills, hue strip, and swatch are all presentation
only.

Do not change without touching JS:
- the element IDs the script queries: `#rvWrap`, `#rvGY`, `#rvGN`, `#rvAgeInp`,
  `#rvAgeSave`, `#rvMoodSlider`, `#rvMoodWord`, `#rvMoodSave`, `#rvRetake`,
  `#rvShare`, `#rvToast`;
- the `.rv-slide` / `.is-current` / `.is-leaving` class names and the 400ms /
  280ms transition timings (the JS removes leaving slides on a matching timer);
- the `--winner-color` variable name;
- the API request/response field names in sections 8-9.

The four-step order (gender, age, mood, stats) and the confirm-the-prediction
interaction are the core mechanic; keep the "guess then let the user correct it"
pattern, since the corrections are the training labels.
```
