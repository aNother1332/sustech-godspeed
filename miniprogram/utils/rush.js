// utils/rush.js
// 用车高峰期（辅助找车禁用时段）计算
// 规则：周一至周五（国家法定节假日除外）及调休上班日，每个奇数节课（第1/3/5/7/9节）
// 上课前 25 分钟至上课后 5 分钟为禁用时段。

// 奇数节课上课时间（换算为当天分钟数），来源：校历课程时间表
const ODD_PERIOD_STARTS = [
  { period: 1, start: 8 * 60 }, // 第1节 08:00
  { period: 3, start: 10 * 60 + 20 }, // 第3节 10:20
  { period: 5, start: 14 * 60 }, // 第5节 14:00
  { period: 7, start: 16 * 60 + 20 }, // 第7节 16:20
  { period: 9, start: 19 * 60 }, // 第9节 19:00
];
const RUSH_BEFORE_MIN = 25;
const RUSH_AFTER_MIN = 5;

// 国家法定节假日（放假的日子，辅助找车不禁用）
// 依据《国务院办公厅关于2026年部分节假日安排的通知》，每年需随新通知更新
const HOLIDAYS = [
  "2026-01-01", "2026-01-02", "2026-01-03", // 元旦
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23", // 春节
  "2026-04-04", "2026-04-05", "2026-04-06", // 清明
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", // 劳动节
  "2026-06-19", "2026-06-20", "2026-06-21", // 端午
  "2026-09-25", "2026-09-26", "2026-09-27", // 中秋
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
  "2026-10-06", "2026-10-07", // 国庆
];

// 调休上班日（周末但按工作日计，禁用时段照常生效）
const MAKEUP_WORKDAYS = [
  "2026-01-04", // 元旦
  "2026-05-09", // 劳动节
  "2026-09-20", "2026-10-10", // 国庆
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

// 判断当前时刻是否处于禁用时段
// 返回 null 表示未禁用；否则返回 { period: 第几节课 }（可扩展禁用结束时刻等信息）
function findRushPeriod(now) {
  const ds = dateStr(now);
  if (HOLIDAYS.indexOf(ds) >= 0) return null; // 法定节假日不禁用
  const day = now.getDay(); // 0 周日 ... 6 周六
  const isWorkday = (day >= 1 && day <= 5) || MAKEUP_WORKDAYS.indexOf(ds) >= 0;
  if (!isWorkday) return null; // 普通周末不禁用
  const m = minutesOfDay(now);
  for (let i = 0; i < ODD_PERIOD_STARTS.length; i++) {
    const p = ODD_PERIOD_STARTS[i];
    if (m >= p.start - RUSH_BEFORE_MIN && m < p.start + RUSH_AFTER_MIN) {
      return { period: p.period };
    }
  }
  return null;
}

module.exports = { findRushPeriod, ODD_PERIOD_STARTS, HOLIDAYS, MAKEUP_WORKDAYS };
