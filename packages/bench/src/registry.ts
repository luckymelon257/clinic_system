import { graphScenarios } from '../scenarios/graph/index';
import { redisScenarios } from '../scenarios/redis/index';
import type { Scenario } from './types';

/** All scenarios in report order. Graph (S1–S8), then Redis (R1–R4). */
export const scenarios: Scenario[] = [...graphScenarios, ...redisScenarios];

export function pick(ids: readonly string[] | null, all: readonly Scenario[] = scenarios): Scenario[] {
  if (!ids || ids.length === 0) return [...all];
  const wanted = new Set(ids.map((s) => s.toUpperCase()));
  const found = all.filter((s) => wanted.has(s.id.toUpperCase()));
  const missing = [...wanted].filter((id) => !found.some((s) => s.id.toUpperCase() === id));
  if (missing.length) throw new Error(`unknown scenario(s): ${missing.join(', ')}; known: ${all.map((s) => s.id).join(', ') || 'none'}`);
  return found;
}
