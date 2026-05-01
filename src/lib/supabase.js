import { createClient } from '@supabase/supabase-js';

const FALLBACK_SUPABASE_URL = 'https://chwspnooeooddezsfcdp.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNod3Nwbm9vZW9vZGRlenNmY2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzA2MTMsImV4cCI6MjA5MjYwNjYxM30.ZkIrn9MP236kSJxMwXovblZOwGBVbX9FnBRIx9LOz2A';
const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const rawSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const RIDER_SESSION_KEY = 'fleetline.rider-session.v1';
const DEMO_STORE_KEY = 'fleetline.demo-store.v1';
const DEMO_SESSION_KEY = 'fleetline.demo-session.v1';
const ROUTE_SESSION_HISTORY_DAYS = 190;
const ROUTE_SESSION_COLUMNS =
  'id, employee_id, date, start_reading_id, end_reading_id, status, started_at, ended_at, last_point_at, point_count, total_distance_m, created_by, created_at, updated_at';
const ROUTE_POINT_COLUMNS = 'id, session_id, employee_id, recorded_at, lat, lng, accuracy_m, speed_mps, heading, created_at';
const SHOP_PIN_COLUMNS = 'id, route_session_id, employee_id, name, lat, lng, accuracy_m, pinned_at, photo_path, created_at';
const LEGACY_SHOP_PIN_COLUMNS = 'id, route_session_id, employee_id, name, lat, lng, accuracy_m, pinned_at, created_at';
const ROUTE_TEMPLATE_COLUMNS =
  'id, employee_id, weekday, name, status, source_start_date, source_end_date, source_pin_count, duplicate_count, approved_by, approved_at, created_at, updated_at';
const ROUTE_TEMPLATE_STOP_COLUMNS =
  'id, template_id, stop_order, name, lat, lng, radius_m, visit_count, source_pin_ids, created_at';
const ROUTE_DEVIATION_COLUMNS =
  'id, route_session_id, template_id, employee_id, event_type, lat, lng, distance_m, radius_m, message, recorded_at, created_at';
const hasPlaceholderText = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return !text || text.includes('your-') || text.includes('your ') || text.includes('placeholder');
};
const supabaseUrl = hasPlaceholderText(rawSupabaseUrl) ? FALLBACK_SUPABASE_URL : rawSupabaseUrl;
const supabaseAnonKey = hasPlaceholderText(rawSupabaseAnonKey) ? FALLBACK_SUPABASE_ANON_KEY : rawSupabaseAnonKey;
const normalizedSupabaseUrl = String(supabaseUrl || '').trim();
const normalizedSupabaseAnonKey = String(supabaseAnonKey || '').trim();
const hasValidSupabaseUrl =
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(normalizedSupabaseUrl) ||
  /^https:\/\/[a-z0-9-]+\.supabase\.in$/.test(normalizedSupabaseUrl);
const hasValidAnonKey = normalizedSupabaseAnonKey.startsWith('eyJ') && !hasPlaceholderText(normalizedSupabaseAnonKey);

export const supabaseConfigError = !normalizedSupabaseUrl
  ? 'Missing VITE_SUPABASE_URL.'
  : !hasValidSupabaseUrl
    ? 'VITE_SUPABASE_URL must be your real Supabase project URL.'
    : !normalizedSupabaseAnonKey
      ? 'Missing VITE_SUPABASE_ANON_KEY.'
      : !hasValidAnonKey
        ? 'VITE_SUPABASE_ANON_KEY is invalid. Replace the placeholder with the real anon public key.'
        : '';
export const isSupabaseConfigured = !supabaseConfigError;
export const isDemoMode =
  !isSupabaseConfigured && import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true';

if (!isSupabaseConfigured) {
  console.warn(`[fleetline] Supabase setup problem: ${supabaseConfigError}`);
}

const adminClient = isSupabaseConfigured
  ? createClient(normalizedSupabaseUrl, normalizedSupabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

const sessionListeners = new Set();
const demoListeners = {
  employees: new Set(),
  readings: new Set(),
  config: new Set(),
  routeSessions: new Set(),
  routePoints: new Set(),
  shopPins: new Set(),
  routeTemplates: new Set(),
  routeDeviationEvents: new Set(),
  fuelPriceHistory: new Set(),
  dailyReviews: new Set(),
};

let riderSession = isSupabaseConfigured ? readStoredRiderSession() : null;
let riderClient = riderSession ? buildRiderClient(riderSession.accessToken) : null;
let demoSession = isDemoMode ? readStoredDemoSession() : null;

adminClient?.auth.onAuthStateChange(() => {
  notifySessionListeners();
});

function missingConfigError() {
  return new Error(`${supabaseConfigError} Add the correct values to .env.local or Vercel Environment Variables, then redeploy.`);
}

function todayIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createDemoStore() {
  const createdAt = new Date().toISOString();
  const employees = [
    {
      id: 'demo-rider-ali',
      name: 'Ali Hassan',
      username: 'ali',
      phone: '+92 300 1234567',
      bikePlate: 'LEA-1234',
      bikeModel: 'Honda CD 70',
      mileage: 42,
      active: true,
      pin: '1234',
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: 'demo-rider-sara',
      name: 'Sara Khan',
      username: 'sara',
      phone: '+92 311 5557788',
      bikePlate: 'LEG-9081',
      bikeModel: 'Suzuki GD 110',
      mileage: 38,
      active: true,
      pin: '1234',
      createdAt,
      updatedAt: createdAt,
    },
  ];

  return {
    employees,
    readings: [
      {
        id: 'demo-reading-1',
        employeeId: employees[0].id,
        date: todayIso(-1),
        km: 12420,
        readingType: 'morning',
        photoPath: null,
        submittedAt: new Date(Date.now() - 86400000).toISOString(),
        submittedBy: employees[0].id,
      },
      {
        id: 'demo-reading-2',
        employeeId: employees[0].id,
        date: todayIso(-1),
        km: 12492,
        readingType: 'evening',
        photoPath: null,
        submittedAt: new Date(Date.now() - 86400000).toISOString(),
        submittedBy: employees[0].id,
      },
      {
        id: 'demo-reading-3',
        employeeId: employees[1].id,
        date: todayIso(-1),
        km: 8820,
        readingType: 'evening',
        photoPath: null,
        submittedAt: new Date(Date.now() - 85000000).toISOString(),
        submittedBy: employees[1].id,
      },
    ],
    config: {
      id: 1,
      fuelPrice: 280,
      defaultMileage: 40,
      currency: 'PKR',
      adminWhatsApp: '',
      updatedAt: createdAt,
      updatedBy: null,
    },
    admins: [
      {
        userId: 'demo-admin',
        email: 'admin@fleetline.local',
        invitedBy: null,
        createdAt,
      },
    ],
    auditLog: [
      {
        id: 1,
        actorId: 'demo-admin',
        action: 'demo.seed',
        entityType: 'system',
        entityId: 'local-demo',
        before: null,
        after: { employees: employees.length },
        createdAt,
      },
    ],
    photos: {},
    routeSessions: [],
    routePoints: [],
    shopPins: [],
    routeTemplates: [],
    routeTemplateStops: [],
    routeDeviationEvents: [],
    fuelPriceHistory: [
      {
        date: todayIso(),
        fuelPrice: 280,
        currency: 'PKR',
        createdAt,
        updatedAt: createdAt,
        updatedBy: 'demo-admin',
      },
    ],
    dailyReviews: [],
  };
}

function readDemoStore() {
  const raw = window.localStorage.getItem(DEMO_STORE_KEY);
  if (raw) {
    const store = JSON.parse(raw);
    store.routeSessions ??= [];
    store.routePoints ??= [];
    store.shopPins ??= [];
    store.routeTemplates ??= [];
    store.routeTemplateStops ??= [];
    store.routeDeviationEvents ??= [];
    store.fuelPriceHistory ??= [];
    store.dailyReviews ??= [];
    return store;
  }

  const store = createDemoStore();
  writeDemoStore(store);
  return store;
}

function writeDemoStore(store) {
  window.localStorage.setItem(DEMO_STORE_KEY, JSON.stringify(store));
}

function readStoredDemoSession() {
  try {
    const raw = window.localStorage.getItem(DEMO_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredDemoSession(nextSession) {
  demoSession = nextSession;

  if (!nextSession) {
    window.localStorage.removeItem(DEMO_SESSION_KEY);
    return;
  }

  window.localStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(nextSession));
}

function omitDemoPin(employee) {
  const { pin, ...safeEmployee } = employee;
  return safeEmployee;
}

function appendDemoAudit(store, action, entityType, entityId, before, after) {
  store.auditLog.unshift({
    id: Math.max(0, ...store.auditLog.map((row) => Number(row.id) || 0)) + 1,
    actorId: demoSession?.role === 'rider' ? demoSession.employee.id : 'demo-admin',
    action,
    entityType,
    entityId,
    before,
    after,
    createdAt: new Date().toISOString(),
  });
}

function notifyDemoTable(table) {
  const store = readDemoStore();
  if (table === 'employees') {
    const rows = store.employees.map(omitDemoPin);
    demoListeners.employees.forEach((listener) => listener(rows));
  }

  if (table === 'readings') {
    demoListeners.readings.forEach((listener) => listener([...store.readings]));
  }

  if (table === 'config') {
    demoListeners.config.forEach((listener) => listener({ ...store.config }));
  }

  if (table === 'routeSessions') {
    demoListeners.routeSessions.forEach((listener) => listener([...store.routeSessions]));
  }

  if (table === 'routePoints') {
    demoListeners.routePoints.forEach((listener) => listener([...store.routePoints]));
  }

  if (table === 'shopPins') {
    demoListeners.shopPins.forEach((listener) => listener([...store.shopPins]));
  }

  if (table === 'routeTemplates') {
    const templates = store.routeTemplates.map((template) => ({
      ...template,
      stops: store.routeTemplateStops.filter((stop) => stop.templateId === template.id),
    }));
    demoListeners.routeTemplates.forEach((listener) => listener(templates));
  }

  if (table === 'routeDeviationEvents') {
    demoListeners.routeDeviationEvents.forEach((listener) => listener([...store.routeDeviationEvents]));
  }

  if (table === 'fuelPriceHistory') {
    demoListeners.fuelPriceHistory.forEach((listener) => listener([...store.fuelPriceHistory]));
  }

  if (table === 'dailyReviews') {
    demoListeners.dailyReviews.forEach((listener) => listener([...store.dailyReviews]));
  }
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function demoSubscribe(table, callback) {
  const store = readDemoStore();

  if (table === 'employees') {
    callback(store.employees.map(omitDemoPin));
  }

  if (table === 'readings') {
    callback([...store.readings]);
  }

  if (table === 'config') {
    callback({ ...store.config });
  }

  if (table === 'routeSessions') {
    callback([...store.routeSessions]);
  }

  if (table === 'routePoints') {
    callback([...store.routePoints]);
  }

  if (table === 'shopPins') {
    callback([...store.shopPins]);
  }

  if (table === 'routeTemplates') {
    callback(store.routeTemplates.map((template) => ({
      ...template,
      stops: store.routeTemplateStops.filter((stop) => stop.templateId === template.id),
    })));
  }

  if (table === 'routeDeviationEvents') {
    callback([...store.routeDeviationEvents]);
  }

  if (table === 'fuelPriceHistory') {
    callback([...store.fuelPriceHistory]);
  }

  if (table === 'dailyReviews') {
    callback([...store.dailyReviews]);
  }

  demoListeners[table].add(callback);
  return () => demoListeners[table].delete(callback);
}

function readStoredRiderSession() {
  try {
    const raw = window.localStorage.getItem(RIDER_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error('[fleetline] Failed to read rider session', error);
    return null;
  }
}

function writeStoredRiderSession(nextSession) {
  riderSession = nextSession;

  try {
    if (!nextSession) {
      riderClient = null;
      window.localStorage.removeItem(RIDER_SESSION_KEY);
      return;
    }

    riderClient = buildRiderClient(nextSession.accessToken);
    window.localStorage.setItem(RIDER_SESSION_KEY, JSON.stringify(nextSession));
  } catch (error) {
    console.warn('[fleetline] Could not persist rider session locally', error);
  }
}

function buildRiderClient(accessToken) {
  if (!isSupabaseConfigured) {
    throw missingConfigError();
  }

  const client = createClient(normalizedSupabaseUrl, normalizedSupabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    accessToken: async () => accessToken,
  });

  client.realtime.setAuth(accessToken);
  return client;
}

async function notifySessionListeners() {
  const currentSession = await getCurrentSession();
  sessionListeners.forEach((listener) => listener(currentSession));
}

function getActiveClient() {
  return riderClient ?? adminClient;
}

function ensureAuthenticatedClient() {
  const client = getActiveClient();
  if (!client) {
    throw new Error('Supabase client is not initialized.');
  }
  return client;
}

async function invokeFunction(name, body) {
  const response = await ensureAuthenticatedClient().functions.invoke(name, { body });
  if (response.error) {
    throw new Error(await getFunctionErrorMessage(response.error, response.data, `${name} failed.`));
  }

  if (response.data?.error) {
    throw new Error(response.data.error);
  }

  return response.data;
}

async function getFunctionErrorMessage(error, data, fallback) {
  if (data?.error) {
    return data.error;
  }

  const context = error?.context;
  if (context && typeof context.clone === 'function') {
    try {
      const body = await context.clone().json();
      if (body?.error) return body.error;
      if (body?.message) return body.message;
    } catch {
      // Ignore parse failures and use the SDK message below.
    }
  }

  return error?.message || fallback;
}

function mapEmployee(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    phone: row.phone ?? '',
    bikePlate: row.bike_plate,
    bikeModel: row.bike_model ?? '',
    mileage: row.mileage === null ? null : Number(row.mileage),
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConfig(row) {
  return {
    id: row.id,
    fuelPrice: Number(row.fuel_price),
    defaultMileage: Number(row.default_mileage),
    currency: row.currency,
    adminWhatsApp: row.admin_whatsapp ?? '',
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

function mapReading(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    date: row.date,
    km: row.km,
    readingType: row.reading_type ?? 'evening',
    photoPath: row.photo_path,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by,
  };
}

function mapRouteSession(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    date: row.date,
    startReadingId: row.start_reading_id,
    endReadingId: row.end_reading_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastPointAt: row.last_point_at,
    pointCount: row.point_count ?? 0,
    totalDistanceM: row.total_distance_m ?? 0,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoutePoint(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    employeeId: row.employee_id,
    recordedAt: row.recorded_at,
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    speedMps: row.speed_mps === null ? null : Number(row.speed_mps),
    heading: row.heading === null ? null : Number(row.heading),
    createdAt: row.created_at,
  };
}

function mapShopPin(row) {
  return {
    id: row.id,
    routeSessionId: row.route_session_id,
    employeeId: row.employee_id,
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    pinnedAt: row.pinned_at,
    photoPath: row.photo_path ?? null,
    createdAt: row.created_at,
  };
}

function mapRouteTemplateStop(row) {
  return {
    id: row.id,
    templateId: row.template_id,
    stopOrder: row.stop_order,
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    radiusM: row.radius_m,
    visitCount: row.visit_count,
    sourcePinIds: row.source_pin_ids ?? [],
    createdAt: row.created_at,
  };
}

function mapRouteTemplate(row, stops = []) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    weekday: row.weekday,
    name: row.name,
    status: row.status,
    sourceStartDate: row.source_start_date,
    sourceEndDate: row.source_end_date,
    sourcePinCount: row.source_pin_count ?? 0,
    duplicateCount: row.duplicate_count ?? 0,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stops,
  };
}

function mapRouteDeviation(row) {
  return {
    id: row.id,
    routeSessionId: row.route_session_id,
    templateId: row.template_id,
    employeeId: row.employee_id,
    eventType: row.event_type,
    lat: Number(row.lat),
    lng: Number(row.lng),
    distanceM: row.distance_m ?? 0,
    radiusM: row.radius_m ?? 0,
    message: row.message ?? '',
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
  };
}

function mapFuelPriceHistory(row) {
  return {
    date: row.date,
    fuelPrice: Number(row.fuel_price),
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function mapDailyReview(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    date: row.date,
    status: row.status,
    notes: row.notes ?? '',
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAdmin(row) {
  return {
    userId: row.user_id,
    email: row.email,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
  };
}

function mapAuditLog(row) {
  return {
    id: row.id,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before,
    after: row.after,
    createdAt: row.created_at,
  };
}

async function refreshSubscription(query, callback) {
  const { data, error } = await query(ensureAuthenticatedClient());
  if (error) {
    console.error('[fleetline] subscription refresh failed', error);
    throw error;
  }

  callback(data);
}

function subscribeTable({ table, filter, query, callback }) {
  const client = ensureAuthenticatedClient();
  const channelName = `${table}-${Math.random().toString(36).slice(2, 10)}`;
  const channel = client.channel(channelName);
  const changeConfig = { event: '*', schema: 'public', table };

  if (filter) {
    changeConfig.filter = filter;
  }

  refreshSubscription(query, callback).catch((error) => console.error(error));

  channel.on('postgres_changes', changeConfig, () => {
    refreshSubscription(query, callback).catch((error) => console.error(error));
  });

  channel.subscribe();

  return () => {
    client.removeChannel(channel);
  };
}

function sortRouteSessions(rows) {
  return [...rows].sort(
    (left, right) =>
      right.date.localeCompare(left.date) ||
      new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
}

function subscribeIncrementalRouteSessions(callback) {
  const client = ensureAuthenticatedClient();
  const channel = client.channel(`route-sessions-${Math.random().toString(36).slice(2, 10)}`);
  const rowsById = new Map();
  let closed = false;

  const emit = () => {
    if (!closed) callback(sortRouteSessions([...rowsById.values()]));
  };

  client
    .from('route_sessions')
    .select(ROUTE_SESSION_COLUMNS)
    .gte('date', todayIso(-ROUTE_SESSION_HISTORY_DAYS))
    .order('date', { ascending: false })
    .order('started_at', { ascending: false })
    .then(({ data, error }) => {
      if (error) {
        console.error('[fleetline] route session load failed', error);
        return;
      }

      rowsById.clear();
      (data ?? []).map(mapRouteSession).forEach((row) => rowsById.set(row.id, row));
      emit();
    });

  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'route_sessions' }, (payload) => {
    if (payload.eventType === 'DELETE') {
      const id = payload.old?.id;
      if (id) rowsById.delete(id);
      emit();
      return;
    }

    if (payload.new?.id) {
      rowsById.set(payload.new.id, mapRouteSession(payload.new));
      emit();
    }
  });

  channel.subscribe();

  return () => {
    closed = true;
    client.removeChannel(channel);
  };
}

function subscribeIncrementalRoutePoints(callback) {
  const client = ensureAuthenticatedClient();
  const channel = client.channel(`route-points-${Math.random().toString(36).slice(2, 10)}`);

  // Do not bulk-load every GPS point for every rider. Full route geometry loads on demand per selected session.
  callback([]);

  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'route_points' }, (payload) => {
    if (payload.new?.id) {
      callback([mapRoutePoint(payload.new)]);
    }
  });

  channel.subscribe();

  return () => {
    client.removeChannel(channel);
  };
}

export const supabase = adminClient;

export async function getCurrentSession() {
  if (isDemoMode) {
    return demoSession;
  }

  if (!adminClient) {
    return null;
  }

  const { data } = await adminClient.auth.getSession();

  if (data.session?.user) {
    return {
      role: 'admin',
      user: data.session.user,
    };
  }

  if (riderSession?.accessToken && riderSession?.employee) {
    if (riderSession.expiresAt && riderSession.expiresAt <= Date.now()) {
      writeStoredRiderSession(null);
      return null;
    }

    return {
      role: 'rider',
      employee: riderSession.employee,
      accessToken: riderSession.accessToken,
    };
  }

  return null;
}

export function onSessionChange(listener) {
  sessionListeners.add(listener);
  getCurrentSession().then(listener);
  return () => sessionListeners.delete(listener);
}

export async function adminLogin(email, password) {
  if (isDemoMode) {
    if (!email || !password) {
      throw new Error('Email and password are required.');
    }

    writeStoredDemoSession({
      role: 'admin',
      user: {
        id: 'demo-admin',
        email,
      },
    });
    await notifySessionListeners();
    return { user: demoSession.user };
  }

  if (!adminClient) {
    throw missingConfigError();
  }

  writeStoredRiderSession(null);
  const response = await adminClient.auth.signInWithPassword({ email, password });
  if (response.error) {
    throw response.error;
  }

  await notifySessionListeners();
  return response.data;
}

export async function riderLogin(username, pin) {
  if (isDemoMode) {
    const store = readDemoStore();
    const employee = store.employees.find(
      (row) => row.active && row.username.toLowerCase() === String(username).trim().toLowerCase(),
    );

    if (!employee || employee.pin !== String(pin)) {
      throw new Error('Invalid username or PIN. Demo rider PIN is 1234 unless you reset it.');
    }

    writeStoredDemoSession({
      role: 'rider',
      employee: omitDemoPin(employee),
      accessToken: 'demo-rider-token',
    });
    await notifySessionListeners();
    return { employee: omitDemoPin(employee), access_token: 'demo-rider-token' };
  }

  if (!adminClient) {
    throw missingConfigError();
  }

  await adminClient.auth.signOut();

  const response = await adminClient.functions.invoke('rider-login', {
    body: { username, pin },
  });

  if (response.error) {
    throw new Error(await getFunctionErrorMessage(response.error, response.data, 'Rider sign-in failed.'));
  }

  if (response.data?.error) {
    throw new Error(response.data.error);
  }

  writeStoredRiderSession({
    accessToken: response.data.access_token,
    employee: response.data.employee,
    expiresAt: Date.now() + response.data.expires_in * 1000,
  });

  await notifySessionListeners();
  return response.data;
}

export async function signOut() {
  if (isDemoMode) {
    writeStoredDemoSession(null);
    await notifySessionListeners();
    return;
  }

  writeStoredRiderSession(null);
  await adminClient?.auth.signOut();
  await notifySessionListeners();
}

export async function listActiveEmployees() {
  if (isDemoMode) {
    return readDemoStore()
      .employees
      .filter((employee) => employee.active)
      .map((employee) => ({
        id: employee.id,
        name: employee.name,
        username: employee.username,
        bikePlate: employee.bikePlate,
        bikeModel: employee.bikeModel ?? '',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  throw new Error('Public rider directory is disabled.');
}

export function subscribeEmployees(callback) {
  if (isDemoMode) {
    return demoSubscribe('employees', callback);
  }

  return subscribeTable({
    table: 'employees',
    query: (client) =>
      client
        .from('employees')
        .select('id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at')
        .order('name'),
    callback: (rows) => callback((rows ?? []).map(mapEmployee)),
  });
}

export function subscribeReadings(callback) {
  if (isDemoMode) {
    return demoSubscribe('readings', callback);
  }

  return subscribeTable({
    table: 'readings',
    query: (client) =>
      client
        .from('readings')
        .select('id, employee_id, date, km, reading_type, photo_path, submitted_at, submitted_by')
        .order('date', { ascending: false })
        .order('submitted_at', { ascending: false }),
    callback: (rows) => callback((rows ?? []).map(mapReading)),
  });
}

export function subscribeRouteSessions(callback) {
  if (isDemoMode) {
    return demoSubscribe('routeSessions', callback);
  }

  return subscribeIncrementalRouteSessions(callback);
}

export function subscribeRoutePoints(callback) {
  if (isDemoMode) {
    return demoSubscribe('routePoints', callback);
  }

  return subscribeIncrementalRoutePoints(callback);
}

async function loadShopPinsWithOptionalPhoto(client) {
  const queryShopPins = (columns) =>
    client
      .from('shop_pins')
      .select(columns)
      .order('pinned_at', { ascending: false })
      .limit(1000);

  const result = await queryShopPins(SHOP_PIN_COLUMNS);
  const missingPhotoColumn =
    result.error?.code === '42703' ||
    String(result.error?.message ?? '').toLowerCase().includes('photo_path');

  return missingPhotoColumn ? queryShopPins(LEGACY_SHOP_PIN_COLUMNS) : result;
}

export function subscribeShopPins(callback) {
  if (isDemoMode) {
    return demoSubscribe('shopPins', callback);
  }

  return subscribeTable({
    table: 'shop_pins',
    query: loadShopPinsWithOptionalPhoto,
    callback: (rows) => callback((rows ?? []).map(mapShopPin)),
  });
}

export function subscribeRouteTemplates(callback) {
  if (isDemoMode) {
    return demoSubscribe('routeTemplates', callback);
  }

  const loadTemplates = async (client) => {
    const [{ data: templates, error: templatesError }, { data: stops, error: stopsError }] = await Promise.all([
      client
        .from('route_templates')
        .select(ROUTE_TEMPLATE_COLUMNS)
        .order('updated_at', { ascending: false }),
      client
        .from('route_template_stops')
        .select(ROUTE_TEMPLATE_STOP_COLUMNS)
        .order('stop_order', { ascending: true }),
    ]);

    return {
      data: (templates ?? []).map((template) =>
        mapRouteTemplate(
          template,
          (stops ?? [])
            .filter((stop) => stop.template_id === template.id)
            .map(mapRouteTemplateStop),
        ),
      ),
      error: templatesError ?? stopsError,
    };
  };

  const unsubscribeTemplates = subscribeTable({
    table: 'route_templates',
    query: loadTemplates,
    callback,
  });
  const unsubscribeStops = subscribeTable({
    table: 'route_template_stops',
    query: loadTemplates,
    callback,
  });

  return () => {
    unsubscribeTemplates();
    unsubscribeStops();
  };
}

export function subscribeRouteDeviationEvents(callback) {
  if (isDemoMode) {
    return demoSubscribe('routeDeviationEvents', callback);
  }

  return subscribeTable({
    table: 'route_deviation_events',
    query: (client) =>
      client
        .from('route_deviation_events')
        .select(ROUTE_DEVIATION_COLUMNS)
        .order('recorded_at', { ascending: false })
        .limit(250),
    callback: (rows) => callback((rows ?? []).map(mapRouteDeviation)),
  });
}

export async function listRoutePointsForSession(sessionId) {
  if (isDemoMode) {
    return readDemoStore()
      .routePoints
      .filter((point) => point.sessionId === sessionId)
      .sort((left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime());
  }

  const client = ensureAuthenticatedClient();
  const { data, error } = await client
    .from('route_points')
    .select(ROUTE_POINT_COLUMNS)
    .eq('session_id', sessionId)
    .order('recorded_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(mapRoutePoint);
}

export async function saveRouteTemplate(template) {
  const now = new Date().toISOString();
  const stops = (template.stops ?? []).map((stop, index) => ({
    stopOrder: index + 1,
    name: stop.name || `Stop ${index + 1}`,
    lat: Number(stop.lat),
    lng: Number(stop.lng),
    radiusM: Math.round(Number(stop.radiusM) || 100),
    visitCount: Math.max(1, Math.round(Number(stop.visitCount) || 1)),
    sourcePinIds: stop.sourcePinIds ?? [],
  }));

  if (isDemoMode) {
    const store = readDemoStore();
    store.routeTemplates = store.routeTemplates.map((row) =>
      row.employeeId === template.employeeId && row.weekday === template.weekday && row.status === 'approved'
        ? { ...row, status: 'archived', updatedAt: now }
        : row,
    );

    const row = {
      id: crypto.randomUUID(),
      employeeId: template.employeeId,
      weekday: template.weekday,
      name: template.name,
      status: template.status ?? 'approved',
      sourceStartDate: template.sourceStartDate,
      sourceEndDate: template.sourceEndDate,
      sourcePinCount: template.sourcePinCount ?? 0,
      duplicateCount: template.duplicateCount ?? 0,
      approvedBy: demoSession?.role === 'admin' ? demoSession.user.id : null,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const stopRows = stops.map((stop) => ({
      id: crypto.randomUUID(),
      templateId: row.id,
      stopOrder: stop.stopOrder,
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng,
      radiusM: stop.radiusM,
      visitCount: stop.visitCount,
      sourcePinIds: stop.sourcePinIds,
      createdAt: now,
    }));

    store.routeTemplates.unshift(row);
    store.routeTemplateStops.push(...stopRows);
    appendDemoAudit(store, 'route_template.approve', 'route_template', row.id, null, { ...row, stops: stopRows });
    writeDemoStore(store);
    notifyDemoTable('routeTemplates');
    return { ...row, stops: stopRows };
  }

  const client = ensureAuthenticatedClient();
  const archive = await client
    .from('route_templates')
    .update({ status: 'archived' })
    .eq('employee_id', template.employeeId)
    .eq('weekday', template.weekday)
    .eq('status', 'approved');

  if (archive.error) {
    throw archive.error;
  }

  const { data, error } = await client
    .from('route_templates')
    .insert({
      employee_id: template.employeeId,
      weekday: template.weekday,
      name: template.name,
      status: template.status ?? 'approved',
      source_start_date: template.sourceStartDate,
      source_end_date: template.sourceEndDate,
      source_pin_count: template.sourcePinCount ?? 0,
      duplicate_count: template.duplicateCount ?? 0,
      approved_at: now,
    })
    .select(ROUTE_TEMPLATE_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  let stopRows = [];
  if (stops.length) {
    const { data: savedStops, error: stopsError } = await client
      .from('route_template_stops')
      .insert(stops.map((stop) => ({
        template_id: data.id,
        stop_order: stop.stopOrder,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        radius_m: stop.radiusM,
        visit_count: stop.visitCount,
        source_pin_ids: stop.sourcePinIds,
      })))
      .select(ROUTE_TEMPLATE_STOP_COLUMNS);

    if (stopsError) {
      throw stopsError;
    }

    stopRows = (savedStops ?? []).map(mapRouteTemplateStop);
  }

  return mapRouteTemplate(data, stopRows);
}

export async function deleteRouteSession(sessionId) {
  if (isDemoMode) {
    const store = readDemoStore();
    const before = store.routeSessions.find((row) => row.id === sessionId);
    store.routeSessions = store.routeSessions.filter((row) => row.id !== sessionId);
    store.routePoints = store.routePoints.filter((row) => row.sessionId !== sessionId);
    store.shopPins = store.shopPins.filter((row) => row.routeSessionId !== sessionId);
    store.routeDeviationEvents = store.routeDeviationEvents.filter((row) => row.routeSessionId !== sessionId);

    appendDemoAudit(store, 'route.delete', 'route_session', sessionId, before ?? null, {
      deleted: true,
      removedPoints: true,
    });
    writeDemoStore(store);
    notifyDemoTable('routeSessions');
    notifyDemoTable('routePoints');
    notifyDemoTable('shopPins');
    notifyDemoTable('routeDeviationEvents');
    return;
  }

  const client = ensureAuthenticatedClient();
  const { error } = await client
    .from('route_sessions')
    .delete()
    .eq('id', sessionId);

  if (error) {
    throw error;
  }
}

export function subscribeFuelPriceHistory(callback) {
  if (isDemoMode) {
    return demoSubscribe('fuelPriceHistory', callback);
  }

  return subscribeTable({
    table: 'fuel_price_history',
    query: (client) =>
      client
        .from('fuel_price_history')
        .select('date, fuel_price, currency, created_at, updated_at, updated_by')
        .order('date', { ascending: false }),
    callback: (rows) => callback((rows ?? []).map(mapFuelPriceHistory)),
  });
}

export function subscribeDailyReviews(callback) {
  if (isDemoMode) {
    return demoSubscribe('dailyReviews', callback);
  }

  return subscribeTable({
    table: 'daily_reviews',
    query: (client) =>
      client
        .from('daily_reviews')
        .select('id, employee_id, date, status, notes, reviewed_by, reviewed_at, created_at, updated_at')
        .order('date', { ascending: false }),
    callback: (rows) => callback((rows ?? []).map(mapDailyReview)),
  });
}

export async function saveDailyReview(review) {
  if (isDemoMode) {
    const store = readDemoStore();
    const now = new Date().toISOString();
    const index = store.dailyReviews.findIndex(
      (row) => row.employeeId === review.employeeId && row.date === review.date,
    );
    const nextReview = {
      id: index >= 0 ? store.dailyReviews[index].id : crypto.randomUUID(),
      employeeId: review.employeeId,
      date: review.date,
      status: review.status ?? 'pending_review',
      notes: review.notes ?? '',
      reviewedBy: demoSession?.role === 'admin' ? demoSession.user.id : null,
      reviewedAt: ['approved', 'problem', 'paid'].includes(review.status) ? now : null,
      createdAt: index >= 0 ? store.dailyReviews[index].createdAt : now,
      updatedAt: now,
    };

    const before = index >= 0 ? store.dailyReviews[index] : null;
    if (index >= 0) {
      store.dailyReviews[index] = nextReview;
    } else {
      store.dailyReviews.unshift(nextReview);
    }

    appendDemoAudit(
      store,
      index >= 0 ? 'daily_review.update' : 'daily_review.create',
      'daily_review',
      `${nextReview.employeeId}:${nextReview.date}`,
      before,
      nextReview,
    );
    writeDemoStore(store);
    notifyDemoTable('dailyReviews');
    return nextReview;
  }

  const client = ensureAuthenticatedClient();
  const payload = {
    employee_id: review.employeeId,
    date: review.date,
    status: review.status ?? 'pending_review',
    notes: review.notes ?? null,
  };

  const { data, error } = await client
    .from('daily_reviews')
    .upsert(payload, { onConflict: 'employee_id,date' })
    .select('id, employee_id, date, status, notes, reviewed_by, reviewed_at, created_at, updated_at')
    .single();

  if (error) {
    throw error;
  }

  return mapDailyReview(data);
}

export function subscribeConfig(callback) {
  if (isDemoMode) {
    return demoSubscribe('config', callback);
  }

  return subscribeTable({
    table: 'config',
    filter: 'id=eq.1',
    query: (client) => client.from('config').select('*').eq('id', 1).single(),
    callback: (row) => callback(mapConfig(row)),
  });
}

export async function saveEmployee(employee, options = {}) {
  if (isDemoMode) {
    const store = readDemoStore();
    const now = new Date().toISOString();

    if (options.isNew) {
      if (!/^\d{4}$/.test(String(options.pin ?? ''))) {
        throw new Error('A 4-digit PIN is required for new riders.');
      }

      const nextEmployee = {
        id: crypto.randomUUID(),
        name: employee.name.trim(),
        username: employee.username.trim().toLowerCase(),
        phone: employee.phone?.trim() || '',
        bikePlate: employee.bikePlate.trim().toUpperCase(),
        bikeModel: employee.bikeModel?.trim() || '',
        mileage: employee.mileage === '' || employee.mileage === null ? null : Number(employee.mileage),
        active: employee.active ?? true,
        pin: String(options.pin),
        createdAt: now,
        updatedAt: now,
      };

      store.employees.push(nextEmployee);
      appendDemoAudit(store, 'employee.create', 'employee', nextEmployee.id, null, omitDemoPin(nextEmployee));
      writeDemoStore(store);
      notifyDemoTable('employees');
      return omitDemoPin(nextEmployee);
    }

    const index = store.employees.findIndex((row) => row.id === employee.id);
    if (index === -1) {
      throw new Error('Employee not found.');
    }

    const before = omitDemoPin(store.employees[index]);
    const nextEmployee = {
      ...store.employees[index],
      name: employee.name.trim(),
      username: employee.username.trim().toLowerCase(),
      phone: employee.phone?.trim() || '',
      bikePlate: employee.bikePlate.trim().toUpperCase(),
      bikeModel: employee.bikeModel?.trim() || '',
      mileage: employee.mileage === '' || employee.mileage === null ? null : Number(employee.mileage),
      active: employee.active ?? true,
      updatedAt: now,
    };

    store.employees[index] = nextEmployee;
    appendDemoAudit(store, 'employee.update', 'employee', nextEmployee.id, before, omitDemoPin(nextEmployee));
    writeDemoStore(store);
    notifyDemoTable('employees');
    return omitDemoPin(nextEmployee);
  }

  const result = await invokeFunction('upsert-employee', {
    employee,
    is_new: Boolean(options.isNew),
    pin: options.pin ? String(options.pin) : undefined,
  });

  return mapEmployee(result.employee);
}

export async function deleteEmployee(employeeId) {
  if (isDemoMode) {
    const store = readDemoStore();
    const before = store.employees.find((row) => row.id === employeeId);
    store.employees = store.employees.filter((row) => row.id !== employeeId);
    store.readings = store.readings.filter((row) => row.employeeId !== employeeId);
    store.routeSessions = store.routeSessions.filter((row) => row.employeeId !== employeeId);
    store.routePoints = store.routePoints.filter((row) => row.employeeId !== employeeId);
    store.shopPins = store.shopPins.filter((row) => row.employeeId !== employeeId);
    store.routeDeviationEvents = store.routeDeviationEvents.filter((row) => row.employeeId !== employeeId);
    const removedTemplateIds = new Set(store.routeTemplates.filter((row) => row.employeeId === employeeId).map((row) => row.id));
    store.routeTemplates = store.routeTemplates.filter((row) => row.employeeId !== employeeId);
    store.routeTemplateStops = store.routeTemplateStops.filter((row) => !removedTemplateIds.has(row.templateId));
    Object.keys(store.photos).forEach((path) => {
      if (path.includes(`/${employeeId}/`)) {
        delete store.photos[path];
      }
    });
    appendDemoAudit(store, 'employee.delete', 'employee', employeeId, before ? omitDemoPin(before) : null, null);
    writeDemoStore(store);
    notifyDemoTable('employees');
    notifyDemoTable('readings');
    notifyDemoTable('routeSessions');
    notifyDemoTable('routePoints');
    notifyDemoTable('shopPins');
    notifyDemoTable('routeDeviationEvents');
    notifyDemoTable('routeTemplates');
    return;
  }

  await invokeFunction('delete-employee', { employee_id: employeeId });
}

export async function deleteReading(readingId) {
  if (isDemoMode) {
    const store = readDemoStore();
    const reading = store.readings.find((row) => row.id === readingId);
    store.readings = store.readings.filter((row) => row.id !== readingId);

    if (reading?.photoPath) {
      delete store.photos[reading.photoPath];
    }

    appendDemoAudit(store, 'reading.delete', 'reading', readingId, reading ?? null, {
      deleted: true,
      removedPhoto: Boolean(reading?.photoPath),
    });
    writeDemoStore(store);
    notifyDemoTable('readings');
    return;
  }

  await invokeFunction('delete-reading', { reading_id: readingId });
}

export async function uploadPhoto(employeeId, readingId, file) {
  if (isDemoMode) {
    const path = `demo/readings/${employeeId}/${readingId}.jpg`;
    const store = readDemoStore();
    store.photos[path] = await blobToDataUrl(file);
    writeDemoStore(store);
    return path;
  }

  const client = ensureAuthenticatedClient();
  const path = `readings/${employeeId}/${readingId}.jpg`;
  const { error } = await client.storage.from('odometer-photos').upload(path, file, {
    contentType: 'image/jpeg',
    upsert: false,
  });

  if (error) {
    throw error;
  }

  return path;
}

export async function saveReading(reading) {
  if (isDemoMode) {
    const store = readDemoStore();
    const row = {
      id: reading.id,
      employeeId: reading.employeeId,
      date: reading.date,
      km: reading.km,
      readingType: reading.readingType ?? 'evening',
      photoPath: reading.photoPath,
      submittedAt: reading.submittedAt ?? new Date().toISOString(),
      submittedBy: demoSession?.role === 'rider' ? demoSession.employee.id : 'demo-admin',
    };

    store.readings.push(row);
    writeDemoStore(store);
    notifyDemoTable('readings');
    return row;
  }

  const client = ensureAuthenticatedClient();
  const payload = {
    id: reading.id,
    employee_id: reading.employeeId,
    date: reading.date,
    km: reading.km,
    reading_type: reading.readingType ?? 'evening',
    photo_path: reading.photoPath,
    submitted_at: reading.submittedAt ?? new Date().toISOString(),
  };

  const { data, error } = await client
    .from('readings')
    .insert(payload)
    .select('id, employee_id, date, km, reading_type, photo_path, submitted_at, submitted_by')
    .single();

  if (error) {
    throw error;
  }

  return mapReading(data);
}

export async function startRouteSession(session) {
  if (isDemoMode) {
    const store = readDemoStore();
    const existing = store.routeSessions.find(
      (row) => row.employeeId === session.employeeId && row.date === session.date,
    );

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const row = {
      id: session.id,
      employeeId: session.employeeId,
      date: session.date,
      startReadingId: session.startReadingId,
      endReadingId: null,
      status: 'active',
      startedAt: session.startedAt ?? now,
      endedAt: null,
      lastPointAt: null,
      pointCount: 0,
      totalDistanceM: 0,
      createdBy: demoSession?.role === 'rider' ? demoSession.employee.id : 'demo-admin',
      createdAt: now,
      updatedAt: now,
    };

    store.routeSessions.unshift(row);
    appendDemoAudit(store, 'route.start', 'route_session', row.id, null, row);
    writeDemoStore(store);
    notifyDemoTable('routeSessions');
    return row;
  }

  const client = ensureAuthenticatedClient();
  const payload = {
    id: session.id,
    employee_id: session.employeeId,
    date: session.date,
    start_reading_id: session.startReadingId,
    status: 'active',
    started_at: session.startedAt ?? new Date().toISOString(),
  };

  const { data, error } = await client
    .from('route_sessions')
    .insert(payload)
    .select(ROUTE_SESSION_COLUMNS)
    .single();

  if (error?.code === '23505') {
    const { data: existing, error: existingError } = await client
      .from('route_sessions')
      .select(ROUTE_SESSION_COLUMNS)
      .eq('employee_id', session.employeeId)
      .eq('date', session.date)
      .single();

    if (existingError) {
      throw existingError;
    }

    if (existing.status !== 'active') {
      const { data: recovered, error: recoverError } = await client
        .from('route_sessions')
        .update({
          start_reading_id: session.startReadingId ?? existing.start_reading_id,
          end_reading_id: null,
          status: 'active',
          ended_at: null,
        })
        .eq('id', existing.id)
        .select(ROUTE_SESSION_COLUMNS)
        .single();

      if (recoverError) {
        throw recoverError;
      }

      return mapRouteSession(recovered);
    }

    return mapRouteSession(existing);
  }

  if (error) {
    throw error;
  }

  return mapRouteSession(data);
}

export async function appendRoutePoints(points) {
  if (!points?.length) return [];

  if (isDemoMode) {
    const store = readDemoStore();
    const inserted = [];

    points.forEach((point) => {
      if (store.routePoints.some((row) => row.id === point.id)) return;
      const row = {
        id: point.id,
        sessionId: point.sessionId,
        employeeId: point.employeeId,
        recordedAt: point.recordedAt,
        lat: Number(point.lat),
        lng: Number(point.lng),
        accuracyM: point.accuracyM ?? null,
        speedMps: point.speedMps ?? null,
        heading: point.heading ?? null,
        createdAt: new Date().toISOString(),
      };
      store.routePoints.push(row);
      inserted.push(row);

      const sessionRow = store.routeSessions.find((session) => session.id === point.sessionId);
      if (sessionRow) {
        sessionRow.pointCount = (sessionRow.pointCount ?? 0) + 1;
        sessionRow.lastPointAt = point.recordedAt;
        sessionRow.updatedAt = new Date().toISOString();
      }
    });

    writeDemoStore(store);
    notifyDemoTable('routePoints');
    notifyDemoTable('routeSessions');
    return inserted;
  }

  const client = ensureAuthenticatedClient();
  const payload = points.map((point) => ({
    id: point.id,
    session_id: point.sessionId,
    employee_id: point.employeeId,
    recorded_at: point.recordedAt,
    lat: point.lat,
    lng: point.lng,
    accuracy_m: point.accuracyM ?? null,
    speed_mps: point.speedMps ?? null,
    heading: point.heading ?? null,
  }));

  const { data, error } = await client
    .from('route_points')
    .insert(payload)
    .select(ROUTE_POINT_COLUMNS);

  if (error?.code === '23505') {
    return [];
  }

  if (error) {
    throw error;
  }

  return (data ?? []).map(mapRoutePoint);
}

export async function finishRouteSession({ sessionId, endReadingId, endedAt, totalDistanceM }) {
  if (isDemoMode) {
    const store = readDemoStore();
    const index = store.routeSessions.findIndex((row) => row.id === sessionId);

    if (index === -1) {
      return null;
    }

    const before = { ...store.routeSessions[index] };
    store.routeSessions[index] = {
      ...store.routeSessions[index],
      endReadingId,
      status: 'completed',
      endedAt: endedAt ?? new Date().toISOString(),
      totalDistanceM: Math.max(0, Math.round(Number(totalDistanceM) || 0)),
      updatedAt: new Date().toISOString(),
    };
    appendDemoAudit(store, 'route.complete', 'route_session', sessionId, before, store.routeSessions[index]);
    writeDemoStore(store);
    notifyDemoTable('routeSessions');
    return store.routeSessions[index];
  }

  const client = ensureAuthenticatedClient();
  const { data, error } = await client
    .from('route_sessions')
    .update({
      end_reading_id: endReadingId,
      status: 'completed',
      ended_at: endedAt ?? new Date().toISOString(),
      total_distance_m: Math.max(0, Math.round(Number(totalDistanceM) || 0)),
    })
    .eq('id', sessionId)
    .select(ROUTE_SESSION_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return mapRouteSession(data);
}

export async function saveConfig(config) {
  if (isDemoMode) {
    const store = readDemoStore();
    const before = { ...store.config };
    store.config = {
      id: 1,
      fuelPrice: Number(config.fuelPrice),
      defaultMileage: Number(config.defaultMileage),
      currency: config.currency.trim().toUpperCase(),
      adminWhatsApp: config.adminWhatsApp?.trim() || '',
      updatedAt: new Date().toISOString(),
      updatedBy: demoSession?.role === 'admin' ? demoSession.user.id : null,
    };
    const priceIndex = store.fuelPriceHistory.findIndex((row) => row.date === todayIso());
    const priceRow = {
      date: todayIso(),
      fuelPrice: Number(config.fuelPrice),
      currency: config.currency.trim().toUpperCase(),
      createdAt: priceIndex >= 0 ? store.fuelPriceHistory[priceIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: demoSession?.role === 'admin' ? demoSession.user.id : null,
    };
    if (priceIndex >= 0) {
      store.fuelPriceHistory[priceIndex] = priceRow;
    } else {
      store.fuelPriceHistory.unshift(priceRow);
    }
    appendDemoAudit(store, 'config.update', 'config', '1', before, store.config);
    writeDemoStore(store);
    notifyDemoTable('config');
    notifyDemoTable('fuelPriceHistory');
    return store.config;
  }

  const client = ensureAuthenticatedClient();
  const payload = {
    id: 1,
    fuel_price: Number(config.fuelPrice),
    default_mileage: Number(config.defaultMileage),
    currency: config.currency.trim().toUpperCase(),
    admin_whatsapp: config.adminWhatsApp?.trim() || null,
  };

  const { data, error } = await client
    .from('config')
    .update(payload)
    .eq('id', 1)
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return mapConfig(data);
}

export async function inviteAdmin(email, redirectTo) {
  if (isDemoMode) {
    const store = readDemoStore();
    const admin = {
      userId: crypto.randomUUID(),
      email: String(email).trim().toLowerCase(),
      invitedBy: 'demo-admin',
      createdAt: new Date().toISOString(),
    };
    store.admins.unshift(admin);
    appendDemoAudit(store, 'admin.invite', 'admin', admin.userId, null, admin);
    writeDemoStore(store);
    return { ok: true, admin, redirectTo };
  }

  return invokeFunction('invite-admin', { email, redirectTo });
}

export async function resetRiderPin(employeeId, newPin) {
  if (isDemoMode) {
    if (!/^\d{4}$/.test(String(newPin))) {
      throw new Error('PIN must be exactly 4 digits.');
    }

    const store = readDemoStore();
    const index = store.employees.findIndex((row) => row.id === employeeId);
    if (index === -1) {
      throw new Error('Employee not found.');
    }

    store.employees[index] = {
      ...store.employees[index],
      pin: String(newPin),
      updatedAt: new Date().toISOString(),
    };
    appendDemoAudit(store, 'employee.pin_reset', 'employee', employeeId, null, {
      employeeId,
      pinReset: true,
    });
    writeDemoStore(store);
    return { ok: true };
  }

  return invokeFunction('reset-rider-pin', {
    employee_id: employeeId,
    new_pin: newPin,
  });
}

export async function listAdmins() {
  if (isDemoMode) {
    return [...readDemoStore().admins];
  }

  const { data, error } = await ensureAuthenticatedClient()
    .from('admins')
    .select('user_id, email, invited_by, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map(mapAdmin);
}

export async function listAuditLog({ page = 0, pageSize = 20 } = {}) {
  if (isDemoMode) {
    const rows = readDemoStore().auditLog;
    const from = page * pageSize;
    return {
      rows: rows.slice(from, from + pageSize),
      count: rows.length,
      page,
      pageSize,
    };
  }

  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await ensureAuthenticatedClient()
    .from('audit_log')
    .select('id, actor_id, action, entity_type, entity_id, before, after, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    throw error;
  }

  return {
    rows: (data ?? []).map(mapAuditLog),
    count: count ?? 0,
    page,
    pageSize,
  };
}

export async function getSignedPhotoUrl(photoPath, expiresIn = 300) {
  if (!photoPath) {
    return null;
  }

  if (isDemoMode) {
    return readDemoStore().photos[photoPath] ?? null;
  }

  const { data, error } = await ensureAuthenticatedClient()
    .storage
    .from('odometer-photos')
    .createSignedUrl(photoPath, expiresIn);

  if (error) {
    throw error;
  }

  return data.signedUrl;
}
