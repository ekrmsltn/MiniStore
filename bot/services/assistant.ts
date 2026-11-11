import { loadConfig } from '../config';
import { ForbiddenError, RateLimitError, ValidationError } from '../errors';
import { index } from '../telegram/index';
import { AssistantUsageEntity, type ResourceEntity } from '../models';
import { canAccessStore } from './users';
import { AVAILABLE_PERMISSIONS, hasPermission } from './permissions';
import { getAssistantKnowledge } from './assistant-knowledge';
import { getAssistantResourceContext } from './assistant/resources';
import { canAccessFolder, canAccessResource } from './visibility';
import {
  getAssistantIdentityContext,
  replaceUserIdentities,
  restoreUserIdentities,
} from './assistant/identity';
import type { AssistantContext, ConversationMessage } from './assistant/types';
export { formatAssistantResponse, prepareAssistantReply } from './assistant/formatting';
import { extractAnswer, getEndpoint, systemPrompt } from './assistant/provider';

const config = loadConfig();
const MAX_QUESTION_LENGTH = 1_500;
const MAX_ANSWER_LENGTH = 3_800;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_COOLDOWN_MS = 10_000;
const ASSISTANT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CONVERSATION_TTL_MS = 30 * 60 * 1_000;
const MAX_CONVERSATION_MESSAGES = 10;
const recentRequests = new Map<number, number>();
const requestLocks = new Map<number, Promise<void>>();
interface ConversationState {
  messages: ConversationMessage[];
  updatedAt: number;
  startIndex: number;
  resourceAccessFingerprint?: string;
}
const conversations = new Map<number, ConversationState>();
const inFlightRequests = new Map<number, AbortController>();
export class AssistantProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantProviderError';
  }
}

export class AssistantCancelledError extends Error {
  constructor() {
    super('The assistant request was cancelled');
    this.name = 'AssistantCancelledError';
  }
}

export interface AssistantUsageStatus {
  role: 'owner' | 'admin' | 'user';
  used: number;
  limit: number | null;
  remaining: number | null;
  resetsAt: Date | null;
}

export interface AssistantReply {
  answer: string;
  conversationAnswer: string;
  resourceIds: string[];
}

export interface AssistantUsageOverview {
  totalUsers: number;
  activeUsers: number;
  activeAdmins: number;
  pendingUsers: number;
  suspendedUsers: number;
  blockedUsers: number;
  entries: Array<{
    name: string;
    role: string;
    status: string;
    usage: AssistantUsageStatus | null;
  }>;
}

function getUsageSnapshot(
  telegramId: number,
  role: 'owner' | 'admin' | 'user',
): AssistantUsageStatus {
  if (role === 'owner') {
    return { role, used: 0, limit: null, remaining: null, resetsAt: null };
  }

  const now = Date.now();
  const { requestTimestamps, windowStartedAt } = getActiveUsageWindow(
    index.getAssistantUsage(telegramId),
    now,
  );
  const limit = role === 'admin' ? 100 : 50;

  return {
    role,
    used: requestTimestamps.length,
    limit,
    remaining: Math.max(0, limit - requestTimestamps.length),
    resetsAt:
      requestTimestamps.length > 0 && windowStartedAt !== null
        ? new Date(windowStartedAt + ASSISTANT_USAGE_WINDOW_MS)
        : null,
  };
}

function getActiveUsageWindow(
  usage: AssistantUsageEntity | undefined,
  now: number,
): { requestTimestamps: string[]; windowStartedAt: number | null } {
  if (!usage) return { requestTimestamps: [], windowStartedAt: null };

  const requestTimestamps = usage.requestTimestamps
    .map((timestamp) => ({ timestamp, time: Date.parse(timestamp) }))
    .filter(({ time }) => Number.isFinite(time) && time <= now)
    .sort((left, right) => left.time - right.time);
  const storedStart = usage.windowStartedAt ? Date.parse(usage.windowStartedAt) : Number.NaN;
  const windowStartedAt =
    Number.isFinite(storedStart) && storedStart <= now
      ? storedStart
      : (requestTimestamps[0]?.time ?? null);

  if (windowStartedAt === null || now >= windowStartedAt + ASSISTANT_USAGE_WINDOW_MS) {
    return { requestTimestamps: [], windowStartedAt: null };
  }

  return {
    requestTimestamps: requestTimestamps
      .filter(({ time }) => time >= windowStartedAt)
      .map(({ timestamp }) => timestamp),
    windowStartedAt,
  };
}

interface ResolvedAssistantContext {
  context: AssistantContext;
  activeResources: ResourceEntity[];
}

export function getAssistantUsageStatus(telegramId: number): AssistantUsageStatus {
  if (!canAccessStore(telegramId)) {
    throw new ForbiddenError('You need an active MiniStore account to view assistant usage');
  }

  const role =
    String(telegramId) === String(config.ownerId)
      ? 'owner'
      : index.getUserByTelegramId(telegramId)?.role === 'admin'
        ? 'admin'
        : 'user';
  return getUsageSnapshot(telegramId, role);
}

export function getAssistantUsageOverview(ownerId: number): AssistantUsageOverview {
  if (ownerId !== config.ownerId) {
    throw new ForbiddenError('Only the configured owner can view all-user assistant usage');
  }

  const users = index
    .getUsers()
    .filter((user) => user.telegramId !== config.ownerId)
    .sort((left, right) => {
      const byRole = left.role.localeCompare(right.role);
      if (byRole !== 0) return byRole;
      const byStatus = left.status.localeCompare(right.status);
      if (byStatus !== 0) return byStatus;
      return (left.firstName || left.username || '').localeCompare(
        right.firstName || right.username || '',
      );
    });

  return {
    totalUsers: users.length,
    activeUsers: users.filter((user) => user.role === 'user' && user.status === 'active').length,
    activeAdmins: users.filter((user) => user.role === 'admin' && user.status === 'active').length,
    pendingUsers: users.filter((user) => user.role === 'pending').length,
    suspendedUsers: users.filter((user) => user.status === 'suspended').length,
    blockedUsers: users.filter((user) => user.status === 'blocked').length,
    entries: users.map((user) => {
      const role = user.role === 'admin' ? 'admin' : user.role === 'user' ? 'user' : null;
      return {
        name:
          [user.firstName, user.lastName].filter(Boolean).join(' ') ||
          user.username ||
          String(user.telegramId),
        role: user.role,
        status: user.status,
        usage: role ? getUsageSnapshot(user.telegramId, role) : null,
      };
    }),
  };
}

function getAssistantContext(telegramId: number): ResolvedAssistantContext {
  if (!canAccessStore(telegramId)) {
    cancelAssistantConversation(telegramId);
    throw new ForbiddenError('You need an active MiniStore account to use the assistant');
  }

  const isOwner = String(telegramId) === String(config.ownerId);
  const user = index.getUserByTelegramId(telegramId);
  const role = isOwner ? 'owner' : user?.role || 'user';
  const permissions = isOwner
    ? ['all']
    : AVAILABLE_PERMISSIONS.filter((permission) => hasPermission(telegramId, permission));

  const activeResources = index
    .getResources()
    .filter((resource) => !resource.isDeleted && canAccessResource(telegramId, resource));
  const activeFolders = index
    .getFolders()
    .filter((folder) => !folder.isDeleted && canAccessFolder(telegramId, folder.id));
  const activity: Record<string, number> = {
    activeResources: activeResources.length,
    activeFolders: activeFolders.length,
    totalDownloads: activeResources.reduce((total, resource) => total + resource.downloadCount, 0),
  };

  if (hasPermission(telegramId, 'manage_users')) {
    const activeUsers = index.getUsers().filter((entry) => entry.status === 'active');
    activity.activeUsers = activeUsers.length;
    activity.pendingRequests = index.getUsers().filter((entry) => entry.role === 'pending').length;
  }

  if (hasPermission(telegramId, 'view_audit_logs')) {
    const recentAudit = index
      .getAudits()
      .filter((entry) => Date.now() - Date.parse(entry.timestamp) <= 30 * 24 * 60 * 60 * 1000);
    activity.auditEventsLast30Days = recentAudit.length;
  }

  return {
    context: {
      role,
      permissions,
      knowledge: getAssistantKnowledge(role, permissions),
      activity,
    },
    activeResources,
  };
}

function getAssistantAccessFingerprint(telegramId: number): string {
  const resources = index
    .getResources()
    .filter((resource) => !resource.isDeleted && canAccessResource(telegramId, resource))
    .map((resource) => resource.id)
    .sort();
  const folders = index
    .getFolders()
    .filter((folder) => !folder.isDeleted && canAccessFolder(telegramId, folder.id))
    .map((folder) => folder.id)
    .sort();
  return JSON.stringify({ resources, folders });
}

function sanitizeAssistantAnswer(
  answer: string,
  currentResources: AssistantContext['currentResources'],
  currentUsers: AssistantContext['currentUsers'],
): AssistantReply {
  const allowedIds = new Map(
    (currentResources?.items ?? []).map((resource) => [
      resource.resourceId.toLowerCase(),
      resource.resourceId,
    ]),
  );
  const resourceIds: string[] = [];
  const allowedUserReferences = new Map(
    (currentUsers?.items ?? []).map((profile) => [
      profile.reference.toUpperCase(),
      profile.reference.toUpperCase(),
    ]),
  );
  const selectedIds = new Set<string>();
  const answerWithoutMarkers = answer.replace(
    /\[\[MINISTORE_DOWNLOADS:([^\]]*)\]\]/gi,
    (_marker, ids: string) => {
      for (const candidate of ids.split(',')) {
        const resourceId = allowedIds.get(candidate.trim().toLowerCase());
        if (resourceId && !selectedIds.has(resourceId)) {
          selectedIds.add(resourceId);
          resourceIds.push(resourceId);
        }
      }
      return '';
    },
  );
  const sanitizedAnswer = answerWithoutMarkers
    .replace(/^.*\bresource:[a-z0-9_-]+\b.*$/gim, '')
    .replace(/^\s*(?:[-*•]\s*)?(?:resource\s*)?ids?\s*[:-].*$/gim, '')
    .replace(/^\s*(?:[-*•]\s*)?tags?\s*(?::|-|includes?\b).*$/gim, '')
    .replace(/\[\[MINISTORE_USER:[^\]]*(?:\]\]?|$)|\bUSER_[A-Z0-9_]+\b/gi, (marker) => {
      const reference = marker.startsWith('[[')
        ? marker.match(/^\[\[MINISTORE_USER:(USER_[A-F0-9]{12})\]\]$/i)?.[1]
        : marker;
      const allowedReference = reference && allowedUserReferences.get(reference.toUpperCase());
      return allowedReference ? `[[MINISTORE_USER:${allowedReference}]]` : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const safeAnswer =
    sanitizedAnswer ||
    (resourceIds.length > 0
      ? 'I found a matching resource. Use the Download button below.'
      : currentResources
        ? 'I could not find a matching active resource.'
        : 'I could not prepare a safe answer. Please rephrase your question.');
  if (resourceIds.length === 0 && sanitizedAnswer) {
    for (const resource of currentResources?.items ?? []) {
      if (sanitizedAnswer.toLowerCase().includes(resource.title.toLowerCase())) {
        resourceIds.push(resource.resourceId);
      }
    }
  }

  return {
    answer: safeAnswer,
    conversationAnswer: safeAnswer,
    resourceIds,
  };
}

async function reserveAssistantRequest(telegramId: number, role: string): Promise<void> {
  const previous = requestLocks.get(telegramId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  requestLocks.set(telegramId, current);
  await previous;

  try {
    const now = Date.now();
    if (role !== 'owner') {
      const previousRequest = recentRequests.get(telegramId);
      if (previousRequest !== undefined && now - previousRequest < USER_COOLDOWN_MS) {
        throw new ValidationError('Please wait a few seconds before asking the assistant again');
      }

      for (const [userId, requestedAt] of recentRequests) {
        if (now - requestedAt >= USER_COOLDOWN_MS) recentRequests.delete(userId);
      }

      const existing = index.getAssistantUsage(telegramId);
      const limit = role === 'admin' ? 100 : 50;
      const activeWindow = getActiveUsageWindow(existing, now);
      const requestTimestamps = activeWindow.requestTimestamps;
      const windowStartedAt = activeWindow.windowStartedAt ?? now;
      if (requestTimestamps.length >= limit) {
        const nextAvailableAt = windowStartedAt + ASSISTANT_USAGE_WINDOW_MS;
        throw new RateLimitError(
          `You've reached your limit of ${limit} assistant requests in 24 hours. Your next request will be available at ${new Date(nextAvailableAt).toISOString()} (UTC).`,
        );
      }

      const timestamp = new Date(now).toISOString();
      const updated: AssistantUsageEntity = {
        type: 'assistant_usage',
        id: `assistant_usage:${telegramId}`,
        telegramId,
        requestTimestamps: [...requestTimestamps, timestamp],
        windowStartedAt: new Date(windowStartedAt).toISOString(),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) {
        await index.updateEntity(updated);
      } else {
        await index.saveEntity(updated);
      }
      recentRequests.set(telegramId, now);
    }
  } finally {
    release();
    if (requestLocks.get(telegramId) === current) requestLocks.delete(telegramId);
  }
}

function getConversationState(telegramId: number): ConversationState {
  const now = Date.now();
  for (const [userId, conversation] of conversations) {
    if (now - conversation.updatedAt >= CONVERSATION_TTL_MS) conversations.delete(userId);
  }
  return conversations.get(telegramId) ?? { messages: [], updatedAt: now, startIndex: 0 };
}

function getConversation(telegramId: number): ConversationMessage[] {
  return getConversationState(telegramId).messages;
}

export function cancelAssistantConversation(telegramId: number): void {
  inFlightRequests.get(telegramId)?.abort();
  inFlightRequests.delete(telegramId);
  conversations.delete(telegramId);
  recentRequests.delete(telegramId);
}

export function isAssistantConfigured(): boolean {
  return Boolean(config.aiBaseUrl && config.apiKey && config.aiModel);
}

export function getAssistantConversationLength(telegramId: number): number {
  const conversation = getConversationState(telegramId);
  return conversation.startIndex + conversation.messages.length;
}

export async function askAssistantWithResources(
  telegramId: number,
  question: string,
  options: { conversationPrefixLength?: number } = {},
): Promise<AssistantReply> {
  if (!isAssistantConfigured() || !config.aiBaseUrl || !config.apiKey || !config.aiModel) {
    throw new ValidationError(
      'The MiniStore assistant has not been configured by the administrator',
    );
  }
  if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_LENGTH) {
    throw new ValidationError(`Ask a question of 1–${MAX_QUESTION_LENGTH} characters`);
  }

  const { context, activeResources } = getAssistantContext(telegramId);
  await reserveAssistantRequest(telegramId, context.role);
  const resourceAccessFingerprint = getAssistantAccessFingerprint(telegramId);
  let conversation = getConversationState(telegramId);
  if (conversation.resourceAccessFingerprint !== resourceAccessFingerprint) {
    conversations.delete(telegramId);
    conversation = { messages: [], updatedAt: Date.now(), startIndex: 0 };
  }
  conversation.resourceAccessFingerprint = resourceAccessFingerprint;
  if (options.conversationPrefixLength !== undefined) {
    const absolutePrefixLength = Math.max(
      0,
      Math.min(
        options.conversationPrefixLength,
        conversation.startIndex + conversation.messages.length,
      ),
    );
    const relativePrefixLength = Math.max(0, absolutePrefixLength - conversation.startIndex);
    conversation = {
      messages: conversation.messages.slice(0, relativePrefixLength),
      updatedAt: Date.now(),
      startIndex: Math.min(absolutePrefixLength, conversation.startIndex),
      resourceAccessFingerprint,
    };
    conversations.set(telegramId, conversation);
  }
  const identityContext = getAssistantIdentityContext(
    telegramId,
    question,
    getConversation(telegramId),
  );
  const previousMessages = identityContext.previousMessages;
  context.currentUsers = identityContext.context;
  context.currentResources = getAssistantResourceContext(
    question,
    previousMessages,
    activeResources,
  );
  const controller = new AbortController();
  inFlightRequests.get(telegramId)?.abort();
  inFlightRequests.set(telegramId, controller);

  const isAnthropic = config.aiApiFormat === 'anthropic';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(isAnthropic
      ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${config.apiKey}` }),
  };
  const contextAndQuestion = [
    'Verified caller role, permissions, credential-free MiniStore knowledge, and permitted aggregate facts (JSON):',
    JSON.stringify(context),
    'Recent conversation (JSON; use only for this conversation and follow the current verified role and permissions):',
    JSON.stringify(previousMessages),
    'User question:',
    identityContext.question.trim(),
  ].join('\n');
  const body = isAnthropic
    ? {
        model: config.aiModel,
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: contextAndQuestion }],
      }
    : {
        model: config.aiModel,
        max_tokens: 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contextAndQuestion },
        ],
      };

  try {
    let response: Response;
    try {
      response = await fetch(getEndpoint(config.aiBaseUrl, config.aiApiFormat), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch {
      if (controller.signal.aborted) throw new AssistantCancelledError();
      throw new AssistantProviderError(
        'The AI service could not be reached. Please try again later.',
      );
    }

    if (controller.signal.aborted) throw new AssistantCancelledError();
    if (!response.ok) {
      throw new AssistantProviderError(
        `The AI service returned HTTP ${response.status}. Please try again later.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw new AssistantCancelledError();
      throw new AssistantProviderError('The AI service returned an invalid response.');
    }

    const answer = extractAnswer(payload, config.aiApiFormat);
    if (!answer) throw new AssistantProviderError('The AI service returned no answer.');
    if (controller.signal.aborted) throw new AssistantCancelledError();
    if (!canAccessStore(telegramId)) {
      throw new ForbiddenError('You need an active MiniStore account to use the assistant');
    }
    const currentResourceAccessFingerprint = getAssistantAccessFingerprint(telegramId);
    if (currentResourceAccessFingerprint !== resourceAccessFingerprint) {
      throw new AssistantProviderError(
        'Your resource access changed while I was preparing this answer. Please ask again.',
      );
    }

    const identitySafeAnswer = context.currentUsers
      ? replaceUserIdentities(
          answer,
          identityContext.profiles,
          new Set(context.currentUsers.items.map((profile) => profile.reference)),
        ).replace(/\[PRIVATE_USER\]/g, 'a user')
      : answer;
    const reply = sanitizeAssistantAnswer(
      identitySafeAnswer,
      context.currentResources,
      context.currentUsers,
    );
    const conversationAnswer = reply.conversationAnswer.slice(0, MAX_ANSWER_LENGTH);
    const unboundedMessages: ConversationMessage[] = [
      ...previousMessages,
      { role: 'user' as const, content: identityContext.question.trim() },
      { role: 'assistant' as const, content: conversationAnswer },
    ];
    const messages = unboundedMessages.slice(-MAX_CONVERSATION_MESSAGES);
    conversations.set(telegramId, {
      messages,
      updatedAt: Date.now(),
      startIndex: conversation.startIndex + unboundedMessages.length - messages.length,
      resourceAccessFingerprint,
    });
    const limitedAnswer = reply.answer.slice(0, MAX_ANSWER_LENGTH);
    return {
      ...reply,
      answer: restoreUserIdentities(limitedAnswer, identityContext.profilesByReference),
      conversationAnswer,
    };
  } finally {
    if (inFlightRequests.get(telegramId) === controller) {
      inFlightRequests.delete(telegramId);
    }
  }
}

export async function askAssistant(telegramId: number, question: string): Promise<string> {
  return (await askAssistantWithResources(telegramId, question)).answer;
}
