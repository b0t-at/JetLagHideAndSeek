// @ts-check
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";

const require = createRequire(import.meta.url);
const arcgisPackage = require.resolve("@arcgis/core/package.json");
// Runtime assets of the ArcGIS operators the app uses: the projection engine behind
// the geodesic buffer/distance operators. Served from the app instead of js.arcgis.com;
// the client sets esriConfig.assetsPath to match (src/maps/geo-utils/arcgis-config.ts).
const ARCGIS_ASSETS = ["esri/geometry/support/pe-wasm.wasm"];
const ARCGIS_ASSETS_DIR = `arcgis-assets/${require(arcgisPackage).version}`;
const arcgisAssetSource = (/** @type {string} */ asset) =>
    path.join(path.dirname(arcgisPackage), "assets", asset);

/**
 * Copies the ArcGIS assets from the installed @arcgis/core into the build (and serves
 * them in dev), so they always match the library's JS and never sit in git.
 * @returns {import("astro").AstroIntegration}
 */
const arcgisAssets = () => ({
    name: "arcgis-assets",
    hooks: {
        "astro:server:setup": ({ server }) => {
            server.middlewares.use((req, res, next) => {
                const url = req.url?.split("?")[0] ?? "";
                const asset = ARCGIS_ASSETS.find((a) =>
                    url.endsWith(`/${ARCGIS_ASSETS_DIR}/${a}`),
                );
                if (!asset) return next();
                fs.createReadStream(arcgisAssetSource(asset))
                    .on("open", () =>
                        res.setHeader("Content-Type", "application/wasm"),
                    )
                    .on("error", (err) => {
                        if (res.headersSent) res.destroy(err);
                        else next();
                    })
                    .pipe(res);
            });
        },
        // Runs before AstroPWA's build:done, so the service worker precaches them
        "astro:build:done": ({ dir }) => {
            for (const asset of ARCGIS_ASSETS) {
                const target = path.join(
                    fileURLToPath(dir),
                    ARCGIS_ASSETS_DIR,
                    asset,
                );
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(arcgisAssetSource(asset), target);
            }
        },
    },
});

const DAY = 24 * 60 * 60;

/**
 * Retries a tile or icon request without CORS when the CORS request failed, in case a
 * host stops sending CORS headers. Only when the failure came fast while online: a
 * CORS refusal comes with the response, while a flaky connection fails slowly or
 * offline, and retrying those would only double the waiting.
 * The functions run inside the service worker (workbox-build copies their source),
 * so they keep their state on the worker's global object.
 */
const corsFallback = {
    requestWillFetch: async (
        /** @type {{ request: Request }} */ { request },
    ) => {
        /** @type {any} */ (self).corsFetchStart ??= new Map();
        /** @type {any} */ (self).corsFetchStart.set(request.url, Date.now());
        return request;
    },
    handlerDidError: async (
        /** @type {{ request: Request }} */ { request },
    ) => {
        /** @type {Map<string, number> | undefined} */
        const started = /** @type {any} */ (self).corsFetchStart;
        const elapsed = Date.now() - (started?.get(request.url) ?? 0);
        return navigator.onLine && elapsed < 3000 ? fetch(request) : undefined;
    },
    // Called for every handled request, after handlerDidError
    handlerDidComplete: async (
        /** @type {{ request: Request }} */ { request },
    ) => {
        /** @type {any} */ (self).corsFetchStart?.delete(request.url);
    },
};

/**
 * Service worker caching for map tiles and marker icons. Leaflet loads them as plain
 * <img> (no-cors), so cached copies would be opaque, and Chrome counts every opaque
 * response as megabytes of storage quota. These hosts send
 * Access-Control-Allow-Origin: *, so the worker fetches them with CORS and keeps only
 * real 200 responses (see corsFallback for a host that refuses CORS).
 * @param {number} maxEntries
 * @param {number} maxAgeSeconds
 */
const corsImageCaching = (maxEntries, maxAgeSeconds) => ({
    fetchOptions: {
        mode: /** @type {const} */ ("cors"),
        credentials: /** @type {const} */ ("omit"),
    },
    cacheableResponse: { statuses: [200] },
    expiration: { maxEntries, maxAgeSeconds, purgeOnQuotaError: true },
    plugins: [corsFallback],
});

// https://astro.build/config
export default defineConfig({
    integrations: [
        react(),
        tailwind({
            applyBaseStyles: false,
        }),
        arcgisAssets(),
        AstroPWA({
            // A new deploy waits until the app was closed, or until src/pwa.ts
            // applies it at a moment that loses nothing (it posts SKIP_WAITING)
            registerType: "prompt",
            // Registered by src/pwa.ts (imported in src/layouts/Layout.astro)
            injectRegister: false,
            workbox: {
                // The first install takes control of the open page, so the app
                // works offline without a reload
                clientsClaim: true,
                // App shell: JS, CSS, the page, self-hosted fonts and pe-wasm.wasm
                globPatterns: ["**/*.{js,css,html,woff2,wasm}"],
                // pe-wasm.wasm is 2.8 MB (default limit 2 MiB)
                maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
                // Hashed or versioned paths: precache them without a revision, so
                // a file the page already fetched is not downloaded a second time
                dontCacheBustURLsMatching: /^(?:_astro|arcgis-assets)\//,
                runtimeCaching: [
                    {
                        // CARTO basemaps (the default layers)
                        urlPattern:
                            /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\//,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "map-tiles-carto",
                            ...corsImageCaching(500, 7 * DAY),
                        },
                    },
                    {
                        // OpenStreetMap and Thunderforest layers
                        urlPattern:
                            /^https:\/\/tile\.(?:openstreetmap\.org|thunderforest\.com)\//,
                        handler: "StaleWhileRevalidate",
                        options: {
                            cacheName: "map-tiles",
                            ...corsImageCaching(500, 7 * DAY),
                        },
                    },
                    {
                        // Coloured marker icons
                        urlPattern:
                            /^https:\/\/(?:raw\.githubusercontent\.com\/pointhi\/leaflet-color-markers\/|cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/)/,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "marker-icons",
                            ...corsImageCaching(50, 30 * DAY),
                        },
                    },
                ],
            },
            manifest: {
                name: "Jet Lag Hide and Seek Map Generator",
                short_name: "Map Generator",
                description:
                    "Automatically generate maps for Jet Lag The Game: Hide and Seek with ease! Simply name the questions and watch the map eliminate hundreds of possibilities in seconds.",
                icons: [
                    {
                        src: "https://b0t-at.github.io/JetLagHideAndSeek/JLIcon.png",
                        sizes: "1080x1080",
                        type: "image/png",
                    },
                    {
                        src: "https://b0t-at.github.io/JetLagHideAndSeek/android-chrome-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                    },
                    {
                        src: "https://b0t-at.github.io/JetLagHideAndSeek/android-chrome-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                    },
                ],
                theme_color: "#1F2F3F",
            },
        }),
    ],
    devToolbar: {
        enabled: false,
    },
    site: "https://b0t-at.github.io/",
    base: "JetLagHideAndSeek",
});
