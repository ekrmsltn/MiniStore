import type { Api } from 'grammy';

interface ChannelAccessApi {
  getMe(): Promise<{ id: number }>;
  getChatMember(
    chatId: string,
    userId: number,
  ): Promise<{ status: string; can_post_messages?: boolean }>;
}

let botId: number | undefined;

export async function validateBotApiToken(api: Pick<Api, 'getMe'>): Promise<number> {
  try {
    botId = (await api.getMe()).id;
    return botId;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'error_code' in error &&
      error.error_code === 401
    ) {
      throw new Error(
        'Telegram rejected BOT_TOKEN (401 Unauthorized). Replace it with the current token from BotFather.',
      );
    }
    throw error;
  }
}

export async function assertBotCanPostInChannel(
  api: Pick<Api, 'getMe' | 'getChatMember'> & ChannelAccessApi,
  channelId: string,
): Promise<void> {
  const userId = botId ?? (await validateBotApiToken(api));
  const member = await api.getChatMember(channelId, userId);

  if (
    member.status === 'creator' ||
    (member.status === 'administrator' && member.can_post_messages === true)
  ) {
    return;
  }

  const postingPermission = member.status === 'administrator' ? ' without permission to post' : '';
  throw new Error(
    `Bot must be a channel administrator with permission to post; current status is ${member.status}${postingPermission}`,
  );
}
