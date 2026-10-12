require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { DateTime } = require('luxon');
const cron = require('node-cron');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN || '8974478810:AAEgxD-ikJrMwV_JSBJY9F45ppBhefoZjtg';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-1003493006883';

// ⏰ ATTENDANCE TIME WINDOW (IST): 06:00 AM – 11:30 AM
const START_HOUR = parseInt(process.env.ATTENDANCE_START_HOUR || '6');
const START_MINUTE = parseInt(process.env.ATTENDANCE_START_MINUTE || '0');
const END_HOUR = parseInt(process.env.ATTENDANCE_END_HOUR || '11');
const END_MINUTE = parseInt(process.env.ATTENDANCE_END_MINUTE || '30');
const TIMING_TEXT = '06:00 AM – 11:30 AM (IST)';

function isAttendanceOpen(dt) {
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

// Pending Leave Requests in memory (userId -> { name, username, chatId, promptMsgId, timeout })
const pendingLeaveRequests = new Map();

// Auto-register members & intercept Leave Reason replies
bot.use(async (ctx, next) => {
  if (ctx.from) {
    db.registerMember(ctx.from.id, ctx.from.first_name, ctx.from.username).catch(() => {});
  }

  // Check if this message is a response to a pending Leave request
  if (ctx.message && ctx.message.text && ctx.from) {
    const userId = String(ctx.from.id);
    if (pendingLeaveRequests.has(userId)) {
      const pending = pendingLeaveRequests.get(userId);
      const userText = ctx.message.text.trim();

      // If user typed a command instead, let the command handler handle it
      if (!userText.startsWith('/')) {
        clearTimeout(pending.timeout);
        pendingLeaveRequests.delete(userId);

        const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');

        // Check reason validity (must be at least 3 characters)
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

        // Accept Leave with reason
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
// 1. Cron Job: 6:00 AM Daily Morning Announcement Message
// -------------------------------------------------------------
cron.schedule('0 6 * * *', async () => {
  try {
    const msg = `🌸 ʀᴀᴅʜᴇ ʀᴀᴅʜᴇ! ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʏᴏᴜ ᴀʟʟ☀️\n💗 ᴅᴀɪʟʏ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ɪꜱ ɴᴏᴡ ᴏᴘᴇɴ\n⏰ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴛɪᴍɪɴɢ\n🕕 <b>06:00 AM – 11:30 AM (IST)</b>\n📌 ᴀᴘɴɪ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴍᴀʀᴋ ᴋᴀʀɴᴇ ᴋᴇ ʟɪʏᴇ ɴɪᴄʜᴇ ᴅɪʏᴇ ɢᴀʏᴇ ʙᴜᴛᴛᴏɴꜱ ᴘᴀʀ ᴄʟɪᴄᴋ ᴋᴀʀᴇɴ. 💗`;
    await bot.telegram.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'HTML', ...getAttendanceKeyboard() });
    console.log('[CRON] 6:00 AM Announcement sent with buttons.');
  } catch (err) {
    console.error('[CRON ERROR] 6 AM:', err);
  }
}, { timezone: 'Asia/Kolkata' });

// -------------------------------------------------------------
// 2. Cron Job: 9:00 PM Daily Attendance Report Summary + CSV File
// -------------------------------------------------------------
cron.schedule('0 21 * * *', async () => {
  try {
    const members = await db.getAllMembers();
    const attendance = await db.getAllAttendance();

    const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    const yesterday = DateTime.now().setZone('Asia/Kolkata').minus({ days: 1 }).toFormat('dd-MM-yyyy');
    const dayBefore = DateTime.now().setZone('Asia/Kolkata').minus({ days: 2 }).toFormat('dd-MM-yyyy');

    const totalMembersCount = members.length;

    const todayAttendance = attendance.filter(r => String(r.date).trim() === today);
    const presentUsers = todayAttendance.filter(r => String(r.status || 'Present').trim() === 'Present');
    const leaveUsers = todayAttendance.filter(r => String(r.status || '').trim() === 'Leave');

    const presentUserIds = new Set(presentUsers.map(u => String(u.userId)));
    const leaveUserIds = new Set(leaveUsers.map(u => String(u.userId)));

    const absentUsers = members.filter(m => !presentUserIds.has(String(m.userId)) && !leaveUserIds.has(String(m.userId)));

    const warnings = [];
    for (const member of absentUsers) {
      const mId = String(member.userId);
      const attendedYesterday = attendance.some(r => String(r.date).trim() === yesterday && String(r.userId) === mId);
      const attendedDayBefore = attendance.some(r => String(r.date).trim() === dayBefore && String(r.userId) === mId);
      if (!attendedYesterday && !attendedDayBefore) {
        warnings.push(member.name);
      }
    }

    function chunkList(users, type) {
      const chunks = [];
      let currentChunk = [];
      let currentLength = 0;
      let counter = 1;
      for (const user of users) {
        let line = '';
        const name = escapeHTML(user.name || 'Unknown');
        if (type === 'leave') {
          const reason = escapeHTML(user.reason || 'No reason specified');
          line = `  <b>${counter}.</b> <code>${name}</code>\n     ┗ <i>${reason}</i>\n`;
        } else {
          line = `  <b>${counter}.</b> <code>${name}</code>\n`;
        }

        if (currentLength + line.length > 3000) {
          chunks.push(currentChunk.join(''));
          currentChunk = [line];
          currentLength = line.length;
        } else {
          currentChunk.push(line);
          currentLength += line.length;
        }
        counter++;
      }
      if (currentChunk.length > 0) chunks.push(currentChunk.join(''));
      return chunks;
    }

    function chunkWarnings(warningList) {
      const chunks = [];
      let currentChunk = [];
      let currentLength = 0;
      let counter = 1;
      for (const name of warningList) {
        const line = `  <b>${counter}.</b> <code>${escapeHTML(name)}</code> ⚠️\n`;
        if (currentLength + line.length > 3000) {
          chunks.push(currentChunk.join(''));
          currentChunk = [line];
          currentLength = line.length;
        } else {
          currentChunk.push(line);
          currentLength += line.length;
        }
        counter++;
      }
      if (currentChunk.length > 0) chunks.push(currentChunk.join(''));
      return chunks;
    }

    const presentChunks = chunkList(presentUsers, 'present');
    const leaveChunks = chunkList(leaveUsers, 'leave');
    const absentChunks = chunkList(absentUsers, 'absent');
    const warningChunks = chunkWarnings(warnings);

    const divider = '━━━━━━━━━━━━━━━━━━━━━━\n';
    let msg1 = `<b>📊 DAILY ATTENDANCE REPORT</b>\n${divider}📅 <b>Date:</b> <code>${today}</code>\n👥 <b>Total Members:</b> <code>${totalMembersCount}</code>\n${divider}✅ <b>Present Count:</b> <code>${presentUsers.length}</code>\n\n`;
    if (presentChunks.length > 0) {
      msg1 += `📝 <b>Present Members (Part 1):</b>\n${presentChunks[0]}`;
    } else {
      msg1 += `📝 <b>Present Members:</b>\n  <i>None</i>`;
    }
    await bot.telegram.sendMessage(GROUP_CHAT_ID, msg1, { parse_mode: 'HTML' });

    for (let i = 1; i < presentChunks.length; i++) {
      await bot.telegram.sendMessage(GROUP_CHAT_ID, `📝 <b>Present Members (Part ${i + 1}):</b>\n${presentChunks[i]}`, { parse_mode: 'HTML' });
    }

    let leaveMsg = `🍂 <b>ON LEAVE COUNT: ${leaveUsers.length}</b>\n${divider}`;
    if (leaveChunks.length > 0) leaveMsg += `📝 <b>Leave Registered:</b>\n${leaveChunks.join('')}`;
    else leaveMsg += `📝 <b>Leave Registered:</b>\n  <i>None</i>`;
    await bot.telegram.sendMessage(GROUP_CHAT_ID, leaveMsg, { parse_mode: 'HTML' });

    let absentMsg = `❌ <b>ABSENT COUNT: ${absentUsers.length}</b>\n${divider}`;
    if (absentChunks.length > 0) absentMsg += `📝 <b>Absent Members:</b>\n${absentChunks.join('')}`;
    else absentMsg += `📝 <b>Absent Members:</b>\n  <i>None</i>`;
    absentMsg += '\n⚠️ <b>Consecutive Absentees (3+ days):</b>\n';
    if (warningChunks.length > 0) absentMsg += warningChunks.join('');
    else absentMsg += '  <i>None</i>';

    await bot.telegram.sendMessage(GROUP_CHAT_ID, absentMsg, { parse_mode: 'HTML' });

    // Auto-send Excel/CSV file report
    const filePath = await db.generateCSVFilePath();
    await bot.telegram.sendDocument(GROUP_CHAT_ID, { source: filePath, filename: `attendance_${today}.csv` }, { caption: `📁 Daily Attendance Excel/CSV Export (${today})` });

    console.log('[CRON] 9:00 PM Report & CSV sent successfully.');
  } catch (err) {
    console.error('[CRON ERROR] 9 PM:', err);
  }
}, { timezone: 'Asia/Kolkata' });

// -------------------------------------------------------------
// 3. Command: /export (Download Excel/CSV Report)
// -------------------------------------------------------------
bot.hears(/^\/export(@\w+)?$/i, async (ctx) => {
  const userMessageId = ctx.message.message_id;
  try {
    const today = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-MM-yyyy');
    const filePath = await db.generateCSVFilePath();
    const allAttendance = await db.getAllAttendance();

    await ctx.replyWithDocument({ source: filePath, filename: `attendance_export_${today}.csv` }, {
      caption: `📊 <b>Attendance Excel/CSV Export</b>\n📅 Generated on: <code>${today}</code>\nTotal Logs: <code>${allAttendance.length}</code>`,
      parse_mode: 'HTML'
    });

    // Delete user command after 500ms
    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
    }, 500);
  } catch (err) {
    console.error('[COMMAND ERROR] /export:', err);
    ctx.reply('⚠️ Failed to generate export file.').catch(() => {});
  }
});

// -------------------------------------------------------------
// 4. Command: /admission form
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
// 5. Command: /mystatus
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

    let streakCount = 0;
    let checkDate = DateTime.now().setZone('Asia/Kolkata');
    while (true) {
      const dateStr = checkDate.toFormat('dd-MM-yyyy');
      const pastRecord = userRows.find(r => String(r.date).trim() === dateStr);
      if (pastRecord && String(pastRecord.status || 'Present').trim() === 'Present') {
        streakCount++;
        checkDate = checkDate.minus({ days: 1 });
      } else {
        break;
      }
    }

    let badge = '';
    if (streakCount >= 30) badge = ' 👑 [Legend]';
    else if (streakCount >= 15) badge = ' 🌟 [Gold]';
    else if (streakCount >= 7) badge = ' 🔥 [Silver]';
    else if (streakCount >= 3) badge = ' ⚡ [Rising Star]';

    const text = `<b>📊 ATTENDANCE SUMMARY: ${name}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📅 <b>Total Logs:</b> <code>${totalLogs}</code>\n✅ <b>Present Days:</b> <code>${presentCount}</code>\n🍂 <b>Leave Days:</b> <code>${leaveCount}</code>\n📈 <b>Attendance Rate:</b> <code>${attendanceRate}%</code>\n🔥 <b>Current Streak:</b> <code>${streakCount} Days${badge}</code>`;

    const statusMsg = await ctx.reply(text, { parse_mode: 'HTML' });

    // Delete user command immediately
    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
    }, 500);

    // Auto-delete status card after 60 seconds
    setTimeout(() => {
      ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    }, 60000);

  } catch (err) {
    console.error('[COMMAND ERROR] /mystatus:', err);
  }
});

// -------------------------------------------------------------
// 5.5 Command: /attendance (or /panel, /menu) - Opens Button Menu
// -------------------------------------------------------------
bot.hears(/^\/(attendance|panel|menu)(@\w+)?$/i, async (ctx) => {
  try {
    const text = `🌸 ʀᴀᴅʜᴇ ʀᴀᴅʜᴇ! ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʏᴏᴜ ᴀʟʟ☀️\n💗 ᴅᴀɪʟʏ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ɪꜱ ɴᴏᴡ ᴏᴘᴇɴ\n⏰ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴛɪᴍɪɴɢ\n🕕 <b>06:00 AM – 11:30 AM (IST)</b>\n📌 ᴀᴘɴɪ ᴀᴛᴛᴇɴᴅᴀɴᴄᴇ ᴍᴀʀᴋ ᴋᴀʀɴᴇ ᴋᴇ ʟɪʏᴇ ɴɪᴄʜᴇ ᴅɪʏᴇ ɢᴀʏᴇ ʙᴜᴛᴛᴏɴꜱ ᴘᴀʀ ᴄʟɪᴄᴋ ᴋᴀʀᴇɴ. 💗`;
    await ctx.reply(text, { parse_mode: 'HTML', ...getAttendanceKeyboard() });
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
// Button Action: ✅ Mark Present
// -------------------------------------------------------------
bot.action('btn_present', async (ctx) => {
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

    // Calculate Streak
    const allRows = await db.getAllAttendance();
    let streakCount = 1;
    let checkDate = nowKolkata.minus({ days: 1 });
    while (true) {
      const dateStr = checkDate.toFormat('dd-MM-yyyy');
      const pastRecord = allRows.find(r =>
        String(r.userId) === userId &&
        String(r.date).trim() === dateStr
      );
      if (pastRecord && String(pastRecord.status || 'Present').trim() === 'Present') {
        streakCount++;
        checkDate = checkDate.minus({ days: 1 });
      } else {
        break;
      }
    }

    let badge = '';
    if (streakCount >= 30) badge = ' 👑 [Legend]';
    else if (streakCount >= 15) badge = ' 🌟 [Gold]';
    else if (streakCount >= 7) badge = ' 🔥 [Silver]';
    else if (streakCount >= 3) badge = ' ⚡ [Rising Star]';

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
// Button Action: 🍂 Take Leave (Asks for Reason)
// -------------------------------------------------------------
bot.action('btn_leave', async (ctx) => {
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

    // 2-minute timer for timeout denial
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
    }, 120000); // 120 seconds

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

    let streakCount = 0;
    let checkDate = DateTime.now().setZone('Asia/Kolkata');
    while (true) {
      const dateStr = checkDate.toFormat('dd-MM-yyyy');
      const pastRecord = userRows.find(r => String(r.date).trim() === dateStr);
      if (pastRecord && String(pastRecord.status || 'Present').trim() === 'Present') {
        streakCount++;
        checkDate = checkDate.minus({ days: 1 });
      } else {
        break;
      }
    }

    let badge = '';
    if (streakCount >= 30) badge = ' 👑 [Legend]';
    else if (streakCount >= 15) badge = ' 🌟 [Gold]';
    else if (streakCount >= 7) badge = ' 🔥 [Silver]';
    else if (streakCount >= 3) badge = ' ⚡ [Rising Star]';

    const alertText = `📊 Status for ${name}:\n✅ Present: ${presentCount} | 🍂 Leave: ${leaveCount}\n📈 Rate: ${attendanceRate}%\n🔥 Streak: ${streakCount} Days${badge}`;
    await ctx.answerCbQuery(alertText, { show_alert: true });
  } catch (err) {
    console.error('[BTN_MYSTATUS ERROR]:', err);
    ctx.answerCbQuery('⚠️ Status check failed.', { show_alert: true }).catch(() => {});
  }
});

// -------------------------------------------------------------
// 6. Attendance Handler: /present & /leave
// -------------------------------------------------------------
bot.hears(/^(\/present|\/leave)(@\w+)?( .*)?$/i, async (ctx) => {
  if (ctx.chat.type === 'private') return;

  const nowKolkata = DateTime.now().setZone('Asia/Kolkata');
  const attendanceOpen = isAttendanceOpen(nowKolkata);

  const userId = String(ctx.from.id);
  const name = ctx.from.first_name || 'Unknown';
  const username = ctx.from.username || '';
  const userText = ctx.message.text.trim();
  const isPresent = userText.toLowerCase().startsWith('/present');
  const status = isPresent ? 'Present' : 'Leave';
  const reason = !isPresent ? (userText.split(' ').slice(1).join(' ') || 'No reason specified') : '';
  const today = nowKolkata.toFormat('dd-MM-yyyy');

  const userMessageId = ctx.message.message_id;

  // CLOSED TIMING HANDLER
  if (!attendanceOpen) {
    const closedMsgText = `❌ Attendance/Leave is closed for today.\n\n⏰ Attendance timing: ${TIMING_TEXT}\n\nPlease try again tomorrow morning.`;
    const closedMsg = await ctx.reply(closedMsgText);

    setTimeout(() => {
      ctx.deleteMessage(closedMsg.message_id).catch(() => {});
      ctx.deleteMessage(userMessageId).catch(() => {});
    }, 15000); // 15 seconds auto-delete
    return;
  }

  // OPEN TIMING HANDLER
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
      // Already Marked Handler
      const duplicateMsg = await ctx.reply(`<b>✅ ${name}, attendance/leave already marked for today</b>`, { parse_mode: 'HTML' });

      setTimeout(() => {
        ctx.deleteMessage(userMessageId).catch(() => {});
      }, 500);

      setTimeout(() => {
        ctx.deleteMessage(duplicateMsg.message_id).catch(() => {});
      }, 10000); // Delete duplicate notice after 10s
      return;
    }

    // Calculate Streak
    let streakCount = 0;
    if (isPresent) {
      const allRows = await db.getAllAttendance();
      streakCount = 1;
      let checkDate = nowKolkata.minus({ days: 1 });
      while (true) {
        const dateStr = checkDate.toFormat('dd-MM-yyyy');
        const pastRecord = allRows.find(r =>
          String(r.userId) === userId &&
          String(r.date).trim() === dateStr
        );
        if (pastRecord && String(pastRecord.status || 'Present').trim() === 'Present') {
          streakCount++;
          checkDate = checkDate.minus({ days: 1 });
        } else {
          break;
        }
      }
    }

    let badge = '';
    if (streakCount >= 30) badge = ' 👑 [Legend]';
    else if (streakCount >= 15) badge = ' 🌟 [Gold]';
    else if (streakCount >= 7) badge = ' 🔥 [Silver]';
    else if (streakCount >= 3) badge = ' ⚡ [Rising Star]';

    let replyText = isPresent
      ? `<b>✅ ${name}, attendance marked!</b>\n<code>🔥 ${streakCount}-Day Streak!${badge}</code>`
      : `<b>🍂 ${name}, leave registered</b>`;

    const successMsg = await ctx.reply(replyText, { parse_mode: 'HTML' });

    // Delete user command immediately
    setTimeout(() => {
      ctx.deleteMessage(userMessageId).catch(() => {});
    }, 500);

    // Delete success message after 30 seconds
    setTimeout(() => {
      ctx.deleteMessage(successMsg.message_id).catch(() => {});
    }, 30000);

  } catch (err) {
    console.error('[ATTENDANCE ERROR]:', err);
    ctx.reply('⚠️ Error saving attendance.').catch(() => {});
  }
});

bot.launch().then(() => {
  console.log('🚀 Telegram Attendance Bot (MongoDB Cloud + Local DB + CSV Mode) is running...');
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
