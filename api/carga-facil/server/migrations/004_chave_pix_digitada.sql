CREATE TABLE chaves_pix (
  caminhoneiro_id TEXT PRIMARY KEY REFERENCES caminhoneiros(id) ON DELETE CASCADE,
  chave TEXT NOT NULL CHECK(length(chave) BETWEEN 1 AND 77),
  tipo TEXT NOT NULL CHECK(tipo IN ('cpf','cnpj','celular','email','aleatoria')),
  versao TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
) STRICT;
