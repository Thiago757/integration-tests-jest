CREATE TABLE usuarios (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE sessoes (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessoes(user_id);
CREATE INDEX sessions_expiry ON sessoes(expires_at);
CREATE TABLE caminhoneiros (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, cpf TEXT NOT NULL, phone TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL,
  desired_destination TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('waiting','matched','traveling','inactive')),
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_id,cpf), UNIQUE(id,owner_id)
) STRICT;
CREATE INDEX drivers_search ON caminhoneiros(owner_id,status,state,city);
CREATE TABLE veiculos (
  id TEXT PRIMARY KEY, driver_id TEXT NOT NULL UNIQUE REFERENCES caminhoneiros(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL CHECK(vehicle_type IN ('Truck','Toco','Carreta','Bitrem','Rodotrem','VUC')),
  truck_plate TEXT NOT NULL, trailer_plate TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX vehicles_type ON veiculos(vehicle_type);
CREATE TABLE transportadoras (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, cnpj TEXT NOT NULL, contact TEXT NOT NULL, phone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '', demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_id,cnpj), UNIQUE(id,owner_id)
) STRICT;
CREATE TABLE exigencias_documentais (
  carrier_id TEXT NOT NULL REFERENCES transportadoras(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('cnh','cpf','residence','truck','trailer','rntrc','bank_details','bank_receipt','pix','other')),
  PRIMARY KEY(carrier_id,category)
) STRICT;
CREATE TABLE documentos (
  id TEXT PRIMARY KEY, driver_id TEXT NOT NULL REFERENCES caminhoneiros(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('cnh','cpf','residence','truck','trailer','rntrc','bank_details','bank_receipt','pix','other')),
  number TEXT NOT NULL DEFAULT '', issued_on TEXT NOT NULL DEFAULT '', expires_on TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0),
  updated_at TEXT NOT NULL, UNIQUE(driver_id,category)
) STRICT;
CREATE INDEX documents_expiry ON documentos(expires_on);
CREATE TABLE cargas (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  carrier_id TEXT NOT NULL, origin_city TEXT NOT NULL, origin_state TEXT NOT NULL,
  destination_city TEXT NOT NULL, destination_state TEXT NOT NULL, cargo_type TEXT NOT NULL,
  vehicle_type TEXT NOT NULL CHECK(vehicle_type IN ('Truck','Toco','Carreta','Bitrem','Rodotrem','VUC')),
  freight_cents INTEGER NOT NULL CHECK(freight_cents >= 0), scheduled_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('available','negotiating','closed','cancelled')),
  demo INTEGER NOT NULL DEFAULT 0, UNIQUE(id,owner_id),
  FOREIGN KEY(carrier_id,owner_id) REFERENCES transportadoras(id,owner_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX cargos_availability ON cargas(owner_id,status,origin_state,origin_city,vehicle_type);
CREATE TABLE agenciamentos (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  cargo_id TEXT NOT NULL UNIQUE, driver_id TEXT NOT NULL, carrier_id TEXT NOT NULL,
  date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', operation_status TEXT NOT NULL CHECK(operation_status IN ('assigned','in_transit','completed')),
  snapshot TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(id,owner_id),
  FOREIGN KEY(cargo_id,owner_id) REFERENCES cargas(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(driver_id,owner_id) REFERENCES caminhoneiros(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(carrier_id,owner_id) REFERENCES transportadoras(id,owner_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX one_active_agency_per_driver ON agenciamentos(driver_id) WHERE operation_status != 'completed';
CREATE INDEX agencies_operations ON agenciamentos(owner_id,operation_status,date);
CREATE TABLE comissoes (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  agency_id TEXT NOT NULL UNIQUE, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','received')), paid_on TEXT,
  CHECK((status='pending' AND paid_on IS NULL) OR (status='received' AND paid_on IS NOT NULL)),
  FOREIGN KEY(agency_id,owner_id) REFERENCES agenciamentos(id,owner_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX commissions_status ON comissoes(owner_id,status,paid_on);
CREATE TABLE registros_atividade (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX activities_entity ON registros_atividade(owner_id,entity_type,entity_id,created_at);
CREATE TABLE arquivos_para_excluir (
  storage_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
