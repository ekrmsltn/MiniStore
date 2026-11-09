import crypto from 'node:crypto';
import { loadConfig } from '../../config';
import type { UserEntity } from '../../models';
import { index } from '../../telegram/index';
import { AVAILABLE_PERMISSIONS } from '../permissions';
import type { AssistantContext, ConversationMessage } from './types';

const config = loadConfig();
const MAX_ASSISTANT_USER_RESULTS = 30;
const userReferenceSecret = crypto.randomBytes(32);

interface LocalUserProfile {
  user: UserEntity;
  reference: string;
  displayName: string | null;
  username: string | null;
}

interface AssistantIdentityContext {
  question: string;
  previousMessages: ConversationMessage[];
  context?: NonNullable<AssistantContext['currentUsers']>;
  profiles: LocalUserProfile[];
  profilesByReference: Map<string, { displayName: string | null; username: string | null }>;
}

function isOwnerIdentityQuestion(question: string): boolean {
  return /\bwho\s+(?:is|'s)\s+(?:the\s+)?owner\b|\b(?:owner|owner['’]s)\s+(?:name|username|handle)\b|\bwho\s+owns\b/i.test(
    question,
  );
}

function isCallerIdentityQuestion(question: string): boolean {
  return /\bwho\s+am\s+i\b|\bwhat(?:['’]s| is)\s+my\s+(?:name|username|handle|account)\b|\bwhat\s+do\s+you\s+know\s+about\s+me\b|\bwho\s+are\s+you\s+talking\s+to\b/i.test(
    question,
  );
}

function getUserReference(telegramId: number): string {
  const digest = crypto
    .createHmac('sha256', userReferenceSecret)
    .update(String(telegramId))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `USER_${digest}`;
}

function getLocalUserProfiles(telegramId: number): LocalUserProfile[] {
  const users = [...index.getUsers()];
  for (const id of new Set([telegramId, config.ownerId])) {
    const user = index.getUserByTelegramId(id);
    if (user && !users.some((candidate) => candidate.telegramId === id)) {
      users.push(user);
    }
  }
  return users.map((user) => {
    const displayName = [user.firstName, user.lastName]
      .filter((name): name is string => Boolean(name?.trim()))
      .join(' ')
      .replace(/\p{Cc}/gu, '')
      .trim()
      .slice(0, 160);
    const username = user.username?.replace(/^@/, '').trim();
    return {
      user,
      reference: getUserReference(user.telegramId),
      displayName: displayName || null,
      username: username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? `@${username}` : null,
    };
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceUserIdentities(
  text: string,
  profiles: LocalUserProfile[],
  allowedReferences: Set<string>,
): string {
  const candidates = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const values = [
      profile.displayName,
      profile.username,
      profile.username?.slice(1),
      String(profile.user.telegramId),
    ].filter((value): value is string => Boolean(value));
    for (const value of values) {
      const key = value.toLocaleLowerCase();
      const references = candidates.get(key) ?? new Set<string>();
      references.add(profile.reference);
      candidates.set(key, references);
    }
  }
  if (candidates.size === 0) return text;

  let redacted = text;
  const lowerText = text.toLocaleLowerCase();
  for (const [value, candidateReferences] of [...candidates.entries()].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    if (!lowerText.includes(value)) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    const references = [...candidateReferences].filter((reference) =>
      allowedReferences.has(reference),
    );
    redacted = redacted.replace(
      pattern,
      references.length > 0 ? references.join(' and ') : '[PRIVATE_USER]',
    );
  }
  return redacted;
}

export function getAssistantIdentityContext(
  telegramId: number,
  question: string,
  previousMessages: ConversationMessage[],
): AssistantIdentityContext {
  const profiles = getLocalUserProfiles(telegramId);
  const isOwner = String(telegramId) === String(config.ownerId);
  const callerProfile = profiles.find((profile) => profile.user.telegramId === telegramId);
  const ownerProfile = profiles.find((profile) => profile.user.telegramId === config.ownerId);
  const previousReferences = new Set(
    previousMessages
      .flatMap((message) => message.content.match(/\bUSER_[A-F0-9]{12}\b/g) ?? [])
      .map((reference) => reference.toUpperCase()),
  );
  const mentionedProfiles = profiles.filter((profile) => {
    const values = [profile.displayName, profile.username, profile.username?.slice(1)].filter(
      (value): value is string => Boolean(value),
    );
    return values.some((value) => {
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`,
        'iu',
      );
      return pattern.test(question);
    });
  });
  const userQuestion =
    /\b(?:users?|admins?|accounts?|members?|people|identit(?:y|ies)|usernames?|permissions?)\b/i.test(
      question,
    ) ||
    isOwnerIdentityQuestion(question) ||
    isCallerIdentityQuestion(question) ||
    mentionedProfiles.length > 0 ||
    previousReferences.size > 0;
  const previousOwnerIdentityQuestion =
    previousMessages.some(
      (message) => message.role === 'user' && isOwnerIdentityQuestion(message.content),
    ) && /\b(?:name|username|handle)\b/i.test(question);
  const isPublicOwnerIdentityQuestion =
    !isOwner && (isOwnerIdentityQuestion(question) || previousOwnerIdentityQuestion);
  let selectedProfiles: LocalUserProfile[] = [];
  if (isOwner && userQuestion) {
    if (isCallerIdentityQuestion(question)) {
      selectedProfiles = callerProfile ? [callerProfile] : [];
    } else if (isOwnerIdentityQuestion(question)) {
      selectedProfiles = ownerProfile ? [ownerProfile] : [];
    } else if (mentionedProfiles.length > 0) {
      selectedProfiles = mentionedProfiles;
    } else if (
      /\b(?:all|list|every|users?|admins?|accounts?|members?|people|permissions?)\b/i.test(question)
    ) {
      selectedProfiles = profiles;
    }
    if (previousReferences.size > 0) {
      selectedProfiles = profiles.filter(
        (profile) =>
          previousReferences.has(profile.reference) ||
          selectedProfiles.some((selected) => selected.reference === profile.reference),
      );
    }
  } else if (isCallerIdentityQuestion(question) && callerProfile) {
    selectedProfiles = [callerProfile];
  } else if (isPublicOwnerIdentityQuestion && ownerProfile) {
    selectedProfiles = [ownerProfile];
  }

  const boundedProfiles = selectedProfiles.slice(0, MAX_ASSISTANT_USER_RESULTS);
  const selectedReferences = new Set(boundedProfiles.map((profile) => profile.reference));
  const maskedQuestion = replaceUserIdentities(question, profiles, selectedReferences);
  const maskedPreviousMessages = previousMessages.map((message) => ({
    ...message,
    content: replaceUserIdentities(message.content, profiles, selectedReferences),
  }));
  const profilesByReference = new Map(
    boundedProfiles.map((profile) => [
      profile.reference,
      {
        displayName: profile.displayName,
        username: profile.username,
      },
    ]),
  );

  return {
    question: maskedQuestion,
    previousMessages: maskedPreviousMessages,
    profiles,
    ...(boundedProfiles.length > 0
      ? {
          context: {
            totalCount: selectedProfiles.length,
            truncated: selectedProfiles.length > boundedProfiles.length,
            items: boundedProfiles.map((profile) => ({
              reference: profile.reference,
              subject:
                profile.user.telegramId === telegramId
                  ? 'current_caller'
                  : profile.user.telegramId === config.ownerId
                    ? 'configured_owner'
                    : 'account',
              ...(isOwner
                ? {
                    role: profile.user.role,
                    status: profile.user.status,
                    permissions:
                      profile.user.role === 'admin'
                        ? AVAILABLE_PERMISSIONS.filter((permission) =>
                            profile.user.permissions.includes(permission),
                          )
                        : [],
                    createdAt: profile.user.createdAt.slice(0, 10),
                  }
                : {}),
            })),
          },
        }
      : {}),
    profilesByReference,
  };
}

export function restoreUserIdentities(
  answer: string,
  profilesByReference: AssistantIdentityContext['profilesByReference'],
): string {
  return answer.replace(
    /\[\[MINISTORE_USER:(USER_[A-F0-9]{12})\]\]/gi,
    (_marker, reference: string) => {
      const profile = profilesByReference.get(reference.toUpperCase());
      if (!profile) return '';
      const username = profile.username
        ? ` [@${profile.username.slice(1)}](https://t.me/${profile.username.slice(1)})`
        : '';
      return profile.displayName
        ? `**${profile.displayName}**${username}`
        : username.trim() || 'an account';
    },
  );
}
