-- A estimativa preserva as cidades, os trechos e a base escolhida para o R$/km.
-- Cargas antigas mantêm a quilometragem e não recebem uma rota inventada.
ALTER TABLE cargas ADD COLUMN estimativa_rota_json TEXT
  CHECK (estimativa_rota_json IS NULL OR json_valid(estimativa_rota_json));
