# API Carga Fácil — ambiente da prova

Backend real Node/Express do Carga Fácil, com banco SQLite temporário.
Disponibiliza GET, POST, PUT, PATCH e DELETE, além de autenticação por sessão.
**Não contém solução dos testes do Carga Fácil**: eles serão escritos na prova
de segunda-feira, 05/10/2026.

[![Preparação e SonarCloud](https://github.com/Thiago757/integration-tests-jest/actions/workflows/node.js.yml/badge.svg?branch=master)](https://github.com/Thiago757/integration-tests-jest/actions/workflows/node.js.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Thiago757_integration-tests-jest&metric=alert_status)](https://sonarcloud.io/dashboard?id=Thiago757_integration-tests-jest)

## Executar a API

Use Node.js **24.15+ na linha 24**:

```sh
npm ci
npm run api
```

Endereço: `http://127.0.0.1:4318`. O terminal mostra credenciais temporárias.
Cada execução começa com banco vazio, sem acessar os dados do projeto original.

## Ambiente dos testes e Sonar

```sh
npm run ci          # valida infraestrutura, inicia API e executa o arquivo de prova
npm test            # runner para os testes que serão escritos na prova
npm run sonar       # análise local; requer SONAR_TOKEN no ambiente
```

O arquivo `test/carga_facil.spec.ts` contém somente um `test.todo`.
O runner fornece URL e credenciais temporárias via variáveis de ambiente.
Uma execução com TODO **não significa que testes foram implementados ou aprovados**.

O Sonar analisa o **código da API**, não um cliente com cobertura artificial.
O workflow envia a análise ao projeto `Thiago757_integration-tests-jest` e aguarda
o Quality Gate. Ainda não há cobertura: o gate pode apontar problemas do backend
ou ausência de cobertura enquanto os testes não forem implementados.

Veja [as instruções de uso](docs/PROVA.md) e [a origem da API](api/carga-facil/ORIGEM.md).

Os oito exemplos originais do repositório, para outras APIs públicas, foram
preservados como referência e podem ser executados com `npm run test:external`.
Não são a solução da prova do Carga Fácil e precisam de internet.
