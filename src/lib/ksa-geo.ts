/**
 * Saudi Arabia outline and the equirectangular projection both maps share.
 *
 * Extracted from `saudi-sales-map.tsx` when the Branch Directory needed the same
 * geometry. A 57-vertex polygon copied into two files is one edit away from two
 * differently-shaped countries, so it lives here and both import it.
 *
 * The projection is deliberately plain: linear in longitude and latitude, no
 * Mercator correction. Over the ~17° of latitude Saudi Arabia spans, the
 * distortion is small, and the alternative — carrying a projection library — buys
 * accuracy nobody reading a branch locator can perceive.
 */

/** Country outline as (longitude, latitude) pairs. */
export const KSA_OUTLINE: Array<[number, number]> = [
  [34.95, 29.35],
  [36.02, 29.19],
  [36.48, 29.5],
  [36.75, 29.87],
  [37.49, 29.99],
  [37.98, 30.5],
  [36.96, 31.49],
  [38.0, 31.99],
  [39.15, 32.14],
  [40.37, 31.93],
  [42.08, 31.08],
  [42.85, 30.49],
  [44.72, 29.19],
  [46.36, 29.06],
  [46.55, 29.1],
  [47.46, 29.98],
  [48.02, 29.54],
  [48.42, 28.54],
  [48.83, 28.06],
  [49.3, 27.46],
  [49.98, 27.03],
  [50.24, 26.35],
  [50.56, 26.05],
  [50.2, 25.61],
  [50.56, 25.0],
  [51.28, 24.62],
  [51.6, 24.14],
  [52.56, 22.94],
  [55.2, 22.7],
  [55.67, 22.0],
  [55.2, 20.55],
  [52.0, 19.0],
  [49.5, 19.2],
  [48.19, 18.16],
  [47.58, 17.45],
  [46.72, 17.3],
  [45.42, 17.33],
  [43.79, 16.36],
  [43.19, 16.66],
  [42.78, 16.38],
  [42.65, 16.77],
  [42.35, 17.68],
  [42.11, 18.36],
  [41.68, 18.68],
  [41.22, 19.42],
  [40.65, 19.86],
  [39.62, 20.5],
  [39.1, 21.29],
  [38.99, 22.06],
  [38.46, 23.72],
  [37.16, 24.88],
  [36.68, 25.61],
  [35.9, 26.53],
  [35.15, 27.44],
  [34.63, 28.06],
  [34.95, 29.35],
];

/** Projection bounds, chosen to frame the country with a little margin. */
export const LON_MIN = 33.5;
export const LON_MAX = 56.5;
export const LAT_MIN = 15.5;
export const LAT_MAX = 32.8;

/** Base canvas size. Positions are computed in this space, then transformed. */
export const MAP_WIDTH = 900;
export const MAP_HEIGHT = Math.round((MAP_WIDTH * (LAT_MAX - LAT_MIN)) / (LON_MAX - LON_MIN));

export function projectPoint(lon: number, lat: number): [number, number] {
  const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * MAP_WIDTH;
  const y = MAP_HEIGHT - ((lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * MAP_HEIGHT;
  return [x, y];
}

/** The outline as an SVG path in projected space. */
export const KSA_OUTLINE_PATH: string =
  "M " +
  KSA_OUTLINE.map(([lon, lat]) => {
    const [x, y] = projectPoint(lon, lat);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" L ") +
  " Z";
