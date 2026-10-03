CREATE TABLE leituras_documentos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  caminhoneiro_id TEXT,
  situacao TEXT NOT NULL CHECK(situacao IN ('aguardando','processando','concluida','falhou')),
  arquivos_json TEXT NOT NULL,
  resultado_json TEXT NOT NULL DEFAULT '',
  erro TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  expira_em INTEGER NOT NULL,
  UNIQUE(id,owner_id),
  FOREIGN KEY(caminhoneiro_id,owner_id) REFERENCES caminhoneiros(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX leituras_documentos_pendentes
  ON leituras_documentos(owner_id,situacao,atualizado_em);
CREATE INDEX leituras_documentos_expiracao ON leituras_documentos(expira_em);
