import { ValidationError } from '../errors';
import { index } from '../telegram/index';

const directoryLocks = new Map<string, Promise<void>>();

export async function withDirectoryLock<T>(
  directoryId: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  const key = directoryId ?? '\0root';
  const previous = directoryLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  directoryLocks.set(key, current);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (directoryLocks.get(key) === current) {
      directoryLocks.delete(key);
    }
  }
}

export function getDirectoryEntryNames(
  directoryId: string | null,
  excludeEntityId?: string,
): string[] {
  const folderNames = index
    .getFolders()
    .filter(
      (folder) =>
        !folder.isDeleted && folder.parentId === directoryId && folder.id !== excludeEntityId,
    )
    .map((folder) => folder.name);
  const resourceNames = index
    .getResources()
    .filter(
      (resource) =>
        !resource.isDeleted && resource.folderId === directoryId && resource.id !== excludeEntityId,
    )
    .flatMap((resource) => [resource.title, resource.fileName || resource.title]);

  return [...folderNames, ...resourceNames];
}

export function uniqueDirectoryEntryName(
  name: string,
  directoryId: string | null,
  excludeEntityId?: string,
  maxLength = 500,
): string {
  return uniqueName(name, getDirectoryEntryNames(directoryId, excludeEntityId), maxLength);
}

export function uniqueName(name: string, existingNames: string[], maxLength: number): string {
  const trimmedName = name.trim();
  if (!trimmedName) throw new ValidationError('Name is required');
  if (trimmedName.length > maxLength) {
    throw new ValidationError(`Name must be ${maxLength} characters or less`);
  }

  const existing = new Set(existingNames.map(normalizeName));
  if (!existing.has(normalizeName(trimmedName))) return trimmedName;

  const dot = trimmedName.lastIndexOf('.');
  const hasExtension = dot > 0;
  const stem = hasExtension ? trimmedName.slice(0, dot) : trimmedName;
  const extension = hasExtension ? trimmedName.slice(dot) : '';

  for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
    const suffixText = ` (${suffix})`;
    const candidateStemLength = maxLength - suffixText.length - extension.length;
    if (candidateStemLength < 1) {
      throw new ValidationError(`Name cannot be made unique within ${maxLength} characters`);
    }
    const candidate = `${stem.slice(0, candidateStemLength)}${suffixText}${extension}`;
    if (!existing.has(normalizeName(candidate))) return candidate;
  }

  throw new ValidationError('Could not generate a unique name');
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}
