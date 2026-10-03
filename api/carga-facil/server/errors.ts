export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function required<T>(value: T | undefined | null, message = 'Registro não encontrado.'): T {
  if (value == null) throw new AppError(404, message);
  return value;
}
