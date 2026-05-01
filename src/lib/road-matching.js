import { filterNoisyRoutePoints, thinRoutePoints } from './route-utils.js';

const MAPBOX_TOKEN =
  import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ||
  import.meta.env.VITE_MAPBOX_TOKEN ||
  '';
const OSRM_MATCH_URL =
  import.meta.env.VITE_OSRM_MATCH_URL ||
  'https://router.project-osrm.org/match/v1/driving';
const ENABLE_OSRM_DEMO_MATCHING = String(import.meta.env.VITE_ENABLE_OSRM_DEMO_MATCHING || '').toLowerCase() === 'true';
const MAX_MATCH_POINTS = 90;
const MAX_MATCHED_GEOMETRY_POINTS = 650;

const hasUsableToken = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return Boolean(text) && !text.includes('your-') && !text.includes('placeholder');
};

const chunkPoints = (points, size) => {
  if (points.length <= size) return [points];

  const chunks = [];
  let index = 0;
  while (index < points.length) {
    const end = Math.min(points.length, index + size);
    const chunk = points.slice(index, end);
    if (chunk.length >= 2) chunks.push(chunk);
    index = end - 1;
  }

  return chunks;
};

const routePointFromCoordinate = (coordinate, template, index, provider) => ({
  id: `matched-${provider}-${template?.id ?? index}-${index}`,
  sessionId: template?.sessionId,
  employeeId: template?.employeeId,
  recordedAt: template?.recordedAt ?? new Date().toISOString(),
  lat: Number(coordinate[1]),
  lng: Number(coordinate[0]),
  accuracyM: template?.accuracyM ?? null,
  speedMps: template?.speedMps ?? null,
  heading: template?.heading ?? null,
  createdAt: template?.createdAt ?? template?.recordedAt ?? new Date().toISOString(),
});

async function requestMapboxMatch(points, signal) {
  const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(';');
  const radiuses = points
    .map((point) => {
      const accuracy = Number(point.accuracyM);
      return Number.isFinite(accuracy) ? Math.max(10, Math.min(accuracy, 80)).toFixed(0) : 25;
    })
    .join(';');
  const url = new URL(`https://api.mapbox.com/matching/v5/mapbox/driving/${coordinates}`);
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('tidy', 'true');
  url.searchParams.set('radiuses', radiuses);
  url.searchParams.set('access_token', MAPBOX_TOKEN);

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Mapbox road matching failed (${response.status}).`);
  }

  const data = await response.json();
  return data.matchings?.[0]?.geometry?.coordinates ?? [];
}

async function requestOsrmMatch(points, signal) {
  const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(';');
  const radiuses = points
    .map((point) => {
      const accuracy = Number(point.accuracyM);
      return Number.isFinite(accuracy) ? Math.max(10, Math.min(accuracy, 80)).toFixed(0) : 25;
    })
    .join(';');
  const url = new URL(`${OSRM_MATCH_URL.replace(/\/$/, '')}/${coordinates}`);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('radiuses', radiuses);

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`OSRM road matching failed (${response.status}).`);
  }

  const data = await response.json();
  return data.matchings?.[0]?.geometry?.coordinates ?? [];
}

export async function matchRouteToRoad(points = [], options = {}) {
  const sourcePoints = thinRoutePoints(filterNoisyRoutePoints(points), options.maxPoints ?? MAX_MATCH_POINTS);
  if (sourcePoints.length < 3) {
    return {
      provider: 'raw',
      points: sourcePoints,
      message: 'Need at least 3 clean GPS points for road matching.',
    };
  }

  const provider = hasUsableToken(MAPBOX_TOKEN) ? 'mapbox' : ENABLE_OSRM_DEMO_MATCHING ? 'osrm-demo' : 'raw';
  if (provider === 'raw') {
    return {
      provider: 'raw',
      points: sourcePoints,
      message: 'Raw GPS display. Configure Mapbox for production road matching.',
    };
  }

  const matched = [];
  const chunks = chunkPoints(sourcePoints, MAX_MATCH_POINTS);

  for (const chunk of chunks) {
    const coordinates = provider === 'mapbox'
      ? await requestMapboxMatch(chunk, options.signal)
      : await requestOsrmMatch(chunk, options.signal);

    const template = chunk.at(-1) ?? sourcePoints.at(-1);
    const chunkPointsMatched = coordinates.map((coordinate, index) =>
      routePointFromCoordinate(coordinate, template, index, provider),
    );

    if (matched.length && chunkPointsMatched.length) {
      matched.push(...chunkPointsMatched.slice(1));
    } else {
      matched.push(...chunkPointsMatched);
    }
  }

  if (matched.length < 2) {
    return {
      provider: 'raw',
      points: sourcePoints,
      message: 'Road matching returned no usable road geometry.',
    };
  }

  return {
    provider,
    points: thinRoutePoints(matched, MAX_MATCHED_GEOMETRY_POINTS),
    message: provider === 'mapbox'
      ? 'Road matched with Mapbox.'
      : 'Road matched with the OSRM demo service. Use Mapbox or self-host OSRM/Valhalla for production.',
  };
}
