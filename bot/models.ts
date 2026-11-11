/**
 * Entity type definitions for the Management Channel.
 * Each entity is stored as a JSON message in Telegram.
 */

export type EntityType =
  'user' | 'folder' | 'resource' | 'resource_version' | 'audit' | 'session' | 'assistant_usage';

export type UserRole =
  'owner' | 'admin' | 'user' | 'pending' | 'rejected' | 'suspended' | 'blocked';
export type UserStatus = 'active' | 'inactive' | 'suspended' | 'blocked';

export interface BaseEntity {
  type: EntityType;
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type Visibility =
  { mode: 'public' } | { mode: 'private' } | { mode: 'custom'; userIds: number[] };

export const MAX_CUSTOM_VISIBILITY_USERS = 200;

export function isVisibility(value: unknown): value is Visibility {
  if (typeof value !== 'object' || value === null || !('mode' in value)) return false;
  const visibility = value as Record<string, unknown>;
  if (visibility.mode === 'public' || visibility.mode === 'private') {
    return Object.keys(visibility).length === 1;
  }
  if (visibility.mode !== 'custom' || !Array.isArray(visibility.userIds)) return false;
  return (
    visibility.userIds.length <= MAX_CUSTOM_VISIBILITY_USERS &&
    visibility.userIds.every(
      (id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
    ) &&
    new Set(visibility.userIds).size === visibility.userIds.length &&
    Object.keys(visibility).length === 2
  );
}

export interface UserEntity extends BaseEntity {
  type: 'user';
  id: `user:${number}`;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  status: UserStatus;
  permissions: string[];
  favorites: string[];
}

export interface FolderEntity extends BaseEntity {
  type: 'folder';
  id: `folder:${string}`;
  name: string;
  parentId: `folder:${string}` | null;
  visibility?: Visibility;
  creatorId: number;
  isDeleted: boolean;
  deletedAt: string | null;
  deletionBatchId?: string;
}

export interface ResourceEntity extends BaseEntity {
  type: 'resource';
  id: `resource:${string}`;
  title: string;
  description: string;
  tags: string[];
  categoryId: string | null;
  fileType: string;
  fileSize: number;
  fileName?: string;
  folderId: `folder:${string}` | null;
  visibility?: Visibility;
  storageMessageId: number;
  storageFileId: string;
  uploaderId: number;
  currentVersionUploaderId?: number;
  version: number;
  downloadCount: number;
  isDeleted: boolean;
  deletedAt: string | null;
  deletionBatchId?: string;
}

export interface ResourceVersionEntity extends BaseEntity {
  type: 'resource_version';
  id: `resource_version:${string}`;
  resourceId: `resource:${string}`;
  version: number;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageMessageId: number;
  storageFileId: string;
  uploaderId: number;
}

export interface AuditEntity extends BaseEntity {
  type: 'audit';
  actorId: number;
  action: string;
  targetId: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface SessionEntity extends BaseEntity {
  type: 'session';
  id: `session:${string}`;
  telegramId: number;
  expiresAt: number;
  revoked: boolean;
}

export interface AssistantUsageEntity extends BaseEntity {
  type: 'assistant_usage';
  id: `assistant_usage:${number}`;
  telegramId: number;
  requestTimestamps: string[];
  windowStartedAt?: string;
}

export type Entity =
  | UserEntity
  | FolderEntity
  | ResourceEntity
  | ResourceVersionEntity
  | AuditEntity
  | SessionEntity
  | AssistantUsageEntity;

/**
 * Generate a unique ID for an entity.
 */
export function generateEntityId(type: EntityType, identifier: string | number): string {
  return `${type}:${identifier}`;
}

/**
 * Parse an entity ID into type and identifier.
 */
export function parseEntityId(id: string): { type: EntityType; identifier: string } {
  const [type, identifier] = id.split(':') as [EntityType, string];
  return { type, identifier };
}
