/**
 * Resource management service.
 * Handles resource CRUD, search, and metadata operations.
 */

import crypto from 'crypto';
import { ResourceEntity, ResourceVersionEntity, AuditEntity, generateEntityId } from '../models';
import { index } from '../telegram/index';
import { deleteFile, hasStoredFile } from '../telegram/storage';
import logger from '../logger';
import { NotFoundError, ValidationError, ConflictError } from '../errors';
import { uniqueDirectoryEntryName, withDirectoryLock } from './naming';

const creatingFileIds = new Set<string>();
const versioningResourceIds = new Set<string>();
const resourceMutationLocks = new Map<string, Promise<void>>();

/**
 * Create a new resource record.
 */
export async function createResource(
  title: string,
  description: string,
  tags: string[],
  fileType: string,
  fileSize: number,
  folderId: string | null,
  storageMessageId: number,
  storageFileId: string,
  uploaderId: number,
  fileName = title,
): Promise<ResourceEntity> {
  if (!title || title.trim().length === 0 || title.length > 500) {
    throw new ValidationError('Resource title is required');
  }
  if (description.length > 4000) {
    throw new ValidationError('Resource description must be 4000 characters or less');
  }
  if (!Array.isArray(tags) || tags.length > 20 || tags.some((tag) => typeof tag !== 'string')) {
    throw new ValidationError('Resource tags must be an array of at most 20 strings');
  }
  if (!Number.isInteger(fileSize) || fileSize < 0 || fileSize > 50 * 1024 * 1024) {
    throw new ValidationError('Resource file size must be an integer between 0 and 50 MB');
  }
  if (!Number.isInteger(storageMessageId) || storageMessageId <= 0 || !storageFileId) {
    throw new ValidationError('Valid Telegram storage file information is required');
  }
  if (folderId !== null && (typeof folderId !== 'string' || !folderId.trim())) {
    throw new ValidationError('Folder ID must be a non-empty ID or null');
  }
  if (typeof fileName !== 'string' || fileName.trim().length === 0 || fileName.length > 500) {
    throw new ValidationError('Resource file name must be between 1 and 500 characters');
  }

  if (checkDuplicateResource(storageFileId) || creatingFileIds.has(storageFileId)) {
    throw new ConflictError('A resource with this file already exists');
  }
  creatingFileIds.add(storageFileId);

  try {
    return await withDirectoryLock(folderId, async () => {
      if (folderId) {
        const folder = index.getFolder(folderId);
        if (!folder || folder.isDeleted) {
          throw new NotFoundError(`Active folder ${folderId} not found`);
        }
      }

      const now = new Date().toISOString();
      const resourceId = generateEntityId('resource', crypto.randomBytes(8).toString('hex'));
      const resource: ResourceEntity = {
        type: 'resource',
        id: resourceId as `resource:${string}`,
        title: uniqueDirectoryEntryName(title, folderId, undefined, 500),
        description: description.trim(),
        tags: tags.slice(0, 20),
        categoryId: null,
        fileType,
        fileSize,
        fileName: uniqueDirectoryEntryName(fileName, folderId, undefined, 500),
        folderId: folderId ? (folderId as `folder:${string}`) : null,
        storageMessageId,
        storageFileId,
        uploaderId,
        currentVersionUploaderId: uploaderId,
        version: 1,
        downloadCount: 0,
        isDeleted: false,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      await index.saveEntity(resource);
      await logAudit(uploaderId, 'resource.created', resource.id, {
        title: resource.title,
        fileName: resource.fileName,
        folderId,
      });

      logger.info({ resourceId: resource.id, msg: 'Resource created' });
      return resource;
    });
  } finally {
    creatingFileIds.delete(storageFileId);
  }
}

/**
 * Update resource metadata.
 */
export async function updateResource(
  resourceId: string,
  updates: Partial<
    Pick<ResourceEntity, 'title' | 'description' | 'tags' | 'categoryId' | 'folderId'>
  >,
  actorId: number,
): Promise<ResourceEntity> {
  if (
    'folderId' in updates &&
    updates.folderId !== undefined &&
    updates.folderId !== null &&
    (typeof updates.folderId !== 'string' || !updates.folderId.trim())
  ) {
    throw new ValidationError('Folder ID must be a non-empty ID or null');
  }

  const initialResource = index.getResource(resourceId);
  if (!initialResource) throw new NotFoundError(`Resource ${resourceId} not found`);
  const targetFolderId =
    updates.folderId !== undefined ? updates.folderId : initialResource.folderId;

  return withDirectoryLock(targetFolderId, () =>
    withResourceMutationLock(resourceId, async () => {
      const resource = index.getResource(resourceId);
      if (!resource) {
        throw new NotFoundError(`Resource ${resourceId} not found`);
      }
      if (resource.isDeleted) {
        throw new ValidationError('Cannot update a deleted resource');
      }
      if (updates.folderId !== undefined && updates.folderId) {
        const folder = index.getFolder(updates.folderId);
        if (!folder || folder.isDeleted) {
          throw new NotFoundError(`Active folder ${updates.folderId} not found`);
        }
      }

      if (
        'title' in updates &&
        (typeof updates.title !== 'string' ||
          updates.title.trim().length === 0 ||
          updates.title.length > 500)
      ) {
        throw new ValidationError('Resource title must be between 1 and 500 characters');
      }
      if (
        'description' in updates &&
        (typeof updates.description !== 'string' || updates.description.length > 4000)
      ) {
        throw new ValidationError('Resource description must be 4000 characters or less');
      }
      if (
        'tags' in updates &&
        (!Array.isArray(updates.tags) ||
          updates.tags.length > 20 ||
          updates.tags.some((tag) => typeof tag !== 'string' || tag.trim().length > 100))
      ) {
        throw new ValidationError(
          'Resource tags must contain at most 20 values of 100 characters or less',
        );
      }
      if (
        'categoryId' in updates &&
        updates.categoryId !== null &&
        (typeof updates.categoryId !== 'string' ||
          updates.categoryId.trim().length === 0 ||
          updates.categoryId.length > 100)
      ) {
        throw new ValidationError('Resource category must be between 1 and 100 characters');
      }

      const updatedFolderId = updates.folderId !== undefined ? updates.folderId : resource.folderId;
      const updatedTitle = updates.title !== undefined ? updates.title.trim() : resource.title;
      const updatedFileName = resource.fileName || resource.title;
      const updated: ResourceEntity = {
        ...resource,
        ...updates,
        title: uniqueDirectoryEntryName(updatedTitle, updatedFolderId, resource.id, 500),
        fileName: uniqueDirectoryEntryName(updatedFileName, updatedFolderId, resource.id, 500),
        ...(updates.description !== undefined ? { description: updates.description.trim() } : {}),
        ...(updates.tags !== undefined
          ? { tags: updates.tags.map((tag) => tag.trim()).filter(Boolean) }
          : {}),
        ...(updates.categoryId !== undefined
          ? { categoryId: updates.categoryId?.trim() || null }
          : {}),
        updatedAt: new Date().toISOString(),
      };

      await index.updateEntity(updated);
      await logAudit(actorId, 'resource.updated', resource.id, updates);

      logger.info({ resourceId: resource.id, msg: 'Resource updated' });
      return updated;
    }),
  );
}

/**
 * Soft delete a resource.
 */
export async function deleteResource(resourceId: string, actorId: number): Promise<ResourceEntity> {
  return withResourceMutationLock(resourceId, async () => {
    const resource = index.getResource(resourceId);
    if (!resource) {
      throw new NotFoundError(`Resource ${resourceId} not found`);
    }
    if (resource.isDeleted) {
      throw new ValidationError('Resource is already deleted');
    }

    const now = new Date().toISOString();
    const updated: ResourceEntity = {
      ...resource,
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
    };

    await index.updateEntity(updated);
    await logAudit(actorId, 'resource.deleted', resource.id, {});

    logger.info({ resourceId: resource.id, msg: 'Resource soft-deleted' });
    return updated;
  });
}

/**
 * Restore a deleted resource.
 */
export async function restoreResource(
  resourceId: string,
  actorId: number,
): Promise<ResourceEntity> {
  const initialResource = index.getResource(resourceId);
  if (!initialResource) throw new NotFoundError(`Resource ${resourceId} not found`);

  return withDirectoryLock(initialResource.folderId, () =>
    withResourceMutationLock(resourceId, async () => {
      const resource = index.getResource(resourceId);
      if (!resource) {
        throw new NotFoundError(`Resource ${resourceId} not found`);
      }
      if (!resource.isDeleted) {
        throw new ValidationError('Resource is not deleted');
      }

      if (resource.folderId) {
        const folder = index.getFolder(resource.folderId);
        if (!folder || folder.isDeleted) {
          throw new ValidationError('Restore the parent folder before restoring this resource');
        }
      }

      const updated: ResourceEntity = {
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
        updatedAt: new Date().toISOString(),
      };

      await index.updateEntity(updated);
      await logAudit(actorId, 'resource.restored', resource.id, {});

      logger.info({ resourceId: resource.id, msg: 'Resource restored' });
      return updated;
    }),
  );
}

/**
 * Increment download count.
 */
export async function trackDownload(resourceId: string): Promise<ResourceEntity> {
  return withResourceMutationLock(resourceId, async () => {
    const resource = index.getResource(resourceId);
    if (!resource) {
      throw new NotFoundError(`Resource ${resourceId} not found`);
    }

    const updated: ResourceEntity = {
      ...resource,
      downloadCount: resource.downloadCount + 1,
      updatedAt: new Date().toISOString(),
    };

    await index.updateEntity(updated);
    return updated;
  });
}

/**
 * Get a resource by ID.
 */
export function getResource(resourceId: string): ResourceEntity | undefined {
  return index.getResource(resourceId);
}

/**
 * Search resources.
 */
export function searchResources(query: string): ResourceEntity[] {
  return index.searchResources(query);
}

/**
 * Get all resources.
 */
export function getAllResources(): ResourceEntity[] {
  return index.getResources().filter((r) => !r.isDeleted);
}

/**
 * Get deleted resources (recycle bin).
 */
export function getDeletedResources(): ResourceEntity[] {
  return index.getResources().filter((r) => r.isDeleted);
}

/**
 * Permanently delete a resource (remove from Management Channel and Storage Channel).
 */
export async function permanentDeleteResource(resourceId: string, actorId: number): Promise<void> {
  const resource = index.getResource(resourceId);
  if (!resource) {
    throw new NotFoundError(`Resource ${resourceId} not found`);
  }
  if (!resource.isDeleted) {
    throw new ValidationError('Resource must be soft-deleted before permanent deletion');
  }

  const versions = index.getResourceVersions(resourceId);
  const messageIds = new Set([
    resource.storageMessageId,
    ...versions.map((version) => version.storageMessageId),
  ]);
  for (const messageId of messageIds) {
    if (await hasStoredFile(messageId)) {
      await deleteFile(messageId);
      logger.info({
        resourceId: resource.id,
        messageId,
        msg: 'File removed from Storage Channel',
      });
    } else {
      logger.warn({
        resourceId: resource.id,
        messageId,
        msg: 'Storage file was already missing during permanent deletion',
      });
    }
  }

  for (const version of versions) {
    await index.deleteEntity(version.id);
  }

  // Delete the resource entity from the Management Channel
  await index.deleteEntity(resourceId);
  await logAudit(actorId, 'resource.permanently_deleted', resource.id, {
    title: resource.title,
    storageMessageId: resource.storageMessageId,
  });

  logger.info({ resourceId: resource.id, msg: 'Resource permanently deleted' });
}

/**
 * Check if a resource with the same storage file ID already exists.
 * Used for duplicate detection before upload.
 */
export function checkDuplicateResource(storageFileId: string): ResourceEntity | undefined {
  const resources = index.getResources().filter((resource) => !resource.isDeleted);
  const historicalResources = new Set(
    index
      .getByType('resource_version')
      .filter(
        (version): version is ResourceVersionEntity =>
          version.type === 'resource_version' && version.storageFileId === storageFileId,
      )
      .map((version) => version.resourceId),
  );
  return resources.find(
    (resource) => resource.storageFileId === storageFileId || historicalResources.has(resource.id),
  );
}

/**
 * Return the complete version history, including the current file.
 */
export function getResourceVersions(resourceId: string): ResourceVersionEntity[] {
  const resource = index.getResource(resourceId);
  if (!resource) {
    throw new NotFoundError(`Resource ${resourceId} not found`);
  }

  const versions = index.getResourceVersions(resourceId);
  if (!versions.some((version) => version.version === resource.version)) {
    const currentVersionCreatedAt =
      resource.version === 1 ? resource.createdAt : resource.updatedAt;
    versions.push({
      type: 'resource_version',
      id: createResourceVersionId(resource.id, resource.version),
      resourceId: resource.id,
      version: resource.version,
      fileName: resource.fileName || resource.title,
      fileType: resource.fileType,
      fileSize: resource.fileSize,
      storageMessageId: resource.storageMessageId,
      storageFileId: resource.storageFileId,
      uploaderId: resource.currentVersionUploaderId ?? resource.uploaderId,
      createdAt: currentVersionCreatedAt,
      updatedAt: currentVersionCreatedAt,
    });
  }

  return versions.sort((a, b) => a.version - b.version);
}

export function getResourceVersion(
  resourceId: string,
  versionNumber: number,
): ResourceVersionEntity | undefined {
  return getResourceVersions(resourceId).find((version) => version.version === versionNumber);
}

/**
 * Store the current revision before replacing it with a newly uploaded file.
 */
export async function createResourceVersion(
  resourceId: string,
  file: {
    fileName: string;
    fileType: string;
    fileSize: number;
    storageMessageId: number;
    storageFileId: string;
  },
  actorId: number,
): Promise<ResourceEntity> {
  if (versioningResourceIds.has(resourceId)) {
    await discardUncommittedVersionFile(resourceId, file.storageMessageId);
    throw new ConflictError('A new version is already being created for this resource');
  }
  versioningResourceIds.add(resourceId);

  try {
    return await withResourceMutationLock(resourceId, async () => {
      let committed = false;
      try {
        const resource = index.getResource(resourceId);
        if (!resource) {
          throw new NotFoundError(`Resource ${resourceId} not found`);
        }
        if (resource.isDeleted) {
          throw new ValidationError('Cannot create a new version of a deleted resource');
        }
        if (
          !file.fileName ||
          file.fileName.length > 255 ||
          !file.fileType ||
          !Number.isSafeInteger(file.fileSize) ||
          file.fileSize < 0 ||
          file.fileSize > 50 * 1024 * 1024 ||
          !Number.isSafeInteger(file.storageMessageId) ||
          file.storageMessageId <= 0 ||
          !file.storageFileId
        ) {
          throw new ValidationError('Valid file metadata is required to create a resource version');
        }
        if (
          resource.storageFileId === file.storageFileId ||
          index
            .getResourceVersions(resourceId)
            .some((version) => version.storageFileId === file.storageFileId)
        ) {
          throw new ConflictError('This file is already part of the resource version history');
        }

        const now = new Date().toISOString();
        const previousVersion: ResourceVersionEntity = {
          type: 'resource_version',
          id: createResourceVersionId(resource.id, resource.version),
          resourceId: resource.id,
          version: resource.version,
          fileName: resource.fileName || resource.title,
          fileType: resource.fileType,
          fileSize: resource.fileSize,
          storageMessageId: resource.storageMessageId,
          storageFileId: resource.storageFileId,
          uploaderId: resource.currentVersionUploaderId ?? resource.uploaderId,
          createdAt: resource.version === 1 ? resource.createdAt : resource.updatedAt,
          updatedAt: now,
        };

        await index.saveEntity(previousVersion);

        const updated: ResourceEntity = {
          ...resource,
          fileName: file.fileName,
          fileType: file.fileType,
          fileSize: file.fileSize,
          storageMessageId: file.storageMessageId,
          storageFileId: file.storageFileId,
          currentVersionUploaderId: actorId,
          version: resource.version + 1,
          updatedAt: now,
        };

        await index.updateEntity(updated);
        committed = true;
        await logAudit(actorId, 'resource.versioned', resource.id, {
          newVersion: updated.version,
          previousVersion: resource.version,
          fileName: file.fileName,
        });

        logger.info({
          resourceId: resource.id,
          version: updated.version,
          msg: 'Resource version created',
        });
        return updated;
      } catch (error) {
        if (!committed) {
          await discardUncommittedVersionFile(resourceId, file.storageMessageId);
        }
        throw error;
      }
    });
  } finally {
    versioningResourceIds.delete(resourceId);
  }
}

async function discardUncommittedVersionFile(resourceId: string, messageId: number): Promise<void> {
  try {
    await deleteFile(messageId);
  } catch (cleanupError) {
    logger.error({
      err: cleanupError,
      resourceId,
      messageId,
      msg: 'Failed to remove an uncommitted resource version from Storage Channel',
    });
  }
}

async function withResourceMutationLock<T>(
  resourceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = resourceMutationLocks.get(resourceId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  resourceMutationLocks.set(resourceId, current);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (resourceMutationLocks.get(resourceId) === current) {
      resourceMutationLocks.delete(resourceId);
    }
  }
}

function createResourceVersionId(
  resourceId: string,
  version: number,
): `resource_version:${string}` {
  return `resource_version:${resourceId.slice('resource:'.length)}-${version}`;
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
