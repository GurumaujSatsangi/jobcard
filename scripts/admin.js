// Manage admin accounts from the command line.
//
//   npm run admin -- create --name "Jane Doe" --email jane.doe@iacs.res.in --phone 1703 --department "Workshop"
//   npm run admin -- set-password --email jane.doe@iacs.res.in      (choose your own, typed hidden)
//   (In PowerShell use: node scripts/admin.js <command> ... -- PowerShell drops the "--".)
//   npm run admin -- reset-password --email jane.doe@iacs.res.in    (random, printed once)
//   npm run admin -- update --email jane.doe@iacs.res.in [--name ..] [--phone ..] [--department ..]
//   npm run admin -- deactivate --email jane.doe@iacs.res.in
//   npm run admin -- list
//
// The profile (name, email, extension, department) is used as the requester on
// preventive services. A random password is printed once; it is stored only
// as a bcrypt hash, so use reset-password if it is lost.
import "dotenv/config";
import crypto from "node:crypto";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { pool, query, initDb } from "../src/db.js";
import { OFFICIAL_EMAIL_DOMAIN } from "../src/constants.js";
import { hashPassword, revokeAllFor } from "../src/auth/admin-auth.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    department: { type: "string" },
  },
});

const newPassword = () => crypto.randomBytes(12).toString("base64url"); // 16 characters

// Read a line from the terminal without showing what is typed.
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.question(prompt, (answer) => {
      rl.output.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.stdoutMuted = true;
  });
}
const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exitCode = 1;
};
const email = values.email?.trim().toLowerCase();

await initDb();
try {
  const cmd = positionals[0];
  if (cmd === "create") {
    const { name, phone, department } = values;
    if (!name || !email || !phone || !department) fail("create needs --name, --email, --phone and --department");
    else if (!email.endsWith(`@${OFFICIAL_EMAIL_DOMAIN}`)) fail(`--email must be an @${OFFICIAL_EMAIL_DOMAIN} address`);
    else {
      const password = newPassword();
      try {
        const { insertId } = await query(
          "INSERT INTO admin_accounts (name, email, contact_number, department, password_hash) VALUES (?,?,?,?,?)",
          [name.trim(), email, phone.trim(), department.trim(), await hashPassword(password)],
        );
        console.log(`Created admin #${insertId} (${name}, ${email}).\nPassword: ${password}\nGive this to the admin; it will not be shown again.`);
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") fail(`An admin with ${email} already exists.`);
        else throw err;
      }
    }
  } else if (cmd === "set-password") {
    // Choose your own password; typed twice, hidden, never printed.
    const { rows } = await query("SELECT id FROM admin_accounts WHERE email = ?", [email ?? ""]);
    if (!rows[0]) fail("No admin with that --email");
    else {
      const first = await askHidden(`New password for ${email}: `);
      const second = await askHidden("Type it again: ");
      if (first !== second) fail("The two passwords don't match. Nothing was changed.");
      else if (first.length < 12) fail("Use at least 12 characters. Nothing was changed.");
      else {
        await query("UPDATE admin_accounts SET password_hash = ? WHERE id = ?", [await hashPassword(first), rows[0].id]);
        await revokeAllFor(rows[0].id);
        console.log(`Password set for ${email}. Any existing logins were signed out.`);
      }
    }
  } else if (cmd === "reset-password") {
    const password = newPassword();
    const { rows } = await query("SELECT id FROM admin_accounts WHERE email = ?", [email ?? ""]);
    if (!rows[0]) fail("No admin with that --email");
    else {
      await query("UPDATE admin_accounts SET password_hash = ? WHERE id = ?", [await hashPassword(password), rows[0].id]);
      await revokeAllFor(rows[0].id);
      console.log(`New password for ${email}: ${password}\nAll their existing logins were signed out.`);
    }
  } else if (cmd === "update") {
    const sets = [];
    const args = [];
    for (const [flag, col] of [["name", "name"], ["phone", "contact_number"], ["department", "department"]]) {
      if (values[flag]) { sets.push(`${col} = ?`); args.push(values[flag].trim()); }
    }
    if (!sets.length) fail("update needs at least one of --name, --phone, --department");
    else {
      const { rowCount } = await query(`UPDATE admin_accounts SET ${sets.join(", ")} WHERE email = ?`, [...args, email ?? ""]);
      if (!rowCount) fail("No admin with that --email");
      else console.log(`Updated ${email}.`);
    }
  } else if (cmd === "deactivate") {
    const { rows } = await query("SELECT id FROM admin_accounts WHERE email = ?", [email ?? ""]);
    if (!rows[0]) fail("No admin with that --email");
    else {
      await query("UPDATE admin_accounts SET active = 0 WHERE id = ?", [rows[0].id]);
      await revokeAllFor(rows[0].id);
      console.log(`${email} deactivated and signed out.`);
    }
  } else if (cmd === "list") {
    const { rows } = await query("SELECT id, name, email, contact_number, department, active FROM admin_accounts ORDER BY id");
    console.table(rows);
  } else {
    fail("Usage: npm run admin -- <create|set-password|reset-password|update|deactivate|list> [options]");
  }
} finally {
  await pool.end();
}
