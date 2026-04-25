import React, { useEffect, useMemo, useRef, useState } from 'react';
import imageCompression from 'browser-image-compression';
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
  MessageCircle,
  PackageCheck,
  Phone,
  RefreshCw,
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
  deleteEmployee,
  deleteReading,
  getCurrentSession,
  getSignedPhotoUrl,
  inviteAdmin,
  isDemoMode,
  isSupabaseConfigured,
  listAdmins,
  listAuditLog,
  onSessionChange,
  resetRiderPin,
  riderLogin,
  saveConfig,
  saveEmployee,
  saveReading,
  signOut,
  subscribeConfig,
  subscribeEmployees,
  subscribeReadings,
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

const localIsoDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const today = () => localIsoDate();
const monthKey = (value) => value.slice(0, 7);
const fmtDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtShort = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
const fmtNum = (value) => Number(value ?? 0).toLocaleString('en-US');

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

const openWhatsApp = (phone, message) => {
  const clean = sanitizePhone(phone);
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

const getMonthlySummary = (readings, selectedMonth, mileage, fuelPrice) => {
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

  return {
    dailySummaries,
    completedDays: dailySummaries.filter((day) => day.complete).length,
    totalKm,
    fuelUsed,
    cost: fuelUsed * Number(fuelPrice),
    warningCount: dailySummaries.filter((day) => day.invalid || day.distance > HIGH_DAILY_KM_WARNING).length,
  };
};

const buildReadingsMap = (rows) =>
  rows.reduce((accumulator, row) => {
    accumulator[row.employeeId] = accumulator[row.employeeId] || [];
    accumulator[row.employeeId].push(row);
    return accumulator;
  }, {});

const buildFleetCSV = (employees, readingsByEmployee, config, selectedMonth) => {
  const rows = [
    [`FleetLine Fleet Report - ${selectedMonth || 'All time'}`],
    [`Generated: ${new Date().toLocaleString()}`],
    [`Fuel price: ${config.currency} ${config.fuelPrice}/L`],
    [],
    ['Rider', 'Username', 'Bike Plate', 'Bike Model', 'Mileage (km/L)', 'Readings', 'Completed Days', 'Total KM', 'Fuel (L)', `Cost (${config.currency})`],
  ];

  let grandKm = 0;
  let grandFuel = 0;
  let grandCost = 0;

  employees.forEach((employee) => {
    const mileage = Number(employee.mileage ?? config.defaultMileage);
    const readings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
      (reading) => !selectedMonth || monthKey(reading.date) === selectedMonth,
    );
    const summary = getMonthlySummary(readings, selectedMonth, mileage, config.fuelPrice);

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

const buildEmployeeCSV = (employee, readingsByEmployee, config, selectedMonth) => {
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

  const dailySummaries = getMonthlySummary(readings, selectedMonth, mileage, config.fuelPrice).dailySummaries;

  dailySummaries.forEach((day) => {
    const distance = day.complete ? day.distance : 0;
    const fuel = mileage > 0 && day.complete ? distance / mileage : 0;
    const cost = fuel * Number(config.fuelPrice);
    rows.push([
      day.date,
      day.morning?.km ?? '',
      day.evening?.km ?? '',
      distance,
      fuel.toFixed(2),
      cost.toFixed(2),
      day.invalid ? 'Check odometer: evening lower than morning' : day.complete ? 'Complete' : 'Incomplete',
    ]);
  });

  return rows;
};

const ThemeStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=JetBrains+Mono:wght@400;500;700&family=Manrope:wght@400;500;600;700;800&display=swap');
    :root {
      --fleet-orange: #ff6b1a;
      --fleet-gold: #f4b41a;
      --fleet-black: #050505;
      --fleet-panel: #111111;
      --fleet-border: rgba(255, 140, 50, 0.22);
    }
    .font-display { font-family: 'Bebas Neue', sans-serif; letter-spacing: 0.02em; }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
    .font-body { font-family: 'Manrope', sans-serif; }
    .grid-bg {
      background-image:
        linear-gradient(rgba(255,140,50,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,140,50,0.04) 1px, transparent 1px);
      background-size: 32px 32px;
    }
    .ticker-border { background: linear-gradient(90deg, #ff6b1a, #f4b41a, #ff6b1a); }
    .glow-orange {
      box-shadow: 0 0 24px -4px rgba(255,107,26,0.45), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    @keyframes pulse-orange {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    .pulse-dot { animation: pulse-orange 1.5s ease-in-out infinite; }
    input:focus, textarea:focus, select:focus { outline: none; }
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
  <div className="sticky top-0 z-30 bg-black/95 backdrop-blur border-b border-orange-500/20">
    <div className="h-1 ticker-border"></div>
    <div className="flex items-center justify-between px-5 py-3">
      <div className="flex items-center gap-2">
        <div
          className="flex h-9 w-9 items-center justify-center bg-gradient-to-br from-orange-500 to-amber-600"
          style={{ clipPath: 'polygon(20% 0, 100% 0, 80% 100%, 0 100%)' }}
        >
          <Bike className="h-5 w-5 text-black" strokeWidth={2.5} />
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
            className="flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 transition-colors hover:border-orange-500/60 hover:bg-orange-500/10"
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
    orange: 'text-orange-500 border-orange-500/30',
    gold: 'text-amber-400 border-amber-400/30',
    white: 'text-white border-zinc-700',
  };
  const [textColor, borderColor] = colors[accent].split(' ');

  return (
    <div className={`relative overflow-hidden border bg-zinc-950 p-4 ${borderColor}`}>
      <div className="absolute right-0 top-0 h-16 w-16 opacity-5">
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

const Modal = ({ open, onClose, title, children }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-5">
      <div className="w-full max-w-lg border border-orange-500/25 bg-black sm:max-h-[90vh] sm:overflow-y-auto">
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
        className={`w-full border border-zinc-800 bg-black py-3 pr-3 text-white transition-colors focus:border-orange-500 ${
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

const SupabaseSetupView = () => (
  <div className="grid-bg flex min-h-screen items-center justify-center bg-black px-5 text-white font-body">
    <ThemeStyles />
    <div className="w-full max-w-xl border border-orange-500/30 bg-zinc-950 p-6">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Setup Required</div>
      <div className="font-display text-4xl leading-none text-white">Connect Supabase</div>
      <div className="mt-3 text-sm leading-6 text-zinc-400">
        Add your project URL and anon key to a local env file, then restart the Vite server.
      </div>
      <pre className="mt-5 overflow-x-auto border border-zinc-800 bg-black p-4 font-mono text-xs text-amber-300">
{`# .env.local
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key`}
      </pre>
      <div className="mt-4 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
        Restart with: npm.cmd run dev
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
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="relative mb-4 inline-block">
              <div className="absolute inset-0 bg-orange-500/20 blur-2xl"></div>
              <div
                className="relative flex h-20 w-20 items-center justify-center bg-gradient-to-br from-orange-500 via-orange-600 to-amber-700"
                style={{ clipPath: 'polygon(20% 0, 100% 0, 80% 100%, 0 100%)' }}
              >
                <Bike className="h-10 w-10 text-black" strokeWidth={2.5} />
              </div>
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
              <div className="mb-4 border border-orange-500/30 bg-orange-500/5 p-5">
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
                className="w-full bg-gradient-to-r from-orange-500 to-amber-500 py-3 font-display text-lg tracking-widest text-black glow-orange disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? 'VERIFYING...' : 'ENTER DASHBOARD ->'}
              </button>
              <button
                onClick={() => setMode('admin')}
                className="mt-4 flex w-full items-center justify-center gap-2 border border-amber-500/50 bg-black py-3 text-amber-400 transition-colors hover:bg-amber-500/10"
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
              <div className="mb-4 border border-amber-500/30 bg-amber-500/5 p-5">
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
                className="w-full bg-gradient-to-r from-orange-500 to-amber-500 py-3 font-display text-lg tracking-widest text-black glow-orange disabled:cursor-not-allowed disabled:opacity-40"
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
        <button onClick={onCancel} className="flex-1 border border-zinc-800 bg-zinc-900 py-3 font-display tracking-widest text-zinc-400">
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
          className="mt-3 flex w-full items-center justify-center gap-2 border border-red-500/40 py-2.5 font-display tracking-widest text-red-400 hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" /> DELETE RIDER
        </button>
      ) : null}
    </div>
  );
};

const AdminOverview = ({ employees, readingsByEmployee, config, onSelectEmployee }) => {
  const thisMonth = monthKey(today());
  const stats = employees.reduce(
    (accumulator, employee) => {
      const monthlyReadings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
        (reading) => monthKey(reading.date) === thisMonth && !reading.queued,
      );
      const mileage = Number(employee.mileage ?? config.defaultMileage);
      const summary = getMonthlySummary(monthlyReadings, thisMonth, mileage, config.fuelPrice);
      accumulator.totalKm += summary.totalKm;
      accumulator.totalFuel += summary.fuelUsed;
      accumulator.activeToday += monthlyReadings.some((reading) => reading.date === today()) ? 1 : 0;
      return accumulator;
    },
    { totalKm: 0, totalFuel: 0, activeToday: 0 },
  );

  return (
    <div className="space-y-4 p-5">
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Month Overview</div>
        <div className="font-display text-3xl leading-none text-white">
          {new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Active Riders" value={employees.length} unit="registered" icon={Users} accent="orange" />
        <StatCard label="Today" value={stats.activeToday} unit={`/ ${employees.length}`} icon={CheckCircle} accent="gold" />
        <StatCard label="Total KM" value={fmtNum(Math.round(stats.totalKm))} unit="km" icon={TrendingUp} accent="orange" />
        <StatCard label="Fuel Used" value={stats.totalFuel.toFixed(1)} unit="litres" icon={Fuel} accent="gold" />
      </div>

      <div className="border border-orange-500/30 bg-gradient-to-br from-orange-500/10 via-amber-500/5 to-transparent p-5">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-amber-500">Estimated Fuel Cost</div>
        <div className="font-display text-5xl text-orange-500">
          {config.currency} {fmtNum(Math.round(stats.totalFuel * Number(config.fuelPrice)))}
        </div>
        <div className="mt-1 font-mono text-[10px] text-zinc-500">
          @ {config.currency} {config.fuelPrice}/litre
        </div>
      </div>

      {employees.length > 0 ? (
        <button
          onClick={() => downloadCSV(buildFleetCSV(employees, readingsByEmployee, config, thisMonth), `fleet_${thisMonth}.csv`)}
          className="flex w-full items-center justify-center gap-2 border border-amber-400/50 bg-zinc-950 py-3 font-display tracking-widest text-amber-400 hover:bg-amber-400/10"
        >
          <FileDown className="h-4 w-4" /> EXPORT FLEET REPORT
        </button>
      ) : null}

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Riders</div>
        {employees.length === 0 ? (
          <div className="border border-dashed border-zinc-800 p-8 text-center text-zinc-500">No riders yet.</div>
        ) : (
          <div className="space-y-2">
            {employees.map((employee) => {
              const monthlyReadings = sortReadingsAsc(readingsByEmployee[employee.id] || []).filter(
                (reading) => monthKey(reading.date) === thisMonth && !reading.queued,
              );
              const mileage = Number(employee.mileage ?? config.defaultMileage);
              const summary = getMonthlySummary(monthlyReadings, thisMonth, mileage, config.fuelPrice);
              const distance = summary.totalKm;
              const didToday = monthlyReadings.some((reading) => reading.date === today());

              return (
                <button
                  key={employee.id}
                  onClick={() => onSelectEmployee(employee.id)}
                  className="flex w-full items-center gap-3 border border-zinc-800 bg-zinc-950 p-3 transition-colors hover:border-orange-500"
                >
                  <div className="relative flex h-11 w-11 items-center justify-center border border-orange-500/40 bg-gradient-to-br from-orange-500/20 to-amber-500/20">
                    <User className="h-5 w-5 text-orange-500" />
                    {didToday ? <div className="pulse-dot absolute -right-1 -top-1 h-3 w-3 rounded-full bg-green-500"></div> : null}
                  </div>
                  <div className="flex-1 text-left">
                    <div className="font-semibold text-white">{employee.name}</div>
                    <div className="font-mono text-[10px] text-zinc-500">
                      {employee.bikePlate} | {employee.bikeModel || 'bike'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-xl leading-none text-amber-400">{fmtNum(distance)}</div>
                    <div className="font-mono text-[10px] uppercase text-zinc-500">km this mo</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-zinc-600" />
                </button>
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
    <div className="p-5">
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
          className="glow-orange flex items-center gap-1.5 bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2.5 font-display tracking-widest text-black"
        >
          <UserPlus className="h-4 w-4" /> ADD
        </button>
      </div>

      {employees.length === 0 ? (
        <div className="border border-dashed border-zinc-800 p-10 text-center">
          <Users className="mx-auto mb-3 h-12 w-12 text-zinc-700" />
          <div className="mb-1 font-display text-2xl text-white">No Riders Yet</div>
          <div className="mb-4 text-sm text-zinc-500">Add your first rider to start tracking fuel usage.</div>
          <button
            onClick={() => {
              setEditing(null);
              setShowModal(true);
            }}
            className="bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-3 font-display tracking-widest text-black"
          >
            + ADD FIRST RIDER
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {employees.map((employee) => (
            <div key={employee.id} className="border border-zinc-800 bg-zinc-950 p-4">
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
                    className="flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-orange-500 hover:bg-orange-500/10"
                  >
                    <Edit2 className="h-4 w-4 text-orange-500" />
                  </button>
                  <button
                    onClick={() => onResetPin(employee)}
                    className="flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-amber-500 hover:bg-amber-500/10"
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
        <div className="border border-amber-500/30 bg-amber-500/10 p-4">
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
          className="w-full bg-gradient-to-r from-orange-500 to-amber-500 py-3 font-display tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'RESETTING...' : 'RESET PIN'}
        </button>
      </div>
    </Modal>
  );
};

const AdminSettings = ({ config, onSave }) => {
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
    <div className="space-y-4 p-5">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// System</div>
        <div className="font-display text-3xl leading-none text-white">Settings</div>
      </div>

      <div className="border border-zinc-800 bg-zinc-950 p-5">
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

      <div className="border border-[#25D366]/30 bg-zinc-950 p-5">
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

      <div className="border border-zinc-800 bg-zinc-950 p-5">
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
        className="glow-orange w-full bg-gradient-to-r from-orange-500 to-amber-500 py-3 font-display tracking-widest text-black"
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
    <div className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Access</div>
          <div className="font-display text-3xl leading-none text-white">Admins</div>
        </div>
        <button
          onClick={onRefresh}
          className="flex h-10 w-10 items-center justify-center border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-orange-500 hover:text-orange-500"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="border border-zinc-800 bg-zinc-950 p-5">
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
          className="glow-orange w-full bg-gradient-to-r from-orange-500 to-amber-500 py-3 font-display tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'SENDING INVITE...' : 'SEND INVITE'}
        </button>
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Current Admins</div>
        <div className="space-y-2">
          {admins.map((admin) => (
            <div key={admin.userId} className="border border-zinc-800 bg-zinc-950 p-4">
              <div className="font-semibold text-white">{admin.email}</div>
              <div className="mt-1 font-mono text-[10px] uppercase text-zinc-500">
                Added {fmtDate(admin.createdAt)}
              </div>
            </div>
          ))}
          {admins.length === 0 ? (
            <div className="border border-dashed border-zinc-800 p-6 text-center text-zinc-500">
              No admins loaded yet.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const AuditPanel = ({ auditRows, auditCount, page, pageSize, onPageChange, onRefresh }) => (
  <div className="space-y-4 p-5">
    <div className="flex items-center justify-between">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// History</div>
        <div className="font-display text-3xl leading-none text-white">Audit Log</div>
      </div>
      <button
        onClick={onRefresh}
        className="flex h-10 w-10 items-center justify-center border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-orange-500 hover:text-orange-500"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
    </div>

    <div className="space-y-2">
      {auditRows.map((row) => (
        <details key={row.id} className="border border-zinc-800 bg-zinc-950 p-4">
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
              <pre className="overflow-x-auto whitespace-pre-wrap border border-zinc-800 bg-black p-3 text-xs text-zinc-300">
                {JSON.stringify(row.before, null, 2) || 'null'}
              </pre>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">After</div>
              <pre className="overflow-x-auto whitespace-pre-wrap border border-zinc-800 bg-black p-3 text-xs text-zinc-300">
                {JSON.stringify(row.after, null, 2) || 'null'}
              </pre>
            </div>
          </div>
        </details>
      ))}
      {auditRows.length === 0 ? (
        <div className="border border-dashed border-zinc-800 p-8 text-center text-zinc-500">No audit rows found.</div>
      ) : null}
    </div>

    <div className="flex items-center justify-between border border-zinc-800 bg-zinc-950 p-3">
      <div className="font-mono text-[10px] uppercase text-zinc-500">
        Page {page + 1} | Showing {auditRows.length} of {auditCount}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className="border border-zinc-800 px-3 py-2 font-mono text-[10px] uppercase text-zinc-400 disabled:opacity-40"
        >
          Prev
        </button>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={(page + 1) * pageSize >= auditCount}
          className="border border-zinc-800 px-3 py-2 font-mono text-[10px] uppercase text-zinc-400 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  </div>
);

const EmployeeDetailView = ({
  employee,
  readings,
  config,
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
  const monthlySummary = getMonthlySummary(filtered, selectedMonth, mileage, config.fuelPrice);
  const distance = monthlySummary.totalKm;
  const fuelUsed = monthlySummary.fuelUsed;
  const cost = monthlySummary.cost;

  return (
    <div>
      <div className="border-b border-orange-500/20 bg-gradient-to-b from-orange-500/20 to-transparent p-5">
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
              className="flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-amber-500"
            >
              <KeyRound className="h-4 w-4 text-amber-400" />
            </button>
            <button
              onClick={() => setShowEdit(true)}
              className="flex h-9 w-9 items-center justify-center border border-zinc-800 bg-zinc-900 hover:border-orange-500"
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
                className={`whitespace-nowrap border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
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
          <StatCard label="Distance" value={fmtNum(Math.round(distance))} unit="km" icon={TrendingUp} accent="orange" />
          <StatCard label="Fuel" value={fuelUsed.toFixed(2)} unit="L" icon={Fuel} accent="gold" />
          <StatCard label="Cost" value={fmtNum(Math.round(cost))} unit={config.currency} icon={DollarSign} accent="orange" />
          <StatCard label="Readings" value={filtered.length} unit="entries" icon={CheckCircle} accent="gold" />
        </div>

        {readings.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => downloadCSV(buildEmployeeCSV(employee, { [employee.id]: readings }, config, selectedMonth), `${employee.username}_${selectedMonth}.csv`)}
              className="flex items-center justify-center gap-1.5 border border-amber-400/40 bg-zinc-950 py-2.5 font-display text-sm tracking-widest text-amber-400 hover:bg-amber-400/10"
            >
              <FileDown className="h-3.5 w-3.5" /> MONTH CSV
            </button>
            <button
              onClick={() => downloadCSV(buildEmployeeCSV(employee, { [employee.id]: readings }, config, null), `${employee.username}_all.csv`)}
              className="flex items-center justify-center gap-1.5 border border-orange-500/40 bg-zinc-950 py-2.5 font-display text-sm tracking-widest text-orange-500 hover:bg-orange-500/10"
            >
              <Upload className="h-3.5 w-3.5" /> ALL TIME
            </button>
          </div>
        ) : null}

        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Reading History</div>
          {filtered.length === 0 ? (
            <div className="border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No readings for this month.</div>
          ) : (
            <div className="space-y-1">
              {[...filtered].reverse().map((reading, index, list) => {
                const previous = list[index + 1];
                const diff = previous ? reading.km - previous.km : null;
                return (
                  <div key={reading.id} className="flex items-center gap-3 border border-zinc-800 bg-zinc-950 p-3">
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
                        className="font-mono text-[10px] uppercase tracking-widest text-orange-500 hover:text-amber-400"
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
                      className="font-mono text-[10px] uppercase tracking-widest text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
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
  failedCount,
  syncingCount,
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
    <div className="space-y-4 p-5">
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
              className={`border p-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
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

      <div className="border border-zinc-800 bg-zinc-950 p-4">
        <div className="mb-2 flex items-center gap-2">
          <SelectedTypeIcon className="h-4 w-4 text-orange-500" />
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500">
            Current step: {selectedTypeConfig.label}
          </div>
        </div>
        <div className="text-sm text-zinc-400">{selectedTypeConfig.helper}</div>
        {todaySummary.complete ? (
          <div className={`mt-3 border p-3 ${todaySummary.invalid ? 'border-red-500/30 bg-red-500/10' : 'border-green-500/30 bg-green-500/10'}`}>
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

      {queuedCount > 0 ? (
        <div className={`border p-4 ${failedCount > 0 ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
          <div className="mb-1 flex items-center gap-2">
            <CloudOff className={`h-4 w-4 ${failedCount > 0 ? 'text-red-300' : 'text-amber-400'}`} />
            <div className={`font-mono text-[10px] uppercase tracking-widest ${failedCount > 0 ? 'text-red-200' : 'text-amber-300'}`}>
              {failedCount > 0
                ? `${failedCount} failed | ${queuedCount - failedCount} waiting`
                : `${queuedCount} queued${syncingCount > 0 ? ` | ${syncingCount} syncing` : ' | will sync on reconnect'}`}
            </div>
          </div>
          <div className="text-xs text-zinc-400">Queued readings stay on this device until they upload successfully.</div>
          {failedCount > 0 ? (
            <button
              onClick={onRetrySync}
              className="mt-3 border border-red-400/50 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-red-200"
            >
              Retry sync
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="border-2 border-dashed border-zinc-800 bg-zinc-950 p-5">
        {!photoPreview ? (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="mb-3 flex h-16 w-16 items-center justify-center border border-orange-500/30 bg-orange-500/10">
              <Camera className="h-8 w-8 text-orange-500" />
            </div>
            <div className="font-display text-xl text-white">Photo Required</div>
            <div className="mb-4 mt-1 text-xs text-zinc-500">Every reading must include an odometer photo.</div>
            <button
              onClick={() => fileInput.current?.click()}
              className="glow-orange flex items-center gap-2 bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-3 font-display tracking-widest text-black"
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
            <img src={photoPreview} alt="Odometer preview" className="h-56 w-full border border-orange-500/30 object-cover" />
            <button
              onClick={() => {
                if (photoPreview) URL.revokeObjectURL(photoPreview);
                resetForm();
              }}
              className="mt-2 w-full py-2 font-mono text-xs uppercase tracking-widest text-zinc-500 hover:text-orange-500"
            >
              Retake photo
            </button>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// Enter Reading</div>
        <div className="border-2 border-zinc-800 bg-black p-4">
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
            <div className={`mt-3 border p-3 ${projectedRawDistance < 0 ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
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
        className="glow-orange w-full bg-gradient-to-r from-orange-500 to-amber-500 py-4 font-display text-xl tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40"
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
          className="flex w-full items-center justify-center gap-2 bg-[#25D366] py-3 font-display tracking-widest text-white transition-all hover:brightness-110"
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
  const cost = monthlySummary.cost;
  const todayFuel = mileage > 0 ? todaySummary.distance / mileage : 0;
  const todayCost = todayFuel * Number(config.fuelPrice);

  return (
    <div className="space-y-4 p-5">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500/70">
          // {new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
        </div>
        <div className="font-display text-3xl leading-none text-white">Your Stats</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Distance" value={fmtNum(Math.round(distance))} unit="km" icon={TrendingUp} accent="orange" />
        <StatCard label="Fuel Est." value={fuelUsed.toFixed(1)} unit="litres" icon={Fuel} accent="gold" />
      </div>

      <div className="border border-zinc-800 bg-zinc-950 p-5">
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

      <div className="border border-orange-500/30 bg-gradient-to-br from-orange-500/10 to-amber-500/5 p-5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-amber-500">Estimated Monthly Fuel Cost</div>
        <div className="mt-1 font-display text-4xl text-orange-500">
          {config.currency} {fmtNum(Math.round(cost))}
        </div>
        <div className="mt-1 font-mono text-[10px] text-zinc-500">
          @ {config.currency} {config.fuelPrice}/L | {mileage} km/L
        </div>
      </div>

      {readings.length > 0 ? (
        <button
          onClick={() => downloadCSV(buildEmployeeCSV(employee, { [employee.id]: readings }, config, thisMonth), `${employee.username}_${thisMonth}.csv`)}
          className="flex w-full items-center justify-center gap-2 border border-amber-400/40 bg-zinc-950 py-3 font-display tracking-widest text-amber-400 hover:bg-amber-400/5"
        >
          <FileDown className="h-4 w-4" /> EXPORT MY REPORT
        </button>
      ) : null}

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-amber-500/70">// All Readings</div>
        {readings.length === 0 ? (
          <div className="border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No readings yet. Submit your first one today.
          </div>
        ) : (
          <div className="space-y-1">
            {[...sortReadingsAsc(readings)].reverse().map((reading, index, list) => {
              const previous = list[index + 1];
              const diff = previous ? reading.km - previous.km : null;
              return (
                <div key={reading.id} className="flex items-center gap-3 border border-zinc-800 bg-zinc-950 p-3">
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
                      className="font-mono text-[10px] uppercase tracking-widest text-orange-500 hover:text-amber-400"
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
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(null);
  const [photoModal, setPhotoModal] = useState({ open: false, url: '', path: '' });
  const [resetPinEmployee, setResetPinEmployee] = useState(null);
  const [resetPinBusy, setResetPinBusy] = useState(false);
  const [toast, setToast] = useState(null);

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
      setConfig(DEFAULT_CONFIG);
      return undefined;
    }

    const unsubscribeEmployees = subscribeEmployees((rows) => setEmployees(rows));
    const unsubscribeReadings = subscribeReadings((rows) => setReadings(rows));
    const unsubscribeConfig = subscribeConfig((row) => setConfig(row));

    return () => {
      unsubscribeEmployees?.();
      unsubscribeReadings?.();
      unsubscribeConfig?.();
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

  const refreshAdmins = async () => {
    setAdmins(await listAdmins());
  };

  const refreshAudit = async (page = auditPage) => {
    const result = await listAuditLog({ page, pageSize: 20 });
    setAuditRows(result.rows);
    setAuditCount(result.count);
  };

  const compressPhoto = async (file) =>
    imageCompression(file, {
      maxSizeMB: 0.2,
      maxWidthOrHeight: 1600,
      useWebWorker: true,
      initialQuality: 0.8,
      fileType: 'image/jpeg',
    });

  const replayQueuedReading = async (item) => {
    if (item.op !== 'reading.create') return;
    const { payload } = item;
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
  };

  const flushQueuedReadings = async (includeFailed = false) => {
    if (!navigator.onLine || session?.role !== 'rider') return;
    await flushOutbox(replayQueuedReading, { includeFailed });
  };

  useEffect(() => {
    const tryFlush = async () => {
      try {
        await flushQueuedReadings(false);
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

  const queuedCount = riderQueuedReadings.length;
  const failedQueuedCount = riderQueuedReadings.filter((reading) => reading.outboxStatus === 'failed').length;
  const syncingQueuedCount = riderQueuedReadings.filter((reading) => reading.outboxStatus === 'syncing').length;

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
    await signOut();
    setSelectedEmployeeId(null);
    setAdminTab('overview');
    setRiderTab('today');
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
      await flushQueuedReadings(false);
      showToast('Reading submitted.', 'success');
    } catch (error) {
      if (isLikelyNetworkError(error)) {
        await enqueue({ id: readingId, op: 'reading.create', payload });
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
    return <SupabaseSetupView />;
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
                onSelectEmployee={setSelectedEmployeeId}
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
            {adminTab === 'settings' ? <AdminSettings config={config} onSave={handleSaveConfig} /> : null}
          </>
        )}

        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-orange-500/20 bg-black/95 backdrop-blur">
          <div className="grid grid-cols-5">
            {[
              { id: 'overview', label: 'Overview', icon: BarChart3 },
              { id: 'employees', label: 'Riders', icon: Users },
              { id: 'admins', label: 'Admins', icon: Shield },
              { id: 'audit', label: 'Audit', icon: History },
              { id: 'settings', label: 'Settings', icon: Settings },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setAdminTab(tab.id);
                  setSelectedEmployeeId(null);
                }}
                className={`relative flex flex-col items-center gap-0.5 py-3 transition-colors ${
                  adminTab === tab.id && !selectedEmployeeId ? 'text-orange-500' : 'text-zinc-500'
                }`}
              >
                <tab.icon className="h-5 w-5" />
                <div className="font-mono text-[9px] uppercase tracking-widest">{tab.label}</div>
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
          failedCount={failedQueuedCount}
          syncingCount={syncingQueuedCount}
          onRetrySync={() => flushQueuedReadings(true)}
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

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-orange-500/20 bg-black/95 backdrop-blur">
        <div className="grid grid-cols-2">
          {[
            { id: 'today', label: 'Submit', icon: Camera },
            { id: 'history', label: 'Stats', icon: TrendingUp },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setRiderTab(tab.id)}
              className={`relative flex flex-col items-center gap-0.5 py-3 transition-colors ${
                riderTab === tab.id ? 'text-orange-500' : 'text-zinc-500'
              }`}
            >
              <tab.icon className="h-5 w-5" />
              <div className="font-mono text-[9px] uppercase tracking-widest">{tab.label}</div>
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
