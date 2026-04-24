import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { signHs256 } from '../_shared/jwt.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const jwtSecret = Deno.env.get('JWT_SECRET') ?? '';

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { username, pin } = await request.json();
    const normalizedUsername = String(username ?? '').trim().toLowerCase();
    const normalizedPin = String(pin ?? '').trim();

    if (!normalizedUsername || !/^\d{4}$/.test(normalizedPin)) {
      return json({ error: 'Username and a 4-digit PIN are required.' }, 400);
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
      return json({ error: 'Invalid username or PIN.' }, 401);
    }

    const now = Math.floor(Date.now() / 1000);
    const accessToken = await signHs256(
      {
        aud: 'authenticated',
        sub: employee.id,
        role: 'rider',
        employee_id: employee.id,
        user_type: 'rider',
        iat: now,
        exp: now + 60 * 60 * 24 * 30,
      },
      jwtSecret,
    );

    return json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 60 * 60 * 24 * 30,
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
