import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { signHs256 } from '../_shared/jwt.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const jwtSecret = Deno.env.get('JWT_SECRET') ?? '';
const lockWindowMinutes = 15;
const maxFailedAttempts = 5;

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function genericLoginError(status = 401) {
  return json({ error: 'Invalid username or PIN.' }, status);
}

function getClientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (
    forwarded ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getRecentAttempts(username: string, ipHash: string) {
  const cutoff = new Date(Date.now() - lockWindowMinutes * 60 * 1000).toISOString();
  const { data, error } = await service
    .from('rider_login_attempts')
    .select('success, locked_until, created_at')
    .eq('username', username)
    .eq('ip_hash', ipHash)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[rider-login] failed to read login attempts', error);
    throw new Error('rate-limit-check-failed');
  }

  return data ?? [];
}

async function recordAttempt(username: string, ipHash: string, success: boolean, lockedUntil: string | null = null) {
  const { error } = await service.from('rider_login_attempts').insert({
    username,
    ip_hash: ipHash,
    success,
    locked_until: lockedUntil,
  });

  if (error) {
    console.error('[rider-login] failed to record login attempt', error);
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!jwtSecret) {
    console.error('[rider-login] JWT_SECRET is not configured');
    return json({ error: 'Rider login is not configured yet.' }, 500);
  }

  try {
    const { username, pin } = await request.json();
    const normalizedUsername = String(username ?? '').trim().toLowerCase();
    const normalizedPin = String(pin ?? '').trim();

    if (!normalizedUsername || !/^\d{4}$/.test(normalizedPin)) {
      return genericLoginError();
    }

    const ipHash = await sha256(`${normalizedUsername}:${getClientIp(request)}`);
    const attempts = await getRecentAttempts(normalizedUsername, ipHash);
    const now = Date.now();
    const activeLock = attempts.find((attempt) => attempt.locked_until && Date.parse(attempt.locked_until) > now);

    if (activeLock) {
      return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    }

    const failedAttempts = attempts.filter((attempt) => !attempt.success).length;
    if (failedAttempts >= maxFailedAttempts) {
      const lockedUntil = new Date(now + lockWindowMinutes * 60 * 1000).toISOString();
      await recordAttempt(normalizedUsername, ipHash, false, lockedUntil);
      return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    }

    const { data, error } = await service.rpc('verify_rider_pin', {
      username_input: normalizedUsername,
      pin_input: normalizedPin,
    });

    if (error) {
      console.error('[rider-login] verify_rider_pin failed', error);
      return json({ error: 'Unable to verify rider credentials.' }, 500);
    }

    const employee = Array.isArray(data) ? data[0] : data;
    if (!employee?.id) {
      const lockedUntil =
        failedAttempts + 1 >= maxFailedAttempts
          ? new Date(now + lockWindowMinutes * 60 * 1000).toISOString()
          : null;
      await recordAttempt(normalizedUsername, ipHash, false, lockedUntil);
      return lockedUntil ? json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429) : genericLoginError();
    }

    await recordAttempt(normalizedUsername, ipHash, true);

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresIn = 60 * 60 * 24 * 30;
    const accessToken = await signHs256(
      {
        aud: 'authenticated',
        sub: employee.id,
        role: 'rider',
        employee_id: employee.id,
        user_type: 'rider',
        iat: issuedAt,
        exp: issuedAt + expiresIn,
      },
      jwtSecret,
    );

    return json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      employee: {
        id: employee.id,
        name: employee.name,
        username: employee.username,
        phone: employee.phone,
        bikePlate: employee.bike_plate,
        bikeModel: employee.bike_model,
        mileage: employee.mileage,
      },
    });
  } catch (error) {
    console.error('[rider-login] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
