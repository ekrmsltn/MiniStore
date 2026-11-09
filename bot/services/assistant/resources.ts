import type { ResourceEntity } from '../../models';
import { index } from '../../telegram/index';

type ConversationMessage = { role: 'user' | 'assistant'; content: string };

export interface AssistantResourceContext {
  activeCount: number;
  matchCount: number;
  truncated: boolean;
  items: Array<{
    resourceId: string;
    title: string;
    description: string;
    tags: string[];
    fileName: string;
    fileType: string;
    fileSize: number;
    category: string | null;
    folder: string;
    version: number;
    downloadCount: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

const MAX_ASSISTANT_RESOURCE_RESULTS = 8;
const MAX_ASSISTANT_RESOURCE_DESCRIPTION = 600;
const resourceQueryStopWords = new Set([
  'about',
  'all',
  'available',
  'any',
  'at',
  'are',
  'can',
  'could',
  'description',
  'describe',
  'details',
  'do',
  'document',
  'documents',
  'does',
  'file',
  'files',
  'find',
  'first',
  'for',
  'from',
  'give',
  'have',
  'help',
  'how',
  'id',
  'ids',
  'is',
  'in',
  'it',
  'its',
  'list',
  'me',
  'many',
  'more',
  'one',
  'ones',
  'of',
  'on',
  'please',
  'something',
  'resource',
  'resources',
  'search',
  'second',
  'show',
  'store',
  'tag',
  'tags',
  'tell',
  'the',
  'there',
  'third',
  'that',
  'them',
  'this',
  'to',
  'last',
  'what',
  'which',
  'with',
  'we',
  'you',
  'those',
]);

function normalizeResourceText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function getResourceQueryTerms(question: string): string[] {
  return Array.from(
    new Set(
      normalizeResourceText(question)
        .match(/[\p{L}\p{N}]{2,}/gu)
        ?.filter((term) => !resourceQueryStopWords.has(term) && !/^\d+$/.test(term)) ?? [],
    ),
  ).slice(0, 30);
}

function isResourceCatalogQuestion(question: string): boolean {
  return (
    /\b(resources?|files?|documents?|guides?|manuals?|library|catalog|store)\b/i.test(question) ||
    /\b(do (?:we|you) (?:still )?have|is there|are there|what(?:'s| is) available|looking for|find|search)\b/i.test(
      question,
    )
  );
}

function getResourceFolderPath(folderId: string | null): string {
  if (!folderId) return 'Root';

  const path: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;
  while (currentId && path.length < 10 && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = index.getFolder(currentId);
    if (!folder || folder.isDeleted) return 'Unknown';
    path.push(folder.name.slice(0, 100));
    currentId = folder.parentId;
  }
  return path.reverse().join('/') || 'Unknown';
}

export function getAssistantResourceContext(
  question: string,
  previousMessages: ConversationMessage[],
  activeResources: ResourceEntity[],
): AssistantResourceContext | undefined {
  const recentResourceQuestion =
    [...previousMessages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const recentResourceConversation = isResourceCatalogQuestion(recentResourceQuestion);
  if (!isResourceCatalogQuestion(question) && !recentResourceConversation) return undefined;

  const normalizedQuestion = normalizeResourceText(question);
  const questionTokenSet = new Set(normalizedQuestion.match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  const explicitResourceId = question.match(/\bresource:[a-z0-9_-]+\b/i)?.[0];
  const currentQuestionTerms = getResourceQueryTerms(question);
  const recentResourceTerms = getResourceQueryTerms(recentResourceQuestion);
  const questionTerms =
    currentQuestionTerms.length > 0 ? currentQuestionTerms : recentResourceTerms;
  const broadCatalogFollowUp =
    recentResourceConversation &&
    currentQuestionTerms.length === 0 &&
    recentResourceTerms.length === 0;
  const asksForCatalog =
    broadCatalogFollowUp ||
    (currentQuestionTerms.length === 0 &&
      /\b(all|available|catalog|list|recent|latest|what|which|how many|number of|resources?|files?|documents?)\b/i.test(
        question,
      ));
  const resourceQuestion = isResourceCatalogQuestion(question) || recentResourceConversation;

  const rankedResources = activeResources
    .map((resource) => {
      const folder = getResourceFolderPath(resource.folderId);
      const fields: Array<[string, number]> = [
        [resource.title, 8],
        [resource.tags.join(' '), 7],
        [resource.fileName || '', 6],
        [resource.description, 4],
        [resource.categoryId || '', 3],
        [resource.fileType, 3],
        [folder, 2],
      ];
      const fieldTokens = fields.map(([value, weight]) => ({
        tokens: new Set(normalizeResourceText(value).match(/[\p{L}\p{N}]{2,}/gu) ?? []),
        weight,
      }));
      const score = questionTerms.reduce(
        (total, term) =>
          total +
          Math.max(
            0,
            ...fieldTokens.filter(({ tokens }) => tokens.has(term)).map(({ weight }) => weight),
          ),
        0,
      );
      const exactIdMatch =
        explicitResourceId !== undefined &&
        resource.id.toLowerCase() === explicitResourceId.toLowerCase();
      const titleTokens = normalizeResourceText(resource.title).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
      const titleMatch =
        titleTokens.length > 0 && titleTokens.every((token) => questionTokenSet.has(token));
      return { resource, folder, score, exactIdMatch, titleMatch };
    })
    .filter(
      ({ score, exactIdMatch, titleMatch }) =>
        asksForCatalog || exactIdMatch || titleMatch || score > 0,
    )
    .sort((left, right) => {
      if (left.exactIdMatch !== right.exactIdMatch) return left.exactIdMatch ? -1 : 1;
      if (left.titleMatch !== right.titleMatch) return left.titleMatch ? -1 : 1;
      if (asksForCatalog) {
        return right.resource.updatedAt.localeCompare(left.resource.updatedAt);
      }
      return (
        right.score - left.score || right.resource.updatedAt.localeCompare(left.resource.updatedAt)
      );
    });

  const shouldIncludeResources = resourceQuestion || rankedResources.length > 0;
  if (!shouldIncludeResources) return undefined;

  const items = rankedResources
    .slice(0, MAX_ASSISTANT_RESOURCE_RESULTS)
    .map(({ resource, folder }) => ({
      resourceId: resource.id,
      title: resource.title.slice(0, 200),
      description: resource.description.slice(0, MAX_ASSISTANT_RESOURCE_DESCRIPTION),
      tags: resource.tags.slice(0, 10).map((tag) => tag.slice(0, 100)),
      fileName: (resource.fileName || resource.title).slice(0, 200),
      fileType: resource.fileType.slice(0, 100),
      fileSize: resource.fileSize,
      category: resource.categoryId?.slice(0, 100) ?? null,
      folder,
      version: resource.version,
      downloadCount: resource.downloadCount,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
    }));

  return {
    activeCount: activeResources.length,
    matchCount: rankedResources.length,
    truncated: rankedResources.length > items.length,
    items,
  };
}
