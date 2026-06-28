# Berkshire Watcher Agent Instructions

Use Ponytail full: keep portfolio/watchlist edits small, reuse the current JSON shape, and avoid new dependencies unless the user explicitly asks.

When managing `data/portfolio.json` and `data/profiles/*.json`, use the installed AI Berkshire skills as the analysis source when available:

- `news-pulse`: explain big price/news moves through company events, regulation/policy, peers/industry, and market sentiment.
- `thesis-tracker`: decide whether a holding is `강한 홀드 신호`, `보유 유지`, `다시 고려`, or `위험 신호`.
- `industry-research`: build factor maps, chain explanations, related stocks, upstream/downstream links, sector cycle notes, and source groups.
- `portfolio-review`: check portfolio overlap, hidden correlation, concentration, and theme duplication.

If an AI Berkshire report for the ticker exists under `../ai-berkshire/reports`, read it before inventing thesis/risk triggers.

For Telegram/Telecodex requests:

1. Keep `data/portfolio.json` thin: ticker, name, status, portfolios, template, profile.
2. Put detailed thesis factors in `data/profiles/TICKER.json`.
3. Reuse `data/templates/*.json` for sector/theme defaults before adding repeated fields to a profile.
4. Use `status: "holding"` for stocks the user says they own; use `status: "watching"` for watchlist-only names.
5. Prefer `paused` over deletion unless the user says to remove/delete the stock.
6. Run `npm run check` after non-trivial edits.
7. Commit to `main` and push when the user asks.
