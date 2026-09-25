module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler'],
      defaults: { partIds: [] }
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '修补中',
      data: {
        role: '老生',
        play: '火焰山',
        paintStatus: '髯口处脱漆',
        mechanism: '转眼机关正常',
        accessories: ['相貂', '蟒'],
        boxNo: '木箱乙-05',
        currentUsable: false
      },
      eventAction: '修补开单',
      note: '开单修补髯口脱漆'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '短靠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-3',
      status: '在库',
      data: {
        name: '雉鸡翎',
        role: '武生',
        play: '大闹天宫',
        boxNo: '配件箱-03'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-4',
      status: '缺损',
      data: {
        name: '旧靠旗',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      },
      note: '返场清点发现旗面破损'
    },
    {
      collection: 'repairRecords',
      id: 'repair-seed-1',
      status: '补漆中',
      data: {
        puppetHeadId: 'head-seed-2',
        repairType: '补漆',
        handler: '陈师傅',
        partIds: ['accessory-seed-2']
      },
      eventAction: '开单领用',
      note: '领用短靠比对补漆'
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/repairs 修补开单并领用配件（同剧目、在库、未被占用；冲突则整单不保存）',
    'GET /api/repairs/availability?play=火焰山 查看配件占用与可领用状态',
    'POST /api/repairs/:id/parts 更换配件，旧占用自动释放、过往处理留档',
    'POST /api/repairs/:id/close 关单登记复原结果：通过则配件回库偶头可演出，新问题则转待修补',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/lossReports 登记返场缺损或遗失'
  ]
};
