import { dateSchema, type Category } from './domain.js';
import { cleanCpf, isValidCpf } from './validation.js';

export interface DocumentReading {
  expiresOn: string;
  issuedOn: string;
  plate: string;
  cpf: string;
  message: string;
  name?: string;
  category?: Category;
}

export const personalDocumentCategories: readonly Category[] = [
  'cnh',
  'cpf',
  'residence',
  'rntrc',
  'bank_details',
  'bank_receipt',
  'other',
];

export const vehicleDocumentCategories: readonly Category[] = ['truck', 'trailer'];

export type DocumentMatch = {
  method: 'cpf' | 'plate' | 'name' | 'none';
  label: string;
  autoSelect: boolean;
};

export function addMonths(value: string, months: number) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return '';
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(
    Math.min(day, lastDay),
  ).padStart(2, '0')}`;
}

export function documentExpirationFor(
  category: Category,
  issuedOn: string,
  suggestedExpiration = '',
) {
  if (category === 'rntrc' || category === 'bank_details' || category === 'bank_receipt') return '';
  // Contas usadas como comprovante vencem quatro meses depois da data da
  // própria conta. A data impressa como "vencimento" é a referência da conta,
  // não a validade cadastral do comprovante.
  if (category === 'residence') return issuedOn ? addMonths(issuedOn, 4) : suggestedExpiration;
  // CRLV de caminhão e carreta é renovado um ano após a data completa do
  // documento. O exercício em 31/12 só é uma alternativa quando o OCR não
  // encontrou dia e mês.
  if (vehicleDocumentCategories.includes(category))
    return issuedOn ? addMonths(issuedOn, 12) : suggestedExpiration;
  return suggestedExpiration;
}

// Only use dates beside explicit labels. Birth dates, CRLV exercise years and
// arbitrary dates are never used as expiration dates.
export function readDocumentFields(text: string): DocumentReading {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  const dates = (label: RegExp) => {
    const found = new Set<string>();
    for (const match of normalized.matchAll(label)) {
      const after = normalized.slice(
        match.index! + match[0].length,
        match.index! + match[0].length + 65,
      );
      const candidate = after.match(/^[\s:.-]{0,35}(\d{2})[./-](\d{2})[./-](\d{4})\b/);
      if (candidate) {
        const date = `${candidate[3]}-${candidate[2]}-${candidate[1]}`;
        if (dateSchema.safeParse(date).success) found.add(date);
      }
    }
    return found.size === 1 ? [...found][0] : '';
  };
  const dateValue = '(\\d{2})[./-](\\d{2})[./-](\\d{4})';
  // Na CNH Digital, os títulos "Data de emissão" e "Validade" ficam na
  // mesma linha e os dois valores aparecem na linha seguinte. Procurar apenas
  // a primeira data depois de "Validade" acabava usando a data de emissão.
  const cnhDatePair = normalized.match(
    new RegExp(
      `\\bDATA(?: DE)? EMISSAO\\b[\\s\\S]{0,70}?\\bVALIDADE\\b[\\s\\S]{0,90}?${dateValue}\\D{0,35}?${dateValue}`,
    ),
  );
  const asDate = (day?: string, month?: string, year?: string) => {
    if (!day || !month || !year) return '';
    const value = `${year}-${month}-${day}`;
    return dateSchema.safeParse(value).success ? value : '';
  };
  let issuedOn = cnhDatePair
    ? asDate(cnhDatePair[1], cnhDatePair[2], cnhDatePair[3])
    : dates(/\b(?:EMISSAO|EXPEDICAO)\b/g);
  let expiresOn = cnhDatePair
    ? asDate(cnhDatePair[4], cnhDatePair[5], cnhDatePair[6])
    : dates(/\b(?:VALIDADE|VALIDO ATE|VENCIMENTO|EXPIRATION)\b/g);
  if (expiresOn && issuedOn > expiresOn) issuedOn = '';
  const plates = [...normalized.matchAll(/\bPLACA\b/g)]
    .map(
      (match) =>
        normalized
          .slice(match.index! + match[0].length, match.index! + match[0].length + 180)
          .match(/\b([A-Z]{3}[- ]?\d[A-Z0-9]\d{2})\b/)?.[1],
    )
    .filter(Boolean)
    .map((plate) => plate!.replace(/[- ]/g, ''));
  const cpfTexts = [
    ...[...normalized.matchAll(/\bCPF\b/g)].flatMap((match) => {
      const after = normalized
        .slice(match.index! + match[0].length, match.index! + match[0].length + 70)
        .replace(/[OQD]/g, '0')
        .replace(/[IL]/g, '1')
        .replace(/S/g, '5');
      return [...after.matchAll(/(?:\d[.\s-]*){11}/g)].map((candidate) => candidate[0]);
    }),
    ...[...normalized.matchAll(/\b\d{3}[.\s]\d{3}[.\s]\d{3}[-\s]\d{2}\b/g)].map(
      (match) => match[0],
    ),
  ];
  const cpfs = cpfTexts.map(cleanCpf).filter(isValidCpf);
  const has = (pattern: RegExp) => pattern.test(normalized);
  const vehicleCertificate = has(
    /CERTIFICADO[\s\S]{0,100}REGISTRO[\s\S]{0,100}LICENCIAMENTO DE VEICULO|\bCRLV(?:-?E)?\b/,
  );
  const trailerDocument = has(/SEMI[\s-]?REBOQUE|\bREBOQUE\b|\bCARRETA\b/);
  // A mensagem institucional no rodapé do CRLV menciona “CNH”. O cabeçalho
  // oficial do veículo precisa ter prioridade para não trocar os documentos.
  const category: Category = vehicleCertificate
    ? trailerDocument
      ? 'trailer'
      : 'truck'
    : has(/CARTEIRA[\s\S]{0,35}HABILITACAO|\bCNH\b/)
      ? 'cnh'
      : has(/\bRNTRC\b|REGISTRO NACIONAL DE TRANSPORTADORES/)
        ? 'rntrc'
        : has(
              /COMPROVANTE (?:DE )?RESIDENCIA|FATURA DE (?:ENERGIA|AGUA)|CONTA DE (?:LUZ|AGUA|ENERGIA)|AGUA\s*[/E-]+\s*ESGOTO/,
            )
          ? 'residence'
          : has(/COMPROVANTE (?:DE )?(?:CONTA|ABERTURA DE CONTA|TITULARIDADE)/)
            ? 'bank_receipt'
            : has(
                  /DADOS BANCARIOS|(?:AGENCIA[\s\S]{0,40}CONTA|CONTA[\s\S]{0,40}AGENCIA)|\bAG\.?\s+\d{2,}[\s\S]{0,45}\bC\s*\/\s*C\b/,
                )
              ? 'bank_details'
              : trailerDocument
                ? 'trailer'
                : has(/\bCRLV\b|CERTIFICADO[\s\S]{0,80}LICENCIAMENTO|CAMINHAO|CAMINHAO.TRATOR/)
                  ? 'truck'
                  : has(
                        /CADASTRO DE PESSOAS FISICAS|COMPROVANTE[\s\S]{0,35}(?:CPF|SITUACAO CADASTRAL)|\bCPF\b/,
                      )
                    ? 'cpf'
                    : 'other';
  const allDates = [
    ...new Set(
      [...normalized.matchAll(/\b(\d{2})[./-](\d{2})[./-](\d{4})\b/g)]
        .map((match) => asDate(match[1], match[2], match[3]))
        .filter(Boolean),
    ),
  ];
  const onlyDate = allDates.length === 1 ? allDates[0] : '';
  if (category === 'residence') {
    const reference = issuedOn || expiresOn || onlyDate;
    issuedOn = reference;
    expiresOn = documentExpirationFor(category, reference);
  } else if (vehicleDocumentCategories.includes(category)) {
    const exercise = normalized.match(/\bEXERCICIO\b[\s\S]{0,100}?\b(20\d{2})\b/)?.[1];
    if (!issuedOn && !expiresOn) issuedOn = onlyDate;
    expiresOn = documentExpirationFor(
      category,
      issuedOn,
      exercise ? `${exercise}-12-31` : expiresOn,
    );
  } else if (category === 'rntrc') {
    issuedOn ||= dates(/\bCADASTRADO DESDE\b/g);
    expiresOn = documentExpirationFor(category, issuedOn, expiresOn);
  } else if (category === 'bank_details' || category === 'bank_receipt') {
    expiresOn = documentExpirationFor(category, issuedOn, expiresOn);
  }
  const names = [
    ...normalized.matchAll(
      /(?:^|\n)\s*(?:[12]\s+)?NOME(?: COMPLETO| DO CONDUTOR| E SOBRENOME)?\s*[:.-]?\s*([A-Z][A-Z ]{3,119})(?=\n|$)/g,
    ),
  ]
    .map((match) => match[1].trim())
    .filter(
      (name) =>
        name.split(/\s+/).length >= 2 &&
        !/FILIACAO|NASCIMENTO|VALIDADE|REGISTRO|DOCUMENTO/.test(name),
    );
  const inlineNames = [
    ...normalized.matchAll(
      /\bNOME(?: COMPLETO| DO CONDUTOR| E SOBRENOME)?\s*[:.-]?\s*([A-Z][A-Z ]{3,100}?)(?=\s+(?:CPF|DOCUMENTO|DOC\.?|DATA|NASCIMENTO|FILIACAO|VALIDADE|REGISTRO)\b)/g,
    ),
  ].map((match) => match[1].trim());
  names.push(
    ...inlineNames.filter(
      (name) =>
        name.split(/\s+/).length >= 2 &&
        !/FILIACAO|NASCIMENTO|VALIDADE|REGISTRO|DOCUMENTO/.test(name),
    ),
  );
  // PDFs oficiais da CNH-e trazem o cartão como imagem. O OCR costuma deformar
  // o pequeno título do campo "Nome e sobrenome", mas preserva o nome logo
  // antes de "Data, local e UF de nascimento". Essa posição é específica da
  // CNH e não é usada para documentos genéricos.
  if (category === 'cnh') {
    const cnhHeader = normalized.match(/CARTEIRA NACIONAL[^\n]{0,45}HABILITACAO[^\n]*/);
    const cnhStart = cnhHeader?.index ?? -1;
    const birthLabel = normalized.search(/DATA[^\n]{0,35}(?:LOCAL[^\n]{0,25})?NASCIMENTO/);
    if (cnhStart >= 0 && birthLabel > cnhStart) {
      const beforeBirth = normalized.slice(cnhStart, birthLabel).split('\n');
      for (const line of beforeBirth.slice(-3)) {
        const withoutDate = line
          .replace(/\d{2}[./-]\d{2}[./-]\d{4}[\s\]|]*$/g, '')
          .replace(/^[^A-Z]+|[^A-Z ]+$/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const candidate = withoutDate.match(/([A-Z]{2,}(?:\s+[A-Z]{2,}){1,7})$/)?.[1];
        if (
          candidate &&
          !/CARTEIRA|NACIONAL|HABILITACAO|DRIVER|LICENSE|PERMISO|CONDUCCION|NOME|SOBRENOME/.test(
            candidate,
          )
        )
          names.push(candidate);
      }
    }
    if (cnhHeader && cnhStart >= 0) {
      const afterHeader = normalized
        .slice(cnhStart + cnhHeader[0].length)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6);
      for (const line of afterHeader) {
        const candidate = line
          .replace(/^[^A-Z]+/, '')
          .split(/\s*(?:\[|\|)\s*/)[0]
          .replace(/\d{2}[./-]\d{2}[./-]\d{4}.*$/, '')
          .replace(/[^A-Z ]+$/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (
          /^[A-Z]{2,}(?:\s+[A-Z]{2,}){1,7}$/.test(candidate) &&
          !/CARTEIRA|NACIONAL|HABILITACAO|DRIVER|LICENSE|PERMISO|CONDUCCION|NOME|SOBRENOME|DATA|LOCAL|NASCIMENTO/.test(
            candidate,
          )
        ) {
          names.push(candidate);
          break;
        }
      }
    }
  }
  const uniqueNames = [...new Set(names.map((value) => value.replace(/\s+/g, ' ').trim()))];
  const name =
    !vehicleDocumentCategories.includes(category) && uniqueNames.length === 1 ? uniqueNames[0] : '';
  return {
    name,
    category,
    expiresOn,
    issuedOn,
    plate: new Set(plates).size === 1 ? plates[0] : '',
    cpf: new Set(cpfs).size === 1 ? cpfs[0] : '',
    message:
      category === 'rntrc'
        ? 'RNTRC / ANTT configurado como vitalício, sem vencimento.'
        : category === 'residence' && expiresOn
          ? 'Comprovante de residência válido por quatro meses a partir da data da conta.'
          : vehicleDocumentCategories.includes(category) && expiresOn
            ? 'Documento do veículo com renovação anual calculada pela data do documento.'
            : category === 'bank_details' || category === 'bank_receipt'
              ? 'Documento bancário sem vencimento automático.'
              : expiresOn
                ? 'Validade encontrada. Confira a data com o documento antes de salvar.'
                : 'Não encontrei uma validade clara. Você pode informar a data ou deixar em branco se não houver validade.',
  };
}
