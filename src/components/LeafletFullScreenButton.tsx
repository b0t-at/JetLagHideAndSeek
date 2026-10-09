import { useStore } from "@nanostores/react";
import { DomEvent } from "leaflet";
import { atom } from "nanostores";
import { useEffect, useRef, useState } from "react";
import { AiOutlineFullscreen, AiOutlineFullscreenExit } from "react-icons/ai";

/** Whether the map covers the viewport through CSS instead of the Fullscreen API */
export const pseudoFullScreen = atom(false);

/**
 * iPadOS Safari leaves real fullscreen on a downward swipe or when a text field
 * gets focus, and interrupts brisk tapping with a "typing in full screen" alert;
 * before 16.4 it only has the prefixed API. So touch devices, and browsers
 * without element fullscreen, get a CSS stand-in that covers the viewport
 */
const needsPseudoFullScreen = (element: HTMLElement) =>
    window.matchMedia("(pointer: coarse)").matches ||
    !document.fullscreenEnabled ||
    typeof element.requestFullscreen !== "function";

export const LeafletFullScreenButton = () => {
    const $pseudoFullScreen = useStore(pseudoFullScreen);
    const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
    const buttonRef = useRef<HTMLAnchorElement>(null);

    useEffect(() => {
        // Also when fullscreen is left with Esc
        const handleFullscreenChange = () =>
            setIsFullScreen(!!document.fullscreenElement);

        document.addEventListener("fullscreenchange", handleFullscreenChange);

        return () => {
            document.removeEventListener(
                "fullscreenchange",
                handleFullscreenChange,
            );
        };
    }, []);

    useEffect(() => {
        // The button sits inside the map container, which would otherwise get
        // its touchstart: while drawing, leaflet-draw adds a vertex under it
        if (buttonRef.current) {
            DomEvent.disableClickPropagation(buttonRef.current);
        }
    }, []);

    return (
        <a
            ref={buttonRef}
            className="leaflet-full-screen-specific-name bg-white hover:bg-[#f4f4f4] w-[30px] h-[30px] rounded-sm leading-[30px] text-[22px] flex items-center justify-center border-2 border-black border-opacity-30 cursor-pointer"
            onClick={() => {
                const dialogContainer: HTMLDivElement | null =
                    document.querySelector(
                        "#map-modal-dialog-container-leaflet",
                    );

                if (pseudoFullScreen.get()) {
                    pseudoFullScreen.set(false);
                } else if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else if (dialogContainer) {
                    if (needsPseudoFullScreen(dialogContainer)) {
                        pseudoFullScreen.set(true);
                    } else {
                        dialogContainer.requestFullscreen();
                    }
                }
            }}
        >
            {isFullScreen || $pseudoFullScreen ? (
                <AiOutlineFullscreenExit className="w-6 h-6 text-black" />
            ) : (
                <AiOutlineFullscreen className="w-6 h-6 text-black" />
            )}
        </a>
    );
};
