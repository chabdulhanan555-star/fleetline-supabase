import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { readBearerToken, verifyHs256 } from '../_shared/jwt.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const jwtSecret = Deno.env.get('JWT_SECRET') ?? '';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function isUuid(value: unknown) {
  return typeof value === 'string' && uuidPattern.test(value);
}

function legacyIdToUuid(scope: string, value?: string | null) {
  const text = `${scope}:${String(value || scope)}`;
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  let h3 = 0xc0decafe ^ text.length;
  let h4 = 0x12345678 ^ text.length;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
    h3 = Math.imul(h3 ^ code, 2246822507);
    h4 = Math.imul(h4 ^ code, 3266489909);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909);
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const bytes = [h1, h2, h3, h4].flatMap((value32) => [
    (value32 >>> 24) & 0xff,
    (value32 >>> 16) & 0xff,
    (value32 >>> 8) & 0xff,
    value32 & 0xff,
  ]);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toSupabaseUuid(value: string | null | undefined, scope: string) {
  return isUuid(value) ? String(value).toLowerCase() : legacyIdToUuid(scope, value);
}

function dateFromTimestamp(value?: string | null) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

async function ensureRouteSession(body: any, employeeId: string, date: string) {
  const routeSessionId = toSupabaseUuid(body.tripId, 'route_session');

  const byId = await service
    .from('route_sessions')
    .select('id')
    .eq('id', routeSessionId)
    .maybeSingle();

  if (byId.error) throw byId.error;
  if (byId.data?.id) return byId.data.id as string;

  const byDay = await service
    .from('route_sessions')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('date', date)
    .maybeSingle();

  if (byDay.error) throw byDay.error;
  if (byDay.data?.id) return byDay.data.id as string;

  const insert = await service.from('route_sessions').insert({
    id: routeSessionId,
    employee_id: employeeId,
    date,
    status: 'active',
    started_at: body.startedAt ?? body.point?.timestamp ?? new Date().toISOString(),
  });

  if (insert.error && insert.error.code !== '23505') throw insert.error;

  return routeSessionId;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!jwtSecret) {
      return json({ error: 'Live location service is not configured.' }, 500);
    }

    const token = readBearerToken(request.headers.get('authorization'));
    if (!token) {
      return json({ error: 'Missing rider token.' }, 401);
    }

    const claims = await verifyHs256(token, jwtSecret) as Record<string, unknown>;
    const employeeId = typeof claims.employee_id === 'string' ? claims.employee_id : typeof claims.sub === 'string' ? claims.sub : '';
    if (!isUuid(employeeId)) {
      return json({ error: 'Invalid rider token.' }, 401);
    }

    const body = await request.json();
    const point = body?.point ?? {};
    const lat = Number(point.latitude);
    const lng = Number(point.longitude);
    const recordedAt = typeof point.timestamp === 'string' ? point.timestamp : new Date().toISOString();
    const date = typeof body?.date === 'string' ? body.date : dateFromTimestamp(recordedAt);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return json({ error: 'Invalid GPS coordinates.' }, 400);
    }

    const employee = await service
      .from('employees')
      .select('id, active')
      .eq('id', employeeId.toLowerCase())
      .maybeSingle();

    if (employee.error) throw employee.error;
    if (!employee.data?.active) {
      return json({ error: 'Rider is not active.' }, 403);
    }

    const routeSessionId = await ensureRouteSession(body, employeeId.toLowerCase(), date);

    const live = await service.from('live_rider_locations').upsert(
      {
        employee_id: employeeId.toLowerCase(),
        route_session_id: routeSessionId,
        date,
        status: 'active',
        lat,
        lng,
        accuracy_m: point.accuracy ?? null,
        speed_mps: point.speed ?? null,
        heading: point.heading ?? null,
        recorded_at: recordedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'employee_id' },
    );

    if (live.error) throw live.error;

    if (body.tripId && point.id) {
      const pointInsert = await service.from('route_points').insert({
        id: toSupabaseUuid(point.id, 'route_point'),
        session_id: routeSessionId,
        employee_id: employeeId.toLowerCase(),
        recorded_at: recordedAt,
        lat,
        lng,
        accuracy_m: point.accuracy ?? null,
        speed_mps: point.speed ?? null,
        heading: point.heading ?? null,
      });

      if (pointInsert.error && pointInsert.error.code !== '23505') throw pointInsert.error;
    }

    return json({ ok: true, route_session_id: routeSessionId, recorded_at: recordedAt });
  } catch (error) {
    console.error('[rider-live-location] failed', error);
    return json({ error: error instanceof Error ? error.message : 'Live location update failed.' }, 500);
  }
});
