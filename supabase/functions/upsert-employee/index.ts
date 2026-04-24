import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdminCaller, safeEmployee } from '../_shared/admin.ts';
import { corsHeaders, json } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function normalizeEmployee(input: any) {
  const username = String(input?.username ?? '').trim().toLowerCase();
  const mileage = input?.mileage === '' || input?.mileage === null || input?.mileage === undefined
    ? null
    : Number(input.mileage);

  return {
    id: input?.id ? String(input.id) : null,
    name: String(input?.name ?? '').trim(),
    username,
    phone: String(input?.phone ?? '').trim() || null,
    bike_plate: String(input?.bikePlate ?? input?.bike_plate ?? '').trim().toUpperCase(),
    bike_model: String(input?.bikeModel ?? input?.bike_model ?? '').trim() || null,
    mileage: Number.isFinite(mileage) ? mileage : null,
    active: input?.active !== false,
  };
}

function validateEmployee(employee: ReturnType<typeof normalizeEmployee>) {
  if (!employee.name || !employee.username || !employee.bike_plate) {
    return 'Name, username, and bike plate are required.';
  }

  if (!/^[a-z0-9._-]{2,32}$/.test(employee.username)) {
    return 'Username must be 2-32 characters using letters, numbers, dots, dashes, or underscores.';
  }

  if (employee.mileage !== null && (employee.mileage <= 0 || employee.mileage > 999)) {
    return 'Mileage must be a positive km/L value.';
  }

  return null;
}

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

    const body = await request.json();
    const employee = normalizeEmployee(body.employee ?? body);
    const isNew = Boolean(body.is_new ?? body.isNew ?? !employee.id);
    const pin = String(body.pin ?? '').trim();
    const validationError = validateEmployee(employee);

    if (validationError) {
      return json({ error: validationError }, 400);
    }

    if (isNew && !/^\d{4}$/.test(pin)) {
      return json({ error: 'A 4-digit PIN is required for new riders.' }, 400);
    }

    if (!isNew && !employee.id) {
      return json({ error: 'Employee id is required for updates.' }, 400);
    }

    if (isNew) {
      const { data: pinHash, error: hashError } = await service.rpc('hash_rider_pin', {
        pin_input: pin,
      });

      if (hashError || !pinHash) {
        console.error('[upsert-employee] hash_rider_pin failed', hashError);
        return json({ error: 'Failed to hash rider PIN.' }, 500);
      }

      const { data, error } = await service
        .from('employees')
        .insert({
          name: employee.name,
          username: employee.username,
          phone: employee.phone,
          bike_plate: employee.bike_plate,
          bike_model: employee.bike_model,
          mileage: employee.mileage,
          active: employee.active,
          pin_hash: pinHash,
        })
        .select('id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at')
        .single();

      if (error) {
        console.error('[upsert-employee] insert failed', error);
        return json({ error: error.message }, 400);
      }

      await service.from('audit_log').insert({
        actor_id: caller.user.id,
        action: 'employee.create',
        entity_type: 'employee',
        entity_id: data.id,
        before: null,
        after: safeEmployee(data),
      });

      return json({ ok: true, employee: data });
    }

    const { data: before, error: beforeError } = await service
      .from('employees')
      .select('id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at')
      .eq('id', employee.id)
      .maybeSingle();

    if (beforeError) {
      console.error('[upsert-employee] lookup failed', beforeError);
      return json({ error: 'Failed to load rider.' }, 500);
    }

    if (!before) {
      return json({ error: 'Employee not found.' }, 404);
    }

    const { data, error } = await service
      .from('employees')
      .update({
        name: employee.name,
        username: employee.username,
        phone: employee.phone,
        bike_plate: employee.bike_plate,
        bike_model: employee.bike_model,
        mileage: employee.mileage,
        active: employee.active,
      })
      .eq('id', employee.id)
      .select('id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at')
      .single();

    if (error) {
      console.error('[upsert-employee] update failed', error);
      return json({ error: error.message }, 400);
    }

    await service.from('audit_log').insert({
      actor_id: caller.user.id,
      action: 'employee.update',
      entity_type: 'employee',
      entity_id: data.id,
      before: safeEmployee(before),
      after: safeEmployee(data),
    });

    return json({ ok: true, employee: data });
  } catch (error) {
    console.error('[upsert-employee] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
