-- "Esperando carga" passa a representar um pedido explícito por destino.
-- Contatos antigos sem destino pedido continuam cadastrados, sem alerta de espera.
CREATE TABLE caminhoneiros_novos (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, cpf TEXT, phone TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL,
  desired_destination TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('available','waiting','matched','traveling','inactive')),
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_id,cpf), UNIQUE(id,owner_id)
) STRICT;
INSERT INTO caminhoneiros_novos
SELECT id,owner_id,name,cpf,phone,city,state,desired_destination,notes,
  CASE WHEN status='waiting' AND desired_destination='' THEN 'available' ELSE status END,
  demo,created_at
FROM caminhoneiros;
DROP TABLE caminhoneiros;
ALTER TABLE caminhoneiros_novos RENAME TO caminhoneiros;
CREATE INDEX drivers_search ON caminhoneiros(owner_id,status,state,city);
