import { useStore } from "@nanostores/react";
import * as React from "react";
import { createPortal } from "react-dom";

import { Sidebar, SidebarContext } from "@/components/ui/sidebar-l";
import { useTutorialStep } from "@/hooks/use-tutorial-step";
import { cn } from "@/lib/utils";

// Same as SIDEBAR_TUTORIAL_STEPS in ui/sidebar-l.tsx
const SIDEBAR_TUTORIAL_STEPS = [6];
const SIDEBAR_WIDTH_MOBILE = "18rem";
// Slide-out duration of the panel (duration-300 below)
const CLOSE_TRANSITION_MS = 300;

const NEVER = new Promise<never>(() => {});

/**
 * While frozen, suspends so the Suspense boundary above hides the children
 * and keeps their state. React does not re-render the hidden children on
 * store changes until they are unfrozen; then each re-renders once with the
 * latest values. NEVER is one shared promise, so React keeps a single retry
 * listener on it per boundary instead of adding one per close.
 *
 * TODO: replace with <Activity mode="hidden"> once React is 19.2 or newer.
 */
const Freeze = ({
    frozen,
    children,
}: {
    frozen: boolean;
    children: React.ReactNode;
}) => {
    if (frozen) throw NEVER;
    return children;
};

/**
 * The questions sidebar. On desktop this is the regular Sidebar. On phones the
 * Sidebar is a Radix Sheet, which unmounts its content on every close, so each
 * open had to mount every question card again. Here the phone panel is mounted
 * on the first open and then only slides in and out. While it is closed, its
 * content is frozen, so edits made on the map do not re-render the cards.
 */
export const QuestionSidebarShell = ({
    children,
}: {
    children: React.ReactNode;
}) => {
    const { isMobile } = useStore(SidebarContext);

    if (!isMobile) return <Sidebar>{children}</Sidebar>;
    return <MobileQuestionPanel>{children}</MobileQuestionPanel>;
};

const MobileQuestionPanel = ({ children }: { children: React.ReactNode }) => {
    const { openMobile, setOpenMobile } = useStore(SidebarContext);
    const open = useTutorialStep(openMobile, SIDEBAR_TUTORIAL_STEPS);
    // Mounted on the first open (so page load does not pay for the cards),
    // then kept. `ready` is set a frame after mounting, so the first open
    // slides in from the closed position like the later ones.
    const [mounted, setMounted] = React.useState(open);
    const [ready, setReady] = React.useState(false);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const shown = open && ready;
    // Frozen once the slide-out has finished, unfrozen as soon as it opens
    const [closedSettled, setClosedSettled] = React.useState(false);
    const frozen = closedSettled && !open;

    if (open && !mounted) setMounted(true);

    React.useEffect(() => {
        if (!mounted || ready) return;
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => setReady(true));
        });
        return () => cancelAnimationFrame(frame);
    }, [mounted, ready]);

    React.useEffect(() => {
        if (shown) {
            setClosedSettled(false);
            return;
        }
        const timeout = setTimeout(
            () => setClosedSettled(true),
            CLOSE_TRANSITION_MS,
        );
        return () => clearTimeout(timeout);
    }, [shown]);

    // Escape closes the panel, unless a dialog or popover inside handled it
    // (Radix layers call preventDefault when they close on Escape)
    React.useEffect(() => {
        if (!shown) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
                setOpenMobile(false);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [shown, setOpenMobile]);

    // Move focus into the panel while it is open and give it back on close
    React.useEffect(() => {
        const panel = panelRef.current;
        if (!shown || !panel) return;
        const previous = document.activeElement;
        panel.focus({ preventScroll: true });
        return () => {
            const active = document.activeElement;
            if (
                previous instanceof HTMLElement &&
                previous.isConnected &&
                (!active || active === document.body || panel.contains(active))
            ) {
                previous.focus({ preventScroll: true });
            }
        };
    }, [shown]);

    if (!mounted) return null;

    return createPortal(
        <>
            <div
                aria-hidden
                className={cn(
                    "fixed inset-0 z-[1031] bg-black/80 transition-[opacity,visibility] duration-300",
                    shown ? "visible opacity-100" : "invisible opacity-0",
                )}
                onClick={() => setOpenMobile(false)}
            />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal={shown}
                aria-label="Questions"
                tabIndex={-1}
                inert={!shown}
                data-state={shown ? "open" : "closed"}
                data-sidebar="sidebar"
                data-mobile="true"
                className={cn(
                    "fixed inset-y-0 left-0 z-[1035] h-full w-full border-r bg-sidebar p-0 text-sidebar-foreground shadow-lg outline-none transition-[transform,visibility] ease-in-out sm:max-w-sm",
                    shown
                        ? "visible translate-x-0 duration-500"
                        : "invisible -translate-x-full duration-300",
                )}
                style={
                    {
                        "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
                    } as React.CSSProperties
                }
            >
                <div className="flex h-full w-full flex-col">
                    <React.Suspense fallback={null}>
                        <Freeze frozen={frozen}>{children}</Freeze>
                    </React.Suspense>
                </div>
            </div>
        </>,
        document.body,
    );
};
