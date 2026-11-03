/**
 * Unit tests for entity models (storage/models.ts).
 * Tests ID generation, parsing, and entity type validation.
 */

import { describe, it, expect } from 'vitest';
import { generateEntityId, parseEntityId, Entity, UserEntity, FolderEntity, ResourceEntity, AuditEntity } from '../models';
import { setupEnv, resetEnv, createMockUser, createMockFolder, createMockResource, createMockAudit } from './helpers';

describe('Entity Models', () => {
  beforeEach(() => {
    setupEnv();
  });

  afterAll(() => {
    resetEnv();
  });

  describe('generateEntityId', () => {
    it('should generate a user entity ID', () => {
      expect(generateEntityId('user', 12345)).toBe('user:12345');
    });

    it('should generate a folder entity ID', () => {
      expect(generateEntityId('folder', 'abc123')).toBe('folder:abc123');
    });

    it('should generate a resource entity ID', () => {
      expect(generateEntityId('resource', 'def456')).toBe('resource:def456');
    });

    it('should generate an audit entity ID', () => {
      expect(generateEntityId('audit', '789')).toBe('audit:789');
    });
  });

  describe('parseEntityId', () => {
    it('should parse a user entity ID', () => {
      const { type, identifier } = parseEntityId('user:12345');
      expect(type).toBe('user');
      expect(identifier).toBe('12345');
    });

    it('should parse a folder entity ID', () => {
      const { type, identifier } = parseEntityId('folder:abc123');
      expect(type).toBe('folder');
      expect(identifier).toBe('abc123');
    });

    it('should parse a resource entity ID', () => {
      const { type, identifier } = parseEntityId('resource:def456');
      expect(type).toBe('resource');
      expect(identifier).toBe('def456');
    });

    it('should parse an audit entity ID', () => {
      const { type, identifier } = parseEntityId('audit:789');
      expect(type).toBe('audit');
      expect(identifier).toBe('789');
    });
  });

  describe('UserEntity', () => {
    it('should create a valid user entity', () => {
      const user = createMockUser();
      expect(user.type).toBe('user');
      expect(user.telegramId).toBe(12345);
      expect(user.role).toBe('user');
      expect(user.status).toBe('active');
    });

    it('should support all user roles', () => {
      const roles = ['owner', 'admin', 'user', 'pending', 'rejected', 'suspended', 'blocked'];
      for (const role of roles) {
        const user = createMockUser({ role });
        expect(user.role).toBe(role);
      }
    });

    it('should support null username and name fields', () => {
      const user = createMockUser({ username: null, firstName: null, lastName: null });
      expect(user.username).toBeNull();
      expect(user.firstName).toBeNull();
      expect(user.lastName).toBeNull();
    });

    it('should support permissions array', () => {
      const user = createMockUser({ permissions: ['user.approve', 'resource.upload'] });
      expect(user.permissions).toHaveLength(2);
      expect(user.permissions).toContain('user.approve');
    });

    it('should support favorites array', () => {
      const user = createMockUser({ favorites: ['resource:1', 'resource:2'] });
      expect(user.favorites).toHaveLength(2);
    });
  });

  describe('FolderEntity', () => {
    it('should create a valid folder entity', () => {
      const folder = createMockFolder();
      expect(folder.type).toBe('folder');
      expect(folder.name).toBe('Test Folder');
      expect(folder.parentId).toBeNull();
      expect(folder.isDeleted).toBe(false);
    });

    it('should support nested folders', () => {
      const child = createMockFolder({
        id: 'folder:child' as `folder:${string}`,
        parentId: 'folder:abc123' as `folder:${string}`,
      });
      expect(child.parentId).toBe('folder:abc123');
    });

    it('should support deleted folders', () => {
      const deleted = createMockFolder({
        isDeleted: true,
        deletedAt: new Date().toISOString(),
      });
      expect(deleted.isDeleted).toBe(true);
      expect(deleted.deletedAt).toBeDefined();
    });
  });

  describe('ResourceEntity', () => {
    it('should create a valid resource entity', () => {
      const resource = createMockResource();
      expect(resource.type).toBe('resource');
      expect(resource.title).toBe('Test Document.pdf');
      expect(resource.fileType).toBe('application/pdf');
      expect(resource.fileSize).toBe(1024);
      expect(resource.version).toBe(1);
      expect(resource.downloadCount).toBe(0);
    });

    it('should support tags', () => {
      const resource = createMockResource({ tags: ['pdf', 'report', '2024'] });
      expect(resource.tags).toHaveLength(3);
    });

    it('should support null folder ID', () => {
      const resource = createMockResource({ folderId: null });
      expect(resource.folderId).toBeNull();
    });

    it('should support deleted resources', () => {
      const deleted = createMockResource({
        isDeleted: true,
        deletedAt: new Date().toISOString(),
      });
      expect(deleted.isDeleted).toBe(true);
    });

    it('should support versioning', () => {
      const v2 = createMockResource({ version: 2 });
      expect(v2.version).toBe(2);
    });

    it('should support download count', () => {
      const resource = createMockResource({ downloadCount: 42 });
      expect(resource.downloadCount).toBe(42);
    });
  });

  describe('AuditEntity', () => {
    it('should create a valid audit entity', () => {
      const audit = createMockAudit();
      expect(audit.type).toBe('audit');
      expect(audit.actorId).toBe(12345);
      expect(audit.action).toBe('user.approved');
      expect(audit.targetId).toBe('user:67890');
    });

    it('should support metadata', () => {
      const audit = createMockAudit({
        metadata: { previousRole: 'user', newRole: 'admin' },
      });
      expect(audit.metadata.previousRole).toBe('user');
      expect(audit.metadata.newRole).toBe('admin');
    });

    it('should support various actions', () => {
      const actions = [
        'user.approved', 'user.rejected', 'user.promoted', 'user.demoted',
        'resource.created', 'resource.deleted', 'resource.restored',
        'folder.created', 'folder.deleted', 'folder.restored',
      ];
      for (const action of actions) {
        const audit = createMockAudit({ action });
        expect(audit.action).toBe(action);
      }
    });
  });
});
