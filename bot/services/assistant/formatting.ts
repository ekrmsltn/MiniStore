const MAX_ANSWER_LENGTH = 3_800;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4_096;
const recognizedAssistantCommands = new Set([
  'start',
  'help',
  'ask',
  'usage',
  'store',
  'search',
  'upload',
  'cancel',
  'status',
  'admin',
  'users',
  'requests',
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatAssistantResponse(answer: string): string {
  const protectedMarkup: string[] = [];
  let marker = 'MINISTORETOKEN';
  while (answer.includes(marker)) marker += 'X';
  const protect = (markup: string): string => {
    const placeholder = `${marker}${protectedMarkup.length}END`;
    protectedMarkup.push(markup);
    return placeholder;
  };

  let formatted = answer
    .replace(/```(?:[^\n`]*\n)?([\s\S]*?)```/g, (_match, code: string) =>
      protect(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`),
    )
    .replace(/`([^`\n]+)`/g, (_match, code: string) => protect(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) =>
      protect(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`),
    );

  const lines = formatted.split('\n');
  const tableFormatted: string[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const header = lines[line];
    const separator = lines[line + 1];
    if (
      header?.trim().startsWith('|') &&
      separator?.trim().startsWith('|') &&
      separator
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
    ) {
      const headers = splitMarkdownTableRow(header);
      const rows: string[] = [];
      line += 2;
      while (line < lines.length && lines[line].trim().startsWith('|')) {
        const cells = splitMarkdownTableRow(lines[line]);
        const row = headers
          .map((column, index) => {
            const value = cells[index]?.trim();
            return value ? `<b>${escapeHtml(column.trim())}:</b> ${formatTableCell(value)}` : '';
          })
          .filter(Boolean)
          .join(' · ');
        if (row) rows.push(row);
        line += 1;
      }
      line -= 1;
      tableFormatted.push(protect(rows.join('\n')));
      continue;
    }
    tableFormatted.push(header);
  }
  formatted = tableFormatted.join('\n');

  formatted = escapeHtml(formatted)
    .replace(/\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/g, '<b>$1$2</b>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g, '<i>$1$2</i>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\s*\d+[.)]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '▎ ')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '────────');

  const placeholderPattern = new RegExp(`${marker}(\\d+)END`, 'g');
  let restored = formatted;
  for (let pass = 0; pass <= protectedMarkup.length; pass += 1) {
    restored = restored.replace(placeholderPattern, (_match, index: string) => {
      return protectedMarkup[Number(index)] ?? '';
    });
    if (!placeholderPattern.test(restored)) break;
    placeholderPattern.lastIndex = 0;
  }
  const commandPattern = /(^|[^\w/;&])\/([a-z0-9_]{1,32})(@[a-z0-9_]{5,32})?(?![\w])/gi;
  const formattedCode = restored.replace(/<code>([^<]*)<\/code>/gi, (_match, code: string) => {
    let result = '';
    let position = 0;
    for (const match of code.matchAll(commandPattern)) {
      if (!recognizedAssistantCommands.has(match[2]!.toLowerCase())) continue;
      const command = match[0].slice(match[1]!.length);
      const commandStart = match.index! + match[1]!.length;
      const commandEnd = commandStart + command.length;
      if (commandStart > position) {
        result += `<code>${code.slice(position, commandStart)}</code>`;
      }
      result += command;
      position = commandEnd;
    }
    if (position === 0) return `<code>${code}</code>`;
    if (position < code.length) result += `<code>${code.slice(position)}</code>`;
    return result;
  });
  return formattedCode
    .split(
      /(<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>|<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/gi,
    )
    .map((part) => {
      if (part.startsWith('<')) return part;
      return part.replace(commandPattern, (match, prefix: string, command: string) =>
        recognizedAssistantCommands.has(command.toLowerCase())
          ? match
          : `${prefix}<code>/${command}${match.slice(prefix.length + command.length + 1)}</code>`,
      );
    })
    .join('');
}

function splitMarkdownTableRow(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

function formatTableCell(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '<b>$1$2</b>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g, '<i>$1$2</i>');
}

export function prepareAssistantReply(
  answer: string,
  cancelHint: string,
  forcePlainText = false,
): { text: string; parseMode?: 'HTML' } {
  const safeAnswer = answer.slice(0, MAX_ANSWER_LENGTH);
  const plainText = `${safeAnswer}\n\n${cancelHint}`;
  if (forcePlainText) return { text: plainText };

  const formatted = `${formatAssistantResponse(safeAnswer)}\n\n${cancelHint}`;
  if (formatted.length > MAX_TELEGRAM_MESSAGE_LENGTH) return { text: plainText };
  return { text: formatted, parseMode: 'HTML' };
}
