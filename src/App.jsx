import React, { useEffect, useMemo, useRef, useState } from 'react';
import imageCompression from 'browser-image-compression';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  BarChart3,
  Bike,
  Camera,
  CheckCircle,
  ChevronRight,
  CloudOff,
  DollarSign,
  Edit2,
  FileDown,
  Fuel,
  Gauge,
  Hash,
  History,
  KeyRound,
  LogOut,
  MapPin,
  MessageCircle,
  PackageCheck,
  Phone,
  RefreshCw,
  Route,
  Settings,
  Shield,
  Moon,
  Sun,
  Trash2,
  TrendingUp,
  Upload,
  User,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { enqueue, flushOutbox, onOutboxChange } from './lib/outbox.js';
import { makeClientId } from './lib/id.js';
import {
  buildRouteLineData,
  buildRoutePointData,
  calculateRouteDistanceM,
  distanceMeters,
  filterNoisyRoutePoints,
  groupRoutePointsBySession,
  sortRoutePoints,
  thinRoutePoints,
} from './lib/route-utils.js';
import { matchRouteToRoad } from './lib/road-matching.js';
import {
  adminLogin,
  appendRoutePoints,
  deleteEmployee,
  deleteReading,
  deleteRouteSession,
  finishRouteSession,
  getCurrentSession,
  getSignedPhotoUrl,
  inviteAdmin,
  isDemoMode,
  isSupabaseConfigured,
  listAdmins,
  listRoutePointsForSession,
  onSessionChange,
  resetRiderPin,
  saveConfig,
  saveDailyReview,
  saveEmployee,
  saveRouteTemplate,
  saveReading,
  signOut,
  subscribeConfig,
  subscribeDailyReviews,
  subscribeEmployees,
  subscribeFuelPriceHistory,
  subscribeLiveRiderLocations,
  subscribeReadings,
  subscribeRouteDeviationEvents,
  subscribeRoutePoints,
  subscribeRouteSessions,
  subscribeRouteTemplates,
  subscribeShopPins,
  supabaseConfigError,
  startRouteSession,
  uploadPhoto,
} from './lib/supabase.js';

const DEFAULT_CONFIG = {
  id: 1,
  fuelPrice: 280,
  defaultMileage: 40,
  currency: 'PKR',
  adminWhatsApp: '',
  updatedAt: null,
  updatedBy: null,
};

const READING_TYPES = {
  morning: {
    label: 'Morning Start',
    shortLabel: 'Morning',
    helper: 'Submit before the rider leaves for market.',
    icon: Sun,
  },
  evening: {
    label: 'Evening End',
    shortLabel: 'Evening',
    helper: 'Submit after the rider returns from market.',
    icon: Moon,
  },
};

const HIGH_DAILY_KM_WARNING = 300;
const ROUTE_ODOMETER_DIFF_WARNING_PCT = 25;
const APP_TIME_ZONE = 'Asia/Karachi';
const WORKING_WEEKDAYS = new Set([1, 2, 3, 4, 5, 6]);
const WORKING_DAYS_LABEL = 'Monday to Saturday';
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LEARNING_WINDOW_DAYS = 7;
const LEARNING_DUPLICATE_RADIUS_M = 80;
const LEARNING_DEFAULT_RADIUS_M = 120;
const MISSING_READING_CUTOFFS = {
  morning: { hour: 11, label: '11:00 AM' },
  evening: { hour: 18, label: '6:00 PM' },
};
const LATE_READING_CUTOFFS = {
  morning: { hour: 11, minute: 0, label: '11:00 AM' },
  evening: { hour: 20, minute: 0, label: '8:00 PM' },
};
const REVIEW_STATUS = {
  pending_review: { label: 'Pending', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  problem: { label: 'Problem', tone: 'red' },
};
const ROUTE_TRACKING_KEY = 'fleetline.active-route-session.v1';
const ROUTE_SAMPLE_INTERVAL_MS = 60000;
const ROUTE_MIN_DISTANCE_M = 75;
const ROUTE_STALE_AFTER_MS = 30 * 60 * 1000;
const ROUTE_RENDER_LINE_LIMIT = 450;
const ROUTE_RENDER_MARKER_LIMIT = 110;
const ROUTE_REFIT_POINT_DELTA = 18;
const ROUTE_MAP_FALLBACK_CENTER = [74.3587, 31.5204];
const ROUTE_POINTS_MEMORY_LIMIT = 5000;
const ROUTE_MAP_LOAD_TIMEOUT_MS = 6500;
const ROUTE_MAP_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: 'OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-saturation': -0.55,
        'raster-contrast': 0.18,
        'raster-brightness-min': 0.08,
        'raster-brightness-max': 0.72,
      },
    },
  ],
};

let maplibrePromise = null;

const loadMaplibre = () => {
  if (!maplibrePromise) {
    maplibrePromise = import('maplibre-gl').then((module) => module.default ?? module);
  }

  return maplibrePromise;
};

const getAppDateTime = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? '00';

  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
    minute: Number(value('minute')),
  };
};

const today = () => getAppDateTime().date;
const getAppDateKey = (value) => {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10);
  return getAppDateTime(parsed).date;
};
const appDateOffset = (offsetDays = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return getAppDateTime(date).date;
};
const monthKey = (value) => value.slice(0, 7);
const getDateParts = (value) => value.split('-').map(Number);
const getWeekday = (value) => {
  const [year, month, day] = getDateParts(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};
const isWorkingDay = (value) => WORKING_WEEKDAYS.has(getWeekday(value));
// All app-facing dates render in Pakistan time. Pass options to customize the
// shape; the helper always pins the timezone so a rider/admin on a device set
// to a different zone still sees the same date as the operations team.
const formatAppDate = (value, options = { day: '2-digit', month: 'short', year: 'numeric' }) =>
  new Date(value).toLocaleDateString('en-GB', { timeZone: APP_TIME_ZONE, ...options });
const formatAppTime = (value, options = { hour: '2-digit', minute: '2-digit' }) =>
  value ? new Date(value).toLocaleTimeString('en-GB', { timeZone: APP_TIME_ZONE, ...options }) : '-';
const formatAppDateTime = (value, options = {}) =>
  new Date(value).toLocaleString('en-GB', {
    timeZone: APP_TIME_ZONE,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    ...options,
  });
const fmtDate = (value) => formatAppDate(value);
const fmtShort = (value) => formatAppDate(value, { day: '2-digit', month: 'short' });
const fmtNum = (value) => Number(value ?? 0).toLocaleString('en-US');
const fmtTime = (value) => formatAppTime(value);
const fmtDistance = (meters) => {
  const value = Number(meters) || 0;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
};
const fmtCoordinate = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(6) : '-');

const readStoredActiveRoute = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ROUTE_TRACKING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeStoredActiveRoute = (route) => {
  if (typeof window === 'undefined') return;
  try {
    if (!route) {
      window.localStorage.removeItem(ROUTE_TRACKING_KEY);
      return;
    }
    window.localStorage.setItem(ROUTE_TRACKING_KEY, JSON.stringify(route));
  } catch (error) {
    console.warn('[route-tracking] Could not persist active route locally', error);
  }
};

const pointFromPosition = (position, session) => ({
  id: makeClientId(),
  sessionId: session.id,
  employeeId: session.employeeId,
  recordedAt: new Date(position.timestamp || Date.now()).toISOString(),
  lat: Number(position.coords.latitude),
  lng: Number(position.coords.longitude),
  accuracyM: position.coords.accuracy ?? null,
  speedMps: position.coords.speed ?? null,
  heading: position.coords.heading ?? null,
});

const shouldRecordRoutePoint = (lastPoint, nextPoint) => {
  if (!lastPoint) return true;
  const movedM = distanceMeters(lastPoint, nextPoint);
  const elapsedMs = new Date(nextPoint.recordedAt).getTime() - new Date(lastPoint.recordedAt).getTime();
  return movedM >= ROUTE_MIN_DISTANCE_M || elapsedMs >= ROUTE_SAMPLE_INTERVAL_MS;
};

const isInactiveRouteError = (error) =>
  String(error?.message ?? error ?? '').toLowerCase().includes('route session is not active');

const isLikelyNetworkError = (error) => {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  return text.includes('fetch') || text.includes('network') || text.includes('failed');
};

const csvEscape = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[,"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const downloadCSV = (rows, filename) => {
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
};

const sanitizePhone = (value) => (value || '').replace(/[^\d]/g, '');

const normalizeWhatsAppPhone = (value) => {
  const digits = sanitizePhone(value);
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('3')) return `92${digits}`;
  return digits;
};

const openWhatsApp = (phone, message) => {
  const clean = normalizeWhatsAppPhone(phone);
  const url = clean
    ? `https://wa.me/${clean}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
};

const sortReadingsAsc = (rows) =>
  [...rows].sort((left, right) => {
    const leftKey = `${left.date}|${left.submittedAt ?? ''}`;
    const rightKey = `${right.date}|${right.submittedAt ?? ''}`;
    return leftKey.localeCompare(rightKey);
  });

const getReadingType = (reading) => reading.readingType ?? reading.reading_type ?? 'evening';

const readingTypeLabel = (reading) => READING_TYPES[getReadingType(reading)]?.shortLabel ?? 'Reading';

// `excludeQueued` drops offline-only readings so admin reports and charts agree
// with synced data. Rider self-views leave it false so a rider still sees the
// reading they just submitted before it round-trips through Supabase.
const getDaySummary = (readings, date = today(), { excludeQueued = false } = {}) => {
  const filtered = excludeQueued ? readings.filter((reading) => !reading.queued) : readings;
  const dayReadings = sortReadingsAsc(filtered).filter((reading) => reading.date === date);
  const mornings = dayReadings.filter((reading) => getReadingType(reading) === 'morning');
  const evenings = dayReadings.filter((reading) => getReadingType(reading) === 'evening');
  const morning = mornings[0] ?? null;
  const evening = evenings.at(-1) ?? null;
  const rawDistance = morning && evening ? evening.km - morning.km : null;

  return {
    date,
    morning,
    evening,
    readings: dayReadings,
    complete: Boolean(morning && evening),
    rawDistance,
    distance: rawDistance === null ? 0 : Math.max(0, rawDistance),
    invalid: rawDistance !== null && rawDistance < 0,
  };
};

const getNextReadingType = (readings, date = today()) => {
  const summary = getDaySummary(readings, date);
  if (!summary.morning) return 'morning';
  if (!summary.evening) return 'evening';
  return 'evening';
};

const getMonthlySummary = (readings, selectedMonth, mileage, fuelPrice, fuelPriceHistory = []) => {
  const days = new Map();
  sortReadingsAsc(readings)
    .filter((reading) => (
      !reading.queued &&
      isWorkingDay(reading.date) &&
      (!selectedMonth || monthKey(reading.date) === selectedMonth)
    ))
    .forEach((reading) => {
      const existing = days.get(reading.date) || [];
      existing.push(reading);
      days.set(reading.date, existing);
    });

  const dailySummaries = [...days.entries()].map(([date, rows]) => getDaySummary(rows, date));
  const totalKm = dailySummaries.reduce((sum, day) => sum + (day.complete ? day.distance : 0), 0);
  const fuelUsed = mileage > 0 ? totalKm / mileage : 0;
  const cost = dailySummaries.reduce((sum, day) => {
    const dayFuel = mileage > 0 && day.complete ? day.distance / mileage : 0;
    return sum + dayFuel * getFuelPriceForDate(day.date, fuelPriceHistory, fuelPrice);
  }, 0);

  return {
    dailySummaries,
    completedDays: dailySummaries.filter((day) => day.complete).length,
    totalKm,
    fuelUsed,
    cost,
    warningCount: dailySummaries.filter((day) => day.invalid || day.distance > HIGH_DAILY_KM_WARNING).length,
  };
};

const getMinutesSinceMidnight = (date = new Date()) => {
  const appTime = getAppDateTime(date);
  return appTime.hour * 60 + appTime.minute;
};

const isPastCutoff = (type, date = new Date()) =>
  getMinutesSinceMidnight(date) >= MISSING_READING_CUTOFFS[type].hour * 60;

const getTimestampMinutes = (isoValue) => {
  if (!isoValue) return 0;
  const appTime = getAppDateTime(new Date(isoValue));
  return appTime.hour * 60 + appTime.minute;
};

const isLateReading = (type, reading) => {
  if (!reading?.submittedAt) return false;
  const cutoff = LATE_READING_CUTOFFS[type];
  return getTimestampMinutes(reading.submittedAt) > cutoff.hour * 60 + cutoff.minute;
};

const buildFuelPriceMap = (fuelPriceHistory = []) =>
  fuelPriceHistory.reduce((accumulator, row) => {
    accumulator[row.date] = row;
    return accumulator;
  }, {});

const getFuelPriceForDate = (date, fuelPriceHistory = [], fallbackPrice = 0) => {
  const exactPrice = buildFuelPriceMap(fuelPriceHistory)[date]?.fuelPrice;
  if (exactPrice !== undefined) return Number(exactPrice);

  const nearestHistoricalPrice = [...fuelPriceHistory]
    .filter((row) => row.date <= date)
    .sort((left, right) => right.date.localeCompare(left.date))[0]?.fuelPrice;

  return Number(nearestHistoricalPrice ?? fallbackPrice);
};

const getReviewKey = (employeeId, date) => `${employeeId}:${date}`;

const buildDailyReviewMap = (dailyReviews = []) =>
  dailyReviews.reduce((accumulator, review) => {
    accumulator[getReviewKey(review.employeeId, review.date)] = review;
    return accumulator;
  }, {});

const getRouteForDay = (routeSessions = [], employeeId, date) =>
  routeSessions
    .filter((session) => session.employeeId === employeeId && session.date === date)
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0] ?? null;

const getLiveLocationForSession = (liveLocations = [], session) => {
  if (!session) return null;

  return liveLocations.find((location) => location.routeSessionId === session.id) ??
    liveLocations.find(
      (location) =>
        location.employeeId === session.employeeId &&
        location.date === session.date &&
        (location.status === 'active' || session.status === 'active'),
    ) ??
    null;
};

const getLatestPointFromSession = (session, liveLocation = null) => {
  if (
    liveLocation &&
    Number.isFinite(Number(liveLocation.lat)) &&
    Number.isFinite(Number(liveLocation.lng)) &&
    (liveLocation.status === 'active' || session?.status === 'active')
  ) {
    return {
      id: `live-${liveLocation.employeeId}-${liveLocation.recordedAt || liveLocation.updatedAt}`,
      sessionId: session?.id ?? liveLocation.routeSessionId ?? liveLocation.employeeId,
      employeeId: liveLocation.employeeId,
      recordedAt: liveLocation.recordedAt || liveLocation.updatedAt,
      lat: Number(liveLocation.lat),
      lng: Number(liveLocation.lng),
      accuracyM: liveLocation.accuracyM,
      speedMps: liveLocation.speedMps,
      heading: liveLocation.heading,
      createdAt: liveLocation.updatedAt || liveLocation.recordedAt,
    };
  }

  if (!session || !Number.isFinite(Number(session.latestLat)) || !Number.isFinite(Number(session.latestLng))) {
    return null;
  }

  return {
    id: `live-${session.id}-${session.lastPointAt || session.updatedAt || session.startedAt}`,
    sessionId: session.id,
    employeeId: session.employeeId,
    recordedAt: session.lastPointAt || session.updatedAt || session.startedAt,
    lat: Number(session.latestLat),
    lng: Number(session.latestLng),
    accuracyM: session.latestAccuracyM,
    speedMps: session.latestSpeedMps,
    heading: session.latestHeading,
    createdAt: session.updatedAt || session.lastPointAt || session.startedAt,
  };
};

const buildLiveOnlyRouteSessions = (liveLocations = [], routeSessions = []) => {
  const routeSessionIds = new Set(routeSessions.map((session) => session.id));
  const routeSessionDayKeys = new Set(
    routeSessions.map((session) => `${session.employeeId}:${session.date}`),
  );

  return liveLocations
    .filter((location) => {
      if (location.date !== today() || location.status !== 'active') return false;
      if (!Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) return false;
      if (location.routeSessionId && routeSessionIds.has(location.routeSessionId)) return false;
      return !routeSessionDayKeys.has(`${location.employeeId}:${location.date}`);
    })
    .map((location) => ({
      id: `live-${location.employeeId}`,
      employeeId: location.employeeId,
      date: location.date,
      startReadingId: null,
      endReadingId: null,
      status: 'active',
      startedAt: location.recordedAt || location.updatedAt,
      endedAt: null,
      lastPointAt: location.recordedAt || location.updatedAt,
      latestLat: Number(location.lat),
      latestLng: Number(location.lng),
      latestAccuracyM: location.accuracyM,
      latestSpeedMps: location.speedMps,
      latestHeading: location.heading,
      pointCount: 1,
      totalDistanceM: 0,
      createdBy: null,
      createdAt: location.updatedAt || location.recordedAt,
      updatedAt: location.updatedAt || location.recordedAt,
      isLiveOnly: true,
    }));
};

const mergeSessionLatestPoint = (points = [], session, liveLocation = null) => {
  const sorted = sortRoutePoints(points);
  const latest = getLatestPointFromSession(session, liveLocation);

  if (!latest) return sorted;

  const currentLast = sorted.at(-1);
  if (!currentLast || new Date(latest.recordedAt).getTime() > new Date(currentLast.recordedAt).getTime()) {
    return [...sorted, latest];
  }

  return sorted;
};

const getShopPinsForRouteDay = (shopPins = [], employeeId, date, routeSessionId) =>
  shopPins
    .filter((pin) =>
      routeSessionId
        ? pin.routeSessionId === routeSessionId
        : pin.employeeId === employeeId && getAppDateKey(pin.pinnedAt) === date,
    )
    .sort((left, right) => new Date(left.pinnedAt).getTime() - new Date(right.pinnedAt).getTime());

const getDeviationEventsForRouteDay = (events = [], employeeId, date, routeSessionId) =>
  events
    .filter((event) =>
      routeSessionId
        ? event.routeSessionId === routeSessionId
        : event.employeeId === employeeId && getAppDateKey(event.recordedAt) === date,
    )
    .sort((left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime());

const getRouteHealth = ({ routeSession, routePoints = [], odometerKm = 0 }) => {
  const sortedPoints = sortRoutePoints(routePoints);
  const pointCount = sortedPoints.length || routeSession?.pointCount || 0;
  const gpsDistanceM = routeSession?.totalDistanceM || calculateRouteDistanceM(sortedPoints);
  const gpsDistanceKm = gpsDistanceM / 1000;
  const activeMinutes =
    sortedPoints.length > 1
      ? Math.max(0, Math.round((new Date(sortedPoints.at(-1).recordedAt).getTime() - new Date(sortedPoints[0].recordedAt).getTime()) / 60000))
      : routeSession?.startedAt && routeSession?.lastPointAt
        ? Math.max(0, Math.round((new Date(routeSession.lastPointAt).getTime() - new Date(routeSession.startedAt).getTime()) / 60000))
        : 0;
  const diffKm = odometerKm > 0 && gpsDistanceKm > 0 ? Math.abs(odometerKm - gpsDistanceKm) : 0;
  const diffPct = odometerKm > 0 && gpsDistanceKm > 0 ? (diffKm / odometerKm) * 100 : null;
  const confidence =
    odometerKm > 0 && gpsDistanceKm > 0
      ? Math.max(0, Math.min(100, Math.round(100 - Math.min(100, diffPct ?? 100))))
      : sortedPoints.length > 0
        ? 55
        : 0;

  return {
    activeMinutes,
    pointCount,
    gpsDistanceM,
    gpsDistanceKm,
    diffKm,
    diffPct,
    confidence,
    hasGps: pointCount > 0,
  };
};

const getProblemFlags = ({ daySummary, routeHealth, review, now = new Date(), date = today() }) => {
  const flags = [];

  if (daySummary.invalid) {
    flags.push({ id: 'invalid_odo', label: 'Evening < Morning', tone: 'red' });
  }

  if (daySummary.complete && daySummary.distance > HIGH_DAILY_KM_WARNING) {
    flags.push({ id: 'high_km', label: `High KM > ${HIGH_DAILY_KM_WARNING}`, tone: 'amber' });
  }

  if (daySummary.complete && !routeHealth.hasGps) {
    flags.push({ id: 'gps_missing', label: 'GPS Missing', tone: 'red' });
  }

  if (daySummary.complete && routeHealth.diffPct !== null && routeHealth.diffPct > ROUTE_ODOMETER_DIFF_WARNING_PCT) {
    flags.push({ id: 'gps_diff', label: `GPS Diff ${Math.round(routeHealth.diffPct)}%`, tone: 'amber' });
  }

  if ((daySummary.morning && !daySummary.morning.photoPath) || (daySummary.evening && !daySummary.evening.photoPath)) {
    flags.push({ id: 'photo_missing', label: 'Photo Missing', tone: 'red' });
  }

  if (isLateReading('morning', daySummary.morning)) {
    flags.push({ id: 'morning_late', label: `Morning Late > ${LATE_READING_CUTOFFS.morning.label}`, tone: 'amber' });
  }

  if (isLateReading('evening', daySummary.evening)) {
    flags.push({ id: 'evening_late', label: `Evening Late > ${LATE_READING_CUTOFFS.evening.label}`, tone: 'amber' });
  }

  if (review?.status === 'problem') {
    flags.push({ id: 'admin_problem', label: 'Marked Problem', tone: 'red' });
  }

  if (date > today()) {
    return [];
  }

  return flags;
};

const getMissingReadingAlerts = (employees, readingsByEmployee, date = today(), now = new Date()) => {
  const alerts = [];

  if (!isWorkingDay(date)) {
    return alerts;
  }

  employees
    .filter((employee) => employee.active !== false)
    .forEach((employee) => {
      const summary = getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true });

      if (isPastCutoff('morning', now) && !summary.morning) {
        alerts.push({
          id: `${employee.id}-morning`,
          employee,
          type: 'morning',
          title: 'Missing Morning Start',
          dueLabel: MISSING_READING_CUTOFFS.morning.label,
          message: `Assalam o Alaikum ${employee.name}, please submit your Morning Start odometer reading with photo for ${fmtDate(date)} in FleetLine.`,
        });
      }

      if (isPastCutoff('evening', now) && !summary.evening) {
        alerts.push({
          id: `${employee.id}-evening`,
          employee,
          type: 'evening',
          title: 'Missing Evening End',
          dueLabel: MISSING_READING_CUTOFFS.evening.label,
          message: `Assalam o Alaikum ${employee.name}, please submit your Evening End odometer reading with photo for ${fmtDate(date)} in FleetLine.`,
        });
      }
    });

  return alerts;
};

const getDatesForMonth = (month, throughDate = today(), options = {}) => {
  const [year, monthNumber] = month.split('-').map(Number);
  const isCurrentMonth = month === monthKey(throughDate);
  const endDay = isCurrentMonth ? Number(throughDate.slice(8, 10)) : new Date(year, monthNumber, 0).getDate();

  const dates = Array.from({ length: endDay }, (_, index) =>
    `${year}-${String(monthNumber).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
  );

  return options.workingOnly ? dates.filter(isWorkingDay) : dates;
};

const getRiderTodayStatus = (summary, now = new Date(), date = today()) => {
  if (summary.complete) {
    return { label: 'Complete', tone: 'green' };
  }

  if (!isWorkingDay(date) && !summary.morning && !summary.evening) {
    return { label: 'Off Day', tone: 'zinc' };
  }

  if (!summary.morning && isPastCutoff('morning', now)) {
    return { label: 'Missing Morning', tone: 'red' };
  }

  if (summary.morning && !summary.evening && isPastCutoff('evening', now)) {
    return { label: 'Missing Evening', tone: 'red' };
  }

  if (summary.morning && !summary.evening) {
    return { label: 'In Market', tone: 'amber' };
  }

  return { label: 'Pending', tone: 'zinc' };
};

const statusClasses = {
  green: 'border-green-500/30 bg-green-500/10 text-green-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  teal: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  red: 'border-red-500/30 bg-red-500/10 text-red-300',
  zinc: 'border-zinc-700 bg-zinc-900 text-zinc-300',
};

const getAttentionItems = (employees, readingsByEmployee, missingAlerts, date = today(), now = new Date()) => {
  const alertItems = missingAlerts.map((alert) => ({
    id: alert.id,
    tone: 'red',
    title: alert.title,
    description: `${alert.employee.name} | ${alert.employee.bikePlate}`,
    employee: alert.employee,
    message: alert.message,
    canWhatsApp: Boolean(normalizeWhatsAppPhone(alert.employee.phone)),
  }));

  const noPhoneItems = employees
    .filter((employee) => employee.active !== false && !normalizeWhatsAppPhone(employee.phone))
    .map((employee) => ({
      id: `${employee.id}-phone`,
      tone: 'amber',
      title: 'Phone Missing',
      description: `${employee.name} cannot receive WhatsApp reminders yet.`,
      employee,
      message: '',
      canWhatsApp: false,
    }));

  const invalidItems = employees
    .map((employee) => ({
      employee,
      summary: getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true }),
    }))
    .filter(({ employee, summary }) => employee.active !== false && summary.invalid)
    .map(({ employee }) => ({
      id: `${employee.id}-invalid-reading`,
      tone: 'red',
      title: 'Check Odometer',
      description: `${employee.name} has evening lower than morning today.`,
      employee,
      message: '',
      canWhatsApp: false,
    }));

  const waitingItems = employees
    .map((employee) => ({
      employee,
      summary: getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true }),
    }))
    .filter(({ employee, summary }) =>
      employee.active !== false &&
      summary.morning &&
      !summary.evening &&
      !isPastCutoff('evening', now)
    )
    .map(({ employee }) => ({
      id: `${employee.id}-in-market`,
      tone: 'amber',
      title: 'In Market',
      description: `${employee.name} submitted Morning Start; Evening End pending.`,
      employee,
      message: '',
      canWhatsApp: false,
    }));

  return [...alertItems, ...invalidItems, ...noPhoneItems, ...waitingItems];
};

const buildDailyCloseRows = ({
  employees,
  readingsByEmployee,
  config,
  routeSessions = [],
  routePoints = [],
  shopPins = [],
  routeDeviationEvents = [],
  dailyReviews = [],
  fuelPriceHistory = [],
  date = today(),
  now = new Date(),
}) => {
  const pointsBySession = groupRoutePointsBySession(routePoints);
  const reviewMap = buildDailyReviewMap(dailyReviews);

  return employees
    .filter((employee) => employee.active !== false)
    .map((employee) => {
      const daySummary = getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true });
      const routeSession = getRouteForDay(routeSessions, employee.id, date);
      const routeHealth = getRouteHealth({
        routeSession,
        routePoints: routeSession ? pointsBySession[routeSession.id] || [] : [],
        odometerKm: daySummary.distance,
      });
      const routePins = getShopPinsForRouteDay(shopPins, employee.id, date, routeSession?.id);
      const routeEvents = getDeviationEventsForRouteDay(routeDeviationEvents, employee.id, date, routeSession?.id);
      const outsideRouteEvents = routeEvents.filter((event) => event.eventType === 'outside_route');
      const routeReport = {
        pins: routePins,
        pinCount: routePins.length,
        firstPinAt: routePins[0]?.pinnedAt ?? null,
        lastPinAt: routePins.at(-1)?.pinnedAt ?? null,
        deviationEvents: routeEvents,
        deviationCount: routeEvents.length,
        outsideDeviationCount: outsideRouteEvents.length,
        lastDeviationAt: outsideRouteEvents.at(-1)?.recordedAt ?? null,
      };
      const review = reviewMap[getReviewKey(employee.id, date)] ?? null;
      const flags = getProblemFlags({ daySummary, routeHealth, review, now, date });
      if (routeReport.outsideDeviationCount > 0) {
        flags.push({
          id: 'route_deviation',
          label: `${routeReport.outsideDeviationCount} Route Alert${routeReport.outsideDeviationCount === 1 ? '' : 's'}`,
          tone: 'red',
        });
      }
      const mileage = Number(employee.mileage ?? config.defaultMileage);
      const fuelPrice = getFuelPriceForDate(date, fuelPriceHistory, config.fuelPrice);
      const fuelUsed = mileage > 0 && daySummary.complete ? daySummary.distance / mileage : 0;
      const fuelCost = fuelUsed * fuelPrice;
      const todayStatus = getRiderTodayStatus(daySummary, now, date);
      const displayStatus =
        review?.status ??
        (flags.some((flag) => flag.tone === 'red') ? 'problem' : daySummary.complete ? 'pending_review' : 'pending_review');

      return {
        employee,
        date,
        daySummary,
        routeSession,
        routeHealth,
        routeReport,
        review,
        flags,
        mileage,
        fuelPrice,
        fuelUsed,
        fuelCost,
        todayStatus,
        displayStatus,
      };
    });
};

const buildReadingsMap = (rows) =>
  rows.reduce((accumulator, row) => {
    accumulator[row.employeeId] = accumulator[row.employeeId] || [];
    accumulator[row.employeeId].push(row);
    return accumulator;
  }, {});

const buildFleetCSV = (employees, readingsByEmployee, config, selectedMonth, fuelPriceHistory = []) => {
  const workingDates = selectedMonth ? getDatesForMonth(selectedMonth, today(), { workingOnly: true }) : [];
  const rows = [
    [`FleetLine Fleet Report - ${selectedMonth || 'All time'}`],
    [`Generated: ${formatAppDateTime(new Date())}`],
    [`Fuel price: ${config.currency} ${config.fuelPrice}/L`],
    [`Working days: ${WORKING_DAYS_LABEL}; Sunday ignored`],
    [],
    ['Rider', 'Username', 'Bike Plate', 'Bike Model', 'Mileage (km/L)', 'Readings', 'Completed Days', 'Working Days', 'Missing Days', 'Partial Days', 'Monthly KM', 'Fuel (L)', `Monthly Fuel Cost (${config.currency})`],
  ];

  let grandKm = 0;
  let grandFuel = 0;
  let grandCost = 0;

  employees.forEach((employee) => {
    const mileage = Number(employee.mileage ?? config.defaultMileage);
    const readings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
      (reading) => !reading.queued && isWorkingDay(reading.date) && (!selectedMonth || monthKey(reading.date) === selectedMonth),
    );
    const summary = getMonthlySummary(readings, selectedMonth, mileage, config.fuelPrice, fuelPriceHistory);
    const workingSummaries = workingDates.map((date) => getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true }));
    const missingDays = workingSummaries.filter((day) => !day.morning && !day.evening).length;
    const incompleteDays = workingSummaries.filter((day) => (day.morning || day.evening) && !day.complete).length;

    grandKm += summary.totalKm;
    grandFuel += summary.fuelUsed;
    grandCost += summary.cost;

    rows.push([
      employee.name,
      employee.username,
      employee.bikePlate,
      employee.bikeModel || '',
      mileage,
      readings.length,
      summary.completedDays,
      workingDates.length || summary.completedDays,
      missingDays,
      incompleteDays,
      summary.totalKm,
      summary.fuelUsed.toFixed(2),
      summary.cost.toFixed(2),
    ]);
  });

  rows.push([]);
  rows.push(['FLEET TOTAL', '', '', '', '', '', '', '', '', '', grandKm, grandFuel.toFixed(2), grandCost.toFixed(2)]);
  return rows;
};

const buildEmployeeCSV = (employee, readingsByEmployee, config, selectedMonth, fuelPriceHistory = []) => {
  const mileage = Number(employee.mileage ?? config.defaultMileage);
  const readings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
    (reading) => !reading.queued && isWorkingDay(reading.date) && (!selectedMonth || monthKey(reading.date) === selectedMonth),
  );

  const rows = [
    [`FleetLine Report - ${employee.name} (${employee.bikePlate})`],
    [`Month: ${selectedMonth || 'All time'} | Generated: ${formatAppDateTime(new Date())}`],
    [`Mileage: ${mileage} km/L | Fuel price: ${config.currency} ${config.fuelPrice}/L`],
    [`Working days: ${WORKING_DAYS_LABEL}; Sunday ignored`],
    [],
    ['Date', 'Morning Odo', 'Evening Odo', 'Daily Distance (km)', 'Fuel Used (L)', `Cost (${config.currency})`, 'Status'],
  ];

  const dailySummaries = getMonthlySummary(readings, selectedMonth, mileage, config.fuelPrice, fuelPriceHistory).dailySummaries;

  dailySummaries.forEach((day) => {
    const distance = day.complete ? day.distance : 0;
    const fuel = mileage > 0 && day.complete ? distance / mileage : 0;
    const fuelPrice = getFuelPriceForDate(day.date, fuelPriceHistory, config.fuelPrice);
    const cost = fuel * fuelPrice;
    rows.push([
      day.date,
      day.morning?.km ?? '',
      day.evening?.km ?? '',
      distance,
      fuel.toFixed(2),
      cost.toFixed(2),
      day.invalid ? 'Check odometer: evening lower than morning' : day.complete ? `Complete @ ${config.currency} ${fuelPrice}/L` : 'Incomplete',
    ]);
  });

  return rows;
};

const buildDailyRouteCSV = (rows, date, config) => [
  [`FleetLine Daily Route Report - ${date}`],
  [`Generated: ${formatAppDateTime(new Date())}`],
  [],
  [
    'Rider',
    'Bike Plate',
    'Date',
    'Review Status',
    'Morning KM',
    'Evening KM',
    'Odometer KM',
    'GPS KM',
    'GPS Difference KM',
    'GPS Difference %',
    'GPS Points',
    'Shop Pins',
    'Route Alerts',
    `Fuel Cost (${config.currency})`,
    'Admin Notes',
  ],
  ...rows.map((row) => [
    row.employee.name,
    row.employee.bikePlate,
    row.date,
    REVIEW_STATUS[row.displayStatus]?.label ?? row.displayStatus,
    row.daySummary.morning?.km ?? '',
    row.daySummary.evening?.km ?? '',
    row.daySummary.complete ? row.daySummary.distance.toFixed(1) : '',
    row.routeHealth.gpsDistanceKm.toFixed(2),
    row.routeHealth.diffKm.toFixed(2),
    row.routeHealth.diffPct === null ? '' : row.routeHealth.diffPct.toFixed(1),
    row.routeHealth.pointCount,
    row.routeReport.pinCount,
    row.routeReport.outsideDeviationCount,
    Math.round(row.fuelCost),
    row.review?.notes ?? '',
  ]),
];

const ThemeStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=JetBrains+Mono:wght@400;500;700&family=Manrope:wght@400;500;600;700;800&display=swap');
    :root {
      --fleet-orange: var(--primary);
      --fleet-gold: var(--warning);
      --fleet-black: var(--ops-bg);
      --fleet-panel: var(--ops-panel);
      --fleet-border: rgba(217, 119, 6, 0.24);
    }
    .font-display { font-family: 'Bebas Neue', sans-serif; letter-spacing: 0.02em; }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
    .font-body { font-family: 'Manrope', sans-serif; }
    .grid-bg {
      background-image:
        radial-gradient(circle at 18% 8%, rgba(217, 119, 6, 0.16), transparent 24rem),
        radial-gradient(circle at 92% 18%, rgba(15, 118, 110, 0.12), transparent 22rem),
        linear-gradient(rgba(217,119,6,0.055) 1px, transparent 1px),
        linear-gradient(90deg, rgba(217,119,6,0.045) 1px, transparent 1px),
        linear-gradient(135deg, var(--ops-bg-deep), var(--ops-bg));
      background-size: 100% 100%, 100% 100%, 32px 32px, 32px 32px, 100% 100%;
    }
    .ticker-border { background: linear-gradient(90deg, var(--primary-dark), var(--primary), var(--warning), var(--accent)); }
    .glow-orange {
      box-shadow: 0 0 24px -4px rgba(217,119,6,0.48), inset 0 1px 0 rgba(255,253,247,0.14);
    }
    .app-logo-4d {
      filter:
        drop-shadow(0 14px 18px rgba(0,0,0,0.42))
        drop-shadow(0 0 18px rgba(217,119,6,0.26));
      transform: translateZ(24px);
      animation: logo-power-on 900ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .dashboard-3d {
      perspective: 1400px;
      perspective-origin: 50% 0%;
    }
    .surface-3d {
      position: relative;
      isolation: isolate;
      transform: translateZ(0);
      transform-style: preserve-3d;
      border-radius: 18px;
      background:
        linear-gradient(145deg, rgba(255,253,247,0.075), transparent 38%),
        linear-gradient(155deg, rgba(23,32,42,0.98), rgba(8,12,17,0.98));
      box-shadow:
        0 26px 56px rgba(0,0,0,0.36),
        0 7px 0 rgba(0,0,0,0.24),
        inset 0 1px 0 rgba(255,253,247,0.13),
        inset 0 -1px 0 rgba(0,0,0,0.45);
      overflow: hidden;
      transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
    }
    .surface-3d::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: -1;
      background:
        radial-gradient(circle at 20% 0%, rgba(217,119,6,0.18), transparent 34%),
        radial-gradient(circle at 96% 8%, rgba(15,118,110,0.12), transparent 30%);
      opacity: 0.9;
      pointer-events: none;
    }
    .surface-3d::after {
      content: '';
      position: absolute;
      inset: 1px;
      z-index: -1;
      border-radius: 17px;
      border: 1px solid rgba(255,253,247,0.06);
      pointer-events: none;
    }
    .hero-3d {
      background:
        linear-gradient(135deg, rgba(217,119,6,0.28), rgba(234,179,8,0.11) 42%, rgba(15,118,110,0.13)),
        linear-gradient(155deg, rgba(23,32,42,0.98), rgba(5,8,12,0.98));
      box-shadow:
        0 32px 68px rgba(0,0,0,0.42),
        0 10px 0 rgba(52, 28, 7, 0.42),
        inset 0 1px 0 rgba(255,253,247,0.16);
    }
    .surface-3d[class*="border-orange"],
    .surface-3d[class*="border-amber"] {
      background:
        linear-gradient(145deg, rgba(217,119,6,0.16), transparent 42%),
        linear-gradient(155deg, rgba(23,32,42,0.98), rgba(8,12,17,0.98));
    }
    .surface-3d[class*="border-red"] {
      background:
        linear-gradient(145deg, rgba(220,38,38,0.18), transparent 42%),
        linear-gradient(155deg, rgba(23,32,42,0.98), rgba(8,12,17,0.98));
    }
    .surface-3d[class*="border-green"] {
      background:
        linear-gradient(145deg, rgba(21,128,61,0.16), transparent 42%),
        linear-gradient(155deg, rgba(23,32,42,0.98), rgba(8,12,17,0.98));
    }
    .mini-surface-3d {
      border-radius: 14px;
      background: linear-gradient(145deg, rgba(255,253,247,0.08), rgba(5,8,12,0.56));
      box-shadow: inset 0 1px 0 rgba(255,253,247,0.1), 0 12px 22px rgba(0,0,0,0.24);
    }
    .button-3d {
      position: relative;
      isolation: isolate;
      overflow: hidden;
      border-radius: 14px;
      transform: translateY(0);
      box-shadow:
        0 11px 0 rgba(0,0,0,0.32),
        0 22px 34px rgba(0,0,0,0.34),
        inset 0 1px 0 rgba(255,253,247,0.28),
        inset 0 -1px 0 rgba(0,0,0,0.28);
      transition: transform 150ms ease, box-shadow 150ms ease, filter 150ms ease;
    }
    .button-3d::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: -1;
      background: linear-gradient(115deg, rgba(255,253,247,0.26), transparent 28%, rgba(255,253,247,0.08) 46%, transparent 66%);
      opacity: 0.95;
    }
    .button-3d::after {
      content: '';
      position: absolute;
      inset: -70% -35%;
      z-index: -1;
      background: linear-gradient(115deg, transparent 38%, rgba(255,253,247,0.34) 50%, transparent 62%);
      transform: translateX(-120%) rotate(8deg);
      opacity: 0;
      pointer-events: none;
    }
    .button-3d-primary {
      border: 1px solid rgba(254,243,199,0.48);
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 48%, #92400e 100%);
      color: #05080c;
    }
    .button-3d-outline {
      border: 1px solid rgba(245,158,11,0.56);
      background: linear-gradient(145deg, rgba(217,119,6,0.18), rgba(5,8,12,0.86));
      color: #fbbf24;
    }
    .button-3d-whatsapp {
      border: 1px solid rgba(220,252,231,0.38);
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      color: #fffdf7;
      box-shadow:
        0 11px 0 rgba(4, 79, 45, 0.48),
        0 22px 34px rgba(0,0,0,0.34),
        0 0 22px rgba(37,211,102,0.22),
        inset 0 1px 0 rgba(255,253,247,0.3);
    }
    .button-3d:active {
      transform: translateY(7px);
      box-shadow:
        0 4px 0 rgba(0,0,0,0.34),
        0 10px 18px rgba(0,0,0,0.28),
        inset 0 1px 0 rgba(255,253,247,0.18);
    }
    .button-3d:disabled {
      transform: none;
      box-shadow: inset 0 1px 0 rgba(255,253,247,0.1), 0 8px 18px rgba(0,0,0,0.2);
    }
    .bar-track-3d {
      border-radius: 999px;
      box-shadow: inset 0 2px 6px rgba(0,0,0,0.55);
    }
    .bar-fill-3d {
      border-radius: inherit;
      box-shadow: 0 0 18px rgba(217,119,6,0.34), inset 0 1px 0 rgba(255,253,247,0.35);
    }
    .route-map-3d {
      transform-style: preserve-3d;
      box-shadow:
        0 28px 80px rgba(0,0,0,0.46),
        0 9px 0 rgba(0,0,0,0.24),
        inset 0 1px 0 rgba(255,253,247,0.1);
    }
    .route-map-3d .maplibregl-canvas {
      filter: none;
    }
    .route-map-3d .maplibregl-ctrl-attrib {
      background: rgba(5, 8, 12, 0.78);
      color: rgba(255, 253, 247, 0.58);
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
    }
    .route-map-3d .maplibregl-ctrl-attrib a {
      color: #f59e0b;
    }
    .table-3d {
      border-radius: 18px;
      box-shadow: 0 24px 48px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,253,247,0.08);
    }
    .ops-ledger-shell {
      border-radius: 26px;
      background:
        linear-gradient(180deg, rgba(255,253,247,0.04), transparent 18%),
        radial-gradient(circle at top left, rgba(217,119,6,0.12), transparent 28rem),
        rgba(5,8,12,0.78);
      box-shadow:
        inset 0 1px 0 rgba(255,253,247,0.1),
        0 24px 70px rgba(0,0,0,0.44);
    }
    .ops-ledger-header {
      background:
        linear-gradient(90deg, rgba(217,119,6,0.2), rgba(217,119,6,0.06) 42%, rgba(15,118,110,0.08));
    }
    .ops-ledger-row {
      border-radius: 20px;
      background:
        radial-gradient(circle at 8% 50%, rgba(217,119,6,0.14), transparent 17rem),
        linear-gradient(135deg, rgba(23,32,42,0.96), rgba(5,8,12,0.94));
      box-shadow:
        inset 0 1px 0 rgba(255,253,247,0.08),
        0 14px 30px rgba(0,0,0,0.28);
    }
    .ops-ledger-row:hover {
      transform: translateY(-1px);
      box-shadow:
        inset 0 1px 0 rgba(255,253,247,0.1),
        0 18px 36px rgba(0,0,0,0.34),
        0 0 0 1px rgba(217,119,6,0.26);
    }
    .ops-metric-pill {
      border-radius: 16px;
      background:
        linear-gradient(180deg, rgba(255,253,247,0.05), rgba(255,253,247,0.01)),
        rgba(5,8,12,0.68);
      box-shadow: inset 0 1px 0 rgba(255,253,247,0.08);
    }
    .ledger-panel-3d {
      border-radius: 24px;
      background:
        radial-gradient(circle at top right, rgba(217,119,6,0.26), transparent 32rem),
        linear-gradient(155deg, rgba(23,32,42,0.98), rgba(8,12,17,0.98));
      box-shadow:
        0 32px 82px rgba(0,0,0,0.48),
        0 10px 0 rgba(0,0,0,0.2),
        inset 0 1px 0 rgba(255,253,247,0.12);
    }
    .ledger-row-3d {
      background:
        linear-gradient(90deg, rgba(217,119,6,0.06), transparent 42%),
        rgba(5,8,12,0.72);
      box-shadow: inset 0 1px 0 rgba(255,253,247,0.04);
    }
    .ledger-rider-avatar {
      background:
        linear-gradient(145deg, rgba(217,119,6,0.34), rgba(146,64,14,0.28)),
        rgba(5,8,12,0.78);
      box-shadow:
        inset 0 1px 0 rgba(255,253,247,0.16),
        0 12px 28px rgba(0,0,0,0.28),
        0 0 24px rgba(217,119,6,0.12);
    }
    .modal-backdrop {
      animation: modal-fade-in 180ms ease-out both;
    }
    .modal-shell {
      animation: modal-rise-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
      box-shadow: 0 30px 90px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,253,247,0.10);
    }
    .modal-scroll-area {
      scrollbar-width: thin;
      scrollbar-color: rgba(217,119,6,0.72) rgba(5,8,12,0.88);
    }
    .modal-scroll-area::-webkit-scrollbar {
      width: 8px;
    }
    .modal-scroll-area::-webkit-scrollbar-track {
      background: rgba(5,8,12,0.88);
    }
    .modal-scroll-area::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, #d97706, #92400e);
      border-radius: 999px;
      border: 2px solid rgba(5,8,12,0.88);
    }
    .photo-preview-zoom {
      animation: photo-zoom-in 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
      box-shadow: 0 26px 80px rgba(0,0,0,0.5), 0 0 30px rgba(217,119,6,0.16);
    }
    .route-live-card {
      box-shadow:
        0 28px 70px rgba(0,0,0,0.42),
        0 0 0 1px rgba(34,197,94,0.20),
        0 0 28px rgba(34,197,94,0.12),
        inset 0 1px 0 rgba(255,253,247,0.13);
      animation: route-card-breathe 2.8s ease-in-out infinite;
    }
    .route-icon-live {
      animation: route-icon-pulse 1.8s ease-in-out infinite;
    }
    .status-badge-alert {
      position: relative;
      overflow: hidden;
    }
    .status-badge-alert::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg, transparent, rgba(255,253,247,0.20), transparent);
      transform: translateX(-130%);
      animation: badge-scan 2.6s ease-in-out infinite;
      pointer-events: none;
    }
    .export-burst {
      animation: export-pop 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .export-burst::after {
      opacity: 1;
      animation: button-sheen 520ms ease-out both;
    }
    .toast-rise {
      animation: toast-rise 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @media (hover: hover) and (pointer: fine) {
      .lift-3d:hover,
      .surface-3d:hover {
        transform: translateY(-3px) rotateX(1.2deg);
        box-shadow:
          0 34px 68px rgba(0,0,0,0.42),
          0 9px 0 rgba(0,0,0,0.22),
          inset 0 1px 0 rgba(255,253,247,0.16);
      }
      .button-3d:hover:not(:disabled) {
        transform: translateY(-2px);
        filter: brightness(1.08);
      }
      .button-3d:active:not(:disabled) {
        transform: translateY(7px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .surface-3d,
      .lift-3d,
      .app-logo-4d,
      .route-live-card,
      .route-icon-live,
      .pulse-attention,
      .status-badge-alert,
      .export-burst,
      .toast-rise,
      .modal-backdrop,
      .modal-shell,
      .photo-preview-zoom,
      .ghost-card-pulse,
      .ghost-upload-orb,
      .skeleton-shimmer {
        transition: none;
        animation: none;
      }
      .lift-3d:hover,
      .surface-3d:hover {
        transform: none;
      }
    }
    .bg-black\\/95, .bg-black\\/80, .bg-black\\/50, .bg-black\\/40 { backdrop-filter: blur(16px); }
    .border-zinc-800, .border-zinc-900 { border-color: var(--ops-border); }
    .shadow-2xl { box-shadow: 0 24px 60px rgba(0,0,0,0.38); }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    @keyframes pulse-orange {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    .pulse-dot { animation: pulse-orange 1.5s ease-in-out infinite; }
    @keyframes pulse-attention {
      0%, 100% { box-shadow: 0 0 0 0 rgba(217,119,6,0.0); }
      50% { box-shadow: 0 0 0 6px rgba(217,119,6,0.18); }
    }
    .pulse-attention { animation: pulse-attention 2.2s ease-in-out infinite; }
    @keyframes logo-power-on {
      0% { opacity: 0; transform: translateZ(24px) scale(0.92) rotateX(10deg); filter: drop-shadow(0 0 0 rgba(217,119,6,0)); }
      45% { opacity: 1; transform: translateZ(24px) scale(1.05) rotateX(0deg); filter: drop-shadow(0 0 24px rgba(217,119,6,0.48)); }
      100% {
        opacity: 1;
        transform: translateZ(24px) scale(1);
        filter: drop-shadow(0 14px 18px rgba(0,0,0,0.42)) drop-shadow(0 0 18px rgba(217,119,6,0.26));
      }
    }
    @keyframes modal-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes modal-rise-in {
      from { opacity: 0; transform: translateY(20px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes photo-zoom-in {
      from { opacity: 0; transform: scale(0.96); filter: blur(2px); }
      to { opacity: 1; transform: scale(1); filter: blur(0); }
    }
    @keyframes route-card-breathe {
      0%, 100% { border-color: rgba(34,197,94,0.28); }
      50% { border-color: rgba(245,158,11,0.42); box-shadow: 0 30px 76px rgba(0,0,0,0.44), 0 0 32px rgba(34,197,94,0.16), inset 0 1px 0 rgba(255,253,247,0.14); }
    }
    @keyframes route-icon-pulse {
      0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(34,197,94,0)); }
      50% { transform: scale(1.08); filter: drop-shadow(0 0 12px rgba(34,197,94,0.36)); }
    }
    @keyframes badge-scan {
      0%, 64% { transform: translateX(-130%); }
      100% { transform: translateX(130%); }
    }
    @keyframes button-sheen {
      from { transform: translateX(-120%) rotate(8deg); }
      to { transform: translateX(120%) rotate(8deg); }
    }
    @keyframes export-pop {
      0% { transform: translateY(0) scale(1); }
      35% { transform: translateY(-3px) scale(1.08); }
      100% { transform: translateY(0) scale(1); }
    }
    @keyframes toast-rise {
      from { opacity: 0; transform: translateY(-8px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes fade-up {
      0% { opacity: 0; transform: translateY(8px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    .fade-up {
      animation: fade-up 380ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @media (prefers-reduced-motion: reduce) {
      .fade-up { animation: none; }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes ghost-pulse {
      0%, 100% { opacity: 0.58; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.01); }
    }
    .skeleton-shimmer {
      background:
        linear-gradient(90deg, rgba(255,253,247,0.04) 0%, rgba(217,119,6,0.10) 48%, rgba(255,253,247,0.04) 100%),
        linear-gradient(155deg, rgba(23,32,42,0.95), rgba(8,12,17,0.95));
      background-size: 200% 100%, 100% 100%;
      animation: shimmer 1.6s linear infinite, ghost-pulse 1.9s ease-in-out infinite;
      border-radius: 14px;
    }
    .ghost-card-pulse {
      animation: ghost-pulse 1.7s ease-in-out infinite;
    }
    .ghost-upload-orb {
      border-radius: 999px;
      background:
        radial-gradient(circle at 35% 20%, rgba(255,253,247,0.18), transparent 28%),
        linear-gradient(145deg, rgba(217,119,6,0.28), rgba(8,12,17,0.88));
      box-shadow: 0 0 34px rgba(217,119,6,0.24), inset 0 1px 0 rgba(255,253,247,0.14);
      animation: ghost-pulse 1.4s ease-in-out infinite;
    }
    .odo-window {
      display: inline-block;
      overflow: hidden;
      vertical-align: top;
    }
    .odo-strip {
      transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
      will-change: transform;
    }
    .odo-strip > span {
      display: block;
      text-align: center;
    }
    @media (prefers-reduced-motion: reduce) {
      .odo-strip { transition: none; }
    }
    input:focus, textarea:focus, select:focus { outline: none; }
    .field-focus:focus {
      background-color: rgba(217, 119, 6, 0.06);
      box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.55);
    }
    .empty-state {
      border: 2px dashed rgba(245, 158, 11, 0.32);
      background:
        linear-gradient(160deg, rgba(217,119,6,0.06), transparent 55%),
        linear-gradient(155deg, rgba(23,32,42,0.92), rgba(8,12,17,0.92));
      border-radius: 18px;
      box-shadow:
        inset 0 1px 0 rgba(255,253,247,0.06),
        0 18px 38px rgba(0,0,0,0.32);
    }
    .empty-state .empty-icon {
      filter: drop-shadow(0 0 18px rgba(217,119,6,0.35));
    }
    .stat-tone-orange { background: linear-gradient(155deg, rgba(217,119,6,0.10), rgba(8,12,17,0.96)); }
    .stat-tone-gold { background: linear-gradient(155deg, rgba(234,179,8,0.10), rgba(8,12,17,0.96)); }
    .stat-tone-teal { background: linear-gradient(155deg, rgba(15,118,110,0.12), rgba(8,12,17,0.96)); }
    .stat-tone-white { background: linear-gradient(155deg, rgba(255,253,247,0.06), rgba(8,12,17,0.96)); }
  `}</style>
);

const Toast = ({ toast }) => {
  if (!toast) return null;

  const tones = {
    success: 'border-green-500/40 text-green-300',
    error: 'border-red-500/40 text-red-300',
    info: 'border-amber-500/40 text-amber-300',
  };

  return (
    <div className="fixed left-1/2 top-4 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
      <div className={`toast-rise bg-black/95 backdrop-blur border ${tones[toast.tone] || tones.info} px-4 py-3 shadow-2xl`}>
        <div className="font-mono text-xs uppercase tracking-widest">{toast.message}</div>
      </div>
    </div>
  );
};

const BrandHeader = ({ onLogout, userName, subtitle }) => (
  <div className="sticky top-0 z-30 border-b border-orange-500/20 bg-black/95 shadow-2xl backdrop-blur">
    <div className="h-1 ticker-border"></div>
    <div className="flex items-center justify-between px-5 py-3">
      <div className="flex items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center">
          <img src="/icons/icon.svg" alt="FleetLine logo" className="app-logo-4d h-10 w-10 object-contain" />
        </div>
        <div>
          <div className="font-display text-xl leading-none text-orange-500">FLEETLINE</div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">
            {subtitle || 'Control'}
          </div>
        </div>
      </div>
      {userName ? (
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase text-amber-500/60">Signed in</div>
            <div className="max-w-[140px] truncate font-body text-sm text-white">{userName}</div>
          </div>
          <button
            onClick={onLogout}
            className="mini-surface-3d flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 transition-colors hover:border-orange-500/60 hover:bg-orange-500/10"
          >
            <LogOut className="h-4 w-4 text-orange-500" />
          </button>
        </div>
      ) : null}
    </div>
  </div>
);

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const parseAnimatedValue = (value) => {
  if (typeof value === 'number') {
    return { num: value, decimals: 0, useCommas: false };
  }
  const str = String(value ?? '');
  const decimalMatch = str.match(/\.(\d+)/);
  const decimals = decimalMatch ? decimalMatch[1].length : 0;
  const useCommas = /\d{1,3}(,\d{3})+/.test(str);
  const cleaned = str.replace(/,/g, '');
  const num = Number(cleaned);
  return {
    num: Number.isFinite(num) ? num : 0,
    decimals,
    useCommas,
  };
};

const formatAnimatedValue = (n, { decimals, useCommas }) => {
  const fixed = decimals > 0 ? n.toFixed(decimals) : Math.round(n).toString();
  if (!useCommas) return fixed;
  const [whole, frac] = fixed.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${withCommas}.${frac}` : withCommas;
};

const AnimatedCounter = ({ value, duration = 850 }) => {
  const target = useMemo(() => parseAnimatedValue(value), [value]);
  const [display, setDisplay] = useState(target.num);
  const previousRef = useRef(target.num);

  useEffect(() => {
    const start = previousRef.current;
    const end = target.num;
    previousRef.current = end;
    if (prefersReducedMotion() || start === end) {
      setDisplay(end);
      return undefined;
    }
    const startTime = performance.now();
    let raf;
    const tick = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(start + (end - start) * eased);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => raf && cancelAnimationFrame(raf);
  }, [target.num, duration]);

  return <>{formatAnimatedValue(display, target)}</>;
};

const Odometer = ({ value, length = 5, className = '' }) => {
  const digits = String(value ?? '0').padStart(length, '0').slice(-length).split('');
  return (
    <div className={`inline-flex select-none ${className}`} aria-hidden="true">
      {digits.map((digit, index) => {
        const numericDigit = Number.isNaN(Number(digit)) ? 0 : Number(digit);
        return (
          <span key={index} className="odo-window relative leading-none" style={{ height: '1em', width: '0.62em' }}>
            <span className="odo-strip flex flex-col" style={{ transform: `translateY(-${numericDigit * 10}%)`, height: '1000%' }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                <span key={d} style={{ height: '10%' }}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
};

const SkeletonCard = ({ className = 'h-24' }) => (
  <div className={`skeleton-shimmer ${className}`} />
);

const StatCard = ({ label, value, unit, icon: Icon, accent = 'orange' }) => {
  const colors = {
    orange: 'text-orange-500 border-orange-500/30 stat-tone-orange',
    gold: 'text-amber-400 border-amber-400/30 stat-tone-gold',
    teal: 'text-teal-300 border-teal-500/30 stat-tone-teal',
    white: 'text-white border-zinc-700 stat-tone-white',
  };
  const [textColor, borderColor, toneClass] = (colors[accent] ?? colors.orange).split(' ');
  const isAnimatable = (() => {
    if (value == null) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return /^[\d.,]+$/.test(value.trim());
    return false;
  })();

  return (
    <div className={`surface-3d relative overflow-hidden border p-4 ${borderColor} ${toneClass}`}>
      <div className="absolute right-0 top-0 h-16 w-16 opacity-10">
        <Icon className={`h-full w-full ${textColor}`} />
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${textColor}`} />
        <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">{label}</div>
      </div>
      <div className="flex items-baseline gap-1.5">
        <div className={`font-display text-3xl leading-none tabular-nums ${textColor}`}>
          {isAnimatable ? <AnimatedCounter value={value} /> : value}
        </div>
        {unit ? <div className="font-mono text-[10px] uppercase text-zinc-500">{unit}</div> : null}
      </div>
    </div>
  );
};

const StatusBadge = ({ label, tone = 'zinc' }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${statusClasses[tone] ?? statusClasses.zinc} ${['red', 'amber'].includes(tone) ? 'status-badge-alert' : ''}`}>
    {label}
  </span>
);

const BarChart = ({ rows, valueLabel = (value) => fmtNum(Math.round(value)), emptyText = 'No chart data yet.' }) => {
  const maxValue = Math.max(0, ...rows.map((row) => Number(row.value) || 0));

  if (!rows.length || maxValue <= 0) {
    return (
      <div className="empty-state p-6 text-center">
        <BarChart3 className="empty-icon mx-auto mb-2 h-8 w-8 text-orange-500/80" />
        <div className="text-sm text-zinc-400">{emptyText}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const width = Math.max(4, Math.round((Number(row.value) / maxValue) * 100));
        return (
          <div key={row.label}>
            <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10px] uppercase">
              <span className="truncate text-zinc-400">{row.label}</span>
              <span className="text-amber-400">{valueLabel(row.value)}</span>
            </div>
            <div className="bar-track-3d h-2 overflow-hidden bg-zinc-900">
              <div className="bar-fill-3d h-full bg-gradient-to-r from-orange-500 to-amber-400" style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

const updateRouteMapData = (map, points, maplibre, options = {}) => {
  const lineSource = map.getSource('route-line');
  const pointSource = map.getSource('route-points');
  if (!lineSource || !pointSource) return;

  lineSource.setData(buildRouteLineData(points, ROUTE_RENDER_LINE_LIMIT));
  pointSource.setData(buildRoutePointData(points, ROUTE_RENDER_MARKER_LIMIT));

  const { fit = false, follow = false } = options;
  const lastPoint = points.at(-1);

  if (!lastPoint || (!fit && !follow)) return;

  if (points.length === 1) {
    map.easeTo({ center: [lastPoint.lng, lastPoint.lat], zoom: 15, pitch: 52, bearing: -18, duration: 350 });
    return;
  }

  if (fit && maplibre) {
    const bounds = new maplibre.LngLatBounds();
    thinRoutePoints(points, ROUTE_RENDER_LINE_LIMIT).forEach((point) => bounds.extend([point.lng, point.lat]));
    map.fitBounds(bounds, { padding: 44, maxZoom: 16, duration: 420 });
    return;
  }

  if (follow) {
    map.easeTo({ center: [lastPoint.lng, lastPoint.lat], duration: 260, essential: false });
  }
};

const RouteMap = ({ points, session, employee }) => {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const maplibreRef = useRef(null);
  const updateFrameRef = useRef(null);
  const fittedRouteRef = useRef({ sessionId: null, pointCount: 0, lastPointKey: '' });
  const [mapStatus, setMapStatus] = useState('loading');
  const [roadMatch, setRoadMatch] = useState({
    status: 'raw',
    provider: 'raw',
    points: [],
    message: 'Using clean GPS route.',
  });
  const routePoints = useMemo(() => sortRoutePoints(points), [points]);
  const cleanRoutePoints = useMemo(() => filterNoisyRoutePoints(routePoints), [routePoints]);
  const displayRoutePoints = roadMatch.status === 'matched' && roadMatch.points.length > 1
    ? roadMatch.points
    : cleanRoutePoints;
  const routeDistance = session?.totalDistanceM || calculateRouteDistanceM(displayRoutePoints);
  const visiblePointCount = cleanRoutePoints.length || session?.pointCount || 0;
  const lastPoint = displayRoutePoints.at(-1);
  const lastPointKey = lastPoint
    ? `${lastPoint.recordedAt}:${Number(lastPoint.lat).toFixed(7)}:${Number(lastPoint.lng).toFixed(7)}`
    : '';
  const roadMatchBucket = Math.floor(cleanRoutePoints.length / 20);
  const roadMatchKey = cleanRoutePoints.length
    ? session?.status === 'active'
      ? `${session?.id ?? 'route'}:active:${roadMatchBucket}`
      : `${session?.id ?? 'route'}:${session?.status ?? 'route'}:${cleanRoutePoints.length}:${cleanRoutePoints.at(-1)?.recordedAt}:${Number(cleanRoutePoints.at(-1)?.lat).toFixed(7)}:${Number(cleanRoutePoints.at(-1)?.lng).toFixed(7)}`
    : '';

  useEffect(() => {
    if (cleanRoutePoints.length < 3) {
      setRoadMatch({
        status: 'raw',
        provider: 'raw',
        points: [],
        message: cleanRoutePoints.length ? 'Collecting more GPS points for road matching.' : 'No clean GPS points yet.',
      });
      return undefined;
    }

    const controller = new AbortController();
    setRoadMatch((current) => ({
      ...current,
      status: current.points.length > 1 ? 'matched' : 'matching',
      message: current.points.length > 1 ? current.message : 'Matching route to roads.',
    }));

    matchRouteToRoad(cleanRoutePoints, { signal: controller.signal })
      .then((result) => {
        setRoadMatch({
          status: result.provider === 'raw' ? 'raw' : 'matched',
          provider: result.provider,
          points: result.provider === 'raw' ? [] : result.points,
          message: result.message,
        });
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        setRoadMatch({
          status: 'error',
          provider: 'raw',
          points: [],
          message: error instanceof Error ? error.message : 'Road matching failed.',
        });
      });

    return () => controller.abort();
  }, [roadMatchKey]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;

    let cancelled = false;

    const initMap = async () => {
      try {
        const timeout = window.setTimeout(() => {
          if (!cancelled) {
            setMapStatus('error');
          }
        }, ROUTE_MAP_LOAD_TIMEOUT_MS);
        const maplibre = await loadMaplibre();
        if (cancelled || !containerRef.current) {
          window.clearTimeout(timeout);
          return;
        }

        maplibreRef.current = maplibre;
        const initialPoint = displayRoutePoints[0];
        const map = new maplibre.Map({
          container: containerRef.current,
          style: ROUTE_MAP_STYLE,
          center: initialPoint ? [initialPoint.lng, initialPoint.lat] : ROUTE_MAP_FALLBACK_CENTER,
          zoom: initialPoint ? 15 : 10,
          pitch: 52,
          bearing: -18,
          attributionControl: false,
          fadeDuration: 0,
          refreshExpiredTiles: false,
          renderWorldCopies: false,
          interactive: false,
          dragRotate: false,
          pitchWithRotate: false,
          canvasContextAttributes: {
            antialias: false,
            powerPreference: 'low-power',
          },
        });

        mapRef.current = map;
        map.addControl(new maplibre.AttributionControl({ compact: true }), 'bottom-right');

        map.once('load', () => {
          if (cancelled) return;
          window.clearTimeout(timeout);

          map.addSource('route-line', {
            type: 'geojson',
            data: buildRouteLineData([], ROUTE_RENDER_LINE_LIMIT),
          });
          map.addSource('route-points', {
            type: 'geojson',
            data: buildRoutePointData([], ROUTE_RENDER_MARKER_LIMIT),
          });
          map.addLayer({
            id: 'route-line-glow',
            type: 'line',
            source: 'route-line',
            paint: {
              'line-color': '#f59e0b',
              'line-width': 9,
              'line-opacity': 0.2,
              'line-blur': 4,
            },
          });
          map.addLayer({
            id: 'route-line-main',
            type: 'line',
            source: 'route-line',
            paint: {
              'line-color': '#d97706',
              'line-width': 4,
              'line-opacity': 0.95,
            },
          });
          map.addLayer({
            id: 'route-points',
            type: 'circle',
            source: 'route-points',
            paint: {
              'circle-radius': ['case', ['==', ['get', 'kind'], 'live'], 7, ['==', ['get', 'kind'], 'start'], 6, 3],
              'circle-color': ['case', ['==', ['get', 'kind'], 'start'], '#22c55e', ['==', ['get', 'kind'], 'live'], '#ef4444', '#f59e0b'],
              'circle-stroke-color': '#fffdf7',
              'circle-stroke-width': 1.5,
            },
          });
          updateRouteMapData(map, displayRoutePoints, maplibre, { fit: true });
          fittedRouteRef.current = { sessionId: session?.id ?? null, pointCount: displayRoutePoints.length, lastPointKey };
          setMapStatus('ready');
        });

        map.on('error', (event) => {
          console.warn('[route-map] map error', event?.error || event);
          window.clearTimeout(timeout);
          if (!cancelled) setMapStatus('error');
        });
      } catch (error) {
        console.error(error);
        if (!cancelled) setMapStatus('error');
      }
    };

    initMap();

    return () => {
      cancelled = true;
      if (updateFrameRef.current) {
        window.cancelAnimationFrame(updateFrameRef.current);
      }
      mapRef.current?.remove();
      mapRef.current = null;
      maplibreRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const maplibre = maplibreRef.current;
    if (!map || !maplibre || !map.isStyleLoaded() || !map.getSource('route-line')) return undefined;

    if (updateFrameRef.current) {
      window.cancelAnimationFrame(updateFrameRef.current);
    }

    updateFrameRef.current = window.requestAnimationFrame(() => {
      const previous = fittedRouteRef.current;
      const sameSession = previous.sessionId === (session?.id ?? null);
      const pointDelta = Math.abs(displayRoutePoints.length - previous.pointCount);
      const latestChanged = lastPointKey && lastPointKey !== previous.lastPointKey;
      const shouldFit = !sameSession || previous.pointCount === 0 || pointDelta >= ROUTE_REFIT_POINT_DELTA;
      const shouldFollow = sameSession && session?.status === 'active' && latestChanged;

      updateRouteMapData(map, displayRoutePoints, maplibre, { fit: shouldFit, follow: shouldFollow });
      fittedRouteRef.current = { sessionId: session?.id ?? null, pointCount: displayRoutePoints.length, lastPointKey };
    });

    return () => {
      if (updateFrameRef.current) {
        window.cancelAnimationFrame(updateFrameRef.current);
      }
    };
  }, [displayRoutePoints, lastPointKey, session?.id, session?.status]);

  return (
    <div className="route-map-3d surface-3d relative overflow-hidden border border-orange-500/30 bg-zinc-950">
      <div ref={containerRef} className="h-[360px] w-full" />
      {mapStatus === 'loading' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/65 p-8 text-center backdrop-blur-sm">
          <div>
            <div className="ghost-pulse mx-auto mb-4 h-16 w-16 border border-orange-500/30 bg-orange-500/10" />
            <div className="font-display text-2xl text-white">Preparing Route Map</div>
            <div className="mt-1 text-sm text-zinc-500">Loading the 3D map only when you need it.</div>
          </div>
        </div>
      ) : null}
      {mapStatus === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/75 p-8 text-center">
          <div>
            <MapPin className="mx-auto mb-3 h-10 w-10 text-orange-500" />
            <div className="font-display text-2xl text-white">Map Could Not Load</div>
            <div className="mt-1 text-sm text-zinc-500">Route data is safe. Check internet speed and reopen this route.</div>
          </div>
        </div>
      ) : null}
      {displayRoutePoints.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-8 text-center">
          <div>
            <MapPin className="mx-auto mb-3 h-10 w-10 text-zinc-600" />
            <div className="font-display text-2xl text-white">{visiblePointCount > 0 ? 'Loading GPS Points' : 'No GPS Points Yet'}</div>
            <div className="mt-1 text-sm text-zinc-500">
              {visiblePointCount > 0
                ? 'Opening the selected route without loading every rider route at once.'
                : 'The route line appears as soon as the rider sends location points.'}
            </div>
          </div>
        </div>
      ) : null}
      <div className="pointer-events-none absolute left-3 right-3 top-3 flex flex-wrap gap-2">
        <div className="mini-surface-3d border border-orange-500/30 bg-black/80 px-3 py-2">
          <div className="font-mono text-[9px] uppercase text-zinc-500">Rider</div>
          <div className="font-display text-xl leading-none text-white">{employee?.name || 'Route'}</div>
        </div>
        <div className="mini-surface-3d border border-amber-400/30 bg-black/80 px-3 py-2">
          <div className="font-mono text-[9px] uppercase text-zinc-500">GPS Distance</div>
          <div className="font-display text-xl leading-none text-amber-400">{fmtDistance(routeDistance)}</div>
        </div>
        <div className="mini-surface-3d border border-zinc-700 bg-black/80 px-3 py-2">
          <div className="font-mono text-[9px] uppercase text-zinc-500">Points</div>
          <div className="font-display text-xl leading-none text-white">{visiblePointCount}</div>
        </div>
        <div className={`mini-surface-3d border bg-black/80 px-3 py-2 ${roadMatch.status === 'matched' ? 'border-green-400/30' : roadMatch.status === 'matching' ? 'border-amber-400/30' : 'border-zinc-700'}`}>
          <div className="font-mono text-[9px] uppercase text-zinc-500">Road Match</div>
          <div className={`font-display text-xl leading-none ${roadMatch.status === 'matched' ? 'text-green-300' : roadMatch.status === 'matching' ? 'text-amber-300' : 'text-zinc-300'}`}>
            {roadMatch.status === 'matched' ? 'On Road' : roadMatch.status === 'matching' ? 'Matching' : 'Raw'}
          </div>
        </div>
      </div>
      {lastPoint ? (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 mini-surface-3d border border-zinc-700 bg-black/85 px-3 py-2 font-mono text-[10px] uppercase text-zinc-400">
          Last GPS: {fmtTime(lastPoint.recordedAt)}
          {` | Lat ${fmtCoordinate(lastPoint.lat)} | Lng ${fmtCoordinate(lastPoint.lng)}`}
          {lastPoint.accuracyM ? ` | Accuracy ${Math.round(lastPoint.accuracyM)}m` : ''}
          {` | ${roadMatch.message}`}
        </div>
      ) : null}
    </div>
  );
};

const RouteSessionCard = ({ session, employee, points, selected, deleting, onSelect, onDelete }) => {
  const stale = session.status === 'active' && (!session.lastPointAt || Date.now() - new Date(session.lastPointAt).getTime() > ROUTE_STALE_AFTER_MS);
  const distance = session.totalDistanceM || calculateRouteDistanceM(points);
  const pointCount = session.pointCount || points.length;
  const tone = session.status === 'active' ? (stale ? 'amber' : 'green') : 'zinc';

  return (
    <div className={`surface-3d lift-3d border p-3 transition-colors ${
      selected ? 'border-orange-500 bg-orange-500/10' : 'border-zinc-800 bg-zinc-950 hover:border-orange-500/50'
    }`}>
      <div className="flex items-start gap-3">
        <button
          onClick={onSelect}
          className={`flex h-10 w-10 shrink-0 items-center justify-center border ${statusClasses[tone]}`}
        >
          <Route className="h-5 w-5" />
        </button>
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <div className="truncate font-semibold text-white">{employee?.name || 'Unknown rider'}</div>
          <div className="font-mono text-[10px] uppercase text-zinc-500">
            {fmtDate(session.date)} | {session.status}
          </div>
          <div className="mt-1 font-mono text-[9px] uppercase text-zinc-600">
            {pointCount} points | {fmtDistance(distance)}
          </div>
        </button>
        {session.status === 'active' ? (
          <div className={`h-2.5 w-2.5 rounded-full ${stale ? 'bg-amber-400' : 'bg-green-400 pulse-dot'}`} />
        ) : null}
        <button
          onClick={onDelete}
          disabled={deleting}
          className="mini-surface-3d border border-red-500/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? 'DELETING' : 'DELETE'}
        </button>
      </div>
    </div>
  );
};

const LiveRiderMap = ({ employees, routeSessions, routePoints, liveRiderLocations = [], onLoadRoutePoints, onSelectEmployee }) => {
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const pointsBySession = useMemo(() => groupRoutePointsBySession(routePoints), [routePoints]);
  const todayRoutes = useMemo(
    () => [
      ...routeSessions
        .filter((session) => session.date === today() && ['active', 'completed'].includes(session.status))
        .filter((session) => !session.isLiveOnly),
      ...buildLiveOnlyRouteSessions(liveRiderLocations, routeSessions),
    ].sort((left, right) => {
          const leftActive = left.status === 'active' ? 1 : 0;
          const rightActive = right.status === 'active' ? 1 : 0;
          if (leftActive !== rightActive) return rightActive - leftActive;
          const leftTime = new Date(left.lastPointAt || left.startedAt || left.createdAt || 0).getTime();
          const rightTime = new Date(right.lastPointAt || right.startedAt || right.createdAt || 0).getTime();
          return rightTime - leftTime;
        }),
    [liveRiderLocations, routeSessions],
  );
  const activeRoutes = todayRoutes.filter((session) => session.status === 'active');
  const todayRouteKey = todayRoutes.map((session) => session.id).join('|');
  const activeRouteLoadKey = activeRoutes
    .map((session) => `${session.id}:${session.pointCount}:${session.lastPointAt || ''}:${pointsBySession[session.id]?.length ?? 0}`)
    .join('|');
  const selectedSession = todayRoutes.find((session) => session.id === selectedSessionId) ?? todayRoutes[0] ?? null;
  const selectedEmployee = selectedSession
    ? employees.find((employee) => employee.id === selectedSession.employeeId)
    : null;
  const selectedPoints = selectedSession ? pointsBySession[selectedSession.id] || [] : [];
  const selectedLiveLocation = getLiveLocationForSession(liveRiderLocations, selectedSession);
  const sortedSelectedPoints = useMemo(
    () => mergeSessionLatestPoint(selectedPoints, selectedSession, selectedLiveLocation),
    [selectedPoints, selectedSession, selectedLiveLocation],
  );
  const lastPoint = sortedSelectedPoints.at(-1);
  const selectedPointCount = selectedSession?.pointCount || selectedPoints.length || (lastPoint ? 1 : 0);
  const stale =
    selectedSession?.status === 'active' &&
    (!lastPoint?.recordedAt || Date.now() - new Date(lastPoint.recordedAt).getTime() > ROUTE_STALE_AFTER_MS);

  useEffect(() => {
    if (!todayRoutes.length) {
      if (selectedSessionId) setSelectedSessionId(null);
      return;
    }

    if (!selectedSessionId || !todayRoutes.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(todayRoutes[0].id);
    }
  }, [selectedSessionId, todayRouteKey]);

  useEffect(() => {
    if (!onLoadRoutePoints) return;

    activeRoutes
      .filter((session) => !session.isLiveOnly)
      .filter((session) => (session.pointCount ?? 0) > (pointsBySession[session.id]?.length ?? 0))
      .slice(0, 6)
      .forEach((session) => onLoadRoutePoints(session.id));

    if (
      selectedSession &&
      !selectedSession.isLiveOnly &&
      (selectedSession.pointCount ?? 0) > (pointsBySession[selectedSession.id]?.length ?? 0)
    ) {
      onLoadRoutePoints(selectedSession.id);
    }
  }, [activeRouteLoadKey, onLoadRoutePoints, selectedSession?.id, selectedSession?.pointCount]);

  return (
    <div className="surface-3d border border-green-500/25 bg-zinc-950/95 p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-green-300/80">// Live Rider GPS</div>
          <div className="font-display text-3xl leading-none text-white">Live Rider Map</div>
          <div className="mt-1 text-xs text-zinc-500">
            Shows rider live location first. Route history appears after the Start Market session syncs.
          </div>
        </div>
        <div className="flex gap-2">
          <div className="ops-metric-pill min-w-[84px] border border-green-400/20 px-3 py-2 text-right">
            <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">active</div>
            <div className="font-display text-2xl leading-none text-green-300">{activeRoutes.length}</div>
          </div>
          <div className="ops-metric-pill min-w-[84px] border border-amber-400/20 px-3 py-2 text-right">
            <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">today</div>
            <div className="font-display text-2xl leading-none text-amber-300">{todayRoutes.length}</div>
          </div>
        </div>
      </div>

      {todayRoutes.length === 0 ? (
        <div className="empty-state p-8 text-center">
          <MapPin className="empty-icon mx-auto mb-3 h-10 w-10 text-orange-500/80" />
          <div className="font-display text-2xl text-white">No Rider GPS Yet</div>
          <div className="mt-1 text-sm text-zinc-500">
            Ask a rider to login, press Start Market, and allow location. GPS points appear here after sync.
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <RouteMap session={selectedSession} employee={selectedEmployee} points={sortedSelectedPoints} />

          <div className="space-y-3">
            <div className={`mini-surface-3d border p-3 ${stale ? 'border-amber-400/30 bg-amber-500/10' : 'border-green-400/25 bg-black/45'}`}>
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => selectedEmployee && onSelectEmployee?.(selectedEmployee.id)}
                  className="min-w-0 text-left"
                >
                  <div className="truncate font-display text-2xl leading-none text-white">
                    {selectedEmployee?.name || 'Unknown rider'}
                  </div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    {selectedEmployee?.bikePlate || 'No plate'} | {selectedSession.isLiveOnly ? 'live only' : selectedSession.status}
                  </div>
                </button>
                <div className={`h-2.5 w-2.5 rounded-full ${selectedSession.status === 'active' && !stale ? 'bg-green-400 pulse-dot' : stale ? 'bg-amber-400' : 'bg-zinc-500'}`} />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="border border-zinc-800 bg-black/50 p-2">
                  <div className="font-mono text-[8px] uppercase text-zinc-500">Latitude</div>
                  <div className="font-mono text-xs text-white">{fmtCoordinate(lastPoint?.lat)}</div>
                </div>
                <div className="border border-zinc-800 bg-black/50 p-2">
                  <div className="font-mono text-[8px] uppercase text-zinc-500">Longitude</div>
                  <div className="font-mono text-xs text-white">{fmtCoordinate(lastPoint?.lng)}</div>
                </div>
                <div className="border border-zinc-800 bg-black/50 p-2">
                  <div className="font-mono text-[8px] uppercase text-zinc-500">Last Fix</div>
                  <div className="font-mono text-xs text-white">{fmtTime(lastPoint?.recordedAt || selectedSession.lastPointAt)}</div>
                </div>
                <div className="border border-zinc-800 bg-black/50 p-2">
                  <div className="font-mono text-[8px] uppercase text-zinc-500">Points</div>
                  <div className="font-mono text-xs text-white">{selectedPointCount}</div>
                </div>
              </div>

              {stale ? (
                <div className="mt-3 border border-amber-400/25 bg-amber-500/10 p-2 font-mono text-[9px] uppercase leading-4 text-amber-200">
                  No recent GPS point. Rider phone may be offline, app closed, or permission blocked.
                </div>
              ) : null}
            </div>

            <div>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">Today Riders</div>
              <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {todayRoutes.map((session) => {
                  const employee = employees.find((row) => row.id === session.employeeId);
                  const points = pointsBySession[session.id] || [];
                  const routeLastPoint = mergeSessionLatestPoint(
                    points,
                    session,
                    getLiveLocationForSession(liveRiderLocations, session),
                  ).at(-1);
                  const isSelected = selectedSession?.id === session.id;
                  const isStale =
                    session.status === 'active' &&
                    (!routeLastPoint?.recordedAt || Date.now() - new Date(routeLastPoint.recordedAt).getTime() > ROUTE_STALE_AFTER_MS);

                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => setSelectedSessionId(session.id)}
                      className={`mini-surface-3d w-full border p-3 text-left transition-colors ${
                        isSelected ? 'border-orange-500 bg-orange-500/10' : 'border-zinc-800 bg-black/40 hover:border-orange-500/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-white">{employee?.name || 'Unknown rider'}</div>
                          <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                            {fmtTime(routeLastPoint?.recordedAt || session.lastPointAt || session.startedAt)} | {session.isLiveOnly ? 'live only' : session.status}
                          </div>
                        </div>
                        <div className={`mt-1 h-2 w-2 rounded-full ${session.status === 'active' && !isStale ? 'bg-green-400 pulse-dot' : isStale ? 'bg-amber-400' : 'bg-zinc-500'}`} />
                      </div>
                      <div className="mt-2 font-mono text-[9px] uppercase text-zinc-500">
                        {fmtCoordinate(routeLastPoint?.lat)}, {fmtCoordinate(routeLastPoint?.lng)} | {session.isLiveOnly ? 'live' : `${session.pointCount || points.length} pts`}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Modal = ({ open, onClose, title, children, fullScreen = false }) => {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;

    const previousOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;

    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open, title]);

  if (!open || typeof document === 'undefined') return null;

  const backdropClass = fullScreen
    ? 'modal-backdrop fixed inset-0 z-[100] flex bg-[#05080c]'
    : 'modal-backdrop fixed inset-0 z-[100] flex items-end justify-center bg-black/95 p-3 backdrop-blur-sm sm:items-center sm:p-5';
  const shellClass = fullScreen
    ? 'modal-shell flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none border-0 bg-[#05080c]'
    : 'modal-shell flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-[28px] border border-orange-500/30 bg-black sm:max-h-[90vh] lg:max-w-2xl';
  const headerClass = fullScreen
    ? 'sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-orange-500/15 bg-black/95 px-5 py-5 backdrop-blur sm:px-8 lg:px-10'
    : 'sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-orange-500/15 bg-black/95 px-5 py-4 backdrop-blur';
  const bodyClass = fullScreen
    ? 'modal-scroll-area flex-1 overscroll-contain overflow-y-auto px-5 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-8 lg:px-10'
    : 'modal-scroll-area overscroll-contain overflow-y-auto p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]';

  return createPortal(
    <div className={backdropClass}>
      <div className={shellClass}>
        <div className={headerClass}>
          <div>
            <div className="font-display text-3xl text-white sm:text-4xl">{title}</div>
            {fullScreen ? (
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-amber-500/70">
                Rider profile editor
              </div>
            ) : null}
          </div>
          <button onClick={onClose} className="text-zinc-500 transition-colors hover:text-orange-500">
            <X className="h-6 w-6" />
          </button>
        </div>
        <div ref={scrollRef} className={bodyClass}>
          <div className={fullScreen ? 'mx-auto w-full max-w-6xl' : ''}>{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const PhotoPreviewModal = ({ photoModal, onClose }) => (
  <Modal open={photoModal.open} onClose={onClose} title="PHOTO PREVIEW">
    <div className="space-y-4">
      <button
        onClick={onClose}
        className="flex w-full items-center justify-center gap-2 border border-amber-500/50 bg-amber-500/10 py-3 font-display tracking-widest text-amber-300 transition-colors hover:bg-amber-500/20"
      >
        <ArrowLeft className="h-4 w-4" />
        BACK TO APP
      </button>
      {photoModal.url ? (
        <img src={photoModal.url} alt={photoModal.path} className="photo-preview-zoom max-h-[70vh] w-full border border-zinc-800 object-contain" />
      ) : null}
    </div>
  </Modal>
);

const Input = ({ label, icon: Icon, helper, ...props }) => (
  <div className="mb-4">
    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">{label}</div>
    <div className="relative">
      {Icon ? <Icon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" /> : null}
      <input
        {...props}
        className={`field-focus min-h-[48px] w-full border border-zinc-800 bg-black py-3 pr-3 text-white transition-colors focus:border-orange-500 ${
          Icon ? 'pl-10' : 'pl-3'
        }`}
      />
    </div>
    {helper ? <div className="mt-1 font-mono text-[10px] text-zinc-500">{helper}</div> : null}
  </div>
);

const LoadingScreen = () => (
  <div className="grid-bg min-h-screen bg-black px-5 py-6 text-white font-body">
    <ThemeStyles />
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center gap-3">
        <SkeletonCard className="h-12 w-12 rounded-md" />
        <div className="flex-1 space-y-2">
          <SkeletonCard className="h-3 w-24" />
          <SkeletonCard className="h-5 w-40" />
        </div>
        <div className="ghost-card-pulse mini-surface-3d border border-orange-500/20 px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-amber-400">
          Loading
        </div>
      </div>
      <SkeletonCard className="h-40" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <SkeletonCard className="h-24" />
        <SkeletonCard className="h-24" />
        <SkeletonCard className="h-24" />
        <SkeletonCard className="h-24" />
        <SkeletonCard className="h-24" />
        <SkeletonCard className="h-24" />
      </div>
      <SkeletonCard className="h-32" />
      <SkeletonCard className="h-48" />
    </div>
  </div>
);

const SupabaseSetupView = ({ configError }) => (
  <div className="grid-bg flex min-h-screen items-center justify-center bg-black px-5 text-white font-body">
    <ThemeStyles />
    <div className="w-full max-w-xl border border-orange-500/30 bg-zinc-950 p-6">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Setup Required</div>
      <div className="font-display text-4xl leading-none text-white">Connect Supabase</div>
      <div className="mt-3 text-sm leading-6 text-zinc-400">
        Add your real project URL and anon public key, then restart local Vite or redeploy Vercel.
      </div>
      {configError ? (
        <div className="mt-4 border border-red-500/30 bg-red-500/10 p-3 font-mono text-[10px] uppercase tracking-widest text-red-300">
          {configError}
        </div>
      ) : null}
      <pre className="mt-5 overflow-x-auto border border-zinc-800 bg-black p-4 font-mono text-xs text-amber-300">
{`# .env.local
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key`}
      </pre>
      <div className="mt-4 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
        Vercel uses the same two names in Project Settings &gt; Environment Variables.
      </div>
    </div>
  </div>
);

const LoginView = ({ onAdminLogin, loading, error, demoMode }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div className="grid-bg flex min-h-screen flex-col bg-black text-white font-body">
      <ThemeStyles />
      <div className="h-1 ticker-border"></div>
      <div className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="dashboard-3d w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="relative mb-4 inline-block">
              <div className="absolute inset-0 bg-orange-500/20 blur-2xl"></div>
              <img src="/icons/icon.svg" alt="FleetLine logo" className="app-logo-4d relative h-24 w-24 object-contain" />
            </div>
            <div className="font-display text-5xl leading-none text-white">
              FLEET<span className="text-orange-500">LINE</span>
            </div>
            <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.3em] text-amber-500/70">
              Supabase Edition | v1
            </div>
          </div>

          {error ? (
            <div className="mb-4 border border-red-500/30 bg-red-500/10 p-3 font-mono text-[10px] text-red-300">
              {error}
            </div>
          ) : null}

          {demoMode ? (
            <div className="mb-4 border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-[10px] uppercase tracking-widest text-amber-200">
              Local demo mode: admin accepts any email/password.
            </div>
          ) : null}

          <div>
            <div className="surface-3d mb-4 border border-amber-500/30 bg-amber-500/5 p-5">
              <Shield className="mb-3 h-8 w-8 text-amber-400" />
              <div className="mb-1 font-display text-2xl text-white">Admin Login</div>
              <div className="mb-4 text-sm text-zinc-400">Email and password from Supabase Auth.</div>
              <Input
                label="Email"
                icon={MessageCircle}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@example.com"
              />
              <Input
                label="Password"
                icon={Shield}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="********"
              />
            </div>
            <button
              onClick={() => onAdminLogin(email, password)}
              disabled={loading || !email || !password}
              className="button-3d button-3d-primary glow-orange w-full py-3 font-display text-lg tracking-widest disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? 'AUTHENTICATING...' : 'ADMIN AUTHENTICATE ->'}
            </button>
          </div>
        </div>
      </div>
      <div className="p-5 text-center font-mono text-[10px] uppercase tracking-widest text-zinc-600">
        FleetLine | Fuel | Manage
      </div>
    </div>
  );
};

const EmployeeForm = ({ employee, onSave, onDelete, onCancel, onShowToast }) => {
  const [form, setForm] = useState(
    employee || {
      name: '',
      username: '',
      phone: '',
      bikePlate: '',
      bikeModel: '',
      mileage: '',
      active: true,
      pin: '',
    },
  );

  const isNew = !employee;
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const handleSave = () => {
    if (!form.name || !form.username || !form.bikePlate) {
      onShowToast?.('Name, username, and bike plate are required.', 'error');
      return;
    }

    if (isNew && !/^\d{4}$/.test(String(form.pin ?? ''))) {
      onShowToast?.('A 4-digit PIN is required for new riders.', 'error');
      return;
    }

    onSave(
      {
        ...employee,
        name: form.name,
        username: form.username,
        phone: form.phone,
        bikePlate: form.bikePlate,
        bikeModel: form.bikeModel,
        mileage: form.mileage === '' ? null : Number(form.mileage),
        active: form.active,
      },
      { isNew, pin: form.pin },
    );
  };

  return (
    <div className="space-y-5">
      <div className="surface-3d border border-orange-500/20 bg-black/55 p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-2 border-b border-orange-500/10 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="font-display text-2xl text-white">{isNew ? 'Create rider profile' : form.name || 'Rider profile'}</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.24em] text-zinc-500">
              Login, phone, motorcycle and fuel mileage details
            </div>
          </div>
          {!isNew ? (
            <label className="inline-flex w-fit items-center gap-2 rounded-full border border-green-400/20 bg-green-400/10 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-green-300">
              <input
                type="checkbox"
                checked={Boolean(form.active)}
                onChange={(event) => update('active', event.target.checked)}
              />
              Rider is active
            </label>
          ) : null}
        </div>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Input
            label="Full Name"
            icon={User}
            value={form.name}
            onChange={(event) => update('name', event.target.value)}
            placeholder="Ali Hassan"
          />
          <Input
            label="Username"
            icon={Hash}
            value={form.username}
            onChange={(event) => update('username', event.target.value.toLowerCase().replace(/\s/g, ''))}
            placeholder="ali.hassan"
          />
          <Input
            label="Phone Number"
            icon={Phone}
            value={form.phone}
            onChange={(event) => update('phone', event.target.value)}
            placeholder="+92 300 1234567"
          />
          <Input
            label="Bike Plate Number"
            icon={Bike}
            value={form.bikePlate}
            onChange={(event) => update('bikePlate', event.target.value.toUpperCase())}
            placeholder="LEA-1234"
          />
          <Input
            label="Bike Model"
            icon={Gauge}
            value={form.bikeModel}
            onChange={(event) => update('bikeModel', event.target.value)}
            placeholder="Honda CD 70"
          />
          <Input
            label="Mileage Override (km/L)"
            icon={Fuel}
            type="number"
            value={form.mileage ?? ''}
            onChange={(event) => update('mileage', event.target.value)}
            placeholder="Leave blank to use default"
          />
          {isNew ? (
            <Input
              label="Initial 4-digit PIN"
              icon={KeyRound}
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={form.pin}
              onChange={(event) => update('pin', event.target.value.replace(/[^\d]/g, '').slice(0, 4))}
              placeholder="1234"
            />
          ) : null}
        </div>
      </div>

      <div className="surface-3d border border-orange-500/20 bg-black/55 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
          <button onClick={onCancel} className="mini-surface-3d border border-zinc-800 bg-zinc-900 py-4 font-display tracking-widest text-zinc-400">
            CANCEL
          </button>
          <button onClick={handleSave} className="glow-orange bg-gradient-to-r from-orange-500 to-amber-500 py-4 font-display tracking-widest text-black">
            SAVE
          </button>
        </div>
        {employee && onDelete ? (
          <button
            onClick={() => {
              if (window.confirm(`Delete ${employee.name}? All readings and photos will be removed.`)) {
                onDelete(employee.id);
              }
            }}
            className="mini-surface-3d mt-3 flex w-full items-center justify-center gap-2 border border-red-500/40 py-3 font-display tracking-widest text-red-400 hover:bg-red-500/10"
          >
            <Trash2 className="h-4 w-4" /> DELETE RIDER
          </button>
        ) : null}
      </div>
    </div>
  );
};

const DailyCloseSheet = ({ rows, config, onSelectEmployee, onPreviewPhoto, onSaveDailyReview }) => {
  const [drafts, setDrafts] = useState({});
  const [savingKey, setSavingKey] = useState('');

  const getDraft = (row) => {
    const key = getReviewKey(row.employee.id, row.date);
    return drafts[key] ?? {
      status: row.review?.status ?? row.displayStatus,
      notes: row.review?.notes ?? '',
    };
  };

  const updateDraft = (row, patch) => {
    const key = getReviewKey(row.employee.id, row.date);
    setDrafts((current) => ({
      ...current,
      [key]: {
        ...getDraft(row),
        ...patch,
      },
    }));
  };

  const handleSave = async (row, override = null) => {
    const key = getReviewKey(row.employee.id, row.date);
    const draft = {
      ...getDraft(row),
      ...(override ?? {}),
    };
    setSavingKey(key);
    try {
      await onSaveDailyReview({
        employeeId: row.employee.id,
        date: row.date,
        status: draft.status,
        notes: draft.notes,
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } finally {
      setSavingKey('');
    }
  };

  return (
    <div className="ledger-panel-3d border border-orange-500/30 p-5">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-400">// Daily Truth Record</div>
          <div className="font-display text-4xl leading-none text-white">Daily Close Sheet</div>
          <div className="mt-1 text-xs text-zinc-400">
            Morning, evening, route proof, photos, fuel cost, flags, and admin notes in one place.
          </div>
        </div>
        <PackageCheck className="h-7 w-7 text-orange-500" />
      </div>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <div className="empty-state p-8 text-center">
            <PackageCheck className="empty-icon mx-auto mb-3 h-10 w-10 text-orange-500/80" />
            <div className="text-sm text-zinc-400">Add riders to start building daily close sheets.</div>
          </div>
        ) : null}
        {rows.map((row, rowIndex) => {
          const key = getReviewKey(row.employee.id, row.date);
          const hasFlags = row.flags.length > 0;
          const flagMeta = hasFlags
            ? {
                label: `${row.flags.length} Problem Flag${row.flags.length === 1 ? '' : 's'}`,
                tone: row.flags.some((flag) => flag.tone === 'red') ? 'red' : 'amber',
              }
            : { label: 'No Problem Flags', tone: 'green' };
          const draft = getDraft(row);
          const reviewMeta = REVIEW_STATUS[draft.status] ?? REVIEW_STATUS.pending_review;
          const saving = savingKey === key;
          const diffLabel = row.routeHealth.diffPct === null ? '-' : `${Math.round(row.routeHealth.diffPct)}%`;

          return (
            <div
              key={key}
              className={`surface-3d fade-up border p-4 ${hasFlags ? 'border-amber-500/30' : 'border-zinc-800'}`}
              style={{ animationDelay: `${Math.min(rowIndex, 8) * 60}ms` }}
            >
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <button onClick={() => onSelectEmployee(row.employee.id)} className="min-w-0 text-left">
                  <div className="font-display text-2xl leading-none text-white">{row.employee.name}</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    @{row.employee.username} | {row.employee.bikePlate}
                  </div>
                </button>
                <div className="flex flex-wrap justify-end gap-2">
                  <StatusBadge label={row.todayStatus.label} tone={row.todayStatus.tone} />
                  <StatusBadge label={flagMeta.label} tone={flagMeta.tone} />
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-6">
                {[
                  ['Morning', row.daySummary.morning],
                  ['Evening', row.daySummary.evening],
                ].map(([label, reading]) => (
                  <div key={label} className="mini-surface-3d border border-zinc-800 bg-black/45 p-3">
                    <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">{label} Reading</div>
                    <div className="mt-1 font-display text-2xl leading-none text-white">
                      {reading ? fmtNum(reading.km) : '-'}
                      <span className="ml-1 font-mono text-[9px] text-zinc-500">km</span>
                    </div>
                    <div className="mt-1 font-mono text-[9px] uppercase text-zinc-500">
                      {reading ? fmtTime(reading.submittedAt) : 'not submitted'}
                    </div>
                    {reading?.photoPath ? (
                      <button
                        onClick={() => onPreviewPhoto(reading.photoPath)}
                        className="mt-2 font-mono text-[9px] uppercase tracking-widest text-orange-500 hover:text-amber-300"
                      >
                        View Photo Proof
                      </button>
                    ) : (
                      <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-red-300/80">No Photo</div>
                    )}
                  </div>
                ))}

                <div className="mini-surface-3d border border-orange-500/25 bg-black/45 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Daily KM / Fuel</div>
                  <div className={`mt-1 font-display text-2xl leading-none ${row.daySummary.invalid ? 'text-red-300' : 'text-amber-400'}`}>
                    {fmtNum(Math.round(row.daySummary.distance))}
                    <span className="ml-1 font-mono text-[9px] text-zinc-500">km</span>
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-500">
                    {row.fuelUsed.toFixed(2)} L | {config.currency} {fmtNum(Math.round(row.fuelCost))}
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-600">
                    price locked @ {config.currency} {row.fuelPrice}/L
                  </div>
                </div>

                <div className="mini-surface-3d border border-teal-500/25 bg-black/45 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Meter vs GPS</div>
                  <div className={`mt-1 font-display text-2xl leading-none ${row.routeHealth.diffPct !== null && row.routeHealth.diffPct > ROUTE_ODOMETER_DIFF_WARNING_PCT ? 'text-amber-300' : 'text-teal-300'}`}>
                    {diffLabel}
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-500">
                    GPS {row.routeHealth.gpsDistanceKm.toFixed(1)} km | ODO {row.daySummary.complete ? row.daySummary.distance.toFixed(1) : '-'} km
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-600">
                    {row.routeHealth.pointCount} pts | active {row.routeHealth.activeMinutes} min
                  </div>
                </div>

                <div className="mini-surface-3d border border-blue-300/20 bg-black/45 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Shop Visits</div>
                  <div className="mt-1 font-display text-2xl leading-none text-blue-100">
                    {row.routeReport.pinCount}
                  </div>
                  <div className="mt-1 truncate font-mono text-[9px] uppercase text-zinc-500">
                    {row.routeReport.pinCount ? `last ${fmtTime(row.routeReport.lastPinAt)}` : 'no shop pins'}
                  </div>
                  <div className="mt-1 truncate font-mono text-[9px] uppercase text-zinc-600">
                    {row.routeReport.pins.at(-1)?.name ?? 'pin shops from rider app'}
                  </div>
                </div>

                <div className="mini-surface-3d border border-red-500/20 bg-black/45 p-3">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Route Alerts</div>
                  <div className={`mt-1 font-display text-2xl leading-none ${row.routeReport.outsideDeviationCount ? 'text-red-300' : 'text-green-300'}`}>
                    {row.routeReport.outsideDeviationCount}
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-500">
                    {row.routeReport.lastDeviationAt ? `last ${fmtTime(row.routeReport.lastDeviationAt)}` : 'inside route'}
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-600">
                    {row.routeHealth.confidence}% route confidence
                  </div>
                </div>
              </div>

              {hasFlags ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {row.flags.map((flag) => <StatusBadge key={`${key}-${flag.id}`} label={flag.label} tone={flag.tone} />)}
                </div>
              ) : null}

              <div className="mt-4 border-t border-zinc-800 pt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">Admin Approval</div>
                    <div className="text-xs text-zinc-500">Approve clean days or mark route/reading problems for follow-up.</div>
                  </div>
                  <StatusBadge label={reviewMeta.label} tone={reviewMeta.tone} />
                </div>
                <div className="grid gap-2 md:grid-cols-[170px_1fr_auto]">
                  <select
                    value={draft.status}
                    onChange={(event) => updateDraft(row, { status: event.target.value })}
                    className="field-focus min-h-[44px] border border-zinc-800 bg-black px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-white transition-colors focus:border-orange-500"
                  >
                    {Object.entries(REVIEW_STATUS).map(([value, meta]) => (
                      <option key={value} value={value}>{meta.label}</option>
                    ))}
                  </select>
                  <input
                    value={draft.notes}
                    onChange={(event) => updateDraft(row, { notes: event.target.value })}
                    placeholder="Admin notes for this route day"
                    className="field-focus min-h-[44px] border border-zinc-800 bg-black px-3 py-2 text-sm text-white transition-colors placeholder:text-zinc-600 focus:border-orange-500"
                  />
                  <button
                    type="button"
                    onClick={() => handleSave(row)}
                    disabled={saving}
                    className="button-3d button-3d-primary px-4 py-2 font-display tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? 'SAVING...' : 'SAVE REVIEW'}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleSave(row, { status: 'approved', notes: draft.notes || 'Approved from route report.' })}
                    disabled={saving}
                    className="mini-surface-3d border border-green-400/25 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-green-300 hover:bg-green-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Approve Day
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSave(row, { status: 'problem', notes: draft.notes || 'Problem marked from route report.' })}
                    disabled={saving}
                    className="mini-surface-3d border border-red-400/25 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Mark Problem
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const AdminOverview = ({
  employees,
  readingsByEmployee,
  config,
  routeSessions,
  routePoints,
  liveRiderLocations,
  shopPins,
  routeDeviationEvents,
  fuelPriceHistory,
  dailyReviews,
  onSelectEmployee,
  onLoadRoutePoints,
}) => {
  const [now, setNow] = useState(() => new Date());
  const thisMonth = monthKey(today());
  const alertDate = today();
  const monthDates = getDatesForMonth(thisMonth, alertDate, { workingOnly: true });
  const missingAlerts = getMissingReadingAlerts(employees, readingsByEmployee, alertDate, now);
  const morningAlerts = missingAlerts.filter((alert) => alert.type === 'morning').length;
  const eveningAlerts = missingAlerts.filter((alert) => alert.type === 'evening').length;
  const attentionItems = getAttentionItems(employees, readingsByEmployee, missingAlerts, alertDate, now);
  const dailyCloseRows = buildDailyCloseRows({
    employees,
    readingsByEmployee,
    config,
    routeSessions,
    routePoints,
    shopPins,
    routeDeviationEvents,
    dailyReviews,
    fuelPriceHistory,
    date: alertDate,
    now,
  });
  const activeRouteCount = routeSessions.filter((session) => session.date === alertDate && session.status === 'active').length;
  const inMarketCount = dailyCloseRows.filter((row) => row.daySummary.morning && !row.daySummary.evening).length;
  const needsReviewCount = dailyCloseRows.filter((row) => row.flags.length > 0).length;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(interval);
  }, []);

  const monthlyReportRows = employees.map((employee) => {
    const monthlyReadings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
      (reading) => monthKey(reading.date) === thisMonth && !reading.queued,
    );
    const mileage = Number(employee.mileage ?? config.defaultMileage);
    const summary = getMonthlySummary(monthlyReadings, thisMonth, mileage, config.fuelPrice, fuelPriceHistory);
    const dailySummaries = monthDates.map((date) => getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true }));
    const incompleteDays = dailySummaries.filter((day) => day.morning || day.evening).filter((day) => !day.complete).length;
    const todaySummary = getDaySummary(readingsByEmployee[employee.id] || [], alertDate, { excludeQueued: true });
    const todayStatus = getRiderTodayStatus(todaySummary, now, alertDate);

    return {
      employee,
      monthlyReadings,
      summary,
      monthlyKm: summary.totalKm,
      fuelCost: summary.cost,
      incompleteDays,
      todaySummary,
      todayStatus,
      didToday: Boolean(todaySummary.morning || todaySummary.evening),
    };
  });

  const leaderboardRows = [...monthlyReportRows].sort((left, right) => right.monthlyKm - left.monthlyKm);
  const fuelLeaderboardRows = [...monthlyReportRows].sort((left, right) => right.fuelCost - left.fuelCost);

  const todayTotals = monthlyReportRows.reduce(
    (accumulator, row) => {
      const mileage = Number(row.employee.mileage ?? config.defaultMileage);
      const distance = row.todaySummary.complete ? row.todaySummary.distance : 0;
      const fuel = mileage > 0 ? distance / mileage : 0;
      accumulator.started += row.todaySummary.morning ? 1 : 0;
      accumulator.completed += row.todaySummary.complete ? 1 : 0;
      accumulator.km += distance;
      accumulator.fuelCost += fuel * getFuelPriceForDate(alertDate, fuelPriceHistory, config.fuelPrice);
      return accumulator;
    },
    { started: 0, completed: 0, km: 0, fuelCost: 0 },
  );

  const stats = monthlyReportRows.reduce(
    (accumulator, employee) => {
      accumulator.totalKm += employee.summary.totalKm;
      accumulator.totalFuel += employee.summary.fuelUsed;
      accumulator.totalCost += employee.summary.cost;
      accumulator.activeToday += employee.didToday ? 1 : 0;
      return accumulator;
    },
    { totalKm: 0, totalFuel: 0, totalCost: 0, activeToday: 0 },
  );

  const dailyFleetRows = monthDates.slice(-10).map((date) => {
    const km = employees.reduce((sum, employee) => {
      const summary = getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true });
      return sum + (summary.complete ? summary.distance : 0);
    }, 0);

    return {
      label: fmtShort(date),
      value: km,
    };
  });

  const riderFuelRows = fuelLeaderboardRows
    .filter((row) => row.fuelCost > 0)
    .slice(0, 5)
    .map((row) => ({ label: row.employee.name, value: row.fuelCost }));

  const highestKmRider = leaderboardRows.find((row) => row.monthlyKm > 0);
  const highestFuelRider = fuelLeaderboardRows.find((row) => row.fuelCost > 0);

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Today Command Center</div>
        <div className="font-display text-3xl leading-none text-white">
          {formatAppDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
      </div>

      <div className="hero-3d surface-3d relative overflow-hidden border border-orange-500/30 bg-gradient-to-br from-orange-500/20 via-amber-500/10 to-black p-5">
        <div className="absolute -right-8 -top-10 h-32 w-32 rounded-full bg-orange-500/20 blur-3xl" />
        <div className="relative">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-amber-300">// Today Operations</div>
          <div className="font-display text-4xl leading-none text-white">
            {todayTotals.completed}/{employees.length} Complete
          </div>
          <div className="mt-1 text-xs text-zinc-400">
            {todayTotals.started} riders started today | {fmtNum(Math.round(todayTotals.km))} km completed
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="mini-surface-3d border border-orange-500/20 bg-black/40 p-3">
              <div className="font-mono text-[9px] uppercase text-zinc-500">Today KM</div>
              <div className="font-display text-3xl text-amber-400">{fmtNum(Math.round(todayTotals.km))}</div>
            </div>
            <div className="mini-surface-3d border border-orange-500/20 bg-black/40 p-3">
              <div className="font-mono text-[9px] uppercase text-zinc-500">Today Fuel Cost</div>
              <div className="font-display text-3xl text-orange-500">{fmtNum(Math.round(todayTotals.fuelCost))}</div>
              <div className="font-mono text-[9px] uppercase text-zinc-500">{config.currency}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <StatCard label="In Market" value={inMarketCount} unit="riders" icon={Route} accent="teal" />
        <StatCard label="Missing Morning" value={morningAlerts} unit="alerts" icon={Sun} accent={morningAlerts ? 'gold' : 'white'} />
        <StatCard label="Missing Evening" value={eveningAlerts} unit="alerts" icon={Moon} accent={eveningAlerts ? 'gold' : 'white'} />
        <StatCard label="GPS Active" value={activeRouteCount} unit="routes" icon={MapPin} accent="orange" />
        <StatCard label="Needs Review" value={needsReviewCount} unit="items" icon={Shield} accent={needsReviewCount ? 'gold' : 'white'} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Active Riders" value={employees.length} unit="registered" icon={Users} accent="orange" />
        <StatCard label="Today" value={stats.activeToday} unit={`/ ${employees.length}`} icon={CheckCircle} accent="gold" />
        <StatCard label="Monthly KM" value={fmtNum(Math.round(stats.totalKm))} unit="km" icon={TrendingUp} accent="orange" />
        <StatCard label="Fuel Used" value={stats.totalFuel.toFixed(1)} unit="litres" icon={Fuel} accent="gold" />
      </div>

      <LiveRiderMap
        employees={employees}
        routeSessions={routeSessions}
        routePoints={routePoints}
        liveRiderLocations={liveRiderLocations}
        onLoadRoutePoints={onLoadRoutePoints}
        onSelectEmployee={onSelectEmployee}
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="surface-3d border border-zinc-800 bg-zinc-950 p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Highest KM Rider</div>
          <div className="mt-2 truncate font-display text-2xl text-amber-400">{highestKmRider?.employee.name || '-'}</div>
          <div className="font-mono text-[10px] uppercase text-zinc-500">{fmtNum(Math.round(highestKmRider?.monthlyKm || 0))} km</div>
        </div>
        <div className="surface-3d border border-zinc-800 bg-zinc-950 p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Highest Fuel Cost</div>
          <div className="mt-2 truncate font-display text-2xl text-orange-500">{highestFuelRider?.employee.name || '-'}</div>
          <div className="font-mono text-[10px] uppercase text-zinc-500">
            {config.currency} {fmtNum(Math.round(highestFuelRider?.fuelCost || 0))}
          </div>
        </div>
      </div>

      <div className={`surface-3d border p-5 ${attentionItems.length > 0 ? 'border-red-500/30 bg-red-500/10' : 'border-green-500/30 bg-green-500/5'}`}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className={`font-mono text-[10px] uppercase tracking-widest ${attentionItems.length > 0 ? 'text-red-300' : 'text-green-300'}`}>
              // Attention Required
            </div>
            <div className="font-display text-3xl leading-none text-white">
              {attentionItems.length > 0 ? `${attentionItems.length} Item${attentionItems.length === 1 ? '' : 's'} Need Attention` : 'All Clear'}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {isWorkingDay(alertDate)
                ? `Morning alerts start after ${MISSING_READING_CUTOFFS.morning.label}. Evening alerts start after ${MISSING_READING_CUTOFFS.evening.label}.`
                : `Today is Sunday/off-day. Missing reading alerts are paused.`}
            </div>
          </div>
          <div className="text-right font-mono text-[10px] uppercase text-zinc-500">
            {fmtDate(alertDate)}
            <div className={attentionItems.length > 0 ? 'text-red-300' : 'text-green-300'}>
              {morningAlerts} morning | {eveningAlerts} evening
            </div>
          </div>
        </div>

        {attentionItems.length > 0 ? (
          <div className="space-y-2">
            {attentionItems.map((alert) => {
              const Icon = alert.type ? READING_TYPES[alert.type].icon : alert.title === 'Phone Missing' ? Phone : PackageCheck;
              const phone = normalizeWhatsAppPhone(alert.employee.phone);
              return (
                <div key={alert.id} className={`mini-surface-3d border bg-black/50 p-3 ${alert.tone === 'red' ? 'border-red-500/20' : 'border-amber-500/20'}`}>
                  <div className="flex items-start gap-3">
                    <div className={`flex h-10 w-10 items-center justify-center border ${statusClasses[alert.tone]}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-white">{alert.employee.name}</div>
                      <div className={`font-mono text-[10px] uppercase ${alert.tone === 'red' ? 'text-red-200' : 'text-amber-200'}`}>
                        {alert.dueLabel ? `${alert.title} after ${alert.dueLabel}` : alert.title}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
                        {alert.description}
                      </div>
                    </div>
                  </div>
                  {phone && alert.message ? (
                    <button
                      onClick={() => openWhatsApp(alert.employee.phone, alert.message)}
                      className="button-3d button-3d-whatsapp mt-3 flex w-full items-center justify-center gap-2 py-2.5 font-display tracking-widest text-white transition-all hover:brightness-110"
                    >
                      <MessageCircle className="h-4 w-4" /> REMIND ON WHATSAPP
                    </button>
                  ) : (
                    <div className="mt-3 border border-amber-500/30 bg-amber-500/10 p-2 font-mono text-[10px] uppercase text-amber-300">
                      {alert.title === 'Phone Missing' ? 'Add this rider&apos;s phone number to enable WhatsApp reminders.' : 'Review this item from the rider detail screen.'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="border border-green-500/20 bg-black/40 p-3 font-mono text-[10px] uppercase text-green-300">
            No urgent rider issues at the current cutoff time.
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="surface-3d border border-zinc-800 bg-zinc-950 p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Daily Fleet KM</div>
              <div className="font-display text-2xl text-white">Last 10 Days</div>
            </div>
            <BarChart3 className="h-5 w-5 text-orange-500" />
          </div>
          <BarChart rows={dailyFleetRows} valueLabel={(value) => `${fmtNum(Math.round(value))} km`} />
        </div>
        <div className="surface-3d border border-zinc-800 bg-zinc-950 p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Rider Fuel Cost</div>
              <div className="font-display text-2xl text-white">Top 5 This Month</div>
            </div>
            <DollarSign className="h-5 w-5 text-amber-400" />
          </div>
          <BarChart
            rows={riderFuelRows}
            valueLabel={(value) => `${config.currency} ${fmtNum(Math.round(value))}`}
            emptyText="No completed rider days yet."
          />
        </div>
      </div>

    </div>
  );
};

const AdminReportsPanel = ({
  employees,
  readingsByEmployee,
  config,
  routeSessions,
  routePoints,
  shopPins,
  routeDeviationEvents,
  fuelPriceHistory,
  dailyReviews,
  onSelectEmployee,
  onPreviewPhoto,
  onSaveDailyReview,
}) => {
  const [exported, setExported] = useState(false);
  const [reportMode, setReportMode] = useState('month');
  const [reportMonth, setReportMonth] = useState(monthKey(today()));
  const [reportDate, setReportDate] = useState(today());
  const [riderFilter, setRiderFilter] = useState('all');
  const activeReportMonth = reportMonth || monthKey(today());
  const activeReportDate = reportDate || today();
  const workingDates = getDatesForMonth(activeReportMonth, today(), { workingOnly: true });
  const filteredEmployees = riderFilter === 'all'
    ? employees
    : employees.filter((employee) => employee.id === riderFilter);

  useEffect(() => {
    if (!exported) return undefined;
    const timeout = window.setTimeout(() => setExported(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [exported]);

  const handleExportMonthlyCSV = () => {
    if (filteredEmployees.length === 0) return;
    downloadCSV(buildFleetCSV(filteredEmployees, readingsByEmployee, config, activeReportMonth, fuelPriceHistory), `fleet_${activeReportMonth}.csv`);
    setExported(true);
  };

  const monthlyReportRows = filteredEmployees.map((employee) => {
    const monthlyReadings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
      (reading) => monthKey(reading.date) === activeReportMonth && isWorkingDay(reading.date) && !reading.queued,
    );
    const mileage = Number(employee.mileage ?? config.defaultMileage);
    const summary = getMonthlySummary(monthlyReadings, activeReportMonth, mileage, config.fuelPrice, fuelPriceHistory);
    const workingSummaries = workingDates.map((date) => getDaySummary(readingsByEmployee[employee.id] || [], date, { excludeQueued: true }));
    const completedWorkingDays = workingSummaries.filter((day) => day.complete).length;
    const incompleteDays = workingSummaries.filter((day) => (day.morning || day.evening) && !day.complete).length;
    const missingDays = workingSummaries.filter((day) => !day.morning && !day.evening).length;
    const monthlyKm = summary.totalKm;
    const fuelCost = summary.cost;

    return {
      employee,
      summary,
      monthlyKm,
      fuelCost,
      workingDays: workingDates.length,
      completedWorkingDays,
      incompleteDays,
      missingDays,
    };
  });

  const reportTotals = monthlyReportRows.reduce(
    (accumulator, row) => {
      accumulator.totalKm += row.monthlyKm;
      accumulator.totalFuel += row.summary.fuelUsed;
      accumulator.totalCost += row.fuelCost;
      accumulator.completedDays += row.completedWorkingDays;
      accumulator.incompleteDays += row.incompleteDays;
      accumulator.missingDays += row.missingDays;
      return accumulator;
    },
    { totalKm: 0, totalFuel: 0, totalCost: 0, completedDays: 0, incompleteDays: 0, missingDays: 0 },
  );
  const dailyReportRows = buildDailyCloseRows({
    employees: filteredEmployees,
    readingsByEmployee,
    config,
    routeSessions,
    routePoints,
    dailyReviews,
    fuelPriceHistory,
    date: activeReportDate,
    now: new Date(),
  });
  const dailyTotals = dailyReportRows.reduce(
    (accumulator, row) => {
      accumulator.complete += row.daySummary.complete ? 1 : 0;
      accumulator.km += row.daySummary.complete ? row.daySummary.distance : 0;
      accumulator.gpsKm += row.routeHealth.gpsDistanceKm;
      accumulator.shopPins += row.routeReport.pinCount;
      accumulator.routeAlerts += row.routeReport.outsideDeviationCount;
      accumulator.fuelCost += row.fuelCost;
      accumulator.flags += row.flags.length;
      return accumulator;
    },
    { complete: 0, km: 0, gpsKm: 0, shopPins: 0, routeAlerts: 0, fuelCost: 0, flags: 0 },
  );

  const handleExportReportCSV = () => {
    if (reportMode === 'day') {
      if (dailyReportRows.length === 0) return;
      downloadCSV(buildDailyRouteCSV(dailyReportRows, activeReportDate, config), `fleet_route_${activeReportDate}.csv`);
      setExported(true);
      return;
    }

    handleExportMonthlyCSV();
  };

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div className="ledger-panel-3d overflow-hidden border border-orange-500/30 p-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-amber-400">// Reports</div>
            <div className="font-display text-4xl leading-none text-white">
              {reportMode === 'day' ? 'Daily Route Report' : 'Monthly Fuel & KM'}
            </div>
            <div className="mt-1 text-xs text-zinc-400">
              Filter by month, exact date, or rider to inspect previous records without cluttering Overview.
            </div>
            <div className="mt-3 inline-flex border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-amber-300">
              Working days: {WORKING_DAYS_LABEL} | Sunday ignored
            </div>
          </div>
          {reportMode === 'month' ? (
            <button
              type="button"
              onClick={handleExportReportCSV}
              disabled={reportMode === 'day' ? dailyReportRows.length === 0 : filteredEmployees.length === 0}
              title={exported ? 'CSV exported' : 'Export CSV'}
              className={`button-3d button-3d-outline flex h-12 w-12 items-center justify-center border border-orange-500/30 bg-black/60 disabled:cursor-not-allowed disabled:opacity-40 ${exported ? 'export-burst' : ''}`}
            >
              {exported ? <CheckCircle className="h-5 w-5 text-green-300" /> : <FileDown className="h-5 w-5 text-orange-500" />}
            </button>
          ) : (
            <PackageCheck className="h-7 w-7 text-orange-500" />
          )}
        </div>

        <div className="mb-5 grid gap-3 border-y border-orange-500/15 bg-black/35 px-3 py-4 md:grid-cols-3">
          <label className="block">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">Report Type</div>
            <select
              value={reportMode}
              onChange={(event) => setReportMode(event.target.value)}
              className="field-focus min-h-[48px] w-full border border-zinc-800 bg-black px-3 py-3 font-mono text-xs uppercase tracking-widest text-white transition-colors focus:border-orange-500"
            >
              <option value="month">Monthly Ledger</option>
              <option value="day">Daily Route Report</option>
            </select>
          </label>
          <label className="block">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">
              {reportMode === 'month' ? 'Report Month' : 'Report Date'}
            </div>
            {reportMode === 'month' ? (
              <input
                type="month"
                value={activeReportMonth}
                onChange={(event) => setReportMonth(event.target.value)}
                className="field-focus min-h-[48px] w-full border border-zinc-800 bg-black px-3 py-3 font-mono text-sm text-white transition-colors focus:border-orange-500"
              />
            ) : (
              <input
                type="date"
                value={activeReportDate}
                onChange={(event) => setReportDate(event.target.value)}
                className="field-focus min-h-[48px] w-full border border-zinc-800 bg-black px-3 py-3 font-mono text-sm text-white transition-colors focus:border-orange-500"
              />
            )}
          </label>
          <label className="block">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">Rider Filter</div>
            <select
              value={riderFilter}
              onChange={(event) => setRiderFilter(event.target.value)}
              className="field-focus min-h-[48px] w-full border border-zinc-800 bg-black px-3 py-3 font-mono text-xs uppercase tracking-widest text-white transition-colors focus:border-orange-500"
            >
              <option value="all">All Riders</option>
              {employees
                .slice()
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} | {employee.bikePlate}
                  </option>
                ))}
            </select>
          </label>
        </div>

        {reportMode === 'day' ? (
          <>
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-6">
              <div className="mini-surface-3d border border-orange-500/25 bg-black/60 p-3">
                <div className="font-mono text-[9px] uppercase text-zinc-500">Report Date</div>
                <div className="font-display text-2xl leading-none text-amber-400">{fmtShort(activeReportDate)}</div>
                <div className="font-mono text-[9px] uppercase text-zinc-600">
                  {isWorkingDay(activeReportDate) ? 'working day' : 'off-day / Sunday'}
                </div>
              </div>
              <div className="mini-surface-3d border border-green-500/20 bg-black/60 p-3">
                <div className="font-mono text-[9px] uppercase text-zinc-500">Complete</div>
                <div className="font-display text-3xl leading-none text-green-300">{dailyTotals.complete}</div>
                <div className="font-mono text-[9px] uppercase text-zinc-600">rider days</div>
              </div>
              <div className="mini-surface-3d border border-orange-500/25 bg-black/60 p-3">
                <div className="font-mono text-[9px] uppercase text-zinc-500">Daily KM</div>
                <div className="font-display text-3xl leading-none text-amber-400">{fmtNum(Math.round(dailyTotals.km))}</div>
                <div className="font-mono text-[9px] uppercase text-zinc-600">odometer total</div>
              </div>
              <div className="mini-surface-3d border border-teal-500/20 bg-black/60 p-3">
                <div className="font-mono text-[9px] uppercase text-zinc-500">GPS KM</div>
                <div className="font-display text-3xl leading-none text-teal-300">{dailyTotals.gpsKm.toFixed(1)}</div>
                <div className="font-mono text-[9px] uppercase text-zinc-600">route total</div>
              </div>
              <div className="mini-surface-3d border border-blue-300/20 bg-black/60 p-3">
                <div className="font-mono text-[9px] uppercase text-zinc-500">Shop Visits</div>
                <div className="font-display text-3xl leading-none text-blue-100">{dailyTotals.shopPins}</div>
                <div className="font-mono text-[9px] uppercase text-zinc-600">pinned stops</div>
              </div>
              <div className="mini-surface-3d border border-amber-400/25 bg-black/60 p-3">
                <div className="font-mono text-[9px] uppercase text-zinc-500">Alerts / Cost</div>
                <div className="font-display text-3xl leading-none text-orange-500">{dailyTotals.routeAlerts}</div>
                <div className="font-mono text-[9px] uppercase text-zinc-600">
                  {dailyTotals.flags} flags | {config.currency} {fmtNum(Math.round(dailyTotals.fuelCost))}
                </div>
              </div>
            </div>
            <DailyCloseSheet
              rows={dailyReportRows}
              config={config}
              onSelectEmployee={onSelectEmployee}
              onPreviewPhoto={onPreviewPhoto}
              onSaveDailyReview={onSaveDailyReview}
            />
          </>
        ) : (
          <>
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="mini-surface-3d border border-orange-500/25 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Fleet KM</div>
            <div className="font-display text-3xl leading-none text-amber-400">{fmtNum(Math.round(reportTotals.totalKm))}</div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">working days only</div>
          </div>
          <div className="mini-surface-3d border border-orange-500/25 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Fuel Cost</div>
            <div className="font-display text-3xl leading-none text-orange-500">
              {fmtNum(Math.round(reportTotals.totalCost))}
            </div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">{config.currency}</div>
          </div>
          <div className="mini-surface-3d border border-green-500/20 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Complete Days</div>
            <div className="font-display text-3xl leading-none text-green-300">{reportTotals.completedDays}</div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">morning + evening</div>
          </div>
          <div className="mini-surface-3d border border-amber-400/25 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Missing / Incomplete</div>
            <div className="font-display text-3xl leading-none text-amber-300">
              {reportTotals.missingDays + reportTotals.incompleteDays}
            </div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">working-day gaps</div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-y border-orange-500/15 bg-black/35 px-3 py-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-400">
            {formatAppDate(`${activeReportMonth}-01T00:00:00`, { month: 'long', year: 'numeric' })} ledger | tap rider for details | export from top-right
          </div>
        </div>

        {monthlyReportRows.length === 0 ? (
          <div className="empty-state p-10 text-center">
            <FileDown className="empty-icon mx-auto mb-3 h-10 w-10 text-orange-500/80" />
            <div className="text-sm text-zinc-400">Add riders and submit readings to populate the monthly report.</div>
          </div>
        ) : (
          <div className="ops-ledger-shell overflow-hidden border border-orange-500/20 p-3">
            <div className="overflow-x-auto">
              <div className="min-w-[920px] space-y-3">
                <div className="ops-ledger-header grid grid-cols-[2fr_0.8fr_0.8fr_0.8fr_0.9fr_0.7fr] rounded-2xl border border-orange-500/15 px-4 py-3 font-mono text-[9px] uppercase tracking-widest text-amber-500/80">
                  <div>Rider</div>
                  <div className="text-right">Working Days</div>
                  <div className="text-right">KM</div>
                  <div className="text-right">Litres</div>
                  <div className="text-right">Cost</div>
                  <div className="text-right">{config.currency}/km</div>
                </div>
                {[...monthlyReportRows]
                  .sort((left, right) => left.employee.name.localeCompare(right.employee.name))
                  .map(({ employee, monthlyKm, fuelCost, summary, workingDays, completedWorkingDays, incompleteDays, missingDays }) => {
                    const costPerKm = monthlyKm > 0 ? fuelCost / monthlyKm : 0;
                    const hasGaps = incompleteDays > 0 || missingDays > 0;
                    return (
                      <button
                        key={employee.id}
                        onClick={() => onSelectEmployee(employee.id)}
                        className="ops-ledger-row grid w-full grid-cols-[2fr_0.8fr_0.8fr_0.8fr_0.9fr_0.7fr] items-center gap-3 border border-white/5 px-4 py-4 text-left transition-all"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="ledger-rider-avatar flex h-14 w-14 shrink-0 items-center justify-center border border-orange-500/35">
                            <User className="h-5 w-5 text-orange-500" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate font-display text-2xl leading-none text-white">{employee.name}</div>
                              <span className={`rounded-full border px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest ${
                                hasGaps
                                  ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                                  : 'border-green-400/25 bg-green-400/10 text-green-300'
                              }`}>
                                {hasGaps ? 'gaps' : 'clean'}
                              </span>
                            </div>
                            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-blue-200/60">@{employee.username}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase text-zinc-400">
                              <span className="flex items-center gap-1">
                                <Bike className="h-3 w-3 text-amber-500" /> {employee.bikePlate || 'no plate'}
                              </span>
                              <span className="flex items-center gap-1">
                                <Fuel className="h-3 w-3 text-amber-500" /> {employee.mileage ?? config.defaultMileage} km/L
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="ops-metric-pill border border-green-400/10 px-3 py-2 text-right">
                          <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">complete</div>
                          <div className={`font-display text-lg leading-none ${hasGaps ? 'text-amber-300' : 'text-green-300'}`}>
                            {completedWorkingDays}
                            <span className="font-mono text-[10px] text-zinc-500">/{workingDays}</span>
                          </div>
                          {hasGaps ? (
                            <div className="font-mono text-[8px] uppercase text-amber-400/80">
                              {missingDays} missing | {incompleteDays} partial
                            </div>
                          ) : null}
                        </div>
                        <div className="ops-metric-pill border border-orange-500/10 px-3 py-2 text-right">
                          <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">km</div>
                          <div className="font-display text-2xl leading-none text-amber-400">{fmtNum(Math.round(monthlyKm))}</div>
                        </div>
                        <div className="ops-metric-pill border border-zinc-700/50 px-3 py-2 text-right">
                          <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">litres</div>
                          <div className="font-display text-2xl leading-none text-zinc-100">{summary.fuelUsed.toFixed(1)}</div>
                        </div>
                        <div className="ops-metric-pill border border-orange-500/15 px-3 py-2 text-right">
                          <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">fuel cost</div>
                          <div className="font-display text-2xl leading-none text-orange-500">{fmtNum(Math.round(fuelCost))}</div>
                          <div className="font-mono text-[8px] uppercase text-zinc-500">{config.currency}</div>
                        </div>
                        <div className="ops-metric-pill border border-blue-300/10 px-3 py-2 text-right">
                          <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">{config.currency}/km</div>
                          <div className="font-mono text-sm font-bold tabular-nums text-blue-100">
                            {monthlyKm > 0 ? costPerKm.toFixed(1) : '-'}
                          </div>
                        </div>
                      </button>
                    );
                })}
              </div>
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
};

const normalizeStopName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const getClusterRadius = (cluster) => {
  const center = { lat: cluster.lat, lng: cluster.lng };
  const furthest = cluster.pins.reduce((max, pin) => Math.max(max, distanceMeters(center, pin)), 0);
  return Math.max(LEARNING_DEFAULT_RADIUS_M, Math.min(300, Math.round(furthest + 50)));
};

const clusterShopPins = (pins = []) => {
  const clusters = [];

  [...pins]
    .sort((left, right) => new Date(left.pinnedAt).getTime() - new Date(right.pinnedAt).getTime())
    .forEach((pin) => {
      const normalizedName = normalizeStopName(pin.name);
      const match = clusters.find((cluster) => {
        const sameName = normalizedName && cluster.normalizedName === normalizedName;
        const nearby = distanceMeters(cluster, pin) <= LEARNING_DUPLICATE_RADIUS_M;
        return nearby || (sameName && distanceMeters(cluster, pin) <= LEARNING_DUPLICATE_RADIUS_M * 2);
      });

      if (!match) {
        clusters.push({
          id: pin.id,
          normalizedName,
          name: pin.name || `Shop ${clusters.length + 1}`,
          lat: pin.lat,
          lng: pin.lng,
          pins: [pin],
          firstPinnedAt: pin.pinnedAt,
        });
        return;
      }

      const nextCount = match.pins.length + 1;
      match.lat = ((match.lat * match.pins.length) + pin.lat) / nextCount;
      match.lng = ((match.lng * match.pins.length) + pin.lng) / nextCount;
      match.pins.push(pin);
      if (pin.name && (!match.name || /^shop\s+\d+$/i.test(match.name))) {
        match.name = pin.name;
      }
    });

  return clusters.map((cluster, index) => ({
    id: cluster.id,
    stopOrder: index + 1,
    name: cluster.name,
    lat: cluster.lat,
    lng: cluster.lng,
    radiusM: getClusterRadius(cluster),
    visitCount: cluster.pins.length,
    sourcePinIds: cluster.pins.map((pin) => pin.id),
    firstPinnedAt: cluster.firstPinnedAt,
  }));
};

const buildWeeklyLearningRows = ({ employees, routeSessions, shopPins, routeTemplates }) => {
  const sessionsById = new Map(routeSessions.map((session) => [session.id, session]));
  const cutoffDate = appDateOffset(-(LEARNING_WINDOW_DAYS - 1));
  const groups = new Map();

  shopPins.forEach((pin) => {
    const session = sessionsById.get(pin.routeSessionId);
    const date = session?.date ?? pin.pinnedAt?.slice(0, 10);
    const employeeId = pin.employeeId ?? session?.employeeId;

    if (!employeeId || !date || date < cutoffDate) return;

    const weekday = getWeekday(date);
    const key = `${employeeId}:${weekday}`;
    const existing = groups.get(key) ?? {
      employeeId,
      weekday,
      pins: [],
      dates: new Set(),
      sourceStartDate: date,
      sourceEndDate: date,
    };

    existing.pins.push({
      ...pin,
      date,
      lat: Number(pin.lat),
      lng: Number(pin.lng),
    });
    existing.dates.add(date);
    existing.sourceStartDate = date < existing.sourceStartDate ? date : existing.sourceStartDate;
    existing.sourceEndDate = date > existing.sourceEndDate ? date : existing.sourceEndDate;
    groups.set(key, existing);
  });

  return [...groups.values()]
    .map((group) => {
      const employee = employees.find((row) => row.id === group.employeeId);
      const stops = clusterShopPins(group.pins);
      const approvedTemplate = routeTemplates
        .filter((template) =>
          template.employeeId === group.employeeId &&
          Number(template.weekday) === Number(group.weekday) &&
          template.status === 'approved',
        )
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0] ?? null;

      return {
        ...group,
        employee,
        stops,
        pinCount: group.pins.length,
        duplicateCount: Math.max(0, group.pins.length - stops.length),
        visitDays: group.dates.size,
        approvedTemplate,
        confidence: Math.min(100, Math.round((group.pins.length * 10) + (group.dates.size * 20))),
      };
    })
    .sort(
      (left, right) =>
        right.pinCount - left.pinCount ||
        (left.employee?.name || '').localeCompare(right.employee?.name || '') ||
        left.weekday - right.weekday,
    );
};

const AdminRoutesPanel = ({
  employees,
  routeSessions,
  routePoints,
  liveRiderLocations = [],
  shopPins,
  routeTemplates,
  routeDeviationEvents,
  deletingRouteId,
  onLoadRoutePoints,
  onDeleteRouteSession,
  onPreviewPhoto,
  onSaveRouteTemplate,
}) => {
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const pointsBySession = useMemo(() => groupRoutePointsBySession(routePoints), [routePoints]);
  const rows = useMemo(
    () =>
      [...routeSessions].sort(
        (left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
      ),
    [routeSessions],
  );
  const selectedSession = rows.find((session) => session.id === selectedSessionId) ?? rows[0] ?? null;
  const selectedEmployee = selectedSession
    ? employees.find((employee) => employee.id === selectedSession.employeeId)
    : null;
  const selectedPoints = selectedSession ? pointsBySession[selectedSession.id] || [] : [];
  const selectedLiveLocation = getLiveLocationForSession(liveRiderLocations, selectedSession);
  const selectedDisplayPoints = useMemo(
    () => mergeSessionLatestPoint(selectedPoints, selectedSession, selectedLiveLocation),
    [selectedPoints, selectedSession, selectedLiveLocation],
  );
  const selectedPins = selectedSession
    ? getShopPinsForRouteDay(shopPins, selectedSession.employeeId, selectedSession.date, selectedSession.id)
    : [];
  const activeRoutes = rows.filter((session) => session.status === 'active');
  const todayRoutes = rows.filter((session) => session.date === today());
  const staleRoutes = activeRoutes.filter(
    (session) => !session.lastPointAt || Date.now() - new Date(session.lastPointAt).getTime() > ROUTE_STALE_AFTER_MS,
  );
  const weeklyLearningRows = useMemo(
    () => buildWeeklyLearningRows({ employees, routeSessions, shopPins, routeTemplates }),
    [employees, routeSessions, shopPins, routeTemplates],
  );
  const approvedTemplateCount = routeTemplates.filter((template) => template.status === 'approved').length;
  const recentDeviationEvents = useMemo(
    () =>
      [...routeDeviationEvents].sort(
        (left, right) => new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime(),
      ),
    [routeDeviationEvents],
  );
  const todayDeviationEvents = recentDeviationEvents.filter((event) => getAppDateTime(event.recordedAt).date === today());

  useEffect(() => {
    if (!selectedSessionId && rows[0]) {
      setSelectedSessionId(rows[0].id);
    }
  }, [rows, selectedSessionId]);

  useEffect(() => {
    if (selectedSession?.id) {
      onLoadRoutePoints?.(selectedSession.id);
    }
  }, [selectedSession?.id]);

  const handleDeleteRoute = async (session, employee) => {
    const label = `${employee?.name || 'this rider'} route on ${fmtDate(session.date)}`;
    const shouldDelete = window.confirm(
      `Delete ${label}? This removes the route session and all GPS points. Odometer readings and photos will stay safe.`,
    );

    if (!shouldDelete) return;

    await onDeleteRouteSession(session.id);
    if (selectedSessionId === session.id) {
      const nextSession = rows.find((row) => row.id !== session.id) ?? null;
      setSelectedSessionId(nextSession?.id ?? null);
    }
  };

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Live Route Control</div>
          <div className="font-display text-3xl leading-none text-white">Route Map</div>
          <div className="mt-1 text-xs text-zinc-500">Routes start after Morning Start and close after Evening End.</div>
        </div>
        <Route className="h-7 w-7 text-orange-500" />
      </div>

      <div className="grid gap-2 md:grid-cols-4">
        <StatCard label="Active Now" value={activeRoutes.length} unit="routes" icon={Route} accent="orange" />
        <StatCard label="Today" value={todayRoutes.length} unit="sessions" icon={MapPin} accent="gold" />
        <StatCard label="No GPS" value={staleRoutes.length} unit="alerts" icon={CloudOff} accent={staleRoutes.length ? 'gold' : 'white'} />
        <StatCard label="Route Alerts" value={todayDeviationEvents.length} unit="today" icon={Shield} accent={todayDeviationEvents.length ? 'gold' : 'white'} />
      </div>

      <RouteDeviationPanel
        events={recentDeviationEvents}
        employees={employees}
        routeSessions={routeSessions}
      />

      <WeeklyLearningPanel
        rows={weeklyLearningRows}
        approvedTemplateCount={approvedTemplateCount}
        onSaveRouteTemplate={onSaveRouteTemplate}
      />

      {staleRoutes.length > 0 ? (
        <div className="surface-3d border border-amber-400/30 bg-amber-500/10 p-4">
          <div className="font-display text-2xl text-white">GPS Attention</div>
          <div className="mt-1 text-sm text-amber-200">
            {staleRoutes.length} active route{staleRoutes.length === 1 ? '' : 's'} has no recent GPS point. The rider may have denied permission, closed Chrome, or lost signal.
          </div>
        </div>
      ) : null}

      {selectedSession ? (
        <>
          <RouteMap
            session={selectedSession}
            employee={selectedEmployee}
            points={selectedDisplayPoints}
          />
          <ShopPinProofPanel pins={selectedPins} onPreviewPhoto={onPreviewPhoto} />
        </>
      ) : (
        <div className="surface-3d border border-dashed border-zinc-800 p-10 text-center">
          <Route className="mx-auto mb-3 h-12 w-12 text-zinc-700" />
          <div className="font-display text-2xl text-white">No Routes Yet</div>
          <div className="mt-1 text-sm text-zinc-500">Ask a rider to submit Morning Start with location permission allowed.</div>
        </div>
      )}

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Route Sessions</div>
        {rows.length === 0 ? (
          <div className="surface-3d border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            No route sessions have been recorded yet.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.slice(0, 30).map((session) => {
              const employee = employees.find((row) => row.id === session.employeeId);
              const points = mergeSessionLatestPoint(
                pointsBySession[session.id] || [],
                session,
                getLiveLocationForSession(liveRiderLocations, session),
              );
              return (
                <RouteSessionCard
                  key={session.id}
                  session={session}
                  employee={employee}
                  points={points}
                  selected={selectedSession?.id === session.id}
                  deleting={deletingRouteId === session.id}
                  onSelect={() => setSelectedSessionId(session.id)}
                  onDelete={() => handleDeleteRoute(session, employee)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const ShopPinProofPanel = ({ pins = [], onPreviewPhoto }) => (
  <div className="surface-3d border border-blue-300/20 bg-zinc-950/90 p-4">
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-blue-200/80">// Shop Visit Proof</div>
        <div className="font-display text-2xl leading-none text-white">Pinned Shops</div>
        <div className="mt-1 text-xs text-zinc-500">Shop coordinates and optional rider photo proof from the mobile app.</div>
      </div>
      <div className="ops-metric-pill min-w-[82px] border border-blue-300/20 px-3 py-2 text-right">
        <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">photos</div>
        <div className="font-display text-2xl leading-none text-blue-100">
          {pins.filter((pin) => pin.photoPath).length}/{pins.length}
        </div>
      </div>
    </div>

    {pins.length === 0 ? (
      <div className="mini-surface-3d border border-dashed border-zinc-800 bg-black/40 p-5 text-center text-sm text-zinc-500">
        No shops pinned for this route session yet.
      </div>
    ) : (
      <div className="grid gap-2 lg:grid-cols-2">
        {pins.map((pin, index) => (
          <div key={pin.id} className="mini-surface-3d border border-zinc-800 bg-black/45 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-display text-xl leading-none text-white">
                  {index + 1}. {pin.name || 'Shop'}
                </div>
                <div className="mt-1 font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                  {fmtTime(pin.pinnedAt)} | {fmtCoordinate(pin.lat)}, {fmtCoordinate(pin.lng)}
                </div>
              </div>
              {pin.photoPath ? (
                <button
                  onClick={() => onPreviewPhoto?.(pin.photoPath)}
                  className="flex shrink-0 items-center gap-1 border border-orange-500/30 bg-orange-500/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-orange-300 hover:bg-orange-500/20"
                >
                  <Camera className="h-3.5 w-3.5" />
                  Photo
                </button>
              ) : (
                <div className="shrink-0 border border-zinc-800 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-zinc-600">
                  No Photo
                </div>
              )}
            </div>
            <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600">
              Accuracy {pin.accuracyM === null ? '-' : `${Math.round(pin.accuracyM)}m`}
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
);

const RouteDeviationPanel = ({ events, employees, routeSessions }) => {
  const outsideEvents = events.filter((event) => event.eventType === 'outside_route');
  const recentEvents = outsideEvents.slice(0, 6);
  const sessionById = new Map(routeSessions.map((session) => [session.id, session]));

  return (
    <div className="surface-3d border border-red-500/25 bg-zinc-950/90 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-red-300/80">// Phase 6</div>
          <div className="font-display text-2xl leading-none text-white">Route Geofence Alerts</div>
          <div className="mt-1 text-xs text-zinc-500">
            Approved route plans create a corridor and stop radius. Rider phones queue alerts offline and sync them here.
          </div>
        </div>
        <div className="ops-metric-pill min-w-[92px] border border-red-400/20 px-3 py-2 text-right">
          <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">alerts</div>
          <div className="font-display text-2xl leading-none text-red-300">{outsideEvents.length}</div>
        </div>
      </div>

      {recentEvents.length === 0 ? (
        <div className="mini-surface-3d border border-dashed border-zinc-800 bg-black/40 p-5 text-center text-sm text-zinc-500">
          No route deviation alerts synced yet.
        </div>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {recentEvents.map((event) => {
            const session = event.routeSessionId ? sessionById.get(event.routeSessionId) : null;
            const employee = employees.find((row) => row.id === event.employeeId) ?? null;
            const outsideBy = Math.max(0, Number(event.distanceM || 0) - Number(event.radiusM || 0));

            return (
              <div key={event.id} className="mini-surface-3d border border-red-500/20 bg-red-500/5 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-display text-xl leading-none text-white">
                      {employee?.name || 'Unknown rider'}
                    </div>
                    <div className="mt-1 font-mono text-[9px] uppercase tracking-widest text-red-200">
                      {fmtShort(event.recordedAt)} | {fmtTime(event.recordedAt)}
                    </div>
                  </div>
                  <div className="border border-red-400/30 bg-red-500/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-red-200">
                    {fmtDistance(outsideBy)}
                  </div>
                </div>
                <div className="mt-2 text-sm text-zinc-300">{event.message || 'Outside approved route.'}</div>
                <div className="mt-2 flex flex-wrap gap-2 font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                  <span>Route {session?.date ? fmtShort(session.date) : 'unsynced'}</span>
                  <span>Distance {fmtDistance(event.distanceM)}</span>
                  <span>Radius {fmtDistance(event.radiusM)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const WeeklyLearningPanel = ({ rows, approvedTemplateCount, onSaveRouteTemplate }) => {
  const [savingKey, setSavingKey] = useState('');
  const readyRows = rows.filter((row) => row.pinCount > 0);

  const handleApprove = async (row) => {
    const key = `${row.employeeId}:${row.weekday}`;
    setSavingKey(key);
    try {
      await onSaveRouteTemplate({
        employeeId: row.employeeId,
        weekday: row.weekday,
        name: `${row.employee?.name || 'Rider'} ${WEEKDAY_LABELS[row.weekday]} route`,
        status: 'approved',
        sourceStartDate: row.sourceStartDate,
        sourceEndDate: row.sourceEndDate,
        sourcePinCount: row.pinCount,
        duplicateCount: row.duplicateCount,
        stops: row.stops,
      });
    } finally {
      setSavingKey('');
    }
  };

  return (
    <div className="surface-3d border border-orange-500/25 bg-zinc-950/90 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Phase 5</div>
          <div className="font-display text-2xl leading-none text-white">Weekly Market Learning</div>
          <div className="mt-1 text-xs text-zinc-500">
            Rider shop pins are grouped by weekday, duplicates are merged, then approved as reusable route plans.
          </div>
        </div>
        <div className="ops-metric-pill min-w-[92px] border border-green-400/20 px-3 py-2 text-right">
          <div className="font-mono text-[8px] uppercase tracking-widest text-zinc-500">approved</div>
          <div className="font-display text-2xl leading-none text-green-300">{approvedTemplateCount}</div>
        </div>
      </div>

      {readyRows.length === 0 ? (
        <div className="mini-surface-3d border border-dashed border-zinc-800 bg-black/40 p-5 text-center text-sm text-zinc-500">
          No synced shop pins in the last {LEARNING_WINDOW_DAYS} days yet. Ask riders to pin each shop during market visits.
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {readyRows.slice(0, 8).map((row) => {
            const key = `${row.employeeId}:${row.weekday}`;
            const saving = savingKey === key;
            const approved = Boolean(row.approvedTemplate);

            return (
              <div key={key} className="mini-surface-3d border border-zinc-800 bg-black/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-display text-xl leading-none text-white">
                      {row.employee?.name || 'Unknown rider'}
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-amber-300">
                      {WEEKDAY_LABELS[row.weekday]} market
                    </div>
                  </div>
                  <div className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${
                    approved
                      ? 'border-green-400/30 bg-green-500/10 text-green-300'
                      : 'border-amber-400/30 bg-amber-500/10 text-amber-300'
                  }`}>
                    {approved ? 'Approved' : 'Learning'}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-4 gap-2">
                  <div className="ops-metric-pill border border-orange-500/15 px-2 py-2">
                    <div className="font-mono text-[8px] uppercase text-zinc-500">pins</div>
                    <div className="font-display text-xl text-orange-300">{row.pinCount}</div>
                  </div>
                  <div className="ops-metric-pill border border-blue-300/15 px-2 py-2">
                    <div className="font-mono text-[8px] uppercase text-zinc-500">stops</div>
                    <div className="font-display text-xl text-blue-100">{row.stops.length}</div>
                  </div>
                  <div className="ops-metric-pill border border-amber-400/15 px-2 py-2">
                    <div className="font-mono text-[8px] uppercase text-zinc-500">dupes</div>
                    <div className="font-display text-xl text-amber-300">{row.duplicateCount}</div>
                  </div>
                  <div className="ops-metric-pill border border-green-400/15 px-2 py-2">
                    <div className="font-mono text-[8px] uppercase text-zinc-500">score</div>
                    <div className="font-display text-xl text-green-300">{row.confidence}</div>
                  </div>
                </div>

                <div className="mt-3 text-xs text-zinc-500">
                  Window: {fmtShort(row.sourceStartDate)} to {fmtShort(row.sourceEndDate)} | Visit days: {row.visitDays}
                </div>

                <div className="mt-3 space-y-1.5">
                  {row.stops.slice(0, 4).map((stop) => (
                    <div key={stop.id} className="flex items-center justify-between gap-2 border border-zinc-900 bg-zinc-950 px-2 py-1.5">
                      <div className="truncate text-xs text-zinc-200">{stop.stopOrder}. {stop.name}</div>
                      <div className="font-mono text-[9px] uppercase text-zinc-500">{stop.visitCount} visit{stop.visitCount === 1 ? '' : 's'}</div>
                    </div>
                  ))}
                  {row.stops.length > 4 ? (
                    <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">
                      +{row.stops.length - 4} more stops
                    </div>
                  ) : null}
                </div>

                <button
                  onClick={() => handleApprove(row)}
                  disabled={saving || row.stops.length === 0}
                  className="button-3d button-3d-primary glow-orange mt-3 w-full py-2.5 font-display tracking-widest disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? 'SAVING TEMPLATE...' : approved ? 'REPLACE APPROVED TEMPLATE' : 'APPROVE ROUTE TEMPLATE'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const AdminEmployees = ({ employees, onSave, onDelete, onResetPin, onShowToast }) => {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);

  return (
    <div className="dashboard-3d p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Fleet Roster</div>
          <div className="font-display text-3xl leading-none text-white">
            <AnimatedCounter value={employees.length} /> Riders
          </div>
          <div className="mt-1 text-xs text-zinc-500">Add, edit, or reset PINs for the riders you manage.</div>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setShowModal(true);
          }}
          className="button-3d button-3d-primary glow-orange flex shrink-0 items-center gap-1.5 px-4 py-2.5 font-display tracking-widest"
        >
          <UserPlus className="h-4 w-4" /> ADD
        </button>
      </div>

      {employees.length === 0 ? (
        <div className="empty-state p-10 text-center">
          <Users className="empty-icon mx-auto mb-4 h-14 w-14 text-orange-500/80" />
          <div className="mb-1 font-display text-2xl text-white">No Riders Yet</div>
          <div className="mb-4 text-sm text-zinc-400">Add your first rider to start tracking fuel usage.</div>
          <button
            onClick={() => {
              setEditing(null);
              setShowModal(true);
            }}
            className="button-3d button-3d-primary glow-orange px-6 py-3 font-display tracking-widest"
          >
            + ADD FIRST RIDER
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {employees.map((employee, employeeIndex) => {
            const initial = (employee.name || '?').trim().charAt(0).toUpperCase() || '?';
            return (
              <div
                key={employee.id}
                className="ops-ledger-row fade-up grid gap-3 border border-white/5 p-4"
                style={{ animationDelay: `${Math.min(employeeIndex, 10) * 60}ms` }}
              >
                <div className="flex items-start gap-3">
                  <div className="ledger-rider-avatar flex h-14 w-14 shrink-0 items-center justify-center border border-orange-500/35 bg-gradient-to-br from-orange-500/25 via-amber-500/10 to-transparent">
                    <span className="font-display text-3xl leading-none text-orange-300">{initial}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-2xl leading-none text-white">{employee.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] uppercase tracking-widest text-blue-200/60">
                      <span>@{employee.username}</span>
                      {employee.bikeModel ? (
                        <>
                          <span className="text-zinc-700">·</span>
                          <span className="text-zinc-400">{employee.bikeModel}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => {
                        setEditing(employee);
                        setShowModal(true);
                      }}
                      className="mini-surface-3d flex h-10 w-10 items-center justify-center border border-zinc-800 bg-zinc-900 transition-colors hover:border-orange-500 hover:bg-orange-500/10"
                      aria-label="Edit rider"
                    >
                      <Edit2 className="h-4 w-4 text-orange-500" />
                    </button>
                    <button
                      onClick={() => onResetPin(employee)}
                      className="mini-surface-3d flex h-10 w-10 items-center justify-center border border-zinc-800 bg-zinc-900 transition-colors hover:border-amber-500 hover:bg-amber-500/10"
                      aria-label="Reset PIN"
                    >
                      <KeyRound className="h-4 w-4 text-amber-400" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="ops-metric-pill border border-orange-500/15 px-3 py-2">
                    <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-zinc-500">
                      <Bike className="h-3 w-3 text-amber-500" /> Plate
                    </div>
                    <div className="mt-1 truncate font-display text-base leading-none text-amber-300">
                      {employee.bikePlate || '—'}
                    </div>
                  </div>
                  <div className="ops-metric-pill border border-blue-300/15 px-3 py-2">
                    <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-zinc-500">
                      <Phone className="h-3 w-3 text-blue-300" /> Phone
                    </div>
                    <div className="mt-1 truncate font-display text-base leading-none text-zinc-100">
                      {employee.phone || '—'}
                    </div>
                  </div>
                  <div className="ops-metric-pill border border-green-400/15 px-3 py-2">
                    <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-zinc-500">
                      <Fuel className="h-3 w-3 text-green-300" /> km/L
                    </div>
                    <div className="mt-1 font-display text-base leading-none text-green-300">
                      {employee.mileage ?? 'default'}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editing ? 'EDIT RIDER' : 'NEW RIDER'} fullScreen>
        <EmployeeForm
          employee={editing}
          onShowToast={onShowToast}
          onSave={async (employee, options) => {
            try {
              await onSave(employee, options);
              setShowModal(false);
            } catch {
              // Keep the modal open so the admin can fix the form or retry.
            }
          }}
          onDelete={editing ? async (employeeId) => {
            try {
              await onDelete(employeeId);
              setShowModal(false);
            } catch {
              // Leave the modal open when deletion fails.
            }
          } : null}
          onCancel={() => setShowModal(false)}
        />
      </Modal>
    </div>
  );
};

const ResetPinModal = ({ employee, busy, onClose, onConfirm }) => {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

  useEffect(() => {
    setPin('');
    setConfirmPin('');
  }, [employee]);

  const valid = /^\d{4}$/.test(pin) && pin === confirmPin;

  return (
    <Modal open={Boolean(employee)} onClose={onClose} title="RESET RIDER PIN">
      <div className="space-y-4">
        <div className="surface-3d border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="font-display text-xl text-white">{employee?.name}</div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-300">
            @{employee?.username} | New PIN required
          </div>
        </div>
        <Input
          label="New 4-digit PIN"
          icon={KeyRound}
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/[^\d]/g, '').slice(0, 4))}
          placeholder="1234"
        />
        <Input
          label="Confirm PIN"
          icon={KeyRound}
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={confirmPin}
          onChange={(event) => setConfirmPin(event.target.value.replace(/[^\d]/g, '').slice(0, 4))}
          placeholder="1234"
        />
        <button
          onClick={() => valid && onConfirm(pin)}
          disabled={!valid || busy}
          className="glow-orange w-full bg-gradient-to-r from-orange-500 to-amber-500 py-3 font-display tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'RESETTING...' : 'RESET PIN'}
        </button>
      </div>
    </Modal>
  );
};

const FUEL_FEED_URL =
  'https://raw.githubusercontent.com/chabdulhanan555-star/fleetline-supabase/main/data/fuel-prices.json';

const AdminSettings = ({ config, fuelPriceHistory = [], onSave }) => {
  const [form, setForm] = useState(config);
  const [saved, setSaved] = useState(false);
  const [feed, setFeed] = useState(null);
  const [feedApplying, setFeedApplying] = useState(false);
  const [feedApplied, setFeedApplied] = useState(false);
  const [feedDismissed, setFeedDismissed] = useState(false);

  useEffect(() => {
    setForm(config);
  }, [config]);

  // Pull the latest scraped fuel price from the GitHub-hosted feed.
  // Cache-busted with the current hour so we get a refresh at most hourly
  // (the GitHub raw URL is CDN-cached).
  useEffect(() => {
    let cancelled = false;
    const cacheBuster = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    fetch(`${FUEL_FEED_URL}?t=${cacheBuster}`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setFeed(data);
      })
      .catch(() => {
        // Silent fail -- feed is a nice-to-have, manual entry still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    try {
      await onSave(form);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch {
      // Toast state is handled upstream.
    }
  };

  const feedPetrol = feed?.petrol ?? null;
  const currentPrice = Number(form.fuelPrice);
  const feedDiffers =
    feedPetrol &&
    Number.isFinite(feedPetrol) &&
    Number.isFinite(currentPrice) &&
    Math.abs(feedPetrol - currentPrice) > 0.01;
  const feedFreshness = feed?.lastSuccessfulFetch ? Date.parse(feed.lastSuccessfulFetch) : null;
  const feedHoursOld = feedFreshness ? Math.floor((Date.now() - feedFreshness) / 3600000) : null;

  const handleApplyFeedPrice = async () => {
    if (!feedPetrol) return;
    setFeedApplying(true);
    try {
      await onSave({ ...form, fuelPrice: feedPetrol });
      setForm((current) => ({ ...current, fuelPrice: feedPetrol }));
      setFeedApplied(true);
      window.setTimeout(() => setFeedApplied(false), 2400);
    } catch {
      // Toast handled upstream
    } finally {
      setFeedApplying(false);
    }
  };

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// System</div>
        <div className="font-display text-3xl leading-none text-white">Settings</div>
      </div>

      <div className="surface-3d border border-zinc-800 bg-zinc-950 p-5">
        <div className="mb-4 font-display text-xl text-orange-500">FUEL CONFIG</div>
        <Input
          label="Currency Code"
          icon={DollarSign}
          value={form.currency}
          onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}
          placeholder="PKR"
        />
        <Input
          label={`Fuel Price per Litre (${form.currency})`}
          icon={Fuel}
          type="number"
          value={form.fuelPrice}
          onChange={(event) => setForm((current) => ({ ...current, fuelPrice: event.target.value }))}
        />
        {feedApplied ? (
          <div className="-mt-2 mb-4 flex items-center gap-2 border border-green-500/30 bg-green-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-green-300">
            <CheckCircle className="h-3.5 w-3.5" /> Applied feed price
          </div>
        ) : null}
        {feedDiffers && !feedDismissed && !feedApplied ? (
          <div className="mb-4 border border-orange-500/40 bg-orange-500/10 p-4">
            <div className="mb-1 flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-orange-300" />
              <div className="font-mono text-[10px] uppercase tracking-widest text-orange-200">
                News feed shows new price
              </div>
            </div>
            <div className="text-sm text-zinc-300">
              <span className="font-display text-2xl text-amber-300">{form.currency} {feedPetrol.toFixed(2)}</span>
              <span className="ml-2 text-zinc-500">vs your saved {form.currency} {currentPrice.toFixed(2)}</span>
            </div>
            <div className="mt-1 font-mono text-[10px] text-zinc-500">
              Source: {feed?.source || 'feed'}
              {feedHoursOld !== null
                ? ` · fetched ${feedHoursOld === 0 ? '<1 hr' : `${feedHoursOld} hr${feedHoursOld === 1 ? '' : 's'}`} ago`
                : ''}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setFeedDismissed(true)}
                disabled={feedApplying}
                className="mini-surface-3d border border-zinc-800 bg-zinc-900 px-4 py-2 font-mono text-xs uppercase tracking-widest text-zinc-300 disabled:opacity-50"
              >
                Dismiss
              </button>
              <button
                onClick={handleApplyFeedPrice}
                disabled={feedApplying}
                className="button-3d button-3d-primary glow-orange flex flex-1 items-center justify-center gap-2 px-4 py-2 font-display tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
              >
                {feedApplying ? 'APPLYING' : `APPLY ${form.currency} ${feedPetrol.toFixed(2)}`}
              </button>
            </div>
          </div>
        ) : null}
        {feed && feed.success && !feedDiffers && !feedApplied ? (
          <div className="-mt-2 mb-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-green-400/70">
            <CheckCircle className="h-3 w-3" />
            Feed matches saved price
            {feed.source ? <span className="text-zinc-600">· {feed.source}</span> : null}
          </div>
        ) : null}
        {feed && feed.success === false ? (
          <div className="-mt-2 mb-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            <RefreshCw className="h-3 w-3" />
            Feed unavailable · using your saved price
          </div>
        ) : null}
        <Input
          label="Default Mileage (km/L)"
          icon={Gauge}
          type="number"
          value={form.defaultMileage}
          onChange={(event) => setForm((current) => ({ ...current, defaultMileage: event.target.value }))}
        />
      </div>

      <div className="surface-3d border border-orange-500/25 bg-zinc-950 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Fuel className="h-5 w-5 text-orange-500" />
          <div className="font-display text-xl text-orange-500">FUEL PRICE HISTORY</div>
        </div>
        <div className="mb-3 text-xs text-zinc-400">
          Each daily close uses the fuel price saved for that day, so old reports do not change when petrol changes later.
        </div>
        <div className="space-y-2">
          {fuelPriceHistory.slice(0, 8).map((row) => (
            <div key={row.date} className="mini-surface-3d flex items-center justify-between border border-zinc-800 bg-black/40 px-3 py-2">
              <div className="font-mono text-[10px] uppercase text-zinc-500">{fmtDate(row.date)}</div>
              <div className="font-display text-xl leading-none text-amber-400">
                {row.currency} {row.fuelPrice}
              </div>
            </div>
          ))}
          {fuelPriceHistory.length === 0 ? (
            <div className="mini-surface-3d border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
              No fuel price history yet. Save settings once to lock today&apos;s price.
            </div>
          ) : null}
        </div>
      </div>

      <div className="surface-3d border border-[#25D366]/30 bg-zinc-950 p-5">
        <div className="mb-3 flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-[#25D366]" />
          <div className="font-display text-xl text-[#25D366]">WHATSAPP SHARE</div>
        </div>
        <div className="mb-3 text-xs text-zinc-400">
          Riders can open WhatsApp with a pre-filled reading summary after submitting.
        </div>
        <Input
          label="Admin WhatsApp"
          icon={Phone}
          value={form.adminWhatsApp}
          onChange={(event) => setForm((current) => ({ ...current, adminWhatsApp: event.target.value }))}
          placeholder="+92 300 1234567"
        />
      </div>

      <div className="surface-3d border border-zinc-800 bg-zinc-950 p-5">
        <div className="mb-3 flex items-center gap-2">
          <PackageCheck className="h-5 w-5 text-amber-400" />
          <div className="font-display text-xl text-amber-400">SUPABASE + PWA</div>
        </div>
        <div className="space-y-2 text-sm text-zinc-400">
          <div>Supabase now handles auth, realtime data, storage, and retention cleanup.</div>
          <div>The PWA still works offline and queues rider submissions in IndexedDB until the network returns.</div>
        </div>
      </div>

      <button
        onClick={handleSave}
        className="button-3d button-3d-primary glow-orange w-full py-3 font-display tracking-widest"
      >
        {saved ? 'ALL SETTINGS SAVED' : 'SAVE SETTINGS'}
      </button>
    </div>
  );
};

const AdminsPanel = ({ admins, onRefresh, onInvite }) => {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Access</div>
          <div className="font-display text-3xl leading-none text-white">Admins</div>
        </div>
        <button
          onClick={onRefresh}
          className="mini-surface-3d flex h-10 w-10 items-center justify-center border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-orange-500 hover:text-orange-500"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="surface-3d border border-zinc-800 bg-zinc-950 p-5">
        <div className="mb-4 font-display text-xl text-orange-500">INVITE ADMIN</div>
        <Input
          label="Email"
          icon={MessageCircle}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="new-admin@example.com"
        />
        <button
          onClick={async () => {
            if (!email) return;
            setSubmitting(true);
            try {
              await onInvite(email);
              setEmail('');
            } catch {
              // Toast state is handled upstream.
            } finally {
              setSubmitting(false);
            }
          }}
          disabled={submitting || !email}
          className="button-3d button-3d-primary glow-orange w-full py-3 font-display tracking-widest disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'SENDING INVITE...' : 'SEND INVITE'}
        </button>
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Current Admins</div>
        <div className="space-y-2">
          {admins.map((admin) => (
            <div key={admin.userId} className="surface-3d border border-zinc-800 bg-zinc-950 p-4">
              <div className="font-semibold text-white">{admin.email}</div>
              <div className="mt-1 font-mono text-[10px] uppercase text-zinc-500">
                Added {fmtDate(admin.createdAt)}
              </div>
            </div>
          ))}
          {admins.length === 0 ? (
            <div className="surface-3d border border-dashed border-zinc-800 p-6 text-center text-zinc-500">
              No admins loaded yet.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const EmployeeRouteHistory = ({ employee, routeSessions = [], routePoints = [], selectedMonth, onLoadRoutePoints }) => {
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const pointsBySession = useMemo(() => groupRoutePointsBySession(routePoints), [routePoints]);
  const rows = useMemo(
    () =>
      routeSessions
        .filter((session) => session.employeeId === employee.id && monthKey(session.date) === selectedMonth)
        .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()),
    [employee.id, routeSessions, selectedMonth],
  );
  const selectedSession = rows.find((session) => session.id === selectedSessionId) ?? rows[0] ?? null;
  const selectedPoints = selectedSession ? pointsBySession[selectedSession.id] || [] : [];

  useEffect(() => {
    if (!rows.some((row) => row.id === selectedSessionId)) {
      setSelectedSessionId(rows[0]?.id ?? null);
    }
  }, [rows, selectedSessionId]);

  useEffect(() => {
    if (selectedSession?.id) {
      onLoadRoutePoints?.(selectedSession.id);
    }
  }, [selectedSession?.id]);

  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// GPS Route Proof</div>
      {rows.length === 0 ? (
        <div className="empty-state p-8 text-center">
          <Route className="empty-icon mx-auto mb-3 h-10 w-10 text-orange-500/80" />
          <div className="text-sm text-zinc-400">No GPS route recorded for this month.</div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1">
            {rows.map((session) => {
              const points = pointsBySession[session.id] || [];
              return (
                <button
                  key={session.id}
                  onClick={() => setSelectedSessionId(session.id)}
                  className={`mini-surface-3d whitespace-nowrap border px-3 py-2 text-left ${
                    selectedSession?.id === session.id
                      ? 'border-orange-500 bg-orange-500/10 text-orange-500'
                      : 'border-zinc-800 bg-zinc-950 text-zinc-400'
                  }`}
                >
                  <div className="font-display text-lg leading-none">{fmtShort(session.date)}</div>
                  <div className="font-mono text-[9px] uppercase">
                    {session.status} | {session.pointCount || points.length} points
                  </div>
                </button>
              );
            })}
          </div>
          {selectedSession ? (
            <RouteMap session={selectedSession} employee={employee} points={selectedPoints} />
          ) : null}
        </div>
      )}
    </div>
  );
};

const EmployeeDetailView = ({
  employee,
  readings,
  config,
  routeSessions,
  routePoints,
  fuelPriceHistory,
  onLoadRoutePoints,
  onBack,
  onUpdateEmployee,
  onDeleteEmployee,
  onDeleteReading,
  onResetPin,
  onShowToast,
  onPreviewPhoto,
}) => {
  const [showEdit, setShowEdit] = useState(false);
  const [deletingReadingId, setDeletingReadingId] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(monthKey(today()));

  const months = [...new Set(sortReadingsAsc(readings).map((reading) => monthKey(reading.date)))];
  const filtered = sortReadingsAsc(readings).filter((reading) => monthKey(reading.date) === selectedMonth);
  const mileage = Number(employee.mileage ?? config.defaultMileage);
  const monthlySummary = getMonthlySummary(filtered, selectedMonth, mileage, config.fuelPrice, fuelPriceHistory);
  const distance = monthlySummary.totalKm;
  const fuelUsed = monthlySummary.fuelUsed;
  const cost = monthlySummary.cost;

  return (
    <div className="dashboard-3d">
      <div className="surface-3d border-b border-orange-500/20 bg-gradient-to-b from-orange-500/20 to-transparent p-5">
        <button
          onClick={onBack}
          className="mb-3 flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-amber-500 hover:text-orange-500"
        >
          <ArrowLeft className="h-3 w-3" /> Back to overview
        </button>
        <div className="flex items-start gap-3">
          <div className="flex h-16 w-16 items-center justify-center bg-gradient-to-br from-orange-500 to-amber-600">
            <User className="h-8 w-8 text-black" strokeWidth={2.5} />
          </div>
          <div className="flex-1">
            <div className="font-display text-3xl leading-none text-white">{employee.name}</div>
            <div className="mt-1 font-mono text-sm text-amber-400">{employee.bikePlate}</div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
              @{employee.username} | {employee.bikeModel || 'bike'}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onResetPin(employee)}
              className="mini-surface-3d flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-amber-500"
            >
              <KeyRound className="h-4 w-4 text-amber-400" />
            </button>
            <button
              onClick={() => setShowEdit(true)}
              className="mini-surface-3d flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-orange-500"
            >
              <Edit2 className="h-4 w-4 text-orange-500" />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
        {months.length > 1 ? (
          <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">
            {months.map((value) => (
              <button
                key={value}
                onClick={() => setSelectedMonth(value)}
                className={`mini-surface-3d whitespace-nowrap border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
                  selectedMonth === value
                    ? 'border-orange-500 bg-orange-500 text-black'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400'
                }`}
              >
                {formatAppDate(`${value}-01T00:00:00`, { month: 'short', year: '2-digit' })}
              </button>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <StatCard label="Monthly KM" value={fmtNum(Math.round(distance))} unit="km" icon={TrendingUp} accent="orange" />
          <StatCard label="Fuel" value={fuelUsed.toFixed(2)} unit="L" icon={Fuel} accent="gold" />
          <StatCard label="Monthly Fuel Cost" value={fmtNum(Math.round(cost))} unit={config.currency} icon={DollarSign} accent="orange" />
          <StatCard label="Readings" value={filtered.length} unit="entries" icon={CheckCircle} accent="gold" />
        </div>

        {readings.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => downloadCSV(buildEmployeeCSV(employee, { [employee.id]: readings }, config, selectedMonth, fuelPriceHistory), `${employee.username}_${selectedMonth}.csv`)}
              className="mini-surface-3d flex items-center justify-center gap-1.5 border border-amber-400/40 bg-zinc-950 py-2.5 font-display text-sm tracking-widest text-amber-400 hover:bg-amber-400/10"
            >
              <FileDown className="h-3.5 w-3.5" /> MONTH CSV
            </button>
            <button
              onClick={() => downloadCSV(buildEmployeeCSV(employee, { [employee.id]: readings }, config, null, fuelPriceHistory), `${employee.username}_all.csv`)}
              className="mini-surface-3d flex items-center justify-center gap-1.5 border border-orange-500/40 bg-zinc-950 py-2.5 font-display text-sm tracking-widest text-orange-500 hover:bg-orange-500/10"
            >
              <Upload className="h-3.5 w-3.5" /> ALL TIME
            </button>
          </div>
        ) : null}

        <EmployeeRouteHistory
          employee={employee}
          routeSessions={routeSessions}
          routePoints={routePoints}
          selectedMonth={selectedMonth}
          onLoadRoutePoints={onLoadRoutePoints}
        />

        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Reading History</div>
          {filtered.length === 0 ? (
            <div className="surface-3d border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No readings for this month.</div>
          ) : (
            <div className="space-y-1">
              {[...filtered].reverse().map((reading, index, list) => {
                const previous = list[index + 1];
                const diff = previous ? reading.km - previous.km : null;
                return (
                  <div key={reading.id} className="surface-3d flex items-center gap-3 border border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex h-10 w-10 flex-col items-center justify-center border border-orange-500/40">
                      <div className="font-display text-sm leading-none text-orange-500">{formatAppDate(reading.date, { day: 'numeric' })}</div>
                      <div className="font-mono text-[8px] uppercase text-amber-500">
                        {formatAppDate(reading.date, { month: 'short' })}
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="font-mono text-xs uppercase text-zinc-500">{readingTypeLabel(reading)} Odo</div>
                      <div className="font-display text-2xl leading-none text-white">
                        {fmtNum(reading.km)} <span className="text-xs text-zinc-500">km</span>
                      </div>
                      <div className="font-mono text-[10px] uppercase text-zinc-500">
                        {fmtDate(reading.date)} | {fmtTime(reading.submittedAt)}
                      </div>
                    </div>
                    {diff !== null ? (
                      <div className="text-right">
                        <div className="font-mono text-[10px] uppercase text-zinc-500">+diff</div>
                        <div className={`font-display text-xl ${diff >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                          {diff >= 0 ? '+' : ''}
                          {fmtNum(diff)}
                        </div>
                      </div>
                    ) : null}
                    {reading.photoPath ? (
                      <button
                        onClick={() => onPreviewPhoto(reading.photoPath)}
                        className="mini-surface-3d border border-orange-500/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-orange-500 hover:text-amber-400"
                      >
                        PHOTO
                      </button>
                    ) : null}
                    <button
                      onClick={async () => {
                        const label = `${readingTypeLabel(reading)} reading on ${fmtDate(reading.date)}`;
                        const shouldDelete = window.confirm(
                          `Delete this ${label}? The photo will also be removed and monthly totals will update.`,
                        );
                        if (!shouldDelete) return;

                        setDeletingReadingId(reading.id);
                        try {
                          await onDeleteReading(reading);
                        } finally {
                          setDeletingReadingId(null);
                        }
                      }}
                      disabled={deletingReadingId === reading.id}
                      className="mini-surface-3d border border-red-500/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingReadingId === reading.id ? 'DELETING' : 'DELETE'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <Modal open={showEdit} onClose={() => setShowEdit(false)} title="EDIT RIDER" fullScreen>
        <EmployeeForm
          employee={employee}
          onShowToast={onShowToast}
          onSave={async (nextEmployee, options) => {
            try {
              await onUpdateEmployee(nextEmployee, options);
              setShowEdit(false);
            } catch {
              // Keep the modal open when save fails.
            }
          }}
          onDelete={async (employeeId) => {
            try {
              await onDeleteEmployee(employeeId);
              setShowEdit(false);
              onBack();
            } catch {
              // Keep the modal open when deletion fails.
            }
          }}
          onCancel={() => setShowEdit(false)}
        />
      </Modal>
    </div>
  );
};

const RiderSubmitView = ({
  employee,
  readings,
  config,
  queuedCount,
  queuedRouteCount,
  failedCount,
  syncingCount,
  routeTracking,
  onRetrySync,
  onSubmit,
  onShareWhatsApp,
  onShowToast,
}) => {
  const fileInput = useRef(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [reading, setReading] = useState('');
  const [readingType, setReadingType] = useState(() => getNextReadingType(readings));
  const [submitting, setSubmitting] = useState(false);

  const allReadings = sortReadingsAsc(readings);
  const lastReading = allReadings.length > 0 ? allReadings.at(-1) : null;
  const todayDate = today();
  const todaySummary = getDaySummary(allReadings, todayDate);
  const mileage = Number(employee.mileage ?? config.defaultMileage);
  const fuelPrice = Number(config.fuelPrice);
  const selectedTypeConfig = READING_TYPES[readingType];
  const SelectedTypeIcon = selectedTypeConfig.icon;
  const selectedTypeReading = readingType === 'morning' ? todaySummary.morning : todaySummary.evening;
  const enteredKm = Number.parseInt(reading, 10);
  const hasEnteredKm = !Number.isNaN(enteredKm) && enteredKm >= 0;
  const projectedRawDistance = readingType === 'evening' && todaySummary.morning && hasEnteredKm
    ? enteredKm - todaySummary.morning.km
    : null;
  const projectedDistance = projectedRawDistance === null ? 0 : Math.max(0, projectedRawDistance);
  const projectedFuel = mileage > 0 ? projectedDistance / mileage : 0;
  const projectedCost = projectedFuel * fuelPrice;
  const routeStatus = routeTracking?.status ?? 'idle';
  const routeTone =
    routeStatus === 'active'
      ? 'green'
      : routeStatus === 'requesting'
        ? 'amber'
        : routeStatus === 'error'
          ? 'red'
          : routeStatus === 'completed'
            ? 'zinc'
            : 'amber';
  const canSubmit =
    Boolean(photoFile) &&
    Boolean(reading) &&
    !submitting &&
    !selectedTypeReading &&
    (readingType === 'morning' || Boolean(todaySummary.morning));

  useEffect(() => {
    setReadingType(getNextReadingType(readings));
  }, [readings]);

  const resetForm = () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview('');
    setReading('');
  };

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Daily Submission</div>
        <div className="font-display text-3xl leading-none text-white">
          {formatAppDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {Object.entries(READING_TYPES).map(([type, option]) => {
          const TypeIcon = option.icon;
          const submittedReading = type === 'morning' ? todaySummary.morning : todaySummary.evening;
          const locked = type === 'evening' && !todaySummary.morning;
          const active = readingType === type;

          return (
            <button
              key={type}
              onClick={() => !locked && setReadingType(type)}
              disabled={locked}
              className={`surface-3d border p-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                active
                  ? 'border-orange-500 bg-orange-500/10'
                  : submittedReading
                    ? 'border-green-500/30 bg-green-500/10'
                    : 'border-zinc-800 bg-zinc-950'
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <TypeIcon className={active ? 'h-5 w-5 text-orange-500' : 'h-5 w-5 text-amber-400'} />
                {submittedReading ? <CheckCircle className="h-4 w-4 text-green-400" /> : null}
              </div>
              <div className="font-display text-xl leading-none text-white">{option.label}</div>
              <div className="mt-1 font-mono text-[10px] uppercase text-zinc-500">
                {submittedReading ? `${fmtNum(submittedReading.km)} km submitted` : locked ? 'Submit morning first' : 'Pending'}
              </div>
            </button>
          );
        })}
      </div>

      <div className="surface-3d border border-zinc-800 bg-zinc-950 p-4">
        <div className="mb-2 flex items-center gap-2">
          <SelectedTypeIcon className="h-4 w-4 text-orange-500" />
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500">
            Current step: {selectedTypeConfig.label}
          </div>
        </div>
        <div className="text-sm text-zinc-400">{selectedTypeConfig.helper}</div>
        {todaySummary.complete ? (
          <div className={`mini-surface-3d mt-3 border p-3 ${todaySummary.invalid ? 'border-red-500/30 bg-red-500/10' : 'border-green-500/30 bg-green-500/10'}`}>
            <div className={`font-display text-2xl ${todaySummary.invalid ? 'text-red-300' : 'text-green-300'}`}>
              Today: {fmtNum(todaySummary.distance)} km
            </div>
            <div className="font-mono text-[10px] uppercase text-zinc-400">
              Fuel {mileage > 0 ? (todaySummary.distance / mileage).toFixed(2) : '0.00'} L | {config.currency}{' '}
              {fmtNum(Math.round((mileage > 0 ? todaySummary.distance / mileage : 0) * fuelPrice))}
            </div>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase">
            <div className={todaySummary.morning ? 'text-green-400' : 'text-zinc-500'}>
              Morning: {todaySummary.morning ? 'done' : 'pending'}
            </div>
            <div className={todaySummary.evening ? 'text-green-400' : 'text-zinc-500'}>
              Evening: {todaySummary.evening ? 'done' : 'pending'}
            </div>
          </div>
        )}
      </div>

      <div className={`surface-3d border p-4 ${statusClasses[routeTone]} ${routeStatus === 'active' ? 'route-live-card' : ''}`}>
        <div className="flex items-start gap-3">
          <div className={`flex h-10 w-10 items-center justify-center border ${statusClasses[routeTone]} ${routeStatus === 'active' ? 'route-icon-live' : ''}`}>
            <MapPin className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display text-2xl leading-none text-white">
              {routeStatus === 'active'
                ? 'Route Tracking Active'
                : routeStatus === 'requesting'
                  ? 'Allow Location'
                  : routeStatus === 'completed'
                    ? 'Route Closed'
                    : 'GPS Route Proof'}
            </div>
            <div className="mt-1 text-xs text-zinc-400">
              Morning Start begins GPS proof automatically. Keep this Chrome tab open during market work for live tracking.
            </div>
            {routeTracking?.message ? (
              <div className="mt-2 font-mono text-[10px] uppercase tracking-widest">
                {routeTracking.message}
              </div>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase text-zinc-500 sm:grid-cols-3 sm:text-[9px]">
              <div>
                Points
                <div className="font-display text-xl text-white">{routeTracking?.pointCount ?? 0}</div>
              </div>
              <div>
                GPS
                <div className="font-display text-xl text-amber-400">{fmtDistance(routeTracking?.totalDistanceM ?? 0)}</div>
              </div>
              <div className="col-span-2 sm:col-span-1">
                Queued
                <div className="font-display text-xl text-orange-500">{queuedRouteCount ?? 0}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {queuedCount > 0 || queuedRouteCount > 0 ? (
        <div className={`surface-3d border p-4 ${failedCount > 0 ? 'border-red-500/30 bg-red-500/10 pulse-attention' : 'border-amber-500/30 bg-amber-500/10'}`}>
          <div className="mb-1 flex items-center gap-2">
            <CloudOff className={`h-4 w-4 ${failedCount > 0 ? 'text-red-300' : 'text-amber-400'}`} />
            <div className={`font-mono text-[10px] uppercase tracking-widest ${failedCount > 0 ? 'text-red-200' : 'text-amber-300'}`}>
              {failedCount > 0
                ? `${failedCount} failed | ${queuedCount - failedCount} waiting`
                : `${queuedCount} readings | ${queuedRouteCount ?? 0} GPS items${syncingCount > 0 ? ` | ${syncingCount} syncing` : ' | will sync on reconnect'}`}
            </div>
          </div>
          <div className="text-xs text-zinc-400">Queued readings and GPS points stay on this device until they upload successfully.</div>
          {failedCount > 0 || queuedRouteCount > 0 ? (
            <button
              onClick={onRetrySync}
              className="mt-3 border border-red-400/50 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-red-200"
            >
              Retry sync
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="surface-3d border-2 border-dashed border-zinc-800 bg-zinc-950 p-5">
        {!photoPreview ? (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="mb-3 flex h-16 w-16 items-center justify-center border border-orange-500/30 bg-orange-500/10">
              <Camera className="h-8 w-8 text-orange-500" />
            </div>
            <div className="font-display text-xl text-white">Photo Required</div>
            <div className="mb-4 mt-1 text-xs text-zinc-500">Every reading must include an odometer photo.</div>
            <button
              onClick={() => fileInput.current?.click()}
              className="button-3d button-3d-primary glow-orange flex items-center gap-2 px-6 py-3 font-display tracking-widest"
            >
              <Camera className="h-4 w-4" /> TAKE PHOTO
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setPhotoFile(file);
                setPhotoPreview(URL.createObjectURL(file));
              }}
              className="hidden"
            />
          </div>
        ) : (
          <div>
            <div className="relative">
              <img src={photoPreview} alt="Odometer preview" className="h-56 w-full border border-orange-500/30 object-cover" />
              {submitting ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 backdrop-blur-sm">
                  <div className="ghost-upload-orb flex h-12 w-12 items-center justify-center">
                    <Camera className="h-6 w-6 text-orange-300" />
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-amber-300">Uploading photo...</div>
                </div>
              ) : null}
            </div>
            <button
              onClick={() => {
                if (photoPreview) URL.revokeObjectURL(photoPreview);
                resetForm();
              }}
              disabled={submitting}
              className="mt-2 w-full py-2 font-mono text-xs uppercase tracking-widest text-zinc-500 transition-colors hover:text-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Retake photo
            </button>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Enter Reading</div>
        <div className="surface-3d border-2 border-zinc-800 bg-black p-4">
          <div className="mb-2 flex items-center gap-2">
            <Gauge className="h-4 w-4 text-amber-500" />
            <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Odometer Reading (KM)</div>
          </div>
          <label className="relative flex w-full cursor-text items-center">
            {reading ? (
              <Odometer
                value={reading}
                length={Math.max(5, String(reading).length)}
                className="font-display text-5xl tracking-widest text-white"
              />
            ) : (
              <span className="font-display text-5xl tracking-widest text-zinc-700">00000</span>
            )}
            <input
              type="text"
              inputMode="numeric"
              pattern="\d*"
              value={reading}
              onChange={(event) => setReading(event.target.value.replace(/[^\d]/g, ''))}
              className="absolute inset-0 h-full w-full opacity-0"
              autoComplete="off"
              aria-label="Odometer reading"
            />
          </label>
          {lastReading ? (
            <div className="mt-2 font-mono text-[10px] uppercase text-zinc-500">
              Last: {fmtNum(lastReading.km)} km ({readingTypeLabel(lastReading)} | {fmtShort(lastReading.date)})
            </div>
          ) : null}
          {selectedTypeReading ? (
            <div className="mt-2 font-mono text-[10px] uppercase text-green-400">
              {selectedTypeConfig.label} already submitted today.
            </div>
          ) : null}
          {readingType === 'evening' && !todaySummary.morning ? (
            <div className="mt-2 font-mono text-[10px] uppercase text-amber-400">
              Submit Morning Start first so daily KM can be calculated.
            </div>
          ) : null}
          {projectedRawDistance !== null ? (
            <div className={`mini-surface-3d mt-3 border p-3 ${projectedRawDistance < 0 ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
              <div className={`font-mono text-[10px] uppercase tracking-widest ${projectedRawDistance < 0 ? 'text-red-300' : 'text-amber-300'}`}>
                Daily KM Preview
              </div>
              <div className="mt-1 font-display text-3xl text-white">{fmtNum(projectedDistance)} km</div>
              <div className="font-mono text-[10px] uppercase text-zinc-500">
                Fuel {projectedFuel.toFixed(2)} L | {config.currency} {fmtNum(Math.round(projectedCost))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <button
        onClick={async () => {
          const km = Number.parseInt(reading, 10);
          if (!photoFile || Number.isNaN(km) || km < 0) {
            onShowToast?.('Please attach a photo and enter a valid odometer reading.', 'error');
            return;
          }

          if (selectedTypeReading) {
            onShowToast?.(`${selectedTypeConfig.label} is already submitted for today.`, 'error');
            return;
          }

          if (readingType === 'evening' && !todaySummary.morning) {
            onShowToast?.('Please submit Morning Start before Evening End.', 'error');
            return;
          }

          if (readingType === 'evening' && todaySummary.morning && km < todaySummary.morning.km) {
            const shouldContinue = window.confirm(
              `Evening reading (${fmtNum(km)}) is lower than Morning Start (${fmtNum(todaySummary.morning.km)}). Submit anyway?`,
            );
            if (!shouldContinue) return;
          } else if (lastReading && km < lastReading.km) {
            const shouldContinue = window.confirm(
              `This reading (${fmtNum(km)}) is lower than your last reading (${fmtNum(lastReading.km)} on ${fmtDate(lastReading.date)}). Submit anyway?`,
            );
            if (!shouldContinue) return;
          }

          if (readingType === 'evening' && projectedDistance > HIGH_DAILY_KM_WARNING) {
            const shouldContinue = window.confirm(
              `Today distance is ${fmtNum(projectedDistance)} km. That is unusually high. Submit anyway?`,
            );
            if (!shouldContinue) return;
          }

          setSubmitting(true);
          try {
            await onSubmit({ employee, km, date: todayDate, readingType, photoFile });
            resetForm();
          } catch {
            // Toast state is handled upstream.
          } finally {
            setSubmitting(false);
          }
        }}
        disabled={!canSubmit}
        className="button-3d button-3d-primary glow-orange w-full py-4 font-display text-xl tracking-widest disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? 'SUBMITTING...' : `SUBMIT ${selectedTypeConfig.shortLabel.toUpperCase()} ->`}
      </button>

      {reading && config.adminWhatsApp ? (
        <button
          onClick={() => {
            const dailyLine = projectedRawDistance !== null
              ? `\n*Daily KM:* ${fmtNum(projectedDistance)} km\n*Fuel Cost:* ${config.currency} ${fmtNum(Math.round(projectedCost))}`
              : '';
            const message = `*FleetLine Reading*\n\n*Rider:* ${employee.name}\n*Bike:* ${employee.bikePlate}${employee.bikeModel ? ` (${employee.bikeModel})` : ''}\n*Type:* ${selectedTypeConfig.label}\n*Date:* ${fmtDate(todayDate)}\n*Odometer:* ${fmtNum(Number.parseInt(reading, 10))} km${dailyLine}\n\n_Sent from FleetLine_`;
            onShareWhatsApp(message);
          }}
          className="button-3d button-3d-whatsapp flex w-full items-center justify-center gap-2 py-3 font-display tracking-widest text-white transition-all hover:brightness-110"
        >
          <MessageCircle className="h-5 w-5" />
          ALSO SEND VIA WHATSAPP
        </button>
      ) : null}
    </div>
  );
};

const RiderHistoryView = ({ employee, readings, config, onPreviewPhoto }) => {
  const thisMonth = monthKey(today());
  const monthReadings = sortReadingsAsc(readings).filter((reading) => monthKey(reading.date) === thisMonth);
  const mileage = Number(employee.mileage ?? config.defaultMileage);
  const monthlySummary = getMonthlySummary(monthReadings, thisMonth, mileage, config.fuelPrice);
  const todaySummary = getDaySummary(readings, today());
  const distance = monthlySummary.totalKm;
  const fuelUsed = monthlySummary.fuelUsed;
  const todayFuel = mileage > 0 ? todaySummary.distance / mileage : 0;
  const todayCost = todayFuel * Number(config.fuelPrice);

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">
          // {formatAppDate(new Date(), { month: 'long', year: 'numeric' })}
        </div>
        <div className="font-display text-3xl leading-none text-white">Monthly Report</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Monthly KM" value={fmtNum(Math.round(distance))} unit="km" icon={TrendingUp} accent="orange" />
        <StatCard label="Fuel Used" value={fuelUsed.toFixed(1)} unit="litres" icon={Fuel} accent="gold" />
      </div>

      <div className="surface-3d border border-zinc-800 bg-zinc-950 p-5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500">Today</div>
        {todaySummary.complete ? (
          <>
            <div className={`mt-1 font-display text-4xl ${todaySummary.invalid ? 'text-red-400' : 'text-white'}`}>
              {fmtNum(todaySummary.distance)} km
            </div>
            <div className="font-mono text-[10px] uppercase text-zinc-500">
              Fuel {todayFuel.toFixed(2)} L | {config.currency} {fmtNum(Math.round(todayCost))}
            </div>
          </>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase">
            <div className={todaySummary.morning ? 'text-green-400' : 'text-zinc-500'}>
              Morning: {todaySummary.morning ? 'done' : 'pending'}
            </div>
            <div className={todaySummary.evening ? 'text-green-400' : 'text-zinc-500'}>
              Evening: {todaySummary.evening ? 'done' : 'pending'}
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// All Readings</div>
        {readings.length === 0 ? (
          <div className="empty-state p-10 text-center">
            <History className="empty-icon mx-auto mb-4 h-12 w-12 text-orange-500/80" />
            <div className="mb-1 font-display text-2xl text-white">No Readings Yet</div>
            <div className="text-sm text-zinc-400">Submit your first reading today to start your monthly stats.</div>
          </div>
        ) : (
          <div className="space-y-1">
            {[...sortReadingsAsc(readings)].reverse().map((reading, index, list) => {
              const previous = list[index + 1];
              const diff = previous ? reading.km - previous.km : null;
              return (
                <div
                  key={reading.id}
                  className="surface-3d fade-up flex items-center gap-3 border border-zinc-800 bg-zinc-950 p-3"
                  style={{ animationDelay: `${Math.min(index, 12) * 50}ms` }}
                >
                  <div className="flex h-10 w-10 flex-col items-center justify-center border border-orange-500/40">
                    <div className="font-display text-sm leading-none text-orange-500">{formatAppDate(reading.date, { day: 'numeric' })}</div>
                    <div className="font-mono text-[8px] uppercase text-amber-500">
                      {formatAppDate(reading.date, { month: 'short' })}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="font-mono text-xs uppercase text-zinc-500">
                      {reading.queued ? `Queued ${readingTypeLabel(reading)} Odo` : `${readingTypeLabel(reading)} Odo`}
                    </div>
                    <div className="font-display text-2xl leading-none text-white">
                      {fmtNum(reading.km)} <span className="text-xs text-zinc-500">km</span>
                    </div>
                    <div className="font-mono text-[10px] uppercase text-zinc-500">
                      {fmtDate(reading.date)}
                      {reading.queued ? ` | ${reading.outboxStatus === 'failed' ? 'sync failed' : 'awaiting sync'}` : ''}
                    </div>
                  </div>
                  {diff !== null ? (
                    <div className="text-right">
                      <div className="font-mono text-[10px] uppercase text-zinc-500">+</div>
                      <div className={`font-display text-xl ${diff >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                        {diff >= 0 ? '+' : ''}
                        {fmtNum(diff)}
                      </div>
                    </div>
                  ) : null}
                  {reading.photoPath ? (
                    <button
                      onClick={() => onPreviewPhoto(reading.photoPath)}
                      className="mini-surface-3d border border-orange-500/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-orange-500 hover:text-amber-400"
                    >
                      PHOTO
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [readings, setReadings] = useState([]);
  const [routeSessions, setRouteSessions] = useState([]);
  const [routePoints, setRoutePoints] = useState([]);
  const [liveRiderLocations, setLiveRiderLocations] = useState([]);
  const [shopPins, setShopPins] = useState([]);
  const [routeTemplates, setRouteTemplates] = useState([]);
  const [routeDeviationEvents, setRouteDeviationEvents] = useState([]);
  const [fuelPriceHistory, setFuelPriceHistory] = useState([]);
  const [dailyReviews, setDailyReviews] = useState([]);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [queuedItems, setQueuedItems] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [adminTab, setAdminTab] = useState('overview');
  const [riderTab, setRiderTab] = useState('today');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(null);
  const [photoModal, setPhotoModal] = useState({ open: false, url: '', path: '' });
  const [resetPinEmployee, setResetPinEmployee] = useState(null);
  const [resetPinBusy, setResetPinBusy] = useState(false);
  const [deletingRouteId, setDeletingRouteId] = useState(null);
  const [routeTracking, setRouteTracking] = useState({
    status: 'idle',
    sessionId: null,
    message: '',
    pointCount: 0,
    lastPointAt: null,
    totalDistanceM: 0,
  });
  const [toast, setToast] = useState(null);
  const routeWatchRef = useRef(null);
  const activeRouteRef = useRef(null);
  const lastRoutePointRef = useRef(null);

  useEffect(() => {
    const timeout = toast ? window.setTimeout(() => setToast(null), 2600) : null;
    return () => {
      if (timeout) window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    let isMounted = true;

    const boot = async () => {
      const currentSession = await getCurrentSession();
      if (!isMounted) return;
      setSession(currentSession);
      setAuthReady(true);
    };

    boot();

    const unsubscribeSession = onSessionChange((nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });

    const unsubscribeOutbox = onOutboxChange(setQueuedItems);

    return () => {
      isMounted = false;
      unsubscribeSession();
      unsubscribeOutbox();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setEmployees([]);
      setReadings([]);
      setRouteSessions([]);
      setRoutePoints([]);
      setLiveRiderLocations([]);
      setShopPins([]);
      setRouteTemplates([]);
      setRouteDeviationEvents([]);
      setFuelPriceHistory([]);
      setDailyReviews([]);
      setConfig(DEFAULT_CONFIG);
      return undefined;
    }

    const unsubscribeEmployees = subscribeEmployees((rows) => setEmployees(rows));
    const unsubscribeReadings = subscribeReadings((rows) => setReadings(rows));
    const unsubscribeConfig = subscribeConfig((row) => setConfig(row));
    const unsubscribeFuelPriceHistory = subscribeFuelPriceHistory((rows) => setFuelPriceHistory(rows));
    const unsubscribeDailyReviews = session.role === 'admin'
      ? subscribeDailyReviews((rows) => setDailyReviews(rows))
      : null;
    const unsubscribeRouteSessions = session.role === 'admin'
      ? subscribeRouteSessions((rows) => setRouteSessions(rows))
      : null;
    const unsubscribeRoutePoints = session.role === 'admin'
      ? subscribeRoutePoints((rows) => {
          setRoutePoints((current) => {
            const byId = new Map(current.map((point) => [point.id, point]));
            rows.forEach((point) => byId.set(point.id, point));
            return [...byId.values()].sort(
              (left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime(),
            ).slice(-ROUTE_POINTS_MEMORY_LIMIT);
          });
        })
      : null;
    const unsubscribeLiveRiderLocations = session.role === 'admin'
      ? subscribeLiveRiderLocations((rows) => setLiveRiderLocations(rows))
      : null;
    const unsubscribeShopPins = session.role === 'admin'
      ? subscribeShopPins((rows) => setShopPins(rows))
      : null;
    const unsubscribeRouteTemplates = session.role === 'admin'
      ? subscribeRouteTemplates((rows) => setRouteTemplates(rows))
      : null;
    const unsubscribeRouteDeviationEvents = session.role === 'admin'
      ? subscribeRouteDeviationEvents((rows) => setRouteDeviationEvents(rows))
      : null;

    return () => {
      unsubscribeEmployees?.();
      unsubscribeReadings?.();
      unsubscribeConfig?.();
      unsubscribeFuelPriceHistory?.();
      unsubscribeDailyReviews?.();
      unsubscribeRouteSessions?.();
      unsubscribeRoutePoints?.();
      unsubscribeLiveRiderLocations?.();
      unsubscribeShopPins?.();
      unsubscribeRouteTemplates?.();
      unsubscribeRouteDeviationEvents?.();
    };
  }, [session]);

  useEffect(() => {
    if (session?.role !== 'admin') return undefined;

    const loadAdminData = async () => {
      try {
        setAdmins(await listAdmins());
      } catch (error) {
        console.error(error);
      }
    };

    loadAdminData();
    return undefined;
  }, [session]);

  const showToast = (message, tone = 'info') => setToast({ message, tone });

  const syncRouteTrackingState = (route, status = 'active', message = '') => {
    setRouteTracking({
      status,
      sessionId: route?.id ?? null,
      message,
      pointCount: route?.pointCount ?? 0,
      lastPointAt: route?.lastPointAt ?? null,
      totalDistanceM: route?.totalDistanceM ?? 0,
    });
  };

  const updateActiveRoute = (patch) => {
    if (!activeRouteRef.current) return null;
    const nextRoute = {
      ...activeRouteRef.current,
      ...patch,
    };
    activeRouteRef.current = nextRoute;
    writeStoredActiveRoute(nextRoute);
    syncRouteTrackingState(nextRoute, 'active', 'Route tracking active.');
    return nextRoute;
  };

  const stopRouteWatch = () => {
    if (routeWatchRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(routeWatchRef.current);
    }
    routeWatchRef.current = null;
  };

  const getCurrentPosition = () =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Location is not available on this device.'));
        return;
      }

      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 15000,
      });
    });

  const queueOrSaveRouteStart = async (route) => {
    if (!navigator.onLine) {
      await enqueue({ id: `route-start-${route.id}`, op: 'route.start', payload: { route } });
      return route;
    }

    try {
      return await startRouteSession(route);
    } catch (error) {
      if (isLikelyNetworkError(error)) {
        await enqueue({ id: `route-start-${route.id}`, op: 'route.start', payload: { route } });
        return route;
      }
      throw error;
    }
  };

  const queueOrSaveRoutePoints = async (points) => {
    if (!points.length) return;

    if (!navigator.onLine) {
      await Promise.all(points.map((point) =>
        enqueue({ id: `route-point-${point.id}`, op: 'route.point', payload: { point } }),
      ));
      return;
    }

    try {
      await appendRoutePoints(points);
    } catch (error) {
      if (!isLikelyNetworkError(error)) {
        throw error;
      }
      await Promise.all(points.map((point) =>
        enqueue({ id: `route-point-${point.id}`, op: 'route.point', payload: { point } }),
      ));
    }
  };

  const queueOrSaveRouteFinish = async (payload) => {
    if (!navigator.onLine) {
      await enqueue({ id: `route-finish-${payload.sessionId}`, op: 'route.finish', payload });
      return;
    }

    try {
      await finishRouteSession(payload);
    } catch (error) {
      if (!isLikelyNetworkError(error)) {
        throw error;
      }
      await enqueue({ id: `route-finish-${payload.sessionId}`, op: 'route.finish', payload });
    }
  };

  const recoverActiveRouteSession = async (route) => {
    if (!route) {
      return null;
    }

    const recoveredRoute = await queueOrSaveRouteStart(route);
    const nextRoute = {
      ...route,
      ...recoveredRoute,
      status: 'active',
      endedAt: null,
      endReadingId: null,
      lastPoint: route.lastPoint ?? recoveredRoute?.lastPoint ?? null,
      pointCount: Math.max(route.pointCount ?? 0, recoveredRoute?.pointCount ?? 0),
      totalDistanceM: Math.max(route.totalDistanceM ?? 0, recoveredRoute?.totalDistanceM ?? 0),
    };

    activeRouteRef.current = nextRoute;
    writeStoredActiveRoute(nextRoute);
    syncRouteTrackingState(nextRoute, 'active', 'Route tracking recovered.');
    return nextRoute;
  };

  const recordRoutePoint = async (point) => {
    const previousPoint = lastRoutePointRef.current;
    const distanceDelta = previousPoint ? distanceMeters(previousPoint, point) : 0;
    const currentRoute = activeRouteRef.current;
    const nextRoute = {
      ...currentRoute,
      lastPoint: point,
      lastPointAt: point.recordedAt,
      pointCount: (currentRoute?.pointCount ?? 0) + 1,
      totalDistanceM: (currentRoute?.totalDistanceM ?? 0) + distanceDelta,
    };

    try {
      await queueOrSaveRoutePoints([point]);
      lastRoutePointRef.current = point;
      updateActiveRoute(nextRoute);
    } catch (error) {
      if (isInactiveRouteError(error)) {
        try {
          const recoveredRoute = await recoverActiveRouteSession(currentRoute);
          const recoveredPoint = {
            ...point,
            sessionId: recoveredRoute?.id ?? point.sessionId,
          };
          await queueOrSaveRoutePoints([recoveredPoint]);
          lastRoutePointRef.current = recoveredPoint;
          updateActiveRoute({
            ...nextRoute,
            id: recoveredRoute?.id ?? nextRoute.id,
            sessionId: recoveredRoute?.id ?? nextRoute.sessionId,
            lastPoint: recoveredPoint,
            lastPointAt: recoveredPoint.recordedAt,
          });
          return;
        } catch (recoverError) {
          console.error(recoverError);
          stopRouteWatch();
          writeStoredActiveRoute(null);
          activeRouteRef.current = null;
          lastRoutePointRef.current = null;
          setRouteTracking({
            status: 'error',
            sessionId: null,
            message: 'GPS session was closed on the server. Submit Evening End, then start a fresh route tomorrow.',
            pointCount: currentRoute?.pointCount ?? 0,
            lastPointAt: currentRoute?.lastPointAt ?? null,
            totalDistanceM: currentRoute?.totalDistanceM ?? 0,
          });
          return;
        }
      }

      console.error(error);
      syncRouteTrackingState(currentRoute, 'error', error.message || 'Failed to save GPS point.');
    }
  };

  const startRouteWatcher = (route) => {
    if (!navigator.geolocation || routeWatchRef.current !== null) return;

    routeWatchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const activeRoute = activeRouteRef.current ?? route;
        const nextPoint = pointFromPosition(position, activeRoute);
        if (!shouldRecordRoutePoint(lastRoutePointRef.current, nextPoint)) return;
        recordRoutePoint(nextPoint);
      },
      (error) => {
        console.error(error);
        setRouteTracking((current) => ({
          ...current,
          status: 'error',
          message: error.message || 'Location permission or GPS signal is unavailable.',
        }));
      },
      {
        enableHighAccuracy: true,
        timeout: 25000,
        maximumAge: 15000,
      },
    );
  };

  const startRouteTrackingAfterMorning = async ({ employee, readingId, date }) => {
    if (!employee?.id || !navigator.geolocation) {
      syncRouteTrackingState(null, 'unsupported', 'Location tracking is not available on this device.');
      return;
    }

    const existingRoute = activeRouteRef.current ?? readStoredActiveRoute();
    if (existingRoute?.employeeId === employee.id && existingRoute?.date === date && existingRoute?.status === 'active') {
      setRouteTracking((current) => ({
        ...current,
        status: 'requesting',
        message: 'Recovering existing route session.',
      }));
      try {
        const recoveredRoute = await recoverActiveRouteSession(existingRoute);
        lastRoutePointRef.current = recoveredRoute?.lastPoint ?? existingRoute.lastPoint ?? null;
        syncRouteTrackingState(recoveredRoute ?? existingRoute, 'active', 'Route tracking already active.');
        startRouteWatcher(recoveredRoute ?? existingRoute);
      } catch (error) {
        console.error(error);
        writeStoredActiveRoute(null);
        activeRouteRef.current = null;
        lastRoutePointRef.current = null;
        setRouteTracking({
          status: 'error',
          sessionId: null,
          message: 'Could not recover GPS route tracking. Submit Evening End normally; tomorrow will start fresh.',
          pointCount: existingRoute.pointCount ?? 0,
          lastPointAt: existingRoute.lastPointAt ?? null,
          totalDistanceM: existingRoute.totalDistanceM ?? 0,
        });
      }
      return;
    }

    setRouteTracking((current) => ({
      ...current,
      status: 'requesting',
      message: 'Waiting for Android Chrome location permission.',
    }));

    try {
      const firstPosition = await getCurrentPosition();
      const route = {
        id: makeClientId(),
        employeeId: employee.id,
        date,
        startReadingId: readingId,
        startedAt: new Date().toISOString(),
        status: 'active',
        pointCount: 0,
        totalDistanceM: 0,
        lastPointAt: null,
      };

      const savedRoute = await queueOrSaveRouteStart(route);
      const activeRoute = {
        ...route,
        ...savedRoute,
        status: 'active',
      };
      activeRouteRef.current = activeRoute;
      writeStoredActiveRoute(activeRoute);
      syncRouteTrackingState(activeRoute, 'active', 'Route tracking active.');

      const firstPoint = pointFromPosition(firstPosition, activeRoute);
      await recordRoutePoint(firstPoint);
      startRouteWatcher(activeRoute);
      showToast('Route tracking started.', 'success');
    } catch (error) {
      console.error(error);
      setRouteTracking({
        status: 'error',
        sessionId: null,
        message: 'Location permission was not allowed. Odometer reading is saved; route proof is missing.',
        pointCount: 0,
        lastPointAt: null,
        totalDistanceM: 0,
      });
      showToast('Reading saved, but location tracking was not allowed.', 'info');
    }
  };

  const finishRouteTrackingAfterEvening = async ({ employee, readingId, date }) => {
    const activeRoute = activeRouteRef.current ?? readStoredActiveRoute();
    if (!activeRoute || activeRoute.employeeId !== employee?.id || activeRoute.date !== date) {
      return;
    }

    stopRouteWatch();
    const payload = {
      sessionId: activeRoute.id,
      employeeId: activeRoute.employeeId,
      endReadingId: readingId,
      endedAt: new Date().toISOString(),
      totalDistanceM: activeRoute.totalDistanceM ?? 0,
    };

    try {
      await queueOrSaveRouteFinish(payload);
      writeStoredActiveRoute(null);
      activeRouteRef.current = null;
      lastRoutePointRef.current = null;
      setRouteTracking({
        status: 'completed',
        sessionId: payload.sessionId,
        message: 'Route closed after Evening End.',
        pointCount: activeRoute.pointCount ?? 0,
        lastPointAt: activeRoute.lastPointAt ?? null,
        totalDistanceM: payload.totalDistanceM,
      });
      showToast('Route tracking closed.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to close route session.', 'error');
    }
  };

  const refreshAdmins = async () => {
    setAdmins(await listAdmins());
  };

  const loadRoutePointsForSession = async (sessionId) => {
    if (!sessionId || session?.role !== 'admin') return;

    try {
      const rows = await listRoutePointsForSession(sessionId);
      setRoutePoints((current) => {
        const byId = new Map(current.map((point) => [point.id, point]));
        rows.forEach((point) => byId.set(point.id, point));
        return [...byId.values()].sort(
          (left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime(),
        ).slice(-ROUTE_POINTS_MEMORY_LIMIT);
      });
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to load route points.', 'error');
    }
  };

  const compressPhoto = async (file) =>
    imageCompression(file, {
      maxSizeMB: 0.2,
      maxWidthOrHeight: 1600,
      useWebWorker: true,
      initialQuality: 0.8,
      fileType: 'image/jpeg',
    });

  const replayQueuedItem = async (item) => {
    const { payload } = item;

    if (item.op === 'reading.create') {
      const photoPath = await uploadPhoto(payload.employeeId, payload.readingId, payload.photoBlob);
      await saveReading({
        id: payload.readingId,
        employeeId: payload.employeeId,
        date: payload.date,
        km: payload.km,
        readingType: payload.readingType ?? 'evening',
        photoPath,
        submittedAt: payload.submittedAt,
      });
      return;
    }

    if (item.op === 'route.start') {
      await startRouteSession(payload.route);
      return;
    }

    if (item.op === 'route.point') {
      await appendRoutePoints([payload.point]);
      return;
    }

    if (item.op === 'route.finish') {
      await finishRouteSession(payload);
    }
  };

  const flushQueuedItems = async (includeFailed = false) => {
    if (!navigator.onLine || session?.role !== 'rider') return;
    await flushOutbox(replayQueuedItem, { includeFailed });
  };

  useEffect(() => {
    const tryFlush = async () => {
      try {
        await flushQueuedItems(false);
      } catch (error) {
        console.error(error);
      }
    };

    tryFlush();
    window.addEventListener('online', tryFlush);
    return () => window.removeEventListener('online', tryFlush);
  }, [session]);

  const readingsByEmployee = useMemo(() => buildReadingsMap(readings), [readings]);
  const selectedEmployee = selectedEmployeeId ? employees.find((employee) => employee.id === selectedEmployeeId) : null;
  const riderEmployee = useMemo(() => {
    if (session?.role !== 'rider') return null;
    return employees.find((employee) => employee.id === session.employee.id) || session.employee;
  }, [employees, session]);

  const riderQueuedReadings = useMemo(() => {
    if (!riderEmployee) return [];
    return queuedItems
      .filter((item) => item.op === 'reading.create' && item.payload.employeeId === riderEmployee.id)
      .map((item) => ({
        id: item.id,
        employeeId: item.payload.employeeId,
        date: item.payload.date,
        km: item.payload.km,
        readingType: item.payload.readingType ?? 'evening',
        photoPath: null,
        submittedAt: item.payload.submittedAt,
        queued: true,
        outboxStatus: item.status ?? 'queued',
        attempts: item.attempts ?? 0,
        lastError: item.lastError ?? null,
      }));
  }, [queuedItems, riderEmployee]);

  const riderReadings = useMemo(() => {
    if (!riderEmployee) return [];
    return [...(readingsByEmployee[riderEmployee.id] || []), ...riderQueuedReadings];
  }, [readingsByEmployee, riderEmployee, riderQueuedReadings]);

  useEffect(() => {
    if (session?.role !== 'rider' || !riderEmployee) {
      stopRouteWatch();
      return undefined;
    }

    const todaySummary = getDaySummary(riderReadings, today());
    const storedRoute = readStoredActiveRoute();

    if (todaySummary.evening) {
      if (storedRoute?.employeeId === riderEmployee.id && storedRoute?.date === today()) {
        writeStoredActiveRoute(null);
      }
      stopRouteWatch();
      activeRouteRef.current = null;
      lastRoutePointRef.current = null;
      return undefined;
    }

    if (storedRoute?.employeeId === riderEmployee.id && storedRoute?.date === today() && storedRoute?.status === 'active') {
      let cancelled = false;

      const recoverStoredRoute = async () => {
        try {
          const recoveredRoute = await recoverActiveRouteSession(storedRoute);
          if (cancelled) return;
          lastRoutePointRef.current = recoveredRoute?.lastPoint ?? storedRoute.lastPoint ?? null;
          syncRouteTrackingState(recoveredRoute ?? storedRoute, 'active', 'Route tracking active.');
          startRouteWatcher(recoveredRoute ?? storedRoute);
        } catch (error) {
          console.error(error);
          if (cancelled) return;
          writeStoredActiveRoute(null);
          activeRouteRef.current = null;
          lastRoutePointRef.current = null;
          setRouteTracking({
            status: 'error',
            sessionId: null,
            message: 'Could not recover GPS route tracking. Submit Evening End normally; tomorrow will start fresh.',
            pointCount: storedRoute.pointCount ?? 0,
            lastPointAt: storedRoute.lastPointAt ?? null,
            totalDistanceM: storedRoute.totalDistanceM ?? 0,
          });
        }
      };

      recoverStoredRoute();

      return () => {
        cancelled = true;
        stopRouteWatch();
      };
    }

    return () => {
      stopRouteWatch();
    };
  }, [session?.role, riderEmployee?.id, riderReadings]);

  const riderQueuedRouteItems = useMemo(() => {
    if (!riderEmployee) return [];
    return queuedItems.filter(
      (item) =>
        item.op?.startsWith('route.') &&
        (
          item.payload?.point?.employeeId === riderEmployee.id ||
          item.payload?.route?.employeeId === riderEmployee.id ||
          item.payload?.employeeId === riderEmployee.id
        ),
    );
  }, [queuedItems, riderEmployee]);

  const queuedCount = riderQueuedReadings.length;
  const failedQueuedCount = riderQueuedReadings.filter((reading) => reading.outboxStatus === 'failed').length;
  const syncingQueuedCount = riderQueuedReadings.filter((reading) => reading.outboxStatus === 'syncing').length;
  const queuedRouteCount = riderQueuedRouteItems.length;

  const handleAdminLogin = async (email, password) => {
    setAuthLoading(true);
    setAuthError('');
    try {
      await adminLogin(email, password);
      setAdminTab('overview');
      showToast('Admin session started.', 'success');
    } catch (error) {
      setAuthError(error.message || 'Admin sign-in failed.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    stopRouteWatch();
    await signOut();
    setSelectedEmployeeId(null);
    setAdminTab('overview');
    setRiderTab('today');
    setRouteTracking({
      status: 'idle',
      sessionId: null,
      message: '',
      pointCount: 0,
      lastPointAt: null,
      totalDistanceM: 0,
    });
  };

  const handleSaveEmployee = async (employee, options) => {
    try {
      await saveEmployee(employee, options);
      showToast(options?.isNew ? 'Rider added.' : 'Rider updated.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to save rider.', 'error');
      throw error;
    }
  };

  const handleDeleteEmployee = async (employeeId) => {
    try {
      await deleteEmployee(employeeId);
      if (selectedEmployeeId === employeeId) setSelectedEmployeeId(null);
      showToast('Rider deleted.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to delete rider.', 'error');
      throw error;
    }
  };

  const handleDeleteReading = async (reading) => {
    try {
      await deleteReading(reading.id);
      showToast('Reading and photo deleted.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to delete reading.', 'error');
      throw error;
    }
  };

  const handleDeleteRouteSession = async (sessionId) => {
    setDeletingRouteId(sessionId);
    try {
      await deleteRouteSession(sessionId);
      setRouteSessions((current) => current.filter((sessionRow) => sessionRow.id !== sessionId));
      setRoutePoints((current) => current.filter((point) => point.sessionId !== sessionId));
      showToast('Route session deleted.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to delete route session.', 'error');
      throw error;
    } finally {
      setDeletingRouteId(null);
    }
  };

  const handleResetPin = async (employee, nextPin) => {
    if (!/^\d{4}$/.test(String(nextPin ?? ''))) {
      showToast('PIN must be exactly 4 digits.', 'error');
      return false;
    }

    setResetPinBusy(true);
    try {
      await resetRiderPin(employee.id, nextPin);
      showToast(`PIN reset for ${employee.name}.`, 'success');
      return true;
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to reset PIN.', 'error');
      return false;
    } finally {
      setResetPinBusy(false);
    }
  };

  const handleSaveConfig = async (nextConfig) => {
    try {
      await saveConfig(nextConfig);
      showToast('Settings saved.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to save settings.', 'error');
      throw error;
    }
  };

  const handleSaveDailyReview = async (review) => {
    try {
      await saveDailyReview(review);
      showToast('Daily close review saved.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to save daily review.', 'error');
      throw error;
    }
  };

  const handleSaveRouteTemplate = async (template) => {
    try {
      await saveRouteTemplate(template);
      showToast('Weekly route template approved.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to approve route template.', 'error');
      throw error;
    }
  };

  const handleInviteAdmin = async (email) => {
    try {
      await inviteAdmin(email, window.location.origin);
      await refreshAdmins();
      showToast('Admin invite sent.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to invite admin.', 'error');
      throw error;
    }
  };

  const handlePreviewPhoto = async (photoPath) => {
    try {
      const url = await getSignedPhotoUrl(photoPath);
      setPhotoModal({ open: true, url, path: photoPath });
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to load photo preview.', 'error');
    }
  };

  const handleSubmitReading = async ({ employee, km, date, readingType, photoFile }) => {
    const readingId = makeClientId();
    const compressedPhoto = await compressPhoto(photoFile);
    const payload = {
      readingId,
      employeeId: employee.id,
      date,
      km,
      readingType: readingType ?? 'evening',
      photoBlob: compressedPhoto,
      submittedAt: new Date().toISOString(),
    };

    if (!navigator.onLine) {
      await enqueue({ id: readingId, op: 'reading.create', payload });
      if (payload.readingType === 'morning') {
        await startRouteTrackingAfterMorning({ employee, readingId, date });
      } else if (payload.readingType === 'evening') {
        await finishRouteTrackingAfterEvening({ employee, readingId, date });
      }
      showToast('Offline: reading queued for sync.', 'info');
      return;
    }

    try {
      const photoPath = await uploadPhoto(employee.id, readingId, compressedPhoto);
      await saveReading({
        id: readingId,
        employeeId: employee.id,
        date,
        km,
        readingType: payload.readingType,
        photoPath,
        submittedAt: payload.submittedAt,
      });
      if (payload.readingType === 'morning') {
        await startRouteTrackingAfterMorning({ employee, readingId, date });
      } else if (payload.readingType === 'evening') {
        await finishRouteTrackingAfterEvening({ employee, readingId, date });
      }
      await flushQueuedItems(false);
      showToast('Reading submitted.', 'success');
    } catch (error) {
      if (isLikelyNetworkError(error)) {
        await enqueue({ id: readingId, op: 'reading.create', payload });
        if (payload.readingType === 'morning') {
          await startRouteTrackingAfterMorning({ employee, readingId, date });
        } else if (payload.readingType === 'evening') {
          await finishRouteTrackingAfterEvening({ employee, readingId, date });
        }
        showToast('Network issue: reading queued for sync.', 'info');
        return;
      }

      console.error(error);
      showToast(error.message || 'Failed to submit reading.', 'error');
      throw error;
    }
  };

  if (!authReady) {
    return <LoadingScreen />;
  }

  if (!isSupabaseConfigured && !isDemoMode) {
    return <SupabaseSetupView configError={supabaseConfigError} />;
  }

  if (!session) {
    return (
      <>
        <Toast toast={toast} />
        <LoginView
          onAdminLogin={handleAdminLogin}
          loading={authLoading}
          error={authError}
          demoMode={isDemoMode}
        />
      </>
    );
  }

  if (session.role === 'admin') {
    return (
      <div className="grid-bg min-h-screen bg-black pb-24 text-white font-body">
        <ThemeStyles />
        <Toast toast={toast} />
        <BrandHeader onLogout={handleLogout} userName="Administrator" subtitle="Admin Panel" />

        {selectedEmployee ? (
          <EmployeeDetailView
            employee={selectedEmployee}
            readings={readingsByEmployee[selectedEmployee.id] || []}
            config={config}
            routeSessions={routeSessions}
            routePoints={routePoints}
            fuelPriceHistory={fuelPriceHistory}
            onLoadRoutePoints={loadRoutePointsForSession}
            onBack={() => setSelectedEmployeeId(null)}
            onUpdateEmployee={handleSaveEmployee}
            onDeleteEmployee={handleDeleteEmployee}
            onDeleteReading={handleDeleteReading}
            onResetPin={setResetPinEmployee}
            onPreviewPhoto={handlePreviewPhoto}
            onShowToast={showToast}
          />
        ) : (
          <>
            {adminTab === 'overview' ? (
              <AdminOverview
                employees={employees}
                readingsByEmployee={readingsByEmployee}
                config={config}
                routeSessions={routeSessions}
                routePoints={routePoints}
                liveRiderLocations={liveRiderLocations}
                shopPins={shopPins}
                routeDeviationEvents={routeDeviationEvents}
                fuelPriceHistory={fuelPriceHistory}
                dailyReviews={dailyReviews}
                onSelectEmployee={setSelectedEmployeeId}
                onLoadRoutePoints={loadRoutePointsForSession}
              />
            ) : null}
            {adminTab === 'employees' ? (
              <AdminEmployees
                employees={employees}
                onSave={handleSaveEmployee}
                onDelete={handleDeleteEmployee}
                onResetPin={setResetPinEmployee}
                onShowToast={showToast}
              />
            ) : null}
            {adminTab === 'routes' ? (
              <AdminRoutesPanel
                employees={employees}
                routeSessions={routeSessions}
                routePoints={routePoints}
                liveRiderLocations={liveRiderLocations}
                shopPins={shopPins}
                routeTemplates={routeTemplates}
                routeDeviationEvents={routeDeviationEvents}
                deletingRouteId={deletingRouteId}
                onLoadRoutePoints={loadRoutePointsForSession}
                onDeleteRouteSession={handleDeleteRouteSession}
                onPreviewPhoto={handlePreviewPhoto}
                onSaveRouteTemplate={handleSaveRouteTemplate}
              />
            ) : null}
            {adminTab === 'reports' ? (
              <AdminReportsPanel
                employees={employees}
                readingsByEmployee={readingsByEmployee}
                config={config}
                routeSessions={routeSessions}
                routePoints={routePoints}
                shopPins={shopPins}
                routeDeviationEvents={routeDeviationEvents}
                fuelPriceHistory={fuelPriceHistory}
                dailyReviews={dailyReviews}
                onSelectEmployee={setSelectedEmployeeId}
                onPreviewPhoto={handlePreviewPhoto}
                onSaveDailyReview={handleSaveDailyReview}
              />
            ) : null}
            {adminTab === 'admins' ? <AdminsPanel admins={admins} onRefresh={refreshAdmins} onInvite={handleInviteAdmin} /> : null}
            {adminTab === 'settings' ? <AdminSettings config={config} fuelPriceHistory={fuelPriceHistory} onSave={handleSaveConfig} /> : null}
          </>
        )}

        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-orange-500/20 bg-black/95 shadow-2xl backdrop-blur">
          <div className="no-scrollbar flex overflow-x-auto">
            {[
              { id: 'overview', label: 'Overview', icon: BarChart3 },
              { id: 'employees', label: 'Riders', icon: Users },
              { id: 'routes', label: 'Routes', icon: Route },
              { id: 'reports', label: 'Reports', icon: FileDown },
              { id: 'admins', label: 'Admins', icon: Shield },
              { id: 'settings', label: 'Settings', icon: Settings },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setAdminTab(tab.id);
                  setSelectedEmployeeId(null);
                }}
                className={`relative flex min-w-[72px] flex-1 flex-col items-center gap-0.5 px-1 py-3 transition-colors ${
                  adminTab === tab.id && !selectedEmployeeId ? 'text-orange-500' : 'text-zinc-500'
                }`}
              >
                <tab.icon className="h-5 w-5 shrink-0" />
                <div className="w-full truncate text-center font-mono text-[9px] uppercase tracking-wider sm:tracking-widest sm:text-[10px]">{tab.label}</div>
                {adminTab === tab.id && !selectedEmployeeId ? <div className="absolute bottom-0 h-0.5 w-8 bg-orange-500"></div> : null}
              </button>
            ))}
          </div>
        </div>

        <PhotoPreviewModal
          photoModal={photoModal}
          onClose={() => setPhotoModal({ open: false, url: '', path: '' })}
        />
        <ResetPinModal
          employee={resetPinEmployee}
          busy={resetPinBusy}
          onClose={() => setResetPinEmployee(null)}
          onConfirm={async (nextPin) => {
            if (resetPinEmployee && await handleResetPin(resetPinEmployee, nextPin)) {
              setResetPinEmployee(null);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="grid-bg min-h-screen bg-black pb-24 text-white font-body">
      <ThemeStyles />
      <Toast toast={toast} />
      <BrandHeader onLogout={handleLogout} userName={riderEmployee?.name} subtitle={riderEmployee?.bikePlate} />

      {riderTab === 'today' ? (
        <RiderSubmitView
          employee={riderEmployee}
          readings={riderReadings}
          config={config}
          queuedCount={queuedCount}
          queuedRouteCount={queuedRouteCount}
          failedCount={failedQueuedCount}
          syncingCount={syncingQueuedCount}
          routeTracking={routeTracking}
          onRetrySync={() => flushQueuedItems(true)}
          onSubmit={handleSubmitReading}
          onShareWhatsApp={(message) => openWhatsApp(config.adminWhatsApp, message)}
          onShowToast={showToast}
        />
      ) : null}
      {riderTab === 'history' ? (
        <RiderHistoryView
          employee={riderEmployee}
          readings={riderReadings}
          config={config}
          onPreviewPhoto={handlePreviewPhoto}
        />
      ) : null}

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-orange-500/20 bg-black/95 shadow-2xl backdrop-blur">
        <div className="grid grid-cols-2">
          {[
            { id: 'today', label: 'Submit', icon: Camera },
            { id: 'history', label: 'Stats', icon: TrendingUp },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setRiderTab(tab.id)}
              className={`relative flex min-w-0 flex-col items-center gap-0.5 px-1 py-3 transition-colors ${
                riderTab === tab.id ? 'text-orange-500' : 'text-zinc-500'
              }`}
            >
              <tab.icon className="h-5 w-5 shrink-0" />
              <div className="w-full truncate text-center font-mono text-[10px] uppercase tracking-widest sm:text-[11px]">{tab.label}</div>
              {riderTab === tab.id ? <div className="absolute bottom-0 h-0.5 w-8 bg-orange-500"></div> : null}
            </button>
          ))}
        </div>
      </div>

      <PhotoPreviewModal
        photoModal={photoModal}
        onClose={() => setPhotoModal({ open: false, url: '', path: '' })}
      />
    </div>
  );
}
