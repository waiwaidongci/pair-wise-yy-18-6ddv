const fs = require('fs');
const path = require('path');
const { Database } = require('node-sqlite3-wasm');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA journal_mode = WAL;');

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

// 执行无返回的 SQL（可含多条语句）
function runSql(sql) {
  db.exec(sql);
}

function select(sql) {
  return db.prepare(sql).all();
}

function selectOne(sql) {
  return db.prepare(sql).get() || null;
}

function now() {
  return new Date().toISOString();
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

// 同步事务：worker 内的读与写全部落在 BEGIN IMMEDIATE ... COMMIT 之间，
// 任一校验抛出即 ROLLBACK，已登记的写一条都不会落库（冲突整单不保存）。
function transaction(worker) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = worker({
      run: (sql) => db.exec(sql),
      one: (sql) => {
        const row = db.prepare(sql).get();
        return row ? toRecord(row) : null;
      },
      all: (sql) => db.prepare(sql).all().map(toRecord)
    });
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  db,
  DB_FILE,
  sqlValue,
  runSql,
  select,
  selectOne,
  now,
  randomUUID,
  toRecord,
  transaction
};
