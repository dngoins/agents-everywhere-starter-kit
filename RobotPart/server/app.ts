import express, { type ErrorRequestHandler, type Express } from 'express';
import multer from 'multer';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configFromEnv, TIME_ZONE, type ServerConfig } from './config.js';
import { CustomerStore, MAX_IMAGE_BYTES, type Schedule } from './customers.js';
import { hasCode, HttpError } from './errors.js';
import { OpenAIProvider, sdpSchema, type FetchLike } from './provider.js';
import { identitySchema, toolSchemas, uuidSchema } from './tools.js';
import { Workflow, type BookingLogger } from './workflow.js';

export const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface AppOptions {
  config?: ServerConfig;
  rootDir?: string;
  facesDir?: string;
  moviesDir?: string;
  distDir?: string;
  production?: boolean;
  fetch?: FetchLike;
  now?: () => Date;
  movieDelayMs?: number;
  schedule?: Schedule;
  movieAvailable?: () => Promise<boolean>;
  providerTimeoutMs?: number;
  logBooking?: BookingLogger;
  allowedOrigins?: readonly string[];
}

export interface AppRuntime {
  store: CustomerStore;
  workflow: Workflow;
  close: () => Promise<void>;
}

export type RobotApp = Express & { robot: AppRuntime };

// Local demo protection, not authentication. No CORS wildcard and no remote origins.
export function originAllowed(origin: string | undefined, host: string | undefined,
  extra: readonly string[] = []): boolean {
  if (!origin) return true; // Non-browser localhost tests/clients; tab UUID is still required.
  if (extra.includes(origin)) return true;
  if (['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8787', 'http://localhost:8787'].includes(origin)) return true;
  if (!host) return false;
  if (origin === `http://${host}` || origin === `https://${host}`) return true;
  const hostname = host.split(':')[0];
  if (origin === `http://${hostname}:5173` || origin === `http://${hostname}:8787` || origin === `https://${hostname}:5173` || origin === `https://${hostname}:8787`) {
    return true;
  }
  return false;
}

const toolBodySchema = identitySchema.extend({ args: z.record(z.string(), z.unknown()) });
const bookingBodySchema = identitySchema.extend(toolSchemas.book_test_drive.shape);
const voiceBodySchema = identitySchema.extend({ sdp: sdpSchema });
const clientSchema = z.strictObject({ clientId: uuidSchema });

export function createApp(options: AppOptions = {}): RobotApp {
  const root = resolve(options.rootDir ?? DEFAULT_ROOT);
  const facesDir = resolve(options.facesDir ?? join(root, 'Faces'));
  const moviesDir = resolve(options.moviesDir ?? join(root, 'Movies'));
  const distDir = resolve(options.distDir ?? join(root, 'dist'));
  const config = configFromEnv({
    OPENAI_API_KEY: options.config?.apiKey,
    VOICE_MODEL: options.config?.models.voice,
    REGULAR_MODEL: options.config?.models.regular,
    HIGHEND_MODEL: options.config?.models.highend,
  });
  const movieAvailable = options.movieAvailable ?? (async () => {
    try { return (await stat(join(moviesDir, 'demo.mp4'))).isFile(); } catch { return false; }
  });
  const store = new CustomerStore({ facesDir, movieAvailable,
    movieDelayMs: options.movieDelayMs, schedule: options.schedule });
  const provider = new OpenAIProvider(config, options.fetch, options.providerTimeoutMs);
  const workflow = new Workflow(store, provider, options.now, options.logBooking);
  const app = Object.assign(express(), { robot: {
    store, workflow,
    close: async () => { provider.close(); await store.close(); },
  } satisfies AppRuntime });
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!originAllowed(request.headers.origin, request.headers.host, options.allowedOrigins)) {
      next(new HttpError(403, 'Unexpected request origin.'));
      return;
    }
    let path: string;
    try { path = decodeURIComponent(request.path).replaceAll('\\', '/'); } catch {
      next(new HttpError(400, 'Invalid request path.'));
      return;
    }
    if (path.split('/').some((part) => part.startsWith('.'))
      || /^\/(?:Faces|server|RobotLibrary|node_modules)(?:\/|$)/i.test(path)) {
      next(new HttpError(404, 'Not found.'));
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(['/api', '/newCustomerFace'], (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, demo: true });
  });
  app.get('/api/config', async (_request, response) => {
    response.json({ configured: Boolean(config.apiKey), models: config.models,
      timeZone: TIME_ZONE, demoMovieAvailable: await movieAvailable() });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: {
    // Busboy can emit partsLimit as the limit is reached; fields/files enforce the exact shape.
    fileSize: MAX_IMAGE_BYTES, files: 1, fields: 2, parts: 4, fieldSize: 100, fieldNameSize: 40,
  } }).single('image');
  app.post('/newCustomerFace', (request, response, next) => {
    // Normalize all multipart parse errors too (including malformed boundaries).
    upload(request, response, (error: unknown) => {
      if (error) next(new HttpError(400, 'Provide one valid image no larger than 5 MB and both UUIDs.'));
      else next();
    });
  }, async (request, response) => {
    const identity = identitySchema.parse(request.body);
    if (!request.file?.buffer.length) throw new HttpError(400, 'An image file is required.');
    const result = await store.upload(identity.clientId, identity.customerId, request.file.buffer);
    response.status(result.statusCode).json(result.body);
  });

  app.get('/api/customers/:id', (request, response) => {
    const { clientId } = clientSchema.parse(request.query);
    const customerId = uuidSchema.parse(request.params.id);
    response.json(store.snapshot(clientId, customerId));
  });
  app.delete('/api/customers/:id', (request, response) => {
    const { clientId } = clientSchema.parse(request.body);
    const customerId = uuidSchema.parse(request.params.id);
    store.deactivate(clientId, customerId);
    response.json({ ok: true, customerId, active: false });
  });

  app.post('/api/tools/:name', async (request, response) => {
    const { clientId, customerId, args } = toolBodySchema.parse(request.body);
    const name = z.string().parse(request.params.name);
    response.json(await workflow.execute(clientId, customerId, name, args));
  });
  app.get('/api/test-drive/slots', async (request, response) => {
    const { clientId, customerId } = identitySchema.parse(request.query);
    response.json(await workflow.execute(clientId, customerId, 'get_test_drive_slots', {}));
  });
  app.post('/api/test-drive/bookings', async (request, response) => {
    const { clientId, customerId, ...args } = bookingBodySchema.parse(request.body);
    response.json(await workflow.execute(clientId, customerId, 'book_test_drive', args));
  });
  app.post('/api/voice/session', async (request, response) => {
    const { clientId, customerId, sdp } = voiceBodySchema.parse(request.body);
    response.status(201).json(await workflow.createVoice(clientId, customerId, sdp));
  });

  app.use('/Movies', (request, _response, next) => {
    if (request.path !== '/demo.mp4') next(new HttpError(404, 'Not found.'));
    else next();
  }, express.static(moviesDir, { index: false, dotfiles: 'deny', fallthrough: false, acceptRanges: true }));
  // Reserved routes NEVER fall through to dist or the SPA, even with Accept: text/html.
  app.use(['/api', '/newCustomerFace', '/ws'], (_request, _response, next) => next(new HttpError(404, 'Not found.')));
  if (options.production) {
    app.use(express.static(distDir, { index: false, dotfiles: 'deny' }));
    // Express 5: avoid the invalid bare '*' route syntax.
    app.use((request, response, next) => {
      if (!['GET', 'HEAD'].includes(request.method) || !request.accepts('html')) { next(); return; }
      response.sendFile(join(distDir, 'index.html'), (error) => { if (error) next(error); });
    });
  }
  app.use((_request, _response, next) => next(new HttpError(404, 'Not found.')));
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { response.destroy(); return; }
    response.type('json'); // Static/range failures may already have selected video/mp4.
    if (error instanceof HttpError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof z.ZodError || error instanceof multer.MulterError || error instanceof SyntaxError
      || error instanceof URIError) {
      response.status(400).json({ error: 'Invalid request.' }); return;
    }
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    if (status === 413) { response.status(413).json({ error: 'Request is too large.' }); return; }
    if (status === 416) { response.status(416).json({ error: 'Requested range is not satisfiable.' }); return; }
    if (status === 404 || hasCode(error, 'ENOENT')) { response.status(404).json({ error: 'Not found.' }); return; }
    if (status === 400 || status === 403 || status === 405 || status === 415) {
      response.status(status).json({ error: 'Invalid request.' }); return;
    }
    response.status(500).json({ error: 'Unable to complete the request.' });
  };
  app.use(errors);
  return app;
}