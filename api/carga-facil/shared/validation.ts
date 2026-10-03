// Validação local de formato e dígitos. Não consulta titularidade ou situação cadastral.
export const cleanCpf = (value: string) => value.trim().replace(/[.\s-]/g, '');
export const cleanCnpj = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[./\s-]/g, '');

function digit(value: string, weights: number[]) {
  const remainder =
    [...value].reduce((sum, char, index) => sum + (char.charCodeAt(0) - 48) * weights[index], 0) %
    11;
  return String(remainder < 2 ? 0 : 11 - remainder);
}
export function isValidCpf(input: string) {
  const value = cleanCpf(input);
  if (!/^\d{11}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  const first = digit(value.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = digit(value.slice(0, 9) + first, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return value.endsWith(first + second);
}
export function isValidCnpj(input: string) {
  const value = cleanCnpj(input);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(value) || /^(.)\1+$/.test(value)) return false;
  const first = digit(value.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = digit(value.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return value.endsWith(first + second);
}
const areaCodes = new Set(
  '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(
    ' ',
  ),
);
export function cleanPhone(input: string) {
  const value = input.trim().replace(/[()\s.-]/g, '');
  if (/^\+55\d{10,11}$/.test(value)) return value.slice(3);
  if (/^55\d{10,11}$/.test(value)) return value.slice(2);
  return value;
}
export function isValidPhone(input: string) {
  const value = cleanPhone(input);
  return (
    /^\d{10,11}$/.test(value) &&
    areaCodes.has(value.slice(0, 2)) &&
    /^(9\d{8}|[2-5]\d{7})$/.test(value.slice(2))
  );
}

export function formatCpf(input: string) {
  const value = cleanCpf(input);
  return /^\d{11}$/.test(value)
    ? value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
    : input;
}
export function formatCnpj(input: string) {
  const value = cleanCnpj(input);
  return /^[A-Z0-9]{12}\d{2}$/.test(value)
    ? value.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5')
    : input;
}
export function formatPhone(input: string) {
  const value = cleanPhone(input);
  return /^\d{10,11}$/.test(value)
    ? value.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3')
    : input;
}

// Máscaras progressivas usadas durante a digitação. Elas limitam o tamanho e
// inserem a pontuação sem exigir que o campo esteja completo.
export function maskCpfInput(input: string) {
  const value = input.replace(/\D/g, '').slice(0, 11);
  return value
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

export function maskCnpjInput(input: string) {
  const value = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 14);
  return value
    .replace(/^(.{2})(.)/, '$1.$2')
    .replace(/^(.{2})\.(.{3})(.)/, '$1.$2.$3')
    .replace(/^(.{2})\.(.{3})\.(.{3})(.)/, '$1.$2.$3/$4')
    .replace(/^(.{2})\.(.{3})\.(.{3})\/(.{4})(.)/, '$1.$2.$3/$4-$5');
}

export function maskPhoneInput(input: string) {
  let value = input.replace(/\D/g, '');
  if (value.startsWith('55') && value.length > 11) value = value.slice(2);
  value = value.slice(0, 11);
  if (!value) return '';
  if (value.length < 3) return `(${value}`;
  const ddd = value.slice(0, 2);
  const local = value.slice(2);
  if (local.length <= 4) return `(${ddd}) ${local}`;
  const split = local.length > 8 ? 5 : 4;
  return `(${ddd}) ${local.slice(0, split)}-${local.slice(split)}`;
}

export function maskPlateInput(input: string) {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 7);
}

export function parseMoney(input: string) {
  const value = input.trim().replace(/^R\$\s*/, '');
  // Ponto com três dígitos é milhar; decimal aceita vírgula ou ponto com até duas casas.
  const grouped = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(value);
  if (!grouped && !/^\d+([,.]\d{1,2})?$/.test(value)) return Number.NaN;
  const normalized = (grouped ? value.replace(/\./g, '') : value).replace(',', '.');
  const [whole, decimals = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : Number.NaN;
}
