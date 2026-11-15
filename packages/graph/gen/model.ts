import type { Row } from './copy';
import { chance, exponential, int, lognormal, pick, stream, zipf, type Rng } from './prng';
import { DAY, DAYS, END_MIN, HOUR, daytime, isoDow, ts } from './time';

// Bench dataset (docs/07 §2): one hospital of 400 beds for one year, ×N = a network of N such hospitals.
// Every number below comes from the scenario fixed in the task; the derivations are in gen/README.md.

export const H = {
  departments: 8, // index 7 = ICU
  generalWards: 16,
  roomsPerWard: 6,
  bedsPerRoom: 4,
  icuWards: 2,
  icuRooms: 8, // single rooms
  doctors: 60,
  icuDoctors: 6,
  nurses: 300,
  patients: 64_000,
} as const;
const WARDS_PER_DEPT = [3, 3, 2, 2, 2, 2, 2]; // 16 general wards over departments 0..6
const ICU_DEPT = 7;

export const P = {
  losMedianDays: 3.5,
  losMeanDays: 5,
  losMaxDays: 60,
  bedGapMeanDays: 1.1, // turnover gap; with daytime snapping → occupancy ≈ 80 %, ≈ 64 admissions / day
  readmitShare: 0.15,
  slotMinutes: 20, // clinic 16:00–20:00 → 12 slots
  slotFill: 0.8,
  completed: 0.85,
  cancelled: 0.08, // rest no-show
  rxShareVisit: 0.6,
  networkFloatShare: 0.03, // ×5 / ×10 only: nurses working in any hospital of the network
  deptFloatShare: 0.1, // nurses rotating between wards of their department
  crossSiteSessionShare: 0.05, // ×5 / ×10 only: clinic sessions seeing patients of another hospital
  meds: 600,
  classes: 80,
  medInteractions: 350,
  classInteractions: 200,
  sameClassInteractions: 30,
} as const;

export interface Table {
  name: string;
  columns: string[];
  rows(): Iterable<Row>;
}

export interface Dataset {
  scale: number;
  seed: number;
  tables: Table[];
  facts: Record<string, number>;
}

const severity = (r: Rng) => (r() < 0.3 ? 'minor' : r() < 0.714 ? 'moderate' : 'major'); // ≈ 30 / 50 / 20 %
const FORMS = ['tablet', 'capsule', 'syrup', 'injection', 'ointment', 'drops', 'inhaler'];
const LAST = ['Петренко', 'Коваленко', 'Бондаренко', 'Ткаченко', 'Кравченко', 'Олійник', 'Шевчук', 'Мельник', 'Бойко', 'Мороз',
  'Лисенко', 'Марченко', 'Руденко', 'Савченко', 'Карпенко', 'Гончаренко', 'Павленко', 'Левченко', 'Клименко', 'Романюк'];
const FIRST_M = ['Олександр', 'Андрій', 'Сергій', 'Дмитро', 'Іван', 'Микола', 'Петро', 'Юрій', 'Максим', 'Богдан'];
const FIRST_F = ['Олена', 'Наталія', 'Ірина', 'Оксана', 'Тетяна', 'Марія', 'Юлія', 'Ганна', 'Катерина', 'Софія'];
const SPECIALIZATIONS = ['Терапевт', 'Кардіолог', 'Невролог', 'Хірург', 'Педіатр', 'Анестезіолог', 'Ендокринолог',
  'Гастроентеролог', 'Пульмонолог', 'Травматолог'];

const created = ts(-400 * DAY); // reference data exists long before the year starts

export function generate(scale: number, seed = 2026 + scale): Dataset {
  const N = scale;
  const facts: Record<string, number> = {};

  // ---------- structure ----------
  interface Ward { id: number; h: number; dept: number; icu: boolean; rooms: number[] }
  interface Bed { id: number; ward: number; room: number }
  interface Doctor { id: number; h: number; dept: number; homeWard: number }
  const wards: Ward[] = [];
  const rooms: { id: number; ward: number; number: string }[] = [];
  const beds: Bed[] = [];
  const doctors: Doctor[] = [];
  const wardsOf = (h: number, dept: number) => wards.filter((w) => w.h === h && w.dept === dept);

  for (let h = 0; h < N; h++) {
    const deptOfGeneral = WARDS_PER_DEPT.flatMap((n, d) => Array<number>(n).fill(d));
    for (let w = 0; w < H.generalWards + H.icuWards; w++) {
      const icu = w >= H.generalWards;
      const ward: Ward = { id: wards.length + 1, h, dept: icu ? ICU_DEPT : deptOfGeneral[w]!, icu, rooms: [] };
      wards.push(ward);
      const nRooms = icu ? H.icuRooms : H.roomsPerWard;
      const perRoom = icu ? 1 : H.bedsPerRoom;
      for (let r = 0; r < nRooms; r++) {
        const room = { id: rooms.length + 1, ward: ward.id, number: `${r + 1}` };
        rooms.push(room);
        ward.rooms.push(room.id);
        for (let b = 0; b < perRoom; b++) beds.push({ id: beds.length + 1, ward: ward.id, room: room.id });
      }
    }
    const hw = wards.filter((w) => w.h === h);
    for (let i = 0; i < H.doctors; i++) {
      const generalDocs = H.doctors - H.icuDoctors;
      const home = i < generalDocs ? hw[i % H.generalWards]! : hw[H.generalWards + ((i - generalDocs) % H.icuWards)]!;
      doctors.push({ id: doctors.length + 1, h, dept: home.dept, homeWard: home.id });
    }
  }
  const wardById = (id: number) => wards[id - 1]!;
  const homeDoctors = new Map<number, number[]>();
  for (const d of doctors) homeDoctors.set(d.homeWard, [...(homeDoctors.get(d.homeWard) ?? []), d.id]);

  // ---------- nurses ----------
  interface Nurse { id: number; h: number; dept: number; kind: 'fixed' | 'dept' | 'network'; ward: number; offset: number }
  const nurses: Nurse[] = [];
  {
    const r = stream(seed, 'nurses');
    for (let h = 0; h < N; h++) {
      const nNet = N > 1 ? Math.round(H.nurses * P.networkFloatShare) : 0;
      const nDept = Math.round(H.nurses * P.deptFloatShare);
      const hw = wards.filter((w) => w.h === h);
      const icu = hw.filter((w) => w.icu);
      const general = hw.filter((w) => !w.icu);
      const fixedSlots: number[] = [];
      // ICU 1 nurse : 2 beds per shift → 22 per ICU ward; the rest round-robin over the general wards
      const nFixed = H.nurses - nNet - nDept;
      for (const w of icu) for (let k = 0; k < 22; k++) fixedSlots.push(w.id);
      for (let k = 0; fixedSlots.length < nFixed; k++) fixedSlots.push(general[k % general.length]!.id);
      for (let k = 0; k < H.nurses; k++) {
        const id = H.doctors * N + nurses.length + 1;
        const kind = k < nNet ? 'network' : k < nNet + nDept ? 'dept' : 'fixed';
        const ward = kind === 'fixed' ? fixedSlots[k - nNet - nDept]! : 0;
        const dept = kind === 'fixed' ? wardById(ward).dept : k % H.departments;
        nurses.push({ id, h, dept, kind, ward, offset: int(r, 0, 7) });
      }
    }
  }

  // ---------- admissions: per-bed timelines, then patients in chronological order ----------
  interface Adm { id: number; patient: number; bed: number; ward: number; doctor: number; a: number; d: number /* -1 = open */ }
  const adms: Adm[] = [];
  {
    const r = stream(seed, 'admissions');
    for (let h = 0; h < N; h++) {
      const stays: Omit<Adm, 'id' | 'patient' | 'doctor'>[] = [];
      for (const b of beds.filter((x) => wardById(x.ward).h === h)) {
        let t = Math.round(exponential(r, P.bedGapMeanDays * DAY));
        for (;;) {
          const a = daytime(t);
          if (a >= END_MIN) break;
          const los = Math.min(P.losMaxDays, Math.max(0.25, lognormal(r, P.losMedianDays, P.losMeanDays)));
          const d = daytime(a + Math.round(los * DAY));
          if (d >= END_MIN) {
            stays.push({ bed: b.id, ward: b.ward, a, d: -1 });
            break;
          }
          stays.push({ bed: b.id, ward: b.ward, a, d });
          t = d + Math.round(exponential(r, P.bedGapMeanDays * DAY));
        }
      }
      stays.sort((x, y) => x.a - y.a || x.bed - y.bed);
      // patients: 15 % readmissions of patients discharged earlier in this hospital, the rest first stays
      const firstPatient = h * H.patients + 1;
      let nextNew = firstPatient;
      const pending: { patient: number; d: number }[] = []; // in house, sorted by discharge when drained
      let eligible: number[] = [];
      for (const s of stays) {
        pending.sort((x, y) => x.d - y.d);
        while (pending.length && pending[0]!.d <= s.a) eligible.push(pending.shift()!.patient);
        if (eligible.length > 5000) eligible = eligible.slice(-5000); // readmissions favour recent discharges
        let patient: number;
        if (eligible.length && chance(r, P.readmitShare)) {
          const i = eligible.length - 1 - Math.floor(r() * Math.min(eligible.length, 2000));
          patient = eligible[i]!;
          eligible.splice(i, 1);
        } else {
          patient = nextNew++;
        }
        const doctor = pick(r, homeDoctors.get(s.ward)!);
        adms.push({ id: adms.length + 1, patient, doctor, ...s });
        if (s.d >= 0) pending.push({ patient, d: s.d });
      }
      if (nextNew - firstPatient > H.patients) throw new Error(`hospital ${h}: ${nextNew - firstPatient} inpatients > patient pool`);
    }
  }
  const openBeds = new Set(adms.filter((a) => a.d < 0).map((a) => a.bed));
  facts.admissionsPerDay = adms.length / N / DAYS;
  facts.occupancy = adms.reduce((s, a) => s + ((a.d < 0 ? END_MIN : a.d) - a.a), 0) / (beds.length * END_MIN);

  // ---------- catalog: medications, classes, interactions (network-wide, not ×N) ----------
  const cat = stream(seed, 'catalog');
  const medClasses: [number, number][] = [];
  for (let m = 1; m <= P.meds; m++) {
    const c1 = int(cat, 1, P.classes);
    medClasses.push([m, c1]);
    if (chance(cat, 0.15)) {
      let c2 = int(cat, 1, P.classes);
      while (c2 === c1) c2 = int(cat, 1, P.classes);
      medClasses.push([m, c2]);
    }
  }
  const pairs = (n: number, max: number, same: boolean) => {
    const seen = new Set<string>();
    const out: [number, number, string][] = [];
    while (out.length < n) {
      const a = int(cat, 1, max);
      const b = same ? a : int(cat, 1, max);
      if (!same && a === b) continue;
      const [x, y] = a < b ? [a, b] : [b, a];
      if (seen.has(`${x}:${y}`)) continue;
      seen.add(`${x}:${y}`);
      out.push([x, y, severity(cat)]);
    }
    return out;
  };
  const medInter = pairs(P.medInteractions, P.meds, false);
  const classInter = [...pairs(P.classInteractions - P.sameClassInteractions, P.classes, false), ...pairs(P.sameClassInteractions, P.classes, true)];

  // ---------- appointments (materialised: medical records and prescriptions refer to them) ----------
  const apptDoctor = new Int32Array(Math.ceil(doctors.length * DAYS * 12 * 0.9));
  let nAppt = 0;
  const appt: { patient: Int32Array; start: Int32Array; status: Uint8Array } = {
    patient: new Int32Array(apptDoctor.length), start: new Int32Array(apptDoctor.length), status: new Uint8Array(apptDoctor.length),
  };
  {
    const r = stream(seed, 'appointments');
    const slots = (4 * HOUR) / P.slotMinutes;
    for (const doc of doctors) {
      for (let d = 0; d < DAYS; d++) {
        if (isoDow(d) > 5) continue;
        const site = N > 1 && chance(r, P.crossSiteSessionShare) ? (doc.h + int(r, 1, N - 1)) % N : doc.h;
        for (let k = 0; k < slots; k++) {
          if (!chance(r, P.slotFill)) continue;
          const u = r();
          apptDoctor[nAppt] = doc.id;
          appt.patient[nAppt] = site * H.patients + int(r, 1, H.patients);
          appt.start[nAppt] = d * DAY + 16 * HOUR + k * P.slotMinutes;
          appt.status[nAppt] = u < P.completed ? 0 : u < P.completed + P.cancelled ? 1 : 2;
          nAppt++;
        }
      }
    }
  }
  const STATUS = ['completed', 'cancelled', 'no_show'];

  // ---------- tables ----------
  const r = (name: string) => stream(seed, name);
  const tables: Table[] = [];
  const t = (name: string, columns: string[], rows: () => Iterable<Row>) => tables.push({ name, columns, rows });

  t('roles', ['id', 'code', 'name'], () => [[1, 'doctor', 'Лікар']]);
  t('users', ['id', 'email', 'password_hash', 'role_id', 'full_name', 'created_at'],
    () => doctors.map((d) => [d.id, `d${d.id}@bench.local`, 'x', 1, `Лікар ${d.id}`, created]));
  t('specializations', ['id', 'name'], () => SPECIALIZATIONS.map((s, i) => [i + 1, s]));
  t('departments', ['id', 'name', 'created_at'], () => {
    const out: Row[] = [];
    for (let h = 0; h < N; h++) {
      for (let d = 0; d < H.departments; d++) {
        out.push([h * H.departments + d + 1, d === ICU_DEPT ? `ВІТ · Лікарня ${h + 1}` : `Відділення ${d + 1} · Лікарня ${h + 1}`, created]);
      }
    }
    return out;
  });
  const deptId = (h: number, d: number) => h * H.departments + d + 1;
  t('doctors', ['id', 'user_id', 'department_id', 'specialization_id', 'license_number', 'created_at'],
    () => doctors.map((d) => [d.id, d.id, deptId(d.h, d.dept), (d.dept % SPECIALIZATIONS.length) + 1, `B-${d.id}`, created]));
  t('doctor_schedules', ['doctor_id', 'weekday', 'start_time', 'end_time', 'slot_minutes', 'room', 'created_at'], function* () {
    for (const d of doctors) for (let wd = 1; wd <= 5; wd++) yield [d.id, wd, '16:00', '20:00', P.slotMinutes, `К-${d.id}`, created];
  });
  t('wards', ['id', 'department_id', 'ward_number', 'ward_type', 'capacity', 'daily_rate', 'floor', 'created_at'],
    () => wards.map((w) => [w.id, deptId(w.h, w.dept), `H${w.h + 1}-${w.icu ? 'ICU' : 'W'}${w.id}`, w.icu ? 'icu' : 'general',
      w.icu ? H.icuRooms : H.roomsPerWard * H.bedsPerRoom, w.icu ? 5000 : 900, 1 + (w.id % 5), created]));
  t('rooms', ['id', 'ward_id', 'room_number', 'created_at'], () => rooms.map((x) => [x.id, x.ward, x.number, created]));
  t('beds', ['id', 'ward_id', 'room_id', 'bed_number', 'status', 'created_at'],
    () => beds.map((b) => [b.id, b.ward, b.room, `${b.room}-${b.id}`, openBeds.has(b.id) ? 'occupied' : 'available', created]));
  t('patients', ['id', 'last_name', 'first_name', 'birth_date', 'sex', 'created_at'], function* () {
    const pr = r('patients');
    for (let id = 1; id <= H.patients * N; id++) {
      const male = chance(pr, 0.48);
      const by = int(pr, 1930, 2024);
      yield [id, pick(pr, LAST), pick(pr, male ? FIRST_M : FIRST_F), `${by}-${String(int(pr, 1, 12)).padStart(2, '0')}-${String(int(pr, 1, 28)).padStart(2, '0')}`,
        male ? 'male' : 'female', ts(-int(pr, 30, 3000) * DAY)];
    }
  });
  t('admissions', ['id', 'patient_id', 'bed_id', 'doctor_id', 'admitted_at', 'discharged_at', 'status', 'created_at'],
    () => adms.map((a) => [a.id, a.patient, a.bed, a.doctor, ts(a.a), a.d < 0 ? null : ts(a.d), a.d < 0 ? 'active' : 'discharged', ts(a.a)]));
  t('staff', ['id', 'full_name', 'role', 'doctor_id', 'department_id', 'is_float', 'created_at'], function* () {
    for (const d of doctors) yield [d.id, `Лікар ${d.id}`, 'doctor', d.id, deptId(d.h, d.dept), false, created];
    for (const n of nurses) yield [n.id, `Медсестра ${n.id}`, 'nurse', null, deptId(n.h, n.dept), n.kind !== 'fixed', created];
  });

  // staff shifts: nurses 2D-2E-2N-2off (D 07–15, E 15–23, N 23–07); doctors 08–16 on weekdays in the home ward;
  // on-call per department and day (weekdays 20:00–08:00, weekends 08:00–20:00 + 20:00–08:00) rotating over its doctors and wards
  t('staff_shifts', ['staff_id', 'ward_id', 'starts_at', 'ends_at', 'created_at'], function* () {
    const sr = r('shifts');
    const START_H = [7, 7, 15, 15, 23, 23, -1, -1];
    for (const n of nurses) {
      for (let d = 0; d < DAYS; d++) {
        const s = START_H[(d + n.offset) % 8]!;
        if (s < 0) continue;
        let ward = n.ward;
        if (n.kind === 'dept') ward = pick(sr, wardsOf(n.h, n.dept)).id;
        if (n.kind === 'network') ward = pick(sr, wardsOf(int(sr, 0, N - 1), n.dept)).id;
        const a = d * DAY + s * HOUR;
        yield [n.id, ward, ts(a), ts(a + 8 * HOUR), ts(a - 30 * DAY)];
      }
    }
    for (const doc of doctors) {
      for (let d = 0; d < DAYS; d++) {
        if (isoDow(d) <= 5) yield [doc.id, doc.homeWard, ts(d * DAY + 8 * HOUR), ts(d * DAY + 16 * HOUR), ts(d * DAY - 30 * DAY)];
      }
    }
    for (let h = 0; h < N; h++) {
      for (let dept = 0; dept < H.departments; dept++) {
        const docs = doctors.filter((x) => x.h === h && x.dept === dept);
        const dw = wardsOf(h, dept);
        for (let d = 0; d < DAYS; d++) {
          const doc = docs[d % docs.length]!;
          const ward = dw[d % dw.length]!;
          // weekends: day part 08–20 + night 20–08 as two shifts (a 24 h shift would be 25 h on the DST fall-back night)
          if (isoDow(d) > 5) yield [doc.id, ward.id, ts(d * DAY + 8 * HOUR), ts(d * DAY + 20 * HOUR), ts(d * DAY - 30 * DAY)];
          yield [doc.id, ward.id, ts(d * DAY + 20 * HOUR), ts((d + 1) * DAY + 8 * HOUR), ts(d * DAY - 30 * DAY)];
        }
      }
    }
  });

  t('appointments', ['id', 'patient_id', 'doctor_id', 'starts_at', 'ends_at', 'status', 'created_at'], function* () {
    for (let i = 0; i < nAppt; i++) {
      const s = appt.start[i]!;
      yield [i + 1, appt.patient[i]!, apptDoctor[i]!, ts(s), ts(s + P.slotMinutes), STATUS[appt.status[i]!]!, ts(s - 7 * DAY)];
    }
  });

  // medical records: one per completed appointment, then one per admission; prescriptions + items
  const recRng = r('records');
  const medPick = zipf(P.meds, 0.9);
  interface Rx { id: number; record: number; issued: number; inpatient: boolean }
  const recs: Row[] = [];
  const rxs: Rx[] = [];
  let recId = 0;
  for (let i = 0; i < nAppt; i++) {
    if (appt.status[i] !== 0) continue;
    recId++;
    const end = appt.start[i]! + P.slotMinutes;
    recs.push([recId, i + 1, null, appt.patient[i]!, apptDoctor[i]!, 'Bench', ts(end)]);
    if (chance(recRng, P.rxShareVisit)) rxs.push({ id: rxs.length + 1, record: recId, issued: end, inpatient: false });
  }
  for (const a of adms) {
    recId++;
    recs.push([recId, null, a.id, a.patient, a.doctor, 'Bench', ts(a.a + 2 * HOUR)]);
    rxs.push({ id: rxs.length + 1, record: recId, issued: a.a + 3 * HOUR, inpatient: true });
  }
  t('medical_records', ['id', 'appointment_id', 'admission_id', 'patient_id', 'doctor_id', 'conclusion', 'created_at'], () => recs);
  t('prescriptions', ['id', 'medical_record_id', 'issued_at', 'created_at'], () => rxs.map((x) => [x.id, x.record, ts(x.issued), ts(x.issued)]));
  t('prescription_items', ['prescription_id', 'medication_id', 'dosage', 'frequency', 'duration_days', 'quantity'], function* () {
    const ir = r('items');
    for (const x of rxs) {
      const u = ir();
      const n = x.inpatient
        ? u < 0.15 ? 1 : u < 0.5 ? 2 : u < 0.8 ? 3 : u < 0.95 ? 4 : 5 // mean 2.6
        : u < 0.35 ? 1 : u < 0.7 ? 2 : u < 0.9 ? 3 : 4; // mean 2.05
      const seen = new Set<number>();
      while (seen.size < n) seen.add(medPick(ir) + 1);
      for (const m of seen) {
        const days = x.inpatient ? int(ir, 3, 30) : int(ir, 3, 14);
        yield [x.id, m, '1 доза', '2 рази на день', days, days * 2];
      }
    }
  });

  t('medications', ['id', 'name', 'form', 'strength', 'unit_price', 'created_at'], function* () {
    const mr = r('medications');
    for (let m = 1; m <= P.meds; m++) yield [m, `Препарат-${String(m).padStart(4, '0')}`, pick(mr, FORMS), `${int(mr, 1, 100) * 5} мг`, int(mr, 10, 900), created];
  });
  t('drug_classes', ['id', 'code', 'name', 'created_at'], () =>
    Array.from({ length: P.classes }, (_, i) => [i + 1, `C${String(i + 1).padStart(3, '0')}`, `Клас ${i + 1}`, created]));
  t('medication_classes', ['medication_id', 'class_id', 'created_at'], () => medClasses.map(([m, c]) => [m, c, created]));
  t('medication_interactions', ['medication_a', 'medication_b', 'severity', 'created_at'], () => medInter.map(([a, b, s]) => [a, b, s, created]));
  t('drug_class_interactions', ['class_a', 'class_b', 'severity', 'created_at'], () => classInter.map(([a, b, s]) => [a, b, s, created]));

  facts.appointments = nAppt;
  facts.admissions = adms.length;
  facts.openStays = openBeds.size;
  facts.medicalRecords = recs.length;
  facts.prescriptions = rxs.length;
  return { scale, seed, tables, facts };
}
