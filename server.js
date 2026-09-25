const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const config = require('./project.config');

const app = express();
const PORT = process.env.PORT || config.port;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

app.use(express.json({ limit: '2mb' }));

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return execFileSync('sqlite3', [DB_FILE], {
    input: sql,
    encoding: 'utf8'
  });
}

function select(sql) {
  const output = runSql('.mode json\n' + sql);
  if (!output.trim()) return [];
  return JSON.parse(output);
}

// 多语句事务：任一句失败即整体回滚，保证“冲突时整张单不保存”
function runTx(statements) {
  runSql('.bail on\nBEGIN IMMEDIATE;\n' + statements.join('\n') + '\nCOMMIT;\n');
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

function stripMeta(record) {
  const data = { ...record };
  delete data.id;
  delete data.collection;
  delete data.createdAt;
  delete data.updatedAt;
  return data;
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

// —— SQL 构造器：只拼语句不执行，领域流程可组合进同一事务 ——

function insertRecordSql(collection, id, data, status, createdAt) {
  const collectionConfig = findCollection(collection);
  const at = createdAt || now();
  return (
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(titleFor(collectionConfig, data)),
      sqlValue(JSON.stringify(data)),
      sqlValue(at),
      sqlValue(at)
    ].join(', ') +
    ');'
  );
}

function saveRecordSql(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  return (
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function insertEventSql({ recordId, collection, action, status, actor, note, data }) {
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

function insertEvent(entry) {
  runSql(insertEventSql(entry));
}

function saveRecord(collection, id, data, status) {
  runSql(saveRecordSql(collection, id, data, status));
}

function initDb() {
  runSql(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
`);

  const count = select('SELECT COUNT(*) AS count FROM records;')[0].count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    runSql(insertRecordSql(seed.collection, id, data, status, createdAt));
    insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
}

function loadRecord(collection, id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

initDb();

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// ============================================================
// 修补领用流程
// 三方职责各自承担：
//   领用入口 —— 下方 /api/repairs 系列路由：开单、查可领、换件、关单
//   占用判定 —— occupiedAccessoryIds / validatePartsAvailable
//   修补留档 —— archiveRepairEvent：全程写入事件时间线，过往处理不抹除
// ============================================================

const REPAIR_COLLECTION = 'repairRecords';
const REPAIR_CLOSED_STATUS = '已完成'; // 未结修补单 = 状态非「已完成」

// —— 占用判定 ——

// 凡未结修补单里出现的配件即视为占用；返回 Map<配件ID, 占用它的修补单ID>
function occupiedAccessoryIds(excludeOrderId) {
  const occupied = new Map();
  const openOrders = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(REPAIR_COLLECTION) +
    ' AND status != ' + sqlValue(REPAIR_CLOSED_STATUS) + ';'
  ).map(toRecord);
  for (const order of openOrders) {
    if (order.id === excludeOrderId) continue;
    for (const partId of order.partIds || []) {
      if (!occupied.has(partId)) occupied.set(partId, order.id);
    }
  }
  return occupied;
}

// 领用校验：配件须与偶头同剧目、在库、未被其他未结单占用；任一不满足整批驳回
function validatePartsAvailable(head, partIds, excludeOrderId) {
  const occupied = occupiedAccessoryIds(excludeOrderId);
  const problems = [];
  let hasConflict = false;
  const parts = [];
  for (const partId of partIds) {
    const part = loadRecord('accessories', partId);
    if (!part) {
      problems.push('配件不存在：' + partId);
      continue;
    }
    if (part.play !== head.play) {
      problems.push('配件「' + part.name + '」属剧目《' + part.play + '》，与偶头剧目《' + head.play + '》不一致');
    }
    if (part.status !== '在库') {
      problems.push('配件「' + part.name + '」当前状态为「' + part.status + '」，须在库才可领用');
    }
    if (occupied.has(partId)) {
      hasConflict = true;
      problems.push('配件「' + part.name + '」已被未结修补单 ' + occupied.get(partId) + ' 占用');
    }
    parts.push(part);
  }
  if (problems.length) {
    const error = new Error('配件领用未通过：' + problems.join('；'));
    error.status = hasConflict ? 409 : 400;
    error.details = problems;
    throw error;
  }
  return parts;
}

// —— 修补留档 ——

// 开单、换件、关单都经此留痕；换件释放旧占用后，过往领用记录仍保留在事件流里
function archiveRepairEvent(statements, entry) {
  statements.push(insertEventSql({ ...entry, data: { flow: '修补领用', ...(entry.data || {}) } }));
}

function partSummaries(parts) {
  return parts.map((part) => ({ id: part.id, name: part.name, play: part.play }));
}

// —— 领用入口 ——

// 开单：写清偶头与配件，全部校验通过才整单落库；冲突则整张单不保存
app.post('/api/repairs', (req, res, next) => {
  try {
    const body = req.body || {};
    const actor = body.actor || '';
    const note = body.note || '';
    const missing = [];
    if (!body.puppetHeadId) missing.push('puppetHeadId');
    if (!body.repairType) missing.push('repairType');
    if (!body.handler) missing.push('handler');
    if (missing.length) return res.status(400).json({ error: '缺少必填字段：' + missing.join(', ') });

    const head = loadRecord('puppetHeads', body.puppetHeadId);
    if (!head) return res.status(404).json({ error: '偶头不存在：' + body.puppetHeadId });

    const partIds = body.partIds === undefined ? [] : body.partIds;
    if (!Array.isArray(partIds)) return res.status(400).json({ error: 'partIds 须为配件ID数组' });
    const uniquePartIds = [...new Set(partIds)];

    const collectionConfig = findCollection(REPAIR_COLLECTION);
    const status = body.status || collectionConfig.defaultStatus;
    if (!collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    if (status === REPAIR_CLOSED_STATUS) {
      return res.status(400).json({ error: '开单状态不能为「' + REPAIR_CLOSED_STATUS + '」' });
    }

    // 占用判定：先校验后落库，任一配件不过则整单不保存
    const parts = validatePartsAvailable(head, uniquePartIds, null);

    const orderId = randomUUID();
    const orderData = {
      puppetHeadId: head.id,
      repairType: body.repairType,
      handler: body.handler,
      partIds: uniquePartIds,
      status
    };
    const statements = [insertRecordSql(REPAIR_COLLECTION, orderId, orderData, status)];
    archiveRepairEvent(statements, {
      recordId: orderId,
      collection: REPAIR_COLLECTION,
      action: '开单领用',
      status,
      actor,
      note,
      data: {
        puppetHeadId: head.id,
        repairType: body.repairType,
        handler: body.handler,
        parts: partSummaries(parts)
      }
    });
    // 偶头转入修补中，暂不可演出
    statements.push(saveRecordSql('puppetHeads', head.id, { ...stripMeta(head), status: '修补中', currentUsable: false }, '修补中'));
    archiveRepairEvent(statements, {
      recordId: head.id,
      collection: 'puppetHeads',
      action: '修补开单',
      status: '修补中',
      actor,
      note: '修补单 ' + orderId + ' 开单',
      data: { orderId, repairType: body.repairType }
    });
    for (const part of parts) {
      archiveRepairEvent(statements, {
        recordId: part.id,
        collection: 'accessories',
        action: '配件领用',
        status: part.status,
        actor,
        note: '修补单 ' + orderId + ' 领用',
        data: { orderId, puppetHeadId: head.id }
      });
    }
    runTx(statements);
    res.status(201).json(loadRecord(REPAIR_COLLECTION, orderId));
  } catch (error) {
    next(error);
  }
});

// 可领用查询：配件的在库与占用情况一目了然，便于开单前挑件
app.get('/api/repairs/availability', (req, res, next) => {
  try {
    const occupied = occupiedAccessoryIds(null);
    const accessories = select(
      "SELECT * FROM records WHERE collection = 'accessories' ORDER BY updated_at DESC;"
    ).map(toRecord);
    const enriched = accessories.map((accessory) => ({
      ...accessory,
      occupied: occupied.has(accessory.id),
      occupiedByOrderId: occupied.get(accessory.id) || null,
      available: accessory.status === '在库' && !occupied.has(accessory.id)
    }));
    res.json(applyQuery(enriched, req.query));
  } catch (error) {
    next(error);
  }
});

// 换配件：新件校验通过后整单更新；旧占用即释放，过往处理仍在时间线留档
app.post('/api/repairs/:id/parts', (req, res, next) => {
  try {
    const order = loadRecord(REPAIR_COLLECTION, req.params.id);
    if (!order) return res.status(404).json({ error: '修补单不存在' });
    if (order.status === REPAIR_CLOSED_STATUS) {
      return res.status(409).json({ error: '修补单已关闭，不能再换配件' });
    }
    const body = req.body || {};
    if (!Array.isArray(body.partIds)) {
      return res.status(400).json({ error: 'partIds 须为配件ID数组' });
    }
    const head = loadRecord('puppetHeads', order.puppetHeadId);
    if (!head) return res.status(404).json({ error: '关联偶头不存在：' + order.puppetHeadId });

    const uniquePartIds = [...new Set(body.partIds)];
    // 占用判定：排除本单自身占用，新件仍须同剧目、在库、未被他人占用
    const parts = validatePartsAvailable(head, uniquePartIds, order.id);

    const actor = body.actor || '';
    const note = body.note || '';
    const oldIds = order.partIds || [];
    const added = parts.filter((part) => !oldIds.includes(part.id));
    const released = oldIds
      .filter((id) => !uniquePartIds.includes(id))
      .map((id) => loadRecord('accessories', id))
      .filter(Boolean);

    const statements = [
      saveRecordSql(REPAIR_COLLECTION, order.id, { ...stripMeta(order), partIds: uniquePartIds }, order.status)
    ];
    archiveRepairEvent(statements, {
      recordId: order.id,
      collection: REPAIR_COLLECTION,
      action: '更换配件',
      status: order.status,
      actor,
      note,
      data: {
        added: partSummaries(added),
        released: partSummaries(released),
        partIds: uniquePartIds
      }
    });
    for (const part of added) {
      archiveRepairEvent(statements, {
        recordId: part.id,
        collection: 'accessories',
        action: '配件领用',
        status: part.status,
        actor,
        note: '修补单 ' + order.id + ' 换件领用',
        data: { orderId: order.id, puppetHeadId: order.puppetHeadId }
      });
    }
    for (const part of released) {
      archiveRepairEvent(statements, {
        recordId: part.id,
        collection: 'accessories',
        action: '配件回库',
        status: part.status,
        actor,
        note: '修补单 ' + order.id + ' 更换配件，旧占用释放',
        data: { orderId: order.id, puppetHeadId: order.puppetHeadId }
      });
    }
    runTx(statements);
    res.json(loadRecord(REPAIR_COLLECTION, order.id));
  } catch (error) {
    next(error);
  }
});

// 关单：登记复原结果。通过→配件回库、偶头恢复可演出；新问题→转待修补、配件继续占用
app.post('/api/repairs/:id/close', (req, res, next) => {
  try {
    const order = loadRecord(REPAIR_COLLECTION, req.params.id);
    if (!order) return res.status(404).json({ error: '修补单不存在' });
    if (order.status === REPAIR_CLOSED_STATUS) {
      return res.status(409).json({ error: '修补单已关闭，请勿重复关单' });
    }
    const body = req.body || {};
    const result = body.result;
    if (!['通过', '新问题'].includes(result)) {
      return res.status(400).json({ error: 'result 须为「通过」或「新问题」' });
    }
    const actor = body.actor || '';
    const note = body.note || '';
    const problems = body.problems || '';
    if (result === '新问题' && !problems) {
      return res.status(400).json({ error: '发现新问题须登记 problems 说明' });
    }

    const head = loadRecord('puppetHeads', order.puppetHeadId);
    const partIds = order.partIds || [];
    const parts = partIds.map((id) => loadRecord('accessories', id)).filter(Boolean);
    const statements = [];

    if (result === '通过') {
      const nextData = {
        ...stripMeta(order),
        status: REPAIR_CLOSED_STATUS,
        closeResult: '通过',
        closeNote: note,
        closedAt: now(),
        closedBy: actor
      };
      statements.push(saveRecordSql(REPAIR_COLLECTION, order.id, nextData, REPAIR_CLOSED_STATUS));
      archiveRepairEvent(statements, {
        recordId: order.id,
        collection: REPAIR_COLLECTION,
        action: '关单',
        status: REPAIR_CLOSED_STATUS,
        actor,
        note,
        data: { result, releasedParts: partSummaries(parts) }
      });
      if (head) {
        statements.push(saveRecordSql('puppetHeads', head.id, { ...stripMeta(head), status: '可演出', currentUsable: true }, '可演出'));
        archiveRepairEvent(statements, {
          recordId: head.id,
          collection: 'puppetHeads',
          action: '复原通过',
          status: '可演出',
          actor,
          note: note || '修补完成，恢复可演出',
          data: { orderId: order.id }
        });
      }
      // 配件回库：单结后占用即解除，逐件留痕
      for (const part of parts) {
        archiveRepairEvent(statements, {
          recordId: part.id,
          collection: 'accessories',
          action: '配件回库',
          status: part.status,
          actor,
          note: '修补单 ' + order.id + ' 关单通过，配件回库',
          data: { orderId: order.id, puppetHeadId: order.puppetHeadId }
        });
      }
    } else {
      const nextData = {
        ...stripMeta(order),
        status: '待处理',
        lastCloseResult: '新问题',
        newProblems: problems,
        reopenedAt: now()
      };
      statements.push(saveRecordSql(REPAIR_COLLECTION, order.id, nextData, '待处理'));
      archiveRepairEvent(statements, {
        recordId: order.id,
        collection: REPAIR_COLLECTION,
        action: '关单留修',
        status: '待处理',
        actor,
        note: note || problems,
        data: { result, problems, keptParts: partSummaries(parts) }
      });
      if (head) {
        statements.push(saveRecordSql('puppetHeads', head.id, { ...stripMeta(head), status: '待修补', currentUsable: false }, '待修补'));
        archiveRepairEvent(statements, {
          recordId: head.id,
          collection: 'puppetHeads',
          action: '转待修补',
          status: '待修补',
          actor,
          note: problems,
          data: { orderId: order.id }
        });
      }
      // 配件继续占用：单未结，占用判定仍算在本单头上，不写回库事件
    }
    runTx(statements);
    res.json(loadRecord(REPAIR_COLLECTION, order.id));
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 通用集合接口
// ============================================================

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;'
    ).map(toRecord);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    runSql(insertRecordSql(req.params.collection, id, data, status));
    insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = select(
      'SELECT * FROM events WHERE record_id = ' + sqlValue(req.params.id) + ' ORDER BY created_at ASC;'
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    runSql('DELETE FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' AND id = ' + sqlValue(req.params.id) + ';');
    runSql('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const body = { error: error.message || 'server error' };
  if (error.details) body.details = error.details;
  res.status(error.status || 500).json(body);
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});
