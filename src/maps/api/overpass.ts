import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon } from "geojson";
import _ from "lodash";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    mapGeoJSON,
    mapGeoLocation,
    overpassCustomHost,
    overpassHost,
    polyGeoJSON,
} from "@/lib/context";
import { safeUnion } from "@/maps/geo-utils";

import { cacheFetch, determineCache } from "./cache";
import { LOCATION_FIRST_TAG, OVERPASS_HOSTS } from "./constants";
import type {
    EncompassingTentacleQuestionSchema,
    HomeGameMatchingQuestions,
    HomeGameMeasuringQuestions,
    QuestionSpecificLocation,
} from "./types";
import { CacheType } from "./types";

type TentacleLocationQuery = Pick<
    EncompassingTentacleQuestionSchema,
    "lat" | "lng" | "radius" | "unit" | "locationType"
>;

// Public Overpass servers often hang or time out; ask the next one as well if one is this slow
const ASK_NEXT_HOST_AFTER_MS = 20000;

/** The first successful response from the hosts, tried in order; or the last error */
const fetchFromHosts = (urls: string[], cacheType: CacheType) =>
    new Promise<{ response: Response; url: string } | string>((resolve) => {
        let next = 0;
        let running = 0;
        let settled = false;
        let lastError = "no response";

        const tryNext = () => {
            if (settled) return;
            if (next >= urls.length) {
                if (running === 0) {
                    settled = true;
                    resolve(lastError);
                }
                return;
            }

            const url = urls[next++];
            running++;
            const askNext = setTimeout(tryNext, ASK_NEXT_HOST_AFTER_MS);
            cacheFetch(url, undefined, cacheType)
                .then((response) => {
                    if (response.ok) {
                        if (!settled) {
                            settled = true;
                            resolve({ response, url });
                        }
                    } else {
                        lastError = `${response.status} ${response.statusText}`;
                    }
                })
                .catch((error) => {
                    lastError = String(error);
                })
                .finally(() => {
                    running--;
                    clearTimeout(askNext);
                    tryNext();
                });
        };

        tryNext();
    });

export const getOverpassData = async (
    query: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
) => {
    const encodedQuery = encodeURIComponent(query);
    const allHostUrls = Object.values(OVERPASS_HOSTS);
    const selectedHost = overpassHost.get();
    const customUrl = overpassCustomHost.get();

    const primaryBaseUrl =
        selectedHost === "custom"
            ? customUrl || allHostUrls[0]
            : selectedHost || allHostUrls[0];
    const fallbackBaseUrls = allHostUrls.filter((h) => h !== primaryBaseUrl);

    const urls = [primaryBaseUrl, ...fallbackBaseUrls].map(
        (base) => `${base}?data=${encodedQuery}`,
    );
    const cache = await determineCache(cacheType).catch(() => null);
    const cached = await cache?.match(urls[0]);
    if (cached?.ok) return await cached.json();

    const pending = fetchFromHosts(urls, cacheType);
    const result = await (loadingText
        ? toast.promise(pending, { pending: loadingText })
        : pending);

    if (typeof result === "string") {
        toast.error(`Could not load data from Overpass: ${result}`, {
            toastId: "overpass-error",
        });
        return { elements: [] };
    }

    if (cache && result.url !== urls[0]) {
        await cache.put(urls[0], result.response.clone()).catch(() => {});
    }

    return await result.response.json();
};

export const determineGeoJSON = async (
    osmId: string,
    osmTypeLetter: "W" | "R" | "N",
): Promise<any> => {
    const osmTypeMap: { [key: string]: string } = {
        W: "way",
        R: "relation",
        N: "node",
    };
    const osmType = osmTypeMap[osmTypeLetter];
    const query = `[out:json];${osmType}(${osmId});out geom;`;
    const data = await getOverpassData(
        query,
        "Loading map data...",
        CacheType.PERMANENT_CACHE,
    );
    const geo = osmtogeojson(data);
    return {
        ...geo,
        features: geo.features.filter(
            (feature: any) => feature.geometry.type !== "Point",
        ),
    };
};

export const findTentacleLocations = async (
    question: TentacleLocationQuery,
    text: string = "Determining tentacle locations...",
) => {
    const query = `
[out:json][timeout:25];
nwr["${LOCATION_FIRST_TAG[question.locationType]}"="${question.locationType}"](around:${turf.convertLength(
        question.radius,
        question.unit,
        "meters",
    )}, ${question.lat}, ${question.lng});
out center;
    `;
    const data = await getOverpassData(query, text);
    const elements = data.elements;
    const response = turf.points([]);
    elements.forEach((element: any) => {
        if (!element.tags["name"] && !element.tags["name:en"]) return;
        if (element.lat && element.lon) {
            const name = element.tags["name:en"] ?? element.tags["name"];
            if (
                response.features.find(
                    (feature: any) => feature.properties.name === name,
                )
            )
                return;
            response.features.push(
                turf.point([element.lon, element.lat], { name }),
            );
        }
        if (!element.center || !element.center.lon || !element.center.lat)
            return;
        const name = element.tags["name:en"] ?? element.tags["name"];
        if (
            response.features.find(
                (feature: any) => feature.properties.name === name,
            )
        )
            return;
        response.features.push(
            turf.point([element.center.lon, element.center.lat], { name }),
        );
    });
    return response;
};

export const findAdminBoundary = async (
    latitude: number,
    longitude: number,
    adminLevel: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
) => {
    const query = `
[out:json];
is_in(${latitude}, ${longitude})->.a;
rel(pivot.a)["admin_level"="${adminLevel}"];
out geom;
    `;
    const data = await getOverpassData(query, "Determining matching zone...");
    const geo = osmtogeojson(data);
    return geo.features?.[0];
};

export const fetchCoastline = async () => {
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/coastline50.geojson",
        "Fetching coastline data...",
        CacheType.PERMANENT_CACHE,
    );
    const data = await response.json();
    return data;
};

const TRAIN_ROUTE_FILTER =
    '["type"="route"]["route"~"^(train|subway|light_rail|monorail)$"]';

/** Adds the other stop_areas of their stop_area_group, so an interchange counts as one station */
const withGroupedStopAreas = (set: string) =>
    `rel(br.${set})["public_transport"="stop_area_group"];rel(r)["public_transport"="stop_area"]->.grouped;(.${set};.grouped;)->.${set};`;

/**
 * Ids of the nodes (stations, stops) on any train line serving the given station.
 * Lines are found through the station's stop_area and the route relations of its stops.
 */
export const trainLineNodeFinder = async (node: string): Promise<number[]> => {
    const [type, id] = node.split("/");
    // Custom station lists may carry arbitrary ids
    if (!/^(node|way|relation)$/.test(type) || !/^\d+$/.test(id)) return [];

    const $mapGeoJSON = mapGeoJSON.get();
    // Stops outside the play area can't be anyone's nearest station
    const bbox = $mapGeoJSON
        ? (([w, s, e, n]) => `(${s},${w},${n},${e})`)(turf.bbox($mapGeoJSON))
        : "";
    const query = `
[out:json];
${type}(${id})->.station;
rel(b${type[0]}.station)["public_transport"="stop_area"]->.areas;
${withGroupedStopAreas("areas")}
(node(r.areas);way(r.areas);rel(r.areas);.station;)->.members;
(
rel(bn.members)${TRAIN_ROUTE_FILTER};
rel(bw.members)${TRAIN_ROUTE_FILTER};
rel(br.members)${TRAIN_ROUTE_FILTER};
)->.routes;
(
node(r.routes)${bbox};
way(r.routes:"platform")${bbox};
way(r.routes:"platform_entry_only")${bbox};
way(r.routes:"platform_exit_only")${bbox};
rel(r.routes)${bbox};
)->.stops;
(
rel(bn.stops)["public_transport"="stop_area"];
rel(bw.stops)["public_transport"="stop_area"];
rel(br.stops)["public_transport"="stop_area"];
)->.served;
${withGroupedStopAreas("served")}
(node.stops;node(r.served););
out ids;
`;
    const data = await getOverpassData(query, "Finding train lines...");
    return _.uniq(data.elements.map((element: any) => element.id));
};

export const findPlacesInZone = async (
    filter: string,
    loadingText?: string,
    searchType:
        | "node"
        | "way"
        | "relation"
        | "nwr"
        | "nw"
        | "wr"
        | "nr"
        | "area" = "nwr",
    outType: "center" | "geom" = "center",
    alternatives: string[] = [],
    timeoutDuration: number = 0,
) => {
    let query = "";
    const $polyGeoJSON = polyGeoJSON.get();
    if ($polyGeoJSON) {
        query = `
[out:json]${timeoutDuration != 0 ? `[timeout:${timeoutDuration}]` : ""};
(
${searchType}${filter}(poly:"${turf
            .getCoords($polyGeoJSON.features)
            .flatMap((polygon) => polygon.geometry.coordinates)
            .flat()
            .map((coord) => [coord[1], coord[0]].join(" "))
            .join(" ")}");
${
    alternatives.length > 0
        ? alternatives
              .map(
                  (alternative) =>
                      `${searchType}${alternative}(poly:"${turf
                          .getCoords($polyGeoJSON.features)
                          .flatMap((polygon) => polygon.geometry.coordinates)
                          .flat()
                          .map((coord) => [coord[1], coord[0]].join(" "))
                          .join(" ")}");`,
              )
              .join("\n")
        : ""
}
);
out ${outType};
`;
    } else {
        const primaryLocation = mapGeoLocation.get();
        const additionalLocations = additionalMapGeoLocations
            .get()
            .filter((entry) => entry.added)
            .map((entry) => entry.location);
        const allLocations = [primaryLocation, ...additionalLocations];
        const relationToAreaBlocks = allLocations
            .map((loc, idx) => {
                const regionVar = `.region${idx}`;
                return `relation(${loc.properties.osm_id});map_to_area->${regionVar};`;
            })
            .join("\n");
        const searchBlocks = allLocations
            .map((_, idx) => {
                const regionVar = `area.region${idx}`;
                const altQueries =
                    alternatives.length > 0
                        ? alternatives
                              .map(
                                  (alt) => `${searchType}${alt}(${regionVar});`,
                              )
                              .join("\n")
                        : "";
                return `
            ${searchType}${filter}(${regionVar});
            ${altQueries}
          `;
            })
            .join("\n");
        query = `
        [out:json]${timeoutDuration !== 0 ? `[timeout:${timeoutDuration}]` : ""};
        ${relationToAreaBlocks}
        (
        ${searchBlocks}
        );
        out ${outType};
        `;
    }
    const data = await getOverpassData(
        query,
        loadingText,
        CacheType.ZONE_CACHE,
    );
    const subtractedEntries = additionalMapGeoLocations
        .get()
        .filter((e) => !e.added);
    const subtractedPolygons = subtractedEntries.map((entry) => entry.location);
    if (subtractedPolygons.length > 0 && data && data.elements) {
        const turfPolys = await Promise.all(
            subtractedPolygons.map(
                async (location) =>
                    turf.combine(
                        await determineGeoJSON(
                            location.properties.osm_id.toString(),
                            location.properties.osm_type,
                        ),
                    ).features[0],
            ),
        );
        data.elements = data.elements.filter((el: any) => {
            const lon = el.center ? el.center.lon : el.lon;
            const lat = el.center ? el.center.lat : el.lat;
            if (typeof lon !== "number" || typeof lat !== "number")
                return false;
            const pt = turf.point([lon, lat]);
            return !turfPolys.some((poly) =>
                turf.booleanPointInPolygon(pt, poly as any),
            );
        });
    }
    return data;
};

export const findPlacesSpecificInZone = async (
    location: `${QuestionSpecificLocation}`,
) => {
    const locations = (
        await findPlacesInZone(
            location,
            `Finding ${
                location === '["brand:wikidata"="Q38076"]'
                    ? "McDonald's"
                    : "7-Elevens"
            }...`,
        )
    ).elements;
    return turf.featureCollection(
        locations.map((x: any) =>
            turf.point([
                x.center ? x.center.lon : x.lon,
                x.center ? x.center.lat : x.lat,
            ]),
        ),
    );
};

/** Places around the question, widening the search until one is found (cached per question) */
export const findQuestionLocations = async (
    question: HomeGameMatchingQuestions | HomeGameMeasuringQuestions,
) => {
    let radius = 30;
    let instances: any = { features: [] };
    while (instances.features.length === 0) {
        instances = await findTentacleLocations(
            {
                lat: question.lat,
                lng: question.lng,
                radius: radius,
                unit: "miles",
                locationType: question.type,
            },
            "Finding matching locations...",
        );
        radius += 30;
    }
    return { instances, radiusMiles: radius - 30 };
};

export const nearestToQuestion = async (
    question: HomeGameMatchingQuestions | HomeGameMeasuringQuestions,
) => {
    const { instances } = await findQuestionLocations(question);
    const questionPoint = turf.point([question.lng, question.lat]);
    return turf.nearestPoint(questionPoint, instances as any);
};

export const determineMapBoundaries = async () => {
    const mapGeoDatum = await Promise.all(
        [
            {
                location: mapGeoLocation.get(),
                added: true,
                base: true,
            },
            ...additionalMapGeoLocations.get(),
        ].map(async (location) => ({
            added: location.added,
            data: await determineGeoJSON(
                location.location.properties.osm_id.toString(),
                location.location.properties.osm_type,
            ),
        })),
    );

    let mapGeoData = turf.featureCollection([
        safeUnion(
            turf.featureCollection(
                mapGeoDatum
                    .filter((x) => x.added)
                    .flatMap((x) => x.data.features),
            ) as any,
        ),
    ]);

    const differences = mapGeoDatum.filter((x) => !x.added).map((x) => x.data);

    if (differences.length > 0) {
        mapGeoData = turf.featureCollection([
            turf.difference(
                turf.featureCollection([
                    mapGeoData.features[0],
                    ...differences.flatMap((x) => x.features),
                ]),
            )!,
        ]);
    }

    if (turf.coordAll(mapGeoData).length > 10000) {
        turf.simplify(mapGeoData, {
            tolerance: 0.0005,
            highQuality: true,
            mutate: true,
        });
    }

    return turf.combine(mapGeoData) as FeatureCollection<MultiPolygon>;
};
