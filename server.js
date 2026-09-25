const express = require('express');
const config = require('./project.config');
const { runSql, sqlValue, select, now, randomUUID, toRecord } = require('./db');
const store = require('./store');
const occupancy = require('./domain/occupancy');
const domainRouter = require('./domain');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
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
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(seed.collection),
        sqlValue(status),
        sqlValue(store.titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(seed.updatedAt || createdAt)
      ].join(', ') +
      ');'
    );
    store.insertEventNow({
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

// 修补领用流程专用路由（领用入口 / 占用判定 / 修补留档）
app.use('/api', domainRouter);

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

// 修补单是领用流程单据，不允许走通用建单入口（必须 /api/repairRecords/open）
app.post('/api/repairRecords', (req, res) => {
  res.status(405).json({
    error: '修补单须走领用流程：POST /api/repairRecords/open（校验偶头、剧目、在库、占用后整单保存）'
  });
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    const createdAt = now();
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(req.params.collection),
        sqlValue(status),
        sqlValue(store.titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(createdAt)
      ].join(', ') +
      ');'
    );
    store.insertEventNow({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(store.getRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = store.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

// 流程守卫：修补流程管辖的状态/占用字段不允许用通用 PATCH 旁路改动
function assertNotWorkflowOwned(collection, record, body) {
  if (collection === 'repairRecords') {
    const owned = ['status', 'accessoryIds', 'result', 'resultNote', 'replacementHistory'];
    const touched = owned.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (touched.length) {
      const error = new Error('修补单的 ' + touched.join(', ') + ' 由领用流程维护：开单 /open、关单 /close、换件 /swap-accessory');
      error.status = 405;
      throw error;
    }
  }
  if (collection === 'accessories' && body.status !== undefined) {
    if (body.status === '修补领用') {
      const error = new Error('配件"修补领用"状态只能由开单/换件领用写入');
      error.status = 405;
      throw error;
    }
    if (record.status === '修补领用' && body.status !== '修补领用') {
      const error = new Error('配件被未结修补单占用，释放须走关单 /close 或换件 /swap-accessory');
      error.status = 405;
      throw error;
    }
  }
  if (collection === 'puppetHeads' && body.status !== undefined && record.status === '修补中') {
    const open = store.listRows('repairRecords').some(
      (row) => occupancy.isOpenStatus(row.status) && row.puppetHeadId === record.id
    );
    if (open) {
      const error = new Error('偶头在未结修补单中，状态须由关单 /close 流转');
      error.status = 405;
      throw error;
    }
  }
}

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    const collection = req.params.collection;
    findCollection(collection);
    const record = store.getRecord(collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    assertNotWorkflowOwned(collection, record, req.body);
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    runSql(store.updateStatement({
      collection,
      id: req.params.id,
      status,
      data: nextData,
      title: store.titleFor(findCollection(collection), nextData)
    }));
    store.insertEventNow({
      recordId: req.params.id,
      collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(store.getRecord(collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collection = req.params.collection;
    const collectionConfig = findCollection(collection);
    const record = store.getRecord(collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    assertNotWorkflowOwned(collection, record, { ...(req.body.fields || {}), ...(req.body.status ? { status: req.body.status } : {}) });
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    runSql(store.updateStatement({
      collection,
      id: req.params.id,
      status,
      data: nextData,
      title: store.titleFor(collectionConfig, nextData)
    }));
    store.insertEventNow({
      recordId: req.params.id,
      collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(store.getRecord(collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = store.getRecord(req.params.collection, req.params.id);
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
    const collection = req.params.collection;
    findCollection(collection);
    if (collection === 'repairRecords') {
      const record = store.getRecord(collection, req.params.id);
      if (record && occupancy.isOpenStatus(record.status)) {
        return res.status(405).json({ error: '未结修补单不能删除，请先关单 /close；历史单据留档保留' });
      }
    }
    runSql('DELETE FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(req.params.id) + ';');
    runSql('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error', details: error.details });
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});
