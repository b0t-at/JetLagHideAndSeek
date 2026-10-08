import * as turf from "@turf/turf";
import type { Geometry } from "geojson";

/**
 * Whether the hider stands in a question's region (a polygon feature or
 * geometry, or a collection of them). undefined when there is no polygon to
 * test against.
 */
export const hiderInRegion = (
    hider: { latitude: number; longitude: number },
    region: any,
): boolean | undefined => {
    const point = turf.point([hider.longitude, hider.latitude]);
    const polygons = (
        region.type === "FeatureCollection" ? region.features : [region]
    )
        .map((x: any): Geometry | undefined =>
            x?.type === "Feature" ? x.geometry : x,
        )
        .filter(
            (x: Geometry | undefined) =>
                x?.type === "Polygon" || x?.type === "MultiPolygon",
        );

    if (polygons.length === 0) return undefined;

    return polygons.some((x: any) => turf.booleanPointInPolygon(point, x));
};
