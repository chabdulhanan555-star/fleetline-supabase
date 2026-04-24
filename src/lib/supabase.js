import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const RIDER_SESSION_KEY = 'fleetline.rider-session.v1';
const DEMO_STORE_KEY = 'fleetline.demo-store.v1';
const DEMO_SESSION_KEY = 'fleetline.demo-session.v1';
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const isDemoMode =
  !isSupabaseConfigured && import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true';

if (!isSupabaseConfigured) {
  console.warn('[fleetline] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}

const adminClient = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
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
};

let riderSession = isSupabaseConfigured ? readStoredRiderSession() : null;
let riderClient = riderSession ? buildRiderClient(riderSession.accessToken) : null;
let demoSession = isDemoMode ? readStoredDemoSession() : null;

adminClient?.auth.onAuthStateChange(() => {
  notifySessionListeners();
});

function missingConfigError() {
  return new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Add them to .env.local and restart Vite.');
}

function todayIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
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
        date: todayIso(-2),
        km: 12420,
        photoPath: null,
        submittedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        submittedBy: employees[0].id,
      },
      {
        id: 'demo-reading-2',
        employeeId: employees[0].id,
        date: todayIso(-1),
        km: 12492,
        photoPath: null,
        submittedAt: new Date(Date.now() - 86400000).toISOString(),
        submittedBy: employees[0].id,
      },
      {
        id: 'demo-reading-3',
        employeeId: employees[1].id,
        date: todayIso(-1),
        km: 8820,
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
  };
}

function readDemoStore() {
  const raw = window.localStorage.getItem(DEMO_STORE_KEY);
  if (raw) {
    return JSON.parse(raw);
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

  if (!nextSession) {
    riderClient = null;
    window.localStorage.removeItem(RIDER_SESSION_KEY);
    return;
  }

  riderClient = buildRiderClient(nextSession.accessToken);
  window.localStorage.setItem(RIDER_SESSION_KEY, JSON.stringify(nextSession));
}

function buildRiderClient(accessToken) {
  if (!isSupabaseConfigured) {
    throw missingConfigError();
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
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
    photoPath: row.photo_path,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by,
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
        .select('id, employee_id, date, km, photo_path, submitted_at, submitted_by')
        .order('date', { ascending: false })
        .order('submitted_at', { ascending: false }),
    callback: (rows) => callback((rows ?? []).map(mapReading)),
  });
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
    Object.keys(store.photos).forEach((path) => {
      if (path.includes(`/${employeeId}/`)) {
        delete store.photos[path];
      }
    });
    appendDemoAudit(store, 'employee.delete', 'employee', employeeId, before ? omitDemoPin(before) : null, null);
    writeDemoStore(store);
    notifyDemoTable('employees');
    notifyDemoTable('readings');
    return;
  }

  await invokeFunction('delete-employee', { employee_id: employeeId });
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
    photo_path: reading.photoPath,
    submitted_at: reading.submittedAt ?? new Date().toISOString(),
  };

  const { data, error } = await client
    .from('readings')
    .insert(payload)
    .select('id, employee_id, date, km, photo_path, submitted_at, submitted_by')
    .single();

  if (error) {
    throw error;
  }

  return mapReading(data);
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
    appendDemoAudit(store, 'config.update', 'config', '1', before, store.config);
    writeDemoStore(store);
    notifyDemoTable('config');
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
