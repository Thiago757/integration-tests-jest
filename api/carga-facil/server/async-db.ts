import { AsyncLocalStorage } from 'node:async_hooks';
import type { SQLInputValue } from 'node:sqlite';
import { Database } from './db.js';

export interface AsyncDatabase {
  run(sql: string, ...values: SQLInputValue[]): Promise<unknown>;
  one<T>(sql: string, ...values: SQLInputValue[]): Promise<T | undefined>;
  all<T>(sql: string, ...values: SQLInputValue[]): Promise<T[]>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

const adapters = new WeakMap<Database, AsyncDatabase>();

// Todas as operações locais usam a mesma fila. Uma transação assíncrona nunca
// compartilha a conexão SQLite com outra requisição enquanto está aberta.
export function asyncDatabase(db: Database | AsyncDatabase): AsyncDatabase {
  if (!(db instanceof Database)) return db;
  const existing = adapters.get(db);
  if (existing) return existing;
  const context = new AsyncLocalStorage<boolean>();
  let pending = Promise.resolve();
  function exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    if (context.getStore()) return Promise.resolve().then(fn);
    const result = pending.then(() => context.run(true, fn));
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  const adapter: AsyncDatabase = {
    run: (sql, ...values) => exclusive(() => db.run(sql, ...values)),
    one: <T>(sql: string, ...values: SQLInputValue[]) => exclusive(() => db.one<T>(sql, ...values)),
    all: <T>(sql: string, ...values: SQLInputValue[]) => exclusive(() => db.all<T>(sql, ...values)),
    transaction: <T>(fn: () => Promise<T>) =>
      exclusive(async () => {
        db.raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn();
          db.raw.exec('COMMIT');
          return result;
        } catch (error) {
          db.raw.exec('ROLLBACK');
          throw error;
        }
      }),
  };
  adapters.set(db, adapter);
  return adapter;
}
