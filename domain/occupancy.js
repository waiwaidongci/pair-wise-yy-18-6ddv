// 占用判定：一件配件在任一"未结修补单"里被领用即视为占用。
// 配件自身状态（修补领用）只是占用结果的镜像，真正的判定事实永远从
// 未结修补单推导，避免配件状态与单据脱节。
const { sqlValue } = require('../db');

// 未结：尚未走到关闭结论的修补单（已完成即历史留档，不再占件）
const OPEN_STATUSES = ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中'];

function isOpenStatus(status) {
  return OPEN_STATUSES.includes(status);
}

function openOrdersForAccessory(tx, accessoryId, options = {}) {
  const excludeId = options.excludeId ? sqlValue(options.excludeId) : null;
  const rows = tx.all(
    'SELECT id, status, data FROM records ' +
    "WHERE collection = 'repairRecords' " +
    "AND status IN ('" + OPEN_STATUSES.join("','") + "') " +
    (excludeId ? 'AND id != ' + excludeId + ' ' : '') +
    ';'
  );
  return rows.filter((row) => {
    const ids = row.accessoryIds || [];
    return ids.includes(accessoryId);
  });
}

// 返回 { occupied: bool, by: [{id}] }
function occupancyOf(tx, accessoryId, options = {}) {
  const holders = openOrdersForAccessory(tx, accessoryId, options);
  return { occupied: holders.length > 0, by: holders.map((row) => row.id) };
}

// 批量判定一张单要领的全部配件，返回所有冲突
function conflictsFor(tx, accessoryIds, options = {}) {
  const conflicts = [];
  for (const accessoryId of accessoryIds) {
    const state = occupancyOf(tx, accessoryId, options);
    if (state.occupied) {
      conflicts.push({ accessoryId, heldBy: state.by });
    }
  }
  return conflicts;
}

module.exports = {
  OPEN_STATUSES,
  isOpenStatus,
  openOrdersForAccessory,
  occupancyOf,
  conflictsFor
};
