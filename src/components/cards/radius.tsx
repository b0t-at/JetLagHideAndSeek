import { useStore } from "@nanostores/react";
import { memo } from "react";

import { Input } from "@/components/ui/input";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UnitSelect } from "@/components/UnitSelect";
import { hiderMode, questionModified } from "@/lib/context";
import { cn } from "@/lib/utils";
import type { RadiusQuestion } from "@/maps/schema";

import {
    CardLatLng,
    QuestionCard,
    type QuestionCardProps,
    questionCardPropsEqual,
    ResultLabel,
    useQuestionIndex,
} from "./base";

const RadiusQuestionCard = ({
    data,
    questionKey,
    sub,
    className,
    index,
}: QuestionCardProps<RadiusQuestion>) => {
    const $hiderMode = useStore(hiderMode);
    const questionIndex = useQuestionIndex("radius", questionKey, index);
    const label = `Radius
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
            setHidden={(hidden) => questionModified((data.hidden = hidden))}
        >
            <SidebarMenuItem>
                <div className={cn(MENU_ITEM_CLASSNAME, "gap-2 flex flex-row")}>
                    <Input
                        type="number"
                        className="rounded-md p-2 w-16"
                        value={data.radius}
                        disabled={!data.drag}
                        onChange={(e) =>
                            questionModified(
                                (data.radius = parseFloat(e.target.value)),
                            )
                        }
                    />
                    <UnitSelect
                        unit={data.unit}
                        disabled={!data.drag}
                        onChange={(unit) =>
                            questionModified((data.unit = unit))
                        }
                    />
                </div>
            </SidebarMenuItem>
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
                <ResultLabel>Result</ResultLabel>
                <ToggleGroup
                    className="grow"
                    type="single"
                    value={data.within ? "inside" : "outside"}
                    onValueChange={(value: "inside" | "outside") =>
                        questionModified((data.within = value === "inside"))
                    }
                    disabled={!!$hiderMode || !data.drag}
                >
                    <ToggleGroupItem value="outside">Outside</ToggleGroupItem>
                    <ToggleGroupItem value="inside">Inside</ToggleGroupItem>
                </ToggleGroup>
            </div>
        </QuestionCard>
    );
};

export const RadiusQuestionComponent = memo(
    RadiusQuestionCard,
    questionCardPropsEqual,
);
