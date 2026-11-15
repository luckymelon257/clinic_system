import type { Scenario } from '../../src/types';
import { r1 } from './r1-slots';
import { r2 } from './r2-beds';
import { r3 } from './r3-triage';
import { r4 } from './r4-icu';

// R1–R4 (Redis vs PostgreSQL). Each scenario states why / expect / falsifiedIf.
export const redisScenarios: Scenario[] = [r1, r2, r3, r4];
