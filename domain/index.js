const express = require('express');
const { transaction } = require('../db');
const store = require('../store');
const occupancy = require('./occupancy');
const requisition = require('./requisition');
const repairArchive = require('./repairArchive');

const router = express.Router();

// 未结修补单清单（当前在占件的单据）
router.get('/repairRecords/open', (req, res, next) => {
  try {
    const rows = store.listRows('repairRecords');
    res.json(rows.filter((row) => occupancy.isOpenStatus(row.status)));
  } catch (error) {
    next(error);
  }
});

// 领用入口：开修补单（即领用配件）
router.post('/repairRecords/open', (req, res, next) => {
  try {
    const result = requisition.openRepairOrder(req.body || {});
    res.status(201).json(store.getRecord('repairRecords', result.id));
  } catch (error) {
    next(error);
  }
});

// 修补留档：关单登记复原结果
router.post('/repairRecords/:id/close', (req, res, next) => {
  try {
    const result = repairArchive.closeRepair(req.params.id, req.body || {});
    res.json({ ...result, record: store.getRecord('repairRecords', req.params.id) });
  } catch (error) {
    next(error);
  }
});

// 领用入口：换配件（旧占用释放，新件占用，过往保留）
router.post('/repairRecords/:id/swap-accessory', (req, res, next) => {
  try {
    const result = requisition.swapAccessory(req.params.id, req.body || {});
    res.json({ ...result, record: store.getRecord('repairRecords', req.params.id) });
  } catch (error) {
    next(error);
  }
});

// 占用判定视图：查询配件当前被哪张未结修补单占用
router.get('/accessories/:id/occupancy', (req, res, next) => {
  try {
    const accessory = store.getRecord('accessories', req.params.id);
    if (!accessory) return res.status(404).json({ error: '配件不存在' });
    const state = transaction((tx) => occupancy.occupancyOf(tx, req.params.id));
    res.json({
      accessoryId: req.params.id,
      name: accessory.name,
      status: accessory.status,
      occupied: state.occupied,
      heldByRepairIds: state.by
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
