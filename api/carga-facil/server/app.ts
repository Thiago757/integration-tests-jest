import type { AsyncDatabase } from './async-db.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { Auth } from './auth.js';
import { AppError } from './errors.js';
import { Services } from './services.js';
import { type Database } from './db.js';
import { type PrivateStorage } from './storage.js';
import { type Config } from './config.js';
import { RoutingService } from './routes.js';
import { searchMunicipalities, cityFromCargoText } from './municipalities.js';
import { parseCargoMessages } from '../shared/cargo-message.js';
import { inspectDocument, inspectDocuments, readImageText } from './document-reader.js';
import { DocumentJobs } from './document-jobs.js';
import {
  dateSchema,
  loginSchema,
  maskNumber,
  maskCnpj,
  operationStatuses,
} from '../shared/domain.js';
export function createApp(db: Database | AsyncDatabase, storage: PrivateStorage, config: Config) {
  const app = express();
  const auth = new Auth(db, config);
  const service = new Services(db, storage, config);
  const documentJobs = new DocumentJobs(service.db, storage, service, config.maxUploadBytes);
  queueMicrotask(() => void documentJobs.resume().catch(() => undefined));
  const routing = new RoutingService();
  app.disable('x-powered-by');
  if (config.trustHostingProxy) app.set('trust proxy', 1);
  if (config.trustLoopbackProxy) app.set('trust proxy', 'loopback');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.secureCookie ? [] : null,
        },
      },
      strictTransportSecurity: config.secureCookie ? undefined : false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), web-share=(self)',
    );
    next();
  });
  app.get('/healthz', async (_req, res) => {
    await service.db.one('SELECT 1 AS ok');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 400,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Muitas solicitações. Aguarde um minuto e tente novamente.' },
    }),
  );
  app.use('/api', (req, res, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (!config.origins.includes(req.get('Origin') || '') ||
        req.get('Sec-Fetch-Site') === 'cross-site')
    )
      return res.status(403).json({
        error: 'Esta origem não está autorizada. Abra o endereço configurado do Carga Fácil.',
      });
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 7, parts: 9, fieldSize: 4096 },
  });
  const documentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 10, fields: 0, parts: 10 },
  });
  const loginLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Muitas tentativas de acesso. Aguarde 15 minutos.' },
  });
  app.post('/api/login', loginLimit, async (req, res) => {
    const input = loginSchema.parse(req.body);
    res.json(await auth.login(input.email, input.password, res));
  });
  app.use('/api', auth.require);
  const owner = (req: Request) => req.auth!.user.id;
  const id = (req: Request, key = 'id') =>
    z.string().uuid('Identificador inválido.').parse(req.params[key]);
  const queryText = (req: Request, key: string) =>
    z.string().max(200).optional().parse(req.query[key]) || '';
  const confirmed = (req: Request) =>
    z
      .object({ confirmed: z.literal(true, { error: 'Confirme a exclusão antes de continuar.' }) })
      .parse(req.body);
  app.get('/api/session', (req, res) =>
    res.json({
      user: req.auth!.user,
      csrf: req.auth!.csrf,
      today: service.currentDate(),
      maxUploadBytes: config.maxUploadBytes,
      demo: config.demo === true,
    }),
  );
  app.post('/api/logout', async (req, res) => {
    await auth.logout(req, res);
    res.status(204).end();
  });
  app.get('/api/dashboard', async (req, res) => res.json(await service.dashboard(owner(req))));
  app.post('/api/cargos/interpretar', (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(10_000) }).parse(req.body);
    const items = parseCargoMessages(text, service.currentDate(), cityFromCargoText);
    res.json({ ...items[0]?.data, items });
  });
  app.post('/api/cargos/ler-imagem', upload.single('file'), async (req, res) => {
    const text = await readImageText(req.file, config.maxUploadBytes);
    if (!text) throw new AppError(422, 'Não encontrei texto legível nessa imagem.');
    res.json({ text, items: parseCargoMessages(text, service.currentDate(), cityFromCargoText) });
  });
  app.get('/api/municipios', (req, res) => {
    const search = z.string().trim().max(80).default('').parse(req.query.q);
    res.json(searchMunicipalities(search));
  });
  app.post(
    '/api/rotas',
    rateLimit({
      windowMs: 60000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Aguarde um minuto antes de calcular mais rotas.' },
    }),
    async (req, res) => res.json(await routing.calculate(req.body)),
  );
  app.get('/api/preferences', async (req, res) => res.json(await service.preferences(owner(req))));
  app.put('/api/preferences', async (req, res) =>
    res.json(await service.savePreferences(owner(req), req.body)),
  );
  app.get('/api/activities', async (req, res) =>
    res.json(await service.activities(owner(req), queryText(req, 'entityId'))),
  );
  app.get('/api/drivers', async (req, res) =>
    res.json(await service.drivers(owner(req), queryText(req, 'q'), queryText(req, 'status'))),
  );
  app.get('/api/drivers/lookup', async (req, res) =>
    res.json(await service.lookupDrivers(owner(req), queryText(req, 'q'))),
  );
  app.get('/api/document-readings', async (req, res) =>
    res.json(await documentJobs.list(owner(req))),
  );
  app.get('/api/document-readings/status', async (req, res) =>
    res.json(await documentJobs.statuses(owner(req))),
  );
  app.post('/api/document-readings', documentUpload.array('files', 10), async (req, res) => {
    const targetDriverId = z.string().uuid().optional().parse(req.query.driverId);
    const files = Array.isArray(req.files) ? req.files : [];
    res.status(202).json(await documentJobs.create(owner(req), targetDriverId, files));
  });
  app.get('/api/document-readings/:id', async (req, res) =>
    res.json(await documentJobs.get(owner(req), id(req))),
  );
  app.post('/api/document-readings/:id/confirm', async (req, res) =>
    res.json(await documentJobs.confirm(owner(req), id(req), req.body)),
  );
  app.delete('/api/document-readings/:id', async (req, res) => {
    await documentJobs.remove(owner(req), id(req));
    res.status(204).end();
  });
  app.post('/api/drivers/identify-document', upload.single('file'), async (req, res) => {
    const reading = await inspectDocument(req.file, config.maxUploadBytes);
    res.json({ reading, ...(await service.identifyDrivers(owner(req), reading)) });
  });
  app.post(
    '/api/drivers/identify-documents',
    documentUpload.array('files', 10),
    async (req, res) => {
      const files = Array.isArray(req.files) ? req.files : [];
      const readings = await inspectDocuments(files, config.maxUploadBytes);
      res.json({
        items: await Promise.all(
          readings.map(async (item) =>
            item.reading
              ? {
                  reading: item.reading,
                  ...(await service.identifyDrivers(owner(req), item.reading)),
                }
              : {
                  error: item.error,
                  drivers: [],
                  match: { method: 'none', label: '', autoSelect: false },
                },
          ),
        ),
      });
    },
  );
  app.post('/api/drivers', async (req, res) =>
    res.status(201).json(await service.saveDriver(owner(req), req.body)),
  );
  app.get('/api/drivers/:id', async (req, res) =>
    res.json(await service.driver(owner(req), id(req))),
  );
  app.get('/api/drivers/:id/pix', async (req, res) =>
    res.json(await service.pix(owner(req), id(req))),
  );
  app.put('/api/drivers/:id/pix', async (req, res) =>
    res.json(await service.savePix(owner(req), id(req), req.body)),
  );
  app.put('/api/drivers/:id', async (req, res) =>
    res.json(await service.saveDriver(owner(req), req.body, id(req))),
  );
  app.delete('/api/drivers/:id', async (req, res) => {
    confirmed(req);
    await service.deleteDriver(owner(req), id(req));
    res.status(204).end();
  });
  app.get('/api/carriers', async (req, res) =>
    res.json(
      (await service.carriers(owner(req), queryText(req, 'q'))).map((c) => ({
        ...c,
        cnpj: maskCnpj(c.cnpj),
      })),
    ),
  );
  app.get('/api/carriers/:id', async (req, res) =>
    res.json(await service.carrier(owner(req), id(req))),
  );
  app.post('/api/carriers', async (req, res) =>
    res.status(201).json(await service.saveCarrier(owner(req), req.body)),
  );
  app.put('/api/carriers/:id', async (req, res) =>
    res.json(await service.saveCarrier(owner(req), req.body, id(req))),
  );
  app.delete('/api/carriers/:id', async (req, res) => {
    confirmed(req);
    await service.deleteCarrier(owner(req), id(req));
    res.status(204).end();
  });
  app.get('/api/cargos', async (req, res) =>
    res.json(await service.cargos(owner(req), queryText(req, 'status'), queryText(req, 'q'))),
  );
  app.get('/api/cargos/:id', async (req, res) =>
    res.json(await service.cargo(owner(req), id(req))),
  );
  app.post('/api/cargos', async (req, res) =>
    res.status(201).json(await service.saveCargo(owner(req), req.body)),
  );
  app.put('/api/cargos/:id', async (req, res) =>
    res.json(await service.saveCargo(owner(req), req.body, id(req))),
  );
  app.patch('/api/cargos/:id/negotiation', async (req, res) => {
    const { active, selectedDriverId } = z
      .object({ active: z.boolean(), selectedDriverId: z.string().uuid().optional() })
      .strict()
      .parse(req.body);
    res.json(await service.setCargoNegotiating(owner(req), id(req), active, selectedDriverId));
  });
  app.delete('/api/cargos/:id', async (req, res) => {
    confirmed(req);
    await service.deleteCargo(owner(req), id(req));
    res.status(204).end();
  });
  app.get('/api/cargos/:id/matches', async (req, res) =>
    res.json(await service.matches(owner(req), id(req))),
  );
  app.get('/api/drivers/:id/documents', async (req, res) =>
    res.json(
      (await service.documents(owner(req), id(req))).map((d) => ({
        ...d,
        number: maskNumber(d.number),
      })),
    ),
  );
  app.get('/api/drivers/:id/checklist', async (req, res) =>
    res.json(
      (await service.checklist(owner(req), id(req), queryText(req, 'carrierId') || undefined)).map(
        (i) => ({
          ...i,
          document: i.document ? { ...i.document, number: maskNumber(i.document.number) } : null,
        }),
      ),
    ),
  );
  app.post('/api/drivers/:id/documents/read', upload.single('file'), async (req, res) => {
    await service.driver(owner(req), id(req));
    res.json(await inspectDocument(req.file, config.maxUploadBytes));
  });
  app.post('/api/drivers/:id/documents', upload.single('file'), async (req, res) =>
    res.status(201).json(await service.saveDocument(owner(req), id(req), req.body, req.file)),
  );
  app.put('/api/drivers/:id/documents/:documentId', upload.single('file'), async (req, res) =>
    res.json(
      await service.saveDocument(owner(req), id(req), req.body, req.file, id(req, 'documentId')),
    ),
  );
  app.get('/api/documents/:id', async (req, res) => {
    const { storageKey: _storageKey, ...document } = await service.document(owner(req), id(req));
    await service.audit(owner(req), 'Consultou dados de documento', 'driver', document.driverId);
    res.json(document);
  });
  app.delete('/api/documents/:id', async (req, res) => {
    confirmed(req);
    await service.deleteDocument(owner(req), id(req));
    res.status(204).end();
  });
  app.get('/api/documents/:id/file', async (req, res) => {
    const doc = await service.document(owner(req), id(req));
    if (req.query.version && req.query.version !== doc.updatedAt)
      throw new AppError(409, 'O arquivo foi substituído. Prepare o compartilhamento novamente.');
    const buffer = await storage.read(doc.storageKey);
    res.setHeader('Content-Type', doc.mime);
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${doc.filename}"`,
    );
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    await service.audit(
      owner(req),
      req.query.download === '1' ? 'Baixou documento' : 'Visualizou documento',
      'driver',
      doc.driverId,
      doc.category,
    );
    res.send(buffer);
  });
  app.post('/api/drivers/:id/share/prepare', async (req, res) =>
    res.json(await service.prepareShare(owner(req), id(req), req.body)),
  );
  app.get('/api/cargos/:id/journey', async (req, res) =>
    res.json(await service.cargoJourney(owner(req), id(req))),
  );
  app.get('/api/agencies', async (req, res) => res.json(await service.agencies(owner(req))));
  app.post('/api/agencies', async (req, res) =>
    res.status(201).json(await service.closeAgency(owner(req), req.body)),
  );
  app.patch('/api/agencies/:id/status', async (req, res) => {
    const { status } = z.object({ status: z.enum(operationStatuses) }).parse(req.body);
    res.json(await service.updateOperation(owner(req), id(req), status, req.body.delivery));
  });
  app.post('/api/agencies/:id/correct', async (req, res) =>
    res.json(await service.correctAgency(owner(req), id(req), req.body)),
  );
  app.put('/api/commissions/:id/plan', async (req, res) =>
    res.json(await service.saveCommissionPlan(owner(req), id(req), req.body)),
  );
  app.get('/api/commissions', async (req, res) => {
    const filters = z
      .object({
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        driverId: z.string().uuid().optional(),
        status: z.enum(['pending', 'received', 'cancelled']).optional(),
      })
      .refine(
        (v) => !v.from || !v.to || v.from <= v.to,
        'A data inicial deve ser anterior à final.',
      )
      .parse(req.query);
    res.json(await service.commissions(owner(req), filters));
  });
  app.post('/api/commissions/:id/receive', async (req, res) => {
    const { paidOn } = z.object({ paidOn: dateSchema }).parse(req.body);
    res.json(await service.receiveCommission(owner(req), id(req), paidOn));
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Caminho não encontrado.' }));
  const client = resolve('dist/client');
  if (existsSync(resolve(client, 'instalar/index.html'))) {
    app.get(['/instalar', '/instalar/'], (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(resolve(client, 'instalar/index.html'));
    });
  }
  if (existsSync(resolve(client, 'index.html'))) {
    app.use(
      express.static(client, {
        index: false,
        dotfiles: 'deny',
        setHeaders(res, path) {
          if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(resolve(client, 'index.html'));
    });
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return _next(error);
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues[0]?.message || 'Confira os campos informados.',
        fields: Object.fromEntries(error.issues.map((v) => [v.path.join('.'), v.message])),
      });
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message });
    if (error instanceof multer.MulterError)
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error:
          error.code === 'LIMIT_FILE_SIZE'
            ? `O arquivo deve ter até ${config.maxUploadBytes / 1024 / 1024} MB.`
            : 'Envie até 10 arquivos por vez e confira os documentos escolhidos.',
      });
    const pgError = error as { code?: string; constraint?: string };
    const message =
      pgError?.code === '23505'
        ? 'UNIQUE constraint failed: ' +
          (pgError.constraint?.includes('cpf')
            ? 'caminhoneiros.owner_id, caminhoneiros.cpf'
            : pgError.constraint || '')
        : error instanceof Error
          ? error.message
          : '';
    if (message.includes('UNIQUE constraint failed'))
      return res.status(409).json({
        ...(message.includes('caminhoneiros.owner_id, caminhoneiros.cpf')
          ? {
              fields: {
                cpf: 'Este CPF já está cadastrado. Abra a ficha existente.',
                driverCpf: 'Este CPF já está cadastrado. Escolha o caminhoneiro existente.',
              },
            }
          : {}),
        error: message.includes('caminhoneiros.owner_id, caminhoneiros.cpf')
          ? 'Este CPF já está cadastrado. Use a ficha existente para não duplicar o caminhoneiro.'
          : message.includes('documentos.')
            ? 'Já existe um documento nesta categoria. Use “Substituir”.'
            : 'Este cadastro já existe ou a carga/caminhoneiro já tem um agenciamento em andamento.',
      });
    if (message.includes('FOREIGN KEY constraint failed'))
      return res
        .status(409)
        .json({ error: 'Este registro está ligado ao histórico e não pode ser excluído.' });
    if (error instanceof SyntaxError && 'body' in error)
      return res
        .status(400)
        .json({ error: 'Não foi possível ler os dados. Confira o formulário.' });
    console.error(
      'Falha interna da aplicação:',
      error instanceof Error ? error.name : 'UnknownError',
    );
    res.status(500).json({
      error:
        'Não foi possível concluir agora. Tente novamente. Se continuar, peça ajuda ao responsável pelo sistema.',
    });
  });
  return { app, auth, service, documentJobs };
}
