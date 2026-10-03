import { fork } from 'node:child_process';
import { AppError } from './errors.js';
import { validateFile, type UploadedFile } from './storage.js';
import type { DocumentReading } from '../shared/document-reading.js';

export type DocumentBatchItem =
  { reading: DocumentReading; error?: never } | { reading?: never; error: string };

type WorkerResult = DocumentReading | { text: string };
type WorkerMessage = {
  result?: WorkerResult;
  results?: Array<{ result?: DocumentReading; error?: true }>;
};

// OCR consome bastante memória. A fila evita dois leitores concorrentes no plano
// gratuito e, diferente do bloqueio anterior, não manda o usuário tentar novamente.
let readerQueue: Promise<void> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const pending = readerQueue.then(task, task);
  readerQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function runWorker(
  input:
    | { buffer: Buffer; mime: string; mode: 'text' }
    | { documents: Array<{ buffer: Buffer; mime: string; name?: string }>; mode: 'document' },
  timeoutMs: number,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const child = fork(new URL(`./document-worker.${extension}`, import.meta.url), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--max-old-space-size=256'],
    });
    let settled = false;
    const finish = (message?: WorkerMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (message?.result || message?.results) resolve(message);
      else
        reject(
          new AppError(422, 'Não consegui ler este arquivo. Confira a foto e tente novamente.'),
        );
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once('message', (message: WorkerMessage) => finish(message));
    child.once('error', () => finish());
    child.once('exit', () => finish());
    child.send(input);
  });
}

export async function inspectDocuments(
  files: UploadedFile[],
  maxBytes: number,
  maxTotalBytes = 25 * 1024 * 1024,
): Promise<DocumentBatchItem[]> {
  if (!files.length) throw new AppError(400, 'Escolha pelo menos um documento.');
  if (files.length > 10) throw new AppError(400, 'Escolha até 10 documentos por vez.');
  if (files.reduce((total, file) => total + file.buffer.length, 0) > maxTotalBytes)
    throw new AppError(413, 'Escolha arquivos que somem até 25 MB.');
  const types = await Promise.all(files.map((file) => validateFile(file, maxBytes)));
  const message = await enqueue(() =>
    runWorker(
      {
        mode: 'document',
        documents: files.map((file, index) => ({
          buffer: file.buffer,
          mime: types[index].mime,
          name: file.originalname,
        })),
      },
      120_000,
    ),
  );
  if (!message.results || message.results.length !== files.length)
    throw new AppError(422, 'A leitura foi interrompida. Os arquivos continuam selecionados.');
  return message.results.map((item) =>
    item.result
      ? { reading: item.result }
      : {
          error:
            'Não consegui ler este arquivo. Escolha o tipo e confira a validade antes de salvar.',
        },
  );
}

export async function inspectDocument(
  file: UploadedFile | undefined,
  maxBytes: number,
): Promise<DocumentReading> {
  const [item] = await inspectDocuments(file ? [file] : [], maxBytes);
  if (!item.reading) throw new AppError(422, item.error);
  return item.reading;
}

export async function readImageText(
  file: UploadedFile | undefined,
  maxBytes: number,
): Promise<string> {
  const type = await validateFile(file, maxBytes);
  const message = await enqueue(() =>
    runWorker({ buffer: file!.buffer, mime: type.mime, mode: 'text' }, 60_000),
  );
  return ((message.result as { text?: string } | undefined)?.text || '').trim();
}
