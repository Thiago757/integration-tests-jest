const { fork, spawn } = require('node:child_process');
const { resolve } = require('node:path');

const apiDirectory = resolve(__dirname, '../api/carga-facil');
const api = fork(resolve(apiDirectory, 'prova-server.ts'), [], {
  cwd: apiDirectory,
  execArgv: ['--import', 'tsx'],
  env: { ...process.env, CARGA_FACIL_PORT: '0' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc']
});
let tests;
let finished = false;
const timer = setTimeout(() => {
  console.error(
    'A API não iniciou em 30 segundos. Confira npm ci e Node 24.15+.'
  );
  finish(1);
}, 30000);

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.exitCode = code;
  if (tests && tests.exitCode === null) tests.kill('SIGTERM');
  api.kill('SIGTERM');
}

api.once('message', ({ baseUrl, email, otherEmail, password }) => {
  clearTimeout(timer);
  console.info(`Carga Fácil pronto em ${baseUrl} (banco temporário).`);
  tests = spawn(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--config',
      'jest.carga-facil.config.js',
      '--runInBand',
      ...process.argv.slice(2)
    ],
    {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        CARGA_FACIL_BASE_URL: baseUrl,
        CARGA_FACIL_EMAIL: email,
        CARGA_FACIL_OTHER_EMAIL: otherEmail,
        CARGA_FACIL_PASSWORD: password
      },
      stdio: 'inherit'
    }
  );
  tests.once('error', error => {
    console.error(error.message);
    finish(1);
  });
  tests.once('exit', code => finish(code ?? 1));
});
api.once('error', error => {
  console.error(error.message);
  finish(1);
});
api.once('exit', () => {
  if (!finished) {
    console.error('A API encerrou antes de terminar os testes.');
    finish(1);
  }
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => finish(130));
