/**
 * Unit tests for custom error classes.
 * Tests error hierarchy, status codes, and messages.
 */

import { describe, it, expect } from 'vitest';
import {
  AppError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  RateLimitError,
  TelegramApiError,
} from '../errors';

describe('Custom Error Classes', () => {
  describe('AppError', () => {
    it('should set message and status code', () => {
      const err = new AppError('Test error', 500);
      expect(err.message).toBe('Test error');
      expect(err.statusCode).toBe(500);
      expect(err.isOperational).toBe(true);
      expect(err.name).toBe('AppError');
    });

    it('should be operational by default', () => {
      const err = new AppError('Test', 500);
      expect(err.isOperational).toBe(true);
    });

    it('should support non-operational errors', () => {
      const err = new AppError('Test', 500, false);
      expect(err.isOperational).toBe(false);
    });

    it('should extend Error', () => {
      const err = new AppError('Test', 500);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('NotFoundError', () => {
    it('should have 404 status code', () => {
      const err = new NotFoundError('User');
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe('User not found');
      expect(err.name).toBe('NotFoundError');
    });

    it('should extend AppError', () => {
      const err = new NotFoundError('Resource');
      expect(err).toBeInstanceOf(AppError);
    });
  });

  describe('UnauthorizedError', () => {
    it('should have 401 status code', () => {
      const err = new UnauthorizedError();
      expect(err.statusCode).toBe(401);
      expect(err.message).toBe('Unauthorized');
      expect(err.name).toBe('UnauthorizedError');
    });

    it('should support custom message', () => {
      const err = new UnauthorizedError('Invalid token');
      expect(err.message).toBe('Invalid token');
    });
  });

  describe('ForbiddenError', () => {
    it('should have 403 status code', () => {
      const err = new ForbiddenError();
      expect(err.statusCode).toBe(403);
      expect(err.message).toBe('Forbidden');
      expect(err.name).toBe('ForbiddenError');
    });

    it('should support custom message', () => {
      const err = new ForbiddenError('Admin access required');
      expect(err.message).toBe('Admin access required');
    });
  });

  describe('ValidationError', () => {
    it('should have 400 status code', () => {
      const err = new ValidationError('Invalid input');
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe('Invalid input');
      expect(err.name).toBe('ValidationError');
    });
  });

  describe('ConflictError', () => {
    it('should have 409 status code', () => {
      const err = new ConflictError();
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe('Resource already exists');
      expect(err.name).toBe('ConflictError');
    });

    it('should support custom message', () => {
      const err = new ConflictError('Duplicate entry');
      expect(err.message).toBe('Duplicate entry');
    });
  });

  describe('RateLimitError', () => {
    it('should have 429 status code', () => {
      const err = new RateLimitError();
      expect(err.statusCode).toBe(429);
      expect(err.message).toBe('Rate limit exceeded');
      expect(err.name).toBe('RateLimitError');
    });
  });

  describe('TelegramApiError', () => {
    it('should have 502 status code by default', () => {
      const err = new TelegramApiError('Connection failed');
      expect(err.statusCode).toBe(502);
      expect(err.message).toBe('Telegram API error: Connection failed');
      expect(err.name).toBe('TelegramApiError');
      expect(err.isOperational).toBe(false);
    });

    it('should support custom status code', () => {
      const err = new TelegramApiError('Not found', 404);
      expect(err.statusCode).toBe(404);
    });
  });
});
