import { loadConfig } from '../config';
import { index } from '../telegram/index';

export const AVAILABLE_PERMISSIONS = [
  'upload_resources',
  'delete_resources',
  'manage_folders',
  'manage_users',
  'view_audit_logs',
] as const;

export type AdminPermission = (typeof AVAILABLE_PERMISSIONS)[number];

const config = loadConfig();

export function hasPermission(telegramId: number, permission: AdminPermission): boolean {
  if (telegramId === config.ownerId) return true;

  const user = index.getUserByTelegramId(telegramId);
  return (
    user?.role === 'admin' &&
    user.status === 'active' &&
    Array.isArray(user.permissions) &&
    user.permissions.includes(permission)
  );
}
