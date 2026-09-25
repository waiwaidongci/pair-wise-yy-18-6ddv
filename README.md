# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 修补领用流程

修补单接成领用流程，三方职责各自承担：领用入口（路由）、占用判定（未结单占用计算）、修补留档（事件时间线）。

- `POST /api/repairs` 开单并领用配件
  - 请求体：`{puppetHeadId, repairType, handler, partIds?, status?, actor?, note?}`
  - 配件须与偶头**同剧目**、**在库**、且**未被其他未结修补单占用**；任一不满足，整张单不保存（占用冲突返回 409，其余校验返回 400）
  - 开单成功后偶头转「修补中」、不可演出
- `GET /api/repairs/availability?play=火焰山` 查看配件占用与可领用状态（`occupied` / `occupiedByOrderId` / `available`）
- `POST /api/repairs/:id/parts` 更换配件
  - 请求体：`{partIds, actor?, note?}`
  - 新件按同一套占用判定校验；旧占用即释放，过往领用记录仍保留在时间线
- `POST /api/repairs/:id/close` 关单登记复原结果
  - 请求体：`{result: "通过" | "新问题", problems?, note?, actor?}`
  - `通过`：配件回库（占用解除），偶头恢复「可演出」，单转「已完成」
  - `新问题`：须填 `problems`；偶头转「待修补」，单退回「待处理」，配件继续占用
- 留档查询：`GET /api/repairRecords/:id/timeline`、`GET /api/puppetHeads/:id/timeline`、`GET /api/accessories/:id/timeline`

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。
