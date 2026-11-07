/**
 * User management service.
 * Handles user lifecycle: access requests, approvals, registration, roles.
 */

import crypto from 'crypto';
import { UserEntity, AuditEntity, generateEntityId, UserRole } from '../models';
import { index } from '../telegram/index';
import { loadConfig } from '../config';
import logger from '../logger';
import { NotFoundError, ForbiddenError } from '../errors';
import { AVAILABLE_PERMISSIONS } from './permissions';

const config = loadConfig();
const accessRequestLocks = new Map<number, Promise<void>>();

/**
 * Create a new user record or update existing one.
 */
export async function createUser(
  telegramId: number,
  username: string | null,
  firstName: string | null,
  lastName: string | null,
): Promise<UserEntity> {
  const existing = index.getUserByTelegramId(telegramId);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const user: UserEntity = {
    type: 'user',
    id: generateEntityId('user', telegramId) as `user:${number}`,
    telegramId,
    username,
    firstName,
    lastName,
    role: 'pending',
    status: 'inactive',
    permissions: [],
    favorites: [],
    createdAt: now,
    updatedAt: now,
  };

  await index.saveEntity(user);
  logger.info({ userId: user.id, msg: 'User created' });
  return user;
}

/**
 * Request access — transition user to pending status.
 */
export async function requestAccess(
  telegramId: number,
  username: string | null,
  firstName: string | null,
  lastName: string | null,
): Promise<{ user: UserEntity; created: boolean }> {
  const previous = accessRequestLocks.get(telegramId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  accessRequestLocks.set(telegramId, current);
  await previous;

  try {
    let user = index.getUserByTelegramId(telegramId);

    if (!user) {
      user = await createUser(telegramId, username, firstName, lastName);
      await logAudit(telegramId, 'user.access_requested', user.id, {});
      logger.info({ userId: user.id, msg: 'Access requested' });
      return { user, created: true };
    }

    if (user.role === 'pending') {
      return { user, created: false };
    }

    if (user.role === 'user' || user.role === 'admin' || user.role === 'owner') {
      return { user, created: false };
    }

    if (user.role === 'blocked' || user.role === 'suspended') {
      throw new ForbiddenError('Blocked or suspended users cannot request access');
    }

    const updated: UserEntity = {
      ...user,
      username,
      firstName,
      lastName,
      role: 'pending',
      status: 'inactive',
      updatedAt: new Date().toISOString(),
    };

    await index.updateEntity(updated);
    await logAudit(telegramId, 'user.access_requested', updated.id, {
      previousRole: user.role,
    });

    logger.info({ userId: updated.id, msg: 'Access requested' });
    return { user: updated, created: true };
  } finally {
    release();
    if (accessRequestLocks.get(telegramId) === current) {
      accessRequestLocks.delete(telegramId);
    }
  }
}

/**
 * Approve a user's access request.
 */
export async function approveUser(telegramId: number, actorId: number): Promise<UserEntity> {
  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  if (user.role !== 'pending' && user.role !== 'rejected') {
    throw new ForbiddenError(`User cannot be approved from current role: ${user.role}`);
  }

  const updated: UserEntity = {
    ...user,
    role: 'user',
    status: 'active',
    permissions: [],
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  await logAudit(actorId, 'user.approved', updated.id, { previousRole: user.role });

  logger.info({ userId: updated.id, actorId, msg: 'User approved' });
  return updated;
}

/**
 * Reject a user's access request.
 */
export async function rejectUser(telegramId: number, actorId: number): Promise<UserEntity> {
  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  if (user.role !== 'pending') {
    throw new ForbiddenError(`User is not pending (current role: ${user.role})`);
  }

  const updated: UserEntity = {
    ...user,
    role: 'rejected',
    status: 'inactive',
    permissions: [],
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  await logAudit(actorId, 'user.rejected', updated.id, { previousRole: user.role });

  logger.info({ userId: updated.id, actorId, msg: 'User rejected' });
  return updated;
}

/**
 * Promote a user to a higher role.
 */
export async function promoteUser(
  telegramId: number,
  newRole: UserRole,
  actorId: number,
): Promise<UserEntity> {
  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  if (newRole !== 'admin') {
    throw new ForbiddenError('Promotion is only available for assigning the admin role');
  }
  if (actorId !== config.ownerId) {
    throw new ForbiddenError('Only the owner can assign the admin role');
  }
  if (user.role !== 'user' || user.status !== 'active') {
    throw new ForbiddenError('Only active users can be promoted to admin');
  }

  // Role hierarchy check
  const hierarchy: Record<UserRole, number> = {
    blocked: 0,
    suspended: 1,
    rejected: 2,
    pending: 3,
    user: 4,
    admin: 5,
    owner: 6,
  };

  if (hierarchy[newRole] <= hierarchy[user.role]) {
    throw new ForbiddenError(`Cannot promote from ${user.role} to ${newRole}`);
  }

  const updated: UserEntity = {
    ...user,
    role: newRole,
    status: 'active',
    permissions: [],
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  await logAudit(actorId, 'user.promoted', updated.id, {
    previousRole: user.role,
    newRole,
  });

  logger.info({ userId: updated.id, actorId, newRole, msg: 'User promoted' });
  return updated;
}

/**
 * Demote a user to a lower role.
 */
export async function demoteUser(
  telegramId: number,
  newRole: UserRole,
  actorId: number,
): Promise<UserEntity> {
  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  if (newRole !== 'user' && newRole !== 'suspended' && newRole !== 'blocked') {
    throw new ForbiddenError('Invalid user role transition');
  }

  // Cannot demote owner
  if (user.telegramId === config.ownerId) {
    throw new ForbiddenError('Cannot demote the owner');
  }
  if (actorId !== config.ownerId) {
    throw new ForbiddenError('Only the owner can demote users');
  }

  const hierarchy: Record<UserRole, number> = {
    blocked: 0,
    suspended: 1,
    rejected: 2,
    pending: 3,
    user: 4,
    admin: 5,
    owner: 6,
  };

  if (hierarchy[newRole] >= hierarchy[user.role]) {
    throw new ForbiddenError(`Cannot demote from ${user.role} to ${newRole}`);
  }

  const updated: UserEntity = {
    ...user,
    role: newRole,
    status: newRole === 'suspended' ? 'suspended' : newRole === 'blocked' ? 'blocked' : 'active',
    permissions: [],
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  await logAudit(actorId, 'user.demoted', updated.id, {
    previousRole: user.role,
    newRole,
  });

  logger.info({ userId: updated.id, actorId, newRole, msg: 'User demoted' });
  return updated;
}

/**
 * Suspend a user.
 */
export async function suspendUser(telegramId: number, actorId: number): Promise<UserEntity> {
  if (actorId !== config.ownerId) {
    throw new ForbiddenError('Only the owner can suspend users');
  }
  return demoteUser(telegramId, 'suspended', actorId);
}

/**
 * Block a user.
 */
export async function blockUser(telegramId: number, actorId: number): Promise<UserEntity> {
  if (actorId !== config.ownerId) {
    throw new ForbiddenError('Only the owner can block users');
  }
  return demoteUser(telegramId, 'blocked', actorId);
}

/**
 * Unblock/reactivate a user — restore them to their previous active role.
 */
export async function unblockUser(telegramId: number, actorId: number): Promise<UserEntity> {
  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  if (user.telegramId === config.ownerId) {
    throw new ForbiddenError('Cannot modify the owner');
  }
  if (actorId !== config.ownerId) {
    throw new ForbiddenError('Only the owner can reactivate users');
  }

  if (user.role !== 'suspended' && user.role !== 'blocked') {
    throw new ForbiddenError(`User is not suspended or blocked (current role: ${user.role})`);
  }

  // Determine the role to restore: default to 'user'; admins should have been
  // suspended while keeping the role info in metadata. For simplicity, restore to 'user'.
  // If the admin needs admin rights back, use /promote explicitly.
  const previousRole: UserRole = 'user';
  const updated: UserEntity = {
    ...user,
    role: previousRole,
    status: 'active',
    permissions: [],
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  await logAudit(actorId, 'user.unblocked', updated.id, {
    previousRole: user.role,
    restoredRole: previousRole,
  });

  logger.info({ userId: updated.id, actorId, msg: 'User unblocked/reactivated' });
  return updated;
}

/**
 * Update user permissions.
 */
export async function updateUserPermissions(
  telegramId: number,
  permissions: string[],
  actorId: number,
): Promise<UserEntity> {
  if (actorId !== config.ownerId) {
    throw new ForbiddenError('Only the owner can manage admin permissions');
  }

  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  if (user.telegramId === config.ownerId) {
    throw new ForbiddenError('Cannot modify owner permissions');
  }
  if (user.role !== 'admin') {
    throw new ForbiddenError('Permissions can only be assigned to admins');
  }

  for (const perm of permissions) {
    if (!(AVAILABLE_PERMISSIONS as readonly string[]).includes(perm)) {
      throw new ForbiddenError(`Invalid permission: ${perm}`);
    }
  }

  const updated: UserEntity = {
    ...user,
    permissions,
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  await logAudit(actorId, 'user.permissions_updated', updated.id, {
    previousPermissions: user.permissions,
    newPermissions: permissions,
  });

  logger.info({ userId: updated.id, actorId, msg: 'User permissions updated' });
  return updated;
}

/**
 * Create an owner record directly, bypassing the access request flow.
 * Called when the owner sends /start for the first time.
 */
export async function createOwnerRecord(
  telegramId: number,
  username: string | null,
  firstName: string | null,
  lastName: string | null,
): Promise<UserEntity> {
  const existing = index.getUserByTelegramId(telegramId);
  if (existing) {
    if (
      existing.role === 'owner' &&
      existing.status === 'active' &&
      existing.permissions.length === 0 &&
      existing.username === username &&
      existing.firstName === firstName &&
      existing.lastName === lastName
    ) {
      return existing;
    }

    const updated: UserEntity = {
      ...existing,
      role: 'owner',
      status: 'active',
      permissions: [],
      username,
      firstName,
      lastName,
      updatedAt: new Date().toISOString(),
    };
    await index.updateEntity(updated);
    logger.info({ userId: updated.id, msg: 'Owner profile refreshed' });
    return updated;
  }

  const now = new Date().toISOString();
  const user: UserEntity = {
    type: 'user',
    id: generateEntityId('user', telegramId) as `user:${number}`,
    telegramId,
    username,
    firstName,
    lastName,
    role: 'owner',
    status: 'active',
    permissions: [],
    favorites: [],
    createdAt: now,
    updatedAt: now,
  };

  await index.saveEntity(user);
  await logAudit(telegramId, 'owner.created', user.id, {});
  logger.info({ userId: user.id, msg: 'Owner record created' });
  return user;
}

/**
 * Get a user by Telegram ID.
 */
export function getUserById(telegramId: number): UserEntity | undefined {
  return index.getUserByTelegramId(telegramId);
}

/**
 * Get all users.
 */
export function getAllUsers(): UserEntity[] {
  return index.getUsers();
}

/**
 * Get pending access requests.
 */
export function getPendingRequests(): UserEntity[] {
  return index.getUsers().filter((u) => u.role === 'pending');
}

/**
 * Check if a user is active and can access the bot-managed store.
 */
export function canAccessStore(telegramId: number): boolean {
  if (!index.isInitialized()) return false;
  // Owner always has access, regardless of index state
  if (telegramId === config.ownerId) return true;
  const user = index.getUserByTelegramId(telegramId);
  if (!user) return false;
  return user.status === 'active' && (user.role === 'user' || user.role === 'admin');
}

/**
 * Check if a user is an admin or owner.
 */
export function isAdmin(telegramId: number): boolean {
  // Owner is always an admin, regardless of index state
  if (telegramId === config.ownerId) return true;
  const user = index.getUserByTelegramId(telegramId);
  if (!user) return false;
  return user.status === 'active' && user.role === 'admin';
}

/**
 * Check if a user is the owner.
 */
export function isOwner(telegramId: number): boolean {
  return telegramId === config.ownerId;
}

/**
 * Add a favorite resource for a user.
 */
export async function addFavorite(telegramId: number, resourceId: string): Promise<UserEntity> {
  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  if (user.favorites.includes(resourceId)) {
    return user;
  }

  const updated: UserEntity = {
    ...user,
    favorites: [...user.favorites, resourceId],
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  return updated;
}

/**
 * Remove a favorite resource for a user.
 */
export async function removeFavorite(telegramId: number, resourceId: string): Promise<UserEntity> {
  const user = index.getUserByTelegramId(telegramId);
  if (!user) {
    throw new NotFoundError(`User ${telegramId} not found`);
  }

  const updated: UserEntity = {
    ...user,
    favorites: user.favorites.filter((id) => id !== resourceId),
    updatedAt: new Date().toISOString(),
  };

  await index.updateEntity(updated);
  return updated;
}

/**
 * Log an audit record.
 */
async function logAudit(
  actorId: number,
  action: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const audit: AuditEntity = {
    type: 'audit',
    id: `audit:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    actorId,
    action,
    targetId,
    metadata,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
  };

  await index.saveEntity(audit);
}
