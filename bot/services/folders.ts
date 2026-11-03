/**
 * Folder management service.
 * Handles CRUD operations for the dynamic folder hierarchy.
 */

import crypto from 'crypto';
import { FolderEntity, ResourceEntity, AuditEntity, generateEntityId } from '../models';
import { index } from '../telegram/index';
import { permanentDeleteResource } from './resources';
import logger from '../logger';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors';
import { uniqueDirectoryEntryName, withDirectoryLock } from './naming';

const MAX_NESTING_DEPTH = 10;

/**
 * Get the nesting depth of a folder.
 */
function getFolderDepth(folderId: string): number {
  let depth = 0;
  let current = index.getFolder(folderId);
  while (current && current.parentId) {
    depth++;
    current = index.getFolder(current.parentId);
  }
  return depth;
}

function validateParentFolder(parentId: string | null): void {
  if (!parentId) return;

  const parent = index.getFolder(parentId);
  if (!parent) throw new NotFoundError(`Parent folder ${parentId} not found`);
  if (parent.isDeleted) throw new ForbiddenError('Cannot use a deleted folder as a parent');
  if (getFolderDepth(parentId) >= MAX_NESTING_DEPTH) {
    throw new ValidationError(`Maximum nesting depth of ${MAX_NESTING_DEPTH} reached`);
  }
}

/**
 * Create a new folder.
 */
export async function createFolder(
  name: string,
  parentId: string | null,
  creatorId: number,
): Promise<FolderEntity> {
  if (!name || name.trim().length === 0) {
    throw new ValidationError('Folder name is required');
  }

  if (name.length > 100) {
    throw new ValidationError('Folder name must be 100 characters or less');
  }

  return withDirectoryLock(parentId, async () => {
    validateParentFolder(parentId);
    const now = new Date().toISOString();
    const folderId = generateEntityId('folder', crypto.randomBytes(8).toString('hex'));

    const folder: FolderEntity = {
      type: 'folder',
      id: folderId as `folder:${string}`,
      name: uniqueDirectoryEntryName(name, parentId, undefined, 100),
      parentId: parentId ? (parentId as `folder:${string}`) : null,
      creatorId,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await index.saveEntity(folder);
    await logAudit(creatorId, 'folder.created', folder.id, {
      name: folder.name,
      parentId,
    });

    logger.info({ folderId: folder.id, msg: 'Folder created' });
    return folder;
  });
}

/**
 * Rename a folder.
 */
export async function renameFolder(
  folderId: string,
  newName: string,
  actorId: number,
): Promise<FolderEntity> {
  if (!newName || newName.trim().length === 0) {
    throw new ValidationError('Folder name is required');
  }

  if (newName.length > 100) {
    throw new ValidationError('Folder name must be 100 characters or less');
  }

  const initialFolder = index.getFolder(folderId);
  if (!initialFolder) throw new NotFoundError(`Folder ${folderId} not found`);

  return withDirectoryLock(initialFolder.parentId, async () => {
    const folder = index.getFolder(folderId);
    if (!folder) throw new NotFoundError(`Folder ${folderId} not found`);
    if (folder.isDeleted) throw new ForbiddenError('Cannot rename a deleted folder');

    const updated: FolderEntity = {
      ...folder,
      name: uniqueDirectoryEntryName(newName, folder.parentId, folder.id, 100),
      updatedAt: new Date().toISOString(),
    };

    await index.updateEntity(updated);
    await logAudit(actorId, 'folder.renamed', folder.id, {
      oldName: folder.name,
      newName: updated.name,
    });

    logger.info({ folderId: folder.id, msg: 'Folder renamed' });
    return updated;
  });
}

/**
 * Move a folder to a new parent.
 */
export async function moveFolder(
  folderId: string,
  newParentId: string | null,
  actorId: number,
): Promise<FolderEntity> {
  return withDirectoryLock(newParentId, async () => {
    const folder = index.getFolder(folderId);
    if (!folder) throw new NotFoundError(`Folder ${folderId} not found`);
    if (folder.isDeleted) throw new ForbiddenError('Cannot move a deleted folder');

    validateParentFolder(newParentId);
    if (newParentId) {
      let current: string | null = newParentId;
      while (current) {
        if (current === folderId) {
          throw new ValidationError('Cannot move folder into its own descendant');
        }
        current = index.getFolder(current)?.parentId ?? null;
      }

      if (getFolderDepth(newParentId) >= MAX_NESTING_DEPTH) {
        throw new ValidationError(`Maximum nesting depth of ${MAX_NESTING_DEPTH} reached`);
      }
    }

    const updated: FolderEntity = {
      ...folder,
      name: uniqueDirectoryEntryName(folder.name, newParentId, folder.id, 100),
      parentId: newParentId ? (newParentId as `folder:${string}`) : null,
      updatedAt: new Date().toISOString(),
    };

    await index.updateEntity(updated);
    await logAudit(actorId, 'folder.moved', folder.id, {
      oldParentId: folder.parentId,
      newParentId,
      name: updated.name,
    });

    logger.info({ folderId: folder.id, msg: 'Folder moved' });
    return updated;
  });
}

/**
 * Soft delete a folder.
 */
export async function deleteFolder(folderId: string, actorId: number): Promise<FolderEntity> {
  const folder = index.getFolder(folderId);
  if (!folder) {
    throw new NotFoundError(`Folder ${folderId} not found`);
  }
  if (folder.isDeleted) {
    throw new ForbiddenError('Folder is already deleted');
  }

  const deletedAt = new Date().toISOString();
  const deletionBatchId = crypto.randomBytes(12).toString('hex');
  await softDeleteDescendants(folderId, deletedAt, deletionBatchId);

  const updated: FolderEntity = {
    ...folder,
    isDeleted: true,
    deletedAt,
    deletionBatchId,
    updatedAt: deletedAt,
  };

  await index.updateEntity(updated);
  await logAudit(actorId, 'folder.deleted', folder.id, {});

  logger.info({ folderId: folder.id, msg: 'Folder soft-deleted' });
  return updated;
}

/**
 * Restore a deleted folder.
 */
export async function restoreFolder(folderId: string, actorId: number): Promise<FolderEntity> {
  const initialFolder = index.getFolder(folderId);
  if (!initialFolder) throw new NotFoundError(`Folder ${folderId} not found`);

  return withDirectoryLock(initialFolder.parentId, async () => {
    const folder = index.getFolder(folderId);
    if (!folder) throw new NotFoundError(`Folder ${folderId} not found`);
    if (!folder.isDeleted) throw new ForbiddenError('Folder is not deleted');
    validateParentFolder(folder.parentId);

    const matchesDeletion = (deletedAt: string | null, batchId?: string) =>
      folder.deletionBatchId
        ? batchId === folder.deletionBatchId
        : Boolean(folder.deletedAt) && deletedAt === folder.deletedAt;
    const restoredAt = new Date().toISOString();
    const restoredFolderIds = new Set([folderId]);
    const restoredRoot: FolderEntity = {
      ...folder,
      name: uniqueDirectoryEntryName(folder.name, folder.parentId, folder.id, 100),
      isDeleted: false,
      deletedAt: null,
      deletionBatchId: undefined,
      updatedAt: restoredAt,
    };
    await index.updateEntity(restoredRoot);

    for (const id of getDescendantFolderIds(folderId)) {
      const descendant = index.getFolder(id);
      if (
        !descendant?.isDeleted ||
        !matchesDeletion(descendant.deletedAt, descendant.deletionBatchId)
      ) {
        continue;
      }

      await index.updateEntity({
        ...descendant,
        name: uniqueDirectoryEntryName(descendant.name, descendant.parentId, descendant.id, 100),
        isDeleted: false,
        deletedAt: null,
        deletionBatchId: undefined,
        updatedAt: restoredAt,
      });
      restoredFolderIds.add(id);
    }

    for (const resource of index.getResources()) {
      if (
        !resource.isDeleted ||
        !resource.folderId ||
        !restoredFolderIds.has(resource.folderId) ||
        !matchesDeletion(resource.deletedAt, resource.deletionBatchId)
      ) {
        continue;
      }

      await index.updateEntity({
        ...resource,
        title: uniqueDirectoryEntryName(resource.title, resource.folderId, resource.id, 500),
        fileName: uniqueDirectoryEntryName(
          resource.fileName || resource.title,
          resource.folderId,
          resource.id,
          500,
        ),
        isDeleted: false,
        deletedAt: null,
        deletionBatchId: undefined,
        updatedAt: restoredAt,
      });
    }

    await logAudit(actorId, 'folder.restored', folder.id, {
      restoredFolderCount: restoredFolderIds.size,
    });

    logger.info({ folderId: folder.id, msg: 'Folder restored' });
    return restoredRoot;
  });
}

/**
 * Permanently delete a folder and all its contents.
 */
export async function permanentDeleteFolder(folderId: string, actorId: number): Promise<void> {
  const folder = index.getFolder(folderId);
  if (!folder) {
    throw new NotFoundError(`Folder ${folderId} not found`);
  }
  if (!folder.isDeleted) {
    throw new ForbiddenError('Folder must be in the recycle bin before permanent deletion');
  }

  const descendantIds = getDescendantFolderIds(folderId);
  const folderIds = new Set([folderId, ...descendantIds]);
  const resources = index
    .getResources()
    .filter((resource) => resource.folderId !== null && folderIds.has(resource.folderId));

  for (const resource of resources) {
    if (!resource.isDeleted) {
      throw new ForbiddenError('All resources must be deleted before permanent folder deletion');
    }
    await permanentDeleteResource(resource.id, actorId);
  }

  for (const id of [...descendantIds].reverse()) {
    await index.deleteEntity(id);
  }

  // Delete the folder itself
  await index.deleteEntity(folderId);
  await logAudit(actorId, 'folder.permanently_deleted', folder.id, {});

  logger.info({ folderId: folder.id, msg: 'Folder permanently deleted' });
}

/**
 * Get all descendants of a folder (recursive).
 */
function getDescendantFolderIds(folderId: string): string[] {
  const descendants: string[] = [];
  const children = index.getFolders().filter((folder) => folder.parentId === folderId);

  for (const child of children) {
    descendants.push(child.id);
    descendants.push(...getDescendantFolderIds(child.id));
  }

  return descendants;
}

/**
 * Soft delete all descendants of a folder.
 */
async function softDeleteDescendants(
  folderId: string,
  deletedAt: string,
  deletionBatchId: string,
): Promise<void> {
  const descendantIds = getDescendantFolderIds(folderId);

  // Soft delete child folders
  for (const id of descendantIds) {
    const folder = index.getFolder(id);
    if (folder && !folder.isDeleted) {
      const updated: FolderEntity = {
        ...folder,
        isDeleted: true,
        deletedAt,
        deletionBatchId,
        updatedAt: deletedAt,
      };
      await index.updateEntity(updated);
    }
  }

  // Soft delete resources in this folder and all descendants
  const allFolderIds = new Set([folderId, ...descendantIds]);
  const resources = index
    .getResources()
    .filter(
      (resource) =>
        resource.folderId !== null && allFolderIds.has(resource.folderId) && !resource.isDeleted,
    );

  for (const resource of resources) {
    const updated: ResourceEntity = {
      ...resource,
      isDeleted: true,
      deletedAt,
      deletionBatchId,
      updatedAt: deletedAt,
    };
    await index.updateEntity(updated);
  }
}

/**
 * Get deleted top-level folders for the recycle bin.
 */
export function getDeletedFolders(): FolderEntity[] {
  return index.getFolders().filter((folder) => {
    if (!folder.isDeleted) return false;
    return !folder.parentId || !index.getFolder(folder.parentId)?.isDeleted;
  });
}

/**
 * Get breadcrumb path for a folder.
 */
export function getFolderBreadcrumb(folderId: string): FolderEntity[] {
  const breadcrumb: FolderEntity[] = [];
  let current = index.getFolder(folderId);

  while (current) {
    breadcrumb.unshift(current);
    if (current.parentId) {
      current = index.getFolder(current.parentId);
    } else {
      break;
    }
  }

  return breadcrumb;
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
