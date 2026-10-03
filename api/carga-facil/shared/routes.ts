import { z } from 'zod';

export const cityInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    state: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();
export const municipalitySchema = cityInputSchema.extend({
  id: z.string().regex(/^\d{7}$/),
});
export type Municipality = z.infer<typeof municipalitySchema>;
export const routeRequestSchema = z
  .object({
    origin: cityInputSchema,
    destination: cityInputSchema,
    start: cityInputSchema.nullable().default(null),
  })
  .strict();
export type RouteRequest = z.infer<typeof routeRequestSchema>;
const km = z.number().min(0).max(100_000).multipleOf(0.1);
export const routeEstimateSchema = z
  .object({
    origin: municipalitySchema,
    destination: municipalitySchema,
    start: municipalitySchema.nullable(),
    loadedKm: km.positive(),
    approachKm: km.nullable(),
    totalKm: km.positive(),
    includeApproach: z.boolean(),
    source: z.literal('osrm'),
    calculatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((route, context) => {
    if (
      Math.round(route.totalKm * 10) !==
        Math.round(route.loadedKm * 10) + Math.round((route.approachKm || 0) * 10) ||
      Boolean(route.start) !== (route.approachKm !== null) ||
      (route.includeApproach && !route.start) ||
      route.origin.id === route.destination.id
    )
      context.addIssue({ code: 'custom', message: 'Os trechos da rota não são consistentes.' });
  });
export type RouteEstimate = z.infer<typeof routeEstimateSchema>;
export const routeDistanceKm = (route: RouteEstimate) =>
  route.includeApproach ? route.totalKm : route.loadedKm;

export function routeMatchesCargo(
  cargo: {
    originCity: string;
    originState: string;
    destinationCity: string;
    destinationState: string;
    distanceKm: number | null;
  },
  route: RouteEstimate,
) {
  const normalize = (value: string) =>
    value.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
  return (
    normalize(cargo.originCity) === normalize(route.origin.name) &&
    cargo.originState === route.origin.state &&
    normalize(cargo.destinationCity) === normalize(route.destination.name) &&
    cargo.destinationState === route.destination.state &&
    cargo.distanceKm === routeDistanceKm(route)
  );
}
