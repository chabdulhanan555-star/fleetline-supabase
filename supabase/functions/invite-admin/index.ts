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

    const { email, redirectTo } = await request.json();
    const normalizedEmail = String(email ?? '').trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return json({ error: 'A valid email address is required.' }, 400);
    }

    const inviteResponse = await service.auth.admin.inviteUserByEmail(normalizedEmail, redirectTo ? { redirectTo } : undefined);
    if (inviteResponse.error) {
      console.error('[invite-admin] inviteUserByEmail failed', inviteResponse.error);
      return json({ error: inviteResponse.error.message }, 400);
    }

    const invitedUserId = inviteResponse.data.user?.id;
    if (!invitedUserId) {
      return json({ error: 'Invite succeeded but user id was not returned.' }, 500);
    }

    const { error: adminInsertError } = await service
      .from('admins')
      .upsert({ user_id: invitedUserId, email: normalizedEmail, invited_by: callerId }, { onConflict: 'user_id' });

    if (adminInsertError) {
      console.error('[invite-admin] admins upsert failed', adminInsertError);
      return json({ error: 'Failed to record invited admin.' }, 500);
    }

    await service.from('audit_log').insert({
      actor_id: callerId,
      action: 'admin.invite',
      entity_type: 'admin',
      entity_id: invitedUserId,
      after: {
        email: normalizedEmail,
      },
    });

    return json({
      ok: true,
      admin: {
        user_id: invitedUserId,
        email: normalizedEmail,
      },
    });
  } catch (error) {
    console.error('[invite-admin] unexpected error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
