import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { PDFDocument } from 'pdf-lib';
import { AppError } from './errors.js';

export interface PrivateStorage {
  put(buffer: Buffer, extension: string): Promise<string>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
// Adaptador substituível por S3/R2 privado. Nunca exponha esta pasta como estática.
export class LocalPrivateStorage implements PrivateStorage {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    if (!/^[a-f0-9-]{36}\.(pdf|jpg|png)$/.test(key)) throw new AppError(400, 'Arquivo inválido.');
    return join(this.root, key);
  }
  async put(buffer: Buffer, extension: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const key = `${randomUUID()}.${extension}`;
    await writeFile(this.path(key), buffer, { mode: 0o600, flag: 'wx' });
    return key;
  }
  async read(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError(404, 'O arquivo não está disponível. Envie uma nova cópia.');
      throw error;
    }
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}
export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}
export async function validateFile(file: UploadedFile | undefined, maxBytes: number) {
  if (!file?.buffer.length) throw new AppError(400, 'Escolha um arquivo PDF, JPG ou PNG.');
  if (file.buffer.length > maxBytes)
    throw new AppError(413, `O arquivo deve ter até ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  let detected;
  try {
    detected = await fileTypeFromBuffer(file.buffer);
  } catch {
    throw new AppError(400, 'O arquivo está incompleto ou inválido.');
  }
  const allowed: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
  };
  const declaredMime =
    file.mimetype === 'image/jpg'
      ? 'image/jpeg'
      : ['application/octet-stream', 'binary/octet-stream', ''].includes(file.mimetype)
        ? ''
        : file.mimetype;
  if (!detected || !allowed[detected.mime] || (declaredMime && declaredMime !== detected.mime))
    throw new AppError(400, 'O conteúdo precisa ser um PDF, JPG ou PNG verdadeiro.');
  const extension = file.originalname.split('.').pop()?.toLowerCase();
  if (
    extension &&
    extension !== file.originalname.toLowerCase() &&
    !(detected.mime === 'image/jpeg' ? ['jpg', 'jpeg'] : [allowed[detected.mime]]).includes(
      extension,
    )
  )
    throw new AppError(400, 'A extensão do arquivo não corresponde ao conteúdo.');
  if (detected.mime === 'application/pdf') {
    try {
      const pdf = await PDFDocument.load(file.buffer);
      if (pdf.getPageCount() === 0) throw new Error('Empty');
    } catch {
      throw new AppError(
        400,
        'Este PDF está danificado ou protegido por senha. Envie um PDF que possa ser aberto.',
      );
    }
  }
  return { mime: detected.mime, extension: allowed[detected.mime] };
}
