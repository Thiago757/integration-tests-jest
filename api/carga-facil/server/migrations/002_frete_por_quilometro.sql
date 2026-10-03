-- Quilometragem desconhecida permanece NULL; nunca deduzir distância a partir das cidades.
ALTER TABLE cargas ADD COLUMN distancia_metros INTEGER
  CHECK (distancia_metros IS NULL OR
    (distancia_metros BETWEEN 100 AND 100000000 AND distancia_metros % 100 = 0));

CREATE TABLE preferencias_usuario (
  usuario_id TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  minimo_frete_centavos_km INTEGER NOT NULL DEFAULT 700
    CHECK (minimo_frete_centavos_km BETWEEN 1 AND 100000),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
