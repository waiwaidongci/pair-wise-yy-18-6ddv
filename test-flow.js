const BASE = 'http://localhost:3914';

let passed = 0;
let failed = 0;

function req(method, urlPath, body) {
  return fetch(BASE + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (res) => {
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  });
}

function check(name, condition, extra) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : ''));
  }
}

(async () => {
  // 准备：另一个可演出偶头 + 同剧目配件
  const head = await req('POST', '/api/puppetHeads', {
    role: '老生', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '木箱甲-01'
  });
  const extraAcc = await req('POST', '/api/accessories', {
    name: '相纱', role: '老生', play: '火焰山', boxNo: '配件箱-03'
  });
  const HEAD = head.body.id;
  const ACC1 = 'accessory-seed-1'; // 红缨冠 / 火焰山
  const ACC2 = 'accessory-seed-2'; // 短靠 / 火焰山
  const ACC3 = 'accessory-seed-3'; // 凤冠 / 牡丹亭
  const ACC4 = extraAcc.body.id;   // 相纱 / 火焰山

  console.log('1) 正常开单领用');
  const beforeOrders = (await req('GET', '/api/repairRecords')).body.length;
  const open1 = await req('POST', '/api/repairRecords/open', {
    puppetHeadId: HEAD, repairType: '补漆', handler: '阿荣',
    accessoryIds: [ACC1], note: '额角掉彩'
  });
  check('开单 201', open1.status === 201, open1.body);
  const ORDER1 = open1.body.id;
  const h1 = await req('GET', '/api/puppetHeads/' + HEAD);
  const a1 = await req('GET', '/api/accessories/' + ACC1);
  check('偶头转修补中', h1.body.status === '修补中' && h1.body.currentUsable === false, h1.body.status);
  check('配件转修补领用', a1.body.status === '修补领用', a1.body.status);

  console.log('2) 两单撞同一件 → 冲突整单不保存');
  const clash = await req('POST', '/api/repairRecords/open', {
    puppetHeadId: 'head-seed-1', repairType: '换线', handler: '阿华',
    accessoryIds: [ACC1, ACC2] // ACC1 已占，即使 ACC2 空闲也整单失败
  });
  check('占用冲突 409', clash.status === 409, clash.status);
  const afterClash = (await req('GET', '/api/repairRecords')).body.length;
  check('整单不保存（记录数未变）', afterClash === beforeOrders + 1, { beforeOrders, afterClash });
  const a2 = await req('GET', '/api/accessories/' + ACC2);
  check('同单其他配件未被动（短靠仍在库）', a2.body.status === '在库', a2.body.status);

  console.log('3) 不同剧目 → 整单不保存');
  const diffPlay = await req('POST', '/api/repairRecords/open', {
    puppetHeadId: HEAD, repairType: '换眼珠', handler: '阿荣', accessoryIds: [ACC3]
  });
  check('剧目不符 422', diffPlay.status === 422, diffPlay.body);

  console.log('4) 配件不在库 → 整单不保存（ACC1 已被领用）');
  const notInStock = await req('POST', '/api/repairRecords/open', {
    puppetHeadId: 'head-seed-1', repairType: '换线', handler: '阿华', accessoryIds: [ACC1]
  });
  check('不在库 422（被占用的也非在库）', notInStock.status === 422 || notInStock.status === 409, notInStock.status);

  console.log('5) 必填校验');
  const miss = await req('POST', '/api/repairRecords/open', { puppetHeadId: HEAD });
  check('缺配件/类型/修手 400', miss.status === 400, miss.body);

  console.log('6) 占用判定视图');
  const occ = await req('GET', '/api/accessories/' + ACC1 + '/occupancy');
  check('occupied=true 且指向 ORDER1',
    occ.body.occupied === true && occ.body.heldByRepairIds[0] === ORDER1, occ.body);
  const occFree = await req('GET', '/api/accessories/' + ACC2 + '/occupancy');
  check('空闲配件 occupied=false', occFree.body.occupied === false, occFree.body);
  const openList = await req('GET', '/api/repairRecords/open');
  check('未结单清单包含 ORDER1', openList.body.some((r) => r.id === ORDER1));

  console.log('7) 换配件：旧件释放、新件占用、过往留档');
  const swap = await req('POST', '/api/repairRecords/' + ORDER1 + '/swap-accessory', {
    oldAccessoryId: ACC1, newAccessoryId: ACC4, reason: '红缨冠绒球脱落改借相纱', actor: '阿荣'
  });
  check('换件 200', swap.status === 200, swap.body);
  const oldA = await req('GET', '/api/accessories/' + ACC1);
  const newA = await req('GET', '/api/accessories/' + ACC4);
  check('旧件回库', oldA.body.status === '在库' && oldA.body.occupiedByRepairId === undefined, oldA.body.status);
  check('新件被占', newA.body.status === '修补领用' && newA.body.occupiedByRepairId === ORDER1, newA.body.status);
  check('单据占用清单已替换',
    swap.body.record.accessoryIds.length === 1 && swap.body.record.accessoryIds[0] === ACC4,
    swap.body.record.accessoryIds);
  check('replacementHistory 留档一条',
    swap.body.record.replacementHistory.length === 1 &&
    swap.body.record.replacementHistory[0].oldAccessoryId === ACC1 &&
    swap.body.record.replacementHistory[0].newAccessoryId === ACC4,
    swap.body.record.replacementHistory);

  console.log('8) 换件后旧件可被新单领用（占用已释放）');
  const open2 = await req('POST', '/api/repairRecords/open', {
    puppetHeadId: 'head-seed-1', repairType: '换线', handler: '阿华', accessoryIds: [ACC1, ACC2]
  });
  check('释放后旧件可开新单 201', open2.status === 201, open2.body);
  const ORDER2 = open2.body.id;

  console.log('9) 换件占用并发安全：两单同时抢 ACC3(凤冠) —— 先给另一偶头开单领用 ACC3 不现实（剧目不同），改为同剧目抢 ACC4 已占场景');
  // ACC4 在 ORDER1，新单抢 ACC4 必须失败
  const grab = await req('POST', '/api/repairRecords/open', {
    puppetHeadId: 'head-seed-1', repairType: '修机关', handler: '阿华', accessoryIds: [ACC4]
  });
  check('抢已被换新占用的件 409/422', grab.status === 409 || grab.status === 422, grab.status);

  console.log('10) 关单发现新问题：转待修补，配件继续占');
  const reopen = await req('POST', '/api/repairRecords/' + ORDER2 + '/close', {
    result: '新问题', resultNote: '试演发现右眼珠卡顿', actor: '阿华'
  });
  check('关单 200', reopen.status === 200, reopen.body);
  check('单据转待处理（未结）', reopen.body.record.status === '待处理', reopen.body.record.status);
  const hSeed = await req('GET', '/api/puppetHeads/head-seed-1');
  check('偶头转待修补', hSeed.body.status === '待修补' && hSeed.body.currentUsable === false, hSeed.body.status);
  const a1Still = await req('GET', '/api/accessories/' + ACC1 + '/occupancy');
  check('配件继续被 ORDER2 占用', a1Still.body.occupied === true && a1Still.body.heldByRepairIds[0] === ORDER2, a1Still.body);
  const occA2 = await req('GET', '/api/accessories/' + ACC2 + '/occupancy');
  check('ACC2 也继续占着', occA2.body.occupied === true, occA2.body);

  console.log('11) 再次关单通过：配件回库、偶头可演出');
  // ORDER1 通过
  const close1 = await req('POST', '/api/repairRecords/' + ORDER1 + '/close', {
    result: '通过', resultNote: '补漆完好', actor: '班主'
  });
  check('ORDER1 已完成', close1.body.record.status === '已完成', close1.body.record.status);
  const h1again = await req('GET', '/api/puppetHeads/' + HEAD);
  check('偶头恢复可演出', h1again.body.status === '可演出' && h1again.body.currentUsable === true, h1again.body.status);
  const a4 = await req('GET', '/api/accessories/' + ACC4);
  check('换上的配件回库', a4.body.status === '在库' && a4.body.occupiedByRepairId === undefined, a4.body.status);

  console.log('12) 历史单据的完工留档与 timeline');
  const tl1 = await req('GET', '/api/repairRecords/' + ORDER1 + '/timeline');
  const actions = tl1.body.events.map((e) => e.action);
  check('timeline 含 开单领用/换配件/关单通过',
    actions.includes('开单领用') && actions.includes('换配件') && actions.some((a) => a.includes('通过')),
    actions);
  check('旧件在自己 timeline 留有 领用→释放 记录',
    (await req('GET', '/api/accessories/' + ACC1 + '/timeline')).body.events
      .map((e) => e.action).includes('领用出库'));

  console.log('13) ORDER2（待修补）再关单通过 → 全部回库');
  const close2 = await req('POST', '/api/repairRecords/' + ORDER2 + '/close', {
    result: '复原通过', actor: '班主'
  });
  check('ORDER2 已完成', close2.body.record.status === '已完成', close2.body.record.status);
  const hSeed2 = await req('GET', '/api/puppetHeads/head-seed-1');
  check('seed 偶头恢复可演出', hSeed2.body.status === '可演出' && hSeed2.body.currentUsable === true, hSeed2.body.status);
  const a1back = await req('GET', '/api/accessories/' + ACC1);
  const a2back = await req('GET', '/api/accessories/' + ACC2);
  check('ACC1/ACC2 均回库', a1back.body.status === '在库' && a2back.body.status === '在库');

  console.log('14) 已结单不能重复关单 / 换件');
  const reClose = await req('POST', '/api/repairRecords/' + ORDER1 + '/close', { result: '通过' });
  check('重复关单 409', reClose.status === 409, reClose.status);
  const reSwap = await req('POST', '/api/repairRecords/' + ORDER1 + '/swap-accessory', {
    oldAccessoryId: ACC4, newAccessoryId: ACC1
  });
  check('已结单换件 409', reSwap.status === 409, reSwap.status);

  console.log('15) 防旁路守卫');
  const genericPost = await req('POST', '/api/repairRecords', {
    puppetHeadId: HEAD, repairType: '补漆', handler: 'x'
  });
  check('通用建修补单入口 405', genericPost.status === 405, genericPost.status);
  // 开一张新单后尝试 PATCH 占用件
  const open3 = await req('POST', '/api/repairRecords/open', {
    puppetHeadId: HEAD, repairType: '补漆', handler: '阿荣', accessoryIds: [ACC1]
  });
  const patchAcc = await req('PATCH', '/api/accessories/' + ACC1, { status: '在库' });
  check('PATCH 强释放占用件 405', patchAcc.status === 405, patchAcc.status);
  const patchOrder = await req('PATCH', '/api/repairRecords/' + open3.body.id, { status: '已完成' });
  check('PATCH 流程状态 405', patchOrder.status === 405, patchOrder.status);
  const delOpen = await req('DELETE', '/api/repairRecords/' + open3.body.id);
  check('未结单删除 405', delOpen.status === 405, delOpen.status);
  const occAfterGuards = await req('GET', '/api/accessories/' + ACC1 + '/occupancy');
  check('守卫后占用仍在', occAfterGuards.body.occupied === true, occAfterGuards.body);

  console.log('16) 真正并发：同时两单抢同一件，恰好一单成功');
  // 先把 ACC1 释放：关掉 open3
  await req('POST', '/api/repairRecords/' + open3.body.id + '/close', { result: '通过' });
  const [c1, c2] = await Promise.all([
    req('POST', '/api/repairRecords/open', { puppetHeadId: HEAD, repairType: '补漆', handler: '甲', accessoryIds: [ACC1] }),
    req('POST', '/api/repairRecords/open', { puppetHeadId: 'head-seed-1', repairType: '换线', handler: '乙', accessoryIds: [ACC1] })
  ]);
  const okCount = [c1, c2].filter((r) => r.status === 201).length;
  const conflictCount = [c1, c2].filter((r) => r.status === 409 || r.status === 422).length;
  check('并发两单：1 成功 1 冲突', okCount === 1 && conflictCount === 1,
    { s1: c1.status, s2: c2.status });
  const holders = (await req('GET', '/api/accessories/' + ACC1 + '/occupancy')).body.heldByRepairIds;
  check('最终仅一单占用', holders.length === 1, holders);

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
