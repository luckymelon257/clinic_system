import type { Scenario } from '../../src/types';
import { s6, s7, s8 } from './custom';
import { s1, s2, s3, s4, s5 } from './latency';

// S1–S8 (Neo4j vs PostgreSQL). Each scenario states why / expect / falsifiedIf. S8 restarts the engines — keep it last.
export const graphScenarios: Scenario[] = [s1, s2, s3, s4, s5, s6, s7, s8];
