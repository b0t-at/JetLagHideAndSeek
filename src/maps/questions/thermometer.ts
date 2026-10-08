import * as turf from "@turf/turf";

import { hiderMode } from "@/lib/context";
import { safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils/voronoi";
import type { ThermometerQuestion } from "@/maps/schema";

// When A and B share a latitude (to within ~0.1 m, e.g. typed coordinates), the
// Voronoi cells come out as the same half for both points, so either answer would
// keep the same area. Moving B by ~1 m north or south avoids that degenerate case.
const MIN_LATITUDE_GAP = 1e-5;

/** The cells of A (features[0]) and B (features[1]) */
const thermometerVoronoi = (question: ThermometerQuestion) => {
    const gap = question.latB - question.latA;
    const latB =
        Math.abs(gap) < MIN_LATITUDE_GAP
            ? question.latA + (gap < 0 ? -MIN_LATITUDE_GAP : MIN_LATITUDE_GAP)
            : question.latB;

    return geoSpatialVoronoi(
        turf.featureCollection([
            turf.point([question.lngA, question.latA]),
            turf.point([question.lngB, latB]),
        ]),
    );
};

export const adjustPerThermometer = (
    question: ThermometerQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const voronoi = thermometerVoronoi(question);

    if (question.warmer) {
        return turf.intersect(
            turf.featureCollection([safeUnion(mapData), voronoi.features[1]]),
        );
    } else {
        return turf.intersect(
            turf.featureCollection([safeUnion(mapData), voronoi.features[0]]),
        );
    }
};

export const hiderifyThermometer = (question: ThermometerQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    const voronoi = thermometerVoronoi(question);

    const hiderPoint = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
    const hiderRegion = turf.booleanPointInPolygon(
        hiderPoint,
        voronoi.features[1],
    )
        ? 1
        : 0;

    if (hiderRegion === 1) {
        question.warmer = true;
    } else {
        question.warmer = false;
    }

    return question;
};

export const thermometerPlanningPolygon = (question: ThermometerQuestion) => {
    const voronoi = thermometerVoronoi(question);

    return turf.featureCollection(
        voronoi.features
            .map((x: any) => turf.polygonToLine(x))
            .flatMap((line) =>
                line.type === "FeatureCollection" ? line.features : [line],
            ),
    );
};
