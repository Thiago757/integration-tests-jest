# Ambiente para a prova de 05/10/2026

## API pronta, testes por fazer

Use Node.js 24.15 ou outra versão 24 mais recente. O backend utiliza `node:sqlite`.

```sh
cd integration-tests-jest
npm ci
npm run api
```

A API escuta em `http://127.0.0.1:4318`. O terminal mostra os e-mails e a senha
temporária; encerre com Ctrl+C. Para mudar a porta:
`CARGA_FACIL_PORT=4320 npm run api`.
Cada inicialização usa um banco SQLite novo. Não acessa o banco de produção.

## Contrato da autenticação

- Login: `POST /api/login`, JSON com `email` e `password` mostrados no terminal.
- Envie `Origin` com a URL local da API, inclusive no login.
- A resposta de login devolve o cookie `cf_session` em `Set-Cookie` e o campo
  `csrf` no JSON. Guarde-os para as próximas requisições.
- Requisições autenticadas usam o cookie; POST, PUT, PATCH e DELETE também
  exigem `Origin` e `X-CSRF-Token` com o valor recebido no login.
- Exclusões exigem o JSON `{ "confirmed": true }`.
- Logout: `POST /api/logout`.

## Recursos disponíveis

| Recurso | Rotas |
| --- | --- |
| Saúde | `GET /healthz` |
| Sessão | `GET /api/session` |
| Caminhoneiros | POST/GET `/api/drivers`; GET/PUT/DELETE `/api/drivers/:id` |
| Transportadoras | POST/GET `/api/carriers`; GET/PUT/DELETE `/api/carriers/:id` |
| Cargas | POST/GET `/api/cargos`; GET/PUT/DELETE `/api/cargos/:id` |
| Negociação | `PATCH /api/cargos/:id/negotiation` |

Os contratos e validações dos corpos estão em `api/carga-facil/shared/validation.ts`
e as rotas em `api/carga-facil/server/routes.ts`.
Cadastros usam dados fictícios; não use dados pessoais reais neste repositório público.

## Escrever os testes na prova

O arquivo `test/carga_facil.spec.ts` está reservado e contém apenas um TODO.
Não há cliente de testes implementado, exemplos resolvidos do Carga Fácil
nem gabarito de asserts.

```sh
npm test
npm run ci
```

O runner inicia a API em uma porta livre, executa Jest e encerra a API.
Disponibiliza estas variáveis no processo dos testes:

- `CARGA_FACIL_BASE_URL`
- `CARGA_FACIL_EMAIL`
- `CARGA_FACIL_OTHER_EMAIL`
- `CARGA_FACIL_PASSWORD`

Cada execução começa com banco novo. A API pode ser usada sem internet após
instalar as dependências. Os exemplos de outras APIs do repositório original
ficam separados em `npm run test:external`.

## SonarCloud

Projeto: [integration-tests-jest](https://sonarcloud.io/dashboard?id=Thiago757_integration-tests-jest).
Organização: `thiago757-2`.

O secret `SONAR_TOKEN` foi cadastrado no GitHub, e a análise automática foi
desligada para usar GitHub Actions. O workflow inicia em push para `master`/`main`
ou manualmente em Actions e aguarda o Quality Gate.

O Sonar analisa o backend original em `server/`, `shared/` e `prova-server.ts`.
A execução do arquivo TODO é reportada como pendente, não como teste aprovado.
Não há cobertura de testes implementados. Nenhum relatório de 100% foi incluído.
Análise publicada e Quality Gate aprovado são coisas diferentes: o gate poderá
falhar por problemas reais da API ou por cobertura, e essas falhas não são ocultadas.

Para análise local após `npm run ci`, no macOS/zsh:

```sh
read -s 'SONAR_TOKEN?Token do SonarCloud: '
export SONAR_TOKEN
npm run sonar
unset SONAR_TOKEN
```

Nunca coloque tokens no código, commits, histórico do terminal ou chat.
Quando os testes forem escritos, a cobertura precisa instrumentar o backend,
pois ele roda em processo separado; cobertura somente de um cliente não mede a API.

## Relatórios

- `output/report.html`: relatório Jest, inicialmente apenas com TODO.
- `output/eslint.html`: validação da infraestrutura e dos arquivos de testes.
- `output/sonar-test-execution.xml`: execução no formato genérico do Sonar.

O ESLint e o Prettier não reescrevem a cópia do backend; o Sonar faz sua análise estática.
