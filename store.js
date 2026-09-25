const { sqlValue, select, selectOne, now, randomUUID, toRecord } = require('./db');

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function findRowByCollection(collection, id) {
  return selectOne(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
}

function getRecord(collection, id) {
  const row = findRowByCollection(collection, id);
  return row ? toRecord(row) : null;
}

function listRows(collection, whereSql = '') {
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) +
    (whereSql ? ' AND ' + whereSql : '') +
    ' ORDER BY updated_at DESC;'
  ).map(toRecord);
}

// 生成 INSERT 语句（在事务内登记，随事务一起提交）
function insertStatement({ id, collection, status, data, title }) {
  const ts = now();
  return (
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(title),
      sqlValue(JSON.stringify(data)),
      sqlValue(ts),
      sqlValue(ts)
    ].join(', ') +
    ');'
  );
}

function updateStatement({ collection, id, status, data, title }) {
  return (
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(title) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function eventStatement({ recordId, collection, action, status, actor, note, data }) {
  return (
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

// 立即落库的事件（初始化种子用）
function insertEventNow(payload) {
  const { runSql } = require('./db');
  runSql(eventStatement(payload));
}

module.exports = {
  titleFor,
  getRecord,
  findRowByCollection,
  listRows,
  insertStatement,
  updateStatement,
  eventStatement,
  insertEventNow
};
