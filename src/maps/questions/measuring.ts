import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Position,
} from "geojson";
import _ from "lodash";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
    trainStations,
} from "@/lib/context";
import {
    fetchCoastline,
    findAdminBoundary,
    findPlacesInZone,
    findPlacesSpecificInZone,
    LOCATION_FIRST_TAG,
    nearestToQuestion,
    prettifyLocation,
    QuestionSpecificLocation,
} from "@/maps/api";
import {
    readGeometryCache,
    writeGeometryCache,
} from "@/maps/api/geometry-cache";
import {
    arcBufferToPoint,
    arcDistance,
    connectToSeparateLines,
    groupObjects,
    modifyMapData,
} from "@/maps/geo-utils";
import { hiderInRegion } from "@/maps/questions/hider";
import {
    type APILocations,
    DEFAULT_ADMIN_LEVEL,
    type HomeGameMeasuringQuestions,
    type MeasuringQuestion,
} from "@/maps/schema";

export interface AdminZoneInfo {
    name: string;
    boundary: any;
}

export const findAdminZoneInfo = _.memoize(
    async (
        lat: number,
        lng: number,
        adminLevel: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
    ): Promise<AdminZoneInfo | null> => {
        const boundary = await findAdminBoundary(lat, lng, adminLevel);

        if (!boundary) {
            return null;
        }

        const name =
            boundary.properties?.["name:en"] ??
            boundary.properties?.name ??
            "Unknown";

        return { name, boundary };
    },
    (lat, lng, adminLevel) =>
        `${lat.toFixed(6)},${lng.toFixed(6)},${adminLevel}`,
);

const highSpeedBase = _.memoize(
    (features: Feature[]) => {
        const grouped = groupObjects(features);

        const neighbored = grouped
            .map((group) => {
                return turf.multiLineString(
                    connectToSeparateLines(
                        group
                            .filter((x) => turf.getType(x) === "LineString")
                            .map((x) => x.geometry.coordinates),
                    ),
                );
            })
            .filter((x) => x.geometry.coordinates.length > 0);

        return turf.combine(
            turf.buffer(
                turf.simplify(turf.featureCollection(neighbored), {
                    tolerance: 0.001,
                }),
                0.001,
            )!,
        ).features[0];
    },
    (features) => `${JSON.stringify(features.map((x) => x.geometry))}`,
);

const bboxExtension = (
    bBox: [number, number, number, number],
    distance: number,
): [number, number, number, number] => {
    const buffered = turf.bbox(
        turf.buffer(turf.bboxPolygon(bBox), Math.abs(distance), {
            units: "miles",
        })!,
    );

    const originalDeltaLat = bBox[3] - bBox[1];
    const originalDeltaLng = bBox[2] - bBox[0];

    return [
        buffered[0] - originalDeltaLng,
        buffered[1] - originalDeltaLat,
        buffered[2] + originalDeltaLng,
        buffered[3] + originalDeltaLat,
    ];
};

interface CoastlineChunk {
    ring: Position[];
    /** Segments start..end-1, i.e. vertices start..end */
    start: number;
    end: number;
    /** No point on these segments is farther than this from the start vertex (degrees) */
    radius: number;
}

const COASTLINE_CHUNK_SEGMENTS = 32;

/** The coastline as land polygons, cut into chunks for the nearest-coast search; once per session */
const loadCoastline = _.memoize(async () => {
    try {
        const coastline = turf.lineToPolygon(
            await fetchCoastline(),
        ) as Feature<MultiPolygon>;

        const chunks: CoastlineChunk[] = [];
        let singleRings = true;
        for (const polygon of coastline.geometry.coordinates) {
            if (polygon.length !== 1) singleRings = false;
            const ring = polygon[0];
            for (
                let start = 0;
                start < ring.length - 1;
                start += COASTLINE_CHUNK_SEGMENTS
            ) {
                const end = Math.min(
                    start + COASTLINE_CHUNK_SEGMENTS,
                    ring.length - 1,
                );
                let radius = 0;
                for (let i = start; i < end; i++) {
                    radius = Math.max(
                        radius,
                        turf.distance(ring[start], ring[i], {
                            units: "degrees",
                        }) +
                            turf.distance(ring[i], ring[i + 1], {
                                units: "degrees",
                            }),
                    );
                }
                // Odd coordinates: never skip this chunk
                if (Number.isNaN(radius)) radius = Infinity;
                chunks.push({ ring, start, end, radius });
            }
        }

        return { coastline, chunks: singleRings ? chunks : null };
    } catch (error) {
        loadCoastline.cache.clear!();
        throw error;
    }
});

// Margin for rounding in the bound below, in degrees (about 10 cm)
const COASTLINE_BOUND_EPSILON = 1e-6;

/**
 * Same result as turf.pointToPolygonDistance(point, coastline, { units: "miles", method: "geodesic" }),
 * which measures all ~60k coastline segments. Here a chunk is skipped when its segments can't beat
 * the nearest one found so far: every point on them is at least distance(point, chunk start) - radius
 * away (triangle inequality on the sphere). The segments that are measured use turf's own code.
 */
const distanceToNearestCoast = (
    point: Feature<Point>,
    coastline: Feature<MultiPolygon>,
    chunks: CoastlineChunk[] | null,
) => {
    if (!chunks) {
        return turf.pointToPolygonDistance(point, coastline, {
            units: "miles",
            method: "geodesic",
        });
    }

    const p = point.geometry.coordinates;
    const bounds = chunks.map((chunk) => {
        const bound =
            turf.distance(p, chunk.ring[chunk.start], { units: "degrees" }) -
            chunk.radius;
        return Number.isNaN(bound) ? -Infinity : bound;
    });
    const order = chunks
        .map((_chunk, i) => i)
        .sort((a, b) => bounds[a] - bounds[b]);

    let nearest = Infinity;
    for (const i of order) {
        if (bounds[i] > nearest + COASTLINE_BOUND_EPSILON) break;
        const { ring, start, end } = chunks[i];
        for (let k = start; k < end; k++) {
            // turf's geodesic point-to-segment distance (point-to-line-distance)
            const distance = turf.nearestPointOnLine(
                turf.lineString([ring[k], ring[k + 1]]).geometry,
                p,
                { units: "degrees" },
            ).properties.dist;
            if (distance < nearest) nearest = distance;
        }
    }

    const miles = turf.convertLength(nearest, "degrees", "miles");
    return miles * (turf.booleanPointInPolygon(point, coastline) ? -1 : 1);
};

export const determineMeasuringBoundary = async (
    question: MeasuringQuestion,
) => {
    const bBox = turf.bbox(mapGeoJSON.get()!);

    switch (question.type) {
        case "highspeed-measure-shinkansen": {
            const features = osmtogeojson(
                await findPlacesInZone(
                    "[highspeed=yes]",
                    "Finding high-speed lines...",
                    "nwr",
                    "geom",
                ),
            ).features;

            return [highSpeedBase(features)];
        }
        case "admin-measure": {
            const adminLevel =
                (question as any).cat?.adminLevel ?? DEFAULT_ADMIN_LEVEL;
            const zoneInfo = await findAdminZoneInfo(
                question.lat,
                question.lng,
                adminLevel,
            );

            if (!zoneInfo) {
                toast.error("No admin boundary found at this location");
                return [turf.multiPolygon([])];
            }

            // Store the zone name for display
            if (!(question as any).cat) {
                (question as any).cat = { adminLevel };
            }
            (question as any).cat.zoneName = zoneInfo.name;

            // Convert the polygon to its outline (the border)
            const outline = turf.flatten(
                turf.polygonToLine(zoneInfo.boundary) as FeatureCollection<
                    LineString | MultiLineString
                >,
            ) as FeatureCollection<LineString>;

            // Buffering a whole country's border freezes the page for minutes; only the part near the play area matters
            const seeker = turf.point([question.lng, question.lat]);
            const distance = Math.min(
                ...outline.features.map((line) =>
                    turf.pointToLineDistance(seeker, line, { units: "miles" }),
                ),
            );
            const clipBox = bboxExtension(
                [
                    Math.min(bBox[0], question.lng),
                    Math.min(bBox[1], question.lat),
                    Math.max(bBox[2], question.lng),
                    Math.max(bBox[3], question.lat),
                ],
                distance + 1, // Margin for the differing geodesic distances
            );

            return outline.features
                .map((line) => turf.bboxClip(line, clipBox))
                .filter((line) => line.geometry.coordinates.length > 0);
        }
        case "coastline": {
            const { coastline, chunks } = await loadCoastline();

            const distanceToCoastline = distanceToNearestCoast(
                turf.point([question.lng, question.lat]),
                coastline,
                chunks,
            );

            return [
                turf.difference(
                    turf.featureCollection([
                        turf.bboxPolygon(bBox),
                        turf.buffer(
                            turf.bboxClip(
                                coastline,
                                bBox
                                    ? bboxExtension(
                                          bBox as any,
                                          distanceToCoastline,
                                      )
                                    : [-180, -90, 180, 90],
                            ),
                            distanceToCoastline,
                            {
                                units: "miles",
                                steps: 64,
                            },
                        )!,
                    ]),
                )!,
            ];
        }
        case "airport":
            return [
                turf.combine(
                    turf.featureCollection(
                        _.uniqBy(
                            (
                                await findPlacesInZone(
                                    '["aeroway"="aerodrome"]["iata"]', // Only commercial airports have IATA codes,
                                    "Finding airports...",
                                )
                            ).elements,
                            (feature: any) => feature.tags.iata,
                        ).map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        case "city":
            return [
                turf.combine(
                    turf.featureCollection(
                        (
                            await findPlacesInZone(
                                '[place=city]["population"~"^[1-9]+[0-9]{6}$"]', // The regex is faster than (if:number(t["population"])>1000000)
                                "Finding cities...",
                            )
                        ).elements.map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        case "aquarium-full":
        case "zoo-full":
        case "theme_park-full":
        case "peak-full":
        case "museum-full":
        case "hospital-full":
        case "cinema-full":
        case "library-full":
        case "golf_course-full":
        case "consulate-full":
        case "park-full": {
            const location = question.type.split("-full")[0] as APILocations;

            const data = await findPlacesInZone(
                `[${LOCATION_FIRST_TAG[location]}=${location}]`,
                `Finding ${prettifyLocation(location, true).toLowerCase()}...`,
                "nwr",
                "center",
                [],
                60,
            );

            if (data.remark && data.remark.startsWith("runtime error")) {
                toast.error(
                    `Error finding ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()}. Please enable hiding zone mode and switch to the Large Game variation of this question.`,
                );
                return [turf.multiPolygon([])];
            }

            if (data.elements.length >= 1000) {
                toast.error(
                    `Too many ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()} found (${data.elements.length}). Please enable hiding zone mode and switch to the Large Game variation of this question.`,
                );
                return [turf.multiPolygon([])];
            }

            return [
                turf.combine(
                    turf.featureCollection(
                        data.elements.map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        }
        case "custom-measure":
            return turf.combine(
                turf.featureCollection((question as any).geo.features),
            ).features;
        case "aquarium":
        case "zoo":
        case "theme_park":
        case "peak":
        case "museum":
        case "hospital":
        case "cinema":
        case "library":
        case "golf_course":
        case "consulate":
        case "park":
        case "mcdonalds":
        case "seven11":
        case "rail-measure":
            return false;
    }
};

const bufferedDeterminerKey = (question: MeasuringQuestion) =>
    JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        entirety: polyGeoJSON.get() ? polyGeoJSON.get() : mapGeoLocation.get(),
        geo: (question as any).geo,
        // zoneName is only a label, filled in by the first determination
        cat: _.omit((question as any).cat, "zoneName"),
    });

const bufferToQuestion = async (
    question: MeasuringQuestion,
    placeData: Awaited<ReturnType<typeof determineMeasuringBoundary>>,
) => {
    if (placeData === false || placeData === undefined) return false;

    return await arcBufferToPoint(
        turf.featureCollection(placeData as any),
        question.lat,
        question.lng,
    );
};

const determineBuffered = async (question: MeasuringQuestion) =>
    bufferToQuestion(question, await determineMeasuringBoundary(question));

// Expensive and computed from static data only (coastline file, bundled or cached boundaries)
const PERSISTED_MEASURING_TYPES = new Set(["coastline", "admin-measure"]);

/** Also covers the play area's extent, which determineMeasuringBoundary clips to */
const persistedDeterminerKey = (question: MeasuringQuestion) => {
    const $mapGeoJSON = mapGeoJSON.get();
    return $mapGeoJSON
        ? JSON.stringify([
              bufferedDeterminerKey(question),
              turf.bbox($mapGeoJSON),
          ])
        : null;
};

/** Like determineBuffered, but keeps the result across reloads */
const determineBufferedPersisted = async (question: MeasuringQuestion) => {
    const storedKey = persistedDeterminerKey(question);
    if (storedKey === null) return await determineBuffered(question);

    const stored =
        await readGeometryCache<Awaited<ReturnType<typeof determineBuffered>>>(
            storedKey,
        );
    if (stored) {
        // The admin zone's label, which a determination would have set
        if (typeof stored.extra?.zoneName === "string") {
            if (!(question as any).cat) {
                (question as any).cat = { adminLevel: DEFAULT_ADMIN_LEVEL };
            }
            (question as any).cat.zoneName = stored.extra.zoneName;
        }
        return stored.value;
    }

    // Read right before determineMeasuringBoundary reads the play area
    const key = persistedDeterminerKey(question);
    const placeData = await determineMeasuringBoundary(question);
    const result = await bufferToQuestion(question, placeData);

    // Not when nothing was found (e.g. no admin boundary), so that toast shows again
    const found =
        placeData !== false &&
        placeData !== undefined &&
        placeData.every((feature) => turf.coordAll(feature).length > 0);
    if (key !== null && result !== false && found) {
        void writeGeometryCache(
            key,
            result,
            question.type === "admin-measure"
                ? { zoneName: (question as any).cat?.zoneName }
                : undefined,
        );
    }

    return result;
};

const bufferedDeterminer = _.memoize(async (question: MeasuringQuestion) => {
    const key = bufferedDeterminerKey(question);

    try {
        return PERSISTED_MEASURING_TYPES.has(question.type)
            ? await determineBufferedPersisted(question)
            : await determineBuffered(question);
    } catch (error) {
        // Don't keep a failure (e.g. the play area changed mid-refresh) cached
        bufferedDeterminer.cache.delete(key);
        throw error;
    }
}, bufferedDeterminerKey);

export const adjustPerMeasuring = async (
    question: MeasuringQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const buffer = await bufferedDeterminer(question);

    if (buffer === false) return mapData;

    return modifyMapData(mapData, buffer, question.hiderCloser);
};

export const hiderifyMeasuring = async (question: MeasuringQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    if (
        [
            "aquarium",
            "zoo",
            "theme_park",
            "peak",
            "museum",
            "hospital",
            "cinema",
            "library",
            "golf_course",
            "consulate",
            "park",
        ].includes(question.type)
    ) {
        const questionNearest = await nearestToQuestion(
            question as HomeGameMeasuringQuestions,
        );
        const hiderNearest = await nearestToQuestion({
            lat: $hiderMode.latitude,
            lng: $hiderMode.longitude,
            hiderCloser: true,
            type: (question as HomeGameMeasuringQuestions).type,
            drag: false,
            color: "black",
            collapsed: false,
        });

        question.hiderCloser =
            questionNearest.properties.distanceToPoint >
            hiderNearest.properties.distanceToPoint;

        return question;
    }

    if (question.type === "rail-measure") {
        const stations = trainStations.get();

        if (stations.length === 0) {
            return question;
        }

        const location = turf.point([question.lng, question.lat]);

        const nearestTrainStation = turf.nearestPoint(
            location,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const distance = await arcDistance(location, nearestTrainStation);

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

        const hiderNearest = turf.nearestPoint(
            hider,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const hiderDistance = await arcDistance(hider, hiderNearest);

        question.hiderCloser = hiderDistance < distance;
    }

    if (question.type === "mcdonalds" || question.type === "seven11") {
        const points = await findPlacesSpecificInZone(
            question.type === "mcdonalds"
                ? QuestionSpecificLocation.McDonalds
                : QuestionSpecificLocation.Seven11,
        );

        if (points.features.length === 0) return question;

        const seeker = turf.point([question.lng, question.lat]);
        const nearest = turf.nearestPoint(seeker, points as any);

        const distance = await arcDistance(seeker, nearest, "miles");

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const hiderNearest = turf.nearestPoint(hider, points as any);

        const hiderDistance = await arcDistance(hider, hiderNearest, "miles");

        question.hiderCloser = hiderDistance < distance;
        return question;
    }

    if (mapGeoJSON.get() === null) return question;

    // A point test against the (memoized) buffer answers this, no need to
    // clip the play area
    let buffer;
    try {
        buffer = await bufferedDeterminer(question);
    } catch {
        return question;
    }
    if (!buffer) return question;

    const hiderCloser = hiderInRegion($hiderMode, buffer);
    if (hiderCloser !== undefined) question.hiderCloser = hiderCloser;

    return question;
};

export const measuringPlanningPolygon = async (question: MeasuringQuestion) => {
    try {
        const buffered = await bufferedDeterminer(question);

        if (buffered === false) return false;

        return turf.polygonToLine(buffered);
    } catch {
        return false;
    }
};
