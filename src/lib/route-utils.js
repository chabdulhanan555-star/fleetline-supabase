const toRadians = (value) => (Number(value) * Math.PI) / 180;

export const distanceMeters = (left, right) => {
  if (!left || !right) return 0;
  const earthRadiusM = 6371000;
  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const sortRoutePoints = (points = []) =>
  [...(points ?? [])].sort((left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime());

export const calculateRouteDistanceM = (points) =>
  sortRoutePoints(points).reduce((total, point, index, rows) => {
    if (index === 0) return total;
    return total + distanceMeters(rows[index - 1], point);
  }, 0);

export const groupRoutePointsBySession = (points = []) =>
  points.reduce((accumulator, point) => {
    accumulator[point.sessionId] ??= [];
    accumulator[point.sessionId].push(point);
    return accumulator;
  }, {});

export const thinRoutePoints = (points, maxPoints) => {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  if (maxPoints <= 2) return [points[0], points.at(-1)].filter(Boolean);

  const step = (points.length - 1) / (maxPoints - 1);
  const thinned = [];
  const seen = new Set();

  for (let index = 0; index < maxPoints; index += 1) {
    const point = points[Math.round(index * step)];
    const key = routePointKey(point);
    if (point && !seen.has(key)) {
      seen.add(key);
      thinned.push(point);
    }
  }

  const lastPoint = points.at(-1);
  const lastKey = routePointKey(lastPoint);
  if (lastPoint && !seen.has(lastKey)) {
    thinned.push(lastPoint);
  }

  return thinned;
};

const routePointKey = (point) => point?.id ?? `${point?.lat}:${point?.lng}:${point?.recordedAt}`;

export const buildRouteLineData = (points, maxPoints) => {
  const linePoints = thinRoutePoints(points, maxPoints);

  return {
    type: 'FeatureCollection',
    features: linePoints.length > 1
      ? [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: linePoints.map((point) => [point.lng, point.lat]),
            },
          },
        ]
      : [],
  };
};

export const buildRoutePointData = (points, maxPoints) => {
  const markerPoints = thinRoutePoints(points, maxPoints);
  const firstKey = routePointKey(points[0]);
  const lastKey = routePointKey(points.at(-1));

  return {
    type: 'FeatureCollection',
    features: markerPoints.map((point) => ({
      type: 'Feature',
      properties: {
        kind: routePointKey(point) === firstKey ? 'start' : routePointKey(point) === lastKey ? 'live' : 'point',
      },
      geometry: {
        type: 'Point',
        coordinates: [point.lng, point.lat],
      },
    })),
  };
};
