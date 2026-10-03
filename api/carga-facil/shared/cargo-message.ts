import {
  bodyTypes,
  vehicleTypes,
  states,
  normalize,
  dateSchema,
  type CargoInput,
} from './domain.js';
import { parseMoney } from './validation.js';

export type CargoSuggestion = Partial<
  Pick<
    CargoInput,
    | 'originCity'
    | 'originState'
    | 'destinationCity'
    | 'destinationState'
    | 'cargoType'
    | 'vehicleType'
    | 'bodyType'
    | 'axleType'
    | 'scheduledDate'
    | 'paymentTerms'
  >
> & { freight?: string; carrierName?: string; distanceKm?: number };
export type CityResolver = (name: string, state: string) => string | undefined;

export function splitCargoMessages(message: string) {
  const text = message.slice(0, 10_000).trim();
  if (!text) return [];
  const lines = text.split(/\n/);
  const uf = `(?:${states.join('|')})`;
  const routeLine = new RegExp(`\\b${uf}\\b.*(?:→|➡|➜|->|=>|\\bpara\\b|\\bx\\b)`, 'i');
  const starts = lines.reduce<number[]>((found, line, index) => {
    if (/^\W*(?:origem\s*[:=-]|(?:tenho\s+)?frete\s+de\s+)/i.test(line) || routeLine.test(line))
      found.push(index);
    return found;
  }, []);
  if (starts.length < 2) return [text];
  return starts.slice(0, 20).map((start, index) =>
    lines
      .slice(index === 0 ? 0 : start, starts[index + 1] ?? lines.length)
      .join('\n')
      .trim(),
  );
}

export function parseCargoMessages(message: string, today?: string, resolveCity?: CityResolver) {
  return splitCargoMessages(message).map((text) => ({
    text,
    data: parseCargoMessage(text, today, resolveCity),
  }));
}

// Deterministic extraction: text is data, never an instruction or executable prompt.
export function parseCargoMessage(message: string, today?: string, resolveCity?: CityResolver) {
  const text = message
    .slice(0, 10000)
    .replace(/[*_~]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\bRS\s*\$/gi, 'R$');
  const plain = normalize(text);
  const suggestion: CargoSuggestion = {};
  const warnings: string[] = [];
  const details: string[] = [];
  const label =
    /\b((?:origem|destino|coleta|descarga|produto|tipo de carga|carga|ve[ií]culo|carroceria|peso|peeso|pagamento|valor(?: do frete)?|observa[çc][õo]es|data(?: prevista)?|transportadora|empresa)\s*:|frete\s*:?\s*(?=(?:R\$\s*)?\d))/gi;
  const rawLines = text
    .replace(label, '\n$1')
    .split(/\n/)
    .map((s) => s.replace(/^[^\p{L}\d]+/u, '').trim())
    .filter(Boolean);
  const lines: string[] = [];
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index];
    const next = rawLines[index + 1];
    // O OCR frequentemente quebra "CIDADE-UF X CIDADE-UF" logo depois do X.
    // Reunir somente uma linha que termina no separador evita misturar outros
    // dados do anúncio com origem e destino.
    if (
      next &&
      /(?:→|➡\uFE0F?|➜|->|=>|\bpara|\bx)\s*$/i.test(line) &&
      new RegExp(`(?:/|-|,|\\(|\\s)(?:${states.join('|')})\\b`, 'i').test(next)
    ) {
      lines.push(`${line} ${next}`);
      index += 1;
    } else lines.push(line);
  }
  const ufPattern = states.join('|');
  function city(raw: string | undefined, kind: 'origin' | 'destination') {
    if (!raw) return;
    // Um alfinete no Status pode virar "1" no OCR. Ele não faz parte da cidade.
    raw = raw.replace(/^[^\p{L}]+/u, '');
    const prefix = raw.trim().match(new RegExp(`^(${ufPattern})\\s*[-/:]\\s*(.+)$`, 'i'));
    if (prefix) raw = `${prefix[2]} - ${prefix[1]}`;
    const match = raw
      .trim()
      .match(
        new RegExp(
          `^([\\p{L}][\\p{L}\\s.'’()-]{1,100}?)\\s*(?:/|-|,|\\(|\\s)\\s*(${ufPattern})\\b`,
          'iu',
        ),
      );
    if (!match) return;
    const state = match[2].toUpperCase();
    const name = resolveCity ? resolveCity(match[1].trim(), state) : match[1].trim();
    if (!name) return;
    Object.assign(suggestion, { [`${kind}City`]: name, [`${kind}State`]: state });
  }
  const originLabel = /^(?:origem|coleta|carregamento)\s*[:=-]\s*/i;
  const destinationLabel = /^(?:destino|entrega|descarga)\s*[:=-]\s*/i;
  const origins = lines.filter(
    (line) => originLabel.test(line) && !/^\d/.test(line.replace(originLabel, '')),
  );
  const destinations = lines.filter(
    (line) => destinationLabel.test(line) && !/^\d/.test(line.replace(destinationLabel, '')),
  );
  if (origins.length === 1) city(origins[0].replace(originLabel, ''), 'origin');
  if (destinations.length === 1) city(destinations[0].replace(destinationLabel, ''), 'destination');
  const separator = /\s*(?:→|➡\uFE0F?|➜|->|=>|\bpara\b|\bx\b)\s*/i;
  const routes = lines
    .map((line) => line.replace(/^(?:tenho\s+)?frete\s+de\s+/i, '').split(separator))
    .filter(
      (parts) =>
        parts.length === 2 &&
        parts.every((part) => new RegExp(`\\b(?:${ufPattern})\\b`, 'i').test(part)),
    );
  if (routes.length === 1 && !origins.length && !destinations.length) {
    city(routes[0][0], 'origin');
    city(routes[0][1], 'destination');
  }
  const multipleCargos =
    origins.length > 1 ||
    destinations.length > 1 ||
    routes.length > 1 ||
    (routes.length > 0 && origins.length > 0);
  if (multipleCargos)
    warnings.push('Cole uma carga por vez para não misturar percursos e valores.');
  const types = lines.filter((line) => /^(?:produto|tipo de carga|carga)\s*[:=-]/i.test(line));
  if (types.length === 1) {
    const value = types[0]
      .replace(/^[^:=-]+[:=-]\s*/, '')
      .replace(/[^\p{L}\d]+$/u, '')
      .replace(/\s+[A-Za-z]{1,2}$/, '')
      .trim();
    if (value.length >= 2 && value.length <= 120) suggestion.cargoType = value;
  } else if (!types.length) {
    const products = lines.filter((line) =>
      /^(?:soja|milho|trigo|arroz|feij[aã]o|farelo|adubo|fertilizante|madeira|areia|brita|cimento|aç[uú]car)$/i.test(
        line,
      ),
    );
    if (products.length === 1) suggestion.cargoType = products[0];
  }
  const freightLabel = /^(?:valor(?: do frete)?|frete)\s*[:=-]?\s*/i;
  const freightLines = lines.filter((line) =>
    /^(?:(?:valor(?: do frete)?|frete)\s*[:=-]?\s*(?:R\$\s*)?|R\$\s*)\d/i.test(line),
  );
  if (freightLines.length === 1) {
    const value = freightLines[0].replace(freightLabel, '');
    const match = value.match(/^(?:R\$\s*)?(\d[\d.,]*)\s*/i);
    const tail = match ? value.slice(match[0].length) : '';
    const unsafe =
      /^(?:\/|por\b|ton\b|tonelada|t\b|kg\b|km\b|\+\s*\d)|\bou\s+(?:R\$\s*)?\d|R\$\s*\d/i.test(
        tail,
      );
    const cents = match ? parseMoney(match[1]) : NaN;
    if (!unsafe && Number.isFinite(cents) && cents > 0 && cents <= 100000000)
      suggestion.freight = (cents / 100).toFixed(2).replace('.', ',');
    else
      warnings.push(
        'O frete precisa ser o total da viagem. Valor por tonelada ou por km não foi convertido.',
      );
  }
  if (/\+\s*ped[aá]gio/i.test(text))
    details.push('Pedágio à parte: o valor informado não inclui o pedágio.');
  const weight = text.match(/\bpe{1,2}so\s*:?\s*(\d[\d.,]*)\s*(toneladas?|tons?\b|t\b|kg\b)/i);
  if (weight) details.push(`Peso: ${weight[1]} ${weight[2]}`);
  else {
    const standaloneWeight = text.match(
      /(?<![\d.,])\b(\d{1,3}(?:[.,]\d{1,3})?)\s*(tons?|toneladas?)\b/i,
    );
    if (standaloneWeight) {
      const numeric = Number(standaloneWeight[1].replace(',', '.'));
      if (Number.isFinite(numeric) && numeric > 0 && numeric <= 100)
        details.push(
          `Peso: ${numeric.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} toneladas`,
        );
    }
  }
  const deliveries = text.match(/(?<![\d/.,])\b(\d{1,2})[ \t]+entregas?\b/i);
  if (deliveries) {
    const total = Number(deliveries[1]);
    details.push(`${total} entrega${total === 1 ? '' : 's'}`);
  }
  const deliveryPlace = text.match(/\bentrega\s+(?:na|no|em)\s+([^\n.]{2,80})/i);
  if (deliveryPlace) details.push(`Entrega: ${deliveryPlace[1].trim()}`);
  const vehicleLength = text.match(
    /\bcarreta\s+com\s+(\d{1,2}(?:[.,]\d)?)\s*metros?\s+ou\s+maior\b/i,
  );
  if (vehicleLength)
    details.push(`Carreta com ${vehicleLength[1].replace('.', ',')} metros ou mais`);
  const payment = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b(?!\s*\/\d)/);
  if (payment && Number(payment[1]) + Number(payment[2]) === 100) {
    suggestion.paymentTerms = `${payment[1]}/${payment[2]}`;
    details.push(`Pagamento informado: ${suggestion.paymentTerms}`);
  }
  const deadline = text.match(/\bdocumento[s]?\s+at[eé]\s+(\d{1,2}:\d{2})/i);
  if (deadline) details.push(`Documentos até ${deadline[1]}`);
  const axles = text.match(/\b([2-9])\s*eixos?\b/i);
  if (axles) details.push(`${axles[1]} eixos (conforme o texto)`);
  const carrierLines = lines.filter((line) => /^(?:transportadora|empresa)\s*[:=-]/i.test(line));
  if (carrierLines.length === 1)
    suggestion.carrierName = carrierLines[0].replace(/^[^:=-]+[:=-]\s*/, '').trim();
  const distances = [...text.matchAll(/(?<![\d.,/])\b(\d[\d.,]*)\s*km\b/gi)].filter(
    (m) => !/(?:R\$|por|\/)\s*$/i.test(text.slice(Math.max(0, m.index - 8), m.index)),
  );
  if (distances.length === 1) {
    const km = Number(distances[0][1].replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'));
    if (Number.isFinite(km) && km > 0 && km <= 100000 && Number.isInteger(km * 10))
      suggestion.distanceKm = km;
  }
  const equipment = vehicleTypes.filter((type) =>
    new RegExp(`\\b${normalize(type)}\\b`).test(plain),
  );
  if (equipment.length === 1) suggestion.vehicleType = equipment[0];
  const bodies = bodyTypes.filter(
    (type) => type && new RegExp(`\\b${normalize(type)}\\b`).test(plain),
  );
  if (bodies.length === 1) suggestion.bodyType = bodies[0];
  const ls = /\bls\b/.test(plain);
  if (ls !== Boolean(axles)) {
    suggestion.axleType = ls ? 'LS' : (`${axles![1]} eixos` as CargoInput['axleType']);
    if (ls && !equipment.length) suggestion.vehicleType = 'Carreta';
  }
  if (bodies.length > 1 || equipment.length > 1 || (ls && axles))
    warnings.push('Há mais de uma opção de caminhão no texto. Confira qual atende a carga.');
  const collectionDate = text.match(
    /\b(?:coleta|carregamento|carregar|data(?: prevista)?)(?:\s+(?:em|dia))?\s*[:=-]?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/i,
  );
  const dates = collectionDate
    ? [collectionDate]
    : [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)];
  if (dates.length === 1) {
    const m = dates[0];
    const day = `${m[3] || today?.slice(0, 4) || ''}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (dateSchema.safeParse(day).success) suggestion.scheduledDate = day;
  }
  const relative = [...plain.matchAll(/\b(hoje|amanha)\b/g)];
  if (today && dateSchema.safeParse(today).success && !dates.length && relative.length === 1) {
    const day = new Date(today + 'T12:00:00Z');
    if (relative[0][1] === 'amanha') day.setUTCDate(day.getUTCDate() + 1);
    suggestion.scheduledDate = day.toISOString().slice(0, 10);
  }
  if (!suggestion.originCity || !suggestion.destinationCity)
    warnings.push('Complete as cidades e estados que não foram identificados.');
  if (!suggestion.scheduledDate)
    warnings.push('Escolha a data da carga. O texto não trouxe uma data completa e válida.');
  return { suggestion, warnings, details, multipleCargos };
}
