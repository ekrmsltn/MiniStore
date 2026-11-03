/**
 * Centralized logging using Pino.
 * Provides structured JSON logs with request context.
 */

import pino from 'pino';

const telegramBotApiUrl = /https:\/\/api\.telegram\.org\/bot[^/\s"'`]+/g;

const REDACTED = '[REDACTED]';
const REDACTED_ID = '[ID]';

function getConfiguredValues(pattern: RegExp): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => {
      pattern.lastIndex = 0;
      return pattern.test(key) && value && value.length >= 5;
    })
    .map(([, value]) => value!);
}

function redactString(value: string): string {
  let redacted = value.replace(telegramBotApiUrl, 'https://api.telegram.org/bot[REDACTED]');
  const sensitiveValues = [
    ...getConfiguredValues(/TOKEN|SECRET|PASSWORD|SESSION|API_HASH|API_KEY/i),
    ...getConfiguredValues(/(?:^|_)(?:API_ID|OWNER_ID|STORAGE_CHANNEL_ID|MANAGEMENT_CHANNEL_ID)$/i),
  ].sort((a, b) => b.length - a.length);

  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted.split(sensitiveValue).join(REDACTED);
  }
  return redacted;
}

function isIdentifierKey(key: string): boolean {
  return key === 'id' || /(?:_id|Id)s?$/i.test(key);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && /token|secret|password|session|api.?hash|api.?key/i.test(key)) return REDACTED;
  if (key && isIdentifierKey(key)) return REDACTED_ID;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

export function redactLogLine(line: string): string {
  const newline = line.endsWith('\n') ? '\n' : '';
  const serialized = line.slice(0, line.length - newline.length);
  return `${JSON.stringify(redactValue(JSON.parse(serialized)))}${newline}`;
}

export function serializeErrorForLog(error: Error): unknown {
  return redactValue(pino.stdSerializers.errWithCause(error));
}

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: { err: serializeErrorForLog },
  hooks: { streamWrite: redactLogLine },
  transport:
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        },
  base: {
    hostname: 'ministore',
  },
});

export default logger;
