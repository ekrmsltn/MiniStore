import { loadConfig } from '../config';
import {
  isVisibility,
  MAX_CUSTOM_VISIBILITY_USERS,
  type FolderEntity,
  type ResourceEntity,
  type Visibility,
} from '../models';
import { index } from '../telegram/index';
import { hasPermission } from './permissions';

const config = loadConfig();

export function validateVisibility(visibility: Visibility): void {
  if (!isVisibility(visibility)) {
    throw new Error(
      `Visibility must be public, private, or custom with at most ${MAX_CUSTOM_VISIBILITY_USERS} distinct positive user IDs`,
    );
  }
}

export function getVisibilityMode(visibility: Visibility | undefined): string {
  return visibility?.mode ?? 'inherit';
}

function getEligibleAccountIds(): Set<number> {
  const ids = new Set(
    index
      .getUsers()
      .filter((user) => user.status === 'active' && (user.role === 'user' || user.role === 'admin'))
      .map((user) => user.telegramId),
  );
  ids.add(config.ownerId);
  return ids;
}

function getVisibilityAudience(
  visibility: Visibility | undefined,
  eligibleAccounts: Set<number>,
): Set<number> {
  if (!visibility || visibility.mode === 'public') return new Set(eligibleAccounts);
  if (visibility.mode === 'private') {
    return new Set(
      [...eligibleAccounts].filter(
        (telegramId) =>
          telegramId === config.ownerId || index.getUserByTelegramId(telegramId)?.role === 'admin',
      ),
    );
  }
  if (!isVisibility(visibility)) return new Set();
  return new Set(visibility.userIds.filter((telegramId) => eligibleAccounts.has(telegramId)));
}

function intersect(left: Set<number>, right: Set<number>): Set<number> {
  return new Set([...left].filter((telegramId) => right.has(telegramId)));
}

function getFolderAudience(
  folderId: string,
  eligibleAccounts: Set<number>,
  visited = new Set<string>(),
): Set<number> {
  if (visited.has(folderId)) return new Set();
  const folder = index.getFolder(folderId);
  if (!folder) return new Set();
  visited.add(folderId);

  const inherited = folder.parentId
    ? getFolderAudience(folder.parentId, eligibleAccounts, visited)
    : new Set(eligibleAccounts);
  if (folder.visibility === undefined) return inherited;
  return intersect(inherited, getVisibilityAudience(folder.visibility, eligibleAccounts));
}

export function canAccessFolder(telegramId: number, folderId: string): boolean {
  if (telegramId === config.ownerId) return Boolean(index.getFolder(folderId));
  if (!isEligibleAccount(telegramId)) return false;
  return getFolderAudience(folderId, getEligibleAccountIds()).has(telegramId);
}

export function canAccessResource(telegramId: number, resource: ResourceEntity): boolean {
  if (telegramId === config.ownerId) return true;
  if (!isEligibleAccount(telegramId)) return false;

  const eligibleAccounts = getEligibleAccountIds();
  const resourceAudience = getVisibilityAudience(resource.visibility, eligibleAccounts);
  const folderAudience = resource.folderId
    ? getFolderAudience(resource.folderId, eligibleAccounts)
    : eligibleAccounts;
  return intersect(resourceAudience, folderAudience).has(telegramId);
}

export function canAccessResourceId(telegramId: number, resourceId: string): boolean {
  const resource = index.getResource(resourceId);
  return Boolean(resource && canAccessResource(telegramId, resource));
}

export function canAccessFolderEntity(telegramId: number, folder: FolderEntity): boolean {
  return canAccessFolder(telegramId, folder.id);
}

export function canManageResourceVisibility(telegramId: number, resource: ResourceEntity): boolean {
  return canAccessResource(telegramId, resource) && hasPermission(telegramId, 'upload_resources');
}

export function canManageFolderVisibility(telegramId: number, folder: FolderEntity): boolean {
  return canAccessFolderEntity(telegramId, folder) && hasPermission(telegramId, 'manage_folders');
}

export function validateVisibilityAccounts(visibility: Visibility): void {
  validateVisibility(visibility);
  if (visibility.mode !== 'custom') return;
  for (const telegramId of visibility.userIds) {
    if (telegramId === config.ownerId) continue;
    const user = index.getUserByTelegramId(telegramId);
    if (!user || user.status !== 'active' || (user.role !== 'user' && user.role !== 'admin')) {
      throw new Error('Custom visibility can include only active approved accounts');
    }
  }
}

function isEligibleAccount(telegramId: number): boolean {
  const user = index.getUserByTelegramId(telegramId);
  return Boolean(
    user && user.status === 'active' && (user.role === 'user' || user.role === 'admin'),
  );
}
