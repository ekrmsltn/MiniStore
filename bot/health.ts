import express, { Request, Response } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import logger from './logger';
import { index } from './telegram/index';
import { isWebhookReady, telegramWebhookRouter } from './webhook';

export const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(
  pinoHttp({
    logger,
    quietReqLogger: true,
    serializers: {
      req: (req) => ({ method: req.method }),
    },
  }),
);

app.get('/health', (_req: Request, res: Response) => {
  const ready = index.isInitialized() && isWebhookReady();
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/status', (_req: Request, res: Response) => {
  const ready = index.isInitialized() && isWebhookReady();
  res.json({
    service: 'ministore',
    version: '0.1.0',
    status: ready ? 'running' : 'initializing',
  });
});

app.use(telegramWebhookRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'NotFound', message: 'Not found' });
});

export default app;
