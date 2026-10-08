import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { defaultFilter } from "cmdk";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import type * as L from "leaflet";
import _ from "lodash";
import { SidebarCloseIcon } from "lucide-react";
import osmtogeojson from "osmtogeojson";
import {
    memo,
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { toast } from "react-toastify";

import {
    Sidebar,
    SidebarContent,
    SidebarContext,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
} from "@/components/ui/sidebar-r";
import {
    animateMapMovements,
    autoZoom,
    customStations as customStationsAtom,
    disabledStations,
    displayHidingZones,
    displayHidingZonesOptions,
    displayHidingZonesStyle,
    hidingRadius,
    hidingRadiusUnits,
    includeDefaultStations as includeDefaultStationsAtom,
    isLoading,
    leafletMapContext,
    mergeDuplicates as mergeDuplicatesAtom,
    planningModeEnabled,
    questionFinishedMapData,
    questions,
    trainStations,
    useCustomStations as useCustomStationsAtom,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import {
    BLANK_GEOJSON,
    findPlacesInZone,
    findPlacesSpecificInZone,
    findQuestionLocations,
    findTentacleLocations,
    normalizeToStationFeatures,
    parseCustomStationsFromText,
    QuestionSpecificLocation,
    type StationPlace,
    trainLineNodeFinder,
} from "@/maps/api";
import {
    arcDistance,
    extractStationLabel,
    extractStationName,
    geoSpatialVoronoi,
    holedMask,
    mergeDuplicateStation,
    safeUnion,
} from "@/maps/geo-utils";

import {
    clearHidingZones,
    drawHidingZoneGeoJSON,
    drawHidingZones,
} from "./hidingZoneLayers";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "./ui/command";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollToTop } from "./ui/scroll-to-top";
import { MENU_ITEM_CLASSNAME } from "./ui/sidebar-l";
import { UnitSelect } from "./UnitSelect";

function _previewText(count: number) {
    return `${count} custom station${count === 1 ? "" : "s"} imported`;
}

let buttonJustClicked = false;

/** Rows rendered in the station list before "Show all"; searching narrows the list */
const STATION_LIST_LIMIT = 100;

const toggleStationSoon = (id: string) => {
    if (!leafletMapContext.get()) return;

    // Gives the "View" button's click a chance to cancel the toggle
    setTimeout(() => {
        if (buttonJustClicked) {
            buttonJustClicked = false;
            return;
        }

        const current = disabledStations.get();
        disabledStations.set(
            current.includes(id)
                ? current.filter((x) => x !== id)
                : [...current, id],
        );
    }, 100);
};

const StationRow = memo(function StationRow({
    id,
    label,
    struck,
    loading,
    onView,
}: {
    id: string;
    label: string;
    struck: boolean;
    loading: boolean;
    onView: (id: string) => void;
}) {
    return (
        <CommandItem
            data-station-id={id}
            value={id}
            className={cn(struck && "line-through")}
            onSelect={() => toggleStationSoon(id)}
            disabled={loading}
        >
            {label}
            <button
                onClick={() => {
                    if (!leafletMapContext.get()) return;

                    buttonJustClicked = true;

                    onView(id);
                }}
                className="bg-slate-600 p-0.5 rounded-md"
                disabled={loading}
            >
                View
            </button>
        </CommandItem>
    );
});

export const ZoneSidebar = () => {
    const $displayHidingZones = useStore(displayHidingZones);
    const $questionFinishedMapData = useStore(questionFinishedMapData);
    const $displayHidingZonesOptions = useStore(displayHidingZonesOptions);
    const $displayHidingZonesStyle = useStore(displayHidingZonesStyle);
    const $hidingRadius = useStore(hidingRadius);
    const $hidingRadiusUnits = useStore(hidingRadiusUnits);
    const $isLoading = useStore(isLoading);
    const map = useStore(leafletMapContext);
    const stations = useStore(trainStations);
    const $disabledStations = useStore(disabledStations);
    const useCustomStations = useStore(useCustomStationsAtom);
    const mergeDuplicates = useStore(mergeDuplicatesAtom);
    const includeDefaultStations = useStore(includeDefaultStationsAtom);
    const $customStations = useStore(customStationsAtom);
    const [hidingZoneModeStationID, setHidingZoneModeStationID] =
        useState<string>("");
    const [stationSearch, setStationSearch] = useState<string>("");
    const deferredStationSearch = useDeferredValue(stationSearch);
    const [showAllStations, setShowAllStations] = useState(false);
    const setStations = trainStations.set;
    const sidebarRef = useRef<HTMLDivElement>(null);
    const [importUrl, setImportUrl] = useState("");
    // The last selected hiding zone that was drawn, and a token so only the newest selection run draws
    const drawnSelection = useRef<{ id: string; stations: unknown } | null>(
        null,
    );
    const selectionRun = useRef(0);

    const labelledStations = useMemo(
        () =>
            stations.map((station) => ({
                id: station.properties.properties.id as string,
                label: extractStationLabel(station.properties) as string,
            })),
        [stations],
    );

    // Same matches and order as cmdk's own filter, without remounting the list
    const matchingStations = useMemo(() => {
        const search = deferredStationSearch.trim();
        if (!search) return labelledStations;

        return labelledStations
            .map((station) => ({
                station,
                score: defaultFilter!(station.label ?? "", search),
            }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.station);
    }, [labelledStations, deferredStationSearch]);

    const shownStations = useMemo(() => {
        if (showAllStations || matchingStations.length <= STATION_LIST_LIMIT)
            return matchingStations;

        const shown = matchingStations.slice(0, STATION_LIST_LIMIT);
        // The selected hiding zone's row must exist so it can be scrolled to
        if (
            hidingZoneModeStationID &&
            !shown.some((x) => x.id === hidingZoneModeStationID)
        ) {
            const selected = matchingStations.find(
                (x) => x.id === hidingZoneModeStationID,
            );
            if (selected) shown.push(selected);
        }
        return shown;
    }, [matchingStations, showAllStations, hidingZoneModeStationID]);

    const disabledStationSet = useMemo(
        () => new Set($disabledStations),
        [$disabledStations],
    );

    const viewStation = useCallback(
        (id: string) => setHidingZoneModeStationID(id),
        [],
    );

    useEffect(() => {
        if (!map || isLoading.get()) return;

        const initializeHidingZones = async () => {
            isLoading.set(true);

            const needsDefault = !useCustomStations || includeDefaultStations;
            if (needsDefault && $displayHidingZonesOptions.length === 0) {
                toast.error("At least one place type must be selected");
                isLoading.set(false);
                return;
            }

            let places: StationPlace[] = [];

            if (!needsDefault) {
                // Custom only
                places = normalizeToStationFeatures(
                    $customStations,
                ).features.map((f) => ({
                    type: "Feature",
                    geometry: f.geometry,
                    properties: {
                        id:
                            f.properties?.id ||
                            `${(f.geometry as any).coordinates[1]},${(f.geometry as any).coordinates[0]}`,
                        name: f.properties?.name,
                    },
                }));
            } else {
                // Fetch default, optionally merge custom
                // @ts-expect-error osmtogeojson always defines properties with an "id" string
                places = osmtogeojson(
                    await findPlacesInZone(
                        $displayHidingZonesOptions[0],
                        "Finding stations. This may take a while. Do not press any buttons while this is processing. Don't worry, it will be cached.",
                        "nwr",
                        "center",
                        $displayHidingZonesOptions.slice(1),
                    ),
                ).features;

                if (
                    useCustomStations &&
                    $customStations.length > 0 &&
                    includeDefaultStations
                ) {
                    const customFeatures = normalizeToStationFeatures(
                        $customStations,
                    ).features.map(
                        (f) =>
                            ({
                                type: "Feature",
                                geometry: f.geometry,
                                properties: {
                                    id:
                                        f.properties?.id ||
                                        `${f.geometry.coordinates[1]},${f.geometry.coordinates[0]}`,
                                    name: f.properties?.name,
                                },
                            }) as StationPlace,
                    );
                    const seen = new Set<string>();
                    const merged: StationPlace[] = [];
                    const add = (feat: StationPlace) => {
                        const id = feat.properties.id as string | undefined;
                        const key =
                            id && id.includes("/")
                                ? `id:${id}`
                                : `pt:${feat.geometry.coordinates[1]},${feat.geometry.coordinates[0]}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            merged.push(feat);
                        }
                    };
                    places.forEach(add);
                    customFeatures.forEach(add);
                    places = merged;
                }
            }

            // merge duplicate stations if selected
            if (mergeDuplicates) {
                places = await mergeDuplicateStation(
                    places,
                    $hidingRadius,
                    $hidingRadiusUnits,
                );
            }

            const unionized = safeUnion(
                turf.simplify($questionFinishedMapData, {
                    tolerance: 0.001,
                }),
            );

            let circles = places
                .map((place) => {
                    const radius = $hidingRadius;
                    const center = turf.getCoord(place);
                    const circle = turf.circle(center, radius, {
                        steps: 32,
                        units: $hidingRadiusUnits,
                        properties: place,
                    });

                    return circle;
                })
                .filter((circle) => {
                    return !turf.booleanWithin(circle, unionized);
                });

            for (const question of questions.get()) {
                if (planningModeEnabled.get() && question.data.drag) {
                    continue;
                }

                if (
                    question.id === "matching" &&
                    (question.data.type === "same-first-letter-station" ||
                        question.data.type === "same-length-station" ||
                        question.data.type === "same-train-line")
                ) {
                    const location = turf.point([
                        question.data.lng,
                        question.data.lat,
                    ]);

                    const nearestTrainStation = turf.nearestPoint(
                        location,
                        turf.featureCollection(
                            circles.map((x) => x.properties),
                        ) as any,
                    );

                    if (question.data.type === "same-train-line") {
                        // Custom-only lists don't have reliable OSM IDs
                        if (useCustomStations && !includeDefaultStations) {
                            toast.warning(
                                "'Same train line' isn't supported with custom-only station lists; skipping this filter.",
                            );
                        } else {
                            const nid = nearestTrainStation.properties.id as
                                | string
                                | undefined;
                            if (!nid || !nid.includes("/")) {
                                toast.warning(
                                    "Nearest station has no OSM id; skipping 'same train line' filter.",
                                );
                                continue;
                            }

                            const nodes = await trainLineNodeFinder(nid);

                            if (nodes.length === 0) {
                                toast.warning(
                                    `No train line found for ${extractStationName(
                                        nearestTrainStation,
                                    )}`,
                                );
                                continue;
                            } else {
                                circles = circles.filter((circle) => {
                                    const idProp =
                                        circle.properties.properties.id;
                                    if (!idProp || !idProp.includes("/"))
                                        return false;
                                    const id = parseInt(idProp.split("/")[1]);

                                    return question.data.same
                                        ? nodes.includes(id)
                                        : !nodes.includes(id);
                                });
                            }
                        }
                    }

                    const englishName = extractStationName(nearestTrainStation);

                    if (!englishName) {
                        isLoading.set(false);
                        return toast.error("No English name found");
                    }

                    if (question.data.type === "same-first-letter-station") {
                        const letter = englishName[0].toUpperCase();

                        circles = circles.filter((circle) => {
                            const name = extractStationName(circle.properties);
                            if (!name) return false;

                            return question.data.same
                                ? name[0].toUpperCase() === letter
                                : name[0].toUpperCase() !== letter;
                        });
                    } else if (question.data.type === "same-length-station") {
                        const seekerLength = englishName.length;
                        const comparison = question.data.lengthComparison;

                        circles = circles.filter((circle) => {
                            const name = extractStationName(circle.properties);
                            if (!name) return false;

                            if (comparison === "same") {
                                return name.length === seekerLength;
                            } else if (comparison === "shorter") {
                                return name.length < seekerLength;
                            } else if (comparison === "longer") {
                                return name.length > seekerLength;
                            }
                            return false;
                        });
                    }
                }
                if (
                    question.id === "measuring" &&
                    (question.data.type === "mcdonalds" ||
                        question.data.type === "seven11")
                ) {
                    const points = await findPlacesSpecificInZone(
                        question.data.type === "mcdonalds"
                            ? QuestionSpecificLocation.McDonalds
                            : QuestionSpecificLocation.Seven11,
                    );

                    if (points.features.length === 0) {
                        warnNoSpecificPlaces(question.data.type);
                        continue;
                    }

                    const nearestPoint = turf.nearestPoint(
                        turf.point([question.data.lng, question.data.lat]),
                        points as any,
                    );

                    const distance = await arcDistance(
                        turf.point([question.data.lng, question.data.lat]),
                        nearestPoint as any,
                        "miles",
                    );
                    const hidingRadiusMiles = hidingRadiusInMiles(
                        $hidingRadius,
                        $hidingRadiusUnits,
                    );

                    const eligibleCircles = await Promise.all(
                        circles.map(async (circle) => {
                            const point = turf.point(
                                turf.getCoord(circle.properties),
                            );
                            const nearest = turf.nearestPoint(
                                point,
                                points as any,
                            );
                            const stationDistance = await arcDistance(
                                point,
                                nearest as any,
                                "miles",
                            );

                            return question.data.hiderCloser
                                ? stationDistance < distance + hidingRadiusMiles
                                : stationDistance >
                                      distance - hidingRadiusMiles;
                        }),
                    );
                    circles = circles.filter(
                        (_, index) => eligibleCircles[index],
                    );
                }
            }

            setStations(circles);
            isLoading.set(false);
        };

        if ($displayHidingZones && $questionFinishedMapData) {
            initializeHidingZones().catch((error) => {
                console.log("Error in hiding zone initialization:", error);
                isLoading.set(false);
                toast.error(
                    "An error occurred during hiding zone initialization",
                    { toastId: "hiding-zone-initialization-error" },
                );
            });
        }
    }, [
        $questionFinishedMapData,
        $displayHidingZones,
        $displayHidingZonesOptions,
        $hidingRadius,
        $hidingRadiusUnits,
        useCustomStations,
        includeDefaultStations,
        $customStations,
        mergeDuplicates,
    ]);

    // Question data and the radius reach this effect through `stations`: the effect above
    // recomputes them whenever those change, so listing them here would draw twice
    useEffect(() => {
        if (!map || isLoading.get()) return;

        if ($displayHidingZones && hidingZoneModeStationID) {
            const hiderStation = _.find(
                stations,
                (c) => c.properties.properties.id === hidingZoneModeStationID,
            );

            if (hiderStation !== undefined) {
                // Disabling a station doesn't change the selected zone
                if (
                    drawnSelection.current?.id === hidingZoneModeStationID &&
                    drawnSelection.current.stations === stations
                ) {
                    return;
                }
                drawnSelection.current = {
                    id: hidingZoneModeStationID,
                    stations,
                };

                const run = ++selectionRun.current;
                selectionProcess(
                    hiderStation,
                    map,
                    stations,
                    (geoJSONData) => drawHidingZoneGeoJSON(map, geoJSONData),
                    questionFinishedMapData.get(),
                    hidingRadiusInMiles(
                        hidingRadius.get(),
                        hidingRadiusUnits.get(),
                    ),
                    () => run === selectionRun.current,
                ).catch((error) => {
                    console.log("Error in hiding zone selection:", error);
                    toast.error(
                        "An error occurred during hiding zone selection",
                        { toastId: "hiding-zone-selection-error" },
                    );
                });
            } else {
                toast.error("Invalid hiding zone selected", {
                    toastId: "hiding-zone-selection-error",
                });
            }
        } else {
            drawnSelection.current = null;
            selectionRun.current++;

            if ($displayHidingZones) {
                drawHidingZones(
                    map,
                    stations,
                    $disabledStations,
                    $displayHidingZonesStyle,
                    viewStation,
                );
            } else {
                clearHidingZones(map);
            }
        }
    }, [
        $disabledStations,
        $displayHidingZones,
        $displayHidingZonesStyle,
        hidingZoneModeStationID,
        stations,
    ]);

    return (
        <Sidebar side="right">
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">Hiding Zone</h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden scale-x-[-1]"
                    onClick={() => {
                        SidebarContext.get().setOpenMobile(false);
                    }}
                />
            </div>
            <SidebarContent ref={sidebarRef}>
                <ScrollToTop element={sidebarRef} minHeight={500} />
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <Label className="font-semibold font-poppins">
                                    Display hiding zones?
                                </Label>
                                <Checkbox
                                    defaultChecked={$displayHidingZones}
                                    checked={$displayHidingZones}
                                    onCheckedChange={displayHidingZones.set}
                                    disabled={$isLoading}
                                />
                            </SidebarMenuItem>
                            <SidebarMenuItem
                                className={cn(
                                    MENU_ITEM_CLASSNAME,
                                    "text-orange-500",
                                )}
                            >
                                Warning: This feature can drastically slow down
                                your device.
                            </SidebarMenuItem>
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <div className="flex flex-row items-center justify-between w-full">
                                    <Label className="font-semibold font-poppins">
                                        Merge duplicated stations?
                                    </Label>
                                    <Checkbox
                                        checked={mergeDuplicates}
                                        onCheckedChange={(v) =>
                                            mergeDuplicatesAtom.set(!!v)
                                        }
                                        disabled={$isLoading}
                                    />
                                </div>
                            </SidebarMenuItem>
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <div className="flex flex-col gap-2 w-full">
                                    <Label className="font-semibold font-poppins leading-5">
                                        Import stations from URL (CSV, GeoJSON,
                                        KML). This must be a raw file link.
                                    </Label>
                                    <div className="flex gap-2">
                                        <Input
                                            placeholder="https://..."
                                            value={importUrl}
                                            onChange={(e) =>
                                                setImportUrl(e.target.value)
                                            }
                                            disabled={$isLoading}
                                        />
                                        <button
                                            className="bg-blue-600 text-white px-3 rounded-md"
                                            disabled={$isLoading}
                                            onClick={async () => {
                                                if (!importUrl) return;
                                                try {
                                                    const res =
                                                        await fetch(importUrl);
                                                    const contentType =
                                                        res.headers.get(
                                                            "content-type",
                                                        ) || undefined;
                                                    const text =
                                                        await res.text();
                                                    const parsed =
                                                        parseCustomStationsFromText(
                                                            text,
                                                            contentType ||
                                                                undefined,
                                                        );
                                                    if (parsed.length === 0) {
                                                        toast.error(
                                                            "No stations found in provided URL",
                                                        );
                                                        return;
                                                    }
                                                    customStationsAtom.set(
                                                        parsed,
                                                    );
                                                    toast.success(
                                                        `Imported ${parsed.length} stations`,
                                                    );
                                                } catch (e: any) {
                                                    toast.error(
                                                        `Failed to import from URL: ${e.message || e}`,
                                                    );
                                                }
                                            }}
                                        >
                                            Import
                                        </button>
                                    </div>
                                    <div>
                                        <Input
                                            type="file"
                                            multiple
                                            accept=".csv,.json,.geojson,.kml,application/json,application/vnd.google-earth.kml+xml,text/csv,application/vnd.google-apps.kml+xml,application/xml,text/xml"
                                            onInput={async (e) => {
                                                const files = (
                                                    e.target as HTMLInputElement
                                                ).files;
                                                if (
                                                    !files ||
                                                    files.length === 0
                                                )
                                                    return;
                                                try {
                                                    const all: any[] = [];
                                                    for (const file of Array.from(
                                                        files,
                                                    )) {
                                                        const text =
                                                            await file.text();
                                                        const parsed =
                                                            parseCustomStationsFromText(
                                                                text,
                                                                file.type,
                                                            );
                                                        all.push(...parsed);
                                                    }
                                                    if (all.length === 0) {
                                                        toast.error(
                                                            "No stations found in uploaded files",
                                                        );
                                                        return;
                                                    }
                                                    const byKey = new Map<
                                                        string,
                                                        any
                                                    >();
                                                    for (const s of all) {
                                                        const key =
                                                            s.id &&
                                                            s.id.includes("/")
                                                                ? `id:${s.id}`
                                                                : `pt:${s.lat},${s.lng}`;
                                                        if (!byKey.has(key))
                                                            byKey.set(key, s);
                                                    }
                                                    const unique = Array.from(
                                                        byKey.values(),
                                                    );
                                                    customStationsAtom.set(
                                                        unique,
                                                    );
                                                    toast.success(
                                                        `Imported ${unique.length} stations`,
                                                    );
                                                } catch (e: any) {
                                                    toast.error(
                                                        `Failed to import files: ${e.message || e}`,
                                                    );
                                                }
                                            }}
                                        />
                                    </div>
                                    {$customStations.length > 0 && (
                                        <div className="text-sm text-gray-300">
                                            {_previewText(
                                                $customStations.length,
                                            )}
                                        </div>
                                    )}
                                    {$customStations.length > 0 && (
                                        <div className="flex gap-2">
                                            <Button
                                                className="w-full"
                                                onClick={() =>
                                                    customStationsAtom.set([])
                                                }
                                            >
                                                Clear Imported
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                                <Label className="font-semibold font-poppins ml-2">
                                    Hiding Zone Radius
                                </Label>
                                <div
                                    className={cn(
                                        MENU_ITEM_CLASSNAME,
                                        "gap-2 flex flex-row",
                                    )}
                                >
                                    <Input
                                        type="number"
                                        className="rounded-md p-2 w-16"
                                        value={$hidingRadius}
                                        onChange={(e) => {
                                            // The input is debounced; ignore a cleared or partial value such as "" or "0."
                                            const radius = parseFloat(
                                                e.target.value,
                                            );
                                            if (
                                                Number.isFinite(radius) &&
                                                radius > 0 &&
                                                radius !== hidingRadius.get()
                                            ) {
                                                hidingRadius.set(radius);
                                            }
                                        }}
                                        disabled={$isLoading}
                                    />
                                    <UnitSelect
                                        unit={$hidingRadiusUnits}
                                        disabled={$isLoading}
                                        onChange={(unit) => {
                                            hidingRadiusUnits.set(unit);
                                        }}
                                    />
                                </div>
                            </SidebarMenuItem>
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set(
                                            "no-display",
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    No Display
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set("stations");
                                    }}
                                    disabled={$isLoading}
                                >
                                    All Stations
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set("zones");
                                    }}
                                    disabled={$isLoading}
                                >
                                    All Zones
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set(
                                            "no-overlap",
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    No Overlap
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && hidingZoneModeStationID && (
                                <SidebarMenuItem
                                    className={cn(
                                        MENU_ITEM_CLASSNAME,
                                        "bg-popover hover:bg-accent",
                                    )}
                                    disabled={$isLoading}
                                >
                                    Current:{" "}
                                    {(() => {
                                        const selected = stations.find(
                                            (x) =>
                                                x.properties.properties.id ===
                                                hidingZoneModeStationID,
                                        );
                                        const displayName = extractStationLabel(
                                            selected?.properties,
                                        );
                                        const id = selected?.properties
                                            .properties.id as string;
                                        const coords = selected?.properties
                                            .geometry.coordinates as [
                                            number,
                                            number,
                                        ];
                                        const href = id?.includes("/")
                                            ? `https://www.openstreetmap.org/${id}`
                                            : `https://www.openstreetmap.org/?mlat=${coords[1]}&mlon=${coords[0]}#map=17/${coords[1]}/${coords[0]}`;
                                        return (
                                            <a
                                                href={href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-blue-500"
                                            >
                                                {displayName}
                                            </a>
                                        );
                                    })()}
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones &&
                                $disabledStations.length > 0 && (
                                    <SidebarMenuItem
                                        className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                        onClick={() => {
                                            disabledStations.set([]);
                                        }}
                                        disabled={$isLoading}
                                    >
                                        Clear Disabled
                                    </SidebarMenuItem>
                                )}
                            {$displayHidingZones && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        disabledStations.set(
                                            stations.map(
                                                (x) =>
                                                    x.properties.properties.id,
                                            ),
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    Disable All
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && (
                                <Command shouldFilter={false}>
                                    <CommandInput
                                        placeholder="Search for a hiding zone..."
                                        value={stationSearch}
                                        onValueChange={(search) => {
                                            setStationSearch(search);
                                            setShowAllStations(false);
                                        }}
                                        disabled={$isLoading}
                                    />
                                    <CommandList className="max-h-full">
                                        <CommandEmpty>
                                            No hiding zones found.
                                        </CommandEmpty>
                                        <CommandGroup>
                                            {shownStations.map((station) => (
                                                <StationRow
                                                    key={station.id}
                                                    id={station.id}
                                                    label={station.label}
                                                    struck={disabledStationSet.has(
                                                        station.id,
                                                    )}
                                                    loading={$isLoading}
                                                    onView={viewStation}
                                                />
                                            ))}
                                        </CommandGroup>
                                        {shownStations.length <
                                            matchingStations.length && (
                                            <button
                                                className="w-full p-2 text-sm text-muted-foreground"
                                                onClick={() =>
                                                    setShowAllStations(true)
                                                }
                                            >
                                                Showing {shownStations.length}{" "}
                                                of {matchingStations.length}.
                                                Search to narrow down, or tap to
                                                show all.
                                            </button>
                                        )}
                                    </CommandList>
                                </Command>
                            )}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
        </Sidebar>
    );
};

const warnNoSpecificPlaces = (type: "mcdonalds" | "seven11") =>
    toast.warning(
        `No ${type === "mcdonalds" ? "McDonald's" : "7-Elevens"} found in the play area; skipping this question.`,
        { toastId: `no-places-${type}` },
    );

/** The distance checks below work in miles; invalid input (e.g. a cleared field) counts as 0 */
const hidingRadiusInMiles = (radius: number, units: turf.Units) =>
    Number.isFinite(radius) && radius >= 0
        ? turf.convertLength(radius, units, "miles")
        : 0;

/** The part of a (multi)polygon inside the station's bbox (plus a margin); [] when nothing is left */
const clipToStation = (
    feature: Feature<Polygon | MultiPolygon>,
    station: Feature<Polygon>,
): Feature<Polygon | MultiPolygon>[] => {
    const [minX, minY, maxX, maxY] = turf.bbox(station);
    const pad = Math.max(maxX - minX, maxY - minY) * 0.1;
    const geometry = turf.bboxClip(feature, [
        minX - pad,
        minY - pad,
        maxX + pad,
        maxY + pad,
    ]).geometry as Polygon | MultiPolygon;
    const polygons: Position[][][] = (
        geometry.type === "Polygon"
            ? [geometry.coordinates]
            : geometry.coordinates
    ).filter((polygon) => polygon.length > 0);

    if (polygons.length === 0) return [];
    return [
        polygons.length === 1
            ? turf.polygon(polygons[0])
            : turf.multiPolygon(polygons),
    ];
};

async function selectionProcess(
    station: any,
    map: L.Map,
    stations: any[],
    showGeoJSON: (geoJSONData: any) => void,
    $questionFinishedMapData: any,
    hidingRadiusMiles: number,
    // False once a newer selection started: then this run must not draw, move the map or scroll
    isCurrent: () => boolean,
) {
    const bbox = turf.bbox(station);

    const bounds: [[number, number], [number, number]] = [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
    ];

    // mask(station) already covers everything outside the station's bbox, so the eliminated
    // area only matters inside it; clipping it first keeps this union small (same result)
    let mapData: any = turf.featureCollection([
        safeUnion(
            turf.featureCollection([
                ...$questionFinishedMapData.features.flatMap((feature: any) =>
                    clipToStation(feature, station),
                ),
                turf.mask(station),
            ]),
        ),
    ]);

    for (const question of questions.get()) {
        if (planningModeEnabled.get() && question.data.drag) {
            continue;
        }

        if (
            (question.id === "measuring" || question.id === "matching") &&
            (question.data.type === "aquarium" ||
                question.data.type === "zoo" ||
                question.data.type === "theme_park" ||
                question.data.type === "peak" ||
                question.data.type === "museum" ||
                question.data.type === "hospital" ||
                question.data.type === "cinema" ||
                question.data.type === "library" ||
                question.data.type === "golf_course" ||
                question.data.type === "consulate" ||
                question.data.type === "park")
        ) {
            // The search around the seeker is already cached; it suffices if it covers every candidate
            const seekerSearch = await findQuestionLocations(question.data);
            const seekerPoint = turf.point([
                question.data.lng,
                question.data.lat,
            ]);
            const nearestQuestion = turf.nearestPoint(
                seekerPoint,
                seekerSearch.instances,
            );

            const withDistances = (instances: any): Promise<any[]> =>
                Promise.all(
                    instances.features.map(async (x: any) => ({
                        distance: await arcDistance(
                            turf.point(turf.getCoord(x)),
                            station.properties,
                            "miles",
                        ),
                        point: x,
                    })),
                );

            let distances = await withDistances(seekerSearch.instances);
            let minimumPoint = _.minBy(distances, "distance");
            const seekerToStation = await arcDistance(
                seekerPoint,
                station.properties,
                "miles",
            );

            if (
                !minimumPoint ||
                seekerToStation +
                    minimumPoint.distance +
                    hidingRadiusMiles * 2 >
                    seekerSearch.radiusMiles
            ) {
                let radius = 30;

                while (true) {
                    distances = await withDistances(
                        await findTentacleLocations(
                            {
                                lat: station.properties.geometry.coordinates[1],
                                lng: station.properties.geometry.coordinates[0],
                                radius: radius,
                                unit: "miles",
                                locationType: question.data.type,
                            },
                            "Finding matching locations to hiding zone...",
                        ),
                    );
                    minimumPoint = _.minBy(distances, "distance");

                    if (!minimumPoint) {
                        radius += 30;
                    } else if (
                        minimumPoint.distance + hidingRadiusMiles * 2 >
                        radius
                    ) {
                        radius = minimumPoint.distance + hidingRadiusMiles * 2;
                    } else {
                        break;
                    }
                }
            }

            const nearestPoints = distances
                .filter(
                    (x) =>
                        x.distance <
                            minimumPoint!.distance + hidingRadiusMiles * 2 &&
                        x.point.properties.name, // If it doesn't have a name, it's not a valid location
                )
                .map((x) => x.point);

            if (question.id === "matching") {
                const voronoi = geoSpatialVoronoi(
                    turf.featureCollection(nearestPoints),
                );

                const correctPolygon = voronoi.features.find((feature: any) => {
                    return (
                        feature.properties.site.properties.name ===
                        nearestQuestion.properties.name
                    );
                });

                if (!correctPolygon) {
                    if (question.data.same) {
                        mapData = BLANK_GEOJSON;
                    }

                    continue;
                }

                if (question.data.same) {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            turf.mask(correctPolygon),
                        ]),
                    );
                } else {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            correctPolygon,
                        ]),
                    );
                }
            } else {
                const circles = nearestPoints.map((x) =>
                    turf.circle(
                        turf.getCoord(x),
                        nearestQuestion.properties.distanceToPoint,
                    ),
                );

                if (question.data.hiderCloser) {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            holedMask(turf.featureCollection(circles)),
                        ]),
                    );
                } else {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            ...circles,
                        ]),
                    );
                }
            }
        }
        if (
            question.id === "measuring" &&
            question.data.type === "rail-measure"
        ) {
            const location = turf.point([question.data.lng, question.data.lat]);

            const nearestTrainStation = turf.nearestPoint(
                location,
                turf.featureCollection(
                    stations.map((x) => x.properties.geometry),
                ),
            );

            const distance = await arcDistance(location, nearestTrainStation);

            const nearbyStations = await Promise.all(
                stations.map(
                    async (x) =>
                        (await arcDistance(
                            station.properties.geometry,
                            x.properties.geometry,
                        )) <
                        distance + 1.61 * hidingRadiusMiles,
                ),
            );
            const circles = stations
                .filter((_, index) => nearbyStations[index])
                .map((x) => turf.circle(x.properties.geometry, distance));

            if (question.data.hiderCloser) {
                mapData = safeUnion(
                    turf.featureCollection([
                        ...mapData.features,
                        holedMask(turf.featureCollection(circles)),
                    ]),
                );
            } else {
                mapData = safeUnion(
                    turf.featureCollection([...mapData.features, ...circles]),
                );
            }
        }
        if (
            question.id === "measuring" &&
            (question.data.type === "mcdonalds" ||
                question.data.type === "seven11")
        ) {
            const points = await findPlacesSpecificInZone(
                question.data.type === "mcdonalds"
                    ? QuestionSpecificLocation.McDonalds
                    : QuestionSpecificLocation.Seven11,
            );

            if (points.features.length === 0) {
                warnNoSpecificPlaces(question.data.type);
                continue;
            }

            const seeker = turf.point([question.data.lng, question.data.lat]);
            const nearest = turf.nearestPoint(seeker, points as any);

            const distance = await arcDistance(seeker, nearest, "miles");

            const nearStation = await Promise.all(
                points.features.map(
                    async (x) =>
                        (await arcDistance(
                            x as any,
                            station.properties.geometry,
                            "miles",
                        )) <
                        distance + hidingRadiusMiles,
                ),
            );
            const filtered = points.features.filter(
                (_, index) => nearStation[index],
            );

            const circles = filtered.map((x) =>
                turf.circle(x as any, distance, {
                    units: "miles",
                }),
            );

            if (question.data.hiderCloser) {
                mapData = safeUnion(
                    turf.featureCollection([
                        ...mapData.features,
                        holedMask(turf.featureCollection(circles)),
                    ]),
                );
            } else {
                mapData = safeUnion(
                    turf.featureCollection([...mapData.features, ...circles]),
                );
            }
        }

        if (mapData.type !== "FeatureCollection") {
            mapData = {
                type: "FeatureCollection",
                features: [mapData],
            };
        }
    }

    if (!isCurrent()) return;

    if (_.isEqual(mapData, BLANK_GEOJSON)) {
        toast.warning(
            "The hider cannot be in this hiding zone. This wasn't eliminated on the sidebar as its absence was caused by multiple criteria.",
        );
    }

    showGeoJSON(mapData);

    if (autoZoom.get()) {
        if (animateMapMovements.get()) {
            map?.flyToBounds(bounds);
        } else {
            map?.fitBounds(bounds);
        }
    }

    const element: HTMLDivElement | null = document.querySelector(
        `[data-station-id="${station.properties.properties.id}"]`,
    );

    if (element) {
        element.scrollIntoView({
            behavior: "smooth",
            block: "center",
        });
        element.classList.add("selected-card-background-temporary");

        setTimeout(() => {
            element.classList.remove("selected-card-background-temporary");
        }, 5000);
    }
}
