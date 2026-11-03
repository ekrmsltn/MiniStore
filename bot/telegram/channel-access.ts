import type { Api } from 'grammy';

interface ChannelAccessApi {
  getMe(): Promise<{ id: number }>;
  getChatMember(
    chatId: string,
    userId: number,
  ): Promise<{ status: string; can_post_messages?: boolean }>;
}

let botId: number | undefined;

export async function assertBotCanPostInChannel(
  api: Pick<Api, 'getMe' | 'getChatMember'> & ChannelAccessApi,
  channelId: string,
): Promise<void> {
  botId ??= (await api.getMe()).id;
  const member = await api.getChatMember(channelId, botId);

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
