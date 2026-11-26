// Telegram bot: links technicians to Telegram and sends them a message when
// a job card (ARN) or preventive service is assigned to them.
//
// Telegram does not let bots look people up by phone number, so each
// technician opens the bot once and taps "Share my mobile number". The bot
// stores number -> Telegram user in telegram_contacts (and links any
// technician account with that mobile). An admin can only add a technician
// whose number has been shared this way, so every technician can be alerted.
//
// Updates are read with long polling (getUpdates) while the server runs, and
// once more right before each check, so no public webhook URL is needed.
//
// .env: TELEGRAM_BOT_TOKEN (from @BotFather).
import { query } from "./db.js";

const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim();
export const telegramConfigured = () => Boolean(token());

// Last 10 digits of an Indian mobile number ("+91 98765 43210" -> "9876543210").
export function normalizeMobile(v) {
  const digits = String(v ?? "").replace(/\D/g, "");
  const ten = digits.length > 10 && /^(91|0)/.test(digits) ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

const html = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

class TelegramError extends Error {}

async function tg(method, params = {}, { timeoutMs = 15000 } = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw Object.assign(new TelegramError(data.description || `Telegram ${method} failed (${res.status})`), { code: data.error_code });
  return data.result;
}

let botUsername = null;
async function getBotUsername() {
  if (!botUsername) botUsername = (await tg("getMe")).username;
  return botUsername;
}

// ---------- reading updates ----------

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg || msg.chat?.type !== "private") return; // only direct chats with the bot
  const chatId = msg.chat.id;

  if (msg.contact) {
    if (msg.contact.user_id !== msg.from?.id) {
      await tg("sendMessage", { chat_id: chatId, text: "Please share your own number using the button below." }).catch(() => {});
      return;
    }
    const mobile = normalizeMobile(msg.contact.phone_number);
    if (!mobile) {
      await tg("sendMessage", { chat_id: chatId, text: "Sorry, only Indian mobile numbers can be registered." }).catch(() => {});
      return;
    }
    await query(
      `INSERT INTO telegram_contacts (mobile, telegram_user_id, first_name, username, updated_at)
       VALUES (?,?,?,?, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE telegram_user_id = VALUES(telegram_user_id), first_name = VALUES(first_name),
                               username = VALUES(username), updated_at = UTC_TIMESTAMP(3)`,
      [mobile, msg.from.id, msg.from.first_name?.slice(0, 255) ?? null, msg.from.username?.slice(0, 64) ?? null],
    );
    // A technician account with this mobile starts getting alerts right away.
    const { rowCount: linked } = await query(
      "UPDATE technician_accounts SET telegram_user_id = ? WHERE mobile = ?",
      [msg.from.id, mobile],
    );
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Thank you. Your number ending ${mobile.slice(-4)} is registered with the IACS Online Job Card Portal.\n\n`
        + (linked
          ? "You will get a message here whenever a job card is assigned to you."
          : "Ask the Workshop admin to create your technician account. After that you will get a message here whenever a job card is assigned to you."),
      reply_markup: { remove_keyboard: true },
    }).catch(() => {});
    return;
  }

  // /start or anything else: ask for the number.
  await tg("sendMessage", {
    chat_id: chatId,
    text: "IACS Online Job Card Portal\n\nTap the button below to share your mobile number. You will then get a message here whenever a job card is assigned to you.",
    reply_markup: {
      keyboard: [[{ text: "Share my mobile number", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  }).catch(() => {});
}

let offset = 0;
let syncing = null;

// Fetch and handle pending updates. `wait` seconds of long polling (0 = return at once).
function syncUpdates(wait = 0) {
  syncing ??= (async () => {
    try {
      const updates = await tg("getUpdates", { offset, timeout: wait, allowed_updates: ["message"] }, { timeoutMs: (wait + 10) * 1000 });
      for (const u of updates) {
        offset = u.update_id + 1;
        try { await handleUpdate(u); } catch (err) { console.error("Telegram update failed:", err.message); }
      }
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// Background long polling while the server runs.
export function startTelegramPolling() {
  if (!telegramConfigured()) {
    console.warn("Telegram is off: set TELEGRAM_BOT_TOKEN in .env to add technicians and send them job alerts.");
    return;
  }
  let lastError = "";
  const loop = async () => {
    for (;;) {
      try {
        await syncUpdates(25);
        lastError = "";
      } catch (err) {
        // 409: a webhook is set or another server process is polling. Back off quietly.
        if (err.message !== lastError) console.error("Telegram polling:", err.message);
        lastError = err.message;
        await new Promise((r) => setTimeout(r, err.code === 409 ? 30000 : 10000));
      }
    }
  };
  loop();
}

// ---------- linking a technician ----------

/**
 * Has this mobile number been shared with the bot?
 * @returns {Promise<{ok: true, telegramUserId: number} | {ok: false, reason: string, message: string}>}
 */
export async function findTelegramUser(mobile) {
  if (!telegramConfigured()) {
    return { ok: false, reason: "NOT_CONFIGURED", message: "Telegram isn't set up on the server (TELEGRAM_BOT_TOKEN), so technicians can't be added yet." };
  }
  try {
    // Pick up a number shared moments ago. If background polling is mid-request
    // it is already receiving updates as they arrive, so don't wait for it.
    if (!syncing) await syncUpdates(0).catch(() => {});
    const { rows: [link] } = await query("SELECT telegram_user_id FROM telegram_contacts WHERE mobile = ?", [mobile]);
    if (link) return { ok: true, telegramUserId: Number(link.telegram_user_id) };
    const bot = await getBotUsername();
    return {
      ok: false,
      reason: "NOT_SHARED",
      message: `Mobile number ${mobile} hasn't been shared with the Telegram bot yet. Ask the technician to open @${bot} on Telegram, tap Start and then "Share my mobile number". Then retry.`,
    };
  } catch (err) {
    console.error("Telegram check failed:", err.message);
    return { ok: false, reason: "TELEGRAM_ERROR", message: `Couldn't reach Telegram (${err.message}). Please retry.` };
  }
}

// ---------- alerts ----------

/**
 * Send a message to a technician. Never throws.
 * @returns {Promise<"sent" | "not_linked" | "failed">}
 */
export async function sendTechnicianAlert(telegramUserId, text) {
  if (!telegramConfigured() || !telegramUserId) return "not_linked";
  try {
    await tg("sendMessage", { chat_id: Number(telegramUserId), text, parse_mode: "HTML", disable_web_page_preview: true }, { timeoutMs: 8000 });
    return "sent";
  } catch (err) {
    // 403: the technician blocked the bot or deleted the chat.
    console.error(`Telegram alert to ${telegramUserId} failed:`, err.message);
    return "failed";
  }
}

const line = (label, value) => (value ? `\n<b>${html(label)}:</b> ${html(value)}` : "");

// Message for a job card assigned to a technician.
export function jobAssignedText(jc, { reassigned = false } = {}) {
  return `🔧 <b>${reassigned ? "Job card reassigned to you" : "New job card assigned"}</b>\n`
    + `\n<b>ARN:</b> <code>${html(jc.arn)}</code>`
    + line("Section", jc.sectionLabel)
    + line("Indentor", jc.indentor)
    + line("Contact", jc.contact)
    + line("Department", jc.department)
    + line("CREW Serial No.", jc.crewSerialNumber)
    + line("Room No.", jc.roomNumber)
    + line("Work", jc.description?.length > 300 ? `${jc.description.slice(0, 300)}…` : jc.description)
    + "\n\nOpen My Jobs on the Online Job Card Portal for details.";
}

// Message for a preventive service assigned to a technician.
export function serviceAssignedText(ps) {
  return `🛠 <b>New preventive service assigned</b>\n`
    + `\n<b>Ref:</b> <code>${html(ps.ref)}</code>`
    + line("Service", ps.serviceType)
    + line("CREW Serial No.", ps.crewSerialNumber)
    + line("Room No.", ps.roomNumber)
    + line("Place", ps.school)
    + line("Requested by", ps.requestedBy)
    + "\n\nOpen My Jobs on the Online Job Card Portal for details.";
}

// Tell the previous technician a job was moved to someone else.
export function jobRemovedText(arn) {
  return `ℹ️ Job card <code>${html(arn)}</code> has been reassigned to another technician. You no longer need to attend to it.`;
}
