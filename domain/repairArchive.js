// 修补留档：关单登记复原结果。
// 通过 → 配件回库、偶头恢复可演出、单据已完成（留档）；
// 发现新问题转待修补 → 配件继续占着，偶头仍待修，单据仍是未结状态。
const config = require('../project.config');
const { transaction, sqlValue } = require('../db');
const store = require('../store');
const occupancy = require('./occupancy');

const PASS_RESULTS = ['通过', '复原通过', '试演通过', 'pass'];

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function isPass(result) {
  return PASS_RESULTS.includes(String(result || '').trim());
}

function stripRecord(record) {
  const next = { ...record };
  delete next.id;
  delete next.collection;
  delete next.createdAt;
  delete next.updatedAt;
  return next;
}

function closeRepair(recordId, body) {
  if (!body.result) {
    throw httpError(400, 'result 必填（关单须登记复原结果：通过 / 新问题）');
  }
  const passed = isPass(body.result);
  const newProblem = !passed;

  return transaction((tx) => {
    const order = tx.one(
      "SELECT * FROM records WHERE collection = 'repairRecords' AND id = " +
      sqlValue(recordId) + ' LIMIT 1;'
    );
    if (!order) throw httpError(404, '修补单不存在: ' + recordId);
    if (!occupancy.isOpenStatus(order.status)) {
      throw httpError(409, '修补单已结，不能重复关单', { status: order.status });
    }

    const accessoryIds = order.accessoryIds || [];
    const accessories = accessoryIds.map((accessoryId) => ({
      id: accessoryId,
      record: tx.one(
        "SELECT * FROM records WHERE collection = 'accessories' AND id = " +
        sqlValue(accessoryId) + ' LIMIT 1;'
      )
    }));

    const head = tx.one(
      "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " +
      sqlValue(order.puppetHeadId) + ' LIMIT 1;'
    );

    const actor = body.actor || order.handler || '';
    const resultNote = body.resultNote || body.note || '';
    const writes = [];

    let orderStatus;
    let headStatus;
    let headUsable;
    let accessoryStatus;
    let orderAction;
    let noteText;

    if (passed) {
      orderStatus = '已完成';
      headStatus = '可演出';
      headUsable = true;
      accessoryStatus = '在库';
      orderAction = '关单-复原通过';
      noteText = '复原通过，配件全部回库，偶头恢复可演出';
    } else {
      // 发现新问题转待修补：配件继续占着
      orderStatus = '待处理';
      headStatus = '待修补';
      headUsable = false;
      accessoryStatus = '修补领用';
      orderAction = '关单-发现新问题转待修补';
      noteText = '试演/复原发现新问题，转待修补，配件继续占用';
    }

    // 单据留档：登记结果（replacementHistory 等过往处理原样保留）
    const nextOrder = stripRecord({
      ...order,
      status: orderStatus,
      result: String(body.result).trim(),
      resultNote,
      closedAt: passed ? new Date().toISOString() : (order.closedAt || ''),
      reopenedAt: newProblem ? new Date().toISOString() : (order.reopenedAt || '')
    });
    writes.push(store.updateStatement({
      collection: 'repairRecords',
      id: recordId,
      status: orderStatus,
      data: nextOrder,
      title: store.titleFor(config.collections.repairRecords, nextOrder)
    }));
    writes.push(store.eventStatement({
      recordId,
      collection: 'repairRecords',
      action: orderAction,
      status: orderStatus,
      actor,
      note: noteText + (resultNote ? '：' + resultNote : ''),
      data: {
        result: body.result,
        resultNote,
        accessoryIds,
        accessoryReturned: passed
      }
    }));

    // 偶头状态
    if (head) {
      const nextHead = stripRecord({ ...head, status: headStatus, currentUsable: headUsable });
      writes.push(store.updateStatement({
        collection: 'puppetHeads',
        id: head.id,
        status: headStatus,
        data: nextHead,
        title: store.titleFor(config.collections.puppetHeads, nextHead)
      }));
      writes.push(store.eventStatement({
        recordId: head.id,
        collection: 'puppetHeads',
        action: passed ? '复原通过恢复演出' : '发现新问题转待修补',
        status: headStatus,
        actor,
        note: resultNote,
        data: { repairRecordId: recordId }
      }));
    }

    // 配件：通过则全部回库；否则继续占着（状态维持修补领用）
    for (const item of accessories) {
      if (!item.record) continue;
      const current = item.record;
      const nextAccessory = stripRecord({ ...current, status: accessoryStatus });
      if (passed) {
        delete nextAccessory.occupiedByRepairId;
      } else {
        nextAccessory.occupiedByRepairId = recordId;
      }
      writes.push(store.updateStatement({
        collection: 'accessories',
        id: item.id,
        status: accessoryStatus,
        data: nextAccessory,
        title: store.titleFor(config.collections.accessories, nextAccessory)
      }));
      writes.push(store.eventStatement({
        recordId: item.id,
        collection: 'accessories',
        action: passed ? '完工回库' : '继续占用',
        status: accessoryStatus,
        actor,
        note: passed ? '修补单 ' + recordId + ' 完工回库' : '修补单 ' + recordId + ' 转待修补，继续占用',
        data: { repairRecordId: recordId }
      }));
    }

    writes.forEach((sql) => tx.run(sql));

    return {
      recordId,
      orderStatus,
      headStatus,
      headUsable,
      accessoryStatus,
      accessoryIds,
      accessoryReturned: passed
    };
  });
}

module.exports = {
  closeRepair,
  isPass,
  httpError
};
