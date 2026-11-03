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
