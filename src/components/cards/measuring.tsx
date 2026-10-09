import { useStore } from "@nanostores/react";
import { Label } from "@radix-ui/react-label";
import * as React from "react";
import { Suspense, use } from "react";

import CustomInitDialog from "@/components/CustomInitDialog";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    customInitPreference,
    displayHidingZones,
    drawingQuestionKey,
    hiderMode,
    questionModified,
    triggerLocalRefresh,
} from "@/lib/context";
import {
    determineMeasuringBoundary,
    findAdminZoneInfo,
} from "@/maps/questions/measuring";
import {
    DEFAULT_ADMIN_LEVEL,
    determineUnionizedStrings,
    type MeasuringQuestion,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

import {
    CardLatLng,
    QuestionCard,
    type QuestionCardProps,
    questionCardPropsEqual,
    ResultLabel,
    useQuestionIndex,
} from "./base";

const MeasuringQuestionCard = ({
    data,
    questionKey,
    sub,
    className,
    index,
}: QuestionCardProps<MeasuringQuestion>) => {
    const $hiderMode = useStore(hiderMode);
    const $displayHidingZones = useStore(displayHidingZones);
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $customInitPref = useStore(customInitPreference);
    const [customDialogOpen, setCustomDialogOpen] = React.useState(false);
    const questionIndex = useQuestionIndex("measuring", questionKey, index);
    const label = `Measuring
    ${questionIndex}`;

    let questionSpecific = <></>;

    switch (data.type) {
        case "admin-measure":
            questionSpecific = (
                <>
                    <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                        <Select
                            trigger="OSM Zone"
                            options={{
                                2: "OSM Zone 2 (Country)",
                                3: "OSM Zone 3 (region in Japan)",
                                4: "OSM Zone 4 (prefecture in Japan)",
                                5: "OSM Zone 5",
                                6: "OSM Zone 6",
                                7: "OSM Zone 7",
                                8: "OSM Zone 8",
                                9: "OSM Zone 9 (district in Vienna)",
                                10: "OSM Zone 10",
                            }}
                            value={(
                                (data as any).cat?.adminLevel ??
                                DEFAULT_ADMIN_LEVEL
                            ).toString()}
                            onValueChange={(value) => {
                                if (!(data as any).cat) {
                                    (data as any).cat = {
                                        adminLevel: DEFAULT_ADMIN_LEVEL,
                                    };
                                }
                                (data as any).cat.adminLevel = parseInt(
                                    value,
                                ) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
                                (data as any).cat.zoneName = undefined;
                                questionModified();
                            }}
                            disabled={!data.drag}
                        />
                    </SidebarMenuItem>
                    <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                        <Suspense
                            fallback={
                                <div className="flex items-center justify-center w-full h-[3rem]">
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
                            <AdminZoneNameDisplay data={data} />
                        </Suspense>
                    </SidebarMenuItem>
                </>
            );
            break;
        case "mcdonalds":
        case "seven11":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    This question will eliminate hiding zones that don&apos;t
                    fit the criteria. When you click on a zone, the parts of
                    that zone that don&apos;t satisfy the criteria will be
                    eliminated.
                </span>
            );
            break;
        case "aquarium":
        case "hospital":
        case "peak":
        case "museum":
        case "theme_park":
        case "zoo":
        case "cinema":
        case "library":
        case "golf_course":
        case "consulate":
        case "park":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    This question will only influence the map when you click on
                    a hiding zone in the hiding zone sidebar.
                </span>
            );
            break;
        case "custom-measure":
            if (data.drag) {
                questionSpecific = (
                    <>
                        {/* A label, so tapping the text toggles the checkbox */}
                        <label className="block px-2 mb-1 text-center text-orange-500">
                            To modify the measuring question, enable it:
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
                        </label>
                        <div className="flex justify-center mb-2">
                            <PresetsDialog
                                data={data}
                                presetTypeHint={data.type}
                            />
                        </div>
                    </>
                );
            }
            break;
    }

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
            <CustomInitDialog
                open={customDialogOpen}
                onOpenChange={setCustomDialogOpen}
                onBlank={async () => {
                    if (!(data as any).geo) {
                        (data as any).geo = {
                            type: "FeatureCollection",
                            features: [],
                        };
                    } else {
                        (data as any).geo.features = [];
                    }
                    data.type = "custom-measure";
                    questionModified();
                    setCustomDialogOpen(false);
                }}
                onPrefill={async () => {
                    const boundary = await determineMeasuringBoundary(data);
                    if (!(data as any).geo) {
                        (data as any).geo = {
                            type: "FeatureCollection",
                            features: [],
                        };
                    }
                    (data as any).geo.features = boundary ? boundary : [];
                    data.type = "custom-measure";
                    questionModified();
                    setCustomDialogOpen(false);
                }}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Measuring Type"
                    options={Object.fromEntries(
                        measuringQuestionSchema.options
                            .filter((x) => x.description === NO_GROUP)
                            .flatMap((x) =>
                                determineUnionizedStrings(x.shape.type),
                            )
                            .map((x) => [(x._def as any).value, x.description]),
                    )}
                    groups={measuringQuestionSchema.options
                        .filter((x) => x.description !== NO_GROUP)
                        .map((x) => [
                            x.description,
                            Object.fromEntries(
                                determineUnionizedStrings(x.shape.type).map(
                                    (x) => [
                                        (x._def as any).value,
                                        x.description,
                                    ],
                                ),
                            ),
                        ])
                        .reduce(
                            (acc, [key, value]) => {
                                const values = {
                                    disabled: !$displayHidingZones,
                                    options: value,
                                };

                                if (acc[key]) {
                                    acc[key].options = {
                                        ...acc[key].options,
                                        ...value,
                                    };
                                } else {
                                    acc[key] = values;
                                }

                                return acc;
                            },
                            {} as Record<
                                string,
                                {
                                    disabled: boolean;
                                    options: Record<string, string>;
                                }
                            >,
                        )}
                    value={data.type}
                    onValueChange={async (value) => {
                        if (value === "custom-measure") {
                            if ($customInitPref === "ask") {
                                setCustomDialogOpen(true);
                                return;
                            }
                            if ($customInitPref === "blank") {
                                if (!(data as any).geo) {
                                    (data as any).geo = {
                                        type: "FeatureCollection",
                                        features: [],
                                    };
                                } else {
                                    (data as any).geo.features = [];
                                }
                            } else if ($customInitPref === "prefill") {
                                const boundary =
                                    await determineMeasuringBoundary(data);
                                if (!(data as any).geo) {
                                    (data as any).geo = {
                                        type: "FeatureCollection",
                                        features: [],
                                    };
                                }
                                (data as any).geo.features = boundary
                                    ? boundary
                                    : [];
                            }
                            data.type = value;
                            questionModified();
                            return;
                        }
                        if (value === "admin-measure" && !(data as any).cat) {
                            (data as any).cat = {
                                adminLevel: DEFAULT_ADMIN_LEVEL,
                            };
                        }
                        data.type = value;
                        questionModified();
                    }}
                    disabled={!data.drag}
                />
            </SidebarMenuItem>
            {questionSpecific}
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
            <div className="flex gap-2 items-center p-2">
                <ResultLabel unstyled>Result</ResultLabel>
                <ToggleGroup
                    className="grow"
                    type="single"
                    value={data.hiderCloser ? "closer" : "further"}
                    onValueChange={(value: "closer" | "further") =>
                        questionModified(
                            (data.hiderCloser = value === "closer"),
                        )
                    }
                    disabled={!!$hiderMode || !data.drag}
                >
                    <ToggleGroupItem value="further">
                        Hider Further
                    </ToggleGroupItem>
                    <ToggleGroupItem value="closer">
                        Hider Closer
                    </ToggleGroupItem>
                </ToggleGroup>
            </div>
        </QuestionCard>
    );
};

export const MeasuringQuestionComponent = React.memo(
    MeasuringQuestionCard,
    questionCardPropsEqual,
);

const AdminZoneNameDisplay = ({ data }: { data: MeasuringQuestion }) => {
    useStore(triggerLocalRefresh);

    const adminLevel = (data as any).cat?.adminLevel ?? DEFAULT_ADMIN_LEVEL;
    const zoneInfo = use(findAdminZoneInfo(data.lat, data.lng, adminLevel));

    // Update the zone name in the data
    if (
        zoneInfo &&
        (data as any).cat &&
        (data as any).cat.zoneName !== zoneInfo.name
    ) {
        (data as any).cat.zoneName = zoneInfo.name;
        questionModified();
    }

    if (!zoneInfo) {
        return (
            <div className="flex items-center justify-center w-full h-[3rem] text-muted-foreground text-sm">
                No zone found
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center w-full h-[3rem]">
            <Label className="text-xs text-muted-foreground">Zone</Label>
            <span className="font-medium text-sm truncate max-w-full">
                {zoneInfo.name}
            </span>
        </div>
    );
};
