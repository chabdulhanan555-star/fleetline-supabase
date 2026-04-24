import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getAdminCaller } from '../_shared/admin.ts';
import { corsHeaders, json } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function safeRedirect(value: unknown) {
  if (!value) return undefined;

  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
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

    const { email, redirectTo } = await request.json();
    const normalizedEmail = String(email ?? '').trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return json({ error: 'A valid email address is required.' }, 400);
    }

    const redirect = safeRedirect(redirectTo);
    const inviteResponse = await service.auth.admin.inviteUserByEmail(
      normalizedEmail,
      redirect ? { redirectTo: redirect } : undefined,
    );

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
      .upsert(
        { user_id: invitedUserId, email: normalizedEmail, invited_by: caller.user.id },
        { onConflict: 'user_id' },
      );

    if (adminInsertError) {
      console.error('[invite-admin] admins upsert failed', adminInsertError);
      return json({ error: 'Failed to record invited admin.' }, 500);
    }

    await service.from('audit_log').insert({
      actor_id: caller.user.id,
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
