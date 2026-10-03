import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { routeRequestSchema, routeEstimateSchema, type RouteEstimate } from '../shared/routes.js';
import { findMunicipality, type CityCoordinates } from './municipalities.js';
import { AppError } from './errors.js';

const DEFAULT_ROUTER = 'https://routing.openstreetmap.de/routed-car';
const responseSchema = z.object({
  code: z.literal('Ok'),
  waypoints: z
    .array(z.object({ distance: z.number().min(0).max(10_000) }))
    .min(2)
    .max(3),
  routes: z
    .array(
      z.object({
        legs: z
          .array(z.object({ distance: z.number().min(0).max(100_000_000) }))
          .min(1)
          .max(2),
      }),
    )
    .min(1),
});
export function routingUrl(value = process.env.ROUTING_OSRM_URL || DEFAULT_ROUTER) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('ROUTING_OSRM_URL deve ser um endereço HTTPS sem credenciais ou parâmetros.');
  return url.href.replace(/\/$/, '');
}

export class RoutingService {
  private cache = new Map<string, { expires: number; value: RouteEstimate }>();
  private pending = new Map<string, Promise<RouteEstimate>>();
  private queue: Promise<void> = Promise.resolve();
  private nextRequest = 0;
  private unavailableUntil = 0;
  private readonly url: string;
  constructor(
    private readonly options: { url?: string; fetch?: typeof fetch; intervalMs?: number } = {},
  ) {
    this.url = routingUrl(options.url);
  }

  async calculate(input: unknown): Promise<RouteEstimate> {
    const request = routeRequestSchema.parse(input);
    const origin = findMunicipality(request.origin);
    const destination = findMunicipality(request.destination);
    const start = request.start ? findMunicipality(request.start) : null;
    if (origin.id === destination.id)
      throw new AppError(
        422,
        'A origem e o destino são a mesma cidade. Informe os quilômetros manualmente para esse percurso.',
      );
    const key = `${start?.id || ''}:${origin.id}:${destination.id}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.value);
    const active = this.pending.get(key);
    if (active) return structuredClone(await active);
    if (this.unavailableUntil > Date.now())
      throw new AppError(
        503,
        'O cálculo de rotas está temporariamente indisponível. Tente mais tarde ou informe os quilômetros.',
      );
    if (this.pending.size >= 10)
      throw new AppError(
        429,
        'Há muitas rotas sendo calculadas. Aguarde alguns instantes e tente novamente.',
      );
    const calculation = this.queue.then(async () => {
      await delay(Math.max(0, this.nextRequest - Date.now()));
      if (this.unavailableUntil > Date.now())
        throw new AppError(
          503,
          'O cálculo de rotas está temporariamente indisponível. Tente mais tarde ou informe os quilômetros.',
        );
      this.nextRequest = Date.now() + Math.max(0, this.options.intervalMs ?? 1100);
      return this.request(origin, destination, start);
    });
    this.queue = calculation.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(key, calculation);
    try {
      const value = await calculation;
      if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, expires: Date.now() + 24 * 60 * 60_000 });
      return structuredClone(value);
    } finally {
      this.pending.delete(key);
    }
  }

  private async request(
    origin: CityCoordinates,
    destination: CityCoordinates,
    start: CityCoordinates | null,
  ): Promise<RouteEstimate> {
    const hasApproach = Boolean(start && start.id !== origin.id);
    const points = hasApproach ? [start!, origin, destination] : [origin, destination];
    const coordinates = points.map((point) => `${point.longitude},${point.latitude}`).join(';');
    try {
      const response = await (this.options.fetch || fetch)(
        `${this.url}/route/v1/driving/${coordinates}?overview=false&steps=false&alternatives=false&continue_straight=false`,
        {
          signal: AbortSignal.timeout(12_000),
          redirect: 'error',
          headers: {
            'User-Agent': 'CargaFacil/1.1 (https://github.com/Dev-ThiagoMazuco/carga-facil)',
            Accept: 'application/json',
          },
        },
      );
      if (response.status === 429 || response.status === 503)
        this.unavailableUntil = Date.now() + 60_000;
      if (!response.ok)
        throw new AppError(
          503,
          'O serviço de rotas não respondeu. Tente novamente ou informe os quilômetros manualmente.',
        );
      const raw = await response.text();
      if (raw.length > 100_000) throw new Error('Resposta de rota excedeu o limite.');
      const data = responseSchema.safeParse(JSON.parse(raw));
      if (
        !data.success ||
        data.data.waypoints.length !== points.length ||
        data.data.routes[0].legs.length !== points.length - 1
      )
        throw new AppError(
          422,
          'Não encontramos uma rota rodoviária confiável entre essas cidades. Confira o percurso e informe os quilômetros manualmente.',
        );
      const legs = data.data.routes[0].legs;
      const loadedKm = Math.round(legs[hasApproach ? 1 : 0].distance / 100) / 10;
      const approachKm = start ? (hasApproach ? Math.round(legs[0].distance / 100) / 10 : 0) : null;
      if (loadedKm <= 0)
        throw new AppError(
          422,
          'O percurso é curto demais para estimar entre cidades. Informe os quilômetros manualmente.',
        );
      const publicCity = ({ id, name, state }: CityCoordinates) => ({ id, name, state });
      return routeEstimateSchema.parse({
        origin: publicCity(origin),
        destination: publicCity(destination),
        start: start ? publicCity(start) : null,
        loadedKm,
        approachKm,
        totalKm: Math.round((loadedKm + (approachKm || 0)) * 10) / 10,
        includeApproach: Boolean(start),
        source: 'osrm',
        calculatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'Não foi possível calcular a rota agora. Tente novamente ou informe os quilômetros manualmente.',
      );
    }
  }
}
