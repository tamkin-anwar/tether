# Chrome Web Store assets

- `listing/<lang>.txt`: the store description for each language (paste into
  Store listing, switching the language at the top of the form).
- `screenshots/tether-1..5.png`: 1280×800 store screenshots, in order.
  Rebuilt from `screenshots/src/shots.html` (`?shot=1` to `5`), rendered at 2×
  and scaled to 1280×800. The "show" in each is original SVG artwork
  (`src/scene.js`), so no streaming service's footage or branding appears.

The store name and summary for each language come from the extension itself
(`_locales/<lang>/messages.json`, built by `tools/build_locales.py`).
