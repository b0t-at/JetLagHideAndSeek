import { atom } from "nanostores";
import * as React from "react";

const MOBILE_BREAKPOINT = 768;
// Two docked sidebars take 2 x 16rem. Below this width (e.g. an iPad in
// portrait or in Split View) the map between them is so narrow that its
// overlays cover the sidebar triggers, so only one may be open there.
const SINGLE_SIDEBAR_BREAKPOINT = 1024;
const SINGLE_SIDEBAR_QUERY = `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${SINGLE_SIDEBAR_BREAKPOINT - 1}px)`;

export function useIsMobile() {
    const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
        undefined,
    );

    React.useEffect(() => {
        const mql = window.matchMedia(
            `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
        );
        const onChange = () => {
            setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
        };
        mql.addEventListener("change", onChange);
        setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    return !!isMobile;
}

type DockedSidebarSide = "left" | "right";

// The docked sidebar that was opened last, as long as it stays open
const lastOpenedSidebar = atom<DockedSidebarSide | null>(null);

/**
 * Records a new open state of a docked sidebar. Opening one closes the other
 * one while the viewport is in the single sidebar range (see
 * useSingleDockedSidebar).
 */
export function noteDockedSidebarOpen(side: DockedSidebarSide, open: boolean) {
    if (open) {
        lastOpenedSidebar.set(side);
    } else if (lastOpenedSidebar.get() === side) {
        lastOpenedSidebar.set(null);
    }
}

/**
 * Keeps at most one docked sidebar open between the mobile breakpoint and
 * SINGLE_SIDEBAR_BREAKPOINT. This sidebar closes when the other one opens, or
 * when the viewport enters that range (e.g. an iPad rotated to portrait)
 * while the other one was opened after it.
 */
export function useSingleDockedSidebar(
    side: DockedSidebarSide,
    open: boolean,
    setOpen: (open: boolean) => void,
) {
    const openRef = React.useRef(open);
    React.useEffect(() => {
        openRef.current = open;
    }, [open]);

    React.useEffect(() => {
        const mql = window.matchMedia(SINGLE_SIDEBAR_QUERY);
        // Not gated on this sidebar being open: Cmd/Ctrl+B toggles both
        // sidebars in one event, before either has re-rendered
        const unlisten = lastOpenedSidebar.listen((last) => {
            if (mql.matches && last !== null && last !== side) {
                setOpen(false);
            }
        });
        const onChange = () => {
            const last = lastOpenedSidebar.get();
            if (
                mql.matches &&
                openRef.current &&
                last !== null &&
                last !== side
            ) {
                setOpen(false);
            }
        };
        mql.addEventListener("change", onChange);
        return () => {
            unlisten();
            mql.removeEventListener("change", onChange);
        };
    }, [side, setOpen]);
}
