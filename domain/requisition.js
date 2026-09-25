// 领用入口：修补单即配件领用单。
// 开单时一次性校验偶头、剧目、在库、占用；任一不通过整张单不保存。
const config = require('../project.config');
const { transaction, randomUUID, sqlValue } = require('../db');
const store = require('../store');
const occupancy = require('./occupancy');

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function normalizeAccessoryIds(body) {
  const raw = body.accessoryIds;
  const ids = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null || raw === ''
      ? []
      : String(raw).split(',').map((item) => item.trim()).filter(Boolean);
  return [...new Set(ids)];
}

// 开单：写清偶头和配件，配件与偶头同剧目且在库，未被其他未结单占用
function openRepairOrder(body) {
  const accessoryIds = normalizeAccessoryIds(body);

  if (!body.puppetHeadId) throw httpError(400, 'puppetHeadId 必填（开单须写清修补的偶头）');
  if (!body.repairType) throw httpError(400, 'repairType 必填（写清修补类型）');
  if (!body.handler) throw httpError(400, 'handler 必填（写清修手）');
  if (accessoryIds.length === 0) {
    throw httpError(400, 'accessoryIds 必填（修补领用须写清领用配件，无需配件请走普通修补登记）');
  }

  const repairConfig = config.collections.repairRecords;

  return transaction((tx) => {
    const head = tx.one(
      "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " +
      sqlValue(body.puppetHeadId) + ' LIMIT 1;'
    );
    if (!head) throw httpError(404, '偶头不存在: ' + body.puppetHeadId);

    const accessories = [];
    for (const accessoryId of accessoryIds) {
      const accessory = tx.one(
        "SELECT * FROM records WHERE collection = 'accessories' AND id = " +
        sqlValue(accessoryId) + ' LIMIT 1;'
      );
      if (!accessory) throw httpError(404, '配件不存在: ' + accessoryId);
      accessories.push(accessory);
    }

    // 占用判定优先：撞件是核心业务规则（配件"修补领用"状态正是占用的镜像，
    // 被未结单占有时这里必须给出 409，而不是笼统的"不在库"）
    const conflicts = occupancy.conflictsFor(tx, accessoryIds);
    if (conflicts.length > 0) {
      throw httpError(409, '配件已被未结修补单领用，整张单不保存', { conflicts });
    }

    for (const accessory of accessories) {
      if (accessory.play !== head.play) {
        throw httpError(
          422,
          '配件与偶头不同剧目，整张单不保存',
          { accessoryId: accessory.id, accessoryPlay: accessory.play, headPlay: head.play }
        );
      }
      if (accessory.status !== '在库') {
        throw httpError(
          422,
          '配件不在库，整张单不保存',
          { accessoryId: accessory.id, status: accessory.status }
        );
      }
    }

    const id = randomUUID();
    const status = repairConfig.defaultStatus;
    const data = {
      puppetHeadId: body.puppetHeadId,
      puppetHeadName: head.role + (head.play ? ' / ' + head.play : ''),
      repairType: body.repairType,
      handler: body.handler,
      accessoryIds,
      accessoryNames: accessories.map((item) => item.name),
      repairNote: body.repairNote || body.note || '',
      result: '',
      resultNote: '',
      replacementHistory: [],
      status
    };

    const writes = [];
    writes.push(store.insertStatement({
      id,
      collection: 'repairRecords',
      status,
      data,
      title: store.titleFor(repairConfig, data)
    }));
    writes.push(store.eventStatement({
      recordId: id,
      collection: 'repairRecords',
      action: '开单领用',
      status,
      actor: body.handler,
      note: '领用配件 ' + accessories.map((item) => item.name).join('、'),
      data: { puppetHeadId: body.puppetHeadId, accessoryIds }
    }));

    // 偶头进入修补中，暂不可演出
    const nextHead = { ...head, status: '修补中', currentUsable: false };
    delete nextHead.id;
    delete nextHead.collection;
    delete nextHead.createdAt;
    delete nextHead.updatedAt;
    writes.push(store.updateStatement({
      collection: 'puppetHeads',
      id: head.id,
      status: '修补中',
      data: nextHead,
      title: store.titleFor(config.collections.puppetHeads, nextHead)
    }));
    writes.push(store.eventStatement({
      recordId: head.id,
      collection: 'puppetHeads',
      action: '送修补',
      status: '修补中',
      actor: body.handler,
      note: '修补单 ' + id + ' 开单',
      data: { repairRecordId: id }
    }));

    // 配件标记为修补领用（占用的镜像状态）
    for (const accessory of accessories) {
      const nextAccessory = { ...accessory, status: '修补领用', occupiedByRepairId: id };
      delete nextAccessory.id;
      delete nextAccessory.collection;
      delete nextAccessory.createdAt;
      delete nextAccessory.updatedAt;
      writes.push(store.updateStatement({
        collection: 'accessories',
        id: accessory.id,
        status: '修补领用',
        data: nextAccessory,
        title: store.titleFor(config.collections.accessories, nextAccessory)
      }));
      writes.push(store.eventStatement({
        recordId: accessory.id,
        collection: 'accessories',
        action: '领用出库',
        status: '修补领用',
        actor: body.handler,
        note: '修补单 ' + id + ' 领用',
        data: { repairRecordId: id }
      }));
    }

    writes.forEach((sql) => tx.run(sql));

    return { id, status, data };
  });
}

// 换配件：旧占用释放，新件继续占；过往处理保留在留档里
function swapAccessory(recordId, body) {
  if (!body.oldAccessoryId) throw httpError(400, 'oldAccessoryId 必填');
  if (!body.newAccessoryId) throw httpError(400, 'newAccessoryId 必填');
  if (body.oldAccessoryId === body.newAccessoryId) {
    throw httpError(400, '新旧配件不能是同一件');
  }

  return transaction((tx) => {
    const order = tx.one(
      "SELECT * FROM records WHERE collection = 'repairRecords' AND id = " +
      sqlValue(recordId) + ' LIMIT 1;'
    );
    if (!order) throw httpError(404, '修补单不存在: ' + recordId);
    if (!occupancy.isOpenStatus(order.status)) {
      throw httpError(409, '修补单已结，不能再换配件', { status: order.status });
    }

    const heldIds = order.accessoryIds || [];
    if (!heldIds.includes(body.oldAccessoryId)) {
      throw httpError(422, '旧配件不在本修补单的领用清单中', { oldAccessoryId: body.oldAccessoryId });
    }
    if (heldIds.includes(body.newAccessoryId)) {
      throw httpError(422, '新配件已在本单领用清单中，无需更换');
    }

    const oldAccessory = tx.one(
      "SELECT * FROM records WHERE collection = 'accessories' AND id = " +
      sqlValue(body.oldAccessoryId) + ' LIMIT 1;'
    );
    const newAccessory = tx.one(
      "SELECT * FROM records WHERE collection = 'accessories' AND id = " +
      sqlValue(body.newAccessoryId) + ' LIMIT 1;'
    );
    if (!oldAccessory) throw httpError(404, '旧配件不存在: ' + body.oldAccessoryId);
    if (!newAccessory) throw httpError(404, '新配件不存在: ' + body.newAccessoryId);

    const head = tx.one(
      "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " +
      sqlValue(order.puppetHeadId) + ' LIMIT 1;'
    );
    if (head && newAccessory.play !== head.play) {
      throw httpError(422, '新配件与偶头不同剧目，更换不保存', {
        newAccessoryPlay: newAccessory.play,
        headPlay: head.play
      });
    }
    // 占用判定先于在库校验（占用件本身状态就是"修补领用"）
    const conflicts = occupancy.conflictsFor(tx, [body.newAccessoryId], { excludeId: recordId });
    if (conflicts.length > 0) {
      throw httpError(409, '新配件已被其他未结修补单领用，更换不保存', { conflicts });
    }
    if (newAccessory.status !== '在库') {
      throw httpError(422, '新配件不在库，更换不保存', { status: newAccessory.status });
    }

    const writes = [];
    const actor = body.actor || order.handler || '';

    // 旧件释放回库
    const nextOld = { ...oldAccessory, status: '在库' };
    delete nextOld.occupiedByRepairId;
    delete nextOld.id;
    delete nextOld.collection;
    delete nextOld.createdAt;
    delete nextOld.updatedAt;
    writes.push(store.updateStatement({
      collection: 'accessories',
      id: oldAccessory.id,
      status: '在库',
      data: nextOld,
      title: store.titleFor(config.collections.accessories, nextOld)
    }));
    writes.push(store.eventStatement({
      recordId: oldAccessory.id,
      collection: 'accessories',
      action: '换件释放回库',
      status: '在库',
      actor,
      note: '修补单 ' + recordId + ' 换下',
      data: { repairRecordId: recordId, replacedBy: body.newAccessoryId }
    }));

    // 新件领用占用
    const nextNew = { ...newAccessory, status: '修补领用', occupiedByRepairId: recordId };
    delete nextNew.id;
    delete nextNew.collection;
    delete nextNew.createdAt;
    delete nextNew.updatedAt;
    writes.push(store.updateStatement({
      collection: 'accessories',
      id: newAccessory.id,
      status: '修补领用',
      data: nextNew,
      title: store.titleFor(config.collections.accessories, nextNew)
    }));
    writes.push(store.eventStatement({
      recordId: newAccessory.id,
      collection: 'accessories',
      action: '换件领用出库',
      status: '修补领用',
      actor,
      note: '修补单 ' + recordId + ' 换上',
      data: { repairRecordId: recordId, replaced: body.oldAccessoryId }
    }));

    // 单据：替换占用清单，过往处理留档
    const nextAccessoryIds = heldIds
      .filter((id) => id !== body.oldAccessoryId)
      .concat(body.newAccessoryId);
    const nextNames = (order.accessoryNames || [])
      .filter((name) => name !== oldAccessory.name)
      .concat(newAccessory.name);
    const historyEntry = {
      at: new Date().toISOString(),
      oldAccessoryId: body.oldAccessoryId,
      oldAccessoryName: oldAccessory.name,
      newAccessoryId: body.newAccessoryId,
      newAccessoryName: newAccessory.name,
      reason: body.reason || body.note || '',
      actor
    };
    const nextOrder = {
      ...order,
      accessoryIds: nextAccessoryIds,
      accessoryNames: nextNames,
      replacementHistory: [...(order.replacementHistory || []), historyEntry]
    };
    delete nextOrder.id;
    delete nextOrder.collection;
    delete nextOrder.createdAt;
    delete nextOrder.updatedAt;
    writes.push(store.updateStatement({
      collection: 'repairRecords',
      id: recordId,
      status: order.status,
      data: nextOrder,
      title: store.titleFor(config.collections.repairRecords, nextOrder)
    }));
    writes.push(store.eventStatement({
      recordId,
      collection: 'repairRecords',
      action: '换配件',
      status: order.status,
      actor,
      note: (oldAccessory.name || body.oldAccessoryId) + ' → ' + (newAccessory.name || body.newAccessoryId),
      data: historyEntry
    }));

    writes.forEach((sql) => tx.run(sql));

    return { recordId, accessoryIds: nextAccessoryIds, replaced: historyEntry };
  });
}

module.exports = {
  openRepairOrder,
  swapAccessory,
  normalizeAccessoryIds,
  httpError
};
