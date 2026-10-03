CREATE TABLE agenciamentos_novo (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  cargo_id TEXT NOT NULL, driver_id TEXT NOT NULL, carrier_id TEXT NOT NULL,
  date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', operation_status TEXT NOT NULL CHECK(operation_status IN ('assigned','in_transit','completed')),
  cancelado_em TEXT NOT NULL DEFAULT '', motivo_cancelamento TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(id,owner_id),
  FOREIGN KEY(cargo_id,owner_id) REFERENCES cargas(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(driver_id,owner_id) REFERENCES caminhoneiros(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(carrier_id,owner_id) REFERENCES transportadoras(id,owner_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO agenciamentos_novo(id,owner_id,cargo_id,driver_id,carrier_id,date,notes,operation_status,snapshot,demo,created_at) SELECT id,owner_id,cargo_id,driver_id,carrier_id,date,notes,operation_status,snapshot,demo,created_at FROM agenciamentos;
DROP TABLE agenciamentos;
ALTER TABLE agenciamentos_novo RENAME TO agenciamentos;
CREATE UNIQUE INDEX one_agency_per_cargo ON agenciamentos(cargo_id) WHERE cancelado_em='';
CREATE UNIQUE INDEX one_active_agency_per_driver ON agenciamentos(driver_id) WHERE operation_status!='completed' AND cancelado_em='';
CREATE INDEX agencies_operations ON agenciamentos(owner_id,operation_status,date);
ALTER TABLE comissoes ADD COLUMN cancelada_em TEXT NOT NULL DEFAULT '';
ALTER TABLE comissoes ADD COLUMN pagador_nome TEXT NOT NULL DEFAULT '';
ALTER TABLE comissoes ADD COLUMN pagador_telefone TEXT NOT NULL DEFAULT '';
ALTER TABLE comissoes ADD COLUMN data_combinada TEXT NOT NULL DEFAULT '';
