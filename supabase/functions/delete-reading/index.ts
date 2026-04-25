import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdminCaller } from '../_shared/admin.ts';
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

    const { reading_id: readingId } = await request.json();
    if (!readingId) {
      return json({ error: 'reading_id is required.' }, 400);
    }

    const { data: reading, error: readingError } = await service
      .from('readings')
      .select('id, employee_id, date, km, reading_type, photo_path, submitted_at, submitted_by')
      .eq('id', readingId)
      .maybeSingle();

    if (readingError) {
      console.error('[delete-reading] reading lookup failed', readingError);
      return json({ error: 'Failed to load reading.' }, 500);
    }

    if (!reading) {
      return json({ error: 'Reading not found.' }, 404);
    }

    if (reading.photo_path) {
      const { error: removeError } = await service.storage.from('odometer-photos').remove([reading.photo_path]);
      if (removeError) {
        console.error('[delete-reading] storage remove failed', removeError);
        return json({ error: 'Failed to remove reading photo.' }, 500);
      }
    }

    const { error: deleteError } = await service.from('readings').delete().eq('id', readingId);
    if (deleteError) {
      console.error('[delete-reading] row delete failed', deleteError);
      return json({ error: 'Failed to delete reading.' }, 500);
    }

    await service.from('audit_log').insert({
      actor_id: caller.user.id,
      action: 'reading.delete',
      entity_type: 'reading',
      entity_id: readingId,
      before: reading,
      after: {
        deleted: true,
        removed_photo: Boolean(reading.photo_path),
      },
    });

    return json({ ok: true, removed_photo: Boolean(reading.photo_path) });
  } catch (error) {
    console.error('[delete-reading] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
