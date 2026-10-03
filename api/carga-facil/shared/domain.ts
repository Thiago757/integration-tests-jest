import { z } from 'zod';
import { routeEstimateSchema } from './routes.js';
import type { PixKey } from './pix.js';
import {
  cleanCpf,
  cleanCnpj,
  cleanPhone,
  isValidCpf,
  isValidCnpj,
  isValidPhone,
} from './validation.js';

export const vehicleTypes = ['Truck', 'Toco', 'Carreta', 'Bitrem', 'Rodotrem', 'VUC'] as const;
export const bodyTypes = [
  '',
  'Graneleiro',
  'Grade baixa',
  'Aberta',
  'Baú',
  'Sider',
  'Tanque',
  'Basculante',
  'Prancha',
] as const;
export const axleTypes = [
  '',
  'LS',
  '2 eixos',
  '3 eixos',
  '4 eixos',
  '5 eixos',
  '6 eixos',
  '7 eixos',
  '8 eixos',
  '9 eixos',
] as const;
export function vehicleLabel(value: { vehicleType: string; bodyType?: string; axleType?: string }) {
  return [value.vehicleType, value.axleType, value.bodyType].filter(Boolean).join(' · ');
}
export const driverStatuses = ['available', 'waiting', 'matched', 'traveling', 'inactive'] as const;
export const cargoStatuses = ['available', 'negotiating', 'closed', 'cancelled'] as const;
export const operationStatuses = ['assigned', 'in_transit', 'completed'] as const;
export const categories = [
  'cnh',
  'cpf',
  'residence',
  'truck',
  'trailer',
  'rntrc',
  'bank_details',
  'bank_receipt',
  'pix',
  'other',
] as const;
export type Category = (typeof categories)[number];
export const categoryLabels: Record<Category, string> = {
  cnh: 'CNH',
  cpf: 'CPF',
  residence: 'Comprovante de residência',
  truck: 'Documento do caminhão',
  trailer: 'Documento da carreta',
  rntrc: 'RNTRC / ANTT',
  bank_details: 'Dados bancários',
  bank_receipt: 'Comprovante de conta',
  pix: 'Chave Pix',
  other: 'Outros documentos',
};
export const statusLabels: Record<string, string> = {
  waiting: 'Esperando carga',
  matched: 'Carga encontrada',
  traveling: 'Localização pendente',
  inactive: 'Inativo',
  available: 'Sem pedido de carga',
  negotiating: 'Negociando',
  closed: 'Fechada',
  cancelled: 'Cancelada',
  assigned: 'Localização pendente',
  in_transit: 'Localização pendente',
  completed: 'Carga fechada',
  pending: 'Pendente',
  received: 'Recebida',
  valid: 'Válido',
  expiring: 'Vence em breve',
  expired: 'Vencido',
  missing: 'Ausente',
};
export const states = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;
export const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
const shortText = z
  .string()
  .trim()
  .min(2, 'Preencha com pelo menos 2 caracteres.')
  .max(120, 'Use até 120 caracteres.');
const optionalText = z.string().trim().max(2000, 'Use até 2.000 caracteres.').default('');
const phone = z
  .string()
  .transform(cleanPhone)
  .refine(
    isValidPhone,
    'Confira o telefone com DDD. Celular tem 9 dígitos e começa com 9; fixo tem 8.',
  );
const state = z.enum(states, { error: 'Selecione um estado.' });
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe uma data válida.')
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Informe uma data válida.');
const optionalDate = z.union([dateSchema, z.literal('')]).default('');
const cents = z
  .number()
  .int('Informe um valor com até 2 casas decimais.')
  .min(0, 'O valor não pode ser negativo.')
  .max(100_000_000, 'Valor máximo: R$ 1.000.000,00.');
const plate = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => v.replace(/[-\s]/g, ''))
  .refine(
    (v) => /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(v),
    'Informe uma placa válida (ABC1D23 ou ABC1234).',
  );
export const driverSchema = z.object({
  name: shortText,
  cpf: z
    .string()
    .transform(cleanCpf)
    .refine(
      (v) => !v || isValidCpf(v),
      'CPF inválido. Confira os 11 números, incluindo os dois últimos.',
    )
    .default(''),
  phone,
  city: z.union([shortText, z.literal('')]).default(''),
  state: z.union([state, z.literal('')]).default(''),
  desiredDestination: z.string().trim().max(120).default(''),
  vehicleType: z.enum(vehicleTypes),
  bodyType: z.enum(bodyTypes).optional(),
  axleType: z.enum(axleTypes).optional(),
  truckPlate: z.union([plate, z.literal('')]).default(''),
  trailerPlate: z.union([plate, z.literal('')]).default(''),
  notes: optionalText,
  status: z.enum(driverStatuses).default('available'),
});
export const carrierSchema = z.object({
  name: shortText,
  cnpj: z
    .string()
    .transform(cleanCnpj)
    .refine(isValidCnpj, 'CNPJ inválido. Confira os 14 caracteres e os dois números finais.'),
  contact: shortText,
  phone,
  notes: optionalText,
  requiredDocuments: z
    .array(z.enum(categories))
    .max(categories.length)
    .transform((v) => [...new Set(v)]),
});
export const cargoSchema = z.object({
  carrierId: z.string().uuid('Selecione uma transportadora.'),
  selectedDriverId: z.string().uuid('Selecione um caminhoneiro.').nullable().optional(),
  paymentTerms: z.string().trim().max(120, 'Use até 120 caracteres para o pagamento.').optional(),
  originCity: shortText,
  originState: state,
  destinationCity: shortText,
  destinationState: state,
  cargoType: shortText,
  vehicleType: z.enum(vehicleTypes),
  bodyType: z.enum(bodyTypes).optional(),
  axleType: z.enum(axleTypes).optional(),
  freightCents: cents.refine((value) => value > 0, 'O valor do frete deve ser maior que zero.'),
  distanceKm: z
    .number()
    .positive('Informe uma distância maior que zero.')
    .max(100_000, 'A distância deve ser de até 100.000 km.')
    .multipleOf(0.1, 'Use até uma casa decimal nos quilômetros.')
    .nullable()
    .default(null),
  routeEstimate: routeEstimateSchema.nullable().default(null),
  scheduledDate: dateSchema,
  notes: z.string().trim().max(10_000, 'Use até 10.000 caracteres.').default(''),
  status: z.enum(cargoStatuses).default('available'),
});
export const DEFAULT_GOOD_RATE_CENTS = 700;
export const preferencesSchema = z
  .object({
    goodRateCents: z
      .number()
      .int('Use até 2 casas decimais.')
      .min(1, 'O mínimo deve ser maior que zero.')
      .max(100_000, 'O mínimo deve ser de até R$ 1.000,00/km.'),
  })
  .strict();
export type UserPreferences = z.infer<typeof preferencesSchema>;

export function parseDistanceKm(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const normalized = /^[1-9]\d{0,2}(\.\d{3})+(,\d)?$/.test(text)
    ? text.replace(/\./g, '').replace(',', '.')
    : text.replace(',', '.');
  return /^\d+(\.\d)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}
export const formatKm = (value: number) =>
  new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value);
export function freightAnalysis(
  freightCents: number,
  distanceKm: number | null | undefined,
  goodRateCents: number,
) {
  if (
    !Number.isFinite(freightCents) ||
    freightCents < 0 ||
    !distanceKm ||
    !Number.isFinite(distanceKm) ||
    distanceKm <= 0 ||
    !Number.isFinite(goodRateCents) ||
    goodRateCents <= 0
  )
    return null;
  const distanceMeters = Math.round(distanceKm * 1000);
  // Compare centavos inteiros antes de arredondar a exibição de R$/km.
  const minimumFreightCents = Math.ceil((goodRateCents * distanceMeters) / 1000);
  return {
    rateCents: (freightCents * 1000) / distanceMeters,
    quality: freightCents >= minimumFreightCents ? ('good' as const) : ('below' as const),
    minimumFreightCents,
    shortfallCents: Math.max(0, minimumFreightCents - freightCents),
  };
}
export const documentSchema = z
  .object({
    category: z.enum(categories),
    number: z.string().trim().max(120).default(''),
    issuedOn: optionalDate,
    expiresOn: optionalDate,
  })
  .refine((value) => value.category !== 'cpf' || !value.number || isValidCpf(value.number), {
    message: 'CPF inválido. Confira os 11 números, incluindo os dois últimos.',
    path: ['number'],
  })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    message: 'A validade deve ser igual ou posterior à emissão.',
    path: ['expiresOn'],
  });
export const deliverySchema = z.object({
  updateLocation: z.boolean(),
  available: z.boolean(),
});
export const agencySchema = z.object({
  cargoId: z.string().uuid('Selecione uma carga.'),
  driverId: z.string().uuid('Selecione um caminhoneiro.'),
  driverCpf: z
    .string()
    .transform(cleanCpf)
    .refine(isValidCpf, 'Confira o CPF do caminhoneiro.')
    .optional(),
  carrierId: z.string().uuid('Selecione uma transportadora.'),
  commissionCents: cents.refine((v) => v > 0, 'A comissão deve ser maior que zero.'),
  date: dateSchema,
  notes: optionalText,
  operationStatus: z.enum(operationStatuses).default('assigned'),
  delivery: deliverySchema.default({ updateLocation: false, available: false }),
  commissionStatus: z.enum(['pending', 'received']).default('pending'),
  payerName: z.string().trim().max(120).optional(),
  payerPhone: z.union([phone, z.literal('')]).optional(),
  dueOn: optionalDate.optional(),
});
export const commissionPlanSchema = z.object({
  payerName: z.string().trim().max(120).default(''),
  payerPhone: z.union([phone, z.literal('')]).default(''),
  dueOn: optionalDate,
});
export const correctionSchema = z.object({
  action: z.enum(['reopen', 'cancel', 'replace']),
  reason: z.string().trim().min(2, 'Informe o motivo.').max(500),
  commission: z.enum(['keep', 'waive']),
  replacementDriverId: z.string().uuid().optional(),
  replacementCpf: driverSchema.shape.cpf.optional(),
  replacementCommissionCents: cents.refine((v) => v > 0).optional(),
  confirmed: z.literal(true),
});
export const shareSchema = z
  .object({
    documentIds: z.array(z.string().uuid()).max(10),
    pixVersion: z.string().uuid().nullable().default(null),
    confirmed: z.literal(true, {
      error: 'Confirme os arquivos e o destinatário antes de preparar.',
    }),
  })
  .refine((value) => value.documentIds.length > 0 || value.pixVersion, {
    message: 'Selecione pelo menos um documento ou a chave Pix.',
    path: ['documentIds'],
  });
export const loginSchema = z.object({
  email: z
    .email()
    .max(200)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});
export type DriverInput = z.infer<typeof driverSchema>;
export type CarrierInput = z.infer<typeof carrierSchema>;
export type CargoInput = z.infer<typeof cargoSchema>;
export type AgencyInput = z.infer<typeof agencySchema>;
export type DocumentInput = z.infer<typeof documentSchema>;
export interface Driver extends DriverInput {
  id: string;
  createdAt: string;
  demo: boolean;
}
export interface Carrier extends CarrierInput {
  id: string;
  demo: boolean;
}
export interface Cargo extends CargoInput {
  id: string;
  carrierName: string;
  demo: boolean;
}
export type DocumentStatus = 'valid' | 'expiring' | 'expired' | 'missing';
export interface DriverDocument extends DocumentInput {
  id: string;
  driverId: string;
  filename: string;
  mime: string;
  size: number;
  updatedAt: string;
  status: DocumentStatus;
}
export interface ChecklistItem {
  category: Category;
  required: boolean;
  status: DocumentStatus;
  document: DriverDocument | null;
  pix?: PixKey | null;
}
export interface Match {
  driver: Driver;
  score: number;
  reasons: string[];
}
export interface Agency extends Omit<AgencyInput, 'commissionStatus'> {
  cancelledOn: string;
  cancellationReason: string;
  commissionStatus: Commission['status'];
  id: string;
  driverName: string;
  carrierName: string;
  route: string;
  createdAt: string;
}
export interface Commission {
  id: string;
  agencyId: string;
  driverId: string;
  driverName: string;
  carrierName: string;
  amountCents: number;
  status: 'pending' | 'received' | 'cancelled';
  payerName: string;
  payerPhone: string;
  dueOn: string;
  date: string;
  paidOn: string | null;
  route: string;
}
export interface Activity {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
  createdAt: string;
}
export interface Dashboard {
  waiting: number;
  available: number;
  ongoing: number;
  closed: number;
  pendingCents: number;
  receivedMonthCents: number;
  alerts: {
    driverId: string;
    driverName: string;
    category: Category;
    status: DocumentStatus;
    expiresOn: string;
  }[];
  waitingDrivers: Driver[];
  cargos: Cargo[];
  recentActivity: Activity[];
  nextActions: { title: string; detail: string; label: string; to: string }[];
}
export interface CargoJourney {
  agency: Agency;
  commission: Commission;
  driver: Driver;
}
export interface ShareManifest {
  files: { id: string; filename: string; mime: string; size: number; url: string }[];
  message: string;
  whatsappUrl: string;
  warnings: string[];
  carrierName: string;
  pixIncluded?: boolean;
}

export function today(timezone = 'America/Sao_Paulo', date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day']
    .map((type) => parts.find((p) => p.type === type)!.value)
    .join('-');
}
export function addDays(date: string, count: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
export function documentStatus(
  expiresOn: string,
  present = true,
  reference = today(),
): DocumentStatus {
  if (!present) return 'missing';
  if (!expiresOn) return 'valid';
  if (expiresOn < reference) return 'expired';
  return expiresOn <= addDays(reference, 30) ? 'expiring' : 'valid';
}
export const money = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);
export const formatDate = (date: string | null) =>
  date ? date.slice(0, 10).split('-').reverse().join('/') : '—';
export const maskCpf = (cpf: string) => {
  const value = cpf.replace(/\D/g, '').slice(-5);
  return value.length === 5 ? `***.***.${value.slice(0, 3)}-${value.slice(3)}` : '';
};
export const driverLocation = (driver: { city: string; state: string }) =>
  [driver.city, driver.state].filter(Boolean).join(' / ') || 'Localização a combinar';
export const maskCnpj = (cnpj: string) => {
  const value = cnpj
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(-6);
  return value.length === 6 ? `**.***.***/${value.slice(0, 4)}-${value.slice(4)}` : '';
};
export const maskNumber = (number: string) => (number ? `•••• ${number.slice(-4)}` : '');
export const whatsappUrl = (phoneValue: string, message = '') => {
  const digits = phoneValue.replace(/\D/g, '');
  if (!digits) return `https://wa.me/${message ? `?text=${encodeURIComponent(message)}` : ''}`;
  return `https://wa.me/${digits.length <= 11 ? '55' : ''}${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
};
export function compatibility(driver: Driver, cargo: CargoInput): Match | null {
  if (!['available', 'waiting'].includes(driver.status) || driver.vehicleType !== cargo.vehicleType)
    return null;
  if (driver.bodyType && cargo.bodyType && driver.bodyType !== cargo.bodyType) return null;
  if (driver.axleType && cargo.axleType && driver.axleType !== cargo.axleType) return null;
  const sameState = driver.state === cargo.originState;
  const sameCity = sameState && normalize(driver.city) === normalize(cargo.originCity);
  const desired = normalize(driver.desiredDestination);
  const sameDestination =
    !!desired &&
    [
      normalize(cargo.destinationCity),
      normalize(`${cargo.destinationCity}/${cargo.destinationState}`),
      normalize(`${cargo.destinationCity} - ${cargo.destinationState}`),
      normalize(cargo.destinationState),
    ].includes(desired);
  const reasons = ['Veículo compatível'];
  if (sameCity) reasons.push('Na cidade de origem');
  else if (sameState) reasons.push('No estado de origem');
  else reasons.push(driver.city && driver.state ? 'Em outro estado' : 'Confirmar onde está');
  if (sameDestination) reasons.push('Destino desejado');
  return {
    driver,
    score: 30 + (sameCity ? 50 : sameState ? 20 : 0) + (sameDestination ? 20 : 0),
    reasons,
  };
}
export const routeLabel = (cargo: CargoInput) =>
  `${cargo.originCity}/${cargo.originState} → ${cargo.destinationCity}/${cargo.destinationState}`;
