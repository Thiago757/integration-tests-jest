const { mkdirSync, writeFileSync } = require('node:fs');
const { relative, resolve } = require('node:path');

function xml(value) {
  return Array.from(String(value))
    .filter(character => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = class SonarReporter {
  constructor(globalConfig) {
    this.root = globalConfig.rootDir;
  }

  onRunComplete(_contexts, results) {
    const files = results.testResults.map(file => {
      const cases = file.testResults.map(test => {
        let status = '';
        if (test.status === 'failed') {
          status = `<failure message="Falha no teste">${xml(test.failureMessages.join('\n'))}</failure>`;
        } else if (test.status !== 'passed') {
          status = '<skipped message="Teste não executado"/>';
        }
        return `<testCase name="${xml(test.fullName)}" duration="${Math.max(0, test.duration ?? 0)}">${status}</testCase>`;
      });
      if (file.testExecError) {
        cases.push(
          `<testCase name="Falha na suíte" duration="0"><error message="Erro de execução">${xml(file.failureMessage ?? file.testExecError.message)}</error></testCase>`
        );
      }
      const path = relative(this.root, file.testFilePath).split('\\').join('/');
      return `<file path="${xml(path)}">${cases.join('')}</file>`;
    });
    const directory = resolve(this.root, 'output');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, 'sonar-test-execution.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<testExecutions version="1">${files.join('')}</testExecutions>\n`
    );
  }
};
