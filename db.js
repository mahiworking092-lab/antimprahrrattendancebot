const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

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
    .then(async () => {
      isMongoConnected = true;
      console.log('✅ [DATABASE] Connected to MongoDB Atlas Cloud successfully!');
      try {
        const doc = await getDoc();
      } catch(e){}
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
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (err) {
    return { members: {}, attendance: [] };
  }
}

function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

function addAttendanceLocal(record) {
  const db = loadDB();
  db.members[record.userId] = {
    userId: String(record.userId),
    name: record.name || 'Unknown',
    username: record.username || '',
    lastSeen: new Date().toISOString()
  };

  const userIdStr = String(record.userId);
  const dateStr = String(record.date).trim();

  const exists = db.attendance.find(a => String(a.userId) === userIdStr && String(a.date).trim() === dateStr);
  if (exists) return false;

  db.attendance.push({
    date: dateStr,
    userId: userIdStr,
    name: record.name || 'Unknown',
    username: record.username || '',
    status: record.status || 'Present',
    reason: record.reason || '',
    timestamp: record.timestamp || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  });

  saveDB(db);
  return true;
}

// Exported Functions
async function registerMember(userId, name, username) {
  if (!userId) return;
  const uIdStr = String(userId);

  // Local sync
  const dbLocal = loadDB();
  dbLocal.members[uIdStr] = { userId: uIdStr, name: name || 'Unknown', username: username || '', lastSeen: new Date().toISOString() };
  saveDB(dbLocal);

  if (isMongoConnected) {
    try {
      await Member.findOneAndUpdate(
        { userId: uIdStr },
        { name: name || 'Unknown', username: username || '', lastSeen: new Date() },
        { upsert: true, new: true }
      );
    } catch (e) {
      console.error('[MONGO MEMBER ERR]:', e.message);
    }
  }
}

async function addAttendance(record) {
  if (!record.userId) return false;
  const uIdStr = String(record.userId);
  const dateStr = String(record.date).trim();
  const timestampStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  record.timestamp = timestampStr;

  if (isMongoConnected) {
    try {
      const existing = await Attendance.findOne({ userId: uIdStr, date: dateStr });
      if (existing) return false;

      await Attendance.create({
        date: dateStr,
        userId: uIdStr,
        name: record.name || 'Unknown',
        username: record.username || '',
        status: record.status || 'Present',
        reason: record.reason || '',
        timestamp: timestampStr
      });
      // also keep local in sync
      addAttendanceLocal(record);
      return true;
    } catch (err) {
      if (err.code === 11000) return false; // Duplicate index
      console.error('[MONGO ATTENDANCE ERR]:', err.message);
    }
  }

  return addAttendanceLocal(record);
}

async function getAllAttendance() {
  if (isMongoConnected) {
    try {
      const records = await Attendance.find().lean();
      if (records && records.length > 0) return records;
    } catch (e) {
      console.error('[MONGO GET ATTENDANCE ERR]:', e.message);
    }
  }
  const db = loadDB();
  return db.attendance || [];
}

async function getAllMembers() {
  if (isMongoConnected) {
    try {
      const members = await Member.find().lean();
      if (members && members.length > 0) return members;
    } catch (e) {
      console.error('[MONGO GET MEMBERS ERR]:', e.message);
    }
  }
  const db = loadDB();
  return Object.values(db.members || {});
}

async function generateCSVFilePath() {
  const records = await getAllAttendance();
  const headers = ['Date', 'User ID', 'Name', 'Username', 'Status', 'Reason', 'Time (IST)'];
  const rows = [headers.join(',')];

  const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`;

  for (const row of records) {
    const line = [
      escapeCsv(row.date),
      escapeCsv(row.userId),
      escapeCsv(row.name),
      escapeCsv(row.username),
      escapeCsv(row.status),
      escapeCsv(row.reason),
      escapeCsv(row.timestamp)
    ].join(',');
    rows.push(line);
  }

  const csvContent = rows.join('\n');
  const filePath = path.join(__dirname, 'attendance_report.csv');
  fs.writeFileSync(filePath, csvContent, 'utf-8');
  return filePath;
}

module.exports = {
  registerMember,
  addAttendance,
  getAllAttendance,
  getAllMembers,
  generateCSVFilePath
};
