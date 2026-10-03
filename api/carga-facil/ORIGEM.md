# API utilizada na prova

Código do backend Node/Express da API real do Carga Fácil, copiado da branch `main`
do projeto local `/Users/thiagomazuco/Projetos/carga-facil`.

Commit de origem: `5645b4393f185bfb802bb34d5b5b90f7c546d4d3`.

As pastas `server` e `shared` preservam o código de origem e as migrações SQLite.
`prova-server.ts` é o ponto de entrada específico desta prova: cria um banco
temporário, duas contas fictícias e um segredo de sessão aleatório.
O servidor escuta apenas em `127.0.0.1` e apaga seu banco temporário ao receber
SIGINT ou SIGTERM. Cada execução começa novamente sem cadastros.

Este ambiente usa o backend Node/Express da branch `main`; o frontend mais recente
na branch `supabase-web` do projeto original tem outra arquitetura.

Nenhum `.env`, senha de usuário real, documento, banco original ou credencial de
produção foi copiado. A geração de credenciais na tela vale somente para o banco
temporário da prova. Não utilize este ponto de entrada em produção.

As validações e proteções originais continuam ativas: sessão em cookie, origem,
CSRF, validação de CPF/CNPJ, isolamento por usuário e restrições de exclusão.

O Sonar analisa o backend em `server/`, `shared/` e `prova-server.ts`,
e classifica `test/` como testes. Os testes do Carga Fácil serão escritos na prova;
o arquivo preparado contém apenas `test.todo`, sem solução ou cobertura fictícia.
O código copiado da API não é reformatado pelo projeto de testes.
