import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { readBearerToken } from '../_shared/jwt.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const cleanupToken = Deno.env.get('CLEANUP_TOKEN') ?? '';
const serviceActorId = '00000000-0000-0000-0000-000000000000';

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

  const token = readBearerToken(request.headers.get('Authorization'));
  if (!token || token !== cleanupToken) {
    return json({ error: 'Unauthorized.' }, 401);
  }

  try {
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: staleReadings, error } = await service
      .from('readings')
      .select('id, photo_path')
      .lte('date', cutoff)
      .not('photo_path', 'is', null);

    if (error) {
      console.error('[cleanup-old-photos] fetch failed', error);
      return json({ error: 'Failed to fetch stale readings.' }, 500);
    }

    const readingRows = staleReadings ?? [];
    const paths = readingRows.map((row) => row.photo_path).filter(Boolean);
    const ids = readingRows.map((row) => row.id);

    for (const pathChunk of chunk(paths, 100)) {
      const { error: removeError } = await service.storage.from('odometer-photos').remove(pathChunk);
      if (removeError) {
        console.error('[cleanup-old-photos] storage remove failed', removeError);
        return json({ error: 'Failed to remove one or more stale photos.' }, 500);
      }
    }

    if (ids.length > 0) {
      const { error: updateError } = await service
        .from('readings')
        .update({ photo_path: null })
        .in('id', ids);

      if (updateError) {
        console.error('[cleanup-old-photos] row update failed', updateError);
        return json({ error: 'Failed to clear stale photo paths.' }, 500);
      }
    }

    await service.from('audit_log').insert({
      actor_id: serviceActorId,
      action: 'storage.cleanup_old_photos',
      entity_type: 'storage',
      entity_id: 'odometer-photos',
      after: {
        cutoff,
        deleted_count: paths.length,
      },
    });

    return json({
      ok: true,
      deleted_count: paths.length,
      updated_rows: ids.length,
      cutoff,
    });
  } catch (error) {
    console.error('[cleanup-old-photos] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
