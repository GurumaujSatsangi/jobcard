// Manage store in-charge accounts from the command line.
//
//   node scripts/store.js create --name "Ravi Kumar" --email ravi.kumar@iacs.res.in --phone 1705
//   node scripts/store.js set-password --email ravi.kumar@iacs.res.in      (choose your own, typed hidden)
//   node scripts/store.js reset-password --email ravi.kumar@iacs.res.in    (random, printed once)
//   node scripts/store.js deactivate --email ravi.kumar@iacs.res.in
//   node scripts/store.js list
//
// (npm run store -- <command> ... also works outside PowerShell.)
import "dotenv/config";
import crypto from "node:crypto";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { pool, query, initDb } from "../src/db.js";
import { OFFICIAL_EMAIL_DOMAIN } from "../src/constants.js";
import { hashPassword, revokeAllFor } from "../src/auth/store-auth.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
});

const newPassword = () => crypto.randomBytes(12).toString("base64url");
const fail = (msg) => { console.error(`Error: ${msg}`); process.exitCode = 1; };
const email = values.email?.trim().toLowerCase();

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.question(prompt, (answer) => { rl.output.write("\n"); rl.close(); resolve(answer); });
    rl.stdoutMuted = true;
  });
}

const findId = async () => (await query("SELECT id FROM store_accounts WHERE email = ?", [email ?? ""])).rows[0]?.id;

await initDb();
try {
  const cmd = positionals[0];
  if (cmd === "create") {
    const { name, phone } = values;
    if (!name || !email || !phone) fail("create needs --name, --email and --phone");
    else if (!email.endsWith(`@${OFFICIAL_EMAIL_DOMAIN}`)) fail(`--email must be an @${OFFICIAL_EMAIL_DOMAIN} address`);
    else {
      const password = newPassword();
      try {
        const { insertId } = await query(
          "INSERT INTO store_accounts (name, email, contact_number, password_hash) VALUES (?,?,?,?)",
          [name.trim(), email, phone.trim(), await hashPassword(password)],
        );
        console.log(`Created store account #${insertId} (${name}, ${email}).\nPassword: ${password}\nGive this to the store in-charge, or run set-password to choose one.`);
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") fail(`A store account with ${email} already exists.`);
        else throw err;
      }
    }
  } else if (cmd === "set-password") {
    const id = await findId();
    if (!id) fail("No store account with that --email");
    else {
      const first = await askHidden(`New password for ${email}: `);
      const second = await askHidden("Type it again: ");
      if (first !== second) fail("The two passwords don't match. Nothing was changed.");
      else if (first.length < 12) fail("Use at least 12 characters. Nothing was changed.");
      else {
        await query("UPDATE store_accounts SET password_hash = ? WHERE id = ?", [await hashPassword(first), id]);
        await revokeAllFor(id);
        console.log(`Password set for ${email}. Any existing logins were signed out.`);
      }
    }
  } else if (cmd === "reset-password") {
    const id = await findId();
    if (!id) fail("No store account with that --email");
    else {
      const password = newPassword();
      await query("UPDATE store_accounts SET password_hash = ? WHERE id = ?", [await hashPassword(password), id]);
      await revokeAllFor(id);
      console.log(`New password for ${email}: ${password}\nAll their existing logins were signed out.`);
    }
  } else if (cmd === "deactivate") {
    const id = await findId();
    if (!id) fail("No store account with that --email");
    else {
      await query("UPDATE store_accounts SET active = 0 WHERE id = ?", [id]);
      await revokeAllFor(id);
      console.log(`${email} deactivated and signed out.`);
    }
  } else if (cmd === "list") {
    console.table((await query("SELECT id, name, email, contact_number, active FROM store_accounts ORDER BY id")).rows);
  } else {
    fail("Usage: node scripts/store.js <create|set-password|reset-password|deactivate|list> [options]");
  }
} finally {
  await pool.end();
}
