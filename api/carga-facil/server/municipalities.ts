import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalize } from '../shared/domain.js';
import type { Municipality } from '../shared/routes.js';
import { AppError } from './errors.js';

export interface CityCoordinates extends Municipality {
  latitude: number;
  longitude: number;
}
const cities: CityCoordinates[] = JSON.parse(
  readFileSync(resolve('server/data/municipios.json'), 'utf8'),
);
const indexed = cities.map((city) => ({ city, key: normalize(`${city.name} ${city.state}`) }));
export function cityFromCargoText(name: string, state: string): string | undefined {
  const input = normalize(name);
  const matches = cities.filter(
    (city) =>
      city.state === state &&
      (normalize(city.name) === input ||
        input.startsWith(normalize(city.name) + ' na ') ||
        input.startsWith(normalize(city.name) + ' no ')),
  );
  return matches.length === 1 ? matches[0].name : undefined;
}
export function searchMunicipalities(query: string): Municipality[] {
  const search = normalize(query)
    .replace(/[/,–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (search.length < 2) return [];
  const tokens = search.split(' ');
  return indexed
    .filter(({ key }) => tokens.every((token) => key.includes(token)))
    .sort(
      (a, b) =>
        Number(!a.key.startsWith(search)) - Number(!b.key.startsWith(search)) ||
        a.city.name.localeCompare(b.city.name, 'pt-BR') ||
        a.city.state.localeCompare(b.city.state),
    )
    .slice(0, 10)
    .map(({ city: { id, name, state } }) => ({ id, name, state }));
}
export function findMunicipality(input: { name: string; state: string }): CityCoordinates {
  const city = cities.find(
    (city) => city.state === input.state && normalize(city.name) === normalize(input.name),
  );
  if (!city)
    throw new AppError(
      400,
      `Selecione ${input.name}/${input.state} nas sugestões de cidades ou confira o estado.`,
    );
  return city;
}
