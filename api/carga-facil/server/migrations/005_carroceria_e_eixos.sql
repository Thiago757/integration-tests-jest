ALTER TABLE veiculos ADD COLUMN carroceria TEXT NOT NULL DEFAULT '' CHECK(carroceria IN ('','Graneleiro','Grade baixa','Baú','Sider','Tanque','Basculante','Prancha'));
ALTER TABLE veiculos ADD COLUMN configuracao_eixos TEXT NOT NULL DEFAULT '' CHECK(configuracao_eixos IN ('','LS','4 eixos'));
ALTER TABLE cargas ADD COLUMN carroceria TEXT NOT NULL DEFAULT '' CHECK(carroceria IN ('','Graneleiro','Grade baixa','Baú','Sider','Tanque','Basculante','Prancha'));
ALTER TABLE cargas ADD COLUMN configuracao_eixos TEXT NOT NULL DEFAULT '' CHECK(configuracao_eixos IN ('','LS','4 eixos'));
