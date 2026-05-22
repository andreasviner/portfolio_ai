# ai.andreaslindeman.com

This folder is the content of `ai.andreaslindeman.com`, a separate
deployment from `andreaslindeman.com`. The split exists because the .com
host does not allow ML workloads, and several portfolio projects want to
ship a real training pipeline alongside the write-up.

## What lives here

- `index.html` is a permanent redirect to the main domain. The subdomain
  root has no homepage of its own.
- Each AI-relevant portfolio project gets its own folder, e.g.
  `color-polygraph/`, holding the leaderboard page and a `training/`
  subfolder with one folder per architecture.
- `style.css` and `icon.png` are local copies of the main site's assets so
  the subdomain renders the same look and feel without depending on a
  cross-origin fetch.
- `_template.html` is the starting point for new AI sub-project pages
  (English).
- `norwegian_html/_template.html` is the Norwegian translation of the
  template for pages that need a `.no` counterpart.
- `sitemap.xml` lists the public URLs hosted on the AI subdomain.

## Conventions

- AI sub-project URL pattern: `https://ai.andreaslindeman.com/<slug>/`
  served by `<slug>/index.html`.
- Training code lives at `<slug>/training/<architecture>/` with shared
  features at `<slug>/training/`.
- Raw dataset goes in `<slug>/training/raw/` so the deep-learning scripts
  can find it via a stable relative path.
- Cross-domain links from this subdomain back to the main portfolio use
  absolute URLs (`https://andreaslindeman.com/...`), not relative paths.

## Building a new sub-project page

1. Copy `_template.html` to `<slug>/index.html`.
2. Make a sibling `training/` folder if there are training scripts.
3. Update the cross-domain back link at the top and bottom of the page.
4. Add the new URL to `sitemap.xml`.
5. Link to the new page from the matching project on the main domain.
