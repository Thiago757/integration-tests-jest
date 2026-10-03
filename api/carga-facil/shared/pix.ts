import { z } from 'zod';
import {
  cleanCpf,
  cleanCnpj,
  cleanPhone,
  isValidCpf,
  isValidCnpj,
  isValidPhone,
} from './validation.js';

export type PixType = 'cpf' | 'cnpj' | 'celular' | 'email' | 'aleatoria';
export interface PixKey {
  key: string;
  type: PixType;
  version: string;
  updatedAt: string;
}
export const pixTypeLabels: Record<PixType, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  celular: 'Celular',
  email: 'E-mail',
  aleatoria: 'Chave aleatória',
};

// Conferência local de formato. Não consulta o banco nem registra uma chave no DICT.
export function normalizePix(input: string): Pick<PixKey, 'key' | 'type'> | null {
  const value = input.trim();
  const lower = value.toLowerCase();
  if (value.length > 77) return null;
  if (
    /^[a-z0-9.!#$'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      lower,
    )
  )
    return { key: lower, type: 'email' };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(lower))
    return { key: lower, type: 'aleatoria' };
  const phone = value.replace(/[()\s.-]/g, '');
  if (phone.startsWith('+')) {
    if (!/^\+[1-9]\d{1,14}$/.test(phone)) return null;
    if (
      phone.startsWith('+55') &&
      (!isValidPhone(phone) || !/^\d{2}9\d{8}$/.test(cleanPhone(phone)))
    )
      return null;
    return { key: phone, type: 'celular' };
  }
  if (value.includes('(') && isValidPhone(value) && /^\d{2}9\d{8}$/.test(cleanPhone(value)))
    return { key: `+55${cleanPhone(value)}`, type: 'celular' };
  if (isValidCpf(value)) return { key: cleanCpf(value), type: 'cpf' };
  if (isValidCnpj(value)) return { key: cleanCnpj(value), type: 'cnpj' };
  return null;
}
export const pixInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .max(77, 'Use até 77 caracteres.')
      .transform((value, context) => {
        if (!value) return null;
        const result = normalizePix(value);
        if (result) return result;
        context.addIssue({
          code: 'custom',
          message:
            'Confira a chave Pix: CPF, CNPJ, e-mail ou chave aleatória. Para celular, use +55 e o DDD.',
        });
        return z.NEVER;
      }),
  })
  .strict();
