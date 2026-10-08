import { useStore } from "@nanostores/react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { EyeIcon, EyeOffIcon, LockIcon, UnlockIcon } from "lucide-react";
import { atom } from "nanostores";
import { type ComponentProps, useRef, useState } from "react";
import { VscChevronDown, VscShare, VscTrash } from "react-icons/vsc";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
} from "@/components/ui/sidebar-l";
import { isLoading, questions, triggerLocalRefresh } from "@/lib/context";
import { cn } from "@/lib/utils";
import type { Question, Questions } from "@/maps/schema";

/**
 * Props shared by the question cards. QuestionSidebar also passes `index` (the
 * card's number among questions of its type) and `snapshot` (the serialized
 * question data), so a card only re-renders when its own question changes.
 * Other callers (marker popups, the tutorial) leave them out and the card
 * subscribes to the questions itself, as before.
 */
export type QuestionCardProps<T> = {
    data: T;
    questionKey: number;
    sub?: string;
    className?: string;
    index?: number;
    snapshot?: string;
};

/**
 * React.memo comparator for the cards. The question data is mutated in place,
 * so without a snapshot the card always re-renders, like an unmemoized one.
 */
export const questionCardPropsEqual = (
    prev: QuestionCardProps<unknown>,
    next: QuestionCardProps<unknown>,
) =>
    next.snapshot !== undefined &&
    prev.snapshot === next.snapshot &&
    prev.data === next.data &&
    prev.questionKey === next.questionKey &&
    prev.index === next.index &&
    prev.sub === next.sub &&
    prev.className === next.className;

const NO_QUESTIONS = atom<Questions>([]);
const NO_REFRESH = atom<number>(0);

/** The number shown in a card's label ("Radius 2") */
export const useQuestionIndex = (
    id: Question["id"],
    questionKey: number,
    index: number | undefined,
    { refresh = true }: { refresh?: boolean } = {},
) => {
    const standalone = index === undefined;
    const $questions = useStore(standalone ? questions : NO_QUESTIONS);
    useStore(standalone && refresh ? triggerLocalRefresh : NO_REFRESH);
    if (!standalone) return index;
    return (
        $questions
            .filter((q) => q.id === id)
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    );
};

/**
 * Disables every native control inside while the map is refreshing. Only this
 * element re-renders when isLoading flips, not the whole card.
 */
export const LoadingFieldset = ({
    children,
    className,
}: {
    children: React.ReactNode;
    className?: string;
}) => {
    const $isLoading = useStore(isLoading);

    return (
        <fieldset disabled={$isLoading} className={cn("min-w-0", className)}>
            {children}
        </fieldset>
    );
};

/** The "Result" label of a card, muted while the map is refreshing */
export const ResultLabel = ({
    children,
    className,
    unstyled = false,
}: {
    children: React.ReactNode;
    className?: string;
    /** Use the bare Radix label instead of the styled ui/label */
    unstyled?: boolean;
}) => {
    const $isLoading = useStore(isLoading);
    const LabelComponent = unstyled ? LabelPrimitive.Root : Label;

    return (
        <LabelComponent
            className={cn(
                "font-semibold text-lg",
                $isLoading && "text-muted-foreground",
                className,
            )}
        >
            {children}
        </LabelComponent>
    );
};

/**
 * LatitudeLongitude that is also disabled while the map is refreshing. Its edit
 * dialog renders in a portal, outside the card's LoadingFieldset.
 */
export const CardLatLng = (props: ComponentProps<typeof LatitudeLongitude>) => {
    const $isLoading = useStore(isLoading);

    return (
        <LatitudeLongitude {...props} disabled={props.disabled || $isLoading} />
    );
};

export const QuestionCard = ({
    children,
    questionKey,
    className,
    label,
    sub,
    collapsed,
    locked,
    hidden,
    setLocked,
    setHidden,
    setCollapsed,
}: {
    children: React.ReactNode;
    questionKey: number;
    className?: string;
    label?: string;
    sub?: string;
    collapsed?: boolean;
    locked?: boolean;
    hidden?: boolean;
    setLocked?: (locked: boolean) => void;
    setHidden?: (hidden: boolean) => void;
    setCollapsed?: (collapsed: boolean) => void;
}) => {
    const [isCollapsed, setIsCollapsed] = useState(collapsed ?? false);

    const toggleCollapse = () => {
        if (setCollapsed) {
            setCollapsed(!isCollapsed);
        }
        setIsCollapsed((prevState) => !prevState);
    };

    return (
        <>
            <SidebarGroup className={className}>
                <div className="relative">
                    <button
                        onClick={toggleCollapse}
                        className={cn(
                            "absolute top-2 left-2 text-white border rounded-md transition-all duration-500",
                            isCollapsed && "-rotate-90",
                        )}
                    >
                        <VscChevronDown />
                    </button>
                    <SidebarGroupLabel
                        className="ml-8 mr-8 cursor-pointer"
                        onClick={toggleCollapse}
                    >
                        {label} {sub && `(${sub})`}
                    </SidebarGroupLabel>
                    <SidebarGroupContent
                        className={cn(
                            "overflow-hidden transition-all duration-1000 max-h-[100rem]", // 100rem is arbitrary
                            isCollapsed && "max-h-0",
                        )}
                    >
                        <LoadingFieldset>
                            <SidebarMenu>{children}</SidebarMenu>
                        </LoadingFieldset>
                        <div className="flex gap-2 pt-2 px-2 justify-center">
                            <Dialog>
                                <DialogTrigger asChild>
                                    <Button variant="outline" size="sm">
                                        <VscShare />
                                    </Button>
                                </DialogTrigger>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle className="text-2xl">
                                            Share this Question!
                                        </DialogTitle>
                                        <DialogDescription>
                                            Below you can access the JSON
                                            representing the question. Send this
                                            to another player for them to copy.
                                            They can then click &ldquo;Paste
                                            Question&rdquo; at the bottom of the
                                            &ldquo;Questions&rdquo; sidebar.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <ShareQuestionBody
                                        questionKey={questionKey}
                                    />
                                </DialogContent>
                            </Dialog>
                            <LoadingFieldset className="flex gap-2">
                                <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                        <Button variant="outline" size="sm">
                                            <VscTrash />
                                        </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>
                                                Are you absolutely sure?
                                            </AlertDialogTitle>
                                            <AlertDialogDescription>
                                                This action cannot be undone.
                                                This will permanently delete the
                                                question.
                                            </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                            <AlertDialogCancel>
                                                Cancel
                                            </AlertDialogCancel>
                                            <AlertDialogAction
                                                onClick={() => {
                                                    questions.set([]);
                                                }}
                                            >
                                                Delete All Questions
                                            </AlertDialogAction>
                                            <AlertDialogAction
                                                onClick={() => {
                                                    questions.set(
                                                        questions
                                                            .get()
                                                            .filter(
                                                                (q) =>
                                                                    q.key !==
                                                                    questionKey,
                                                            ),
                                                    );
                                                }}
                                                className="mb-2 sm:mb-0"
                                            >
                                                Delete Question
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                                {locked !== undefined && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setLocked!(!locked)}
                                    >
                                        {locked ? <LockIcon /> : <UnlockIcon />}
                                    </Button>
                                )}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setHidden!(!hidden)}
                                >
                                    {hidden ? <EyeOffIcon /> : <EyeIcon />}
                                </Button>
                            </LoadingFieldset>
                        </div>
                    </SidebarGroupContent>
                </div>
            </SidebarGroup>
            <Separator className="h-1" />
        </>
    );
};

/** Rendered only while the share dialog is open */
const ShareQuestionBody = ({ questionKey }: { questionKey: number }) => {
    const $questions = useStore(questions);
    const copyButtonRef = useRef<HTMLButtonElement>(null);

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                className="mb-2 sm:mb-0 transition-colors"
                ref={copyButtonRef}
                onClick={() => {
                    navigator.clipboard
                        .writeText(
                            JSON.stringify(
                                questions
                                    .get()
                                    .find((q) => q.key === questionKey),
                                null,
                                4,
                            ),
                        )
                        .then(() => {
                            if (copyButtonRef.current) {
                                copyButtonRef.current.textContent = "Copied!";
                                copyButtonRef.current.classList.add(
                                    "bg-green-500",
                                );
                                setTimeout(() => {
                                    if (copyButtonRef.current) {
                                        copyButtonRef.current.textContent =
                                            "Copy to Clipboard";
                                        copyButtonRef.current.classList.remove(
                                            "bg-green-500",
                                        );
                                    }
                                }, 2000);
                            }
                        })
                        .catch(() => {
                            if (copyButtonRef.current) {
                                copyButtonRef.current.textContent =
                                    "Failed to Copy";
                                copyButtonRef.current.classList.add(
                                    "bg-red-500",
                                );
                                setTimeout(() => {
                                    if (copyButtonRef.current) {
                                        copyButtonRef.current.textContent =
                                            "Copy to Clipboard";
                                        copyButtonRef.current.classList.remove(
                                            "bg-red-500",
                                        );
                                    }
                                }, 2000);
                            }
                        });
                }}
            >
                Copy to Clipboard
            </Button>
            <textarea
                className="w-full h-[300px] bg-slate-900 text-white rounded-md p-2"
                readOnly
                value={JSON.stringify(
                    $questions.find((q) => q.key === questionKey),
                    null,
                    4,
                )}
            ></textarea>
        </>
    );
};
