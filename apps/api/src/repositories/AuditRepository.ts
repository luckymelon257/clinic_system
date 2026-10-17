import type { AuditEntry, DeletedRecord, RouteQuery, SoftDeleteTable } from '@clinic/contracts';
import { BaseRepository, where, type Page } from '../db/BaseRepository';

export class AuditRepository extends BaseRepository {
  async list(q: RouteQuery<'auditLog'>): Promise<Page<AuditEntry>> {
    const w = where({ table_name: q.tableName, record_id: q.recordId, changed_by: q.changedBy, operation: q.operation });
    const p = w.page(q.limit, q.offset);
    const total = await this.one<{ n: number }>(`SELECT count(*)::int AS n FROM v_audit_log ${w.sql}`, w.params);
    const items = await this.many<AuditEntry>(`SELECT * FROM v_audit_log ${w.sql} ORDER BY changed_at DESC, id DESC ${p.limit}`, p.params);
    return { items, total: total?.n ?? 0 };
  }

  deleted(q: RouteQuery<'deletedRecords'>) {
    const w = where({ table_name: q.tableName });
    return this.many<DeletedRecord>(`SELECT * FROM v_deleted_records ${w.sql} ORDER BY deleted_at DESC`, w.params);
  }

  softDelete(table: SoftDeleteTable, id: number) {
    return this.call('sp_soft_delete', [table, id]);
  }

  restore(table: SoftDeleteTable, id: number) {
    return this.call('sp_restore', [table, id]);
  }
}
