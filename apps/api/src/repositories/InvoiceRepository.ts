import type { Invoice, InvoiceItem, InvoiceItemInput, Payment, PaymentInput, RevenueRow, RouteQuery } from '@clinic/contracts';
import { BaseRepository, where, type Page } from '../db/BaseRepository';

export class InvoiceRepository extends BaseRepository {
  async list(q: RouteQuery<'listInvoices'>): Promise<Page<Invoice>> {
    const w = where({ patient_id: q.patientId, status: q.status });
    const p = w.page(q.limit, q.offset);
    // two literal views (not interpolated) so check:sql-access can verify them
    const [count, rows] = q.unpaidOnly
      ? [`SELECT count(*)::int AS n FROM v_unpaid_invoices ${w.sql}`, `SELECT * FROM v_unpaid_invoices ${w.sql}`]
      : [`SELECT count(*)::int AS n FROM v_invoices ${w.sql}`, `SELECT * FROM v_invoices ${w.sql}`];
    const total = await this.one<{ n: number }>(count, w.params);
    const items = await this.many<Invoice>(`${rows} ORDER BY created_at DESC, id DESC ${p.limit}`, p.params);
    return { items, total: total?.n ?? 0 };
  }

  findById(id: number) {
    return this.one<Invoice>('SELECT * FROM v_invoices WHERE id = $1', [id]);
  }

  items(invoiceId: number) {
    return this.many<InvoiceItem>('SELECT * FROM v_invoice_items WHERE invoice_id = $1 ORDER BY id', [invoiceId]);
  }

  payments(invoiceId: number) {
    return this.many<Payment>('SELECT * FROM v_payments WHERE invoice_id = $1 ORDER BY paid_at, id', [invoiceId]);
  }

  create(patientId: number, appointmentId: number | null, admissionId: number | null) {
    return this.callReturningId('sp_invoice_create', [patientId, appointmentId, admissionId]);
  }

  addItem(invoiceId: number, i: InvoiceItemInput) {
    return this.callReturningId('sp_invoice_add_item', [invoiceId, i.itemType, i.description, i.quantity, i.unitPrice]);
  }

  issue(invoiceId: number, dueDays = 14) {
    return this.call('sp_invoice_issue', [invoiceId, dueDays]);
  }

  registerPayment(invoiceId: number, p: PaymentInput) {
    return this.callReturningId('sp_payment_register', [invoiceId, p.amount, p.method, p.reference]);
  }

  revenue(q: RouteQuery<'revenue'>) {
    const w = where({}, [
      ["month >= date_trunc('month', $?::date)::date", q.from],
      ['month <= $?::date', q.to],
    ]);
    return this.many<RevenueRow>(`SELECT * FROM mv_monthly_revenue ${w.sql} ORDER BY month DESC, department_name, method`, w.params);
  }

  refreshReports() {
    return this.call('sp_refresh_reports', []);
  }
}
