import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server/app.js';
import { Database } from './server/db.js';
import { LocalPrivateStorage } from './server/storage.js';

// Sempre abre um banco novo. Não lê o .env nem o banco do Carga Fácil original.
const dataDir = await mkdtemp(join(tmpdir(), 'carga-facil-prova-'));
const db = new Database(join(dataDir, 'prova.sqlite'));
const email = 'prova@example.invalid';
const otherEmail = 'outro@example.invalid';
const password = randomBytes(24).toString('base64url');
const origins: string[] = [];
const { app, auth } = createApp(
  db,
  new LocalPrivateStorage(join(dataDir, 'uploads')),
  {
    dataDir,
    secret: randomBytes(48).toString('hex'),
    origins,
    secureCookie: false,
    maxUploadBytes: 1024 * 1024,
    timezone: 'America/Sao_Paulo',
    production: false
  }
);
await auth.createUser('Aluno da prova', email, password);
await auth.createUser('Outro usuário da prova', otherEmail, password);
const port = Number(process.env.CARGA_FACIL_PORT ?? (process.send ? 0 : 4318));
const server = app.listen(port, '127.0.0.1', (error?: Error) => {
  if (error) return;
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Porta indisponível.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  origins.push(baseUrl);
  if (process.send) process.send({ baseUrl, email, otherEmail, password });
  else {
    console.info(`API da prova: ${baseUrl}`);
    console.info(`E-mail: ${email}\nSenha temporária: ${password}`);
    console.info(
      'Envie Origin com a URL acima; após login, use Cookie e X-CSRF-Token.'
    );
  }
});
server.on('error', async error => {
  console.error(error.message);
  db.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(1);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
