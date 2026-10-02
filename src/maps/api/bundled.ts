import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import _ from "lodash";
import osmtogeojson from "osmtogeojson";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";

import { cacheFetch } from "./cache";
import { CacheType } from "./types";
import vienna from "./vienna-data.json";

// OSM data for games in Vienna shipped with the app (scripts/build-vienna-data.mjs).
// Each lookup returns null when the snapshot doesn't cover the request, so callers ask Overpass.

const files: Record<string, string> = vienna.files;

const loadFile = _.memoize(async (key: string): Promise<any> => {
    try {
        const response = await cacheFetch(
            `${import.meta.env.BASE_URL}/data/vienna/${files[key]}`,
            undefined,
            CacheType.PERMANENT_CACHE,
        );
        if (response.ok) return await response.json();
    } catch {
        // Fall back to Overpass
    }
    loadFile.cache.delete(key);
    return null;
});

const load = (key: string) => (key in files ? loadFile(key) : null);

const isViennaPlayArea = () =>
    !polyGeoJSON.get() &&
    additionalMapGeoLocations.get().length === 0 &&
    mapGeoLocation.get().properties.osm_type === "R" &&
    mapGeoLocation.get().properties.osm_id === vienna.relation;

/** Overpass answer for `relation(id);out geom;` */
export const bundledRelation = async (osmId: string, osmType: string) =>
    osmType === "R" && Number(osmId) === vienna.relation
        ? await load("boundary")
        : null;

const typeOrder = { node: 0, way: 1, relation: 2 } as const;
const searchTypeLetters: Record<string, string> = {
    node: "n",
    way: "w",
    relation: "r",
    nwr: "nwr",
    nw: "nw",
    wr: "wr",
    nr: "nr",
};

/** Overpass answer for findPlacesInZone's union of filters over the play area */
export const bundledZonePlaces = async (
    searchType: string,
    filters: string[],
    outType: string,
) => {
    if (outType !== "center" || !isViennaPlayArea()) return null;
    const letters = searchTypeLetters[searchType];
    if (!letters) return null;

    const datasets = await Promise.all(filters.map((f) => load(`zone:${f}`)));
    if (datasets.some((data) => !data)) return null;

    const elements = _.uniqBy(
        datasets.flatMap((data) => data.elements),
        (e: any) => `${e.type}/${e.id}`,
    )
        .filter((e: any) => letters.includes(e.type[0]))
        .sort(
            (a: any, b: any) =>
                typeOrder[a.type as keyof typeof typeOrder] -
                    typeOrder[b.type as keyof typeof typeOrder] || a.id - b.id,
        );

    return { elements };
};

const polygons = (data: any) =>
    osmtogeojson(data).features.filter(
        (f: any) =>
            f.geometry?.type === "Polygon" ||
            f.geometry?.type === "MultiPolygon",
    ) as Feature<Polygon | MultiPolygon>[];

const loadPolygons = _.memoize(async (key: string) => {
    const data = await load(key);
    if (!data) {
        loadPolygons.cache.delete(key);
        return null;
    }
    return polygons(data);
});

/** The admin boundary of the given level around a point in Vienna, like findAdminBoundary */
export const bundledAdminBoundary = async (
    latitude: number,
    longitude: number,
    adminLevel: number,
) => {
    if (!(`admin:${adminLevel}` in files)) return null;

    const point = turf.point([longitude, latitude]);
    const city = await loadPolygons("boundary");
    if (!city?.some((f) => turf.booleanPointInPolygon(point, f))) return null;

    const zones = await loadPolygons(`admin:${adminLevel}`);
    return zones?.find((f) => turf.booleanPointInPolygon(point, f)) ?? null;
};

/** Overpass answer for `nwr["tag"="type"](around:radius,lat,lng);out center;` */
export const bundledAround = async (
    locationType: string,
    latitude: number,
    longitude: number,
    radiusMeters: number,
) => {
    const center = turf.point([longitude, latitude]);
    if (
        turf.distance(center, turf.point(vienna.center), { units: "meters" }) +
            radiusMeters >
        vienna.poiRadius
    )
        return null;

    const data = await load(`poi:${locationType}`);
    if (!data) return null;

    return {
        elements: data.elements.filter((e: any) => {
            const lon = e.center?.lon ?? e.lon;
            const lat = e.center?.lat ?? e.lat;
            return (
                lon !== undefined &&
                turf.distance(center, turf.point([lon, lat]), {
                    units: "meters",
                }) <= radiusMeters
            );
        }),
    };
};
