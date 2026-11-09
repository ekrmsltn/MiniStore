export type TextAction =
  | { type: 'search' }
  | { type: 'assistant-question' }
  | { type: 'folder-create'; parentId: string | null }
  | { type: 'folder-rename'; folderId: string }
  | { type: 'resource-rename'; resourceId: string }
  | { type: 'resource-description'; resourceId: string }
  | { type: 'resource-tags'; resourceId: string }
  | { type: 'resource-category'; resourceId: string };

export const textActionState = new Map<number, TextAction>();
export const assistantFlowActive = new Set<number>();
export const assistantThinkingMessages = new Map<number, { chatId: number; messageId: number }>();
export interface AssistantPromptMessage {
  userId: number;
  chatId: number;
  promptMessageId: number;
  replyMessageId: number;
  conversationPrefixLength: number;
}

const MAX_TRACKED_ASSISTANT_PROMPTS_PER_USER = 30;
export const assistantPromptMessages = new Map<string, AssistantPromptMessage>();
export const assistantCancelHint = 'or use /cancel to cancel';

export function getAssistantPromptMessageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function rememberAssistantPrompt(message: AssistantPromptMessage): void {
  const key = getAssistantPromptMessageKey(message.chatId, message.promptMessageId);
  for (const [promptKey, prompt] of assistantPromptMessages) {
    if (
      prompt.userId === message.userId &&
      prompt.conversationPrefixLength > message.conversationPrefixLength
    ) {
      assistantPromptMessages.delete(promptKey);
    }
  }
  assistantPromptMessages.delete(key);
  assistantPromptMessages.set(key, message);

  const userKeys = [...assistantPromptMessages.entries()]
    .filter(([, prompt]) => prompt.userId === message.userId)
    .map(([promptKey]) => promptKey);
  while (userKeys.length > MAX_TRACKED_ASSISTANT_PROMPTS_PER_USER) {
    const oldestKey = userKeys.shift();
    if (oldestKey) assistantPromptMessages.delete(oldestKey);
  }
}

export function clearAssistantPromptMessages(userId: number): void {
  for (const [key, prompt] of assistantPromptMessages) {
    if (prompt.userId === userId) assistantPromptMessages.delete(key);
  }
}
