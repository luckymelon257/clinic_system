// @clinic/graph — graph read-model of the hospital (Lab 2):
//   neo4j/  schema + read queries (tracing, exposure path, drug interactions, flat aggregate, counts)
//   sync/   PostgreSQL → Neo4j: full ETL and transactional-outbox worker (D-23)
//   gen/, validate.ts  bench data generator and density gate
export * from './neo4j/index';
export * from './sync/index';
