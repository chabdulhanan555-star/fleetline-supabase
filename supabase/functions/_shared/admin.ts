import { readBearerToken } from './jwt.ts';

export async function getAdminCaller(request: Request, service: any) {
  const token = readBearerToken(request.headers.get('Authorization'));
  if (!token) {
    return { error: { status: 401, message: 'Missing bearer token.' } };
  }

  const { data: userData, error: userError } = await service.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user?.id) {
    return { error: { status: 401, message: 'Invalid admin session.' } };
  }

  const { data: adminRow, error: adminError } = await service
    .from('admins')
    .select('user_id, email')
    .eq('user_id', user.id)
    .maybeSingle();

  if (adminError) {
    console.error('[admin-auth] admin lookup failed', adminError);
    return { error: { status: 500, message: 'Unable to verify admin access.' } };
  }

  if (!adminRow) {
    return { error: { status: 403, message: 'Admin access required.' } };
  }

  return { token, user, admin: adminRow };
}

export function safeEmployee(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    phone: row.phone,
    bike_plate: row.bike_plate,
    bike_model: row.bike_model,
    mileage: row.mileage,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
