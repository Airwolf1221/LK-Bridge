/**
 * Map coordinates (v2 D2, ADR 0040): the frame of a map image, the conversion between pixels and `[lat, lng]`, and the
 * bounds rules. Pure; nothing here reads or writes anything.
 *
 * LegendKeeper's schema (`MapImage`) states the conversion exactly, and the SDK exports it as `pixelToPos` and
 * `posToPixel`. With `bounds = [[south, west], [north, east]]`, where `north` and `west` are 0 at the image's top-left
 * corner, and `width` and `height` the image's size in pixels:
 *
 *   pos = [north - y * (north - south) / height, west + x * (east - west) / width]
 *   x   = (lng - west) * width / (east - west)
 *   y   = (north - lat) * height / (north - south)
 *
 * The formulas are written out here (not imported from the SDK) so the bridge's tests can check them against the SDK's
 * own functions and against the schema's text; the app's own frame is `[-y / 2^z, x / 2^z]` with
 * `z = ceil(log2(max(width, height) / 256))` (`zoomOf`, `appBounds`), which the opt-in sandbox test checks against what
 * LegendKeeper reports.
 */

export type LatLng = readonly [number, number];
export interface Pixel {
  readonly x: number;
  readonly y: number;
}
export type Bounds = readonly [readonly [number, number], readonly [number, number]];

/** The coordinate frame of a map's image. */
export interface MapFrame {
  readonly width: number;
  readonly height: number;
  readonly bounds: Bounds;
}

/** What a map document's `mapImage` says about its coordinate frame. */
export type FrameState =
  /** A single image with a frame: pixels and lat/lng both work. */
  | {
      readonly kind: 'image';
      readonly frame: MapFrame;
      readonly url: string;
      readonly assetId: string | null;
    }
  /** A legacy tiled map: no single image, so no pixels (lat/lng still work, with no bounds to check). */
  | { readonly kind: 'legacy'; readonly frame: MapFrame | null }
  /** The map has no image yet. */
  | { readonly kind: 'none' };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A well-formed frame (positive integer size, finite bounds with north above south and east right of west), or null. */
export function frameFrom(v: unknown): MapFrame | null {
  if (!isObj(v)) return null;
  const { width, height, bounds } = v;
  if (!isNum(width) || !isNum(height) || width <= 0 || height <= 0) return null;
  if (!Array.isArray(bounds) || bounds.length !== 2) return null;
  const [sw, ne] = bounds as unknown[];
  if (!Array.isArray(sw) || !Array.isArray(ne) || sw.length !== 2 || ne.length !== 2) return null;
  const [south, west] = sw as unknown[];
  const [north, east] = ne as unknown[];
  if (!isNum(south) || !isNum(west) || !isNum(north) || !isNum(east)) return null;
  if (!(north > south) || !(east > west)) return null;
  return {
    width,
    height,
    bounds: [
      [south, west],
      [north, east],
    ],
  };
}

/** The frame state of a document's `mapImage` (null when the map has no image). */
export function frameState(mapImage: unknown): FrameState {
  if (mapImage === null || mapImage === undefined || !isObj(mapImage)) return { kind: 'none' };
  const frame = frameFrom(mapImage);
  const url = mapImage.url;
  if (typeof url !== 'string' || url === '' || frame === null) return { kind: 'legacy', frame };
  const assetId = typeof mapImage.assetId === 'string' ? mapImage.assetId : null;
  return { kind: 'image', frame, url, assetId };
}

/** Two frames are the same when size and bounds are equal. */
export function sameFrame(a: MapFrame | null, b: MapFrame | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.bounds[0][0] === b.bounds[0][0] &&
    a.bounds[0][1] === b.bounds[0][1] &&
    a.bounds[1][0] === b.bounds[1][0] &&
    a.bounds[1][1] === b.bounds[1][1]
  );
}

/** Pixel `(x, y)` from the image's top-left corner to `[lat, lng]`, exactly as the schema states it. */
export function pixelToPos(frame: MapFrame, x: number, y: number): LatLng {
  const [[south, west], [north, east]] = frame.bounds;
  return [north - (y * (north - south)) / frame.height, west + (x * (east - west)) / frame.width];
}

/** `[lat, lng]` back to a pixel from the image's top-left corner, exactly as the schema states it. */
export function posToPixel(frame: MapFrame, pos: LatLng): Pixel {
  const [[south, west], [north, east]] = frame.bounds;
  const [lat, lng] = pos;
  return {
    x: ((lng - west) * frame.width) / (east - west),
    y: ((north - lat) * frame.height) / (north - south),
  };
}

/** The app's zoom for an image: `z = ceil(log2(max(width, height) / 256))`, at least 0. */
export function zoomOf(width: number, height: number): number {
  const z = Math.ceil(Math.log2(Math.max(width, height) / 256));
  return z > 0 ? z : 0;
}

/**
 * The bounds the app derives from the size: `[[-height / 2^z, 0], [0, width / 2^z]]` (the frame `[-y / 2^z, x / 2^z]`
 * of the schema's text). The sandbox test compares what LegendKeeper reports with this.
 */
export function appBounds(width: number, height: number): Bounds {
  const k = 2 ** zoomOf(width, height);
  return [
    [-height / k, 0],
    [0, width / k],
  ];
}

/** Coordinates are stored to nine decimals: far finer than a pixel of any map, and free of floating-point tails. */
export const roundCoord = (v: number): number => Math.round(v * 1e9) / 1e9;
export const roundPos = (p: LatLng): [number, number] => [roundCoord(p[0]), roundCoord(p[1])];

/** A relative tolerance for "on the edge": a conversion there can land a rounding error outside. */
const EPS = 1e-9;

export function pixelInside(frame: MapFrame, p: Pixel): boolean {
  const ex = EPS * Math.max(1, frame.width);
  const ey = EPS * Math.max(1, frame.height);
  return p.x >= -ex && p.x <= frame.width + ex && p.y >= -ey && p.y <= frame.height + ey;
}

export function posInside(frame: MapFrame, pos: LatLng): boolean {
  const [[south, west], [north, east]] = frame.bounds;
  const e = EPS * Math.max(1, north - south, east - west);
  return pos[1] >= west - e && pos[1] <= east + e && pos[0] >= south - e && pos[0] <= north + e;
}

// --------------------------------------------------------------------------------------------------- input

/** The shape of a feature's geometry. */
export type GeometryShape = 'point' | 'points' | 'polygons';

/** A request's coordinates, in the system the caller used (never both). */
export type Geometry =
  | { readonly system: 'latlng'; readonly shape: 'point'; readonly point: LatLng }
  | { readonly system: 'latlng'; readonly shape: 'points'; readonly points: readonly LatLng[] }
  | {
      readonly system: 'latlng';
      readonly shape: 'polygons';
      readonly polygons: readonly (readonly LatLng[])[];
    }
  | { readonly system: 'pixel'; readonly shape: 'point'; readonly point: Pixel }
  | { readonly system: 'pixel'; readonly shape: 'points'; readonly points: readonly Pixel[] }
  | {
      readonly system: 'pixel';
      readonly shape: 'polygons';
      readonly polygons: readonly (readonly Pixel[])[];
    };

/** The geometry as `[lat, lng]` values, ready for LegendKeeper: `pos`, `polygon`/`polygons` or `polyline`. */
export interface Resolved {
  readonly point?: [number, number];
  readonly points?: [number, number][];
  readonly polygons?: [number, number][][];
}

export interface Outside {
  readonly index: string;
  readonly value: string;
}

/**
 * Converts a geometry to `[lat, lng]` with a frame (pixels need one), and lists every point outside the image. Pixel
 * conversion is the schema's formula, rounded to nine decimals; lat/lng pass through untouched.
 */
export function resolveGeometry(
  g: Geometry,
  frame: MapFrame | null,
): { readonly resolved: Resolved; readonly outside: readonly Outside[] } {
  const outside: Outside[] = [];
  const one = (v: LatLng | Pixel, at: string): [number, number] => {
    if (g.system === 'pixel') {
      const p = v as Pixel;
      if (frame && !pixelInside(frame, p)) outside.push({ index: at, value: `x ${p.x}, y ${p.y}` });
      return frame ? roundPos(pixelToPos(frame, p.x, p.y)) : [Number.NaN, Number.NaN];
    }
    const l = v as LatLng;
    if (frame && !posInside(frame, l)) outside.push({ index: at, value: `[${l[0]}, ${l[1]}]` });
    return [l[0], l[1]];
  };
  switch (g.shape) {
    case 'point':
      return { resolved: { point: one(g.point, 'position') }, outside };
    case 'points':
      return {
        resolved: {
          points: (g.points as readonly (LatLng | Pixel)[]).map((p, i) => one(p, `point ${i + 1}`)),
        },
        outside,
      };
    case 'polygons':
      return {
        resolved: {
          polygons: (g.polygons as readonly (readonly (LatLng | Pixel)[])[]).map((poly, pi) =>
            poly.map((p, i) => one(p, `polygon ${pi + 1} point ${i + 1}`)),
          ),
        },
        outside,
      };
  }
}

/** Every `[lat, lng]` of a feature stored in LegendKeeper (`pos`, `polygon`, `polygons`, `polyline`). */
export function featurePoints(f: Record<string, unknown>): LatLng[] {
  const out: LatLng[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1])) out.push([v[0], v[1]]);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  walk(f.pos);
  walk(f.polygon);
  walk(f.polygons);
  walk(f.polyline);
  return out;
}
