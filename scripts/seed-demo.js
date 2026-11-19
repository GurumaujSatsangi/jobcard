// Local demo data for trying the technician flow. Do NOT run in production.
//
//   npm run seed:demo
//
// Demo technician passcodes (test values for local development only):
//   111111  Ramesh Das   (AC & Refrigeration)  -> has job JC2026000001 assigned
//   222222  Suresh Pal   (Electrical)          -> has job JC2026000003 assigned
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

await initDb();
try {
  const ids = {};
  for (const t of DEMO_TECHS) {
    const { rows } = await query(
      `INSERT INTO technician_accounts (name, phone, section, passcode_lookup, passcode_hash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (passcode_lookup) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone,
         section = EXCLUDED.section, active = TRUE
       RETURNING id`,
      [t.name, t.phone, t.section, passcodeLookup(t.passcode), await hashPasscode(t.passcode)],
    );
    ids[t.section] = rows[0].id;
  }

  // JC2026000001 (AC) -> Ramesh, re-opened at "material issued".
  await query(
    `UPDATE job_cards SET technician_id = $1, status = $2, closed_at = NULL, updated_at = now(),
       assigned_at = COALESCE(assigned_at, now()), material_issued_at = COALESCE(material_issued_at, now())
     WHERE arn = 'JC2026000001'`,
    [ids.AC_REFRIGERATION, STATUS.MATERIAL_ISSUED],
  );
  // JC2026000002 (Electrical, already closed) -> Suresh, for history.
  await query("UPDATE job_cards SET technician_id = $1 WHERE arn = 'JC2026000002'", [ids.ELECTRICAL]);

  // A fresh open Electrical job assigned to Suresh, for testing the receipt upload.
  const exists = await query("SELECT 1 FROM job_cards WHERE arn = 'JC2026000003'");
  if (!exists.rowCount) {
    await query("SELECT setval('job_card_arn_seq', GREATEST((SELECT last_value FROM job_card_arn_seq), 3))");
    await query(
      `INSERT INTO job_cards (arn, first_name, last_name, email, contact_number, department, section,
         description, status, technician_id, assigned_at)
       VALUES ('JC2026000003', 'Demo', 'Physics', 'demo.physics@iacs.res.in', '1150',
         'School of Physical Sciences, Room 214', 'ELECTRICAL',
         'Dummy job card: power socket near the fume hood is sparking.', $1, $2, now() - interval '2 hours')`,
      [STATUS.TECHNICIAN_ASSIGNED, ids.ELECTRICAL],
    );
  } else {
    await query(
      "UPDATE job_cards SET status = $1, closed_at = NULL, technician_id = $2 WHERE arn = 'JC2026000003'",
      [STATUS.TECHNICIAN_ASSIGNED, ids.ELECTRICAL],
    );
  }
  console.log("Demo technicians and job cards are ready. Passcodes are listed at the top of scripts/seed-demo.js.");
} finally {
  await pool.end();
}
