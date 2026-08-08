import { defineConfig } from 'vite';

/**
 * Coffee Coster is a fully static site — no server rendering, no API at
 * runtime. The coffee prices and the suburb gazetteer are generated ahead of
 * time by `npm run data` into public/data/, map tiles come straight from
 * OpenFreeMap's CDN, and the search index is built in the browser. So the
 * build output can be served by any static host.
 *
 * It builds into docs/ rather than dist/ because GitHub Pages can serve a
 * repository's docs/ folder on the default branch directly, with no deploy
 * workflow or gh-pages branch to keep in sync.
 */
export default defineConfig({
  // Project pages live at https://<user>.github.io/<repo>/, so assets must be
  // requested from that sub-path rather than the domain root. Override with
  // `BASE_PATH=/ npm run build` for a user/organisation page or a custom domain.
  base: process.env.BASE_PATH ?? '/coffee-coster/',

  build: {
    outDir: 'docs',
    emptyOutDir: true,
    // maplibre-gl is ~1MB on its own and is the whole point of the page, so
    // there is nothing meaningful to split out. Silence the size advisory.
    chunkSizeWarningLimit: 1200,
  },
});
