// Registers the service worker that @vite-pwa/astro generates (astro.config.mjs).
// It precaches the app shell, so the app starts without waiting for the network
// and also starts offline.
//
// Updates: the browser looks for a new sw.js on every start; an app that stays open
// also asks every 30 minutes and when it comes back to the foreground (at most every
// 10 minutes). A new deploy installs in the background and then waits, while the
// page keeps running on the version it started with (its files stay cached). The new
// version takes over by itself once the app has been closed. This page switches to
// it (with a reload) by itself only right after the start, before any input, and
// never while autoSave is off and changes are unsaved. Otherwise a toast offers the
// reload: open dialogs, a selected hiding zone or the map view live only in memory.

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
const MIN_UPDATE_CHECK_GAP = 10 * 60 * 1000;
// A reload this soon after the start, before any input, only repeats the start
const STARTUP_WINDOW = 10 * 1000;
const TOAST_ID = "app-update";

// With autoSave off, question and hider marker edits live only in memory until the
// player presses Save
const hasUnsavedChanges = async () => {
    try {
        const { autoSave, hiderMode, questions } = await import(
            "@/lib/context"
        );
        if (autoSave.get()) return false;
        const { questionsSchema } = await import("@/maps/schema");
        const stored = (key: string, fallback: string) =>
            JSON.parse(localStorage.getItem(key) ?? fallback);
        return (
            JSON.stringify(questions.get()) !==
                JSON.stringify(
                    questionsSchema.parse(stored("questions", "[]")),
                ) ||
            JSON.stringify(hiderMode.get()) !==
                JSON.stringify(stored("isHiderMode", "false"))
        );
    } catch {
        return true;
    }
};

if ("serviceWorker" in navigator) {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");

    let interacted = false;
    const interactions = ["pointerdown", "keydown", "wheel"];
    const onInteraction = () => {
        interacted = true;
        for (const type of interactions)
            window.removeEventListener(type, onInteraction, true);
    };
    for (const type of interactions)
        window.addEventListener(type, onInteraction, {
            capture: true,
            passive: true,
        });

    // Switches this page to the new version, once one is ready
    let pendingUpdate: (() => void) | null = null;

    const applyUpdate = () => {
        const update = pendingUpdate;
        if (!update) return;
        pendingUpdate = null;
        import("react-toastify").then(({ toast }) => toast.dismiss(TOAST_ID));
        update();
    };

    const applyUpdateIfSafe = async () => {
        if (!pendingUpdate) return false;
        if (interacted || performance.now() >= STARTUP_WINDOW) return false;
        if (await hasUnsavedChanges()) return false;
        applyUpdate();
        return true;
    };

    const offerUpdate = async (update: () => void) => {
        if (pendingUpdate) return;
        pendingUpdate = update;
        if (await applyUpdateIfSafe()) return;

        const { toast } = await import("react-toastify");
        toast.info("A new version is available. Tap to reload.", {
            toastId: TOAST_ID,
            autoClose: false,
            closeOnClick: false,
            onClick: async () => {
                if (
                    (await hasUnsavedChanges()) &&
                    !window.confirm(
                        "Reloading discards your unsaved changes. Reload anyway?",
                    )
                ) {
                    return;
                }
                applyUpdate();
            },
        });
    };

    // The first install also takes control of the page (clientsClaim); that needs
    // no reload
    let controlled = !!navigator.serviceWorker.controller;
    let reloadOnTakeover = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadOnTakeover) {
            window.location.reload();
        } else if (controlled) {
            // Another tab applied an update, so this page's files may be gone from
            // the cache; a plain reload replaces whatever update was pending
            pendingUpdate = null;
            offerUpdate(() => window.location.reload());
        }
        controlled = true;
    });

    // After the load event, so precaching does not compete with the first start
    window.addEventListener("load", async () => {
        try {
            const registration = await navigator.serviceWorker.register(
                `${base}/sw.js`,
                { scope: `${base}/` },
            );

            const offerWaiting = () => {
                // Without a controller this is the first install, which activates
                // by itself
                if (
                    !registration.waiting ||
                    !navigator.serviceWorker.controller
                )
                    return;
                offerUpdate(() => {
                    // Looked up now, not when offered: a later deploy may have
                    // replaced the worker, or another tab already activated it
                    const waiting = registration.waiting;
                    if (waiting) {
                        reloadOnTakeover = true;
                        waiting.postMessage({ type: "SKIP_WAITING" });
                    } else {
                        window.location.reload();
                    }
                });
            };
            offerWaiting();
            registration.addEventListener("updatefound", () => {
                const installing = registration.installing;
                installing?.addEventListener("statechange", () => {
                    if (installing.state === "installed") offerWaiting();
                });
            });

            let lastCheck = Date.now();
            const checkForUpdate = () => {
                if (!navigator.onLine || registration.installing) return;
                if (Date.now() - lastCheck < MIN_UPDATE_CHECK_GAP) return;
                lastCheck = Date.now();
                registration.update().catch(() => {});
            };
            setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL);
            // Phones pause timers in the background
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") checkForUpdate();
            });
        } catch (e) {
            console.log("Service worker registration failed", e);
        }
    });
}
