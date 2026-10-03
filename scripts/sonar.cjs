const { existsSync } = require('node:fs');

async function main() {
  if (!process.env.SONAR_TOKEN) {
    throw new Error(
      'Defina SONAR_TOKEN no ambiente ou no secret do GitHub. Não coloque o token no código. Veja docs/PROVA.md.'
    );
  }
  for (const path of ['output/sonar-test-execution.xml']) {
    if (!existsSync(path))
      throw new Error(`Falta ${path}. Execute npm run ci antes do Sonar.`);
  }
  const { scan } = await import('@sonar/scan');
  await scan({
    serverUrl: 'https://sonarcloud.io',
    token: process.env.SONAR_TOKEN
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
