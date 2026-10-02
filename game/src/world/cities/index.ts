import type { CityDef } from '../city';
import { HALLOWEEN } from './halloween';
import { NEW_YORK } from './newyork';
import { PARIS } from './paris';
import { SCRAP_CITY } from './scrap';
import { SHANGHAI } from './shanghai';

/** Arena levels in campaign order (Shanghai → New York → Paris); Scrap City is the bonus map, Halloween Town the event map. */
export const CITIES: CityDef[] = [SHANGHAI, NEW_YORK, PARIS, SCRAP_CITY, HALLOWEEN];

export function cityById(id: string): CityDef | undefined {
  return CITIES.find((c) => c.id === id);
}
