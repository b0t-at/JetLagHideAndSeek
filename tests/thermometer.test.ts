import * as turf from "@turf/turf";
import { describe, expect, test } from "vitest";

import { adjustPerThermometer } from "@/maps/questions/thermometer";
import type { ThermometerQuestion } from "@/maps/schema";

// A square around central Vienna
const playArea = turf.featureCollection([
    turf.bboxPolygon([16.25, 48.15, 16.5, 48.28]),
]);

const remaining = (question: Partial<ThermometerQuestion>) =>
    adjustPerThermometer(question as ThermometerQuestion, playArea)!;

describe("adjustPerThermometer", () => {
    for (const [name, a, b] of [
        ["east-west at the same latitude", [16.345, 48.215], [16.395, 48.215]],
        ["west-east at the same latitude", [16.395, 48.215], [16.345, 48.215]],
        ["east-west, 1e-7° apart", [16.345, 48.215], [16.395, 48.2150001]],
        ["north-south", [16.37, 48.19], [16.37, 48.23]],
    ] as [string, [number, number], [number, number]][]) {
        test(`keeps opposite halves for warmer and colder (${name})`, () => {
            const question = {
                lngA: a[0],
                latA: a[1],
                lngB: b[0],
                latB: b[1],
            };
            const warmer = remaining({ ...question, warmer: true });
            const colder = remaining({ ...question, warmer: false });

            expect(turf.booleanPointInPolygon(b, warmer)).toBe(true);
            expect(turf.booleanPointInPolygon(a, warmer)).toBe(false);
            expect(turf.booleanPointInPolygon(a, colder)).toBe(true);
            expect(turf.booleanPointInPolygon(b, colder)).toBe(false);
        });
    }
});
