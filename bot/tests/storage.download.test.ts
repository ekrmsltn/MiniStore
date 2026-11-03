import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setupEnv } from './helpers';

describe('Storage file downloads', () => {
  const getFile = vi.fn();
  const sendDocument = vi.fn();
  const sendPhoto = vi.fn();
  const downloadMedia = vi.fn();
  const getChannelMessage = vi.fn();
  const getMtprotoClient = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    getFile.mockReset();
    sendDocument.mockReset();
    sendPhoto.mockReset();
    downloadMedia.mockReset();
    getChannelMessage.mockReset();
    getMtprotoClient.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('grammy', () => ({
      Api: class {
        getFile = getFile;
        sendDocument = sendDocument;
        sendPhoto = sendPhoto;
      },
      InputFile: class {},
    }));
    getMtprotoClient.mockResolvedValue({ downloadMedia });
    vi.doMock('../telegram/mtproto', () => ({
      checkChannelReadAccess: vi.fn(),
      getChannelMessage,
      getMtprotoClient,
      hasChannelMessage: vi.fn(),
    }));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    resetEnv();
  });

  it('uses the Bot API when the file is available there', async () => {
    getFile.mockResolvedValue({ file_path: 'documents/file.pdf' });
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('file contents'),
    });

    const { downloadFile } = await import('../telegram/storage');

    await expect(downloadFile('telegram-file-id', 42)).resolves.toEqual(
      Buffer.from('file contents'),
    );
    expect(getFile).toHaveBeenCalledWith('telegram-file-id');
    expect(getChannelMessage).not.toHaveBeenCalled();
  });

  it('stores photos with sendPhoto instead of treating photo IDs as documents', async () => {
    sendPhoto.mockResolvedValue({
      message_id: 88,
      photo: [{ file_id: 'stored-photo-id', file_size: 2048 }],
    });
    const { uploadTelegramMedia } = await import('../telegram/storage');

    await expect(
      uploadTelegramMedia('photo', 'incoming-photo-id', 'photo_12.jpg', 1024, 'image/jpeg'),
    ).resolves.toEqual({
      messageId: 88,
      fileId: 'stored-photo-id',
      fileName: 'photo_12.jpg',
      fileSize: 2048,
      mimeType: 'image/jpeg',
    });
    expect(sendPhoto).toHaveBeenCalledWith(
      '-1001234567890',
      'incoming-photo-id',
      { caption: 'photo_12.jpg', disable_notification: true },
    );
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('downloads files unsupported by the Bot API through the authenticated channel reader', async () => {
    getFile.mockRejectedValue(new Error('file too large'));
    getChannelMessage.mockResolvedValue({ id: 42 });
    downloadMedia.mockResolvedValue(Buffer.from('file contents'));
    const { downloadFile } = await import('../telegram/storage');

    await expect(downloadFile('telegram-file-id', 42)).resolves.toEqual(
      Buffer.from('file contents'),
    );
    expect(getFile).toHaveBeenCalledWith('telegram-file-id');
    expect(getChannelMessage).toHaveBeenCalledWith('-1001234567890', 42);
    expect(downloadMedia).toHaveBeenCalledWith({ id: 42 });
  });

  it('reports a channel access error if neither download route is available', async () => {
    getFile.mockRejectedValue(new Error('file too large'));
    getChannelMessage.mockResolvedValue(undefined);
    const { downloadFile } = await import('../telegram/storage');

    await expect(downloadFile('telegram-file-id', 404)).rejects.toThrow(
      'verify the owner Telegram account can access the Storage Channel',
    );
    expect(downloadMedia).not.toHaveBeenCalled();
  });
});
