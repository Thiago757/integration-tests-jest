import { asyncDatabase, type AsyncDatabase } from './async-db.js';
import { randomUUID } from 'node:crypto';
import { routeMatchesCargo } from '../shared/routes.js';
import { pixInputSchema, type PixKey } from '../shared/pix.js';
import { Database } from './db.js';
import type { Config } from './config.js';
import type { PrivateStorage, UploadedFile } from './storage.js';
import { validateFile } from './storage.js';
import { AppError, required } from './errors.js';
import {
  type Driver,
  type Carrier,
  type Cargo,
  type DriverDocument,
  type Agency,
  type Commission,
  type Activity,
  type Category,
  type ChecklistItem,
  type Dashboard,
  type UserPreferences,
  DEFAULT_GOOD_RATE_CENTS,
  preferencesSchema,
  correctionSchema,
  deliverySchema,
  commissionPlanSchema,
  money,
  driverSchema,
  carrierSchema,
  cargoSchema,
  agencySchema,
  documentSchema,
  shareSchema,
  categories,
  categoryLabels,
  compatibility,
  documentStatus,
  today,
  maskCpf,
  normalize,
  routeLabel,
  whatsappUrl,
} from '../shared/domain.js';
import {
  documentExpirationFor,
  personalDocumentCategories,
  vehicleDocumentCategories,
  type DocumentMatch,
  type DocumentReading,
} from '../shared/document-reading.js';
const DRIVER = `SELECT d.id,d.name,COALESCE(d.cpf,'') AS cpf,d.phone,d.city,d.state,d.desired_destination AS desiredDestination,d.notes,d.status,d.demo,d.created_at AS createdAt,v.vehicle_type AS vehicleType,v.carroceria AS bodyType,v.configuracao_eixos AS axleType,v.truck_plate AS truckPlate,v.trailer_plate AS trailerPlate FROM caminhoneiros d JOIN veiculos v ON v.driver_id=d.id`;
const CARGO = `SELECT c.id,c.caminhoneiro_escolhido_id AS selectedDriverId,c.condicoes_pagamento AS paymentTerms,c.carrier_id AS carrierId,t.name AS carrierName,c.origin_city AS originCity,c.origin_state AS originState,c.destination_city AS destinationCity,c.destination_state AS destinationState,c.cargo_type AS cargoType,c.vehicle_type AS vehicleType,c.carroceria AS bodyType,c.configuracao_eixos AS axleType,c.freight_cents AS freightCents,c.distancia_metros / 1000.0 AS distanceKm,c.estimativa_rota_json AS routeEstimate,c.scheduled_date AS scheduledDate,c.notes,c.status,c.demo FROM cargas c JOIN transportadoras t ON t.id=c.carrier_id`;
type CargoRow = Omit<Cargo, 'routeEstimate'> & {
  routeEstimate: string | null;
};
const cargoFromRow = (row: CargoRow): Cargo => ({
  ...row,
  routeEstimate: row.routeEstimate ? JSON.parse(row.routeEstimate) : null,
});
const DOCUMENT = `SELECT id,driver_id AS driverId,category,number,issued_on AS issuedOn,expires_on AS expiresOn,filename,mime,size,updated_at AS updatedAt FROM documentos`;
const ACTIVITY = `SELECT id,action,entity_type AS entityType,entity_id AS entityId,detail,created_at AS createdAt FROM registros_atividade`;
export class Services {
  readonly db: AsyncDatabase;
  constructor(
    db: Database | AsyncDatabase,
    readonly storage: PrivateStorage,
    readonly config: Config,
  ) {
    this.db = asyncDatabase(db);
  }
  currentDate() {
    return today(this.config.timezone);
  }
  async preferences(owner: string): Promise<UserPreferences> {
    return (
      (await this.db.one<UserPreferences>(
        'SELECT minimo_frete_centavos_km AS goodRateCents FROM preferencias_usuario WHERE usuario_id=?',
        owner,
      )) || { goodRateCents: DEFAULT_GOOD_RATE_CENTS }
    );
  }
  async savePreferences(owner: string, input: unknown) {
    const value = preferencesSchema.parse(input);
    await this.db.transaction(async () => {
      await this.db.run(
        "INSERT INTO preferencias_usuario(usuario_id,minimo_frete_centavos_km) VALUES(?,?) ON CONFLICT(usuario_id) DO UPDATE SET minimo_frete_centavos_km=excluded.minimo_frete_centavos_km,atualizado_em=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        owner,
        value.goodRateCents,
      );
      await this.audit(
        owner,
        'Ajustou o mínimo por quilômetro',
        'user',
        owner,
        `${money(value.goodRateCents)}/km`,
      );
    });
    return await this.preferences(owner);
  }
  async audit(owner: string, action: string, entityType: string, entityId: string, detail = '') {
    await this.db.run(
      'INSERT INTO registros_atividade(id,owner_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?,?)',
      randomUUID(),
      owner,
      action,
      entityType,
      entityId,
      detail,
    );
  }
  async activities(owner: string, entityId?: string) {
    return await this.db.all<Activity>(
      `${ACTIVITY} WHERE owner_id=? ${entityId ? 'AND entity_id=?' : ''} ORDER BY created_at DESC,rowid DESC LIMIT 200`,
      ...[owner, ...(entityId ? [entityId] : [])],
    );
  }
  async driver(owner: string, id: string): Promise<Driver> {
    return required(
      await this.db.one<Driver>(`${DRIVER} WHERE d.id=? AND d.owner_id=?`, id, owner),
    );
  }
  async drivers(owner: string, query = '', status = '') {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const phoneQuery = query.replace(/\D/g, '');
    return (await this.db.all<Driver>(`${DRIVER} WHERE d.owner_id=? ORDER BY d.name`, owner))
      .filter((d) => {
        const searchable = normalize(
          [
            d.name,
            d.phone,
            d.city,
            d.state,
            d.desiredDestination,
            d.vehicleType,
            d.bodyType || '',
            d.axleType || '',
          ].join(' '),
        );
        return (
          (!status || d.status === status) &&
          (terms.every((term) => searchable.includes(term)) ||
            (phoneQuery.length >= 4 &&
              /^[\d\s()+./-]+$/.test(query) &&
              (d.phone.includes(phoneQuery) || d.cpf.includes(phoneQuery))))
        );
      })
      .map((d) => ({ ...d, cpf: maskCpf(d.cpf) }));
  }
  async lookupDrivers(owner: string, query: string) {
    const digits = query.replace(/\D/g, '');
    if (digits.length === 11) {
      const driver = await this.db.one<Driver>(
        `${DRIVER} WHERE d.owner_id=? AND d.cpf=?`,
        owner,
        digits,
      );
      return driver ? [{ ...driver, cpf: maskCpf(driver.cpf) }] : [];
    }
    return (await this.drivers(owner, query)).slice(0, 5);
  }
  async identifyDrivers(
    owner: string,
    reading: Pick<DocumentReading, 'cpf' | 'plate'> &
      Partial<Pick<DocumentReading, 'category' | 'name'>>,
  ): Promise<{ drivers: Driver[]; match: DocumentMatch }> {
    const category = reading.category || 'other';
    // O CPF no CRLV pode ser do proprietário, não do motorista. Documento de veículo
    // só encontra um cadastro pela placa correspondente.
    if (reading.plate && (vehicleDocumentCategories.includes(category) || category === 'other')) {
      const drivers = (await this.db.all<Driver>(`${DRIVER} WHERE d.owner_id=?`, owner))
        .filter((driver) =>
          category === 'truck'
            ? driver.truckPlate === reading.plate
            : category === 'trailer'
              ? driver.trailerPlate === reading.plate
              : driver.truckPlate === reading.plate || driver.trailerPlate === reading.plate,
        )
        .map((driver) => ({ ...driver, cpf: maskCpf(driver.cpf) }));
      return {
        drivers,
        match: {
          method: drivers.length ? 'plate' : 'none',
          label: drivers.length ? `placa ${reading.plate}` : '',
          autoSelect: drivers.length === 1,
        },
      };
    }
    if (reading.cpf && personalDocumentCategories.includes(category)) {
      const drivers = await this.lookupDrivers(owner, reading.cpf);
      return {
        drivers,
        match: {
          method: drivers.length ? 'cpf' : 'none',
          label: drivers.length ? `CPF final ${reading.cpf.slice(-4)}` : '',
          autoSelect: drivers.length === 1,
        },
      };
    }
    if (reading.name && personalDocumentCategories.includes(category)) {
      const exact = (await this.db.all<Driver>(`${DRIVER} WHERE d.owner_id=?`, owner))
        .filter((driver) => normalize(driver.name) === normalize(reading.name || ''))
        .map((driver) => ({ ...driver, cpf: maskCpf(driver.cpf) }));
      return {
        drivers: exact,
        match: {
          method: exact.length ? 'name' : 'none',
          label: exact.length ? 'nome completo' : '',
          // Nomes podem se repetir. O usuário precisa confirmar a sugestão.
          autoSelect: false,
        },
      };
    }
    return { drivers: [], match: { method: 'none', label: '', autoSelect: false } };
  }
  async saveDriver(owner: string, input: unknown, id?: string, demo = false) {
    const value = driverSchema.parse(input);
    if (value.status === 'waiting' && !value.desiredDestination.trim())
      throw new AppError(400, 'Informe para onde o caminhoneiro pediu carga.');
    if (value.status !== 'waiting') value.desiredDestination = '';
    const previous = id ? await this.driver(owner, id) : null;
    value.bodyType ??= previous?.bodyType || '';
    value.axleType ??= previous?.axleType || '';
    if (id) {
      await this.driver(owner, id);
      const active = await this.db.one<{
        operation_status: string;
      }>(
        "SELECT operation_status FROM agenciamentos WHERE driver_id=? AND owner_id=? AND operation_status!='completed' AND cancelado_em=''",
        id,
        owner,
      );
      if (
        active &&
        value.status !== (active.operation_status === 'assigned' ? 'matched' : 'traveling')
      )
        throw new AppError(409, 'Altere a situação pelo agenciamento em andamento.');
    }
    if (Boolean(value.city) !== Boolean(value.state))
      throw new AppError(400, 'Informe a cidade e o estado juntos, ou deixe os dois em branco.');
    if (
      previous?.cpf &&
      !value.cpf &&
      (await this.db.one('SELECT id FROM agenciamentos WHERE driver_id=?', id!))
    )
      throw new AppError(409, 'Mantenha o CPF de quem já tem uma viagem registrada.');
    const driverId = id || randomUUID();
    await this.db.transaction(async () => {
      if (id) {
        await this.db.run(
          'UPDATE caminhoneiros SET name=?,cpf=?,phone=?,city=?,state=?,desired_destination=?,notes=?,status=? WHERE id=? AND owner_id=?',
          value.name,
          value.cpf || null,
          value.phone,
          value.city,
          value.state,
          value.desiredDestination,
          value.notes,
          value.status,
          id,
          owner,
        );
        await this.db.run(
          'UPDATE veiculos SET vehicle_type=?,truck_plate=?,trailer_plate=?,carroceria=?,configuracao_eixos=? WHERE driver_id=?',
          value.vehicleType,
          value.truckPlate,
          value.trailerPlate,
          value.bodyType || '',
          value.axleType || '',
          id,
        );
      } else {
        await this.db.run(
          'INSERT INTO caminhoneiros(id,owner_id,name,cpf,phone,city,state,desired_destination,notes,status,demo) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          driverId,
          owner,
          value.name,
          value.cpf || null,
          value.phone,
          value.city,
          value.state,
          value.desiredDestination,
          value.notes,
          value.status,
          Number(demo),
        );
        await this.db.run(
          'INSERT INTO veiculos(id,driver_id,vehicle_type,truck_plate,trailer_plate,carroceria,configuracao_eixos) VALUES(?,?,?,?,?,?,?)',
          randomUUID(),
          driverId,
          value.vehicleType,
          value.truckPlate,
          value.trailerPlate,
          value.bodyType || '',
          value.axleType || '',
        );
      }
      await this.audit(
        owner,
        id ? 'Atualizou caminhoneiro' : 'Cadastrou caminhoneiro',
        'driver',
        driverId,
      );
    });
    return await this.driver(owner, driverId);
  }
  async deleteDriver(owner: string, id: string) {
    await this.driver(owner, id);
    if (await this.db.one('SELECT id FROM agenciamentos WHERE driver_id=?', id))
      throw new AppError(
        409,
        'Este caminhoneiro tem histórico de agenciamento. Marque-o como inativo para preservar as comissões.',
      );
    if (await this.db.one('SELECT id FROM cargas WHERE caminhoneiro_escolhido_id=?', id))
      throw new AppError(
        409,
        'Este caminhoneiro está escolhido para uma carga. Retire a escolha na carga antes de excluir.',
      );
    await this.db.transaction(async () => {
      const keys = await this.db.all<{
        storage_key: string;
      }>('SELECT storage_key FROM documentos WHERE driver_id=?', id);
      for (const key of keys) await this.queueCleanup(key.storage_key);
      await this.db.run('DELETE FROM caminhoneiros WHERE id=? AND owner_id=?', id, owner);
      await this.audit(owner, 'Excluiu caminhoneiro e documentos', 'driver', id);
    });
    await this.cleanupFiles();
  }
  async carrier(owner: string, id: string): Promise<Carrier> {
    const row = required(
      await this.db.one<Omit<Carrier, 'requiredDocuments'>>(
        'SELECT id,name,cnpj,contact,phone,notes,demo FROM transportadoras WHERE id=? AND owner_id=?',
        id,
        owner,
      ),
    );
    const requiredDocuments = (
      await this.db.all<{
        category: Category;
      }>('SELECT category FROM exigencias_documentais WHERE carrier_id=?', id)
    ).map((v) => v.category);
    return { ...row, requiredDocuments };
  }
  async carriers(owner: string, search = '') {
    const carriers = await Promise.all(
      (
        await this.db.all<{
          id: string;
        }>(
          'SELECT t.id FROM transportadoras t WHERE t.owner_id=? ORDER BY (SELECT COUNT(*) FROM cargas c WHERE c.carrier_id=t.id) DESC,(SELECT MAX(c.rowid) FROM cargas c WHERE c.carrier_id=t.id) DESC,t.name',
          owner,
        )
      ).map(async (v) => await this.carrier(owner, v.id)),
    );
    const searchKey = (value: string) => normalize(value).replace(/[^\p{L}\d]/gu, '');
    const wanted = searchKey(search);
    return carriers.filter((carrier) =>
      [carrier.name, carrier.cnpj, carrier.contact, carrier.phone].some((value) =>
        searchKey(value).includes(wanted),
      ),
    );
  }
  async saveCarrier(owner: string, input: unknown, id?: string, demo = false) {
    const value = carrierSchema.parse(input);
    if (id) await this.carrier(owner, id);
    const carrierId = id || randomUUID();
    await this.db.transaction(async () => {
      if (id)
        await this.db.run(
          'UPDATE transportadoras SET name=?,cnpj=?,contact=?,phone=?,notes=? WHERE id=? AND owner_id=?',
          value.name,
          value.cnpj,
          value.contact,
          value.phone,
          value.notes,
          id,
          owner,
        );
      else
        await this.db.run(
          'INSERT INTO transportadoras(id,owner_id,name,cnpj,contact,phone,notes,demo) VALUES(?,?,?,?,?,?,?,?)',
          carrierId,
          owner,
          value.name,
          value.cnpj,
          value.contact,
          value.phone,
          value.notes,
          Number(demo),
        );
      await this.db.run('DELETE FROM exigencias_documentais WHERE carrier_id=?', carrierId);
      for (const category of value.requiredDocuments)
        await this.db.run(
          'INSERT INTO exigencias_documentais(carrier_id,category) VALUES(?,?)',
          carrierId,
          category,
        );
      await this.audit(
        owner,
        id ? 'Atualizou transportadora e checklist' : 'Cadastrou transportadora',
        'carrier',
        carrierId,
      );
    });
    return await this.carrier(owner, carrierId);
  }
  async deleteCarrier(owner: string, id: string) {
    await this.carrier(owner, id);
    if (await this.db.one('SELECT id FROM cargas WHERE carrier_id=?', id))
      throw new AppError(
        409,
        'A transportadora tem cargas vinculadas. Preserve o cadastro para manter o histórico.',
      );
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM transportadoras WHERE id=? AND owner_id=?', id, owner);
      await this.audit(owner, 'Excluiu transportadora', 'carrier', id);
    });
  }
  async cargo(owner: string, id: string): Promise<Cargo> {
    return cargoFromRow(
      required(await this.db.one<CargoRow>(`${CARGO} WHERE c.id=? AND c.owner_id=?`, id, owner)),
    );
  }
  async cargos(owner: string, status = '', query = '') {
    return (
      await this.db.all<CargoRow>(
        `${CARGO} WHERE c.owner_id=? ORDER BY c.scheduled_date,c.id`,
        owner,
      )
    )
      .map(cargoFromRow)
      .filter(
        (c) =>
          (!status || c.status === status) &&
          normalize(
            [
              c.originCity,
              c.originState,
              c.destinationCity,
              c.destinationState,
              c.carrierName,
              c.vehicleType,
              c.bodyType || '',
              c.axleType || '',
              c.cargoType,
            ].join(' '),
          ).includes(normalize(query)),
      );
  }
  async saveCargo(owner: string, input: unknown, id?: string, demo = false) {
    const value = cargoSchema.parse(input);
    await this.carrier(owner, value.carrierId);
    const previous = id ? await this.cargo(owner, id) : null;
    value.bodyType ??= previous?.bodyType || '';
    value.axleType ??= previous?.axleType || '';
    // Clientes anteriores não enviam a quilometragem; uma edição antiga não deve apagá-la.
    if (previous && input && typeof input === 'object' && !('distanceKm' in input))
      value.distanceKm = previous.distanceKm;
    if (
      previous?.routeEstimate &&
      input &&
      typeof input === 'object' &&
      !('routeEstimate' in input) &&
      routeMatchesCargo(value, previous.routeEstimate)
    )
      value.routeEstimate = previous.routeEstimate;
    if (value.routeEstimate && !routeMatchesCargo(value, value.routeEstimate))
      throw new AppError(
        400,
        'A rota calculada não corresponde às cidades ou à quilometragem. Recalcule a rota ou informe os quilômetros manualmente.',
      );
    if (previous?.status === 'closed')
      throw new AppError(
        409,
        'Esta carga já foi fechada. Consulte o agenciamento para acompanhar a viagem.',
      );
    if (value.status === 'closed')
      throw new AppError(
        409,
        'Use “Fechar agenciamento” para fechar a carga e registrar a comissão.',
      );
    const cargoId = id || randomUUID();
    value.paymentTerms ??= previous?.paymentTerms || '';
    value.selectedDriverId ??= previous?.selectedDriverId || null;
    if (
      input &&
      typeof input === 'object' &&
      'selectedDriverId' in input &&
      input.selectedDriverId === null
    )
      value.selectedDriverId = null;
    if (value.status === 'cancelled') value.selectedDriverId = null;
    await this.db.transaction(async () => {
      if (value.selectedDriverId) {
        const driver = await this.driver(owner, value.selectedDriverId);
        if (!compatibility(driver, value))
          throw new AppError(
            409,
            'O caminhoneiro escolhido precisa estar disponível e ter um veículo compatível com a carga. Confira o cadastro ou escolha outro.',
          );
        value.status = 'negotiating';
      }
      const fields = [
        value.carrierId,
        value.originCity,
        value.originState,
        value.destinationCity,
        value.destinationState,
        value.cargoType,
        value.vehicleType,
        value.bodyType || '',
        value.axleType || '',
        value.freightCents,
        value.distanceKm === null ? null : Math.round(value.distanceKm * 1000),
        value.routeEstimate ? JSON.stringify(value.routeEstimate) : null,
        value.scheduledDate,
        value.notes,
        value.status,
        value.selectedDriverId || null,
        value.paymentTerms || '',
      ];
      if (id)
        await this.db.run(
          'UPDATE cargas SET carrier_id=?,origin_city=?,origin_state=?,destination_city=?,destination_state=?,cargo_type=?,vehicle_type=?,carroceria=?,configuracao_eixos=?,freight_cents=?,distancia_metros=?,estimativa_rota_json=?,scheduled_date=?,notes=?,status=?,caminhoneiro_escolhido_id=?,condicoes_pagamento=? WHERE id=? AND owner_id=?',
          ...fields,
          id,
          owner,
        );
      else
        await this.db.run(
          'INSERT INTO cargas(carrier_id,origin_city,origin_state,destination_city,destination_state,cargo_type,vehicle_type,carroceria,configuracao_eixos,freight_cents,distancia_metros,estimativa_rota_json,scheduled_date,notes,status,caminhoneiro_escolhido_id,condicoes_pagamento,id,owner_id,demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ...fields,
          cargoId,
          owner,
          Number(demo),
        );
      await this.audit(owner, id ? 'Atualizou carga' : 'Cadastrou carga', 'cargo', cargoId);
    });
    return await this.cargo(owner, cargoId);
  }
  async deleteCargo(owner: string, id: string) {
    const cargo = await this.cargo(owner, id);
    if (
      cargo.status === 'closed' ||
      (await this.db.one('SELECT id FROM agenciamentos WHERE cargo_id=? AND owner_id=?', id, owner))
    )
      throw new AppError(
        409,
        'Esta carga faz parte do histórico de acordos e não pode ser excluída.',
      );
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM cargas WHERE id=? AND owner_id=?', id, owner);
      await this.audit(owner, 'Excluiu carga', 'cargo', id);
    });
  }
  async setCargoNegotiating(owner: string, id: string, active: boolean, selectedDriverId?: string) {
    await this.db.transaction(async () => {
      const cargo = await this.cargo(owner, id);
      if (!['available', 'negotiating'].includes(cargo.status))
        throw new AppError(409, 'Esta carga não pode mais entrar na lista de fechamentos.');
      const status = active ? 'negotiating' : 'available';
      if (cargo.status === status && !selectedDriverId) return;
      const driverId = active ? selectedDriverId || cargo.selectedDriverId || null : null;
      if (driverId && !compatibility(await this.driver(owner, driverId), cargo))
        throw new AppError(409, 'Confira a disponibilidade e o veículo do caminhoneiro escolhido.');
      await this.db.run(
        'UPDATE cargas SET status=?,caminhoneiro_escolhido_id=? WHERE id=? AND owner_id=?',
        status,
        driverId,
        id,
        owner,
      );
      await this.audit(
        owner,
        active ? 'Separou carga para fechar' : 'Retirou carga dos fechamentos',
        'cargo',
        id,
      );
    });
    return this.cargo(owner, id);
  }
  async matches(owner: string, cargoId: string) {
    const cargo = await this.cargo(owner, cargoId);
    const busy = new Set(
      (
        await this.db.all<{
          driver_id: string;
        }>(
          "SELECT driver_id FROM agenciamentos WHERE owner_id=? AND operation_status!='completed' AND cancelado_em=''",
          owner,
        )
      ).map((v) => v.driver_id),
    );
    return (await this.drivers(owner))
      .filter((d) => !busy.has(d.id))
      .map((d) => compatibility(d, cargo))
      .filter((v) => v !== null)
      .sort((a, b) => b.score - a.score || a.driver.name.localeCompare(b.driver.name, 'pt-BR'));
  }
  async documents(owner: string, driverId: string) {
    await this.driver(owner, driverId);
    return (
      await this.db.all<DriverDocument>(`${DOCUMENT} WHERE driver_id=? ORDER BY category`, driverId)
    ).map((document) => {
      const expiresOn = documentExpirationFor(
        document.category,
        document.issuedOn,
        document.expiresOn,
      );
      return {
        ...document,
        expiresOn,
        status: documentStatus(expiresOn, true, this.currentDate()),
      };
    });
  }
  async pix(owner: string, driverId: string): Promise<PixKey | null> {
    await this.driver(owner, driverId);
    return (
      (await this.db.one<PixKey>(
        'SELECT chave AS key,tipo AS type,versao AS version,atualizado_em AS updatedAt FROM chaves_pix WHERE caminhoneiro_id=?',
        driverId,
      )) || null
    );
  }
  async savePix(owner: string, driverId: string, input: unknown) {
    await this.driver(owner, driverId);
    const { key } = pixInputSchema.parse(input);
    await this.db.transaction(async () => {
      if (key)
        await this.db.run(
          'INSERT INTO chaves_pix(caminhoneiro_id,chave,tipo,versao,atualizado_em) VALUES(?,?,?,?,?) ON CONFLICT(caminhoneiro_id) DO UPDATE SET chave=excluded.chave,tipo=excluded.tipo,versao=excluded.versao,atualizado_em=excluded.atualizado_em',
          driverId,
          key.key,
          key.type,
          randomUUID(),
          new Date().toISOString(),
        );
      else await this.db.run('DELETE FROM chaves_pix WHERE caminhoneiro_id=?', driverId);
      await this.audit(owner, key ? 'Salvou chave Pix' : 'Removeu chave Pix', 'driver', driverId);
    });
    return await this.pix(owner, driverId);
  }
  async document(owner: string, id: string) {
    const row = required(
      await this.db.one<{
        driver_id: string;
        storage_key: string;
      }>(
        'SELECT driver_id,storage_key FROM documentos WHERE id=? AND driver_id IN (SELECT id FROM caminhoneiros WHERE owner_id=?)',
        id,
        owner,
      ),
    );
    return {
      ...required((await this.documents(owner, row.driver_id)).find((v) => v.id === id)),
      storageKey: row.storage_key,
    };
  }
  async queueCleanup(key: string) {
    await this.db.run('INSERT OR IGNORE INTO arquivos_para_excluir(storage_key) VALUES(?)', key);
  }
  async cleanupFiles() {
    for (const row of await this.db.all<{
      storage_key: string;
    }>('SELECT storage_key FROM arquivos_para_excluir LIMIT 100')) {
      try {
        await this.storage.remove(row.storage_key);
        await this.db.run('DELETE FROM arquivos_para_excluir WHERE storage_key=?', row.storage_key);
      } catch {
        await this.db.run(
          'UPDATE arquivos_para_excluir SET attempts=attempts+1 WHERE storage_key=?',
          row.storage_key,
        );
      }
    }
  }
  async saveDocument(
    owner: string,
    driverId: string,
    input: unknown,
    file: UploadedFile | undefined,
    id?: string,
  ) {
    const driver = await this.driver(owner, driverId);
    const fields = typeof input === 'object' && input ? (input as Record<string, unknown>) : {};
    const parsed = documentSchema.parse(input);
    const value = {
      ...parsed,
      expiresOn: documentExpirationFor(parsed.category, parsed.issuedOn, parsed.expiresOn),
    };
    const detectedPlate = driverSchema.shape.truckPlate.parse(String(fields.detectedPlate || ''));
    const detectedCpf = driverSchema.shape.cpf.parse(String(fields.detectedCpf || ''));
    const checksPersonalCpf =
      personalDocumentCategories.includes(value.category) &&
      !(value.category === 'other' && detectedPlate);
    const currentPlate = value.category === 'truck' ? driver.truckPlate : driver.trailerPlate;
    if (detectedCpf && driver.cpf && checksPersonalCpf && detectedCpf !== driver.cpf)
      throw new AppError(
        409,
        'O CPF do documento é de outra pessoa. Confira o caminhoneiro escolhido.',
      );
    if (
      detectedPlate &&
      vehicleDocumentCategories.includes(value.category) &&
      currentPlate &&
      detectedPlate !== currentPlate
    )
      throw new AppError(
        409,
        `A placa do documento é diferente da placa já cadastrada para este caminhoneiro (${currentPlate}).`,
      );
    if (value.category === 'pix')
      throw new AppError(
        400,
        'Digite a chave Pix na ficha do caminhoneiro. Não é necessário anexar um arquivo.',
      );
    const previous = id ? await this.document(owner, id) : undefined;
    if (previous && fields.expectedVersion && fields.expectedVersion !== previous.updatedAt)
      throw new AppError(
        409,
        'O documento mudou desde a conferência. Atualize a lista e confira novamente.',
      );
    if (previous && previous.driverId !== driverId)
      throw new AppError(404, 'Documento não encontrado.');
    if (previous && previous.category !== value.category)
      throw new AppError(
        400,
        'Mantenha a categoria ao substituir. Para outra categoria, cadastre um novo documento.',
      );
    const type = await validateFile(file, this.config.maxUploadBytes);
    const key = await this.storage.put(file!.buffer, type.extension);
    const docId = id || randomUUID();
    const filename = `${value.category}-${docId.slice(0, 8)}.${type.extension}`;
    try {
      await this.db.transaction(async () => {
        const currentDriver = await this.driver(owner, driverId);
        if (
          detectedCpf &&
          currentDriver.cpf &&
          checksPersonalCpf &&
          currentDriver.cpf !== detectedCpf
        )
          throw new AppError(
            409,
            'O CPF do documento é de outra pessoa. Confira o caminhoneiro escolhido.',
          );
        const latestPlate =
          value.category === 'truck' ? currentDriver.truckPlate : currentDriver.trailerPlate;
        if (
          detectedPlate &&
          vehicleDocumentCategories.includes(value.category) &&
          latestPlate &&
          latestPlate !== detectedPlate
        )
          throw new AppError(
            409,
            `A placa do documento é diferente da placa já cadastrada para este caminhoneiro (${latestPlate}).`,
          );
        if (
          previous &&
          (await this.document(owner, previous.id)).storageKey !== previous.storageKey
        )
          throw new AppError(
            409,
            'Este documento foi substituído em outra janela. Atualize a ficha e tente novamente.',
          );
        if (id)
          await this.db.run(
            'UPDATE documentos SET number=?,issued_on=?,expires_on=?,storage_key=?,filename=?,mime=?,size=?,updated_at=? WHERE id=? AND driver_id=?',
            value.number,
            value.issuedOn,
            value.expiresOn,
            key,
            filename,
            type.mime,
            file!.buffer.length,
            new Date().toISOString(),
            id,
            driverId,
          );
        else
          await this.db.run(
            'INSERT INTO documentos(id,driver_id,category,number,issued_on,expires_on,storage_key,filename,mime,size,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            docId,
            driverId,
            value.category,
            value.number,
            value.issuedOn,
            value.expiresOn,
            key,
            filename,
            type.mime,
            file!.buffer.length,
            new Date().toISOString(),
          );
        if (previous) await this.queueCleanup(previous.storageKey);
        if (detectedPlate && value.category === 'truck')
          await this.db.run(
            'UPDATE veiculos SET truck_plate=? WHERE driver_id=?',
            detectedPlate,
            driverId,
          );
        if (detectedPlate && value.category === 'trailer')
          await this.db.run(
            'UPDATE veiculos SET trailer_plate=? WHERE driver_id=?',
            detectedPlate,
            driverId,
          );
        if (detectedCpf && checksPersonalCpf && !currentDriver.cpf) {
          const duplicate = await this.db.one<{ id: string }>(
            'SELECT id FROM caminhoneiros WHERE owner_id=? AND cpf=? AND id<>?',
            owner,
            detectedCpf,
            driverId,
          );
          if (duplicate)
            throw new AppError(
              409,
              'Este CPF já pertence a outro caminhoneiro. Confira o documento.',
            );
          await this.db.run(
            'UPDATE caminhoneiros SET cpf=? WHERE id=? AND owner_id=?',
            detectedCpf,
            driverId,
            owner,
          );
        }
        await this.audit(
          owner,
          id ? 'Substituiu documento' : 'Cadastrou documento',
          'driver',
          driverId,
          categoryLabels[value.category],
        );
      });
    } catch (error) {
      await this.queueCleanup(key);
      await this.cleanupFiles();
      throw error;
    }
    await this.cleanupFiles();
    const { storageKey: _storageKey, ...document } = await this.document(owner, docId);
    return document;
  }
  async deleteDocument(owner: string, id: string) {
    const doc = await this.document(owner, id);
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM documentos WHERE id=?', id);
      await this.queueCleanup(doc.storageKey);
      await this.audit(
        owner,
        'Excluiu documento',
        'driver',
        doc.driverId,
        categoryLabels[doc.category],
      );
    });
    await this.cleanupFiles();
  }
  async checklist(owner: string, driverId: string, carrierId?: string): Promise<ChecklistItem[]> {
    const documents = await this.documents(owner, driverId);
    const pix = await this.pix(owner, driverId);
    const requirements: Category[] = carrierId
      ? (await this.carrier(owner, carrierId)).requiredDocuments
      : ['cnh', 'residence', 'truck', 'trailer', 'rntrc', 'bank_details'];
    return categories.map((category) => {
      const document = documents.find((d) => d.category === category) || null;
      return {
        category,
        document,
        ...(category === 'pix' ? { pix } : {}),
        required: requirements.includes(category),
        status: category === 'pix' ? (pix ? 'valid' : 'missing') : document?.status || 'missing',
      };
    });
  }
  async prepareShare(owner: string, driverId: string, input: unknown) {
    const value = shareSchema.parse(input);
    if (new Set(value.documentIds).size !== value.documentIds.length)
      throw new AppError(400, 'Selecione cada documento apenas uma vez.');
    const driver = await this.driver(owner, driverId);
    const documents = await this.documents(owner, driverId);
    const pix = value.pixVersion ? await this.pix(owner, driverId) : null;
    if (value.pixVersion && (!pix || pix.version !== value.pixVersion))
      throw new AppError(409, 'A chave Pix mudou. Confira a chave e prepare a mensagem novamente.');
    const selected = value.documentIds.map((id) =>
      required(
        documents.find((d) => d.id === id),
        'Um documento selecionado não pertence a este caminhoneiro ou foi excluído.',
      ),
    );
    if (selected.reduce((sum, d) => sum + d.size, 0) > 25 * 1024 * 1024)
      throw new AppError(
        400,
        'Selecione até 25 MB por compartilhamento. Divida os arquivos em dois grupos.',
      );
    const warnings: string[] = [];
    for (const doc of selected)
      if (['expired', 'expiring'].includes(doc.status))
        warnings.push(
          `${categoryLabels[doc.category]}: ${doc.status === 'expired' ? 'vencido' : 'vence em breve'}.`,
        );
    const message = [
      `Olá! Seguem os documentos de ${driver.name}.`,
      ...(selected.length
        ? [
            `Documentos: ${selected.map((d) => (d.category === 'pix' ? 'Arquivo antigo de Pix' : categoryLabels[d.category])).join(', ')}.`,
          ]
        : []),
      ...(pix ? [`Chave Pix: ${pix.key}`] : []),
      'Por favor, confirme o recebimento.',
    ].join('\n');
    await this.audit(
      owner,
      'Preparou documentos para compartilhar',
      'driver',
      driverId,
      `${selected.length} arquivo(s)${pix ? ' e chave Pix' : ''}. Destinatário escolhido no WhatsApp; não confirma envio.`,
    );
    return {
      files: selected.map((d) => ({
        id: d.id,
        filename: d.filename,
        mime: d.mime,
        size: d.size,
        url: `/api/documents/${d.id}/file?download=1&version=${encodeURIComponent(d.updatedAt)}`,
      })),
      message,
      whatsappUrl: whatsappUrl('', message),
      warnings,
      carrierName: '',
      pixIncluded: Boolean(pix),
    };
  }
  async closeAgency(owner: string, input: unknown, demo = false, withinTransaction = false) {
    const value = agencySchema.parse(input);
    if (value.dueOn && value.dueOn < value.date)
      throw new AppError(400, 'A data combinada deve ser a partir do acordo.');
    if (value.date > this.currentDate())
      throw new AppError(400, 'A data do agenciamento não pode estar no futuro.');
    const id = randomUUID();
    const close = async () => {
      const cargo = await this.cargo(owner, value.cargoId);
      const driver = await this.driver(owner, value.driverId);
      const carrier = await this.carrier(owner, value.carrierId);
      if (!driver.cpf) {
        if (!value.driverCpf)
          throw new AppError(400, 'Informe o CPF do caminhoneiro para fechar a primeira carga.');
        await this.db.run(
          'UPDATE caminhoneiros SET cpf=? WHERE id=? AND owner_id=?',
          value.driverCpf,
          driver.id,
          owner,
        );
      }
      if (cargo.carrierId !== carrier.id)
        throw new AppError(400, 'A transportadora precisa ser a mesma da carga.');
      if (!['available', 'negotiating'].includes(cargo.status))
        throw new AppError(409, 'Esta carga não está mais disponível. Atualize a lista.');
      if (!['available', 'waiting'].includes(driver.status))
        throw new AppError(
          409,
          'Este caminhoneiro já está vinculado a outra carga ou está indisponível.',
        );
      if (
        driver.vehicleType !== cargo.vehicleType ||
        (driver.bodyType && cargo.bodyType && driver.bodyType !== cargo.bodyType) ||
        (driver.axleType && cargo.axleType && driver.axleType !== cargo.axleType)
      )
        throw new AppError(400, 'O tipo de veículo não atende a esta carga.');
      const snapshot = JSON.stringify({
        driverName: driver.name,
        carrierName: carrier.name,
        route: routeLabel(cargo),
        truckPlate: driver.truckPlate,
        freightCents: cargo.freightCents,
        delivery: value.delivery,
      });
      await this.db.run(
        'INSERT INTO agenciamentos(id,owner_id,cargo_id,driver_id,carrier_id,date,notes,operation_status,snapshot,demo) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id,
        owner,
        cargo.id,
        driver.id,
        carrier.id,
        value.date,
        value.notes,
        value.operationStatus,
        snapshot,
        Number(demo),
      );
      await this.db.run(
        "UPDATE cargas SET status='closed',caminhoneiro_escolhido_id=NULL WHERE id=? AND owner_id=?",
        cargo.id,
        owner,
      );
      await this.db.run(
        "UPDATE caminhoneiros SET status=?,desired_destination='' WHERE id=? AND owner_id=?",
        value.operationStatus === 'completed'
          ? 'matched'
          : value.operationStatus === 'in_transit'
            ? 'traveling'
            : 'matched',
        driver.id,
        owner,
      );
      const commissionId = randomUUID();
      await this.db.run(
        'INSERT INTO comissoes(id,owner_id,agency_id,amount_cents,status,paid_on,pagador_nome,pagador_telefone,data_combinada) VALUES(?,?,?,?,?,?,?,?,?)',
        commissionId,
        owner,
        id,
        value.commissionCents,
        value.commissionStatus,
        value.commissionStatus === 'received' ? value.date : null,
        value.payerName || '',
        value.payerPhone || '',
        value.dueOn || '',
      );
      await this.audit(
        owner,
        'Fechou agenciamento',
        'agency',
        id,
        value.operationStatus === 'completed'
          ? `Carga fechada para ${cargo.destinationCity}/${cargo.destinationState}. A localização atual do caminhoneiro não foi presumida.`
          : 'Carga fechada e situação do caminhoneiro atualizada.',
      );
      await this.audit(
        owner,
        'Criou comissão',
        'commission',
        commissionId,
        `${value.commissionCents} centavos; ${value.commissionStatus === 'received' ? 'recebida' : 'pendente'}.`,
      );
    };
    if (withinTransaction) await close();
    else await this.db.transaction(close);
    return required((await this.agencies(owner)).find((v) => v.id === id));
  }
  async agencies(owner: string): Promise<Agency[]> {
    const rows = await this.db.all<
      Agency & {
        snapshot: string;
      }
    >(
      `SELECT a.id,a.cargo_id AS cargoId,a.driver_id AS driverId,a.carrier_id AS carrierId,a.date,a.notes,a.operation_status AS operationStatus,a.created_at AS createdAt,a.cancelado_em AS cancelledOn,a.motivo_cancelamento AS cancellationReason,a.snapshot,c.amount_cents AS commissionCents,CASE WHEN c.cancelada_em<>'' THEN 'cancelled' ELSE c.status END AS commissionStatus FROM agenciamentos a JOIN comissoes c ON c.agency_id=a.id WHERE a.owner_id=? ORDER BY a.created_at DESC`,
      owner,
    );
    return rows.map(({ snapshot, ...row }) => ({ ...row, ...JSON.parse(snapshot) }));
  }
  async updateOperation(
    owner: string,
    id: string,
    status: Agency['operationStatus'],
    delivery?: unknown,
  ) {
    await this.db.transaction(async () => {
      const agency = required((await this.agencies(owner)).find((a) => a.id === id));
      if (agency.cancelledOn) throw new AppError(409, 'Este acordo foi cancelado.');
      const arrival = delivery === undefined ? null : deliverySchema.parse(delivery);
      if (arrival && status !== 'completed')
        throw new AppError(400, 'Confirme a localização ao concluir a viagem.');
      const sequence = ['assigned', 'in_transit', 'completed'];
      if (sequence.indexOf(status) <= sequence.indexOf(agency.operationStatus))
        throw new AppError(409, 'A viagem já está nesta etapa ou em uma etapa posterior.');
      await this.db.run(
        'UPDATE agenciamentos SET operation_status=? WHERE id=? AND owner_id=?',
        status,
        id,
        owner,
      );
      await this.db.run(
        "UPDATE caminhoneiros SET status=?,desired_destination='' WHERE id=? AND owner_id=?",
        status === 'completed'
          ? arrival && !arrival.available
            ? 'inactive'
            : 'available'
          : 'traveling',
        agency.driverId,
        owner,
      );
      if (status === 'completed' && arrival?.updateLocation) {
        const cargo = await this.cargo(owner, agency.cargoId);
        await this.db.run(
          'UPDATE caminhoneiros SET city=?,state=? WHERE id=? AND owner_id=?',
          cargo.destinationCity,
          cargo.destinationState,
          agency.driverId,
          owner,
        );
      }
      await this.audit(
        owner,
        status === 'completed' ? 'Concluiu viagem' : 'Iniciou viagem',
        'agency',
        id,
        'Comissão preservada.',
      );
    });
    return required((await this.agencies(owner)).find((a) => a.id === id));
  }
  async correctAgency(owner: string, id: string, input: unknown) {
    const value = correctionSchema.parse(input);
    return this.db.transaction(async () => {
      const agencies = await this.agencies(owner);
      const agency = required(agencies.find((a) => a.id === id));
      if (agency.cancelledOn)
        throw new AppError(409, 'Este acordo já foi encerrado. Atualize a tela.');
      if (
        agency.operationStatus === 'completed' &&
        agencies.some(
          (item) =>
            item.driverId === agency.driverId &&
            !item.cancelledOn &&
            item.createdAt > agency.createdAt,
        )
      )
        throw new AppError(
          409,
          'Este caminhoneiro já tem um acordo mais recente. Corrija a carga mais nova para não alterar a situação atual dele.',
        );
      const commission = required(
        (await this.commissions(owner)).items.find((c) => c.agencyId === id),
      );
      if (value.commission === 'waive' && commission.status !== 'pending')
        throw new AppError(
          409,
          'Uma comissão recebida deve ser preservada. Devoluções precisam ser combinadas separadamente.',
        );
      if (
        value.action === 'replace' &&
        (!value.replacementDriverId ||
          value.replacementDriverId === agency.driverId ||
          !value.replacementCommissionCents)
      )
        throw new AppError(400, 'Escolha outro caminhoneiro e informe a nova comissão.');
      const stamp = new Date().toISOString();
      await this.db.run(
        'UPDATE agenciamentos SET cancelado_em=?,motivo_cancelamento=? WHERE id=? AND owner_id=?',
        stamp,
        value.reason,
        id,
        owner,
      );
      if (value.commission === 'waive')
        await this.db.run(
          'UPDATE comissoes SET cancelada_em=? WHERE id=? AND owner_id=?',
          stamp,
          commission.id,
          owner,
        );
      await this.db.run(
        'UPDATE cargas SET status=? WHERE id=? AND owner_id=?',
        value.action === 'cancel' ? 'cancelled' : 'available',
        agency.cargoId,
        owner,
      );
      await this.db.run(
        "UPDATE caminhoneiros SET status='available',desired_destination='' WHERE id=? AND owner_id=?",
        agency.driverId,
        owner,
      );
      await this.audit(
        owner,
        value.action === 'replace' ? 'Trocou caminhoneiro' : 'Cancelou acordo',
        'agency',
        id,
        `${value.reason}; comissão ${value.commission === 'waive' ? 'cancelada' : 'preservada'}.`,
      );
      if (value.action === 'replace')
        return this.closeAgency(
          owner,
          {
            cargoId: agency.cargoId,
            carrierId: agency.carrierId,
            driverId: value.replacementDriverId,
            driverCpf: value.replacementCpf || undefined,
            commissionCents: value.replacementCommissionCents,
            date: this.currentDate(),
            operationStatus:
              agency.operationStatus === 'completed' ? 'completed' : agency.operationStatus,
          },
          false,
          true,
        );
      return null;
    });
  }
  async saveCommissionPlan(owner: string, id: string, input: unknown) {
    const value = commissionPlanSchema.parse(input);
    return this.db.transaction(async () => {
      const commission = required((await this.commissions(owner)).items.find((c) => c.id === id));
      if (commission.status !== 'pending') throw new AppError(409, 'A cobrança já foi encerrada.');
      if (value.dueOn && value.dueOn < commission.date)
        throw new AppError(400, 'A data combinada deve ser a partir do acordo.');
      await this.db.run(
        'UPDATE comissoes SET pagador_nome=?,pagador_telefone=?,data_combinada=? WHERE id=? AND owner_id=?',
        value.payerName,
        value.payerPhone,
        value.dueOn,
        id,
        owner,
      );
      await this.audit(owner, 'Atualizou cobrança', 'commission', id, 'Pagador e data combinada.');
      return { ...commission, ...value };
    });
  }
  async commissions(
    owner: string,
    filters: {
      from?: string;
      to?: string;
      driverId?: string;
      status?: string;
    } = {},
  ) {
    const rows = (
      await this.db.all<
        Commission & {
          snapshot: string;
        }
      >(
        `SELECT c.id,c.agency_id AS agencyId,a.driver_id AS driverId,c.amount_cents AS amountCents,CASE WHEN c.cancelada_em<>'' THEN 'cancelled' ELSE c.status END AS status,c.pagador_nome AS payerName,c.pagador_telefone AS payerPhone,c.data_combinada AS dueOn,c.paid_on AS paidOn,a.date,a.snapshot FROM comissoes c JOIN agenciamentos a ON a.id=c.agency_id WHERE c.owner_id=? ORDER BY a.date DESC,c.rowid DESC`,
        owner,
      )
    ).map(({ snapshot, ...row }) => ({ ...row, ...JSON.parse(snapshot) }) as Commission);
    const filtered = rows.filter((c) => {
      const date = c.paidOn || c.date;
      return (
        (!filters.from || date >= filters.from) &&
        (!filters.to || date <= filters.to) &&
        (!filters.driverId || c.driverId === filters.driverId)
      );
    });
    const sum = (values: Commission[]) => values.reduce((s, c) => s + c.amountCents, 0);
    return {
      items: filtered.filter((c) => !filters.status || c.status === filters.status),
      pendingCents: sum(filtered.filter((c) => c.status === 'pending')),
      receivedCents: sum(filtered.filter((c) => c.status === 'received')),
      receivedMonthCents: sum(
        rows.filter(
          (c) => c.status === 'received' && c.paidOn?.startsWith(this.currentDate().slice(0, 7)),
        ),
      ),
    };
  }
  async receiveCommission(owner: string, id: string, paidOn: string) {
    return await this.db.transaction(async () => {
      const commission = required((await this.commissions(owner)).items.find((c) => c.id === id));
      if (commission.status === 'received') return commission;
      if (commission.status === 'cancelled')
        throw new AppError(409, 'Esta cobrança foi cancelada.');
      if (paidOn < commission.date || paidOn > this.currentDate())
        throw new AppError(400, 'O recebimento deve ser entre a data do agenciamento e hoje.');
      await this.db.run(
        "UPDATE comissoes SET status='received',paid_on=? WHERE id=? AND owner_id=? AND status='pending'",
        paidOn,
        id,
        owner,
      );
      await this.audit(
        owner,
        'Marcou comissão como recebida',
        'commission',
        id,
        `Pendente → recebida; ${paidOn}; ${commission.amountCents} centavos.`,
      );
      return { ...commission, status: 'received' as const, paidOn };
    });
  }
  async cargoJourney(owner: string, cargoId: string) {
    await this.cargo(owner, cargoId);
    const agency = (await this.agencies(owner)).find(
      (a) => a.cargoId === cargoId && !a.cancelledOn,
    );
    if (!agency) return null;
    return {
      agency,
      commission: required(
        (await this.commissions(owner)).items.find((c) => c.agencyId === agency.id),
      ),
      driver: await this.driver(owner, agency.driverId),
    };
  }
  async dashboard(owner: string): Promise<Dashboard> {
    const drivers = await this.drivers(owner);
    const cargos = await this.cargos(owner);
    const agencies = await this.agencies(owner);
    const commissions = await this.commissions(owner);
    const alerts: Dashboard['alerts'] = [];
    for (const driver of drivers.filter((d) => d.status !== 'inactive')) {
      const operation = agencies.find(
        (a) => a.driverId === driver.id && a.operationStatus !== 'completed' && !a.cancelledOn,
      );
      for (const item of await this.checklist(owner, driver.id, operation?.carrierId)) {
        if (
          (item.required && item.status !== 'valid') ||
          item.status === 'expired' ||
          item.status === 'expiring'
        )
          alerts.push({
            driverId: driver.id,
            driverName: driver.name,
            category: item.category,
            status: item.status,
            expiresOn: item.document?.expiresOn || '',
          });
      }
    }
    const priority: Record<string, number> = { expired: 0, expiring: 1, missing: 2 };
    alerts.sort(
      (a, b) =>
        priority[a.status] - priority[b.status] ||
        a.expiresOn.localeCompare(b.expiresOn) ||
        a.driverName.localeCompare(b.driverName, 'pt-BR'),
    );
    const nextActions: Dashboard['nextActions'] = [];
    const activeDriverIds = new Set(
      agencies
        .filter((a) => !a.cancelledOn && a.operationStatus !== 'completed')
        .map((a) => a.driverId),
    );
    const urgent =
      alerts.find((a) => activeDriverIds.has(a.driverId)) ||
      alerts.find((a) => a.status === 'expired');
    if (urgent)
      nextActions.push({
        title: `${urgent.driverName}: ${categoryLabels[urgent.category]}`,
        detail:
          urgent.status === 'expired'
            ? 'Documento vencido. Peça uma versão atualizada.'
            : urgent.status === 'missing'
              ? 'Este documento ainda não foi anexado.'
              : 'O documento vence nos próximos 30 dias.',
        label: urgent.status === 'missing' ? 'Adicionar documento' : 'Conferir documento',
        to: `/drivers/${urgent.driverId}#documents`,
      });
    const waiting = drivers.filter((d) => d.status === 'waiting');
    const ready = waiting.find((d) =>
      cargos.some((c) => ['available', 'negotiating'].includes(c.status) && compatibility(d, c)),
    );
    if (ready)
      nextActions.push({
        title: `${ready.name} está esperando carga`,
        detail: 'Há cargas com o tipo de caminhão dele. Confira a localização e combinem a viagem.',
        label: 'Ver cargas para ele',
        to: `/cargos?fechar=1&driverId=${ready.id}`,
      });
    const pending = commissions.items
      .filter((c) => c.status === 'pending')
      .sort((a, b) => (a.dueOn || '9999').localeCompare(b.dueOn || '9999'))[0];
    const pendingAgency = pending && agencies.find((a) => a.id === pending.agencyId);
    if (pending && pendingAgency)
      nextActions.push({
        title: `${money(pending.amountCents)} a receber`,
        detail: `${pending.driverName} · ${pending.route}`,
        label: 'Conferir comissão',
        to: `/commissions?status=pending&driverId=${pending.driverId}`,
      });
    return {
      nextActions,
      waiting: drivers.filter((d) => d.status === 'waiting').length,
      available: cargos.filter((c) => c.status === 'available').length,
      ongoing: agencies.filter((a) => a.operationStatus !== 'completed' && !a.cancelledOn).length,
      closed: agencies.filter(
        (a) =>
          a.operationStatus === 'completed' &&
          !a.cancelledOn &&
          a.date.startsWith(this.currentDate().slice(0, 7)),
      ).length,
      pendingCents: commissions.pendingCents,
      receivedMonthCents: commissions.receivedMonthCents,
      alerts,
      waitingDrivers: drivers.filter((d) => d.status === 'waiting').slice(0, 4),
      cargos: cargos.filter((c) => c.status === 'available').slice(0, 3),
      recentActivity: (await this.activities(owner)).slice(0, 5),
    };
  }
}
