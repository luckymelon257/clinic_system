# Архітектура застосунку (Express + pg)

## Структура проєкту

```
clinic_system/
├─ db/
│  ├─ migrations/          # впорядковані SQL-файли, виконуються скриптом migrate.js
│  │  ├─ 001_extensions_types.sql
│  │  ├─ 002_tables.sql
│  │  ├─ 003_indexes.sql
│  │  ├─ 004_audit_softdelete.sql
│  │  ├─ 005_functions.sql
│  │  ├─ 006_procedures.sql
│  │  ├─ 007_business_triggers.sql
│  │  └─ 008_views.sql
│  └─ seeds/               # довідники + демо-дані (generate_series для обсягу)
├─ src/
│  ├─ config/              # env, pg Pool
│  ├─ db/
│  │  ├─ UnitOfWork.js
│  │  └─ BaseRepository.js
│  ├─ repositories/        # PatientRepository, AppointmentRepository, ...
│  ├─ services/            # бізнес-сценарії, що використовують UoW
│  ├─ routes/              # REST API (/api/...)
│  ├─ web/                 # простий UI: EJS + Bootstrap (сторінки поверх тих самих сервісів)
│  ├─ middleware/          # auth (JWT/сесія), RBAC, валідація, обробка помилок
│  └─ app.js
├─ docker-compose.yml      # postgres:16
└─ docs/
```

## Repository + Unit of Work

**Правило:** репозиторії **читають тільки з view/функцій** і **пишуть тільки через `CALL sp_…`**. Прямих `INSERT/UPDATE/DELETE` у коді немає.

```js
// src/db/UnitOfWork.js (ескіз)
class UnitOfWork {
  constructor(pool, currentUserId) { this.pool = pool; this.userId = currentUserId; }

  async begin() {
    this.client = await this.pool.connect();
    await this.client.query('BEGIN');
    await this.client.query("SELECT set_config('app.current_user_id', $1, true)", [String(this.userId ?? '')]);
  }

  // репозиторії створюються ліниво й ділять ОДИН client => одну транзакцію
  get patients()      { return this._repo('patients', PatientRepository); }
  get appointments()  { return this._repo('appointments', AppointmentRepository); }
  get medicalRecords(){ return this._repo('medicalRecords', MedicalRecordRepository); }
  get prescriptions() { return this._repo('prescriptions', PrescriptionRepository); }
  get labOrders()     { return this._repo('labOrders', LabOrderRepository); }
  get admissions()    { return this._repo('admissions', AdmissionRepository); }
  get invoices()      { return this._repo('invoices', InvoiceRepository); }
  get payments()      { return this._repo('payments', PaymentRepository); }

  async commit()   { await this.client.query('COMMIT');   this._release(); }
  async rollback() { await this.client.query('ROLLBACK'); this._release(); }

  // хелпер: uow.run(async (u) => {...}) — commit або rollback автоматично
  static async run(pool, userId, work) { /* begin → work(uow) → commit | rollback */ }
}
```

```js
// приклад репозиторію
class AppointmentRepository extends BaseRepository {
  findById(id)            { return this.one('SELECT * FROM v_appointments WHERE id = $1', [id]); }
  findByDoctorAndDate(d,t){ return this.many('SELECT * FROM v_appointments WHERE doctor_id=$1 AND starts_at::date=$2', [d,t]); }
  freeSlots(d, date)      { return this.many('SELECT * FROM fn_doctor_free_slots($1,$2)', [d, date]); }
  book(dto)               { return this.callReturningId('sp_appointment_book', [dto.patientId, dto.doctorId, dto.startsAt, dto.reason]); }
  cancel(id, reason)      { return this.call('sp_appointment_cancel', [id, reason]); }
}
```

## Бізнес-сценарії з кількома сутностями в одній транзакції

1. **Завершення прийому** (`VisitService.complete`)
   `medicalRecords.create` → `diagnoses.add ×N` → `prescriptions.create` (з позиціями) → `labOrders.create` → `invoices.create` + `addItem(консультація)` → `invoices.issue`.
   Будь-яка помилка (невалідний МКХ-код, видалений препарат) → **rollback усього**.
2. **Госпіталізація / виписка** (`InpatientService`)
   `admissions.admit` (тригер займає ліжко) … `admissions.discharge` → `invoices.generateForAdmission` → `payments.register`.
3. **Реєстрація пацієнта з полісом і записом** (`RegistrationService`)
   `patients.create` → `patients.addInsurance` → `appointments.book`.

## UI (простий)
Серверний рендеринг EJS + Bootstrap: вхід, список/пошук пацієнтів, картка пацієнта (історія), запис на прийом (вибір вільного слоту),
екран прийому для лікаря, черга лабораторії, стаціонар (карта ліжок), рахунки та оплати, журнал аудиту для адміна.
