import type { InteractionSeverity } from '@clinic/contracts';
import { BaseRepository } from '../db/BaseRepository';

export interface PersonRow {
  personKind: 'patient' | 'staff';
  personId: number;
  name: string;
  role: 'doctor' | 'nurse' | null;
}

export interface InteractionDbRow {
  medicationA: number;
  medicationB: number;
  severity: InteractionSeverity;
  via: 'direct' | 'class';
  classA: number | null;
  classB: number | null;
}

/** Graph model in SQL terms (migrations 009 / 010): names for graph answers and the PG fallback (D-28). */
export class GraphRepository extends BaseRepository {
  person(kind: string, id: number) {
    return this.one<PersonRow>('SELECT person_kind, person_id, name, role FROM v_graph_persons WHERE person_kind = $1 AND person_id = $2', [kind, id]);
  }

  medicationNames(ids: number[]) {
    return this.many<{ id: number; name: string }>('SELECT id, name FROM v_medications WHERE id = ANY ($1::int[])', [ids]);
  }

  classNames(ids: number[]) {
    return this.many<{ id: number; name: string }>('SELECT id, name FROM v_drug_classes WHERE id = ANY ($1::int[])', [ids]);
  }

  interactions(ids: number[], patientId: number | null, at: string | null) {
    return this.many<InteractionDbRow>(
      `SELECT medication_a, medication_b, severity, via, class_a, class_b
       FROM fn_drug_interactions($1::int[], $2, coalesce($3::timestamptz, now())) ORDER BY 1, 2, 4 DESC, 5, 6`,
      [ids, patientId, at],
    );
  }

  async activeMedications(patientId: number, at: string | null): Promise<number[]> {
    const rows = await this.many<{ medicationId: number }>(
      'SELECT DISTINCT medication_id FROM fn_patient_active_medications($1, coalesce($2::timestamptz, now())) ORDER BY 1',
      [patientId, at],
    );
    return rows.map((r) => r.medicationId);
  }
}
