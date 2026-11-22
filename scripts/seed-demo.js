// Local demo data for trying the technician flow. Do NOT run in production.
//
//   npm run seed:demo
//
// Safe to run again: it resets the demo job cards to the states below.
//
// Demo technician passcodes (test values for local development only):
//   111111  Ramesh Das   (AC & Refrigeration)  -> JC2026000001 (material issued, open)
//   222222  Suresh Pal   (Electrical)          -> JC2026000002 (closed), JC2026000003 (assigned, open)
import "dotenv/config";
import { pool, query, initDb } from "../src/db.js";
import { STATUS } from "../src/constants.js";
import { passcodeLookup, hashPasscode } from "../src/auth/technician-auth.js";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

const DEMO_TECHS = [
  { passcode: "111111", name: "Ramesh Das", phone: "2239", section: "AC_REFRIGERATION" },
  { passcode: "222222", name: "Suresh Pal", phone: "1704", section: "ELECTRICAL" },
];

// Timestamps are offsets from now, in hours (null = step not reached).
const DEMO_JOBS = [
  {
    arn: "JC2026000001", tech: "AC_REFRIGERATION", status: STATUS.MATERIAL_ISSUED,
    first: "Demo", last: "Indentor", email: "demo.user@iacs.res.in", ext: "1703",
    department: "School of Chemical Sciences", section: "AC_REFRIGERATION",
    itemType: "AIR_CONDITIONER", crew: "IACS/CREW/AC/00005",
    description: "Dummy job card for testing: AC not cooling properly.",
    materials: "Capacitor 2.5 MFD (1), Refrigerant Gas R32 (1 kg)",
    created: -72, assigned: -48, material: -24, closed: null,
  },
  {
    arn: "JC2026000002", tech: "ELECTRICAL", status: STATUS.CLOSED,
    first: "Demo", last: "Electrical", email: "demo.electrical@iacs.res.in", ext: "1704",
    department: "School of Physical Sciences", section: "ELECTRICAL",
    itemType: null, crew: null,
    description: "Dummy job card: tube lights in Lab 3 not working.",
    materials: "LED Tube Light 20W (4)",
    created: -144, assigned: -120, material: -96, closed: -72,
  },
  {
    arn: "JC2026000003", tech: "ELECTRICAL", status: STATUS.TECHNICIAN_ASSIGNED,
    first: "Demo", last: "Physics", email: "demo.physics@iacs.res.in", ext: "1150",
    department: "School of Physical Sciences, Room 214", section: "ELECTRICAL",
    itemType: null, crew: null,
    description: "Dummy job card: power socket near the fume hood is sparking.",
    materials: null,
    created: -3, assigned: -2, material: null, closed: null,
  },
];

const hoursFromNow = (h) => (h === null ? null : new Date(Date.now() + h * 3600 * 1000));

await initDb();
try {
  const demoAc = DEMO_JOBS.find((j) => j.crew).crew;
  const { rowCount: acLoaded } = await query("SELECT 1 FROM ac_units WHERE crew_serial_number = ?", [demoAc]);
  if (!acLoaded) throw new Error(`Load the AC data sheet first (npm run import:ac -- <csv>); demo job uses ${demoAc}.`);

  const techIds = {};
  for (const t of DEMO_TECHS) {
    const lookup = passcodeLookup(t.passcode);
    await query(
      `INSERT INTO technician_accounts (name, phone, section, passcode_lookup, passcode_hash)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone), section = VALUES(section), active = 1`,
      [t.name, t.phone, t.section, lookup, await hashPasscode(t.passcode)],
    );
    const { rows } = await query("SELECT id FROM technician_accounts WHERE passcode_lookup = ?", [lookup]);
    techIds[t.section] = rows[0].id;
  }

  for (const j of DEMO_JOBS) {
    const tech = DEMO_TECHS.find((t) => t.section === j.tech);
    await query(
      `INSERT INTO job_cards
         (arn, first_name, last_name, email, contact_number, department, section, item_type,
          crew_serial_number, details_correct, description, status, technician_id,
          technician_name, technician_phone, assigned_at, materials_issued, material_issued_at,
          closed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         crew_serial_number = VALUES(crew_serial_number),
         status = VALUES(status), technician_id = VALUES(technician_id),
         technician_name = VALUES(technician_name), technician_phone = VALUES(technician_phone),
         assigned_at = VALUES(assigned_at), materials_issued = VALUES(materials_issued),
         material_issued_at = VALUES(material_issued_at), closed_at = VALUES(closed_at),
         created_at = VALUES(created_at), updated_at = UTC_TIMESTAMP(3)`,
      [j.arn, j.first, j.last, j.email, j.ext, j.department, j.section, j.itemType,
       j.crew, j.crew ? 1 : null, j.description, j.status, techIds[j.tech],
       tech.name, tech.phone, hoursFromNow(j.assigned), j.materials, hoursFromNow(j.material),
       hoursFromNow(j.closed), hoursFromNow(j.created)],
    );
  }

  // Make sure new applications get ARNs after the demo ones.
  await query(
    `INSERT INTO arn_counters (year, last_value) VALUES (2026, 3)
     ON DUPLICATE KEY UPDATE last_value = GREATEST(last_value, 3)`,
  );

  console.log("Demo technicians and job cards are ready. Passcodes are listed at the top of scripts/seed-demo.js.");
} finally {
  await pool.end();
}
