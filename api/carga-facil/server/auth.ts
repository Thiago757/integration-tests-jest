import { asyncDatabase, type AsyncDatabase } from './async-db.js';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { parse, serialize } from 'cookie';
import type { Request, Response, NextFunction } from 'express';
import type { Database } from './db.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
const deriveKey = promisify(scrypt);
export const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await deriveKey(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, key] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const hash = (await deriveKey(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, 'hex');
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export interface SessionUser {
  id: string;
  name: string;
  email: string;
}
export interface AuthSession {
  user: SessionUser;
  csrf: string;
  tokenHash: string;
}
declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthSession;
  }
}
export class Auth {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  private db: AsyncDatabase;
  constructor(
    db: Database | AsyncDatabase,
    private config: Config,
  ) {
    this.db = asyncDatabase(db);
  }
  digest(token: string) {
    return createHmac('sha256', this.config.secret).update(token).digest('hex');
  }
  async createUser(name: string, email: string, password: string) {
    if (password.length < 12 || password.length > 200)
      throw new AppError(400, 'A senha precisa ter entre 12 e 200 caracteres.');
    const id = randomUUID();
    const hash = await hashPassword(password);
    await this.db.run(
      'INSERT INTO usuarios(id,name,email,password_hash) VALUES(?,?,?,?)',
      id,
      name,
      email.toLowerCase(),
      hash,
    );
    return id;
  }
  async login(email: string, password: string, res: Response) {
    const user = await this.db.one<
      SessionUser & {
        password_hash: string;
      }
    >('SELECT id,name,email,password_hash FROM usuarios WHERE email = ?', email);
    const valid = await verifyPassword(password, user?.password_hash ?? (await this.dummyHash));
    if (!valid || !user)
      throw new AppError(401, 'E-mail ou senha incorretos. Confira e tente novamente.');
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM sessoes WHERE expires_at <= ?', Date.now());
      await this.db.run(
        'INSERT INTO sessoes(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)',
        this.digest(token),
        user.id,
        csrf,
        Date.now() + SESSION_DURATION_SECONDS * 1000,
      );
      await this.db.run(
        'INSERT INTO registros_atividade(id,owner_id,action,entity_type,entity_id) VALUES(?,?,?,?,?)',
        randomUUID(),
        user.id,
        'Entrou no sistema',
        'user',
        user.id,
      );
    });
    res.setHeader(
      'Set-Cookie',
      serialize('cf_session', token, {
        httpOnly: true,
        secure: this.config.secureCookie,
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_DURATION_SECONDS,
      }),
    );
    return { user: { id: user.id, name: user.name, email: user.email }, csrf };
  }
  async session(req: Request): Promise<AuthSession | undefined> {
    const token = parse(req.headers.cookie || '').cf_session;
    if (!token || token.length > 100) return undefined;
    const hash = this.digest(token);
    const row = await this.db.one<
      SessionUser & {
        csrf_token: string;
      }
    >(
      `SELECT u.id,u.name,u.email,s.csrf_token FROM sessoes s JOIN usuarios u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
      hash,
      Date.now(),
    );
    if (!row) return undefined;
    return {
      user: { id: row.id, name: row.name, email: row.email },
      csrf: row.csrf_token,
      tokenHash: hash,
    };
  }
  require = async (req: Request, _res: Response, next: NextFunction) => {
    req.auth = await this.session(req);
    if (!req.auth) return next(new AppError(401, 'Sua sessão terminou. Entre novamente.'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = req.get('X-CSRF-Token') || '';
      const received = Buffer.from(token);
      const expected = Buffer.from(req.auth.csrf);
      if (received.length !== expected.length || !timingSafeEqual(received, expected))
        return next(
          new AppError(
            403,
            'Não foi possível confirmar a ação. Atualize a página e tente novamente.',
          ),
        );
    }
    next();
  };
  async logout(req: Request, res: Response) {
    if (req.auth) {
      await this.db.run('DELETE FROM sessoes WHERE token_hash=?', req.auth.tokenHash);
      await this.db.run(
        'INSERT INTO registros_atividade(id,owner_id,action,entity_type,entity_id) VALUES(?,?,?,?,?)',
        randomUUID(),
        req.auth.user.id,
        'Saiu do sistema',
        'user',
        req.auth.user.id,
      );
    }
    res.setHeader(
      'Set-Cookie',
      serialize('cf_session', '', {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: this.config.secureCookie,
        maxAge: 0,
      }),
    );
  }
}
