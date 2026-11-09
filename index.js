require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { DateTime } = require('luxon');
const cron = require('node-cron');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN || '8974478810:AAEgxD-ikJrMwV_JSBJY9F45ppBhefoZjtg';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-1003493006883';

// 👑 EXCLUSIVE SUPER ADMIN TELEGRAM ID (Permanently Locked to Mahi)
const ADMIN_ID = process.env.ADMIN_ID || '6416451659';

function checkIsAdmin(ctx) {
  if (!ctx.from) return false;
  return String(ctx.from.id) === String(ADMIN_ID);
}

// ⏰ ATTENDANCE TIME WINDOW (IST): 06:00 AM – 11:30 AM
const START_HOUR = parseInt(process.env.ATTENDANCE_START_HOUR || '6');
const START_MINUTE = parseInt(process.env.ATTENDANCE_START_MINUTE || '0');
const END_HOUR = parseInt(process.env.ATTENDANCE_END_HOUR || '11');
const END_MINUTE = parseInt(process.env.ATTENDANCE_END_MINUTE || '30');
const TIMING_TEXT = '06:00 AM – 11:30 AM (IST)';

// 🗄️ File to store active button message IDs (11:30 AM auto-delete ke liye)
const BUTTONS_STORE = path.join(__dirname, 'active_buttons.json');

function getStoredMessageIds() {
  try {
    if (fs.existsSync(BUTTONS_STORE)) {
      const data = JSON.parse(fs.readFileSync(BUTTONS_STORE, 'utf8'));
      const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
      if (data.date === today && Array.isArray(data.ids)) {
        return data.ids;
      }
    }
  } catch (e) {}
  return [];
}

function saveStoredMessageIds(ids) {
  try {
    const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    fs.writeFileSync(BUTTONS_STORE, JSON.stringify({ date: today, ids }), 'utf8');
  } catch (e) {}
}

let activeAttendanceMessageIds = getStoredMessageIds();

// -------------------------------------------------------------
// 📁 Admin & System Persistent State Files
// -------------------------------------------------------------
const STATE_FILE = path.join(__dirname, 'attendance_state.json');
const MAINTENANCE_FILE = path.join(__dirname, 'maintenance_state.json');
const HOLIDAY_FILE = path.join(__dirname, 'holiday_state.json');

function getAttendanceState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof data.enabled === 'boolean') return data.enabled;
    }
  } catch (e) {}
  return true; // Default ON
}

function setAttendanceState(enabled) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled }), 'utf8');
  } catch (e) {}
}

function getMaintenanceState() {
  try {
    if (fs.existsSync(MAINTENANCE_FILE)) {
      const data = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
      if (typeof data.enabled === 'boolean') return data.enabled;
    }
  } catch (e) {}
  return false; // Default OFF
}

function setMaintenanceState(enabled) {
  try {
    fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify({ enabled }), 'utf8');
  } catch (e) {}
}

function getHolidayState() {
  try {
    if (fs.existsSync(HOLIDAY_FILE)) {
      return JSON.parse(fs.readFileSync(HOLIDAY_FILE, 'utf8'));
    }
  } catch (e) {}
  return { isHoliday: false, date: '', reason: '' };
}

function setHolidayState(isHoliday, reason = '') {
  try {
    const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    fs.writeFileSync(HOLIDAY_FILE, JSON.stringify({ isHoliday, date: today, reason }), 'utf8');
  } catch (e) {}
}

function isHolidayToday() {
  const hol = getHolidayState();
  if (!hol || !hol.isHoliday) return false;
  const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
  return hol.date === today;
}

const MAINTENANCE_POPUP = '⚠️ SERVER MAINTENANCE NOTICE\n\nAdmin Mahi is working on Data Server.\nPlease be patient, service will resume shortly!';
const MAINTENANCE_CHAT_NOTICE = `<b>⚠️ SERVER MAINTENANCE NOTICE</b>\n━━━━━━━━━━━━━━━━━━━━━━\n👩‍💻 <b>Admin Mahi is currently working on Data Server.</b>\n⚙️ <i>Bot functions are temporarily paused to protect attendance records.\nServices will resume shortly. Thank you for your patience!</i> 🌸`;

function isAttendanceOpen(dt) {
  if (!getAttendanceState()) return false;
  if (getMaintenanceState()) return false;
  if (isHolidayToday()) return false;

  const currentMins = dt.hour * 60 + dt.minute;
  const startMins = START_HOUR * 60 + START_MINUTE;
  const endMins = END_HOUR * 60 + END_MINUTE;
  return currentMins >= startMins && currentMins <= endMins;
}

const bot = new Telegraf(BOT_TOKEN);

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getAttendanceKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Mark Present', 'btn_present'),
      Markup.button.callback('🍂 Take Leave', 'btn_leave')
    ]
  ]);
}

const pendingLeaveRequests = new Map();
let waitingAdminHolidayReason = false;
let holidayPromptMsgId = null;
let waitingAdminReportDate = false;
let datePromptMsgId = null;

// -------------------------------------------------------------
// 🎛️ Admin Dashboard Generator (Private Chat Only)
// -------------------------------------------------------------
function getAdminDashboardText() {
  const attState = getAttendanceState() ? '🟢 ON (Active)' : '🔴 OFF (Closed)';
  const maintState = getMaintenanceState() ? '🛠️ ACTIVE (Server Down Mode)' : '🚀 LIVE (Normal Mode)';
  const hol = getHolidayState();
  const holState = isHolidayToday() ? `🏖️ YES (${hol.reason || 'Rest Day'})` : '☀️ NO (Regular Day)';

  return `👑 <b>MASTER ADMIN CONTROL PANEL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Admin:</b> Mahi (<code>${ADMIN_ID}</code>)\n` +
    `⚙️ <b>Live System Status:</b>\n` +
    `• Attendance: <b>${attState}</b>\n` +
    `• Holiday Today: <b>${holState}</b>\n` +
    `• Maintenance: <b>${maintState}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Niche diye gaye buttons se poora bot control karein:</i>`;
}

function getAdminKeyboard() {
  const attState = getAttendanceState();
  const maintState = getMaintenanceState();
  const holState = isHolidayToday();

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(attState ? '🔴 Turn OFF Attendance' : '🟢 Turn ON Attendance', 'adm_toggle_att'),
      Markup.button.callback(holState ? '☀️ Cancel Holiday' : '🏖️ Declare Holiday', holState ? 'adm_cancel_holiday' : 'adm_declare_holiday')
    ],
    [
      Markup.button.callback(maintState ? '🚀 Restore Server (UP)' : '🛠️ Server Down Mode', 'adm_toggle_maint')
    ],
    [
      Markup.button.callback('📥 Download CSV Sheet', 'adm_export_csv'),
      Markup.button.callback('🔄 Sync Group Members', 'adm_sync_members')
    ],
    [
      Markup.button.callback('📊 Test Night Report', 'adm_test_report'),
      Markup.button.callback('🗓️ Past & Month Reports', 'adm_past_reports')
    ],
    [
      Markup.button.callback('🚨 Defaulters List (Inactive)', 'adm_defaulters_list'),
      Markup.button.callback('🔄 Refresh Status', 'adm_refresh')
    ]
  ]);
}

function getReportsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Kal (Yesterday) ki Report', 'adm_rep_yesterday'),
      Markup.button.callback('🗓️ Is Mahine (Month) Summary', 'adm_rep_month_card')
    ],
    [
      Markup.button.callback('📁 Monthly Excel Sheet', 'adm_rep_month_csv'),
      Markup.button.callback('🔍 Kisi Date ki Report', 'adm_rep_custom_date')
    ],
    [
      Markup.button.callback('🔙 Back to Main Control Panel', 'adm_refresh')
    ]
  ]);
}

// -------------------------------------------------------------
// Global Middleware: Register members & Intercept Maintenance
// -------------------------------------------------------------
bot.use(async (ctx, next) => {
  if (ctx.from) {
    db.registerMember(ctx.from.id, ctx.from.first_name, ctx.from.username).catch(() => {});
  }

  // Intercept Admin Holiday Reason input in Private DM
  if (ctx.chat && ctx.chat.type === 'private' && checkIsAdmin(ctx) && waitingAdminHolidayReason) {
    if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
      waitingAdminHolidayReason = false;
      const reason = ctx.message.text.trim();
      setHolidayState(true, reason);

      // 1. Group me Official Beautiful Announcement bhejein
      const groupNotice = `🌸 <b>ʀᴀᴅʜᴇ ʀᴀᴅʜᴇ! ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʏᴏᴜ ᴀʟʟ☀️</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🏖️ <b>OFFICIAL HOLIDAY NOTICE</b> 🎉\n\n📢 <b>Aaj Chhutti (Holiday) ghoshit ki gayi hai!</b>\n📌 <b>Reason:</b> <i>${escapeHTML(reason)}</i>\n━━━━━━━━━━━━━━━━━━━━━━\n✨ Aaj daily attendance band rahegi. Kisi ka Absent mark nahi hoga. Sabhi log enjoy karein! 💗`;
      await bot.telegram.sendMessage(GROUP_CHAT_ID, groupNotice, { parse_mode: 'HTML' }).catch(() => {});

      // 2. Active buttons group se turant delete karein
      const idsToDelete = [...new Set([...activeAttendanceMessageIds, ...getStoredMessageIds()])];
      for (const msgId of idsToDelete) {
        await bot.telegram.deleteMessage(GROUP_CHAT_ID, msgId).catch(() => {});
      }
      activeAttendanceMessageIds = [];
      saveStoredMessageIds([]);

      // 3. Admin ko confirmation aur updated dashboard bhejein
      if (holidayPromptMsgId) {
        ctx.deleteMessage(holidayPromptMsgId).catch(() => {});
        holidayPromptMsgId = null;
      }

      await ctx.reply(`🏖️ <b>Holiday successfully declare ho gayi!</b>\n📢 <i>Group me announcement post kar di gayi hai.</i>`, { parse_mode: 'HTML' });
      await ctx.reply(getAdminDashboardText(), { parse_mode: 'HTML', ...getAdminKeyboard() });
      return;
    }
  }

  // Intercept Admin Custom Date input for Reports in Private DM
  if (ctx.chat && ctx.chat.type === 'private' && checkIsAdmin(ctx) && waitingAdminReportDate) {
    if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
      waitingAdminReportDate = false;
      const inputDate = ctx.message.text.trim();
      if (datePromptMsgId) {
        ctx.deleteMessage(datePromptMsgId).catch(() => {});
        datePromptMsgId = null;
      }

      const parts = inputDate.split('-');
      if (parts.length !== 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
        await ctx.reply(`⚠️ <b>Galat Format!</b> Kripya date is tarah likhein: <code>DD-MM-YYYY</code>\n<i>Udaharan: 05-11-2026</i>`, { parse_mode: 'HTML' });
        return;
      }

      const rep = await getDateAttendanceReport(inputDate);
      await ctx.reply(rep.text, { parse_mode: 'HTML' });
      return;
    }
  }

  // Intercept normal users during Maintenance Mode
  if (getMaintenanceState() && ctx.from) {
    const isAdmin = checkIsAdmin(ctx);
    if (!isAdmin) {
      if (ctx.callbackQuery) {
        return ctx.answerCbQuery(MAINTENANCE_POPUP, { show_alert: true });
      }
      if (ctx.message && ctx.message.text && /^\/(present|leave)/i.test(ctx.message.text)) {
        const notice = await ctx.reply(MAINTENANCE_CHAT_NOTICE, { parse_mode: 'HTML' });
        setTimeout(() => {
          ctx.deleteMessage(ctx.message.message_id).catch(() => {});
          ctx.deleteMessage(notice.message_id).catch(() => {});
        }, 12000);
        return;
      }
    }
  }

  // Check if message is a response to a pending Leave request
  if (ctx.message && ctx.message.text && ctx.from) {
    const userId = String(ctx.from.id);
    if (pendingLeaveRequests.has(userId)) {
      const pending = pendingLeaveRequests.get(userId);
      const userText = ctx.message.text.trim();

      if (!userText.startsWith('/')) {
        clearTimeout(pending.timeout);
        pendingLeaveRequests.delete(userId);

        const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');

        if (userText.length < 3) {
          const deniedMsg = await ctx.reply(
            `❌ <b>LEAVE DENIED (REJECTED):</b> ${escapeHTML(pending.name)}\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ Sahi reason na likhne ke karan aapki Leave reject kar di gayi hai.`,
            { parse_mode: 'HTML' }
          );

          setTimeout(() => {
            ctx.deleteMessage(ctx.message.message_id).catch(() => {});
            ctx.deleteMessage(pending.promptMsgId).catch(() => {});
            ctx.deleteMessage(deniedMsg.message_id).catch(() => {});
          }, 15000);
          return;
        }

        await db.addAttendance({
          date: today,
          userId: userId,
          name: pending.name,
          username: pending.username,
          status: 'Leave',
          reason: userText
        });

        const acceptedMsg = await ctx.reply(
          `<b>🍂 ${escapeHTML(pending.name)}, aapki Leave ACCEPT kar li gayi hai! ✅</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📝 <b>Karan (Reason):</b> <i>${escapeHTML(userText)}</i>`,
          { parse_mode: 'HTML' }
        );

        setTimeout(() => {
          ctx.deleteMessage(ctx.message.message_id).catch(() => {});
          ctx.deleteMessage(pending.promptMsgId).catch(() => {});
          ctx.deleteMessage(acceptedMsg.message_id).catch(() => {});
        }, 25000);
        return;
      }
    }
  }

  return next();
});

// -------------------------------------------------------------
// Auto-Remove Member when they leave or get removed from group
// -------------------------------------------------------------
bot.on('left_chat_member', async (ctx) => {
  try {
    const leftUser = ctx.message.left_chat_member;
    if (leftUser) {
      const userId = String(leftUser.id);
      const name = leftUser.first_name || 'Member';
      console.log(`[LEAVE EVENT] ${name} (${userId}) left group. Cleaning from database...`);
      await db.removeMember(userId);
    }
  } catch (err) {
    console.error('[LEFT_CHAT_MEMBER ERROR]:', err);
  }
});

// -------------------------------------------------------------
// 1. Cron Job: 6:00 AM Daily Morning Announcement Message
// -------------------------------------------------------------
cron.schedule('0 6 * * *', async () => {
  try {
    if (isHolidayToday()) {
      const hol = getHolidayState();
      const holidayMsg = `🌸 <b>ʀᴀᴅʜᴇ ʀᴀᴅʜᴇ! ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʏᴏᴜ ᴀʟʟ☀️</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🏖️ <b>ᴛᴏᴅᴀʏ ɪꜱ ᴀ ʜᴏʟɪᴅᴀʏ!</b> 🎉\n📌 <b>Reason:</b> <i>${escapeHTML(hol.reason || 'Rest & Celebration Day')}</i>\n\n✨ Aaj attendance band rahegi. Sabhi log enjoy karein! 💗`;
      await bot.telegram.sendMessage(GROUP_CHAT_ID, holidayMsg, { parse_mode: 'HTML' });
      console.log('[CRON] 6:00 AM Holiday notice sent.');
      return;
    }

    if (!getAttendanceState()) {
      console.log('[CRON] 6:00 AM skipped: Attendance is turned OFF by Admin.');
      return;
    }

    const msg = `🌸 ʀᴀᴅʜᴇ ʀᴀᴅʜᴇ! ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʏᴏᴜ ᴀʟʟ☀️\n💗 ᴅᴀɪʟʏ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ɪꜱ ɴᴏᴡ ᴏᴘᴇɴ\n⏰ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴛɪᴍɪɴɢ\n🕕 <b>06:00 AM – 11:30 AM (IST)</b>\n📌 ᴀᴘɴɪ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴍᴀʀᴋ ᴋᴀʀɴᴇ ᴋᴇ ʟɪʏᴇ ɴɪᴄʜᴇ ᴅɪʏᴇ ɢᴀʏᴇ ʙᴜᴛᴛᴏNꜱ ᴘᴀʀ ᴄʟɪᴄᴋ ᴋᴀʀᴇɴ. 💗`;
    const sentMsg = await bot.telegram.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'HTML', ...getAttendanceKeyboard() });
    
    activeAttendanceMessageIds.push(sentMsg.message_id);
    saveStoredMessageIds(activeAttendanceMessageIds);

    console.log('[CRON] 6:00 AM Announcement sent with buttons. Message ID:', sentMsg.message_id);
  } catch (err) {
    console.error('[CRON ERROR] 6 AM:', err);
  }
}, { timezone: 'Asia/Kolkata' });

// -------------------------------------------------------------
// 1.5. Cron Job: 11:30 AM Attendance Closed - Auto-Delete Buttons
// -------------------------------------------------------------
cron.schedule('30 11 * * *', async () => {
  try {
    console.log('[CRON] 11:30 AM: Removing active attendance button messages...');
    const idsToDelete = [...new Set([...activeAttendanceMessageIds, ...getStoredMessageIds()])];
    
    for (const msgId of idsToDelete) {
      await bot.telegram.deleteMessage(GROUP_CHAT_ID, msgId).catch(() => {});
    }

    activeAttendanceMessageIds = [];
    saveStoredMessageIds([]);

    // Agar Holiday hai, Attendance OFF hai, ya Server Down hai, toh "Closed" message group me NAHI jayega
    if (isHolidayToday() || !getAttendanceState() || getMaintenanceState()) {
      console.log('[CRON] 11:30 AM: Skipped closed notice because holiday/attendance-off/maintenance is active.');
      return;
    }

    const closedMsg = await bot.telegram.sendMessage(
      GROUP_CHAT_ID,
      `⏰ <b>ATTENDANCE CLOSED!</b> 🔒\n━━━━━━━━━━━━━━━━━━━━━━\n11:30 AM ho chuke hain. Aaj ki attendance window close ho gayi hai.\nAb attendance record nahi hogi.`,
      { parse_mode: 'HTML' }
    );

    setTimeout(() => {
      bot.telegram.deleteMessage(GROUP_CHAT_ID, closedMsg.message_id).catch(() => {});
    }, 60000);

    console.log('[CRON] 11:30 AM: Attendance closed notice sent & buttons deleted.');
  } catch (err) {
    console.error('[CRON ERROR] 11:30 AM:', err);
  }
}, { timezone: 'Asia/Kolkata' });

// -------------------------------------------------------------
// Helper: Working-Day Smart Streak Calculator & Badge
// -------------------------------------------------------------
function getStreakBadge(streakCount) {
  if (streakCount >= 30) return ' 👑 [Legend]';
  if (streakCount >= 15) return ' 🌟 [Gold]';
  if (streakCount >= 7) return ' 🔥 [Silver]';
  if (streakCount >= 3) return ' ⚡ [Rising Star]';
  return '';
}

function calculateWorkingDayStreak(userId, allRows, targetDateStr = null, isUserPresentToday = null) {
  const uId = String(userId);
  const targetDt = targetDateStr
    ? DateTime.fromFormat(targetDateStr, 'dd-MM-yyyy', { zone: 'Asia/Kolkata' })
    : DateTime.now().setZone('Asia/Kolkata');

  const dateMap = new Map();
  const userRecords = new Map();

  for (const r of allRows) {
    const dStr = String(r.date || '').trim();
    if (!dStr) continue;
    const dt = DateTime.fromFormat(dStr, 'dd-MM-yyyy', { zone: 'Asia/Kolkata' });
    if (dt.isValid && dt.startOf('day') <= targetDt.startOf('day')) {
      dateMap.set(dStr, dt.toMillis());
    }
    if (String(r.userId) === uId) {
      userRecords.set(dStr, String(r.status || 'Present').trim());
    }
  }

  if (targetDateStr && isUserPresentToday === true) {
    dateMap.set(targetDateStr, targetDt.toMillis());
    userRecords.set(targetDateStr, 'Present');
  }

  // Sort dates descending (newest to oldest)
  const sortedDates = Array.from(dateMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  if (sortedDates.length === 0) return 0;

  let streak = 0;
  let startIdx = 0;

  if (targetDateStr && sortedDates[0] === targetDateStr) {
    if (userRecords.get(targetDateStr) !== 'Present') {
      startIdx = 1;
    }
  }

  for (let i = startIdx; i < sortedDates.length; i++) {
    const dStr = sortedDates[i];
    if (userRecords.get(dStr) === 'Present') {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

// -------------------------------------------------------------
// Function: Generate & Send Attractive Single-Card Night Report
// -------------------------------------------------------------
async function sendDailyAttendanceReport(targetChatId = GROUP_CHAT_ID) {
  try {
    const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');

    if (isHolidayToday()) {
      setHolidayState(false, ''); // Reset single day holiday
      if (targetChatId === GROUP_CHAT_ID) {
        console.log('[REPORT] Holiday active, skipped sending report to group.');
        return;
      }
      const hol = getHolidayState();
      const holMsg = `🏖️ <b>DAILY SUMMARY (HOLIDAY)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📅 <b>Date:</b> <code>${today}</code>\n🎉 <b>Aaj Holiday thi:</b> <i>${escapeHTML(hol.reason || 'Rest Day')}</i>\n✨ <i>Kisi bhi member ka Absent mark nahi hua hai. Kal attendance normal shuru hogi!</i> 🌸`;
      await bot.telegram.sendMessage(targetChatId, holMsg, { parse_mode: 'HTML' });
      return;
    }

    // Agar Group me report bhej rahe hain aur Attendance OFF ya Server Down hai, toh skip karein
    if (targetChatId === GROUP_CHAT_ID) {
      if (!getAttendanceState()) {
        console.log('[REPORT] Attendance OFF thi, group me night report nahi jayegi.');
        return;
      }
      if (getMaintenanceState()) {
        console.log('[REPORT] Server Down tha, group me night report nahi jayegi.');
        return;
      }
    }

    const members = await db.getAllMembers();
    const attendance = await db.getAllAttendance();

    const nowKolkata = DateTime.now().setZone('Asia/Kolkata');
    const displayDate = nowKolkata.toFormat('dd LLL yyyy');
    const yesterday = nowKolkata.minus({ days: 1 }).toFormat('dd-MM-yyyy');
    const dayBefore = nowKolkata.minus({ days: 2 }).toFormat('dd-MM-yyyy');

    const totalMembersCount = members.length;

    const todayAttendance = attendance.filter(r => String(r.date).trim() === today);
    const presentUsers = todayAttendance.filter(r => String(r.status || 'Present').trim() === 'Present');
    const leaveUsers = todayAttendance.filter(r => String(r.status || '').trim() === 'Leave');

    const presentUserIds = new Set(presentUsers.map(u => String(u.userId)));
    const leaveUserIds = new Set(leaveUsers.map(u => String(u.userId)));

    const absentUsers = members.filter(m => !presentUserIds.has(String(m.userId)) && !leaveUserIds.has(String(m.userId)));

    // Consecutive Inactive (3+ days)
    const warnings = [];
    for (const member of absentUsers) {
      const mId = String(member.userId);
      const attendedYesterday = attendance.some(r => String(r.date).trim() === yesterday && String(r.userId) === mId);
      const attendedDayBefore = attendance.some(r => String(r.date).trim() === dayBefore && String(r.userId) === mId);
      if (!attendedYesterday && !attendedDayBefore) {
        warnings.push(escapeHTML(member.name || 'Member'));
      }
    }

    const turnoutRate = totalMembersCount > 0 ? Math.round((presentUsers.length / totalMembersCount) * 100) : 0;
    const filledBlocks = Math.round((turnoutRate / 100) * 10);
    const emptyBlocks = 10 - filledBlocks;
    const progressBar = '▰'.repeat(filledBlocks) + '▱'.repeat(emptyBlocks);

    // Streaks for Present Members (Smart Working-Days Calculation)
    const streakList = [];
    for (const pUser of presentUsers) {
      const uId = String(pUser.userId);
      const sCount = calculateWorkingDayStreak(uId, attendance, today, true);
      streakList.push({ name: escapeHTML(pUser.name || 'Unknown'), streak: sCount });
    }
    streakList.sort((a, b) => b.streak - a.streak);
    const topThree = streakList.slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];
    let leaderboardText = '';
    if (topThree.length > 0) {
      leaderboardText = topThree.map((item, idx) => `${medals[idx]} <code>${item.name}</code> ➔ <b>${item.streak} Days</b> 🔥`).join('\n');
    } else {
      leaderboardText = '  <i>No streaks recorded today</i>';
    }

    let leaveText = '';
    if (leaveUsers.length > 0) {
      leaveText = leaveUsers.slice(0, 5).map(u => `• <code>${escapeHTML(u.name || 'Unknown')}</code> <i>(${escapeHTML(u.reason || 'No reason')})</i>`).join('\n');
      if (leaveUsers.length > 5) leaveText += `\n• <i>...and ${leaveUsers.length - 5} more on leave</i>`;
    } else {
      leaveText = '  <i>None</i>';
    }

    let warningText = '';
    if (warnings.length > 0) {
      warningText = warnings.slice(0, 6).map(n => `<code>${n}</code> ⚠️`).join(', ');
      if (warnings.length > 6) warningText += `, ...and ${warnings.length - 6} more`;
    } else {
      warningText = '  <i>Sabhi active hain! (None)</i>';
    }

    const quotes = [
      'सफलता एक दिन में नहीं मिलती, लेकिन एक दिन ज़रूर मिलती है।',
      'निरंतर प्रयास ही सफलता की सबसे बड़ी कुंजी है।',
      'जो पानी से नहाता है वो लिबास बदलता है, जो पसीने से नहाता है वो इतिहास बदलता है!',
      'कल का दिन आपका होगा, अगर आज आपने पूरी लगन से मेहनत की होगी।'
    ];
    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];

    const cardMsg = 
`╭───────────────✦───────────────╮
│ 📊 <b>ᴅᴀɪʟʏ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ʀᴇᴘᴏʀᴛ</b>
╰───────────────✦───────────────╯
📅 <b>Date:</b> <code>${displayDate}</code> • ⏰ <code>${nowKolkata.toFormat('hh:mm a')}</code>
👥 <b>Total Members:</b> <code>${totalMembersCount}</code>

📈 <b>Attendance Turnout:</b> <code>${turnoutRate}%</code>
<code>[${progressBar}]</code>

┌──────────── <b>Overview</b> ────────────┐
│ ✅ <b>Present:</b> <code>${presentUsers.length} Members</code>
│ 🍂 <b>On Leave:</b> <code>${leaveUsers.length} Members</code>
│ ❌ <b>Absent:</b> <code>${absentUsers.length} Members</code>
└──────────────────────────────────┘

🔥 <b>Top Consistent Champions:</b>
${leaderboardText}

🍂 <b>Approved Leaves:</b>
${leaveText}

⚠️ <b>3+ Days Inactive (Action Needed):</b>
${warningText}

━━━━━━━━━━━━━━━━━━━━━━
💡 <i>"${randomQuote}"</i>`;

    const reportKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Check My Status', 'btn_mystatus')]
    ]);

    await bot.telegram.sendMessage(targetChatId, cardMsg, { parse_mode: 'HTML', ...reportKeyboard });
    console.log('[REPORT] Attractive Report sent successfully.');
  } catch (err) {
    console.error('[REPORT ERROR]:', err);
  }
}

// -------------------------------------------------------------
// Functions: Generate Specific Date & Monthly Summary Reports
// -------------------------------------------------------------
async function getDateAttendanceReport(targetDateStr) {
  try {
    const members = await db.getAllMembers();
    const attendance = await db.getAllAttendance();

    const totalMembersCount = members.length;
    const dayRecords = attendance.filter(r => String(r.date).trim() === targetDateStr);

    if (dayRecords.length === 0) {
      return {
        found: false,
        text: `⚠️ <b>Date: <code>${targetDateStr}</code></b>\n━━━━━━━━━━━━━━━━━━━━━━\nIs tarikh ki koi attendance record database me uplabdh nahi hai.`
      };
    }

    const presentUsers = dayRecords.filter(r => String(r.status || 'Present').trim() === 'Present');
    const leaveUsers = dayRecords.filter(r => String(r.status || '').trim() === 'Leave');

    const presentUserIds = new Set(presentUsers.map(u => String(u.userId)));
    const leaveUserIds = new Set(leaveUsers.map(u => String(u.userId)));
    const absentUsers = members.filter(m => !presentUserIds.has(String(m.userId)) && !leaveUserIds.has(String(m.userId)));

    const turnoutRate = totalMembersCount > 0 ? Math.round((presentUsers.length / totalMembersCount) * 100) : 0;
    const filledBlocks = Math.round((turnoutRate / 100) * 10);
    const emptyBlocks = 10 - filledBlocks;
    const progressBar = '▰'.repeat(filledBlocks) + '▱'.repeat(emptyBlocks);

    let presentListText = presentUsers.length > 0
      ? presentUsers.slice(0, 15).map(u => `• <code>${escapeHTML(u.name || 'Unknown')}</code>`).join('\n')
      : '  <i>Koi present nahi tha</i>';
    if (presentUsers.length > 15) presentListText += `\n• <i>...and ${presentUsers.length - 15} more</i>`;

    let leaveText = leaveUsers.length > 0
      ? leaveUsers.slice(0, 8).map(u => `• <code>${escapeHTML(u.name || 'Unknown')}</code> <i>(${escapeHTML(u.reason || 'Leave')})</i>`).join('\n')
      : '  <i>None</i>';
    if (leaveUsers.length > 8) leaveText += `\n• <i>...and ${leaveUsers.length - 8} more</i>`;

    let absentText = absentUsers.length > 0
      ? absentUsers.slice(0, 10).map(u => `<code>${escapeHTML(u.name || 'Unknown')}</code>`).join(', ')
      : '  <i>Sabhi present the!</i>';
    if (absentUsers.length > 10) absentText += `, ...and ${absentUsers.length - 10} more`;

    const card = 
`╭───────────────✦───────────────╮
│ 📜 <b>ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ʀᴇᴘᴏʀᴛ (${targetDateStr})</b>
╰───────────────✦───────────────╯
📅 <b>Target Date:</b> <code>${targetDateStr}</code>
👥 <b>Total Members:</b> <code>${totalMembersCount}</code>

📈 <b>Attendance Turnout:</b> <code>${turnoutRate}%</code>
<code>[${progressBar}]</code>

┌──────────── <b>Overview</b> ────────────┐
│ ✅ <b>Present:</b> <code>${presentUsers.length} Members</code>
│ 🍂 <b>On Leave:</b> <code>${leaveUsers.length} Members</code>
│ ❌ <b>Absent:</b> <code>${absentUsers.length} Members</code>
└──────────────────────────────────┘

✅ <b>Present Members:</b>
${presentListText}

🍂 <b>Leave Records:</b>
${leaveText}

❌ <b>Absent Members:</b>
${absentText}`;

    return { found: true, text: card };
  } catch (err) {
    console.error('[GET_DATE_REPORT ERROR]:', err);
    return { found: false, text: '⚠️ Error generating date report.' };
  }
}

async function getMonthlySummaryText(monthYear) {
  try {
    const allAttendance = await db.getAllAttendance();
    const allMembers = await db.getAllMembers();

    const monthRecords = allAttendance.filter(r => {
      if (!r.date) return false;
      const parts = String(r.date).trim().split('-');
      if (parts.length === 3) {
        return `${parts[1]}-${parts[2]}` === monthYear;
      }
      return false;
    });

    const uniqueDates = [...new Set(monthRecords.map(r => r.date))];
    const totalDays = uniqueDates.length;

    if (totalDays === 0) {
      return `⚠️ <b>Month: <code>${monthYear}</code></b>\n━━━━━━━━━━━━━━━━━━━━━━\nIs mahine ka koi attendance data database me record nahi mila.`;
    }

    const memberStats = allMembers.map(m => {
      const uId = String(m.userId);
      const mRecords = monthRecords.filter(r => String(r.userId) === uId);
      const presents = mRecords.filter(r => String(r.status || 'Present').trim() === 'Present').length;
      const leaves = mRecords.filter(r => String(r.status || '').trim() === 'Leave').length;
      const absents = Math.max(0, totalDays - (presents + leaves));
      const rate = totalDays > 0 ? Math.round((presents / totalDays) * 100) : 0;
      return {
        userId: uId,
        name: m.name || 'Unknown',
        presents,
        leaves,
        absents,
        rate
      };
    });

    memberStats.sort((a, b) => b.presents - a.presents || b.rate - a.rate);

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const topList = memberStats.slice(0, 10).map((st, idx) => {
      const icon = medals[idx] || '•';
      return `${icon} <code>${escapeHTML(st.name)}</code> ➔ <b>${st.presents}/${totalDays} Days</b> (${st.rate}%)`;
    }).join('\n');

    const totalPresentCount = monthRecords.filter(r => String(r.status || 'Present').trim() === 'Present').length;
    const totalPossible = totalDays * allMembers.length;
    const overallAvg = totalPossible > 0 ? Math.round((totalPresentCount / totalPossible) * 100) : 0;

    return `╭───────────────✦───────────────╮
│ 🗓️ <b>ᴍᴏɴᴛʜʟʏ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ꜱᴜᴍᴍᴀʀʏ</b>
╰───────────────✦───────────────╯
📅 <b>Month:</b> <code>${monthYear}</code>
👥 <b>Total Registered Members:</b> <code>${allMembers.length}</code>
📆 <b>Total Recorded Days:</b> <code>${totalDays} Days</code>
📈 <b>Group Overall Turnout:</b> <code>${overallAvg}%</code>

🏆 <b>TOP PERFORMERS (Attendance Champions):</b>
${topList}

━━━━━━━━━━━━━━━━━━━━━━
💡 <i>Poore mahine ki detailed sheet download karne ke liye <b>Monthly Excel Sheet</b> button dabayein!</i>`;
  } catch (err) {
    console.error('[MONTHLY_SUMMARY ERROR]:', err);
    return '⚠️ Error generating monthly summary.';
  }
}

async function getDefaultersList() {
  try {
    const members = await db.getAllMembers();
    const attendance = await db.getAllAttendance();

    // Unique dates recorded, sorted descending
    const uniqueDates = [...new Set(attendance.map(r => String(r.date).trim()))].filter(Boolean);
    uniqueDates.sort((a, b) => {
      const dtA = DateTime.fromFormat(a, 'dd-MM-yyyy');
      const dtB = DateTime.fromFormat(b, 'dd-MM-yyyy');
      return dtB.toMillis() - dtA.toMillis();
    });

    const defaulters = [];

    for (const member of members) {
      const uId = String(member.userId);
      const memberRecords = attendance.filter(r => String(r.userId) === uId);

      let consecutiveAbsent = 0;
      for (const dStr of uniqueDates) {
        const rec = memberRecords.find(r => String(r.date).trim() === dStr);
        if (rec && (rec.status === 'Present' || rec.status === 'Leave')) {
          break; // Member attended or took leave, break streak
        } else {
          consecutiveAbsent++;
        }
      }

      if (consecutiveAbsent >= 3) {
        defaulters.push({
          userId: uId,
          name: member.name || 'Unknown',
          username: member.username ? `@${member.username}` : '',
          days: consecutiveAbsent
        });
      }
    }

    defaulters.sort((a, b) => b.days - a.days);
    return defaulters;
  } catch (err) {
    console.error('[DEFAULTERS ERROR]:', err);
    return [];
  }
}

// -------------------------------------------------------------
// 2. Cron Job: 9:00 PM Daily Attendance Report Summary
// -------------------------------------------------------------
cron.schedule('0 21 * * *', async () => {
  // Agar Holiday hai, Attendance OFF hai, ya Server Down hai -> Group me Night Report NAHI jayegi
  if (isHolidayToday()) {
    console.log('[CRON] 9:00 PM: Holiday active, skipping night report.');
    setHolidayState(false, ''); // Agle din ke liye auto-reset
    return;
  }

  if (!getAttendanceState()) {
    console.log('[CRON] 9:00 PM: Attendance OFF thi, skipping night report.');
    return;
  }

  if (getMaintenanceState()) {
    console.log('[CRON] 9:00 PM: Server Down active, skipping night report.');
    return;
  }

  await sendDailyAttendanceReport(GROUP_CHAT_ID);
}, { timezone: 'Asia/Kolkata' });

// -------------------------------------------------------------
// 👑 ADMIN COMMAND: /admin (Opens Interactive Dashboard in DM)
// -------------------------------------------------------------
bot.hears(/^\/admin(@\w+)?$/i, async (ctx) => {
  if (ctx.chat.type !== 'private') {
    if (ctx.message) ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    return;
  }

  if (!checkIsAdmin(ctx)) return;

  await ctx.reply(getAdminDashboardText(), { parse_mode: 'HTML', ...getAdminKeyboard() });
});

// -------------------------------------------------------------
// 👑 ADMIN DASHBOARD ACTIONS (Inline Buttons Handler)
// -------------------------------------------------------------
bot.action('adm_toggle_att', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  const current = getAttendanceState();
  setAttendanceState(!current);
  const statusStr = !current ? '🟢 Attendance chalu (ON) kar di gayi!' : '🔴 Attendance band (OFF) kar di gayi!';
  await ctx.answerCbQuery(statusStr, { show_alert: true });

  try {
    await ctx.editMessageText(getAdminDashboardText(), { parse_mode: 'HTML', ...getAdminKeyboard() });
  } catch (e) {}
});

// 1. Holiday Handlers (Separate Dedicated Actions for Cancel and Declare)
async function doCancelHoliday(ctx) {
  waitingAdminHolidayReason = false;
  if (holidayPromptMsgId) {
    ctx.deleteMessage(holidayPromptMsgId).catch(() => {});
    holidayPromptMsgId = null;
  }
  setHolidayState(false, '');
  await ctx.answerCbQuery('☀️ Holiday Cancelled! Normal mode restored.', { show_alert: true });

  const cancelNotice = `☀️ <b>HOLIDAY CANCELLED!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📢 <i>Admin Mahi dwara Holiday cancel kar di gayi hai. Attendance system normal live hai!</i> 🌸`;
  await bot.telegram.sendMessage(GROUP_CHAT_ID, cancelNotice, { parse_mode: 'HTML' }).catch(() => {});

  try {
    await ctx.editMessageText(getAdminDashboardText(), { parse_mode: 'HTML', ...getAdminKeyboard() });
  } catch (e) {}
}

async function doPromptHoliday(ctx) {
  waitingAdminHolidayReason = true;
  await ctx.answerCbQuery();

  const cancelPromptKb = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Request', 'adm_cancel_holiday_prompt')]
  ]);

  const prompt = await ctx.reply(
    `🏖️ <b>DECLARE HOLIDAY (CHHUTTI):</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📝 <b>Admin Mahi, kripya chhutti ka Reason (karan) likh kar bhejein:</b>\n<i>(Jaise: Diwali Celebration, Sunday Rest, Technical Work, etc.)</i>\n\nAapke reason likhte hi <b>turant Group me notice chala jayega!</b>`,
    { parse_mode: 'HTML', ...cancelPromptKb }
  );
  holidayPromptMsgId = prompt.message_id;
}

bot.action('adm_cancel_holiday', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });
  await doCancelHoliday(ctx);
});

bot.action('adm_declare_holiday', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });
  await doPromptHoliday(ctx);
});

bot.action('adm_toggle_holiday', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });
  if (isHolidayToday()) {
    await doCancelHoliday(ctx);
  } else {
    await doPromptHoliday(ctx);
  }
});

bot.action('adm_cancel_holiday_prompt', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });
  waitingAdminHolidayReason = false;
  holidayPromptMsgId = null;
  await ctx.answerCbQuery('❌ Holiday request cancel kar di gayi.');
  try {
    await ctx.deleteMessage();
  } catch (e) {}
});

// 2. Server Down Button: Notifies Group & Toggles Maintenance
bot.action('adm_toggle_maint', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  const current = getMaintenanceState();
  setMaintenanceState(!current);

  if (!current) {
    // Maintenance Mode ON -> Group me notice bhejein
    await ctx.answerCbQuery('🛠️ Server Maintenance Mode Activated!', { show_alert: true });
    const downNotice = `⚠️ <b>SERVER MAINTENANCE NOTICE</b>\n━━━━━━━━━━━━━━━━━━━━━━\n👩‍💻 <b>Admin Mahi is currently working on Data Server.</b>\n⚙️ <i>Bot functions are temporarily paused to protect attendance records.\nServices will resume shortly. Thank you for your patience!</i> 🌸`;
    await bot.telegram.sendMessage(GROUP_CHAT_ID, downNotice, { parse_mode: 'HTML' }).catch(() => {});
  } else {
    // Maintenance Mode OFF -> Group me live notice bhejein
    await ctx.answerCbQuery('🚀 Server Live (Normal Mode) restored!', { show_alert: true });
    const upNotice = `🚀 <b>SERVER RESTORED! LIVE NOW</b>\n━━━━━━━━━━━━━━━━━━━━━━\n✅ <i>Data server maintenance complete ho chuki hai. Services wapas normal live hain!</i> 🌸`;
    await bot.telegram.sendMessage(GROUP_CHAT_ID, upNotice, { parse_mode: 'HTML' }).catch(() => {});
  }

  try {
    await ctx.editMessageText(getAdminDashboardText(), { parse_mode: 'HTML', ...getAdminKeyboard() });
  } catch (e) {}
});

// 3. Sync Members: Cleans database and posts update in Group
bot.action('adm_sync_members', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  await ctx.answerCbQuery('🔄 Group members sync ho rahe hain...', { show_alert: false });
  try {
    const members = await db.getAllMembers();
    let removedCount = 0;

    for (const m of members) {
      try {
        const chatMember = await ctx.telegram.getChatMember(GROUP_CHAT_ID, m.userId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          await db.removeMember(m.userId);
          removedCount++;
        }
      } catch (err) {
        await db.removeMember(m.userId);
        removedCount++;
      }
    }

    // Admin DM reply
    await ctx.reply(`✅ <b>Sync Completed!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🧹 <code>${removedCount}</code> left members database se remove kar diye gaye hain.`, { parse_mode: 'HTML' });

    // Group me 15 second ke liye notice bhejein
    const groupNotice = await bot.telegram.sendMessage(
      GROUP_CHAT_ID,
      `🔄 <b>DATABASE SYNC COMPLETED</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🧹 <code>${removedCount}</code> inactive/left members ko database se clean kar diya gaya hai. ✅`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    if (groupNotice) {
      setTimeout(() => {
        bot.telegram.deleteMessage(GROUP_CHAT_ID, groupNotice.message_id).catch(() => {});
      }, 15000);
    }

  } catch (err) {
    console.error('[SYNC ERROR]:', err);
    ctx.reply('⚠️ Sync karte waqt error aaya.').catch(() => {});
  }
});

// 4. Test Report: Asks Admin (DM me ya Group me?)
bot.action('adm_test_report', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  await ctx.answerCbQuery();
  const testChoiceKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('👤 Sirf Yahan (DM me)', 'adm_send_test_dm'),
      Markup.button.callback('👥 Group me Bhejein', 'adm_send_test_group')
    ],
    [
      Markup.button.callback('❌ Cancel', 'adm_cancel_test_choice')
    ]
  ]);

  await ctx.reply(
    `📊 <b>TEST NIGHT REPORT:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n❓ <i>Aap report kahan send karna chahte hain?</i>`,
    { parse_mode: 'HTML', ...testChoiceKeyboard }
  );
});

bot.action('adm_send_test_dm', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });
  await ctx.answerCbQuery('📊 Sending to your DM...');
  try {
    await ctx.deleteMessage();
    await sendDailyAttendanceReport(ctx.chat.id);
  } catch (e) {}
});

bot.action('adm_send_test_group', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });
  await ctx.answerCbQuery('📊 Sending to Group...');
  try {
    await ctx.deleteMessage();
    await sendDailyAttendanceReport(GROUP_CHAT_ID);
    await ctx.reply('✅ <b>Test Report Group me successfully send kar di gayi hai!</b>', { parse_mode: 'HTML' });
  } catch (e) {}
});

bot.action('adm_cancel_test_choice', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (e) {}
});

bot.action('adm_export_csv', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  await ctx.answerCbQuery('⏳ CSV Sheet generate ho rahi hai...', { show_alert: false });
  try {
    const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    const filePath = await db.generateCSVFilePath();
    const allAttendance = await db.getAllAttendance();

    await ctx.replyWithDocument({ source: filePath, filename: `attendance_${today}.csv` }, {
      caption: `📁 <b>Admin Export (Excel/CSV)</b>\n📅 Generated on: <code>${today}</code>\nTotal Records: <code>${allAttendance.length}</code>`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('[CSV EXPORT ERROR]:', err);
    ctx.reply('⚠️ CSV export fail ho gaya.').catch(() => {});
  }
});

bot.action('adm_refresh', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  await ctx.answerCbQuery('🔄 Status updated!', { show_alert: false });
  try {
    await ctx.editMessageText(getAdminDashboardText(), { parse_mode: 'HTML', ...getAdminKeyboard() });
  } catch (e) {}
});

// 5. Past & Monthly Reports Menu
bot.action('adm_past_reports', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  await ctx.answerCbQuery();
  const menuText = `🗓️ <b>PAST & MONTHLY ATTENDANCE REPORTS</b>\n━━━━━━━━━━━━━━━━━━━━━━\n👤 <b>Admin Mahi</b>, aap kaunsi report dekhna chahte hain?\n\n• <b>Kal ki Report:</b> Yesterday ka complete overview\n• <b>Is Mahine Summary:</b> Current month rank wise performance\n• <b>Monthly Excel:</b> Poore mahine ki detailed sheet\n• <b>Kisi Date ki:</b> Apni marzi se koi bhi purani date check karein`;

  try {
    await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...getReportsKeyboard() });
  } catch (e) {
    await ctx.reply(menuText, { parse_mode: 'HTML', ...getReportsKeyboard() });
  }
});

bot.action('adm_rep_yesterday', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  const yesterday = DateTime.now().setZone('Asia/Kolkata').minus({ days: 1 }).toFormat('dd-MM-yyyy');
  await ctx.answerCbQuery('⏳ Kal ki report load ho rahi hai...');
  const rep = await getDateAttendanceReport(yesterday);
  await ctx.reply(rep.text, { parse_mode: 'HTML' });
});

bot.action('adm_rep_month_card', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  const currMonth = DateTime.now().setZone('Asia/Kolkata').toFormat('MM-yyyy');
  await ctx.answerCbQuery('⏳ Monthly summary load ho rahi hai...');
  const summaryText = await getMonthlySummaryText(currMonth);
  await ctx.reply(summaryText, { parse_mode: 'HTML' });
});

bot.action('adm_rep_month_csv', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  const currMonth = DateTime.now().setZone('Asia/Kolkata').toFormat('MM-yyyy');
  await ctx.answerCbQuery('⏳ Monthly Excel generate ho rahi hai...', { show_alert: false });
  try {
    const res = await db.generateMonthlyCSVFilePath(currMonth);
    await ctx.replyWithDocument({ source: res.filePath, filename: `monthly_attendance_${currMonth}.csv` }, {
      caption: `📁 <b>Monthly Attendance Excel Sheet (${currMonth})</b>\n👥 Total Members: <code>${res.memberCount}</code>\n📆 Recorded Days: <code>${res.totalDays}</code>`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('[MONTHLY CSV ERR]:', err);
    ctx.reply('⚠️ Monthly CSV generate karne me error aaya.').catch(() => {});
  }
});

bot.action('adm_rep_custom_date', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  waitingAdminReportDate = true;
  await ctx.answerCbQuery();

  const cancelPromptKb = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Request', 'adm_cancel_date_prompt')]
  ]);

  const prompt = await ctx.reply(
    `📅 <b>KISI BHI DATE KI REPORT:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📝 <b>Admin Mahi, kripya Date likh kar bhejein:</b>\n(Format: <code>DD-MM-YYYY</code>, jaise: <code>07-11-2026</code>)`,
    { parse_mode: 'HTML', ...cancelPromptKb }
  );
  datePromptMsgId = prompt.message_id;
});

bot.action('adm_cancel_date_prompt', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });
  waitingAdminReportDate = false;
  datePromptMsgId = null;
  await ctx.answerCbQuery('❌ Date check cancel kar diya gaya.');
  try {
    await ctx.deleteMessage();
  } catch (e) {}
});

// 6. Defaulters List Actions
bot.action('adm_defaulters_list', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  await ctx.answerCbQuery('🔍 Defaulters check ho rahe hain...');
  const defaulters = await getDefaultersList();

  if (defaulters.length === 0) {
    return ctx.reply('✅ <b>Koi Defaulter Nahi Hai!</b>\n━━━━━━━━━━━━━━━━━━━━━━\nGroup ke sabhi members active hain ya lagatar 3 din se koi absent nahi hai. 🌸', { parse_mode: 'HTML' });
  }

  let listText = defaulters.map((d, idx) => {
    const uText = d.username ? ` (${escapeHTML(d.username)})` : '';
    return `${idx + 1}. ⚠️ <code>${escapeHTML(d.name)}</code>${uText} ➔ <b>${d.days} Din se Absent</b>`;
  }).join('\n');

  const text = `🚨 <b>DEFAULTERS LIST (LAGATAR ABSENT)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ <i>Niche diye gaye members lagatar 3 ya usse jyada dino se bina leave ke Absent hain:</i>\n\n${listText}\n\n👥 <b>Total Defaulters:</b> <code>${defaulters.length} Members</code>\n━━━━━━━━━━━━━━━━━━━━━━\n❓ <i>Kya aap Group me in sabhi ko official Warning Card bhejna chahte hain?</i>`;

  const warningChoiceKb = Markup.inlineKeyboard([
    [
      Markup.button.callback('📢 Group me Warning Card Bhejein', 'adm_send_defaulters_warning')
    ],
    [
      Markup.button.callback('❌ Cancel', 'adm_cancel_defaulters')
    ]
  ]);

  await ctx.reply(text, { parse_mode: 'HTML', ...warningChoiceKb });
});

bot.action('adm_send_defaulters_warning', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery('⛔ Not authorized.', { show_alert: true });

  await ctx.answerCbQuery('📢 Group me warning notice bhej rahe hain...');
  const defaulters = await getDefaultersList();

  if (defaulters.length === 0) {
    return ctx.reply('Abhi koi defaulter nahi mila.');
  }

  let listText = defaulters.map(d => {
    const uText = d.username ? ` (${escapeHTML(d.username)})` : '';
    return `• ⚠️ <b>${escapeHTML(d.name)}</b>${uText} ➔ <code>${d.days} Din se Inactive!</code>`;
  }).join('\n');

  const warningCard = 
`╭───────────────✦───────────────╮
│ ⚠️ <b>OFFICIAL ATTENDANCE WARNING</b> ⚠️
╰───────────────✦───────────────╯
📢 <b>Dhyan dein sabhi members!</b>
Niche diye gaye members lagatar <b>3 ya usse jyada dino se</b> bina kisi leave ya reason ke Absent hain:

${listText}

━━━━━━━━━━━━━━━━━━━━━━
📌 <b>Strict Warning:</b>
Lagatar bina bataye absent rehne se aapki attendance rate gir rahi hai.
Kripya daily <b>06:00 AM – 11:30 AM</b> ke beech apni attendance zaroor lagayein, ya agar koi samasya hai toh <b>Take Leave</b> karein! 🌸`;

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  await bot.telegram.sendMessage(GROUP_CHAT_ID, warningCard, { parse_mode: 'HTML' }).catch(() => {});
  await ctx.reply('✅ <b>Warning Card Group me successfully post kar diya gaya hai!</b>', { parse_mode: 'HTML' });
});

bot.action('adm_cancel_defaulters', async (ctx) => {
  if (!checkIsAdmin(ctx)) return ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (e) {}
});

// -------------------------------------------------------------
// 👑 ADMIN DIRECT TEXT COMMANDS (Only for Admin)
// -------------------------------------------------------------
bot.hears(/^\/attendanceon(@\w+)?$/i, async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!checkIsAdmin(ctx)) return;
  setAttendanceState(true);
  await ctx.reply('🟢 <b>Attendance is now turned ON!</b>', { parse_mode: 'HTML' });
});

bot.hears(/^\/attendanceoff(@\w+)?$/i, async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!checkIsAdmin(ctx)) return;
  setAttendanceState(false);
  await ctx.reply('🔴 <b>Attendance is now turned OFF!</b>', { parse_mode: 'HTML' });
});

bot.hears(/^\/holiday(@\w+)?( .*)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;

  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const reason = args || 'Official Holiday';
  setHolidayState(true, reason);

  // Group me Sundar Announcement Notice bhejein
  const groupNotice = `🌸 <b>ʀᴀᴅʜᴇ ʀᴀᴅʜᴇ! ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʏᴏᴜ ᴀʟʟ☀️</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🏖️ <b>OFFICIAL HOLIDAY NOTICE</b> 🎉\n\n📢 <b>Aaj Chhutti (Holiday) ghoshit ki gayi hai!</b>\n📌 <b>Reason:</b> <i>${escapeHTML(reason)}</i>\n━━━━━━━━━━━━━━━━━━━━━━\n✨ Aaj daily attendance band rahegi. Kisi ka Absent mark nahi hoga. Sabhi log enjoy karein! 💗`;
  await bot.telegram.sendMessage(GROUP_CHAT_ID, groupNotice, { parse_mode: 'HTML' }).catch(() => {});

  // Active attendance buttons group se turant hata dein
  const idsToDelete = [...new Set([...activeAttendanceMessageIds, ...getStoredMessageIds()])];
  for (const msgId of idsToDelete) {
    await bot.telegram.deleteMessage(GROUP_CHAT_ID, msgId).catch(() => {});
  }
  activeAttendanceMessageIds = [];
  saveStoredMessageIds([]);

  if (ctx.chat.type === 'private') {
    await ctx.reply(`🏖️ <b>Holiday Declared for Today!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📌 <b>Reason:</b> <i>${escapeHTML(reason)}</i>\n📢 <b>Group me Notice successfully bhej diya gaya hai!</b>\n✨ <i>Subah buttons nahi aayenge aur raat ko koi Absent mark nahi hoga.</i>`, { parse_mode: 'HTML' });
  } else {
    setTimeout(() => {
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    }, 1000);
  }
});

bot.hears(/^\/(holidayoff|cancelholiday)(@\w+)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  setHolidayState(false, '');

  const cancelNotice = `☀️ <b>HOLIDAY CANCELLED!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📢 <i>Admin Mahi dwara Holiday cancel kar di gayi hai. Attendance system normal live hai!</i> 🌸`;
  await bot.telegram.sendMessage(GROUP_CHAT_ID, cancelNotice, { parse_mode: 'HTML' }).catch(() => {});

  if (ctx.chat.type === 'private') {
    await ctx.reply('☀️ <b>Holiday hatakar normal day restore kar diya gaya hai! Group me notice bhej diya gaya.</b>', { parse_mode: 'HTML' });
  }
});

bot.hears(/^\/serverdown(@\w+)?$/i, async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!checkIsAdmin(ctx)) return;
  setMaintenanceState(true);
  const downNotice = `⚠️ <b>SERVER MAINTENANCE NOTICE</b>\n━━━━━━━━━━━━━━━━━━━━━━\n👩‍💻 <b>Admin Mahi is currently working on Data Server.</b>\n⚙️ <i>Bot functions are temporarily paused to protect attendance records.\nServices will resume shortly. Thank you for your patience!</i> 🌸`;
  await bot.telegram.sendMessage(GROUP_CHAT_ID, downNotice, { parse_mode: 'HTML' }).catch(() => {});
  await ctx.reply('🛠️ <b>Server Maintenance Mode Activated!</b>\nGroup members ko maintenance notice bhej diya gaya.', { parse_mode: 'HTML' });
});

bot.hears(/^\/serverup(@\w+)?$/i, async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!checkIsAdmin(ctx)) return;
  setMaintenanceState(false);
  const upNotice = `🚀 <b>SERVER RESTORED! LIVE NOW</b>\n━━━━━━━━━━━━━━━━━━━━━━\n✅ <i>Data server maintenance complete ho chuki hai. Services wapas normal live hain!</i> 🌸`;
  await bot.telegram.sendMessage(GROUP_CHAT_ID, upNotice, { parse_mode: 'HTML' }).catch(() => {});
  await ctx.reply('🚀 <b>Server Live! Normal Mode Restored.</b>\nGroup me restore notice bhej diya gaya.', { parse_mode: 'HTML' });
});

bot.hears(/^\/testreport(@\w+)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  if (ctx.message && ctx.message.message_id) {
    setTimeout(() => {
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    }, 500);
  }
  await sendDailyAttendanceReport(ctx.chat.id);
});

bot.hears(/^\/syncmembers(@\w+)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  const userMsgId = ctx.message ? ctx.message.message_id : null;
  try {
    const waitMsg = await ctx.reply('⏳ Checking & syncing group members with Telegram...');
    const members = await db.getAllMembers();
    let removedCount = 0;

    for (const m of members) {
      try {
        const chatMember = await ctx.telegram.getChatMember(GROUP_CHAT_ID, m.userId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          await db.removeMember(m.userId);
          removedCount++;
        }
      } catch (err) {
        await db.removeMember(m.userId);
        removedCount++;
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      null,
      `✅ <b>Sync Completed!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🧹 <code>${removedCount}</code> left members database se remove kar diye gaye hain. Ab attendance report bilkul accurate rahegi!`,
      { parse_mode: 'HTML' }
    );

    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
      if (userMsgId) ctx.telegram.deleteMessage(ctx.chat.id, userMsgId).catch(() => {});
    }, 10000);

  } catch (err) {
    console.error('[SYNCMEMBERS ERROR]:', err);
    ctx.reply('⚠️ Error syncing members.').catch(() => {});
  }
});

bot.hears(/^\/(csv|cvc|export)(@\w+)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  const userMessageId = ctx.message ? ctx.message.message_id : null;
  try {
    const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    const filePath = await db.generateCSVFilePath();
    const allAttendance = await db.getAllAttendance();

    await ctx.replyWithDocument({ source: filePath, filename: `attendance_${today}.csv` }, {
      caption: `📁 <b>Attendance CSV File (${today})</b>\nTotal Records: <code>${allAttendance.length}</code>`,
      parse_mode: 'HTML'
    });

    if (userMessageId) {
      setTimeout(() => {
        ctx.deleteMessage(userMessageId).catch(() => {});
      }, 500);
    }
  } catch (err) {
    console.error('[COMMAND ERROR] /csv:', err);
    ctx.reply('⚠️ Failed to generate CSV file.').catch(() => {});
  }
});

bot.hears(/^\/report(@\w+)?( .*)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  const userMessageId = ctx.message ? ctx.message.message_id : null;
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

  let targetDate = '';
  if (!args || args.toLowerCase() === 'yesterday' || args.toLowerCase() === 'kal') {
    targetDate = DateTime.now().setZone('Asia/Kolkata').minus({ days: 1 }).toFormat('dd-MM-yyyy');
  } else {
    targetDate = args;
  }

  const rep = await getDateAttendanceReport(targetDate);
  await ctx.reply(rep.text, { parse_mode: 'HTML' });
  if (userMessageId && ctx.chat.type !== 'private') {
    setTimeout(() => { ctx.deleteMessage(userMessageId).catch(() => {}); }, 1000);
  }
});

bot.hears(/^\/month(ly)?(@\w+)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  const currMonth = DateTime.now().setZone('Asia/Kolkata').toFormat('MM-yyyy');
  const summaryText = await getMonthlySummaryText(currMonth);
  await ctx.reply(summaryText, { parse_mode: 'HTML' });
});

bot.hears(/^\/monthcsv(@\w+)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  const currMonth = DateTime.now().setZone('Asia/Kolkata').toFormat('MM-yyyy');
  try {
    const res = await db.generateMonthlyCSVFilePath(currMonth);
    await ctx.replyWithDocument({ source: res.filePath, filename: `monthly_attendance_${currMonth}.csv` }, {
      caption: `📁 <b>Monthly Attendance Excel Sheet (${currMonth})</b>\n👥 Total Members: <code>${res.memberCount}</code>\n📆 Recorded Days: <code>${res.totalDays}</code>`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('[MONTHLY CSV ERR]:', err);
    ctx.reply('⚠️ Failed to generate monthly CSV.').catch(() => {});
  }
});

bot.hears(/^\/(defaulters|inactive)(@\w+)?$/i, async (ctx) => {
  if (!checkIsAdmin(ctx)) return;
  const defaulters = await getDefaultersList();

  if (defaulters.length === 0) {
    return ctx.reply('✅ <b>Koi Defaulter Nahi Hai!</b>\n━━━━━━━━━━━━━━━━━━━━━━\nGroup ke sabhi members active hain ya 3 din se lagatar koi absent nahi hai. 🌸', { parse_mode: 'HTML' });
  }

  let listText = defaulters.map((d, idx) => {
    const uText = d.username ? ` (${escapeHTML(d.username)})` : '';
    return `${idx + 1}. ⚠️ <code>${escapeHTML(d.name)}</code>${uText} ➔ <b>${d.days} Din se Absent</b>`;
  }).join('\n');

  const text = `🚨 <b>DEFAULTERS LIST (LAGATAR ABSENT)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n${listText}\n\n👥 <b>Total Defaulters:</b> <code>${defaulters.length} Members</code>`;
  await ctx.reply(text, { parse_mode: 'HTML' });
});

// -------------------------------------------------------------
// 3. Command: /admission form
// -------------------------------------------------------------
bot.hears(/^\/[Aa]dmission ?[Ff]orm$/, async (ctx) => {
  try {
    const text = `📄 Admission Form\n\n🔗 https://admissionverify.infinityfreeapp.com/\n\nPlease fill the form carefully. ✅`;
    await ctx.reply(text);
  } catch (err) {
    console.error('[COMMAND ERROR] Admission Form:', err);
  }
});

// -------------------------------------------------------------
// 4. Command: /mystatus
// -------------------------------------------------------------
bot.hears(/^\/mystatus(@\w+)?$/, async (ctx) => {
  const userId = String(ctx.from.id);
  const name = escapeHTML(ctx.from.first_name || 'Unknown');
  const userMessageId = ctx.message.message_id;

  try {
    const allRows = await db.getAllAttendance();
    const userRows = allRows.filter(r => String(r.userId) === userId);
    const presentCount = userRows.filter(r => String(r.status || 'Present').trim() === 'Present').length;
    const leaveCount = userRows.filter(r => String(r.status || '').trim() === 'Leave').length;
    const totalLogs = userRows.length;
    const attendanceRate = totalLogs > 0 ? Math.round((presentCount / totalLogs) * 100) : 0;

    const todayStr = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    const streakCount = calculateWorkingDayStreak(userId, allRows, todayStr);
    const badge = getStreakBadge(streakCount);

    const text = `<b>📊 ATTENDANCE SUMMARY: ${name}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📅 <b>Total Logs:</b> <code>${totalLogs}</code>\n✅ <b>Present Days:</b> <code>${presentCount}</code>\n🍂 <b>Leave Days:</b> <code>${leaveCount}</code>\n📈 <b>Attendance Rate:</b> <code>${attendanceRate}%</code>\n🔥 <b>Current Streak:</b> <code>${streakCount} Days${badge}</code>`;

    const statusMsg = await ctx.reply(text, { parse_mode: 'HTML' });

    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
    }, 500);

    setTimeout(() => {
      ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    }, 60000);

  } catch (err) {
    console.error('[COMMAND ERROR] /mystatus:', err);
  }
});

// -------------------------------------------------------------
// 4.5 Command: /attendance (or /panel, /menu) - Opens Button Menu
// -------------------------------------------------------------
bot.hears(/^\/(attendance|panel|menu)(@\w+)?$/i, async (ctx) => {
  try {
    const nowKolkata = DateTime.now().setZone('Asia/Kolkata');
    if (!isAttendanceOpen(nowKolkata)) {
      const closed = await ctx.reply(`❌ Attendance closed hai!\n⏰ Timing: ${TIMING_TEXT}`);
      setTimeout(() => {
        ctx.deleteMessage(closed.message_id).catch(() => {});
        if (ctx.message && ctx.message.message_id) ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      }, 10000);
      return;
    }

    const text = `🌸 ʀᴀᴅʜᴇ ʀᴀᴅʜᴇ! ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʏᴏᴜ ᴀʟʟ☀️\n💗 ᴅᴀɪʟʏ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ɪꜱ ɴᴏᴡ ᴏᴘᴇɴ\n⏰ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴛɪᴍɪɴɢ\n🕕 <b>06:00 AM – 11:30 AM (IST)</b>\n📌 ᴀᴘɴɪ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴍᴀʀᴋ ᴋᴀʀɴᴇ ᴋᴇ ʟɪʏᴇ ɴɪᴄʜᴇ ᴅɪʏᴇ ɢᴀʏᴇ ʙᴜᴛᴛᴏNꜱ ᴘᴀʀ ᴄʟɪᴄᴋ ᴋᴀʀᴇɴ. 💗`;
    const panelMsg = await ctx.reply(text, { parse_mode: 'HTML', ...getAttendanceKeyboard() });
    
    activeAttendanceMessageIds.push(panelMsg.message_id);
    saveStoredMessageIds(activeAttendanceMessageIds);

    if (ctx.message && ctx.message.message_id) {
      setTimeout(() => {
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      }, 500);
    }
  } catch (err) {
    console.error('[COMMAND ERROR] /attendance:', err);
  }
});

// -------------------------------------------------------------
// 5. Button Action: ✅ Mark Present
// -------------------------------------------------------------
bot.action('btn_present', async (ctx) => {
  if (getMaintenanceState()) {
    return ctx.answerCbQuery(MAINTENANCE_POPUP, { show_alert: true });
  }

  if (isHolidayToday()) {
    const hol = getHolidayState();
    return ctx.answerCbQuery(`🏖️ Aaj Holiday hai (${hol.reason || 'Chhutti'})!\nAttendance band hai.`, { show_alert: true });
  }

  if (!getAttendanceState()) {
    return ctx.answerCbQuery('❌ Attendance closed hai aaj ka.', { show_alert: true });
  }

  const nowKolkata = DateTime.now().setZone('Asia/Kolkata');
  const attendanceOpen = isAttendanceOpen(nowKolkata);

  const user = ctx.from;
  const userId = String(user.id);
  const name = user.first_name || 'Unknown';
  const username = user.username || '';
  const today = nowKolkata.toFormat('dd-MM-yyyy');

  if (!attendanceOpen) {
    return ctx.answerCbQuery(`❌ Attendance closed hai!\n⏰ Timing: ${TIMING_TEXT}`, { show_alert: true });
  }

  try {
    const success = await db.addAttendance({
      date: today,
      userId: userId,
      name: name,
      username: username,
      status: 'Present',
      reason: ''
    });

    if (!success) {
      return ctx.answerCbQuery(`✅ ${name}, aapki attendance aaj pehle se lagi hui hai!`, { show_alert: true });
    }

    const allRows = await db.getAllAttendance();
    const streakCount = calculateWorkingDayStreak(userId, allRows, today, true);
    const badge = getStreakBadge(streakCount);

    await ctx.answerCbQuery(`✅ Attendance Marked!\n🔥 ${streakCount}-Day Streak!${badge}`, { show_alert: true });

    const successMsg = await ctx.reply(
      `<b>✅ ${escapeHTML(name)}, attendance marked!</b>\n<code>🔥 ${streakCount}-Day Streak!${badge}</code>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(() => {
      ctx.deleteMessage(successMsg.message_id).catch(() => {});
    }, 20000);
  } catch (err) {
    console.error('[BTN_PRESENT ERROR]:', err);
    ctx.answerCbQuery('⚠️ Error marking attendance.', { show_alert: true }).catch(() => {});
  }
});

// -------------------------------------------------------------
// 6. Button Action: 🍂 Take Leave (Asks for Reason)
// -------------------------------------------------------------
bot.action('btn_leave', async (ctx) => {
  if (getMaintenanceState()) {
    return ctx.answerCbQuery(MAINTENANCE_POPUP, { show_alert: true });
  }

  if (isHolidayToday()) {
    return ctx.answerCbQuery('🏖️ Aaj Holiday hai! Leave lagane ki zaroorat nahi.', { show_alert: true });
  }

  if (!getAttendanceState()) {
    return ctx.answerCbQuery('❌ Attendance closed hai aaj ka.', { show_alert: true });
  }

  const nowKolkata = DateTime.now().setZone('Asia/Kolkata');
  const attendanceOpen = isAttendanceOpen(nowKolkata);

  const user = ctx.from;
  const userId = String(user.id);
  const name = user.first_name || 'Unknown';
  const username = user.username || '';
  const today = nowKolkata.toFormat('dd-MM-yyyy');

  if (!attendanceOpen) {
    return ctx.answerCbQuery(`❌ Leave window closed hai!\n⏰ Timing: ${TIMING_TEXT}`, { show_alert: true });
  }

  try {
    const allRows = await db.getAllAttendance();
    const alreadyMarked = allRows.some(r => String(r.userId) === userId && String(r.date).trim() === today);
    if (alreadyMarked) {
      return ctx.answerCbQuery(`✅ ${name}, attendance/leave aaj pehle se register hai!`, { show_alert: true });
    }

    if (pendingLeaveRequests.has(userId)) {
      return ctx.answerCbQuery('⏳ Aapka leave request already pending hai. Kripya reason reply karein!', { show_alert: true });
    }

    await ctx.answerCbQuery('📝 Kripya chat me leave ka reason (karan) likh kar reply karein.', { show_alert: false });

    const chatId = ctx.chat.id;
    const promptText = `🍂 <b>LEAVE REQUEST:</b> <a href="tg://user?id=${userId}">${escapeHTML(name)}</a>\n━━━━━━━━━━━━━━━━━━━━━━\n❓ <b>Aapko Leave kyu chahiye? Kripya apna reason (karan) likh kar bhejein:</b>\n\n<i>⏳ Aapke paas reason likhne ke liye 2 minute hain.\nAgar samay par reason nahi mila to Leave DENIED (reject) kar di jayegi!</i>`;

    const cancelKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel Leave Request', `cancel_leave_${userId}`)]
    ]);

    const promptMsg = await ctx.reply(promptText, {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        ...cancelKeyboard.reply_markup
      }
    });

    const timeout = setTimeout(async () => {
      if (pendingLeaveRequests.has(userId)) {
        pendingLeaveRequests.delete(userId);
        try {
          const deniedNotice = await bot.telegram.sendMessage(
            chatId,
            `❌ <b>LEAVE DENIED (REJECTED):</b> <a href="tg://user?id=${userId}">${escapeHTML(name)}</a>\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ Samay par reason na milne ke karan aapki leave reject kar di gayi hai!`,
            { parse_mode: 'HTML' }
          );

          setTimeout(() => {
            bot.telegram.deleteMessage(chatId, deniedNotice.message_id).catch(() => {});
            bot.telegram.deleteMessage(chatId, promptMsg.message_id).catch(() => {});
          }, 15000);
        } catch (e) {}
      }
    }, 120000);

    pendingLeaveRequests.set(userId, {
      name,
      username,
      chatId,
      promptMsgId: promptMsg.message_id,
      timeout
    });

  } catch (err) {
    console.error('[BTN_LEAVE ERROR]:', err);
    ctx.answerCbQuery('⚠️ Error starting leave request.', { show_alert: true }).catch(() => {});
  }
});

// -------------------------------------------------------------
// Button Action: Cancel Leave Request
// -------------------------------------------------------------
bot.action(/^cancel_leave_(\d+)$/, async (ctx) => {
  const targetUserId = ctx.match[1];
  if (String(ctx.from.id) !== targetUserId) {
    return ctx.answerCbQuery('❌ Yeh aapka leave request nahi hai.', { show_alert: true });
  }

  const pending = pendingLeaveRequests.get(targetUserId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingLeaveRequests.delete(targetUserId);
    await ctx.answerCbQuery('❌ Leave request cancel kar diya gaya.', { show_alert: true });
    try {
      await ctx.deleteMessage();
    } catch (e) {}
  } else {
    await ctx.answerCbQuery('Request pehle hi complete ya expire ho chuki hai.', { show_alert: true });
  }
});

// -------------------------------------------------------------
// Button Action: 📊 My Status
// -------------------------------------------------------------
bot.action('btn_mystatus', async (ctx) => {
  const userId = String(ctx.from.id);
  const name = escapeHTML(ctx.from.first_name || 'Unknown');

  try {
    const allRows = await db.getAllAttendance();
    const userRows = allRows.filter(r => String(r.userId) === userId);
    const presentCount = userRows.filter(r => String(r.status || 'Present').trim() === 'Present').length;
    const leaveCount = userRows.filter(r => String(r.status || '').trim() === 'Leave').length;
    const totalLogs = userRows.length;
    const attendanceRate = totalLogs > 0 ? Math.round((presentCount / totalLogs) * 100) : 0;

    const todayStr = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    const streakCount = calculateWorkingDayStreak(userId, allRows, todayStr);
    const badge = getStreakBadge(streakCount);

    const alertText = `📊 Status for ${name}:\n✅ Present: ${presentCount} | 🍂 Leave: ${leaveCount}\n📈 Rate: ${attendanceRate}%\n🔥 Streak: ${streakCount} Days${badge}`;
    await ctx.answerCbQuery(alertText, { show_alert: true });
  } catch (err) {
    console.error('[BTN_MYSTATUS ERROR]:', err);
    ctx.answerCbQuery('⚠️ Status check failed.', { show_alert: true }).catch(() => {});
  }
});

// -------------------------------------------------------------
// 7. Attendance Handler: /present & /leave
// -------------------------------------------------------------
bot.hears(/^(\/present|\/leave)(@\w+)?( .*)?$/i, async (ctx) => {
  if (ctx.chat.type === 'private') return;

  const nowKolkata = DateTime.now().setZone('Asia/Kolkata');
  const userMessageId = ctx.message.message_id;

  if (getMaintenanceState()) {
    const notice = await ctx.reply(MAINTENANCE_CHAT_NOTICE, { parse_mode: 'HTML' });
    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
      ctx.deleteMessage(notice.message_id).catch(() => {});
    }, 12000);
    return;
  }

  if (isHolidayToday()) {
    const hol = getHolidayState();
    const notice = await ctx.reply(`🏖️ <b>Aaj Holiday hai (${escapeHTML(hol.reason || 'Chhutti')})!</b>\nAttendance band hai.`, { parse_mode: 'HTML' });
    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
      ctx.deleteMessage(notice.message_id).catch(() => {});
    }, 10000);
    return;
  }

  if (!getAttendanceState()) {
    const notice = await ctx.reply('❌ <b>Attendance closed hai aaj ka.</b>', { parse_mode: 'HTML' });
    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
      ctx.deleteMessage(notice.message_id).catch(() => {});
    }, 10000);
    return;
  }

  const attendanceOpen = isAttendanceOpen(nowKolkata);

  const userId = String(ctx.from.id);
  const name = ctx.from.first_name || 'Unknown';
  const username = ctx.from.username || '';
  const userText = ctx.message.text.trim();
  const isPresent = userText.toLowerCase().startsWith('/present');
  const status = isPresent ? 'Present' : 'Leave';
  const reason = !isPresent ? (userText.split(' ').slice(1).join(' ') || 'No reason specified') : '';
  const today = nowKolkata.toFormat('dd-MM-yyyy');

  if (!attendanceOpen) {
    const closedMsgText = `❌ Attendance/Leave is closed for today.\n\n⏰ Attendance timing: ${TIMING_TEXT}\n\nPlease try again tomorrow morning.`;
    const closedMsg = await ctx.reply(closedMsgText);

    setTimeout(() => {
      ctx.deleteMessage(closedMsg.message_id).catch(() => {});
      ctx.deleteMessage(userMessageId).catch(() => {});
    }, 15000);
    return;
  }

  try {
    const success = await db.addAttendance({
      date: today,
      userId: userId,
      name: name,
      username: username,
      status: status,
      reason: reason
    });

    if (!success) {
      const duplicateMsg = await ctx.reply(`<b>✅ ${name}, attendance/leave already marked for today</b>`, { parse_mode: 'HTML' });

      setTimeout(() => {
        ctx.deleteMessage(userMessageId).catch(() => {});
      }, 500);

      setTimeout(() => {
        ctx.deleteMessage(duplicateMsg.message_id).catch(() => {});
      }, 10000);
      return;
    }

    let streakCount = 0;
    let badge = '';
    if (isPresent) {
      const allRows = await db.getAllAttendance();
      streakCount = calculateWorkingDayStreak(userId, allRows, today, true);
      badge = getStreakBadge(streakCount);
    }

    let replyText = isPresent
      ? `<b>✅ ${name}, attendance marked!</b>\n<code>🔥 ${streakCount}-Day Streak!${badge}</code>`
      : `<b>🍂 ${name}, leave registered</b>`;

    const successMsg = await ctx.reply(replyText, { parse_mode: 'HTML' });

    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
    }, 500);

    setTimeout(() => {
      ctx.deleteMessage(successMsg.message_id).catch(() => {});
    }, 30000);

  } catch (err) {
    console.error('[ATTENDANCE ERROR]:', err);
    ctx.reply('⚠️ Error saving attendance.').catch(() => {});
  }
});

// -------------------------------------------------------------
// 8. Bot Initialization & Public Clean Menu Scoping
// -------------------------------------------------------------
bot.launch().then(async () => {
  console.log('🚀 Telegram Attendance Bot (VIP Admin Shield + MongoDB + Clean Menu) is running...');

  try {
    await bot.telegram.setMyCommands([
      { command: 'mystatus', description: '📊 Apni Attendance Summary dekhein' },
      { command: 'admission', description: '📄 Admission Form Link' }
    ]);
  } catch (e) {
    console.error('Menu command setting error:', e);
  }
});

// 🌐 Lightweight HTTP Server for Render Health Check & Port Binding
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Telegram Attendance Bot is running online! 🚀');
});

server.listen(PORT, () => {
  console.log(`🌐 Web server active on port ${PORT} (Render Health Check Ready)`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
