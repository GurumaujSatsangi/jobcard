// Manage technician accounts from the command line (until the admin panel exists).
//
//   npm run technician -- create --name "Ramesh Das" --phone 2239 --section AC_REFRIGERATION
//   npm run technician -- reset-passcode --id 3
//   npm run technician -- deactivate --id 3
//   npm run technician -- list
//
// A new random 6-digit passcode is printed once. It is stored only as a hash,
// so it cannot be shown again; use reset-passcode if it is lost.
import "dotenv/config";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { pool, query, initDb } from "../src/db.js";
import { SECTIONS } from "../src/constants.js";
import { passcodeLookup, hashPasscode } from "../src/auth/technician-auth.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    phone: { type: "string" },
    section: { type: "string" },
    id: { type: "string" },
  },
});

async function uniquePasscode() {
  for (let i = 0; i < 50; i++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const { rowCount } = await query("SELECT 1 FROM technician_accounts WHERE passcode_lookup = $1", [passcodeLookup(code)]);
    if (!rowCount) return code;
  }
  throw new Error("Could not generate a unique passcode.");
}

const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exitCode = 1;
};

await initDb();
try {
  const cmd = positionals[0];
  if (cmd === "create") {
    const { name, phone, section } = values;
    if (!name || !phone || !section) fail("create needs --name, --phone and --section");
    else if (!SECTIONS.some((s) => s.value === section))
      fail(`--section must be one of: ${SECTIONS.map((s) => s.value).join(", ")}`);
    else {
      const code = await uniquePasscode();
      const { rows } = await query(
        `INSERT INTO technician_accounts (name, phone, section, passcode_lookup, passcode_hash)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, phone, section, passcodeLookup(code), await hashPasscode(code)],
      );
      console.log(`Created technician #${rows[0].id} (${name}, ${section}).\nPasscode: ${code}\nGive this to the technician; it will not be shown again.`);
    }
  } else if (cmd === "reset-passcode") {
    const code = await uniquePasscode();
    const { rowCount } = await query(
      "UPDATE technician_accounts SET passcode_lookup = $2, passcode_hash = $3 WHERE id = $1",
      [values.id, passcodeLookup(code), await hashPasscode(code)],
    );
    if (!rowCount) fail("No technician with that --id");
    else {
      await query("UPDATE technician_sessions SET revoked_at = now() WHERE technician_id = $1 AND revoked_at IS NULL", [values.id]);
      console.log(`New passcode for technician #${values.id}: ${code}\nAll their existing logins were signed out.`);
    }
  } else if (cmd === "deactivate") {
    const { rowCount } = await query("UPDATE technician_accounts SET active = FALSE WHERE id = $1", [values.id]);
    if (!rowCount) fail("No technician with that --id");
    else {
      await query("UPDATE technician_sessions SET revoked_at = now() WHERE technician_id = $1 AND revoked_at IS NULL", [values.id]);
      console.log(`Technician #${values.id} deactivated and signed out.`);
    }
  } else if (cmd === "list") {
    const { rows } = await query("SELECT id, name, phone, section, active FROM technician_accounts ORDER BY id");
    console.table(rows);
  } else {
    fail("Usage: npm run technician -- <create|reset-passcode|deactivate|list> [options]");
  }
} finally {
  await pool.end();
}
