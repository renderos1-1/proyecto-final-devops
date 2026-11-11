# Presentation (Spanish)

| File | What |
|---|---|
| `index.html` | **Main deck for the defense**: 9 slides, high level, split between the four presenters (Masciel Fuentes 1, 2, 9 · Axel Renderos 3, 4 · Ariel Alfaro 5, 6 · Benjamin Trabanino 7, 8). Speaker notes (N) contain each presenter's talking points. Visual style: soft-workspace palette (grey shell, white cards, lavender/pink accents, staggered entrances). |
| `detallado.html` | Detailed 26-slide version, kept as an appendix for in-depth questions. |

Self-contained HTML/CSS/JS decks: open `docs/slides/index.html` in a browser (no server needed; the Inter font loads from Google Fonts when online;
screenshots are loaded from `docs/evidence/` and `docs/slides/img/`).

| Key | Action |
|---|---|
| → / Space / Enter | next step (reveals list items, then the next slide) |
| ← / Backspace | previous |
| O | overview grid (click a slide to jump) |
| N | speaker notes for the current slide |
| F | fullscreen |
| click a screenshot | zoom (Esc closes) |
| `#12` in the URL | open directly at slide 12 |

Images in `img/` were captured with `tools/evidence/url-shot.mjs`. The timeline chart comes from
`uv run scripts/plot-experiment.py <experiment dir> es`.
