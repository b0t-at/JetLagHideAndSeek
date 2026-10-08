import type { Feature, FeatureCollection } from "geojson";

import { overpassSoftFailures } from "./api/overpass";
import {
    adjustPerMatching,
    hiderifyMatching,
    matchingPlanningPolygon,
} from "./questions/matching";
import {
    adjustPerMeasuring,
    hiderifyMeasuring,
    measuringPlanningPolygon,
} from "./questions/measuring";
import {
    adjustPerRadius,
    hiderifyRadius,
    radiusPlanningPolygon,
} from "./questions/radius";
import {
    adjustPerTentacle,
    hiderifyTentacles,
    tentaclesPlanningPolygon,
} from "./questions/tentacles";
import {
    adjustPerThermometer,
    hiderifyThermometer,
    thermometerPlanningPolygon,
} from "./questions/thermometer";
import type { Question, Questions } from "./schema";

export * from "./geo-utils";

export const hiderifyQuestion = async (question: Question) => {
    if (question.data.drag) {
        switch (question.id) {
            case "radius":
                question.data = await hiderifyRadius(question.data);
                break;
            case "thermometer":
                question.data = await hiderifyThermometer(question.data);
                break;
            case "tentacles":
                question.data = await hiderifyTentacles(question.data);
                break;
            case "matching":
                question.data = await hiderifyMatching(question.data);
                break;
            case "measuring":
                question.data = await hiderifyMeasuring(question.data);
                break;
        }
    }

    return question;
};

export const determinePlanningPolygon = async (
    question: Question,
    planningModeEnabled: boolean,
) => {
    if (planningModeEnabled && question.data.drag && !question.data.hidden) {
        switch (question.id) {
            case "radius":
                return radiusPlanningPolygon(question.data);
            case "thermometer":
                return thermometerPlanningPolygon(question.data);
            case "tentacles":
                return tentaclesPlanningPolygon(question.data);
            case "matching":
                return matchingPlanningPolygon(question.data);
            case "measuring":
                return measuringPlanningPolygon(question.data);
        }
    }
};

export async function adjustMapGeoDataForQuestion(
    question: any,
    mapGeoData: any,
    onError?: () => void,
) {
    if (question.data.hidden) {
        return mapGeoData;
    }

    try {
        switch (question?.id) {
            case "radius":
                return await adjustPerRadius(question.data, mapGeoData);
            case "thermometer":
                return await adjustPerThermometer(question.data, mapGeoData);
            case "tentacles":
                if (question.data.location === false) {
                    return adjustPerRadius(
                        { ...question.data, within: false },
                        mapGeoData,
                    );
                }
                return await adjustPerTentacle(question.data, mapGeoData);
            case "matching":
                return await adjustPerMatching(question.data, mapGeoData);
            case "measuring":
                return await adjustPerMeasuring(question.data, mapGeoData);
            default:
                return mapGeoData;
        }
    } catch {
        onError?.();
        return mapGeoData;
    }
}

/** Question fields that only change how a card or marker looks */
export const UI_ONLY_QUESTION_FIELDS = [
    "collapsed",
    "color",
    "colorA",
    "colorB",
] as const;

const omitFields = (data: object, fields: readonly string[]) =>
    Object.fromEntries(
        Object.entries(data).filter(([field]) => !fields.includes(field)),
    );

/**
 * Shallow copy of a question's data without the given fields, nor the zone
 * name label that computing a measuring question fills in
 */
export const omitQuestionFields = (
    data: object,
    fields: readonly string[],
): Record<string, unknown> => {
    const rest = omitFields(data, fields);
    if (rest.cat && typeof rest.cat === "object") {
        rest.cat = omitFields(rest.cat, ["zoneName"]);
    }
    return rest;
};

/**
 * Remembers the area after each question of the last fold, so the next fold
 * only recomputes from the first question that changed. Results are shared
 * and must never be mutated.
 */
export interface QuestionFoldCache {
    start: unknown;
    planningModeEnabled: boolean;
    steps: { key: string; result: any }[];
    /** A step of the last fold failed (e.g. a failed request); retry it on the next refresh */
    lastRunFailed: boolean;
}

export const createQuestionFoldCache = (): QuestionFoldCache => ({
    start: null,
    planningModeEnabled: false,
    steps: [],
    lastRunFailed: false,
});

/** Everything a question's step depends on, besides the area it starts from */
const questionStepKey = (question: Question, planningModeEnabled: boolean) =>
    JSON.stringify([
        question.id,
        // In planning mode unlocked questions are skipped; otherwise the lock doesn't matter
        planningModeEnabled && question.data.drag,
        omitQuestionFields(question.data, [...UI_ONLY_QUESTION_FIELDS, "drag"]),
    ]);

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve));

export async function applyQuestionsToMapGeoData(
    questions: Questions,
    mapGeoData: any,
    planningModeEnabled: boolean,
    planningModeCallback?: (
        polygon: FeatureCollection | Feature,
        question: any,
    ) => void,
    cache?: QuestionFoldCache,
): Promise<any> {
    if (
        cache &&
        (cache.start !== mapGeoData ||
            cache.planningModeEnabled !== planningModeEnabled)
    ) {
        cache.start = mapGeoData;
        cache.planningModeEnabled = planningModeEnabled;
        cache.steps = [];
    }

    if (cache) cache.lastRunFailed = false;

    // Cached steps are only valid while every earlier step was cached too
    let reusing = !!cache;
    let caching = !!cache;
    let computed = 0;

    for (const [index, question] of questions.entries()) {
        if (planningModeCallback) {
            const planningPolygon = await determinePlanningPolygon(
                question,
                planningModeEnabled,
            );
            if (planningPolygon) {
                planningModeCallback(planningPolygon, question);
            }
        }

        const key = cache ? questionStepKey(question, planningModeEnabled) : "";

        if (reusing) {
            const step = cache!.steps[index];
            if (step && step.key === key) {
                mapGeoData = step.result;
                continue;
            }
            reusing = false;
            cache!.steps.length = index;
        }

        if (planningModeEnabled && question.data.drag) {
            if (caching) cache!.steps.push({ key, result: mapGeoData });
            continue;
        }

        // Let the browser paint and handle input between expensive steps
        if (cache && computed++ > 0) await yieldToBrowser();

        let failed = false;
        const softFailuresBefore = overpassSoftFailures();
        mapGeoData = await adjustMapGeoDataForQuestion(
            question,
            mapGeoData,
            () => (failed = true),
        );

        if (mapGeoData.type !== "FeatureCollection") {
            mapGeoData = {
                type: "FeatureCollection",
                features: [mapGeoData],
            };
        }

        // An Overpass request that failed answers with no elements instead of
        // throwing; treat it as a failure so the step isn't kept as a no-op
        if (overpassSoftFailures() !== softFailuresBefore) failed = true;
        if (failed && cache) cache.lastRunFailed = true;

        if (caching) {
            // A failed step (e.g. a failed request) is retried next time, and
            // a question edited while its step ran is recomputed
            if (
                failed ||
                questionStepKey(question, planningModeEnabled) !== key
            ) {
                caching = false;
            } else {
                cache!.steps.push({ key, result: mapGeoData });
            }
        }
    }

    if (reusing) cache!.steps.length = questions.length;

    return mapGeoData;
}
