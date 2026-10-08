import { determineCache } from "./cache";
import { CacheType } from "./types";
import vienna from "./vienna-data.json";

// Computed geometry kept across reloads and tab restores. It lives in the question cache,
// so it is cleared together with the Overpass answers it may be derived from.

// Bump when a persisted computation (or coastline50.geojson) changes its result
const GEOMETRY_CACHE_VERSION = 1;
// The bundled data files carry content hashes in their names
const DATA_VERSION = JSON.stringify(vienna.files);

interface StoredGeometry<T> {
    key: string;
    value: T;
    extra?: Record<string, unknown>;
}

const versionedKey = (key: string) =>
    `${GEOMETRY_CACHE_VERSION}\n${DATA_VERSION}\n${key}`;

const geometryUrl = async (fullKey: string) => {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(fullKey),
    );
    const hex = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("");
    // Any URL of this origin; the entry is never fetched
    return `${location.origin}/jlhs-geometry-cache/${hex}`;
};

/** A geometry stored under this key, or null (also when storage is unavailable) */
export const readGeometryCache = async <T>(
    key: string,
): Promise<{ value: T; extra?: Record<string, unknown> } | null> => {
    try {
        const fullKey = versionedKey(key);
        const cache = await determineCache(CacheType.CACHE);
        const response = await cache.match(await geometryUrl(fullKey));
        if (!response?.ok) return null;

        const stored: StoredGeometry<T> = await response.json();
        // Guards against hash collisions and foreign entries
        if (stored.key !== fullKey) return null;
        return { value: stored.value, extra: stored.extra };
    } catch {
        return null;
    }
};

/** Stores a geometry; failures (no storage, quota) are ignored */
export const writeGeometryCache = async <T>(
    key: string,
    value: T,
    extra?: Record<string, unknown>,
) => {
    try {
        const fullKey = versionedKey(key);
        // Serialized right away, before the caller can change the objects
        const stored: StoredGeometry<T> = { key: fullKey, value, extra };
        const body = JSON.stringify(stored);
        const cache = await determineCache(CacheType.CACHE);
        await cache.put(
            await geometryUrl(fullKey),
            new Response(body, {
                headers: { "Content-Type": "application/json" },
            }),
        );
    } catch {
        // Only a cache; the geometry is computed again next time
    }
};
