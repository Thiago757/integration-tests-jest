import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import type { AsyncDatabase } from './async-db.js';
import { AppError, required } from './errors.js';
import { inspectDocuments, type DocumentBatchItem } from './document-reader.js';
import type { Services } from './services.js';
import { validateFile, type PrivateStorage, type UploadedFile } from './storage.js';
import {
  categories,
  categoryLabels,
  dateSchema,
  driverSchema,
  type Driver,
} from '../shared/domain.js';
import {
  documentExpirationFor,
  personalDocumentCategories,
  vehicleDocumentCategories,
} from '../shared/document-reading.js';
import { cleanCpf } from '../shared/validation.js';
import { normalize } from '../shared/domain.js';

type StoredFile = {
  index: number;
  key: string;
  name: string;
  mime: string;
  extension: string;
  size: number;
};

type JobRow = {
  id: string;
  ownerId: string;
  targetDriverId: string | null;
  status: 'aguardando' | 'processando' | 'concluida' | 'falhou';
  filesJson: string;
  resultJson: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
};

const JOB = `SELECT id,owner_id AS ownerId,caminhoneiro_id AS targetDriverId,situacao AS status,arquivos_json AS filesJson,resultado_json AS resultJson,erro AS error,criado_em AS createdAt,atualizado_em AS updatedAt,expira_em AS expiresAt FROM leituras_documentos`;

const confirmationSchema = z.object({
  confirmed: z.literal(true, { error: 'Confira os dados antes de salvar.' }),
  driverId: z.string().uuid().optional(),
  driver: driverSchema.optional(),
  items: z
    .array(
      z.object({
        index: z.number().int().min(0).max(9),
        category: z.enum(categories).refine((value) => value !== 'pix'),
        expiresOn: z.union([dateSchema, z.literal('')]).default(''),
      }),
    )
    .min(1)
    .max(10),
});

function samePersonName(left: string, right: string) {
  const a = normalize(left).replace(/\s+/g, ' ').trim();
  const b = normalize(right).replace(/\s+/g, ' ').trim();
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

export class DocumentJobs {
  private running = new Set<string>();

  constructor(
    private readonly db: AsyncDatabase,
    private readonly storage: PrivateStorage,
    private readonly service: Services,
    private readonly maxBytes: number,
  ) {}

  private async row(owner: string, id: string) {
    return required(await this.db.one<JobRow>(`${JOB} WHERE id=? AND owner_id=?`, id, owner));
  }

  private files(row: JobRow): StoredFile[] {
    try {
      const files = JSON.parse(row.filesJson);
      if (!Array.isArray(files)) throw new Error('Invalid files');
      return files as StoredFile[];
    } catch {
      throw new AppError(500, 'A leitura perdeu a referência dos arquivos. Envie novamente.');
    }
  }

  async create(owner: string, targetDriverId: string | undefined, files: UploadedFile[]) {
    if (!files.length) throw new AppError(400, 'Escolha pelo menos um documento.');
    if (files.length > 10) throw new AppError(400, 'Escolha até 10 documentos por vez.');
    if (targetDriverId) await this.service.driver(owner, targetDriverId);
    const total = files.reduce((sum, file) => sum + file.buffer.length, 0);
    if (total > 25 * 1024 * 1024) throw new AppError(413, 'Escolha arquivos que somem até 25 MB.');
    const types = await Promise.all(files.map((file) => validateFile(file, this.maxBytes)));
    const stored: StoredFile[] = [];
    try {
      for (const [index, file] of files.entries()) {
        const type = types[index];
        stored.push({
          index,
          key: await this.storage.put(file.buffer, type.extension),
          name: file.originalname.slice(0, 160) || `documento-${index + 1}.${type.extension}`,
          mime: type.mime,
          extension: type.extension,
          size: file.buffer.length,
        });
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      await this.db.run(
        'INSERT INTO leituras_documentos(id,owner_id,caminhoneiro_id,situacao,arquivos_json,criado_em,atualizado_em,expira_em) VALUES(?,?,?,?,?,?,?,?)',
        id,
        owner,
        targetDriverId || null,
        'aguardando',
        JSON.stringify(stored),
        now,
        now,
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      );
      this.start(id);
      return await this.get(owner, id);
    } catch (error) {
      await Promise.allSettled(stored.map((file) => this.storage.remove(file.key)));
      throw error;
    }
  }

  start(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    void this.process(id).finally(() => this.running.delete(id));
  }

  private async process(id: string) {
    let claimed: JobRow | undefined;
    try {
      claimed = await this.db.transaction(async () => {
        const row = await this.db.one<JobRow>(`${JOB} WHERE id=?`, id);
        if (!row || row.status !== 'aguardando' || row.expiresAt <= Date.now()) return undefined;
        await this.db.run(
          'UPDATE leituras_documentos SET situacao=?,atualizado_em=? WHERE id=? AND situacao=?',
          'processando',
          new Date().toISOString(),
          id,
          'aguardando',
        );
        return row;
      });
      if (!claimed) return;
      const files = this.files(claimed);
      const uploaded = await Promise.all(
        files.map(async (file) => ({
          buffer: await this.storage.read(file.key),
          mimetype: file.mime,
          originalname: file.name,
        })),
      );
      const result = await inspectDocuments(uploaded, this.maxBytes);
      await this.db.run(
        'UPDATE leituras_documentos SET situacao=?,resultado_json=?,erro=?,atualizado_em=? WHERE id=?',
        'concluida',
        JSON.stringify(result),
        '',
        new Date().toISOString(),
        id,
      );
    } catch {
      await this.db.run(
        'UPDATE leituras_documentos SET situacao=?,erro=?,atualizado_em=? WHERE id=?',
        'falhou',
        'Não consegui ler este arquivo. Tente uma foto mais nítida ou outro PDF.',
        new Date().toISOString(),
        id,
      );
    }
  }

  async resume() {
    // Ao iniciar uma nova instância não existe leitor da instância anterior em execução.
    // Recolocar todos os itens interrompidos na fila evita cinco minutos de espera ou um
    // item preso para sempre quando o servidor reinicia logo após começar o OCR.
    await this.db.run(
      'UPDATE leituras_documentos SET situacao=?,atualizado_em=? WHERE situacao=?',
      'aguardando',
      new Date().toISOString(),
      'processando',
    );
    for (const row of await this.db.all<{ id: string }>(
      "SELECT id FROM leituras_documentos WHERE situacao='aguardando' AND expira_em>? ORDER BY criado_em LIMIT 20",
      Date.now(),
    ))
      this.start(row.id);
  }

  private async publicJob(row: JobRow) {
    const files = this.files(row).map(({ index, name, mime, size }) => ({
      index,
      name,
      mime,
      size,
    }));
    let items:
      | Array<
          DocumentBatchItem & {
            drivers: Driver[];
            match: Awaited<ReturnType<Services['identifyDrivers']>>['match'];
          }
        >
      | undefined;
    if (row.status === 'concluida') {
      const result = JSON.parse(row.resultJson || '[]') as DocumentBatchItem[];
      items = await Promise.all(
        result.map(async (item) =>
          item.reading
            ? { ...item, ...(await this.service.identifyDrivers(row.ownerId, item.reading)) }
            : {
                ...item,
                drivers: [],
                match: { method: 'none' as const, label: '', autoSelect: false },
              },
        ),
      );
    }
    const targetDriver = row.targetDriverId
      ? await this.service.driver(row.ownerId, row.targetDriverId).catch(() => undefined)
      : undefined;
    return {
      id: row.id,
      status: row.status,
      targetDriverId: row.targetDriverId || undefined,
      targetDriver,
      files,
      items,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async get(owner: string, id: string) {
    return await this.publicJob(await this.row(owner, id));
  }

  async list(owner: string) {
    await this.purgeExpired(owner);
    const rows = await this.db.all<JobRow>(
      `${JOB} WHERE owner_id=? ORDER BY criado_em DESC LIMIT 20`,
      owner,
    );
    return await Promise.all(rows.map((row) => this.publicJob(row)));
  }

  async statuses(owner: string) {
    await this.purgeExpired(owner);
    return this.db.all<{ id: string; status: string }>(
      'SELECT id,situacao AS status FROM leituras_documentos WHERE owner_id=? ORDER BY criado_em DESC LIMIT 20',
      owner,
    );
  }

  private async combinedFile(group: StoredFile[]): Promise<UploadedFile> {
    if (group.length === 1)
      return {
        buffer: await this.storage.read(group[0].key),
        mimetype: group[0].mime,
        originalname: group[0].name,
      };
    const output = await PDFDocument.create();
    for (const stored of group) {
      const buffer = await this.storage.read(stored.key);
      if (stored.mime === 'application/pdf') {
        const source = await PDFDocument.load(buffer);
        for (const page of await output.copyPages(source, source.getPageIndices()))
          output.addPage(page);
      } else {
        const image =
          stored.mime === 'image/png'
            ? await output.embedPng(buffer)
            : await output.embedJpg(buffer);
        const page = output.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      }
    }
    const buffer = Buffer.from(await output.save());
    if (buffer.length > this.maxBytes)
      throw new AppError(413, 'O PDF reunido ficou muito grande. Envie menos páginas por vez.');
    return { buffer, mimetype: 'application/pdf', originalname: 'documentos.pdf' };
  }

  async confirm(owner: string, id: string, input: unknown) {
    const value = confirmationSchema.parse(input);
    const row = await this.row(owner, id);
    if (row.status !== 'concluida')
      throw new AppError(409, 'Aguarde a leitura terminar antes de conferir os dados.');
    const files = this.files(row);
    const readings = JSON.parse(row.resultJson || '[]') as DocumentBatchItem[];
    const indexes = value.items.map((item) => item.index);
    if (
      new Set(indexes).size !== files.length ||
      files.some((file) => !indexes.includes(file.index))
    )
      throw new AppError(400, 'Confira todos os arquivos antes de salvar.');

    const chosen = value.items.map((item) => ({
      ...item,
      file: files.find((file) => file.index === item.index)!,
      reading: readings[item.index]?.reading,
    }));
    const personal = chosen.filter((item) => personalDocumentCategories.includes(item.category));
    const cpfs = [
      ...new Set(personal.map((item) => item.reading?.cpf).filter(Boolean) as string[]),
    ];
    const names = [
      ...new Set(
        personal
          .map((item) => item.reading?.name)
          .filter(Boolean)
          .map((name) => normalize(name!)),
      ),
    ];
    if (cpfs.length > 1 || names.length > 1)
      throw new AppError(
        409,
        'Os documentos parecem ser de pessoas diferentes. Envie os arquivos separadamente.',
      );
    const detectedCpf = cpfs[0] || '';
    const detectedName = personal.find((item) => item.reading?.name)?.reading?.name || '';

    let target: Driver | undefined;
    if (value.driverId) target = await this.service.driver(owner, value.driverId);
    if (row.targetDriverId) {
      if (value.driverId && value.driverId !== row.targetDriverId)
        throw new AppError(409, 'Este envio foi iniciado na ficha de outro caminhoneiro.');
      target = await this.service.driver(owner, row.targetDriverId);
    }
    const exactCpf = detectedCpf
      ? (await this.service.lookupDrivers(owner, detectedCpf))[0]
      : undefined;
    if (!target && exactCpf) target = await this.service.driver(owner, exactCpf.id);
    if (target && exactCpf && target.id !== exactCpf.id)
      throw new AppError(409, 'Este CPF já pertence a outro caminhoneiro. Abra a ficha indicada.');
    if (target?.cpf && detectedCpf && cleanCpf(target.cpf) !== detectedCpf)
      throw new AppError(409, 'O CPF do documento é de outra pessoa. Confira o caminhoneiro.');
    if (target && !target.cpf && detectedName && !samePersonName(target.name, detectedName))
      throw new AppError(
        409,
        'O nome da CNH é diferente do cadastro aberto. Confira a pessoa antes de continuar.',
      );

    const truckPlate = chosen.find((item) => item.category === 'truck')?.reading?.plate || '';
    const trailerPlate = chosen.find((item) => item.category === 'trailer')?.reading?.plate || '';
    if (target?.truckPlate && truckPlate && target.truckPlate !== truckPlate)
      throw new AppError(409, 'A placa do caminhão pertence a outro cadastro.');
    if (target?.trailerPlate && trailerPlate && target.trailerPlate !== trailerPlate)
      throw new AppError(409, 'A placa da carreta pertence a outro cadastro.');

    if (!target) {
      const candidate = driverSchema.parse({
        ...value.driver,
        name: detectedName || value.driver?.name,
        cpf: detectedCpf || value.driver?.cpf || '',
        truckPlate: truckPlate || value.driver?.truckPlate || '',
        trailerPlate: trailerPlate || value.driver?.trailerPlate || '',
      });
      target = await this.service.saveDriver(owner, candidate);
    } else if (
      (!target.cpf && detectedCpf) ||
      (!target.truckPlate && truckPlate) ||
      (!target.trailerPlate && trailerPlate)
    ) {
      target = await this.service.saveDriver(
        owner,
        {
          ...target,
          cpf: target.cpf || detectedCpf,
          truckPlate: target.truckPlate || truckPlate,
          trailerPlate: target.trailerPlate || trailerPlate,
        },
        target.id,
      );
    }

    const existing = await this.service.documents(owner, target.id);
    for (const category of [...new Set(chosen.map((item) => item.category))]) {
      const group = chosen.filter((item) => item.category === category);
      const expirations = [
        ...new Set(
          group
            .map((item) =>
              documentExpirationFor(category, item.reading?.issuedOn || '', item.expiresOn),
            )
            .filter(Boolean),
        ),
      ];
      if (expirations.length > 1)
        throw new AppError(400, `Confira as validades de ${categoryLabels[category]}.`);
      const issued = [
        ...new Set(group.map((item) => item.reading?.issuedOn).filter(Boolean) as string[]),
      ];
      const file = await this.combinedFile(group.map((item) => item.file));
      const previous = existing.find((document) => document.category === category);
      await this.service.saveDocument(
        owner,
        target.id,
        {
          category,
          number: category === 'cpf' ? detectedCpf : '',
          issuedOn:
            issued.length === 1 && (!expirations[0] || issued[0] <= expirations[0])
              ? issued[0]
              : '',
          expiresOn: expirations[0] || '',
          detectedCpf,
          detectedPlate: vehicleDocumentCategories.includes(category)
            ? group[0].reading?.plate || ''
            : '',
          expectedVersion: previous?.updatedAt,
        },
        file,
        previous?.id,
      );
    }

    await this.remove(owner, id);
    return { driver: await this.service.driver(owner, target.id) };
  }

  async remove(owner: string, id: string) {
    const row = await this.row(owner, id);
    const files = this.files(row);
    await this.db.run('DELETE FROM leituras_documentos WHERE id=? AND owner_id=?', id, owner);
    for (const file of files) {
      try {
        await this.storage.remove(file.key);
      } catch {
        await this.service.queueCleanup(file.key);
      }
    }
    await this.service.cleanupFiles();
  }

  private async purgeExpired(owner?: string) {
    const rows = await this.db.all<JobRow>(
      `${JOB} WHERE expira_em<=? ${owner ? 'AND owner_id=?' : ''} LIMIT 50`,
      ...[Date.now(), ...(owner ? [owner] : [])],
    );
    for (const row of rows) await this.remove(row.ownerId, row.id).catch(() => undefined);
  }
}
