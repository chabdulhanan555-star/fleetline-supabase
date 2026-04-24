import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { readBearerToken, verifyHs256 } from '../_shared/jwt.ts';

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
    const token = readBearerToken(request.headers.get('Authorization'));
    if (!token) {
      return json({ error: 'Missing bearer token.' }, 401);
    }

    const claims = await verifyHs256(token, jwtSecret);
    const callerId = String(claims.sub ?? '');

    const { data: adminRow } = await service
      .from('admins')
      .select('user_id')
      .eq('user_id', callerId)
      .maybeSingle();

    if (!adminRow) {
      return json({ error: 'Admin access required.' }, 403);
    }

    const { employee_id: employeeId, new_pin: newPin } = await request.json();
    const normalizedPin = String(newPin ?? '').trim();

    if (!employeeId || !/^\d{4}$/.test(normalizedPin)) {
      return json({ error: 'employee_id and a 4-digit new_pin are required.' }, 400);
    }

    const { data: employeeBefore } = await service
      .from('employees')
      .select('id, name, username')
      .eq('id', employeeId)
      .maybeSingle();

    if (!employeeBefore) {
      return json({ error: 'Employee not found.' }, 404);
    }

    const { data: pinHash, error: hashError } = await service.rpc('hash_rider_pin', {
      pin_input: normalizedPin,
    });

    if (hashError || !pinHash) {
      console.error('[reset-rider-pin] hash_rider_pin failed', hashError);
      return json({ error: 'Failed to hash PIN.' }, 500);
    }

    const { error: updateError } = await service
      .from('employees')
      .update({ pin_hash: pinHash })
      .eq('id', employeeId);

    if (updateError) {
      console.error('[reset-rider-pin] employee update failed', updateError);
      return json({ error: 'Failed to update rider PIN.' }, 500);
    }

    await service.from('audit_log').insert({
      actor_id: callerId,
      action: 'employee.pin_reset',
      entity_type: 'employee',
      entity_id: employeeId,
      before: employeeBefore,
      after: {
        ...employeeBefore,
        pin_reset: true,
      },
    });

    return json({ ok: true });
  } catch (error) {
    console.error('[reset-rider-pin] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
