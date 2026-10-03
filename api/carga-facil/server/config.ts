import 'dotenv/config';
import { resolve } from 'node:path';
export interface Config {
  dataDir: string;
  secret: string;
  origins: string[];
  secureCookie: boolean;
  maxUploadBytes: number;
  timezone: string;
  production: boolean;
  demo?: boolean;
  trustLoopbackProxy?: boolean;
  trustHostingProxy?: boolean;
}
export function readConfig(): Config {
  const secret = process.env.SESSION_SECRET || '';
  if (secret.length < 32)
    throw new Error(
      'Configure SESSION_SECRET com pelo menos 32 caracteres. Execute npm run setup.',
    );
  const production = process.env.NODE_ENV === 'production';
  const secureCookie = process.env.COOKIE_SECURE === 'true';
  const origins = (process.env.APP_ORIGINS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (
    !origins.length ||
    origins.some((v) => {
      try {
        return new URL(v).origin !== v;
      } catch {
        return true;
      }
    })
  )
    throw new Error('APP_ORIGINS deve conter origens válidas, separadas por vírgula.');
  if (production && (!secureCookie || origins.some((v) => !v.startsWith('https://'))))
    throw new Error('Produção exige COOKIE_SECURE=true e APP_ORIGINS com HTTPS.');
  const maxMb = Number(process.env.MAX_UPLOAD_MB || 10);
  if (!Number.isFinite(maxMb) || maxMb <= 0 || maxMb > 10)
    throw new Error('MAX_UPLOAD_MB deve estar entre 1 e 10.');
  const timezone = process.env.BUSINESS_TIMEZONE || 'America/Sao_Paulo';
  new Intl.DateTimeFormat('pt-BR', { timeZone: timezone });
  return {
    dataDir: resolve(process.env.DATA_DIR || './data'),
    secret,
    origins,
    secureCookie,
    maxUploadBytes: maxMb * 1024 * 1024,
    timezone,
    production,
    trustHostingProxy: process.env.RENDER === 'true',
  };
}
