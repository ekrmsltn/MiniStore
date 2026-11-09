import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setupEnv } from './helpers';

describe('assistant prompt edits', () => {
  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    vi.doMock('../logger', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
    vi.doMock('../services/folders', () => ({ createFolder: vi.fn(), renameFolder: vi.fn() }));
    vi.doMock('../services/resources', () => ({ updateResource: vi.fn() }));
    vi.doMock('../services/permissions', () => ({ hasPermission: vi.fn() }));
    vi.doMock('../handlers/assistant-ui', () => ({ replyWithAssistant: vi.fn() }));
    vi.doMock('../handlers/screens', () => ({
      showAdminFolder: vi.fn(),
      showBrowse: vi.fn(),
      showResource: vi.fn(),
      showSearchResults: vi.fn(),
    }));
  });

  afterAll(() => {
    resetEnv();
  });

  it('resubmits an edited prompt with its prior reply and conversation checkpoint', async () => {
    const { registerTextActionHandlers } = await import('../handlers/text-actions');
    const { assistantFlowActive, assistantPromptMessages, getAssistantPromptMessageKey } =
      await import('../handlers/state');
    const { replyWithAssistant } = await import('../handlers/assistant-ui');
    const registered: Array<[string, (ctx: unknown) => unknown]> = [];
    const bot = {
      on: (filter: string, handler: (ctx: unknown) => unknown) => {
        registered.push([filter, handler]);
      },
    };
    registerTextActionHandlers(bot as never);
    assistantFlowActive.add(24680);
    assistantPromptMessages.set(getAssistantPromptMessageKey(24680, 31), {
      userId: 24680,
      chatId: 24680,
      promptMessageId: 31,
      replyMessageId: 32,
      conversationPrefixLength: 4,
    });

    const editedMessageHandler = registered.find(
      ([filter]) => filter === 'edited_message:text',
    )?.[1];
    expect(editedMessageHandler).toBeDefined();
    await editedMessageHandler?.({
      editedMessage: { message_id: 31, text: 'Revised prompt', entities: [] },
      from: { id: 24680 },
      chat: { id: 24680, type: 'private' },
      reply: vi.fn(),
    });

    expect(replyWithAssistant).toHaveBeenCalledWith(
      expect.anything(),
      24680,
      'Revised prompt',
      31,
      expect.objectContaining({
        replyMessageId: 32,
        conversationPrefixLength: 4,
      }),
    );
  });

  it('extracts the question when an edited prompt is an /ask command', async () => {
    const { registerTextActionHandlers } = await import('../handlers/text-actions');
    const { assistantFlowActive, assistantPromptMessages, getAssistantPromptMessageKey } =
      await import('../handlers/state');
    const { replyWithAssistant } = await import('../handlers/assistant-ui');
    const registered: Array<[string, (ctx: unknown) => unknown]> = [];
    const bot = {
      on: (filter: string, handler: (ctx: unknown) => unknown) => {
        registered.push([filter, handler]);
      },
    };
    registerTextActionHandlers(bot as never);
    assistantFlowActive.add(24680);
    assistantPromptMessages.set(getAssistantPromptMessageKey(24680, 41), {
      userId: 24680,
      chatId: 24680,
      promptMessageId: 41,
      replyMessageId: 42,
      conversationPrefixLength: 0,
    });

    const editedMessageHandler = registered.find(
      ([filter]) => filter === 'edited_message:text',
    )?.[1];
    await editedMessageHandler?.({
      editedMessage: {
        message_id: 41,
        text: '/ask@ministore_bot Find the latest guide',
        entities: [{ type: 'bot_command', offset: 0, length: 18 }],
      },
      from: { id: 24680 },
      chat: { id: 24680, type: 'private' },
      reply: vi.fn(),
    });

    expect(replyWithAssistant).toHaveBeenCalledWith(
      expect.anything(),
      24680,
      'Find the latest guide',
      41,
      expect.objectContaining({ replyMessageId: 42 }),
    );
  });

  it('ignores edits from another user', async () => {
    const { registerTextActionHandlers } = await import('../handlers/text-actions');
    const { assistantFlowActive, assistantPromptMessages, getAssistantPromptMessageKey } =
      await import('../handlers/state');
    const { replyWithAssistant } = await import('../handlers/assistant-ui');
    const registered: Array<[string, (ctx: unknown) => unknown]> = [];
    const bot = {
      on: (filter: string, handler: (ctx: unknown) => unknown) => {
        registered.push([filter, handler]);
      },
    };
    registerTextActionHandlers(bot as never);
    assistantFlowActive.add(24680);
    assistantPromptMessages.set(getAssistantPromptMessageKey(24680, 51), {
      userId: 24680,
      chatId: 24680,
      promptMessageId: 51,
      replyMessageId: 52,
      conversationPrefixLength: 0,
    });

    const editedMessageHandler = registered.find(
      ([filter]) => filter === 'edited_message:text',
    )?.[1];
    await editedMessageHandler?.({
      editedMessage: { message_id: 51, text: 'Changed by another user', entities: [] },
      from: { id: 98765 },
      chat: { id: 24680, type: 'private' },
      reply: vi.fn(),
    });

    expect(replyWithAssistant).not.toHaveBeenCalled();
  });
});
