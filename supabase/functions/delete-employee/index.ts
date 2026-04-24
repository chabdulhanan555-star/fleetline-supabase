import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdminCaller, safeEmployee } from '../_shared/admin.ts';
import { corsHeaders, json } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function chunk<T>(input: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < input.length; index += size) {
    chunks.push(input.slice(index, index + size));
  }
  return chunks;
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

    const { employee_id: employeeId } = await request.json();
    if (!employeeId) {
      return json({ error: 'employee_id is required.' }, 400);
    }

    const { data: employee, error: employeeError } = await service
      .from('employees')
      .select('id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at')
      .eq('id', employeeId)
      .maybeSingle();

    if (employeeError) {
      console.error('[delete-employee] employee lookup failed', employeeError);
      return json({ error: 'Failed to load rider.' }, 500);
    }

    if (!employee) {
      return json({ error: 'Employee not found.' }, 404);
    }

    const { data: readings, error: readingsError } = await service
      .from('readings')
      .select('photo_path')
      .eq('employee_id', employeeId)
      .not('photo_path', 'is', null);

    if (readingsError) {
      console.error('[delete-employee] readings lookup failed', readingsError);
      return json({ error: 'Failed to load rider photos.' }, 500);
    }

    const photoPaths = (readings ?? []).map((reading) => reading.photo_path).filter(Boolean);
    for (const pathChunk of chunk(photoPaths, 100)) {
      const { error } = await service.storage.from('odometer-photos').remove(pathChunk);
      if (error) {
        console.error('[delete-employee] storage remove failed', error);
        return json({ error: 'Failed to remove rider photos.' }, 500);
      }
    }

    const { error: deleteError } = await service.from('employees').delete().eq('id', employeeId);
    if (deleteError) {
      console.error('[delete-employee] employee delete failed', deleteError);
      return json({ error: 'Failed to delete rider.' }, 500);
    }

    await service.from('audit_log').insert({
      actor_id: caller.user.id,
      action: 'employee.delete',
      entity_type: 'employee',
      entity_id: employeeId,
      before: safeEmployee(employee),
      after: {
        deleted: true,
        removed_photo_count: photoPaths.length,
      },
    });

    return json({ ok: true, removed_photo_count: photoPaths.length });
  } catch (error) {
    console.error('[delete-employee] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
