// Snapshot of the OSM data a game in Vienna needs, so the app doesn't depend on Overpass for it.
// Usage: node scripts/build-vienna-data.mjs  (writes public/data/vienna/ and src/maps/api/vienna-data.json)
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELATION = 109166;
const CENTER = [16.3725042, 48.2083537]; // lng, lat
// Covers a 30 mi search (nearest place to a question) from anywhere in Vienna
const POI_RADIUS_M = 65000;
const ADMIN_LEVELS = [4, 9, 10];

// Must match the filters the app passes to findPlacesInZone
const ZONE_FILTERS = [
    "[railway=station]",
    "[railway=halt]",
    "[railway=stop]",
    "[railway=tram_stop]",
    "[highway=bus_stop]",
    "[amenity=ferry_terminal]",
    "[public_transport=platform][platform=ferry]",
    "[railway=funicular]",
    "[aerialway=station]",
    "[railway=station][subway!=yes]",
    "[railway=station][subway=yes]",
    "[railway=station][light_rail=yes]",
    "[railway=halt][light_rail=yes]",
    '["brand:wikidata"="Q38076"]',
    '["brand:wikidata"="Q259340"]',
    '["aeroway"="aerodrome"]["iata"]',
    '[place=city]["population"~"^[1-9]+[0-9]{6}$"]',
];
// Must match LOCATION_FIRST_TAG in src/maps/api/constants.ts
const LOCATIONS = {
    aquarium: "tourism",
    hospital: "amenity",
    peak: "natural",
    museum: "tourism",
    theme_park: "tourism",
    zoo: "tourism",
    cinema: "amenity",
    library: "amenity",
    golf_course: "leisure",
    consulate: "diplomatic",
    park: "leisure",
};
for (const [type, tag] of Object.entries(LOCATIONS))
    ZONE_FILTERS.push(`[${tag}=${type}]`);

const HOSTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const KEEP_TAGS = ["name", "name:en", "iata"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "data", "vienna");
const manifestPath = path.join(root, "src", "maps", "api", "vienna-data.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw answers are kept between runs, so a rerun only asks Overpass for what changed or failed
const cacheDir = path.join(os.tmpdir(), "jlhs-vienna-overpass");
fs.mkdirSync(cacheDir, { recursive: true });

// A server without the city's area answers area queries with nothing, so they report the area count first
const AREA_CHECK = `relation(${RELATION});map_to_area->.city;\n.city out count;`;
const withoutAreaCheck = (data) => {
    const [count, ...elements] = data.elements;
    return count?.type === "count" && Number(count.tags.areas) > 0
        ? { ...data, elements }
        : null;
};

const overpass = async (query, validate = (data) => data) => {
    const cacheFile = path.join(
        cacheDir,
        `${createHash("sha1").update(query).digest("hex")}.json`,
    );
    if (fs.existsSync(cacheFile)) {
        const cached = validate(JSON.parse(fs.readFileSync(cacheFile, "utf8")));
        if (cached) return cached;
    }
    for (let attempt = 0; attempt < 12; attempt++) {
        const host = HOSTS[attempt % HOSTS.length];
        try {
            const response = await fetch(host, {
                method: "POST",
                body: new URLSearchParams({ data: query }),
                headers: { "User-Agent": "JetLagHideAndSeek-vienna-snapshot" },
                signal: AbortSignal.timeout(200000),
            });
            if (response.ok) {
                const data = await response.json();
                const valid = !data.remark && validate(data);
                if (valid) {
                    fs.writeFileSync(cacheFile, JSON.stringify(data));
                    return valid;
                }
                console.warn(`  ${host}: ${data.remark ?? "area missing"}`);
            } else console.warn(`  ${host}: ${response.status}`);
        } catch (error) {
            console.warn(`  ${host}: ${error.message}`);
        }
        await sleep(5000 * (attempt + 1));
    }
    throw new Error(`Overpass failed for ${query}`);
};

const trimTags = (data) => ({
    elements: data.elements.map(({ tags, ...element }) => ({
        ...element,
        tags: Object.fromEntries(
            KEEP_TAGS.filter((k) => tags?.[k] !== undefined).map((k) => [
                k,
                tags[k],
            ]),
        ),
    })),
});

const files = {};
const counts = {};
const write = (key, data) => {
    const json = JSON.stringify(data);
    const hash = createHash("sha1").update(json).digest("hex").slice(0, 10);
    const name = `${createHash("sha1").update(key).digest("hex").slice(0, 8)}.${hash}.json`;
    fs.writeFileSync(path.join(outDir, name), json);
    files[key] = name;
    counts[key] = data.elements.length;
    console.log(
        `${key}: ${data.elements.length} elements, ${Math.round(json.length / 1024)} KB`,
    );
};

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

write("boundary", await overpass(`[out:json];relation(${RELATION});out geom;`));
const admin = await overpass(
    `[out:json][timeout:180];
${AREA_CHECK}
(relation(${RELATION});rel(area.city)["boundary"="administrative"]["admin_level"~"^(${ADMIN_LEVELS.join("|")})$"];);
out geom;`,
    withoutAreaCheck,
);
// Relations with "out geom" are self-contained, so each level can be loaded on its own
for (const level of ADMIN_LEVELS)
    write(`admin:${level}`, {
        ...admin,
        elements: admin.elements.filter(
            (e) => e.tags?.admin_level === String(level),
        ),
    });
for (const filter of ZONE_FILTERS)
    write(
        `zone:${filter}`,
        trimTags(
            await overpass(
                `[out:json][timeout:180];
${AREA_CHECK}
nwr${filter}(area.city);
out center;`,
                withoutAreaCheck,
            ),
        ),
    );
const split =
    counts["zone:[railway=station][subway=yes]"] +
    counts["zone:[railway=station][subway!=yes]"];
if (split !== counts["zone:[railway=station]"])
    throw new Error(
        `Inconsistent station counts: ${split} vs ${counts["zone:[railway=station]"]}`,
    );
for (const [type, tag] of Object.entries(LOCATIONS))
    write(
        `poi:${type}`,
        trimTags(
            await overpass(`[out:json][timeout:180];
nwr["${tag}"="${type}"](around:${POI_RADIUS_M},${CENTER[1]},${CENTER[0]});
out center;`),
        ),
    );

fs.writeFileSync(
    manifestPath,
    JSON.stringify(
        {
            generated: new Date().toISOString().slice(0, 10),
            relation: RELATION,
            center: CENTER,
            poiRadius: POI_RADIUS_M,
            adminLevels: ADMIN_LEVELS,
            files,
        },
        null,
        4,
    ) + "\n",
);
console.log(`Wrote ${Object.keys(files).length} files and ${manifestPath}`);
