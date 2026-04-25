import React, { useEffect, useMemo, useRef, useState } from 'react';
import imageCompression from 'browser-image-compression';
import maplibregl from 'maplibre-gl';
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
  Loader2,
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
  listAuditLog,
  listRoutePointsForSession,
  onSessionChange,
  resetRiderPin,
  riderLogin,
  saveConfig,
  saveDailyReview,
  saveEmployee,
  saveReading,
  signOut,
  subscribeConfig,
  subscribeDailyReviews,
  subscribeEmployees,
  subscribeFuelPriceHistory,
  subscribeReadings,
  subscribeRoutePoints,
  subscribeRouteSessions,
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
const APP_VERSION = '1.0.0';
const APP_TIME_ZONE = 'Asia/Karachi';
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
  paid: { label: 'Paid', tone: 'green' },
};
const ROUTE_TRACKING_KEY = 'fleetline.active-route-session.v1';
const ROUTE_SAMPLE_INTERVAL_MS = 60000;
const ROUTE_MIN_DISTANCE_M = 75;
const ROUTE_STALE_AFTER_MS = 30 * 60 * 1000;
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
const monthKey = (value) => value.slice(0, 7);
const fmtDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtShort = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
const fmtNum = (value) => Number(value ?? 0).toLocaleString('en-US');
const fmtTime = (value) =>
  value ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '-';
const fmtDistance = (meters) => {
  const value = Number(meters) || 0;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
};

const toRadians = (value) => (Number(value) * Math.PI) / 180;

const distanceMeters = (left, right) => {
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

const sortRoutePoints = (points) =>
  [...points].sort((left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime());

const calculateRouteDistanceM = (points) =>
  sortRoutePoints(points).reduce((total, point, index, rows) => {
    if (index === 0) return total;
    return total + distanceMeters(rows[index - 1], point);
  }, 0);

const groupRoutePointsBySession = (points) =>
  points.reduce((accumulator, point) => {
    accumulator[point.sessionId] ??= [];
    accumulator[point.sessionId].push(point);
    return accumulator;
  }, {});

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
  if (!route) {
    window.localStorage.removeItem(ROUTE_TRACKING_KEY);
    return;
  }
  window.localStorage.setItem(ROUTE_TRACKING_KEY, JSON.stringify(route));
};

const pointFromPosition = (position, session) => ({
  id: crypto.randomUUID(),
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

const getDaySummary = (readings, date = today()) => {
  const dayReadings = sortReadingsAsc(readings).filter((reading) => reading.date === date);
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
    .filter((reading) => !reading.queued && (!selectedMonth || monthKey(reading.date) === selectedMonth))
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

const getRouteHealth = ({ routeSession, routePoints = [], odometerKm = 0 }) => {
  const sortedPoints = sortRoutePoints(routePoints);
  const gpsDistanceM = routeSession?.totalDistanceM || calculateRouteDistanceM(sortedPoints);
  const gpsDistanceKm = gpsDistanceM / 1000;
  const activeMinutes =
    sortedPoints.length > 1
      ? Math.max(0, Math.round((new Date(sortedPoints.at(-1).recordedAt).getTime() - new Date(sortedPoints[0].recordedAt).getTime()) / 60000))
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
    pointCount: sortedPoints.length,
    gpsDistanceM,
    gpsDistanceKm,
    diffKm,
    diffPct,
    confidence,
    hasGps: sortedPoints.length > 0,
  };
};

const getProblemFlags = ({ daySummary, routeHealth, review, now = new Date(), date = today() }) => {
  const flags = [];

  if (!daySummary.morning && isPastCutoff('morning', now)) {
    flags.push({ id: 'missing_morning', label: 'Missing Morning', tone: 'red' });
  }

  if (daySummary.morning && !daySummary.evening && isPastCutoff('evening', now)) {
    flags.push({ id: 'missing_evening', label: 'Missing Evening', tone: 'red' });
  }

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

  employees
    .filter((employee) => employee.active !== false)
    .forEach((employee) => {
      const summary = getDaySummary(readingsByEmployee[employee.id] || [], date);

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

const getDatesForMonth = (month, throughDate = today()) => {
  const [year, monthNumber] = month.split('-').map(Number);
  const isCurrentMonth = month === monthKey(throughDate);
  const endDay = isCurrentMonth ? Number(throughDate.slice(8, 10)) : new Date(year, monthNumber, 0).getDate();

  return Array.from({ length: endDay }, (_, index) =>
    `${year}-${String(monthNumber).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
  );
};

const getRiderTodayStatus = (summary, now = new Date()) => {
  if (summary.complete) {
    return { label: 'Complete', tone: 'green' };
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
      summary: getDaySummary(readingsByEmployee[employee.id] || [], date),
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
      summary: getDaySummary(readingsByEmployee[employee.id] || [], date),
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
      const daySummary = getDaySummary(readingsByEmployee[employee.id] || [], date);
      const routeSession = getRouteForDay(routeSessions, employee.id, date);
      const routeHealth = getRouteHealth({
        routeSession,
        routePoints: routeSession ? pointsBySession[routeSession.id] || [] : [],
        odometerKm: daySummary.distance,
      });
      const review = reviewMap[getReviewKey(employee.id, date)] ?? null;
      const flags = getProblemFlags({ daySummary, routeHealth, review, now, date });
      const mileage = Number(employee.mileage ?? config.defaultMileage);
      const fuelPrice = getFuelPriceForDate(date, fuelPriceHistory, config.fuelPrice);
      const fuelUsed = mileage > 0 && daySummary.complete ? daySummary.distance / mileage : 0;
      const fuelCost = fuelUsed * fuelPrice;
      const todayStatus = getRiderTodayStatus(daySummary, now);
      const displayStatus =
        review?.status ??
        (flags.some((flag) => flag.tone === 'red') ? 'problem' : daySummary.complete ? 'pending_review' : 'pending_review');

      return {
        employee,
        date,
        daySummary,
        routeSession,
        routeHealth,
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
  const rows = [
    [`FleetLine Fleet Report - ${selectedMonth || 'All time'}`],
    [`Generated: ${new Date().toLocaleString()}`],
    [`Fuel price: ${config.currency} ${config.fuelPrice}/L`],
    [],
    ['Rider', 'Username', 'Bike Plate', 'Bike Model', 'Mileage (km/L)', 'Readings', 'Completed Days', 'Monthly KM', 'Fuel (L)', `Monthly Fuel Cost (${config.currency})`],
  ];

  let grandKm = 0;
  let grandFuel = 0;
  let grandCost = 0;

  employees.forEach((employee) => {
    const mileage = Number(employee.mileage ?? config.defaultMileage);
    const readings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
      (reading) => !selectedMonth || monthKey(reading.date) === selectedMonth,
    );
    const summary = getMonthlySummary(readings, selectedMonth, mileage, config.fuelPrice, fuelPriceHistory);

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
      summary.totalKm,
      summary.fuelUsed.toFixed(2),
      summary.cost.toFixed(2),
    ]);
  });

  rows.push([]);
  rows.push(['FLEET TOTAL', '', '', '', '', '', '', grandKm, grandFuel.toFixed(2), grandCost.toFixed(2)]);
  return rows;
};

const buildEmployeeCSV = (employee, readingsByEmployee, config, selectedMonth, fuelPriceHistory = []) => {
  const mileage = Number(employee.mileage ?? config.defaultMileage);
  const readings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
    (reading) => !selectedMonth || monthKey(reading.date) === selectedMonth,
  );

  const rows = [
    [`FleetLine Report - ${employee.name} (${employee.bikePlate})`],
    [`Month: ${selectedMonth || 'All time'} | Generated: ${new Date().toLocaleString()}`],
    [`Mileage: ${mileage} km/L | Fuel price: ${config.currency} ${config.fuelPrice}/L`],
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
      filter: saturate(0.9) contrast(1.05);
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
      .lift-3d {
        transition: none;
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
      <div className={`bg-black/95 backdrop-blur border ${tones[toast.tone] || tones.info} px-4 py-3 shadow-2xl`}>
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

const StatCard = ({ label, value, unit, icon: Icon, accent = 'orange' }) => {
  const colors = {
    orange: 'text-orange-500 border-orange-500/30 stat-tone-orange',
    gold: 'text-amber-400 border-amber-400/30 stat-tone-gold',
    teal: 'text-teal-300 border-teal-500/30 stat-tone-teal',
    white: 'text-white border-zinc-700 stat-tone-white',
  };
  const [textColor, borderColor, toneClass] = (colors[accent] ?? colors.orange).split(' ');

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
        <div className={`font-display text-3xl leading-none ${textColor}`}>{value}</div>
        {unit ? <div className="font-mono text-[10px] uppercase text-zinc-500">{unit}</div> : null}
      </div>
    </div>
  );
};

const StatusBadge = ({ label, tone = 'zinc' }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${statusClasses[tone] ?? statusClasses.zinc}`}>
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

const buildRouteLineData = (points) => ({
  type: 'FeatureCollection',
  features: points.length > 1
    ? [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: points.map((point) => [point.lng, point.lat]),
          },
        },
      ]
    : [],
});

const buildRoutePointData = (points) => ({
  type: 'FeatureCollection',
  features: points.map((point, index) => ({
    type: 'Feature',
    properties: {
      kind: index === 0 ? 'start' : index === points.length - 1 ? 'live' : 'point',
    },
    geometry: {
      type: 'Point',
      coordinates: [point.lng, point.lat],
    },
  })),
});

const updateRouteMapData = (map, points) => {
  const lineSource = map.getSource('route-line');
  const pointSource = map.getSource('route-points');
  if (!lineSource || !pointSource) return;

  lineSource.setData(buildRouteLineData(points));
  pointSource.setData(buildRoutePointData(points));

  if (points.length === 1) {
    map.easeTo({ center: [points[0].lng, points[0].lat], zoom: 15, pitch: 60, bearing: -22, duration: 600 });
    return;
  }

  if (points.length > 1) {
    const bounds = new maplibregl.LngLatBounds();
    points.forEach((point) => bounds.extend([point.lng, point.lat]));
    map.fitBounds(bounds, { padding: 44, maxZoom: 16, duration: 700 });
  }
};

const RouteMap = ({ points, session, employee }) => {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const routePoints = useMemo(() => sortRoutePoints(points), [points]);
  const routeDistance = session?.totalDistanceM || calculateRouteDistanceM(routePoints);
  const lastPoint = routePoints.at(-1);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;

    const initialPoint = routePoints[0];
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: ROUTE_MAP_STYLE,
      center: initialPoint ? [initialPoint.lng, initialPoint.lat] : [74.3587, 31.5204],
      zoom: initialPoint ? 15 : 10,
      pitch: 60,
      bearing: -22,
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      map.addSource('route-line', {
        type: 'geojson',
        data: buildRouteLineData([]),
      });
      map.addSource('route-points', {
        type: 'geojson',
        data: buildRoutePointData([]),
      });
      map.addLayer({
        id: 'route-line-glow',
        type: 'line',
        source: 'route-line',
        paint: {
          'line-color': '#f59e0b',
          'line-width': 11,
          'line-opacity': 0.24,
          'line-blur': 5,
        },
      });
      map.addLayer({
        id: 'route-line-main',
        type: 'line',
        source: 'route-line',
        paint: {
          'line-color': '#d97706',
          'line-width': 5,
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'route-points',
        type: 'circle',
        source: 'route-points',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'kind'], 'live'], 8, ['==', ['get', 'kind'], 'start'], 7, 4],
          'circle-color': ['case', ['==', ['get', 'kind'], 'start'], '#22c55e', ['==', ['get', 'kind'], 'live'], '#ef4444', '#f59e0b'],
          'circle-stroke-color': '#fffdf7',
          'circle-stroke-width': 2,
        },
      });
      updateRouteMapData(map, routePoints);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getSource('route-line')) return;
    updateRouteMapData(map, routePoints);
  }, [routePoints]);

  return (
    <div className="route-map-3d surface-3d relative overflow-hidden border border-orange-500/30 bg-zinc-950">
      <div ref={containerRef} className="h-[360px] w-full" />
      {routePoints.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-8 text-center">
          <div>
            <MapPin className="mx-auto mb-3 h-10 w-10 text-zinc-600" />
            <div className="font-display text-2xl text-white">No GPS Points Yet</div>
            <div className="mt-1 text-sm text-zinc-500">The route line appears as soon as the rider sends location points.</div>
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
          <div className="font-display text-xl leading-none text-white">{routePoints.length}</div>
        </div>
      </div>
      {lastPoint ? (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 mini-surface-3d border border-zinc-700 bg-black/85 px-3 py-2 font-mono text-[10px] uppercase text-zinc-400">
          Last GPS: {new Date(lastPoint.recordedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          {lastPoint.accuracyM ? ` | Accuracy ${Math.round(lastPoint.accuracyM)}m` : ''}
        </div>
      ) : null}
    </div>
  );
};

const RouteSessionCard = ({ session, employee, points, selected, deleting, onSelect, onDelete }) => {
  const stale = session.status === 'active' && (!session.lastPointAt || Date.now() - new Date(session.lastPointAt).getTime() > ROUTE_STALE_AFTER_MS);
  const distance = session.totalDistanceM || calculateRouteDistanceM(points);
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
            {points.length} points | {fmtDistance(distance)}
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

const Modal = ({ open, onClose, title, children }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-5">
      <div className="w-full max-w-lg border border-orange-500/25 bg-black sm:max-h-[90vh] sm:overflow-y-auto lg:max-w-2xl">
        <div className="flex items-center justify-between border-b border-orange-500/15 px-5 py-4">
          <div className="font-display text-2xl text-white">{title}</div>
          <button onClick={onClose} className="text-zinc-500 transition-colors hover:text-orange-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
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
        <img src={photoModal.url} alt={photoModal.path} className="max-h-[70vh] w-full border border-zinc-800 object-contain" />
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
  <div className="flex min-h-screen items-center justify-center bg-black">
    <ThemeStyles />
    <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
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

const LoginView = ({ onAdminLogin, onRiderLogin, loading, error, demoMode }) => {
  const [mode, setMode] = useState('rider');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleRiderSubmit = async () => {
    if (!username.trim() || !/^\d{4}$/.test(pin)) {
      return;
    }
    await onRiderLogin(username, pin);
  };

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
              Local demo mode: admin accepts any email/password. Rider PIN is 1234.
            </div>
          ) : null}

          {mode === 'rider' ? (
            <div>
              <div className="surface-3d mb-4 border border-orange-500/30 bg-orange-500/5 p-5">
                <User className="mb-3 h-8 w-8 text-orange-500" />
                <div className="mb-1 font-display text-2xl text-white">Rider Login</div>
                <div className="mb-4 text-sm text-zinc-400">Enter the username and PIN given by your admin.</div>
                <Input
                  label="Username"
                  icon={Hash}
                  value={username}
                  onChange={(event) => setUsername(event.target.value.toLowerCase().replace(/\s/g, ''))}
                  placeholder="ali.hassan"
                />
                <Input
                  label="4-digit PIN"
                  icon={KeyRound}
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                  placeholder="****"
                />
              </div>
              <button
                onClick={handleRiderSubmit}
                disabled={loading || !username.trim() || pin.length !== 4}
                className="button-3d button-3d-primary glow-orange w-full py-3 font-display text-lg tracking-widest disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? 'VERIFYING...' : 'ENTER DASHBOARD ->'}
              </button>
              <button
                onClick={() => setMode('admin')}
                className="mini-surface-3d mt-4 flex w-full items-center justify-center gap-2 border border-amber-500/50 bg-black py-3 text-amber-400 transition-colors hover:bg-amber-500/10"
              >
                <Shield className="h-4 w-4" />
                <span className="font-display tracking-widest">ADMIN ACCESS</span>
              </button>
            </div>
          ) : null}

          {mode === 'admin' ? (
            <div>
              <button
                onClick={() => setMode('rider')}
                className="mb-4 flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-amber-500/70 transition-colors hover:text-orange-500"
              >
                <ArrowLeft className="h-3 w-3" /> Rider Login
              </button>
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
          ) : null}
        </div>
      </div>
      <div className="p-5 text-center font-mono text-[10px] uppercase tracking-widest text-zinc-600">
        FleetLine | Fuel | Manage
      </div>
    </div>
  );
};

const EmployeeForm = ({ employee, onSave, onDelete, onCancel }) => {
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
      window.alert('Name, username, and bike plate are required.');
      return;
    }

    if (isNew && !/^\d{4}$/.test(String(form.pin ?? ''))) {
      window.alert('A 4-digit PIN is required for new riders.');
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
    <div>
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
      {!isNew ? (
        <label className="mb-4 flex items-center gap-2 font-mono text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={Boolean(form.active)}
            onChange={(event) => update('active', event.target.checked)}
          />
          Rider is active
        </label>
      ) : null}

      <div className="mt-6 flex gap-2">
        <button onClick={onCancel} className="mini-surface-3d flex-1 border border-zinc-800 bg-zinc-900 py-3 font-display tracking-widest text-zinc-400">
          CANCEL
        </button>
        <button onClick={handleSave} className="glow-orange flex-1 bg-gradient-to-r from-orange-500 to-amber-500 py-3 font-display tracking-widest text-black">
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
          className="mini-surface-3d mt-3 flex w-full items-center justify-center gap-2 border border-red-500/40 py-2.5 font-display tracking-widest text-red-400 hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" /> DELETE RIDER
        </button>
      ) : null}
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

  const handleSave = async (row) => {
    const key = getReviewKey(row.employee.id, row.date);
    const draft = getDraft(row);
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
        {rows.map((row) => {
          const key = getReviewKey(row.employee.id, row.date);
          const draft = getDraft(row);
          const reviewMeta = REVIEW_STATUS[draft.status] ?? REVIEW_STATUS.pending_review;
          const hasFlags = row.flags.length > 0;

          return (
            <div key={key} className={`surface-3d border p-4 ${hasFlags ? 'border-amber-500/30' : 'border-zinc-800'}`}>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <button onClick={() => onSelectEmployee(row.employee.id)} className="min-w-0 text-left">
                  <div className="font-display text-2xl leading-none text-white">{row.employee.name}</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    @{row.employee.username} | {row.employee.bikePlate}
                  </div>
                </button>
                <div className="flex flex-wrap justify-end gap-2">
                  <StatusBadge label={row.todayStatus.label} tone={row.todayStatus.tone} />
                  <StatusBadge label={reviewMeta.label} tone={reviewMeta.tone} />
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-4">
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
                  <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Route Health</div>
                  <div className="mt-1 font-display text-2xl leading-none text-teal-300">
                    {row.routeHealth.confidence}%
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-500">
                    GPS {row.routeHealth.gpsDistanceKm.toFixed(1)} km | {row.routeHealth.pointCount} pts
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase text-zinc-600">
                    active {row.routeHealth.activeMinutes} min | diff {row.routeHealth.diffPct === null ? '-' : `${Math.round(row.routeHealth.diffPct)}%`}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {row.flags.length > 0 ? (
                  row.flags.map((flag) => <StatusBadge key={`${key}-${flag.id}`} label={flag.label} tone={flag.tone} />)
                ) : (
                  <StatusBadge label="No Problem Flags" tone="green" />
                )}
              </div>

              <div className="mt-4 grid gap-2 md:grid-cols-[180px_1fr_120px]">
                <select
                  value={draft.status}
                  onChange={(event) => updateDraft(row, { status: event.target.value })}
                  className="field-focus mini-surface-3d border border-zinc-800 bg-black px-3 py-2 font-mono text-xs uppercase text-zinc-200"
                >
                  {Object.entries(REVIEW_STATUS).map(([value, meta]) => (
                    <option key={value} value={value}>{meta.label}</option>
                  ))}
                </select>
                <textarea
                  value={draft.notes}
                  onChange={(event) => updateDraft(row, { notes: event.target.value })}
                  placeholder="Admin notes, e.g. photo unclear, route checked, approved for payment..."
                  className="field-focus mini-surface-3d min-h-[42px] resize-y border border-zinc-800 bg-black px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600"
                />
                <button
                  onClick={() => handleSave(row)}
                  disabled={savingKey === key}
                  className="button-3d button-3d-outline px-3 py-2 font-display tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingKey === key ? 'SAVING' : 'SAVE'}
                </button>
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
  fuelPriceHistory,
  dailyReviews,
  onSelectEmployee,
  onPreviewPhoto,
  onSaveDailyReview,
}) => {
  const [now, setNow] = useState(() => new Date());
  const thisMonth = monthKey(today());
  const alertDate = today();
  const monthDates = getDatesForMonth(thisMonth, alertDate);
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
    dailyReviews,
    fuelPriceHistory,
    date: alertDate,
    now,
  });
  const activeRouteCount = routeSessions.filter((session) => session.date === alertDate && session.status === 'active').length;
  const inMarketCount = dailyCloseRows.filter((row) => row.daySummary.morning && !row.daySummary.evening).length;
  const needsReviewCount = dailyCloseRows.filter(
    (row) =>
      row.flags.length > 0 ||
      (row.daySummary.complete && !['approved', 'paid'].includes(row.review?.status ?? '')),
  ).length;

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
    const dailySummaries = monthDates.map((date) => getDaySummary(readingsByEmployee[employee.id] || [], date));
    const incompleteDays = dailySummaries.filter((day) => day.morning || day.evening).filter((day) => !day.complete).length;
    const todaySummary = getDaySummary(readingsByEmployee[employee.id] || [], alertDate);
    const todayStatus = getRiderTodayStatus(todaySummary, now);

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
      const summary = getDaySummary(readingsByEmployee[employee.id] || [], date);
      return sum + (summary.complete ? summary.distance : 0);
    }, 0);

    return {
      label: new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
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
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
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

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard label="In Market" value={inMarketCount} unit="riders" icon={Route} accent="teal" />
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

      <DailyCloseSheet
        rows={dailyCloseRows}
        config={config}
        onSelectEmployee={onSelectEmployee}
        onPreviewPhoto={onPreviewPhoto}
        onSaveDailyReview={onSaveDailyReview}
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
              Morning alerts start after {MISSING_READING_CUTOFFS.morning.label}. Evening alerts start after {MISSING_READING_CUTOFFS.evening.label}.
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

      <div className="surface-3d border border-orange-500/30 bg-gradient-to-br from-orange-500/10 via-amber-500/5 to-transparent p-5">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-amber-500">Monthly Fuel Cost</div>
        <div className="font-display text-5xl text-orange-500">
          {config.currency} {fmtNum(Math.round(stats.totalCost))}
        </div>
        <div className="mt-1 font-mono text-[10px] text-zinc-500">
          Uses the saved fuel price for each submitted day.
        </div>
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

      <div className="ledger-panel-3d overflow-hidden border border-orange-500/30 p-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-amber-400">// Monthly Operations Ledger</div>
            <div className="font-display text-4xl leading-none text-white">Fuel & KM Report</div>
            <div className="mt-1 text-xs text-zinc-400">
              Full month view for rider payments, fuel overhead, incomplete days, and cost control.
            </div>
          </div>
          <div className="mini-surface-3d flex h-12 w-12 items-center justify-center border border-orange-500/30 bg-black/60">
            <FileDown className="h-5 w-5 text-orange-500" />
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="mini-surface-3d border border-orange-500/25 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Fleet KM</div>
            <div className="font-display text-3xl leading-none text-amber-400">{fmtNum(Math.round(stats.totalKm))}</div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">this month</div>
          </div>
          <div className="mini-surface-3d border border-orange-500/25 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Fuel Cost</div>
            <div className="font-display text-3xl leading-none text-orange-500">
              {fmtNum(Math.round(stats.totalCost))}
            </div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">{config.currency}</div>
          </div>
          <div className="mini-surface-3d border border-green-500/20 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Complete Days</div>
            <div className="font-display text-3xl leading-none text-green-300">
              {monthlyReportRows.reduce((sum, row) => sum + row.summary.completedDays, 0)}
            </div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">verified pairs</div>
          </div>
          <div className="mini-surface-3d border border-amber-400/25 bg-black/60 p-3">
            <div className="font-mono text-[9px] uppercase text-zinc-500">Incomplete</div>
            <div className="font-display text-3xl leading-none text-amber-300">
              {monthlyReportRows.reduce((sum, row) => sum + row.incompleteDays, 0)}
            </div>
            <div className="font-mono text-[9px] uppercase text-zinc-600">needs review</div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-y border-orange-500/15 bg-black/35 px-3 py-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-400">
            A-Z rider ledger | tap row for daily details
          </div>
          {employees.length > 0 ? (
            <button
              onClick={() => downloadCSV(buildFleetCSV(employees, readingsByEmployee, config, thisMonth, fuelPriceHistory), `fleet_${thisMonth}.csv`)}
              className="button-3d button-3d-outline flex items-center justify-center gap-2 px-4 py-2.5 font-display tracking-widest"
            >
              <FileDown className="h-4 w-4" /> EXPORT MONTHLY CSV
            </button>
          ) : null}
        </div>

        {monthlyReportRows.length === 0 ? (
          <div className="empty-state p-10 text-center">
            <FileDown className="empty-icon mx-auto mb-3 h-10 w-10 text-orange-500/80" />
            <div className="text-sm text-zinc-400">Add riders and submit readings to populate the ledger.</div>
          </div>
        ) : (
          <div className="table-3d overflow-hidden border border-orange-500/20 bg-black/65">
            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-[1.8fr_0.6fr_0.7fr_0.7fr_0.9fr_0.7fr] border-b border-orange-500/15 bg-orange-500/10 px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-amber-500/80">
                  <div>Rider</div>
                  <div className="text-right">Days</div>
                  <div className="text-right">KM</div>
                  <div className="text-right">Litres</div>
                  <div className="text-right">Cost</div>
                  <div className="text-right">{config.currency}/km</div>
                </div>
                {[...monthlyReportRows]
                  .sort((left, right) => left.employee.name.localeCompare(right.employee.name))
                  .map(({ employee, monthlyKm, fuelCost, summary, incompleteDays }) => {
                    const completed = summary.completedDays;
                    const totalDays = completed + incompleteDays;
                    const costPerKm = monthlyKm > 0 ? fuelCost / monthlyKm : 0;
                    const incomplete = incompleteDays > 0;
                    return (
                      <button
                        key={employee.id}
                        onClick={() => onSelectEmployee(employee.id)}
                        className="ledger-row-3d grid w-full grid-cols-[1.8fr_0.6fr_0.7fr_0.7fr_0.9fr_0.7fr] items-center gap-3 border-b border-white/5 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-orange-500/10"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="ledger-rider-avatar flex h-11 w-11 shrink-0 items-center justify-center border border-orange-500/35">
                            <User className="h-5 w-5 text-orange-500" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-white">{employee.name}</div>
                            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">@{employee.username}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] uppercase text-zinc-500">
                              <span className="flex items-center gap-1">
                                <Bike className="h-3 w-3 text-amber-500" /> {employee.bikePlate || 'no plate'}
                              </span>
                              <span className="flex items-center gap-1">
                                <Fuel className="h-3 w-3 text-amber-500" /> {employee.mileage ?? config.defaultMileage} km/L
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`font-display text-lg leading-none ${incomplete ? 'text-amber-300' : 'text-green-300'}`}>
                            {completed}
                            <span className="font-mono text-[10px] text-zinc-500">/{totalDays || completed}</span>
                          </div>
                          {incomplete ? (
                            <div className="font-mono text-[8px] uppercase text-amber-400/80">{incompleteDays} gap{incompleteDays === 1 ? '' : 's'}</div>
                          ) : null}
                        </div>
                        <div className="text-right font-display text-lg leading-none text-amber-400">{fmtNum(Math.round(monthlyKm))}</div>
                        <div className="text-right font-display text-lg leading-none text-zinc-200">{summary.fuelUsed.toFixed(1)}</div>
                        <div className="text-right">
                          <div className="font-display text-lg leading-none text-orange-500">{fmtNum(Math.round(fuelCost))}</div>
                          <div className="font-mono text-[8px] uppercase text-zinc-500">{config.currency}</div>
                        </div>
                        <div className="text-right font-mono text-[11px] tabular-nums text-zinc-300">
                          {monthlyKm > 0 ? costPerKm.toFixed(1) : '-'}
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const AdminRoutesPanel = ({ employees, routeSessions, routePoints, deletingRouteId, onLoadRoutePoints, onDeleteRouteSession }) => {
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
  const activeRoutes = rows.filter((session) => session.status === 'active');
  const todayRoutes = rows.filter((session) => session.date === today());
  const staleRoutes = activeRoutes.filter(
    (session) => !session.lastPointAt || Date.now() - new Date(session.lastPointAt).getTime() > ROUTE_STALE_AFTER_MS,
  );

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

      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Active Now" value={activeRoutes.length} unit="routes" icon={Route} accent="orange" />
        <StatCard label="Today" value={todayRoutes.length} unit="sessions" icon={MapPin} accent="gold" />
        <StatCard label="No GPS" value={staleRoutes.length} unit="alerts" icon={CloudOff} accent={staleRoutes.length ? 'gold' : 'white'} />
      </div>

      {staleRoutes.length > 0 ? (
        <div className="surface-3d border border-amber-400/30 bg-amber-500/10 p-4">
          <div className="font-display text-2xl text-white">GPS Attention</div>
          <div className="mt-1 text-sm text-amber-200">
            {staleRoutes.length} active route{staleRoutes.length === 1 ? '' : 's'} has no recent GPS point. The rider may have denied permission, closed Chrome, or lost signal.
          </div>
        </div>
      ) : null}

      {selectedSession ? (
        <RouteMap
          session={selectedSession}
          employee={selectedEmployee}
          points={selectedPoints}
        />
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
              const points = pointsBySession[session.id] || [];
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

const AdminEmployees = ({ employees, onSave, onDelete, onResetPin }) => {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);

  return (
    <div className="dashboard-3d p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Fleet Roster</div>
          <div className="font-display text-3xl leading-none text-white">{employees.length} Riders</div>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setShowModal(true);
          }}
          className="button-3d button-3d-primary glow-orange flex items-center gap-1.5 px-4 py-2.5 font-display tracking-widest"
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
        <div className="space-y-2">
          {employees.map((employee) => (
            <div key={employee.id} className="surface-3d lift-3d border border-zinc-800 bg-zinc-950 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 items-center justify-center border border-orange-500/40 bg-gradient-to-br from-orange-500/20 to-amber-500/20">
                  <User className="h-6 w-6 text-orange-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-white">{employee.name}</div>
                  <div className="font-mono text-[10px] uppercase text-zinc-500">@{employee.username}</div>
                  <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[10px] text-zinc-400">
                    <div className="flex items-center gap-1">
                      <Phone className="h-3 w-3 text-amber-500" /> {employee.phone || '-'}
                    </div>
                    <div className="flex items-center gap-1">
                      <Bike className="h-3 w-3 text-amber-500" /> {employee.bikePlate}
                    </div>
                    <div className="flex items-center gap-1">
                      <Gauge className="h-3 w-3 text-amber-500" /> {employee.bikeModel || '-'}
                    </div>
                    <div className="flex items-center gap-1">
                      <Fuel className="h-3 w-3 text-amber-500" /> {employee.mileage ?? 'default'} km/L
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => {
                      setEditing(employee);
                      setShowModal(true);
                    }}
                    className="mini-surface-3d flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-orange-500 hover:bg-orange-500/10"
                  >
                    <Edit2 className="h-4 w-4 text-orange-500" />
                  </button>
                  <button
                    onClick={() => onResetPin(employee)}
                    className="mini-surface-3d flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-amber-500 hover:bg-amber-500/10"
                  >
                    <KeyRound className="h-4 w-4 text-amber-400" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editing ? 'EDIT RIDER' : 'NEW RIDER'}>
        <EmployeeForm
          employee={editing}
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

const AdminSettings = ({ config, fuelPriceHistory = [], onSave }) => {
  const [form, setForm] = useState(config);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setForm(config);
  }, [config]);

  const handleSave = async () => {
    try {
      await onSave(form);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch {
      // Toast state is handled upstream.
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

const AuditPanel = ({ auditRows, auditCount, page, pageSize, onPageChange, onRefresh }) => (
  <div className="dashboard-3d space-y-4 p-5">
    <div className="flex items-center justify-between">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// History</div>
        <div className="font-display text-3xl leading-none text-white">Audit Log</div>
      </div>
      <button
        onClick={onRefresh}
        className="mini-surface-3d flex h-10 w-10 items-center justify-center border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-orange-500 hover:text-orange-500"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
    </div>

    <div className="space-y-2">
      {auditRows.map((row) => (
        <details key={row.id} className="surface-3d border border-zinc-800 bg-zinc-950 p-4">
          <summary className="cursor-pointer list-none">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-white">{row.action}</div>
                <div className="mt-1 font-mono text-[10px] uppercase text-zinc-500">
                  {row.entityType} | {row.entityId || '-'} | {fmtDate(row.createdAt)}
                </div>
              </div>
              <History className="mt-1 h-4 w-4 text-amber-400" />
            </div>
          </summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Before</div>
              <pre className="mini-surface-3d overflow-x-auto whitespace-pre-wrap border border-zinc-800 bg-black p-3 text-xs text-zinc-300">
                {JSON.stringify(row.before, null, 2) || 'null'}
              </pre>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">After</div>
              <pre className="mini-surface-3d overflow-x-auto whitespace-pre-wrap border border-zinc-800 bg-black p-3 text-xs text-zinc-300">
                {JSON.stringify(row.after, null, 2) || 'null'}
              </pre>
            </div>
          </div>
        </details>
      ))}
      {auditRows.length === 0 ? (
        <div className="empty-state p-10 text-center">
          <History className="empty-icon mx-auto mb-4 h-12 w-12 text-orange-500/80" />
          <div className="mb-1 font-display text-2xl text-white">No Audit Rows</div>
          <div className="text-sm text-zinc-400">Activity by admins will appear here as it happens.</div>
        </div>
      ) : null}
    </div>

    <div className="surface-3d flex items-center justify-between border border-zinc-800 bg-zinc-950 p-3">
      <div className="font-mono text-[10px] uppercase text-zinc-500">
        Page {page + 1} | Showing {auditRows.length} of {auditCount}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className="mini-surface-3d border border-zinc-800 px-3 py-2 font-mono text-[10px] uppercase text-zinc-400 disabled:opacity-40"
        >
          Prev
        </button>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={(page + 1) * pageSize >= auditCount}
          className="mini-surface-3d border border-zinc-800 px-3 py-2 font-mono text-[10px] uppercase text-zinc-400 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  </div>
);

const AppHealthPanel = ({
  appHealth,
  queuedItems,
  employees,
  readings,
  routeSessions,
  routePoints,
  fuelPriceHistory,
  dailyReviews,
}) => {
  const failedQueue = queuedItems.filter((item) => item.status === 'failed').length;
  const syncingQueue = queuedItems.filter((item) => item.status === 'syncing').length;
  const pendingQueue = queuedItems.length - failedQueue - syncingQueue;
  const healthChecks = [
    {
      label: 'Backend Connection',
      value: appHealth.supabaseConfigured ? 'Configured' : 'Missing Env',
      tone: appHealth.supabaseConfigured ? 'green' : 'red',
      detail: 'VITE_SUPABASE_URL and anon key',
    },
    {
      label: 'Browser Network',
      value: appHealth.isOnline ? 'Online' : 'Offline',
      tone: appHealth.isOnline ? 'green' : 'amber',
      detail: appHealth.isOnline ? 'Realtime can refresh' : 'Writes will queue',
    },
    {
      label: 'Location Permission',
      value: appHealth.locationPermission,
      tone: appHealth.locationPermission === 'granted' ? 'green' : appHealth.locationPermission === 'denied' ? 'red' : 'amber',
      detail: 'Needed for route proof',
    },
    {
      label: 'Offline Queue',
      value: queuedItems.length,
      tone: failedQueue ? 'red' : queuedItems.length ? 'amber' : 'green',
      detail: `${pendingQueue} queued | ${syncingQueue} syncing | ${failedQueue} failed`,
    },
    {
      label: 'Last Sync',
      value: appHealth.lastSyncAt ? fmtTime(appHealth.lastSyncAt) : 'Waiting',
      tone: appHealth.lastSyncAt ? 'green' : 'amber',
      detail: appHealth.lastSyncAt ? fmtDate(appHealth.lastSyncAt) : 'No realtime refresh yet',
    },
    {
      label: 'App Version',
      value: appHealth.appVersion,
      tone: 'zinc',
      detail: 'Frontend build label',
    },
  ];

  return (
    <div className="dashboard-3d space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Diagnostics</div>
          <div className="font-display text-3xl leading-none text-white">App Health</div>
          <div className="mt-1 text-xs text-zinc-500">Use this screen when login, GPS, sync, or photos feel confusing.</div>
        </div>
        <Shield className="h-7 w-7 text-orange-500" />
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {healthChecks.map((check) => (
          <div key={check.label} className={`surface-3d border p-4 ${statusClasses[check.tone] ?? statusClasses.zinc}`}>
            <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">{check.label}</div>
            <div className="mt-1 font-display text-3xl leading-none text-white">{check.value}</div>
            <div className="mt-1 text-xs text-zinc-400">{check.detail}</div>
          </div>
        ))}
      </div>

      <div className="ledger-panel-3d border border-orange-500/25 p-5">
        <div className="mb-4 font-display text-2xl text-white">Realtime Data Counters</div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatCard label="Riders" value={employees.length} unit="rows" icon={Users} accent="orange" />
          <StatCard label="Readings" value={readings.length} unit="rows" icon={Camera} accent="gold" />
          <StatCard label="Routes" value={routeSessions.length} unit="sessions" icon={Route} accent="teal" />
          <StatCard label="GPS Points" value={routePoints.length} unit="points" icon={MapPin} accent="white" />
          <StatCard label="Fuel Prices" value={fuelPriceHistory.length} unit="days" icon={Fuel} accent="orange" />
          <StatCard label="Reviews" value={dailyReviews.length} unit="rows" icon={PackageCheck} accent="gold" />
          <StatCard label="SW Support" value={appHealth.serviceWorkerSupported ? 'Yes' : 'No'} unit="" icon={RefreshCw} accent={appHealth.serviceWorkerSupported ? 'teal' : 'white'} />
          <StatCard label="GPS Support" value={appHealth.gpsSupported ? 'Yes' : 'No'} unit="" icon={MapPin} accent={appHealth.gpsSupported ? 'teal' : 'gold'} />
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
                    {session.status} | {points.length} points
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

const AdminActivityTimeline = ({ employee, readings = [], routeSessions = [], dailyReviews = [], auditRows = [] }) => {
  const matchesEmployeeAudit = (row) =>
    row.entityId?.includes(employee.id) ||
    row.before?.employee_id === employee.id ||
    row.after?.employee_id === employee.id ||
    row.before?.employeeId === employee.id ||
    row.after?.employeeId === employee.id;

  const events = [
    ...readings.map((reading) => ({
      id: `reading-${reading.id}`,
      at: reading.submittedAt,
      title: `${readingTypeLabel(reading)} submitted`,
      detail: `${fmtNum(reading.km)} km | ${reading.photoPath ? 'photo saved' : 'photo missing'}`,
      tone: reading.photoPath ? 'green' : 'amber',
      icon: Camera,
    })),
    ...routeSessions
      .filter((session) => session.employeeId === employee.id)
      .map((session) => ({
        id: `route-${session.id}`,
        at: session.endedAt ?? session.startedAt,
        title: session.status === 'active' ? 'Route active' : session.status === 'deleted' ? 'Route deleted' : 'Route closed',
        detail: `${fmtDistance(session.totalDistanceM)} | ${session.pointCount ?? 0} GPS points`,
        tone: session.status === 'active' ? 'amber' : session.status === 'deleted' ? 'red' : 'teal',
        icon: Route,
      })),
    ...dailyReviews
      .filter((review) => review.employeeId === employee.id)
      .map((review) => ({
        id: `review-${review.id}`,
        at: review.updatedAt,
        title: `Daily review: ${REVIEW_STATUS[review.status]?.label ?? review.status}`,
        detail: `${fmtDate(review.date)}${review.notes ? ` | ${review.notes}` : ''}`,
        tone: REVIEW_STATUS[review.status]?.tone ?? 'zinc',
        icon: PackageCheck,
      })),
    ...auditRows
      .filter(matchesEmployeeAudit)
      .map((row) => ({
        id: `audit-${row.id}`,
        at: row.createdAt,
        title: row.action,
        detail: `${row.entityType} | ${row.entityId || employee.name}`,
        tone: row.action?.includes('delete') ? 'red' : 'zinc',
        icon: History,
      })),
  ]
    .filter((event) => event.at)
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
    .slice(0, 18);

  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Admin Activity Timeline</div>
      {events.length === 0 ? (
        <div className="empty-state p-8 text-center">
          <History className="empty-icon mx-auto mb-3 h-10 w-10 text-orange-500/80" />
          <div className="text-sm text-zinc-400">No activity timeline yet for this rider.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => {
            const Icon = event.icon;
            return (
              <div key={event.id} className="surface-3d flex items-start gap-3 border border-zinc-800 bg-zinc-950 p-3">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center border ${statusClasses[event.tone] ?? statusClasses.zinc}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-white">{event.title}</div>
                  <div className="mt-0.5 truncate font-mono text-[10px] uppercase text-zinc-500">{event.detail}</div>
                </div>
                <div className="font-mono text-[9px] uppercase text-zinc-600">{fmtDate(event.at)} {fmtTime(event.at)}</div>
              </div>
            );
          })}
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
  dailyReviews,
  auditRows,
  onLoadRoutePoints,
  onBack,
  onUpdateEmployee,
  onDeleteEmployee,
  onDeleteReading,
  onResetPin,
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
                {new Date(`${value}-01`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
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

        <AdminActivityTimeline
          employee={employee}
          readings={readings}
          routeSessions={routeSessions}
          dailyReviews={dailyReviews}
          auditRows={auditRows}
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
                      <div className="font-display text-sm leading-none text-orange-500">{new Date(reading.date).getDate()}</div>
                      <div className="font-mono text-[8px] uppercase text-amber-500">
                        {new Date(reading.date).toLocaleDateString('en', { month: 'short' })}
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="font-mono text-xs uppercase text-zinc-500">{readingTypeLabel(reading)} Odo</div>
                      <div className="font-display text-2xl leading-none text-white">
                        {fmtNum(reading.km)} <span className="text-xs text-zinc-500">km</span>
                      </div>
                      <div className="font-mono text-[10px] uppercase text-zinc-500">
                        {fmtDate(reading.date)} | {new Date(reading.submittedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
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

      <Modal open={showEdit} onClose={() => setShowEdit(false)} title="EDIT RIDER">
        <EmployeeForm
          employee={employee}
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
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
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

      <div className={`surface-3d border p-4 ${statusClasses[routeTone]}`}>
        <div className="flex items-start gap-3">
          <div className={`flex h-10 w-10 items-center justify-center border ${statusClasses[routeTone]}`}>
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
                  <Loader2 className="h-10 w-10 animate-spin text-orange-500" />
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
          <input
            value={reading}
            onChange={(event) => setReading(event.target.value.replace(/[^\d]/g, ''))}
            placeholder="00000"
            className="w-full bg-transparent font-display text-5xl tracking-widest text-white"
          />
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
            window.alert('Please attach a photo and enter a valid odometer reading.');
            return;
          }

          if (selectedTypeReading) {
            window.alert(`${selectedTypeConfig.label} is already submitted for today.`);
            return;
          }

          if (readingType === 'evening' && !todaySummary.morning) {
            window.alert('Please submit Morning Start before Evening End.');
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
          // {new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
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
                <div key={reading.id} className="surface-3d flex items-center gap-3 border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex h-10 w-10 flex-col items-center justify-center border border-orange-500/40">
                    <div className="font-display text-sm leading-none text-orange-500">{new Date(reading.date).getDate()}</div>
                    <div className="font-mono text-[8px] uppercase text-amber-500">
                      {new Date(reading.date).toLocaleDateString('en', { month: 'short' })}
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
  const [fuelPriceHistory, setFuelPriceHistory] = useState([]);
  const [dailyReviews, setDailyReviews] = useState([]);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [queuedItems, setQueuedItems] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [auditRows, setAuditRows] = useState([]);
  const [auditCount, setAuditCount] = useState(0);
  const [auditPage, setAuditPage] = useState(0);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [adminTab, setAdminTab] = useState('overview');
  const [riderTab, setRiderTab] = useState('today');
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [locationPermission, setLocationPermission] = useState('unknown');
  const [lastSyncAt, setLastSyncAt] = useState(null);
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
  const markSynced = () => setLastSyncAt(new Date().toISOString());

  useEffect(() => {
    const timeout = toast ? window.setTimeout(() => setToast(null), 2600) : null;
    return () => {
      if (timeout) window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    const updateOnline = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  useEffect(() => {
    let permissionStatus;
    let cancelled = false;

    const loadLocationPermission = async () => {
      if (!navigator.geolocation) {
        setLocationPermission('unsupported');
        return;
      }

      if (!navigator.permissions?.query) {
        setLocationPermission('available');
        return;
      }

      try {
        permissionStatus = await navigator.permissions.query({ name: 'geolocation' });
        if (cancelled) return;
        setLocationPermission(permissionStatus.state);
        permissionStatus.onchange = () => setLocationPermission(permissionStatus.state);
      } catch {
        if (!cancelled) setLocationPermission('available');
      }
    };

    loadLocationPermission();
    return () => {
      cancelled = true;
      if (permissionStatus) permissionStatus.onchange = null;
    };
  }, []);

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
      setFuelPriceHistory([]);
      setDailyReviews([]);
      setConfig(DEFAULT_CONFIG);
      return undefined;
    }

    const unsubscribeEmployees = subscribeEmployees((rows) => {
      setEmployees(rows);
      markSynced();
    });
    const unsubscribeReadings = subscribeReadings((rows) => {
      setReadings(rows);
      markSynced();
    });
    const unsubscribeConfig = subscribeConfig((row) => {
      setConfig(row);
      markSynced();
    });
    const unsubscribeFuelPriceHistory = subscribeFuelPriceHistory((rows) => {
      setFuelPriceHistory(rows);
      markSynced();
    });
    const unsubscribeDailyReviews = session.role === 'admin'
      ? subscribeDailyReviews((rows) => {
          setDailyReviews(rows);
          markSynced();
        })
      : null;
    const unsubscribeRouteSessions = session.role === 'admin'
      ? subscribeRouteSessions((rows) => {
          setRouteSessions(rows);
          markSynced();
        })
      : null;
    const unsubscribeRoutePoints = session.role === 'admin'
      ? subscribeRoutePoints((rows) => {
          setRoutePoints((current) => {
            const byId = new Map(current.map((point) => [point.id, point]));
            rows.forEach((point) => byId.set(point.id, point));
            return [...byId.values()].sort(
              (left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime(),
            );
          });
          markSynced();
        })
      : null;

    return () => {
      unsubscribeEmployees?.();
      unsubscribeReadings?.();
      unsubscribeConfig?.();
      unsubscribeFuelPriceHistory?.();
      unsubscribeDailyReviews?.();
      unsubscribeRouteSessions?.();
      unsubscribeRoutePoints?.();
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

  useEffect(() => {
    if (session?.role !== 'admin') return undefined;

    const loadAudit = async () => {
      try {
        const result = await listAuditLog({ page: auditPage, pageSize: 20 });
        setAuditRows(result.rows);
        setAuditCount(result.count);
      } catch (error) {
        console.error(error);
      }
    };

    loadAudit();
    return undefined;
  }, [session, auditPage]);

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
        const nextPoint = pointFromPosition(position, route);
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
        id: crypto.randomUUID(),
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

  const refreshAudit = async (page = auditPage) => {
    const result = await listAuditLog({ page, pageSize: 20 });
    setAuditRows(result.rows);
    setAuditCount(result.count);
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
        );
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
  const appHealth = {
    appVersion: APP_VERSION,
    isOnline,
    lastSyncAt,
    locationPermission,
    supabaseConfigured: isSupabaseConfigured,
    gpsSupported: typeof navigator !== 'undefined' && Boolean(navigator.geolocation),
    serviceWorkerSupported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  };

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

  const handleRiderLogin = async (username, pin) => {
    setAuthLoading(true);
    setAuthError('');
    try {
      await riderLogin(username, pin);
      setRiderTab('today');
      showToast('Rider session started.', 'success');
    } catch (error) {
      setAuthError(error.message || 'Rider sign-in failed.');
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
      await refreshAudit();
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
      await refreshAudit();
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
      await refreshAudit();
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
      await refreshAudit();
      showToast('Daily close review saved.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Failed to save daily review.', 'error');
      throw error;
    }
  };

  const handleInviteAdmin = async (email) => {
    try {
      await inviteAdmin(email, window.location.origin);
      await refreshAdmins();
      await refreshAudit();
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
    const readingId = crypto.randomUUID();
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
          onRiderLogin={handleRiderLogin}
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
            dailyReviews={dailyReviews}
            auditRows={auditRows}
            onLoadRoutePoints={loadRoutePointsForSession}
            onBack={() => setSelectedEmployeeId(null)}
            onUpdateEmployee={handleSaveEmployee}
            onDeleteEmployee={handleDeleteEmployee}
            onDeleteReading={handleDeleteReading}
            onResetPin={setResetPinEmployee}
            onPreviewPhoto={handlePreviewPhoto}
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
                fuelPriceHistory={fuelPriceHistory}
                dailyReviews={dailyReviews}
                onSelectEmployee={setSelectedEmployeeId}
                onPreviewPhoto={handlePreviewPhoto}
                onSaveDailyReview={handleSaveDailyReview}
              />
            ) : null}
            {adminTab === 'employees' ? (
              <AdminEmployees
                employees={employees}
                onSave={handleSaveEmployee}
                onDelete={handleDeleteEmployee}
                onResetPin={setResetPinEmployee}
              />
            ) : null}
            {adminTab === 'routes' ? (
              <AdminRoutesPanel
                employees={employees}
                routeSessions={routeSessions}
                routePoints={routePoints}
                deletingRouteId={deletingRouteId}
                onLoadRoutePoints={loadRoutePointsForSession}
                onDeleteRouteSession={handleDeleteRouteSession}
              />
            ) : null}
            {adminTab === 'admins' ? <AdminsPanel admins={admins} onRefresh={refreshAdmins} onInvite={handleInviteAdmin} /> : null}
            {adminTab === 'audit' ? (
              <AuditPanel
                auditRows={auditRows}
                auditCount={auditCount}
                page={auditPage}
                pageSize={20}
                onPageChange={setAuditPage}
                onRefresh={() => refreshAudit(auditPage)}
              />
            ) : null}
            {adminTab === 'health' ? (
              <AppHealthPanel
                appHealth={appHealth}
                queuedItems={queuedItems}
                employees={employees}
                readings={readings}
                routeSessions={routeSessions}
                routePoints={routePoints}
                fuelPriceHistory={fuelPriceHistory}
                dailyReviews={dailyReviews}
              />
            ) : null}
            {adminTab === 'settings' ? <AdminSettings config={config} fuelPriceHistory={fuelPriceHistory} onSave={handleSaveConfig} /> : null}
          </>
        )}

        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-orange-500/20 bg-black/95 shadow-2xl backdrop-blur">
          <div className="grid grid-cols-7">
            {[
              { id: 'overview', label: 'Overview', icon: BarChart3 },
              { id: 'employees', label: 'Riders', icon: Users },
              { id: 'routes', label: 'Routes', icon: Route },
              { id: 'admins', label: 'Admins', icon: Shield },
              { id: 'audit', label: 'Audit', icon: History },
              { id: 'health', label: 'Health', icon: RefreshCw },
              { id: 'settings', label: 'Settings', icon: Settings },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setAdminTab(tab.id);
                  setSelectedEmployeeId(null);
                }}
                className={`relative flex min-w-0 flex-col items-center gap-0.5 px-1 py-3 transition-colors ${
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
