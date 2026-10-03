import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class Database {
  readonly raw: DatabaseSync;
  constructor(
    readonly path: string,
    migrate = true,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(path, { timeout: 5000 });
    this.raw.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;',
    );
    if (path !== ':memory:') chmodSync(path, 0o600);
    if (migrate) this.migrate();
  }
  run(sql: string, ...values: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...values);
  }
  one<T>(sql: string, ...values: SQLInputValue[]) {
    return this.raw.prepare(sql).get(...values) as T | undefined;
  }
  all<T>(sql: string, ...values: SQLInputValue[]) {
    return this.raw.prepare(sql).all(...values) as T[];
  }
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
  migrate() {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS migracoes (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT;',
    );
    const directory = resolve(process.cwd(), 'server/migrations');
    for (const filename of readdirSync(directory)
      .filter((v) => v.endsWith('.sql'))
      .sort()) {
      if (!this.one('SELECT name FROM migracoes WHERE name = ?', filename)) {
        // SQLite exige desativar FKs fora da transação ao recriar uma tabela pai.
        // Conferimos todas as referências antes do COMMIT, sem apagar seus filhos.
        const rebuild = [
          '006_contato_rapido.sql',
          '007_rotina_e_acordos.sql',
          '010_pedidos_de_carga.sql',
        ].includes(filename);
        if (rebuild) this.raw.exec('PRAGMA foreign_keys = OFF');
        try {
          this.transaction(() => {
            this.raw.exec(readFileSync(resolve(directory, filename), 'utf8'));
            if (this.all('PRAGMA foreign_key_check').length)
              throw new Error(`Referências inválidas na migração ${filename}.`);
            this.run('INSERT INTO migracoes (name) VALUES (?)', filename);
          });
        } finally {
          if (rebuild) this.raw.exec('PRAGMA foreign_keys = ON');
        }
      }
    }
  }
  close() {
    this.raw.close();
  }
}
