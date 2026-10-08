import esriConfig from "@arcgis/core/config.js";
import { version } from "@arcgis/core/package.json";

// The geodesic operators load the projection engine (pe-wasm.wasm) at runtime from
// `${assetsPath}/esri/geometry/support/`. By default that is js.arcgis.com; the
// arcgisAssets integration in astro.config.mjs ships the file with the app instead
// (copied from the installed @arcgis/core, so it always matches the JS), which lets
// the service worker precache it. The version in the path keeps a library upgrade
// from ever pairing new JS with an old cached wasm.
// ArcGIS reads assetsPath when it loads the engine, so this only has to run before
// the first geodesic operation.
esriConfig.assetsPath = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/arcgis-assets/${version}`;
