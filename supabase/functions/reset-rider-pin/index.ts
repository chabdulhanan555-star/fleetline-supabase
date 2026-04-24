import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdminCaller, safeEmployee } from '../_shared/admin.ts';
import { corsHeaders, json } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

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
    const caller = await getAdminCaller(request, service);
    if (caller.error) {
      return json({ error: caller.error.message }, caller.error.status);
    }

    const { employee_id: employeeId, new_pin: newPin } = await request.json();
    const normalizedPin = String(newPin ?? '').trim();

    if (!employeeId || !/^\d{4}$/.test(normalizedPin)) {
      return json({ error: 'employee_id and a 4-digit new_pin are required.' }, 400);
    }

    const { data: employeeBefore, error: employeeError } = await service
      .from('employees')
      .select('id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at')
      .eq('id', employeeId)
      .maybeSingle();

    if (employeeError) {
      console.error('[reset-rider-pin] employee lookup failed', employeeError);
      return json({ error: 'Failed to load employee.' }, 500);
    }

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

    const { data: employeeAfter, error: updateError } = await service
      .from('employees')
      .update({ pin_hash: pinHash })
      .eq('id', employeeId)
      .select('id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at')
      .single();

    if (updateError) {
      console.error('[reset-rider-pin] employee update failed', updateError);
      return json({ error: 'Failed to update rider PIN.' }, 500);
    }

    await service.from('audit_log').insert({
      actor_id: caller.user.id,
      action: 'employee.pin_reset',
      entity_type: 'employee',
      entity_id: employeeId,
      before: safeEmployee(employeeBefore),
      after: {
        ...safeEmployee(employeeAfter),
        pin_reset: true,
      },
    });

    return json({ ok: true });
  } catch (error) {
    console.error('[reset-rider-pin] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
