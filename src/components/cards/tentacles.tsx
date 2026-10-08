import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { atom } from "nanostores";
import {
    memo,
    Suspense,
    use,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarContext,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { UnitSelect } from "@/components/UnitSelect";
import {
    drawingQuestionKey,
    hiderMode,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn, mapToObj } from "@/lib/utils";
import { findTentacleLocations } from "@/maps/api";
import { arcDistance } from "@/maps/geo-utils";
import {
    determineUnionizedStrings,
    NO_GROUP,
    type Questions,
    type TentacleQuestion,
    tentacleQuestionSchema,
    type TraditionalTentacleQuestion,
} from "@/maps/schema";

import {
    CardLatLng,
    QuestionCard,
    type QuestionCardProps,
    questionCardPropsEqual,
    useQuestionIndex,
} from "./base";

/**
 * findTentacleLocations promises by query, so a re-render or a remount reuses
 * the resolved promise (React's use() then reads it without suspending)
 * instead of querying the bundled data again.
 *
 * A lookup that came back empty is not shared: findTentacleLocations resolves
 * to no features when the data file and Overpass are both unreachable. Such a
 * result is only reused for the token it was made with, so Suspense's retry
 * render does not start another lookup, and a card asks again by passing a new
 * token (a new card, or TentacleLocationSelector's onRetry after an edit).
 */
type TentacleLocationLookup = {
    promise: Promise<any>;
    token: object;
    empty: boolean;
};
const tentacleLocationCache = new Map<string, TentacleLocationLookup>();
const TENTACLE_LOCATION_CACHE_SIZE = 32;
const cachedTentacleLocations = (
    data: TraditionalTentacleQuestion,
    token: object,
) => {
    const key = JSON.stringify([
        data.locationType,
        data.lat,
        data.lng,
        data.radius,
        data.unit,
    ]);
    const cached = tentacleLocationCache.get(key);
    if (cached && (!cached.empty || cached.token === token)) {
        // Re-inserted, so the least recently used lookup is evicted first
        tentacleLocationCache.delete(key);
        tentacleLocationCache.set(key, cached);
        return cached.promise;
    }
    const lookup: TentacleLocationLookup = {
        promise: findTentacleLocations(data),
        token,
        empty: false,
    };
    lookup.promise.then(
        (result) => {
            if (!result?.features?.length) lookup.empty = true;
        },
        () => {
            // Failed lookups are retried on the next render, as before
            if (tentacleLocationCache.get(key) === lookup) {
                tentacleLocationCache.delete(key);
            }
        },
    );
    tentacleLocationCache.set(key, lookup);
    if (tentacleLocationCache.size > TENTACLE_LOCATION_CACHE_SIZE) {
        tentacleLocationCache.delete(
            tentacleLocationCache.keys().next().value!,
        );
    }
    return lookup.promise;
};

const NO_QUESTIONS = atom<Questions>([]);
const NO_SIDEBAR = atom({ openMobile: false });

const TentacleQuestionCard = ({
    data,
    questionKey,
    sub,
    className,
    index,
}: QuestionCardProps<TentacleQuestion>) => {
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    // A new token makes cachedTentacleLocations look up an empty result again
    const [lookupToken, setLookupToken] = useState<object>(() => ({}));
    const retryLookup = useCallback(() => setLookupToken({}), []);
    const questionIndex = useQuestionIndex("tentacles", questionKey, index, {
        refresh: false,
    });
    const label = `Tentacles
    ${questionIndex}`;

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            className={className}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed; // Doesn't trigger a re-render so no need for questionModified
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
            hidden={data.hidden}
            setHidden={(hidden) => questionModified((data.hidden = !hidden))}
        >
            <SidebarMenuItem>
                <div className={cn(MENU_ITEM_CLASSNAME, "gap-2 flex flex-row")}>
                    <Input
                        type="number"
                        className="rounded-md p-2 w-16"
                        value={data.radius}
                        onChange={(e) =>
                            questionModified(
                                (data.radius = parseFloat(e.target.value)),
                            )
                        }
                        disabled={!data.drag}
                    />
                    <UnitSelect
                        unit={data.unit}
                        onChange={(unit) =>
                            questionModified((data.unit = unit))
                        }
                        disabled={!data.drag}
                    />
                </div>
            </SidebarMenuItem>
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Location Type"
                    options={Object.fromEntries(
                        tentacleQuestionSchema.options
                            .filter((x) => x.description === NO_GROUP)
                            .flatMap((x) =>
                                determineUnionizedStrings(x.shape.locationType),
                            )
                            .map((x) => [(x._def as any).value, x.description]),
                    )}
                    groups={Object.fromEntries(
                        tentacleQuestionSchema.options
                            .filter((x) => x.description !== NO_GROUP)
                            .map((x) => [
                                x.description,
                                Object.fromEntries(
                                    determineUnionizedStrings(
                                        x.shape.locationType,
                                    ).map((x) => [
                                        (x._def as any).value,
                                        x.description,
                                    ]),
                                ),
                            ]),
                    )}
                    value={data.locationType}
                    onValueChange={async (value) => {
                        if (value === "custom") {
                            const priorLocations = await findTentacleLocations(
                                data as TraditionalTentacleQuestion,
                            );

                            data.locationType = "custom";
                            data.places = priorLocations.features.map((x) => ({
                                ...x,
                                properties: {
                                    ...x.properties,
                                    name:
                                        x.properties?.["name:en"] ??
                                        x.properties?.name,
                                },
                            }));
                            data.location = false;
                        } else {
                            data.location = false;
                            data.locationType = value;
                        }
                        questionModified();
                    }}
                    disabled={!data.drag}
                />
            </SidebarMenuItem>
            {data.locationType === "custom" && data.drag && (
                <>
                    <p className="px-2 mb-1 text-center text-orange-500">
                        To modify tentacle locations, enable it:
                        <Checkbox
                            className="mx-1 my-1"
                            checked={$drawingQuestionKey === questionKey}
                            onCheckedChange={(checked) => {
                                if (checked) {
                                    drawingQuestionKey.set(questionKey);
                                } else {
                                    drawingQuestionKey.set(-1);
                                }
                            }}
                            disabled={!data.drag}
                        />
                        and use the buttons at the bottom left of the map.
                    </p>
                    <div className="flex justify-center mb-2">
                        <PresetsDialog
                            data={data}
                            presetTypeHint="custom-tentacles"
                        />
                    </div>
                </>
            )}
            <CardLatLng
                latitude={data.lat}
                longitude={data.lng}
                colorName={data.color}
                onChange={(lat, lng) => {
                    if (lat !== null) {
                        data.lat = lat;
                    }
                    if (lng !== null) {
                        data.lng = lng;
                    }
                    questionModified();
                }}
                disabled={!data.drag}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Suspense
                    fallback={
                        <div className="flex items-center justify-center w-full h-8">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="24"
                                height="24"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="animate-spin"
                            >
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                        </div>
                    }
                >
                    <TentacleLocationSelector
                        // A new lookup (e.g. a pasted or synced game) starts
                        // without a filtered list, so the answer isn't checked
                        // against the previous lookup's places
                        key={JSON.stringify([
                            data.locationType,
                            data.lat,
                            data.lng,
                            data.radius,
                            data.unit,
                        ])}
                        data={data}
                        promise={
                            data.locationType === "custom"
                                ? Promise.resolve(
                                      turf.featureCollection(data.places),
                                  )
                                : cachedTentacleLocations(data, lookupToken)
                        }
                        onRetry={
                            data.locationType === "custom"
                                ? undefined
                                : retryLookup
                        }
                        disabled={!data.drag}
                    />
                </Suspense>
            </SidebarMenuItem>
        </QuestionCard>
    );
};

export const TentacleQuestionComponent = memo(
    TentacleQuestionCard,
    questionCardPropsEqual,
);

const TentacleLocationSelector = ({
    data,
    promise,
    onRetry,
    disabled,
}: {
    data: TentacleQuestion;
    promise: Promise<any>;
    onRetry?: () => void;
    disabled: boolean;
}) => {
    const $refresh = useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const locations = use(promise);

    // An empty lookup (e.g. made offline) is asked again after the next edit or
    // when the phone panel is opened again, as the card used to re-render and
    // look up its locations on every change
    const lookupFailed = !!onRetry && !locations?.features?.length;
    const $questions = useStore(lookupFailed ? questions : NO_QUESTIONS);
    const { openMobile } = useStore(lookupFailed ? SidebarContext : NO_SIDEBAR);
    const lastSeen = useRef({
        failed: lookupFailed,
        questions: $questions,
        refresh: $refresh,
        openMobile,
    });
    useEffect(() => {
        const last = lastSeen.current;
        lastSeen.current = {
            failed: lookupFailed,
            questions: $questions,
            refresh: $refresh,
            openMobile,
        };
        if (
            lookupFailed &&
            last.failed &&
            (last.questions !== $questions ||
                last.refresh !== $refresh ||
                (openMobile && !last.openMobile))
        ) {
            onRetry?.();
        }
    }, [lookupFailed, $questions, $refresh, openMobile, onRetry]);

    // null until filtered, so a saved answer isn't cleared on the first render
    const [filteredFeatures, setFilteredFeatures] = useState<any[] | null>(
        null,
    );

    // Filter locations to only those within the radius of the primary location
    useEffect(() => {
        let cancelled = false;

        const filterLocations = async () => {
            if (
                data.lat === null ||
                data.lng === null ||
                data.radius === undefined ||
                data.radius === null
            ) {
                if (!cancelled) setFilteredFeatures(locations.features);
                return;
            }

            const center = turf.point([data.lng, data.lat]);
            const included = await Promise.all(
                locations.features.map(async (feature: any) => {
                    const coords =
                        feature?.geometry?.coordinates ??
                        (feature?.properties?.lon && feature?.properties?.lat
                            ? [feature.properties.lon, feature.properties.lat]
                            : null);

                    if (!coords) return false;

                    return (
                        (await arcDistance(
                            center,
                            turf.point(coords),
                            data.unit,
                        )) <= data.radius
                    );
                }),
            );
            if (!cancelled) {
                setFilteredFeatures(
                    locations.features.filter(
                        (_: any, index: number) => included[index],
                    ),
                );
            }
        };

        filterLocations();
        return () => {
            cancelled = true;
        };
    }, [locations, data.lat, data.lng, data.radius, data.unit]);

    // If the currently selected location is no longer within radius, clear it.
    const _selectedLocationName = data.location
        ? data.location.properties?.name
        : null;
    if (
        _selectedLocationName &&
        filteredFeatures &&
        !filteredFeatures.find(
            (f: any) => f.properties.name === _selectedLocationName,
        )
    ) {
        data.location = false;
        questionModified();
    }

    return (
        <Select
            trigger="Location"
            options={{
                false: "Not Within",
                ...mapToObj(filteredFeatures ?? [], (feature: any) => [
                    feature.properties.name,
                    feature.properties.name,
                ]),
            }}
            value={data.location ? data.location.properties.name : "false"}
            onValueChange={(value) => {
                if (value === "false") {
                    data.location = false;
                } else {
                    data.location = (filteredFeatures ?? []).find(
                        (feature: any) => feature.properties.name === value,
                    );
                }

                questionModified();
            }}
            disabled={!!$hiderMode || disabled}
        />
    );
};
