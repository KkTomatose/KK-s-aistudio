// src/state.js — SQLite state management
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', 'state.db');
const MAX_PLAYS = Math.max(1, Number(process.env.STATE_MAX_PLAYS || 2500));
const MAX_MESSAGES = Math.max(1, Number(process.env.STATE_MAX_MESSAGES || 1000));

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_name TEXT,
    artist TEXT,
    ncm_id TEXT,
    reason TEXT,
    ts INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    content TEXT,
    ts INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS prefs (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Play history
const stmtSavePlay = db.prepare(
  'INSERT INTO plays (song_name, artist, ncm_id, reason) VALUES (?, ?, ?, ?)'
);
const stmtTrimPlays = db.prepare(`
  DELETE FROM plays
  WHERE id NOT IN (
    SELECT id FROM plays
    ORDER BY id DESC
    LIMIT ?
  )
`);
const txnSavePlay = db.transaction((songName, artist, ncmId, reason) => {
  const info = stmtSavePlay.run(songName, artist, ncmId, reason);
  stmtTrimPlays.run(MAX_PLAYS);
  return Number(info.lastInsertRowid);
});
export function savePlay(songName, artist, ncmId, reason) {
  return txnSavePlay(songName, artist, ncmId, reason);
}

export function deletePlay(id) {
  return db.prepare('DELETE FROM plays WHERE id = ?').run(Number(id));
}

export function getRecentPlays(limit = 20) {
  return db.prepare(
    'SELECT id, song_name, artist, ncm_id, reason, ts FROM plays ORDER BY ts DESC, id DESC LIMIT ?'
  ).all(limit);
}

export function getPlaysPaginated(limit = 200, offset = 0) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM plays').get().cnt;
  const rows = db.prepare(
    'SELECT id, song_name, artist, ncm_id, reason, ts FROM plays ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  return { total, rows };
}

// Prefs
const stmtSavePref = db.prepare(
  'INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)'
);
export function savePref(key, value) {
  stmtSavePref.run(key, value);
}

export function getPref(key) {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(key);
  return row ? row.value : null;
}

// Messages
const stmtSaveMessage = db.prepare(
  'INSERT INTO messages (role, content) VALUES (?, ?)'
);
const stmtTrimMessages = db.prepare(`
  DELETE FROM messages
  WHERE id NOT IN (
    SELECT id FROM messages
    ORDER BY id DESC
    LIMIT ?
  )
`);
const txnSaveMessage = db.transaction((role, content) => {
  stmtSaveMessage.run(role, content);
  stmtTrimMessages.run(MAX_MESSAGES);
});
export function saveMessage(role, content) {
  txnSaveMessage(role, content);
}

export function getRecentMessages(limit = 20) {
  return db.prepare(
    'SELECT id, role, content, ts FROM messages ORDER BY ts DESC, id DESC LIMIT ?'
  ).all(limit);
}
