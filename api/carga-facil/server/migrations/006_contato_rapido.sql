-- CPF pode ser informado ao fechar a primeira carga. NULL mantém a unicidade
-- dos CPFs conhecidos sem limitar o número de contatos ainda incompletos.
CREATE TABLE caminhoneiros_novos (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, cpf TEXT, phone TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL,
  desired_destination TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('waiting','matched','traveling','inactive')),
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_id,cpf), UNIQUE(id,owner_id)
) STRICT;
INSERT INTO caminhoneiros_novos SELECT * FROM caminhoneiros;
DROP TABLE caminhoneiros;
ALTER TABLE caminhoneiros_novos RENAME TO caminhoneiros;
CREATE INDEX drivers_search ON caminhoneiros(owner_id,status,state,city);
