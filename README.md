# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords/open` 开修补单（即领用配件）
- `POST /api/repairRecords/:id/swap-accessory` 换配件
- `POST /api/repairRecords/:id/close` 关单登记复原结果
- `GET /api/repairRecords/open` 未结修补单（在占件）清单
- `GET /api/accessories/:id/occupancy` 查询配件占用方
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 修补领用流程

修补单同时是配件领用单，三个职责各自独立：

1. **领用入口**（`POST /api/repairRecords/open`）：开单须写清偶头 `puppetHeadId`、`repairType`、`handler` 和 `accessoryIds`。校验每件配件与偶头同剧目、状态在库、且未被其他未结修补单占用；任一不满足**整张单不保存**（409/422）。开单成功后偶头转"修补中"、配件转"修补领用"。
2. **占用判定**（`domain/occupancy.js`）：占用事实只从未结修补单（非"已完成"）的 `accessoryIds` 推导，配件状态仅为镜像。判定与写入在同一 SQLite 事务内串行完成，两单并发不会领到同一件。
3. **修补留档**（`POST /api/repairRecords/:id/close`）：关单登记 `result`——
   - `通过`：配件全部回库，偶头恢复"可演出"，单据"已完成"留档；
   - 其他（视为发现新问题）：单据回"待处理"、偶头转"待修补"，**配件继续占用**。

换配件走 `POST /api/repairRecords/:id/swap-accessory`：旧件立即释放回库、新件校验后占用，更换记录追加到单据 `replacementHistory`，过往处理不删改。

修补单不可走通用 `POST /api/repairRecords` 建单；占用状态、关单结果等流程字段会拦截通用 PATCH 旁路修改。

SQLite数据库文件会在首次启动时创建到`data/app.db`。
