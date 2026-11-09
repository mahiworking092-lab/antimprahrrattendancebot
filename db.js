const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const DB_FILE = path.join(__dirname, 'attendance_db.json');
const MONGODB_URI = process.env.MONGODB_URI;

// Schemas for MongoDB
const memberSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: { type: String, default: 'Unknown' },
  username: { type: String, default: '' },
  lastSeen: { type: Date, default: Date.now }
});

const attendanceSchema = new mongoose.Schema({
  date: { type: String, required: true },
  userId: { type: String, required: true },
  name: { type: String, default: 'Unknown' },
  username: { type: String, default: '' },
  status: { type: String, default: 'Present' },
  reason: { type: String, default: '' },
  timestamp: { type: String, default: '' }
});

attendanceSchema.index({ userId: 1, date: 1 }, { unique: true });

const Member = mongoose.model('Member', memberSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// 🗄️ MongoDB Schema for Active Buttons (11:30 AM Auto-Delete ke liye)
const buttonStoreSchema = new mongoose.Schema({
  date: { type: String, required: true },
  messageId: { type: Number, required: true }
});
const ButtonStore = mongoose.model('ButtonStore', buttonStoreSchema);

let isMongoConnected = false;

if (MONGODB_URI && MONGODB_URI.trim() !== '') {
  mongoose.connect(MONGODB_URI.trim())
    .then(() => {
      isMongoConnected = true;
      console.log('✅ [DATABASE] Connected to MongoDB Atlas Cloud successfully!');
    })
    .catch(err => {
      console.error('❌ [DATABASE ERROR] MongoDB Connection Failed:', err.message);
      console.warn('⚠️ [DATABASE] Falling back to local DB file.');
      isMongoConnected = false;
    });
}

// Local File Helper Functions
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { members: {}, attendance: [] };
    try { fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2)); } catch (e) {}
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { members: {}, attendance: [] };
  }
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[LOCAL DB ERROR] Save failed:', e);
  }
}

// Member Registration
async function registerMember(userId, name, username) {
  userId = String(userId);
  if (isMongoConnected) {
    try {
      await Member.findOneAndUpdate(
        { userId },
        { userId, name: name || 'Unknown', username: username || '', lastSeen: new Date() },
        { upsert: true, new: true }
      );
    } catch (e) {}
  } else {
    const data = loadDB();
    data.members[userId] = { userId, name: name || 'Unknown', username: username || '', lastSeen: new Date() };
    saveDB(data);
  }
}

// Remove Member (When they leave group)
async function removeMember(userId) {
  userId = String(userId);
  if (isMongoConnected) {
    try {
      await Member.deleteOne({ userId });
      console.log(`[DATABASE] Member ${userId} removed from MongoDB.`);
    } catch (e) {
      console.error('[DATABASE ERROR] Remove member failed:', e);
    }
  } else {
    const data = loadDB();
    if (data.members && data.members[userId]) {
      delete data.members[userId];
      saveDB(data);
      console.log(`[DATABASE] Member ${userId} removed from Local DB.`);
    }
  }
}

// Get All Members
async function getAllMembers() {
  if (isMongoConnected) {
    try {
      return await Member.find({});
    } catch (e) {
      console.error('[DATABASE ERROR] getAllMembers failed:', e);
    }
  }
  const data = loadDB();
  return Object.values(data.members || {});
}

// Get All Attendance
async function getAllAttendance() {
  if (isMongoConnected) {
    try {
      return await Attendance.find({});
    } catch (e) {
      console.error('[DATABASE ERROR] getAllAttendance failed:', e);
    }
  }
  const data = loadDB();
  return data.attendance || [];
}

// Add Attendance Record
async function addAttendance({ date, userId, name, username, status, reason }) {
  userId = String(userId);
  const nowKolkata = DateTime.now().setZone('Asia/Kolkata');
  const timestamp = nowKolkata.toFormat('dd/MM/yyyy, hh:mm:ss a');

  if (isMongoConnected) {
    try {
      const existing = await Attendance.findOne({ date, userId });
      if (existing) return false;

      await Attendance.create({
        date,
        userId,
        name: name || 'Unknown',
        username: username || '',
        status: status || 'Present',
        reason: reason || '',
        timestamp
      });
      return true;
    } catch (e) {
      if (e.code === 11000) return false;
      console.error('[DATABASE ERROR] addAttendance:', e);
      return false;
    }
  } else {
    const data = loadDB();
    const existing = data.attendance.find(r => String(r.date).trim() === date && String(r.userId) === userId);
    if (existing) return false;

    data.attendance.push({
      date,
      userId,
      name: name || 'Unknown',
      username: username || '',
      status: status || 'Present',
      reason: reason || '',
      timestamp
    });
    saveDB(data);
    return true;
  }
}

// Generate CSV File for Export
async function generateCSVFilePath() {
  const records = await getAllAttendance();
  const csvRows = ['Date,User ID,Name,Username,Status,Reason,Timestamp'];

  for (const r of records) {
    const cleanName = String(r.name || '').replace(/,/g, ' ');
    const cleanUsername = String(r.username || '').replace(/,/g, ' ');
    const cleanReason = String(r.reason || '').replace(/,/g, ' ');
    csvRows.push(`${r.date},${r.userId},"${cleanName}","${cleanUsername}",${r.status},"${cleanReason}","${r.timestamp}"`);
  }

  const exportPath = path.join(__dirname, 'attendance_export.csv');
  fs.writeFileSync(exportPath, csvRows.join('\n'), 'utf8');
  return exportPath;
}

// Generate Monthly Summary CSV File
async function generateMonthlyCSVFilePath(monthYear) {
  const allAttendance = await getAllAttendance();
  const allMembers = await getAllMembers();

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

  const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
  const rows = [];
  rows.push(`"MONTHLY ATTENDANCE SUMMARY (${monthYear})"`);
  rows.push(`"Total Working/Recorded Days",${totalDays}`);
  rows.push(`"Total Registered Members",${allMembers.length}`);
  rows.push('');
  rows.push(['Rank', 'Name', 'Username', 'User ID', 'Present Days', 'Leave Days', 'Absent Days', 'Attendance Rate %'].map(escapeCsv).join(','));

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
      username: m.username ? `@${m.username}` : '',
      presents,
      leaves,
      absents,
      rate
    };
  });

  memberStats.sort((a, b) => b.presents - a.presents || b.rate - a.rate);

  memberStats.forEach((st, idx) => {
    rows.push([
      idx + 1,
      escapeCsv(st.name),
      escapeCsv(st.username),
      escapeCsv(st.userId),
      st.presents,
      st.leaves,
      st.absents,
      `${st.rate}%`
    ].join(','));
  });

  rows.push('');
  rows.push('"--- DETAILED DAILY LOGS ---"');
  rows.push(['Date', 'User ID', 'Name', 'Username', 'Status', 'Reason', 'Timestamp'].map(escapeCsv).join(','));
  monthRecords.sort((a, b) => a.date.localeCompare(b.date));
  for (const r of monthRecords) {
    rows.push([
      escapeCsv(r.date),
      escapeCsv(r.userId),
      escapeCsv(r.name),
      escapeCsv(r.username),
      escapeCsv(r.status),
      escapeCsv(r.reason),
      escapeCsv(r.timestamp)
    ].join(','));
  }

  const exportPath = path.join(__dirname, `monthly_attendance_${monthYear}.csv`);
  fs.writeFileSync(exportPath, rows.join('\n'), 'utf8');
  return { filePath: exportPath, totalDays, memberCount: allMembers.length, monthRecordsCount: monthRecords.length };
}

// 🗄️ Naye Functions: MongoDB Button Storage & Auto-Delete Helpers
async function saveActiveButtonId(messageId, date) {
  try {
    if (isMongoConnected) {
      await ButtonStore.create({ date, messageId });
    }
  } catch (e) {
    console.error('[DB] saveActiveButtonId error:', e.message);
  }
}

async function getActiveButtonIds() {
  try {
    if (isMongoConnected) {
      const records = await ButtonStore.find();
      return records.map(r => r.messageId);
    }
  } catch (e) {
    console.error('[DB] getActiveButtonIds error:', e.message);
  }
  return [];
}

async function clearActiveButtonIds() {
  try {
    if (isMongoConnected) {
      await ButtonStore.deleteMany({});
    }
  } catch (e) {
    console.error('[DB] clearActiveButtonIds error:', e.message);
  }
}

module.exports = {
  saveActiveButtonId,
  getActiveButtonIds,
  clearActiveButtonIds,
  registerMember,
  removeMember,
  getAllMembers,
  getAllAttendance,
  addAttendance,
  generateCSVFilePath,
  generateMonthlyCSVFilePath
};
