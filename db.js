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

module.exports = {
  registerMember,
  removeMember,
  getAllMembers,
  getAllAttendance,
  addAttendance,
  generateCSVFilePath
};
