/**
 * In-memory index for all entities stored in the Management Channel.
 * Built on startup from channel messages, serves as the primary lookup mechanism.
 */

import {
  Entity,
  EntityType,
  UserEntity,
  FolderEntity,
  ResourceEntity,
  ResourceVersionEntity,
  AuditEntity,
  SessionEntity,
  AssistantUsageEntity,
} from '../models';
import { iterateEntityRecords, sendEntity, editEntity, deleteEntity } from './management';
import logger from '../logger';
import { pauseTelegramUpdates, resumeTelegramUpdates } from '../webhook';

/**
 * Index maps entity IDs to their data and message IDs.
 */
interface IndexedEntity {
  entity: Entity;
  messageId: number | null;
}

class EntityIndex {
  private index = new Map<string, IndexedEntity>();
  private typeIndex = new Map<EntityType, Set<string>>();
  private entityLocks = new Map<string, Promise<void>>();
  private initialized = false;

  /**
   * Build the index from all entities in the Management Channel.
   */
  async build(): Promise<void> {
    logger.info('Building entity index from Management Channel...');
    this.clear();

    try {
      for await (const { entity, messageId } of iterateEntityRecords()) {
        this.index.set(entity.id, { entity, messageId });
        const typeSet = this.typeIndex.get(entity.type);
        if (typeSet) {
          typeSet.add(entity.id);
        } else {
          this.typeIndex.set(entity.type, new Set([entity.id]));
        }
      }
    } catch (error) {
      this.clear();
      throw error;
    }

    this.initialized = true;
    logger.info({
      total: this.index.size,
      byType: Object.fromEntries(
        Array.from(this.typeIndex.entries()).map(([type, ids]) => [type, ids.size]),
      ),
      msg: 'Entity index built successfully',
    });
  }

  /**
   * Check if the index has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  markUnavailable(): void {
    this.initialized = false;
  }

  /**
   * Get an entity by ID.
   */
  get(id: string): Entity | undefined {
    return this.index.get(id)?.entity;
  }

  /**
   * Get an entity by ID with its message ID.
   */
  getWithMessageId(id: string): IndexedEntity | undefined {
    return this.index.get(id);
  }

  /**
   * Set or update an entity in the index.
   */
  set(entity: Entity, messageId: number | null): void {
    this.index.set(entity.id, { entity, messageId });

    // Update type index
    const typeSet = this.typeIndex.get(entity.type);
    if (typeSet) {
      typeSet.add(entity.id);
    } else {
      this.typeIndex.set(entity.type, new Set([entity.id]));
    }
  }

  /**
   * Remove an entity from the index.
   */
  delete(id: string): boolean {
    const existing = this.index.get(id);
    if (!existing) return false;

    this.index.delete(id);
    const typeSet = this.typeIndex.get(existing.entity.type);
    if (typeSet) {
      typeSet.delete(id);
    }

    return true;
  }

  /**
   * Get all entities of a specific type.
   */
  getByType(type: EntityType): Entity[] {
    const ids = this.typeIndex.get(type);
    if (!ids) return [];

    return Array.from(ids)
      .map((id) => this.index.get(id)?.entity)
      .filter((e): e is Entity => e !== undefined);
  }

  /**
   * Get all users.
   */
  getUsers(): UserEntity[] {
    return this.getByType('user') as UserEntity[];
  }

  /**
   * Get a user by Telegram ID.
   */
  getUserByTelegramId(telegramId: number): UserEntity | undefined {
    return this.getUsers().find((u) => u.telegramId === telegramId);
  }

  /**
   * Get all folders.
   */
  getFolders(): FolderEntity[] {
    return this.getByType('folder') as FolderEntity[];
  }

  /**
   * Get a folder by ID.
   */
  getFolder(id: string): FolderEntity | undefined {
    return this.get(id) as FolderEntity | undefined;
  }

  /**
   * Get child folders of a parent folder.
   */
  getChildFolders(parentId: string): FolderEntity[] {
    return this.getFolders().filter((f) => f.parentId === parentId && !f.isDeleted);
  }

  /**
   * Get root folders (no parent).
   */
  getRootFolders(): FolderEntity[] {
    return this.getFolders().filter((f) => f.parentId === null && !f.isDeleted);
  }

  /**
   * Get all resources.
   */
  getResources(): ResourceEntity[] {
    return this.getByType('resource') as ResourceEntity[];
  }

  /**
   * Get a resource by ID.
   */
  getResource(id: string): ResourceEntity | undefined {
    return this.get(id) as ResourceEntity | undefined;
  }

  getResourceVersions(resourceId: string): ResourceVersionEntity[] {
    return (this.getByType('resource_version') as ResourceVersionEntity[])
      .filter((version) => version.resourceId === resourceId)
      .sort((a, b) => a.version - b.version);
  }

  /**
   * Get resources in a folder.
   */
  getResourcesInFolder(folderId: string): ResourceEntity[] {
    return this.getResources().filter((r) => r.folderId === folderId && !r.isDeleted);
  }

  /**
   * Get all audit records.
   */
  getAudits(): AuditEntity[] {
    return this.getByType('audit') as AuditEntity[];
  }

  getSessions(): SessionEntity[] {
    return this.getByType('session') as SessionEntity[];
  }

  getAssistantUsage(telegramId: number): AssistantUsageEntity | undefined {
    return this.get(`assistant_usage:${telegramId}`) as AssistantUsageEntity | undefined;
  }

  /**
   * Search resources by title or tags.
   */
  searchResources(query: string): ResourceEntity[] {
    const lowerQuery = query.toLowerCase();
    return this.getResources().filter(
      (r) =>
        !r.isDeleted &&
        (r.title.toLowerCase().includes(lowerQuery) ||
          r.tags.some((tag) => tag.toLowerCase().includes(lowerQuery)) ||
          (r.description && r.description.toLowerCase().includes(lowerQuery))),
    );
  }

  /**
   * Get recently added resources.
   */
  getRecentlyAdded(limit = 10): ResourceEntity[] {
    return this.getResources()
      .filter((r) => !r.isDeleted)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  /**
   * Get total index size.
   */
  size(): number {
    return this.index.size;
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.index.clear();
    this.typeIndex.clear();
    this.initialized = false;
  }

  /**
   * Persist an entity to the Management Channel and update the index.
   */
  async saveEntity(entity: Entity): Promise<number> {
    return this.withEntityLock(entity.id, async () => {
      const existing = this.getWithMessageId(entity.id);
      if (existing) {
        if (existing.messageId === null) {
          throw new Error(
            `Cannot save entity ${entity.id}: its Telegram message ID is unavailable`,
          );
        }
        return existing.messageId;
      }

      const messageId = await sendEntity(entity);
      this.set(entity, messageId);
      return messageId;
    });
  }

  /**
   * Update an entity in both the index and the Management Channel.
   */
  async updateEntity(entity: Entity): Promise<void> {
    await this.withEntityLock(entity.id, async () => {
      const existing = this.getWithMessageId(entity.id);
      if (!existing || existing.messageId === null) {
        throw new Error(
          `Cannot update entity ${entity.id}: its Telegram message ID is unavailable`,
        );
      }
      await editEntity(existing.messageId, entity);
      this.set(entity, existing.messageId);
    });
  }

  /**
   * Delete an entity from both the index and the Management Channel.
   */
  async deleteEntity(id: string): Promise<void> {
    await this.withEntityLock(id, async () => {
      const existing = this.getWithMessageId(id);
      if (!existing || existing.messageId === null) {
        throw new Error(`Cannot delete entity ${id}: its Telegram message ID is unavailable`);
      }
      await deleteEntity(existing.messageId);
      this.delete(id);
    });
  }

  private async withEntityLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.entityLocks.get(id);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.entityLocks.set(id, current);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this.entityLocks.get(id) === current) {
        this.entityLocks.delete(id);
      }
    }
  }

  /**
   * Consistency check: compare index against the Management Channel.
   */
  async consistencyCheck(): Promise<{ missing: string[]; extra: string[] }> {
    const channelIds = new Set<string>();
    const missing: string[] = [];
    for await (const { entity } of iterateEntityRecords()) {
      channelIds.add(entity.id);
      if (!this.index.has(entity.id)) {
        missing.push(entity.id);
      }
    }

    const extra: string[] = [];
    for (const id of this.index.keys()) {
      if (!channelIds.has(id)) {
        extra.push(id);
      }
    }

    if (missing.length > 0 || extra.length > 0) {
      logger.warn({
        missing: missing.length,
        extra: extra.length,
        msg: 'Index consistency check found discrepancies',
      });
    }

    return { missing, extra };
  }

  /**
   * Rebuild the index from the Management Channel.
   */
  async rebuild(): Promise<void> {
    this.clear();
    await this.build();
  }
}

// Singleton instance
export const index = new EntityIndex();

/**
 * Initialize the index on startup.
 */
export async function initializeIndex(): Promise<void> {
  await index.build();
}

/**
 * Start periodic consistency checks.
 */
export function startConsistencyChecks(intervalMs = 3600 * 1000): () => void {
  let checking = false;
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (!index.isInitialized()) {
        await pauseTelegramUpdates();
        await index.rebuild();
        resumeTelegramUpdates();
        return;
      }

      const result = await index.consistencyCheck();
      if (result.missing.length > 0 || result.extra.length > 0) {
        logger.info({
          missing: result.missing.length,
          extra: result.extra.length,
          msg: 'Rebuilding index due to channel/index discrepancies',
        });
        await pauseTelegramUpdates();
        await index.rebuild();
        resumeTelegramUpdates();
      }
    } catch (err) {
      logger.error({ err, msg: 'Consistency check failed' });
    } finally {
      checking = false;
    }
  }, intervalMs);

  if (typeof interval.unref === 'function') {
    interval.unref();
  }
  return () => clearInterval(interval);
}
