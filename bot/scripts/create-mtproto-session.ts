import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { loadConfig } from '../config';

async function main(): Promise<void> {
  const config = loadConfig({
    requireTelegramUserSession: false,
    requireWebhook: false,
    requireAI: false,
  });
  const apiId = Number(config.apiId);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error('API_ID must be a positive safe integer');
  }

  const input = createInterface({ input: stdin, output: stdout });
  const client = new TelegramClient(new StringSession(''), apiId, config.apiHash, {
    connectionRetries: 5,
    requestRetries: 3,
  });

  try {
    await client.start({
      phoneNumber: () => input.question('Telegram phone number: '),
      phoneCode: () => input.question('Telegram login code: '),
      password: () => input.question('Telegram 2FA password (if enabled): '),
      onError: (error) => {
        throw error;
      },
    });

    const user = await client.getMe();
    if (String(user.id) !== String(config.ownerId)) {
      throw new Error('The authenticated Telegram account does not match OWNER_ID');
    }

    stdout.write('\nAdd this secret to TELEGRAM_USER_SESSION in your deployment environment:\n');
    stdout.write(`${client.session.save()}\n`);
    stdout.write('Do not share or commit this session string.\n');
  } finally {
    await client.disconnect();
    input.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown MTProto login error';
  console.error(`Could not create MTProto session: ${message}`);
  process.exitCode = 1;
});
