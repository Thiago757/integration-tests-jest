ALTER TABLE cargas ADD COLUMN caminhoneiro_escolhido_id TEXT REFERENCES caminhoneiros(id) ON DELETE RESTRICT;
ALTER TABLE cargas ADD COLUMN condicoes_pagamento TEXT NOT NULL DEFAULT '';
