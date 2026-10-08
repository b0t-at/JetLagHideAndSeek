import type { Position } from "geojson";
import * as L from "leaflet";

import type { StationCircle, StationPlace } from "@/maps/api";
import { extractStationName, lngLatToText } from "@/maps/geo-utils";

/**
 * Draws the hiding zones on canvas renderers in their own panes.
 *
 * - The layers are cached per map, so a redraw with the same zones is skipped and
 *   toggling a station only adds or removes that station's layers.
 * - "No Overlap" no longer computes a polygon union: the circles are filled opaquely
 *   in a pane whose CSS opacity gives the translucent look (so overlaps don't darken),
 *   and the outline of the union is drawn by a canvas that strokes every circle and
 *   then erases the inside of every circle.
 */

export type HidingZoneStyle =
    | "zones"
    | "stations"
    | "no-overlap"
    | "no-display";

const ZONE_PANE = "hidingZones";
const FILL_PANE = "hidingZonesFill";
const OUTLINE_PANE = "hidingZonesOutline";

const COLOR = "green";
const FILL_OPACITY = 0.2;
/** Leaflet's default path weight; the outline canvas only keeps the outer half of its strokes */
const WEIGHT = 3;

/** Above this many stations the "All Stations" style draws canvas dots instead of DOM icons */
const STATION_ICON_LIMIT = 250;

const TRAIN_ICON_HTML = `<div class="text-black bg-opacity-0"><svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg"><path d="M96 0C43 0 0 43 0 96L0 352c0 48 35.2 87.7 81.1 94.9l-46 46C28.1 499.9 33.1 512 43 512l39.7 0c8.5 0 16.6-3.4 22.6-9.4L160 448l128 0 54.6 54.6c6 6 14.1 9.4 22.6 9.4l39.7 0c10 0 15-12.1 7.9-19.1l-46-46c46-7.1 81.1-46.9 81.1-94.9l0-256c0-53-43-96-96-96L96 0zM64 96c0-17.7 14.3-32 32-32l256 0c17.7 0 32 14.3 32 32l0 96c0 17.7-14.3 32-32 32L96 224c-17.7 0-32-14.3-32-32l0-96zM224 288a48 48 0 1 1 0 96 48 48 0 1 1 0-96z"></path></svg></div>`;

let trainIcon: L.DivIcon | null = null;

/** Canvas that strokes every path, then erases the inside of every path: what is left is the outline of their union */
const canvasProto = L.Canvas.prototype as any;
const OutlineCanvas: new (options: L.RendererOptions) => L.Canvas =
    L.Canvas.extend({
        _draw(this: any) {
            this._outlinePass = "stroke";
            canvasProto._draw.call(this);
            this._outlinePass = "erase";
            canvasProto._draw.call(this);
            this._outlinePass = undefined;
        },
        _fillStroke(this: any, ctx: CanvasRenderingContext2D, layer: L.Path) {
            if (this._outlinePass === "erase") {
                ctx.globalCompositeOperation = "destination-out";
                ctx.globalAlpha = 1;
                ctx.fill();
                ctx.globalCompositeOperation = "source-over";
            } else {
                canvasProto._fillStroke.call(this, ctx, layer);
            }
        },
    });

interface DrawnZones {
    key: string;
    style: HidingZoneStyle;
    group: L.FeatureGroup;
    byId: Map<string, L.Layer[]>;
    circlesById: Map<string, StationCircle[]>;
    disabled: Set<string>;
}

interface MapState {
    zoneRenderer: L.Canvas;
    fillRenderer: L.Canvas;
    outlineRenderer: L.Canvas;
    drawn: DrawnZones | null;
    /** Whether the drawn zones take taps (zone selection, station popups) */
    interactive: boolean;
    /** leaflet-draw's edit or delete mode is on: taps must reach the drawn shapes below */
    drawToolActive: boolean;
}

const states = new WeakMap<L.Map, MapState>();

const createPane = (map: L.Map, name: string, zIndex: number) => {
    const pane = map.getPane(name) ?? map.createPane(name);
    // Above the overlay pane (400, question and elimination layers) and below markers (600)
    pane.style.zIndex = String(zIndex);
    return pane;
};

/**
 * The zone canvas covers the whole map above the overlay pane, so it only takes pointer
 * events while it has something to tap and leaflet-draw isn't editing or deleting shapes
 */
const updatePointerEvents = (map: L.Map, state: MapState) => {
    const pane = map.getPane(ZONE_PANE);
    if (pane) {
        pane.style.pointerEvents =
            state.interactive && !state.drawToolActive ? "" : "none";
    }
};

const getState = (map: L.Map): MapState => {
    let state = states.get(map);
    if (state) return state;

    createPane(map, ZONE_PANE, 410);
    const fillPane = createPane(map, FILL_PANE, 410);
    fillPane.style.opacity = String(FILL_OPACITY);
    fillPane.style.pointerEvents = "none";
    createPane(map, OUTLINE_PANE, 411).style.pointerEvents = "none";

    state = {
        zoneRenderer: L.canvas({ pane: ZONE_PANE }),
        fillRenderer: L.canvas({ pane: FILL_PANE }),
        outlineRenderer: new OutlineCanvas({ pane: OUTLINE_PANE }),
        drawn: null,
        interactive: false,
        drawToolActive: false,
    };
    states.set(map, state);

    const setDrawToolActive = (active: boolean) => () => {
        state!.drawToolActive = active;
        updatePointerEvents(map, state!);
    };
    map.on("draw:editstart draw:deletestart", setDrawToolActive(true));
    map.on("draw:editstop draw:deletestop", setDrawToolActive(false));

    return state;
};

const setZonePaneInteractive = (
    map: L.Map,
    state: MapState,
    interactive: boolean,
) => {
    state.interactive = interactive;
    updatePointerEvents(map, state);
};

const stationId = (circle: StationCircle) =>
    circle.properties.properties.id as string;

const toLatLngs = (ring: Position[]) =>
    ring.map(([lng, lat]) => L.latLng(lat, lng));

const stationPopup = (place: StationPlace) => () =>
    `<b>${extractStationName(place) || "No Name Found"} (${lngLatToText(
        place.geometry.coordinates as [number, number],
    )})</b>`;

/** Identifies the drawn zones: station ids and names (for the popups) plus the first vertex of each circle (depends on center, radius and units) */
const zonesKey = (stations: StationCircle[]) => {
    let key = `${stations.length}`;
    for (const circle of stations) {
        const first = circle.geometry.coordinates[0]?.[0];
        key += `|${stationId(circle)}@${first?.[0]},${first?.[1]}:${extractStationName(circle.properties)}`;
    }
    return key;
};

/** Removes every hiding-zone layer (including ones drawn by an older version of this code) */
export const clearHidingZones = (map: L.Map) => {
    const state = states.get(map);
    if (state) {
        state.drawn = null;
        setZonePaneInteractive(map, state, false);
    }

    map.eachLayer((layer: any) => {
        if (layer.hidingZones) {
            map.removeLayer(layer);
        }
    });
};

const addFlaggedGroup = (map: L.Map, group: L.FeatureGroup) => {
    // @ts-expect-error This is intentionally added as a check
    group.hidingZones = true;
    group.addTo(map);
};

const buildStationLayers = (
    state: MapState,
    circle: StationCircle,
    style: HidingZoneStyle,
    useIcons: boolean,
    onZoneClick: (id: string) => void,
): L.Layer[] => {
    const id = stationId(circle);

    switch (style) {
        case "zones": {
            const polygon = L.polygon(
                toLatLngs(circle.geometry.coordinates[0]),
                {
                    renderer: state.zoneRenderer,
                    color: COLOR,
                    fillColor: COLOR,
                    fillOpacity: FILL_OPACITY,
                },
            );
            polygon.on("click", () => onZoneClick(id));
            return [polygon];
        }

        case "no-overlap": {
            const latlngs = toLatLngs(circle.geometry.coordinates[0]);
            return [
                L.polygon(latlngs, {
                    renderer: state.fillRenderer,
                    interactive: false,
                    stroke: false,
                    fillColor: COLOR,
                    fillOpacity: 1,
                }),
                L.polygon(latlngs, {
                    renderer: state.outlineRenderer,
                    interactive: false,
                    fill: false,
                    color: COLOR,
                    // Only the outer half survives the erase pass
                    weight: WEIGHT * 2,
                }),
            ];
        }

        case "stations": {
            const place = circle.properties;
            const [lng, lat] = place.geometry.coordinates;

            const marker = useIcons
                ? L.marker([lat, lng], {
                      icon: (trainIcon ??= L.divIcon({
                          html: TRAIN_ICON_HTML,
                          className: "",
                      })),
                  })
                : L.circleMarker([lat, lng], {
                      renderer: state.zoneRenderer,
                      radius: 5,
                      color: "black",
                      weight: 1,
                      fillColor: COLOR,
                      fillOpacity: 0.9,
                  });

            marker.bindPopup(stationPopup(place));
            return [marker];
        }

        default:
            return [];
    }
};

/**
 * Draws the given stations in the given style. Skips the work when the same zones are
 * already drawn, and only adds or removes the toggled stations when only the disabled
 * stations changed.
 */
export const drawHidingZones = (
    map: L.Map,
    stations: StationCircle[],
    disabledStations: string[],
    style: HidingZoneStyle,
    onZoneClick: (id: string) => void,
) => {
    const state = getState(map);
    const key = zonesKey(stations);
    const disabled = new Set(disabledStations);
    const drawn = state.drawn;

    if (
        drawn &&
        drawn.key === key &&
        drawn.style === style &&
        map.hasLayer(drawn.group)
    ) {
        for (const id of disabled) {
            if (drawn.disabled.has(id)) continue;
            for (const layer of drawn.byId.get(id) ?? []) {
                drawn.group.removeLayer(layer);
            }
            drawn.byId.delete(id);
        }

        const useIcons = stations.length <= STATION_ICON_LIMIT;
        for (const id of drawn.disabled) {
            if (disabled.has(id)) continue;
            const layers = (drawn.circlesById.get(id) ?? []).flatMap((c) =>
                buildStationLayers(state, c, style, useIcons, onZoneClick),
            );
            layers.forEach((layer) => drawn.group.addLayer(layer));
            drawn.byId.set(id, layers);
        }

        drawn.disabled = disabled;
        return;
    }

    clearHidingZones(map);

    const useIcons = stations.length <= STATION_ICON_LIMIT;
    const byId = new Map<string, L.Layer[]>();
    const circlesById = new Map<string, StationCircle[]>();
    const layers: L.Layer[] = [];

    for (const circle of stations) {
        const id = stationId(circle);
        const circles = circlesById.get(id);
        if (circles) circles.push(circle);
        else circlesById.set(id, [circle]);

        if (disabled.has(id)) continue;

        const stationLayers = buildStationLayers(
            state,
            circle,
            style,
            useIcons,
            onZoneClick,
        );
        const known = byId.get(id);
        if (known) known.push(...stationLayers);
        else byId.set(id, stationLayers);
        layers.push(...stationLayers);
    }

    // With icons the stations are DOM markers in the marker pane and the canvas stays empty
    setZonePaneInteractive(
        map,
        state,
        style === "zones" || (style === "stations" && !useIcons),
    );

    const group = L.featureGroup(layers);
    addFlaggedGroup(map, group);

    state.drawn = { key, style, group, byId, circlesById, disabled };
};

/** Draws an arbitrary (non-interactive) GeoJSON overlay in place of the zones, e.g. a selected hiding zone */
export const drawHidingZoneGeoJSON = (map: L.Map, geoJSONData: any) => {
    const state = getState(map);

    clearHidingZones(map);
    setZonePaneInteractive(map, state, false);

    const layer = L.geoJSON(geoJSONData, {
        renderer: state.zoneRenderer,
        interactive: false,
        style: {
            color: COLOR,
            fillColor: COLOR,
            fillOpacity: FILL_OPACITY,
        },
    } as L.GeoJSONOptions);

    const group = L.featureGroup([layer]);
    addFlaggedGroup(map, group);
};
