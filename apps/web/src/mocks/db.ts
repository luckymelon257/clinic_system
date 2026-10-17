import type {
  Admission,
  Appointment,
  AppointmentStatus,
  AuditEntry,
  Bed,
  CurrentUser,
  DeletedRecord,
  Department,
  Doctor,
  Icd10Code,
  InsuranceCompany,
  InvoiceDetail,
  InvoiceItem,
  LabPriority,
  LabOrderStatus,
  LabResult,
  LabTestType,
  MedicalRecord,
  Medication,
  Patient,
  PatientInsurance,
  Prescription,
  RevenueRow,
  ScheduleEntry,
  Specialization,
  User,
} from '@clinic/contracts';

// In-memory demo data for MSW (browser with VITE_USE_MOCKS=1, and node in tests). Ukrainian, contract-shaped.

export type UserRow = User & { password: string; doctorId: number | null; patientId: number | null };
export type PatientRow = Omit<Patient, 'fullName' | 'age' | 'insuranceCompanyName' | 'insurancePolicyNumber' | 'insuranceCoveragePercent'> & {
  deletedAt: string | null;
};
export type LabOrderRow = {
  id: number;
  patientId: number;
  doctorId: number;
  medicalRecordId: number | null;
  priority: LabPriority;
  status: LabOrderStatus;
  orderedAt: string;
  testTypeIds: number[];
};

export const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE'); // 'YYYY-MM-DD' in local time
export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
};
export const at = (date: string, hm: string) => new Date(`${date}T${hm}:00`).toISOString();

const stamp = (createdAt: string) => ({ createdAt, updatedAt: null, updatedBy: null, updatedByEmail: null });

function seed() {
  const today = localDate();
  const now = new Date().toISOString();
  const d = (n: number) => addDays(today, n);

  const departments: Department[] = [
    { id: 1, name: 'Терапевтичне відділення', headDoctorId: 1, headDoctorName: 'Іваненко Олег Петрович' },
    { id: 2, name: 'Кардіологічне відділення', headDoctorId: 2, headDoctorName: 'Коваленко Наталія Сергіївна' },
    { id: 3, name: 'Хірургічне відділення', headDoctorId: 3, headDoctorName: 'Бондаренко Андрій Вікторович' },
    { id: 4, name: 'Педіатричне відділення', headDoctorId: 4, headDoctorName: 'Мельник Ірина Олександрівна' },
  ];
  const specializations: Specialization[] = [
    { id: 1, name: 'Терапевт' },
    { id: 2, name: 'Кардіолог' },
    { id: 3, name: 'Хірург' },
    { id: 4, name: 'Педіатр' },
  ];
  const insuranceCompanies: InsuranceCompany[] = [
    { id: 1, name: 'ТАС Страхування', phone: '+380 44 536 00 20' },
    { id: 2, name: 'Уніка', phone: '+380 44 225 60 00' },
    { id: 3, name: 'АРКС', phone: '+380 44 492 22 22' },
  ];
  const icd10: Icd10Code[] = [
    { code: 'A09', title: 'Діарея та гастроентерит інфекційного походження' },
    { code: 'E11.9', title: 'Цукровий діабет 2 типу без ускладнень' },
    { code: 'I10', title: 'Есенціальна (первинна) гіпертензія' },
    { code: 'I20.9', title: 'Стенокардія, неуточнена' },
    { code: 'I25.1', title: 'Атеросклеротична хвороба серця' },
    { code: 'J06.9', title: 'Гостра інфекція верхніх дихальних шляхів, неуточнена' },
    { code: 'J18.9', title: 'Пневмонія, неуточнена' },
    { code: 'J45.9', title: 'Астма, неуточнена' },
    { code: 'K29.7', title: 'Гастрит, неуточнений' },
    { code: 'K35.8', title: 'Гострий апендицит, інший та неуточнений' },
    { code: 'M54.5', title: 'Біль у нижній частині спини' },
    { code: 'N39.0', title: 'Інфекція сечовивідних шляхів без уточненої локалізації' },
    { code: 'R50.9', title: 'Гарячка, неуточнена' },
    { code: 'Z00.0', title: 'Загальний медичний огляд' },
  ];
  const medications: Medication[] = [
    { id: 1, name: 'Парацетамол', form: 'tablet', strength: '500 мг', unitPrice: 12.5 },
    { id: 2, name: 'Ібупрофен', form: 'tablet', strength: '400 мг', unitPrice: 35 },
    { id: 3, name: 'Амоксицилін', form: 'capsule', strength: '500 мг', unitPrice: 120 },
    { id: 4, name: 'Лізиноприл', form: 'tablet', strength: '10 мг', unitPrice: 85 },
    { id: 5, name: 'Метформін', form: 'tablet', strength: '850 мг', unitPrice: 95 },
    { id: 6, name: 'Омепразол', form: 'capsule', strength: '20 мг', unitPrice: 60 },
    { id: 7, name: 'Сальбутамол', form: 'inhaler', strength: '100 мкг/доза', unitPrice: 180 },
    { id: 8, name: 'Цефтріаксон', form: 'injection', strength: '1 г', unitPrice: 45 },
  ];
  const labTestTypes: LabTestType[] = [
    { id: 1, code: 'HGB', name: 'Гемоглобін', unit: 'г/л', refMin: 120, refMax: 160, price: 150 },
    { id: 2, code: 'WBC', name: 'Лейкоцити', unit: '10^9/л', refMin: 4, refMax: 9, price: 120 },
    { id: 3, code: 'GLU', name: 'Глюкоза крові', unit: 'ммоль/л', refMin: 3.3, refMax: 5.5, price: 90 },
    { id: 4, code: 'CRP', name: 'С-реактивний білок', unit: 'мг/л', refMin: 0, refMax: 5, price: 210 },
    { id: 5, code: 'CHOL', name: 'Холестерин загальний', unit: 'ммоль/л', refMin: 0, refMax: 5.2, price: 140 },
    { id: 6, code: 'UA', name: 'Загальний аналіз сечі', unit: null, refMin: null, refMax: null, price: 110 },
  ];

  const u = (id: number, email: string, role: User['role'], fullName: string, password: string, extra: Partial<UserRow> = {}): UserRow => ({
    id,
    email,
    role,
    fullName,
    password,
    isActive: true,
    lastLoginAt: null,
    doctorId: null,
    patientId: null,
    ...stamp(at(d(-90), '08:00')),
    ...extra,
  });
  const users: UserRow[] = [
    u(1, 'admin@clinic.local', 'admin', 'Адміністратор Системи', 'admin123'),
    u(2, 'registrar@clinic.local', 'registrar', 'Петренко Оксана Іванівна', 'registrar123'),
    u(3, 'doctor@clinic.local', 'doctor', 'Іваненко Олег Петрович', 'doctor123', { doctorId: 1 }),
    u(4, 'lab@clinic.local', 'lab_technician', 'Сидоренко Марія Василівна', 'lab_technician123'),
    u(5, 'cashier@clinic.local', 'cashier', 'Кравець Тетяна Миколаївна', 'cashier123'),
    u(6, 'patient@clinic.local', 'patient', 'Шевченко Тарас Григорович', 'patient123', { patientId: 1 }),
    u(7, 'kovalenko@clinic.local', 'doctor', 'Коваленко Наталія Сергіївна', 'doctor123', { doctorId: 2 }),
    u(8, 'bondarenko@clinic.local', 'doctor', 'Бондаренко Андрій Вікторович', 'doctor123', { doctorId: 3 }),
    u(9, 'melnyk@clinic.local', 'doctor', 'Мельник Ірина Олександрівна', 'doctor123', { doctorId: 4 }),
  ];

  const doc = (id: number, userId: number, dep: number, fee: number, phone: string): Doctor => ({
    id,
    userId,
    fullName: users.find((x) => x.id === userId)!.fullName,
    email: users.find((x) => x.id === userId)!.email,
    phone,
    departmentId: dep,
    departmentName: departments[dep - 1]!.name,
    specializationId: dep,
    specializationName: specializations[dep - 1]!.name,
    licenseNumber: `ЛК-${100200 + id}`,
    consultationFee: fee,
  });
  const doctors: Doctor[] = [
    doc(1, 3, 1, 500, '+380 67 111 22 01'),
    doc(2, 7, 2, 700, '+380 67 111 22 02'),
    doc(3, 8, 3, 800, '+380 67 111 22 03'),
    doc(4, 9, 4, 450, '+380 67 111 22 04'),
  ];
  const weekdays = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота', 'Неділя'];
  const schedules: ScheduleEntry[] = [];
  for (const dr of doctors)
    for (let wd = 1; wd <= 6; wd++)
      schedules.push({
        id: schedules.length + 1,
        doctorId: dr.id,
        weekday: wd,
        weekdayName: weekdays[wd - 1]!,
        startTime: wd === 6 ? '09:00' : '08:00',
        endTime: wd === 6 ? '12:00' : '14:00',
        slotMinutes: 30,
        room: `${dr.departmentId}0${dr.id}`,
      });

  const p = (
    id: number,
    lastName: string,
    firstName: string,
    middleName: string,
    birthDate: string,
    sex: Patient['sex'],
    phone: string,
    bloodType: Patient['bloodType'],
    address: string,
  ): PatientRow => ({
    id,
    lastName,
    firstName,
    middleName,
    birthDate,
    sex,
    phone,
    email: null,
    address,
    bloodType,
    emergencyContactName: null,
    emergencyContactPhone: null,
    deletedAt: null,
    ...stamp(at(d(-60 + id), '10:00')),
  });
  const patients: PatientRow[] = [
    p(1, 'Шевченко', 'Тарас', 'Григорович', '1985-03-09', 'male', '+380 50 123 45 67', 'A+', 'м. Київ, вул. Хрещатик, 10, кв. 5'),
    p(2, 'Ковальчук', 'Олена', 'Миколаївна', '1992-07-21', 'female', '+380 67 234 56 78', 'O+', 'м. Київ, просп. Перемоги, 45'),
    p(3, 'Бойко', 'Андрій', 'Степанович', '1978-11-02', 'male', '+380 93 345 67 89', 'B-', 'м. Бровари, вул. Київська, 12'),
    p(4, 'Ткаченко', 'Ірина', 'Василівна', '2001-01-15', 'female', '+380 66 456 78 90', 'AB+', 'м. Київ, вул. Січових Стрільців, 3'),
    p(5, 'Кравченко', 'Богдан', 'Олексійович', '1965-05-30', 'male', '+380 97 567 89 01', 'A-', 'м. Ірпінь, вул. Соборна, 101'),
    p(6, 'Олійник', 'Софія', 'Андріївна', '2015-09-04', 'female', '+380 63 678 90 12', 'O-', 'м. Київ, вул. Антоновича, 77'),
    p(7, 'Лисенко', 'Микола', 'Іванович', '1950-12-12', 'male', '+380 50 789 01 23', 'B+', 'м. Вишгород, вул. Шолуденка, 8'),
    p(8, 'Гнатюк', 'Василь', 'Петрович', '1988-02-28', 'male', '+380 68 890 12 34', null, 'м. Київ, вул. Велика Васильківська, 20'),
  ];
  patients[1]!.updatedAt = at(d(-3), '15:42');
  patients[1]!.updatedBy = 2;
  patients[1]!.updatedByEmail = 'registrar@clinic.local';
  patients[7]!.deletedAt = at(d(-2), '11:20');

  const insurances: PatientInsurance[] = [
    { id: 1, patientId: 1, companyId: 1, companyName: 'ТАС Страхування', policyNumber: 'TAS-2026-001245', coveragePercent: 70, validFrom: d(-200), validTo: d(165), isActive: true },
    { id: 2, patientId: 2, companyId: 2, companyName: 'Уніка', policyNumber: 'UN-77-445120', coveragePercent: 50, validFrom: d(-400), validTo: d(-35), isActive: false },
    { id: 3, patientId: 5, companyId: 3, companyName: 'АРКС', policyNumber: 'ARX-0099812', coveragePercent: 80, validFrom: d(-30), validTo: null, isActive: true },
  ];

  let apptId = 0;
  const appt = (patientId: number, doctorId: number, date: string, hm: string, status: AppointmentStatus, reason: string | null): Appointment => {
    const dr = doctors[doctorId - 1]!;
    const pt = patients[patientId - 1]!;
    const startsAt = at(date, hm);
    return {
      id: ++apptId,
      patientId,
      patientName: `${pt.lastName} ${pt.firstName} ${pt.middleName ?? ''}`.trim(),
      doctorId,
      doctorName: dr.fullName,
      departmentName: dr.departmentName,
      specializationName: dr.specializationName,
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + 30 * 60000).toISOString(),
      status,
      reason,
      cancelReason: null,
      room: `${dr.departmentId}0${dr.id}`,
      medicalRecordId: null,
      ...stamp(at(d(-7), '09:00')),
    };
  };
  const appointments: Appointment[] = [
    appt(1, 1, d(-30), '09:00', 'completed', 'Кашель, температура'),
    appt(2, 2, d(-14), '10:00', 'completed', 'Підвищений тиск'),
    appt(1, 1, today, '09:00', 'confirmed', 'Повторний огляд'),
    appt(2, 1, today, '09:30', 'scheduled', 'Головний біль'),
    appt(3, 1, today, '10:00', 'scheduled', 'Біль у спині'),
    appt(4, 1, today, '10:30', 'scheduled', 'Профогляд'),
    appt(5, 2, today, '11:00', 'confirmed', 'Біль у грудях'),
    appt(7, 2, today, '11:30', 'scheduled', 'Контроль тиску'),
    appt(6, 4, d(1), '09:00', 'scheduled', 'Щеплення, огляд'),
  ];
  appointments[0]!.medicalRecordId = 1;
  appointments[1]!.medicalRecordId = 2;

  const records: MedicalRecord[] = [
    {
      id: 1,
      patientId: 1,
      patientName: appointments[0]!.patientName,
      doctorId: 1,
      doctorName: doctors[0]!.fullName,
      appointmentId: 1,
      admissionId: null,
      complaints: 'Кашель, температура 38.2 °C протягом 3 днів',
      examination: 'Гіперемія зіву, дихання везикулярне',
      conclusion: 'ГРВІ, легкий перебіг',
      recommendations: 'Пиття, постільний режим 5 днів',
      diagnosesSummary: 'J06.9 Гостра інфекція верхніх дихальних шляхів, неуточнена',
      diagnoses: [{ id: 1, medicalRecordId: 1, icd10Code: 'J06.9', icd10Title: icd10[5]!.title, kind: 'primary', notes: null }],
      createdAt: at(d(-30), '09:25'),
    },
    {
      id: 2,
      patientId: 2,
      patientName: appointments[1]!.patientName,
      doctorId: 2,
      doctorName: doctors[1]!.fullName,
      appointmentId: 2,
      admissionId: null,
      complaints: 'Головний біль, тиск до 160/100',
      examination: 'АТ 155/95, ЧСС 82',
      conclusion: 'Артеріальна гіпертензія I ст.',
      recommendations: 'Контроль АТ щодня, обмеження солі',
      diagnosesSummary: 'I10 Есенціальна (первинна) гіпертензія',
      diagnoses: [{ id: 2, medicalRecordId: 2, icd10Code: 'I10', icd10Title: icd10[2]!.title, kind: 'primary', notes: null }],
      createdAt: at(d(-14), '10:20'),
    },
  ];
  const prescriptions: Prescription[] = [
    {
      id: 1,
      medicalRecordId: 2,
      patientId: 2,
      patientName: appointments[1]!.patientName,
      doctorName: doctors[1]!.fullName,
      issuedAt: at(d(-14), '10:21'),
      validUntil: d(16),
      items: [{ medicationId: 4, medicationName: 'Лізиноприл 10 мг', dosage: '1 таблетка', frequency: '1 раз на день', durationDays: 30, quantity: 30, instructions: 'Зранку' }],
    },
  ];

  const labOrders: LabOrderRow[] = [
    { id: 1, patientId: 1, doctorId: 1, medicalRecordId: 1, priority: 'routine', status: 'completed', orderedAt: at(d(-30), '09:26'), testTypeIds: [1, 2] },
    { id: 2, patientId: 2, doctorId: 2, medicalRecordId: 2, priority: 'routine', status: 'in_progress', orderedAt: at(d(-1), '10:21'), testTypeIds: [3, 5] },
    { id: 3, patientId: 5, doctorId: 2, medicalRecordId: null, priority: 'urgent', status: 'ordered', orderedAt: at(today, '08:15'), testTypeIds: [4, 2] },
    { id: 4, patientId: 3, doctorId: 1, medicalRecordId: null, priority: 'routine', status: 'ordered', orderedAt: at(today, '08:40'), testTypeIds: [6] },
  ];
  const lr = (id: number, orderId: number, patientId: number, t: LabTestType, value: number, recordedAt: string): LabResult => ({
    id,
    orderId,
    patientId,
    patientName: appointments.find((a) => a.patientId === patientId)!.patientName,
    testTypeId: t.id,
    testCode: t.code,
    testName: t.name,
    valueNumeric: value,
    valueText: null,
    unit: t.unit,
    refMin: t.refMin,
    refMax: t.refMax,
    isAbnormal: (t.refMin !== null && value < t.refMin) || (t.refMax !== null && value > t.refMax),
    recordedAt,
    recordedByEmail: 'lab@clinic.local',
  });
  const labResults: LabResult[] = [
    lr(1, 1, 1, labTestTypes[0]!, 138, at(d(-29), '12:00')),
    lr(2, 1, 1, labTestTypes[1]!, 11.4, at(d(-29), '12:05')),
    lr(3, 2, 2, labTestTypes[2]!, 6.1, at(d(-1), '14:30')),
  ];

  const beds: Bed[] = [];
  const ward = (wardId: number, wardNumber: string, wardType: Bed['wardType'], dailyRate: number, depId: number, count: number) => {
    for (let i = 1; i <= count; i++)
      beds.push({
        id: beds.length + 1,
        bedNumber: `${wardNumber}-${i}`,
        status: 'available',
        wardId,
        wardNumber,
        wardType,
        dailyRate,
        departmentId: depId,
        departmentName: departments[depId - 1]!.name,
        admissionId: null,
        patientId: null,
        patientName: null,
      });
  };
  ward(1, '101', 'general', 600, 1, 4);
  ward(2, '102', 'private', 1500, 1, 1);
  ward(3, '201', 'semi_private', 900, 2, 2);
  ward(4, '202', 'icu', 2500, 2, 2);
  ward(5, '301', 'general', 650, 3, 3);
  beds[3]!.status = 'maintenance';

  const admissions: Admission[] = [];
  const admitSeed = (patientId: number, bedId: number, doctorId: number, daysAgo: number, reason: string) => {
    const bed = beds[bedId - 1]!;
    const a: Admission = {
      id: admissions.length + 1,
      patientId,
      patientName: appointments.find((x) => x.patientId === patientId)?.patientName ?? `${patients[patientId - 1]!.lastName} ${patients[patientId - 1]!.firstName}`,
      bedId,
      bedNumber: bed.bedNumber,
      wardNumber: bed.wardNumber,
      departmentName: bed.departmentName,
      doctorId,
      doctorName: doctors[doctorId - 1]!.fullName,
      admittedAt: at(d(-daysAgo), '13:00'),
      dischargedAt: null,
      reason,
      dischargeSummary: null,
      status: 'active',
      days: daysAgo,
    };
    admissions.push(a);
    Object.assign(bed, { status: 'occupied', admissionId: a.id, patientId, patientName: a.patientName });
  };
  admitSeed(7, 1, 1, 3, 'Пневмонія, середній ступінь тяжкості');
  admitSeed(5, 8, 2, 2, 'Нестабільна стенокардія');
  admitSeed(3, 10, 3, 1, 'Підозра на гострий апендицит');

  const invoices: InvoiceDetail[] = [];
  const auditLog: AuditEntry[] = [
    {
      id: 1,
      tableName: 'patients',
      recordId: 2,
      operation: 'UPDATE',
      changedFields: ['phone', 'address'],
      oldData: { id: 2, last_name: 'Ковальчук', first_name: 'Олена', phone: '+380 67 000 00 00', address: 'м. Київ, вул. Лесі Українки, 1' },
      newData: { id: 2, last_name: 'Ковальчук', first_name: 'Олена', phone: '+380 67 234 56 78', address: 'м. Київ, просп. Перемоги, 45' },
      changedAt: at(d(-3), '15:42'),
      changedBy: 2,
      changedByEmail: 'registrar@clinic.local',
    },
    {
      id: 2,
      tableName: 'appointments',
      recordId: 4,
      operation: 'INSERT',
      changedFields: null,
      oldData: null,
      newData: { id: 4, patient_id: 2, doctor_id: 1, status: 'scheduled', reason: 'Головний біль' },
      changedAt: at(d(-7), '09:00'),
      changedBy: 2,
      changedByEmail: 'registrar@clinic.local',
    },
    {
      id: 3,
      tableName: 'patients',
      recordId: 8,
      operation: 'SOFT_DELETE',
      changedFields: ['deleted_at', 'deleted_by'],
      oldData: { id: 8, last_name: 'Гнатюк', deleted_at: null, deleted_by: null },
      newData: { id: 8, last_name: 'Гнатюк', deleted_at: at(d(-2), '11:20'), deleted_by: 1 },
      changedAt: at(d(-2), '11:20'),
      changedBy: 1,
      changedByEmail: 'admin@clinic.local',
    },
  ];
  const deleted: DeletedRecord[] = [
    { tableName: 'patients', recordId: 8, label: 'Гнатюк Василь Петрович', deletedAt: at(d(-2), '11:20'), deletedBy: 1, deletedByEmail: 'admin@clinic.local' },
    { tableName: 'medications', recordId: 9, label: 'Анальгін 500 мг', deletedAt: at(d(-10), '16:05'), deletedBy: 1, deletedByEmail: 'admin@clinic.local' },
  ];

  // historical revenue ("materialized view" snapshot), payments made in the mock are added on refresh
  const revenueHistory: RevenueRow[] = [];
  const methods = ['cash', 'card', 'insurance'] as const;
  for (let m = 5; m >= 1; m--) {
    const first = new Date();
    first.setDate(1);
    first.setMonth(first.getMonth() - m);
    departments.forEach((dep, i) =>
      methods.forEach((method, j) =>
        revenueHistory.push({
          month: localDate(first),
          departmentName: dep.name,
          method,
          paymentsCount: 5 + ((m * 7 + i * 3 + j) % 11),
          total: 8000 + ((m * 3517 + i * 2291 + j * 1733) % 9000),
        }),
      ),
    );
  }

  const db = {
    users,
    departments,
    specializations,
    insuranceCompanies,
    icd10,
    medications,
    labTestTypes,
    patients,
    insurances,
    doctors,
    schedules,
    appointments,
    records,
    prescriptions,
    labOrders,
    labResults,
    beds,
    admissions,
    invoices,
    auditLog,
    deleted,
    revenueHistory,
    revenue: [] as RevenueRow[],
    seq: 1000,
    now,
  };

  // a few invoices: consultation (paid), stay (partially paid, overdue), lab (issued)
  const inv1 = makeInvoice(db, 1, [{ itemType: 'consultation', description: 'Консультація терапевта', quantity: 1, unitPrice: 500 }], { appointmentId: 1 });
  inv1.payments.push({ id: 1, invoiceId: inv1.id, amount: inv1.totalDue, method: 'card', reference: 'POS-88123', paidAt: at(d(-30), '09:40'), receivedByEmail: 'cashier@clinic.local' });
  const inv2 = makeInvoice(db, 2, [{ itemType: 'consultation', description: 'Консультація кардіолога', quantity: 1, unitPrice: 700 }, { itemType: 'lab_test', description: 'Глюкоза крові', quantity: 1, unitPrice: 90 }], { appointmentId: 2 });
  inv2.issuedAt = at(d(-30), '10:30');
  inv2.dueDate = d(-16);
  inv2.payments.push({ id: 2, invoiceId: inv2.id, amount: 300, method: 'cash', reference: null, paidAt: at(d(-14), '10:40'), receivedByEmail: 'cashier@clinic.local' });
  makeInvoice(db, 5, [{ itemType: 'stay', description: 'Перебування у стаціонарі (палата 201)', quantity: 2, unitPrice: 900 }, { itemType: 'lab_test', description: 'С-реактивний білок', quantity: 1, unitPrice: 210 }], {});
  db.invoices.forEach(recalcInvoice);
  db.revenue = computeRevenue(db);
  return db;
}

export type Db = ReturnType<typeof seed>;

export function nextId(db: Db) {
  return ++db.seq;
}

export function activeInsurance(db: Db, patientId: number) {
  return db.insurances.filter((i) => i.patientId === patientId && i.isActive).sort((a, b) => b.coveragePercent - a.coveragePercent)[0] ?? null;
}

export function makeInvoice(
  db: Db,
  patientId: number,
  items: Omit<InvoiceItem, 'id' | 'invoiceId' | 'amount'>[],
  refs: { appointmentId?: number; admissionId?: number },
): InvoiceDetail {
  const id = db.invoices.length + 1;
  const p = db.patients.find((x) => x.id === patientId)!;
  const ins = activeInsurance(db, patientId);
  const inv: InvoiceDetail = {
    id,
    number: `INV-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`,
    patientId,
    patientName: `${p.lastName} ${p.firstName} ${p.middleName ?? ''}`.trim(),
    appointmentId: refs.appointmentId ?? null,
    admissionId: refs.admissionId ?? null,
    status: 'issued',
    subtotal: 0,
    insuranceCoveragePercent: ins?.coveragePercent ?? 0,
    insuranceAmount: 0,
    totalDue: 0,
    paidAmount: 0,
    balance: 0,
    issuedAt: new Date().toISOString(),
    dueDate: addDays(localDate(), 14),
    isOverdue: false,
    createdAt: new Date().toISOString(),
    items: items.map((it, i) => ({ ...it, id: id * 100 + i, invoiceId: id, amount: round(it.quantity * it.unitPrice) })),
    payments: [],
  };
  db.invoices.push(inv);
  recalcInvoice(inv);
  return inv;
}

export const round = (n: number) => Math.round(n * 100) / 100;

/** What the DB triggers do: totals, coverage, status, overdue. */
export function recalcInvoice(inv: InvoiceDetail) {
  inv.subtotal = round(inv.items.reduce((s, i) => s + i.amount, 0));
  inv.insuranceAmount = round((inv.subtotal * inv.insuranceCoveragePercent) / 100);
  inv.totalDue = round(inv.subtotal - inv.insuranceAmount);
  inv.paidAmount = round(inv.payments.reduce((s, p) => s + p.amount, 0));
  inv.balance = round(inv.totalDue - inv.paidAmount);
  if (inv.status !== 'draft' && inv.status !== 'cancelled')
    inv.status = inv.balance <= 0 && inv.totalDue > 0 ? 'paid' : inv.paidAmount > 0 ? 'partially_paid' : 'issued';
  inv.isOverdue = !!inv.dueDate && inv.dueDate < localDate() && inv.balance > 0;
}

export function computeRevenue(db: Db): RevenueRow[] {
  const rows = db.revenueHistory.map((r) => ({ ...r }));
  for (const inv of db.invoices)
    for (const pay of inv.payments) {
      const month = `${localDate(new Date(pay.paidAt)).slice(0, 7)}-01`;
      const appt = db.appointments.find((a) => a.id === inv.appointmentId);
      const departmentName = appt?.departmentName ?? db.departments[0]!.name;
      const row = rows.find((r) => r.month === month && r.departmentName === departmentName && r.method === pay.method);
      if (row) {
        row.paymentsCount++;
        row.total = round(row.total + pay.amount);
      } else rows.push({ month, departmentName, method: pay.method, paymentsCount: 1, total: pay.amount });
    }
  return rows.sort((a, b) => a.month.localeCompare(b.month));
}

export function publicUser(u: UserRow): CurrentUser {
  return { id: u.id, email: u.email, role: u.role, fullName: u.fullName, doctorId: u.doctorId, patientId: u.patientId };
}

export let db: Db = seed();
export const resetDb = () => {
  db = seed();
};
