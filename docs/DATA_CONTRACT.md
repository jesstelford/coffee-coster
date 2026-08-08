# Data Contract

Both files live in `public/data/` and are consumed by the app at runtime.

They are **generated** by the pipeline (`npm run data`) — never hand-edit them. Fix the
scripts in `scripts/` or `data/overrides.json` and re-run.

## 1) `public/data/coffees.json` — the extracted coffee prices

```json
{
  "source": { "url": "<reddit thread url>", "postId": "1vii42k", "title": "...", "fetchedAt": "<ISO>" },
  "generatedAt": "<ISO8601>",
  "count": <number>,
  "coffees": [
    {
      "id": "<reddit comment id, e.g. mxy12ab>",
      "price": 5.5,                  // AUD, number, 2dp max
      "lat": -28.1234, "lon": 153.4567,
      "location": "Palm Beach",      // human display name of the suburb/town
      "state": "QLD",                // AU state/territory abbreviation
      "confidence": "high",          // "high" | "medium" | "low"
      "drink": "flat white",         // or null if not stated
      "excerpt": "Paid $7.10 for a flat white this am",  // <= 180 chars, cleaned
      "author": "PossumProofed",
      "permalink": "https://www.reddit.com/r/AskAnAustralian/comments/1vii42k/comment/<id>/"
    }
  ]
}
```

## 2) `public/data/suburbs.json` — the search gazetteer

COMPACT format to keep mobile payload small:

```json
{
  "generatedAt": "<ISO8601>",
  "count": <number>,
  "fields": ["name", "state", "lat", "lon"],
  "suburbs": [ ["Palm Beach", "QLD", -28.1234, 153.4567], ... ]
}
```

Coordinates rounded to 4 decimal places. Deduplicated to unique (name, state) pairs — GeoNames has
one row per postcode, so many suburbs repeat; keep one entry per name+state using the mean of its
coordinates. Sorted alphabetically by name.
