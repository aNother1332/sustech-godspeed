// cloudfunctions/bike/index.js
// 存储层：CloudBase 2.0 SQL 型数据库（PostgreSQL）
// 经 @cloudbase/node-sdk 的 rdb()（PostgREST 通道，云函数内免密）读写 public schema
const cloud = require("wx-server-sdk");
const CloudBase = require("@cloudbase/node-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SPEED_CHOICES = ["slow", "normal", "fast"];
// 二维码车号目前为 8 位，放宽到 6-12 位以兼容滴滴后续批次的编码变化
const VEHICLE_ID_RE = /^\d{6,12}$/;
const PLATE_RE = /^\d{6}$/;

// rdb 实例在每次调用内创建：模块顶层创建时 headers 状态不完整会导致 Accept-Profile 缺失
function makeTable() {
  const app = CloudBase.init({ env: process.env.TCB_ENV });
  const rdb = app.rdb();
  return (name) => {
    const q = rdb.from(name);
    q.schema = "public";
    return q;
  };
}

// 由最新至多 3 条投票计算速度状态：最高票唯一则取之；任何平票判普速；无投票默认普速
function computeStatus(recentChoices) {
  const counts = { slow: 0, normal: 0, fast: 0 };
  recentChoices.forEach((c) => {
    if (counts[c] !== undefined) counts[c] += 1;
  });
  const max = Math.max(counts.slow, counts.normal, counts.fast);
  if (max === 0) return "normal";
  const tops = SPEED_CHOICES.filter((c) => counts[c] === max);
  return tops.length === 1 ? tops[0] : "normal";
}

function normalizePlate(plate) {
  const p = String(plate == null ? "" : plate).trim();
  if (p === "") return "";
  if (!PLATE_RE.test(p)) return null;
  return p;
}

async function getVehicleInfo(table, vehicleId, openid) {
  const v = await table("vehicles").select().eq("vehicle_id", vehicleId);
  if (v.error) return { errCode: -1, errMsg: "查询车辆失败: " + v.error.message };
  if (!v.data || v.data.length === 0) return { errCode: 0, exists: false };
  const veh = v.data[0];

  const r = await table("votes")
    .select()
    .eq("vehicle_id", vehicleId)
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (r.error) return { errCode: -1, errMsg: "查询投票失败: " + r.error.message };
  const votes = r.data || [];

  const counts = { slow: 0, normal: 0, fast: 0 };
  let myVote = null;
  votes.forEach((row) => {
    if (counts[row.choice] !== undefined) counts[row.choice] += 1;
    if (row.openid === openid) myVote = row.choice;
  });
  const recent = votes.slice(0, 3).map((row) => row.choice);
  return {
    errCode: 0,
    exists: true,
    vehicle: {
      vehicleId: veh.vehicle_id,
      plate: veh.plate || "",
      createdAt: veh.created_at,
    },
    counts: { ...counts, total: votes.length },
    myVote,
    recent,
    status: computeStatus(recent),
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { type } = event;
  const table = makeTable();

  try {
    switch (type) {
      // 扫码进入：车不存在则自动建档（车牌留空），存在则直接返回
      case "ensureVehicle": {
        const vehicleId = String(event.vehicleId || "");
        if (!VEHICLE_ID_RE.test(vehicleId)) {
          return { errCode: 1, errMsg: "车号格式不正确" };
        }
        const found = await table("vehicles").select().eq("vehicle_id", vehicleId);
        if (found.error) return { errCode: -1, errMsg: "查询失败: " + found.error.message };
        if (found.data && found.data.length) return { errCode: 0, created: false };
        const ins = await table("vehicles").insert({
          vehicle_id: vehicleId,
          plate: "",
        });
        if (ins.error) {
          // 唯一键冲突说明并发下已被创建，视为已存在；其余错误如实返回
          if (/duplicate|23505/i.test(ins.error.message || "")) {
            return { errCode: 0, created: false };
          }
          return { errCode: -1, errMsg: "建档失败: " + ins.error.message };
        }
        return { errCode: 0, created: true };
      }

      case "getVehicle": {
        const vehicleId = String(event.vehicleId || "");
        if (!VEHICLE_ID_RE.test(vehicleId)) {
          return { errCode: 1, errMsg: "车号格式不正确" };
        }
        return await getVehicleInfo(table, vehicleId, OPENID);
      }

      // 投票 / 改票：一人一车一票，重复投票即覆盖并刷新时间戳
      case "vote": {
        const vehicleId = String(event.vehicleId || "");
        const choice = String(event.choice || "");
        if (!VEHICLE_ID_RE.test(vehicleId)) {
          return { errCode: 1, errMsg: "车号格式不正确" };
        }
        if (SPEED_CHOICES.indexOf(choice) < 0) {
          return { errCode: 1, errMsg: "无效的速度选项" };
        }
        const veh = await table("vehicles").select().eq("vehicle_id", vehicleId);
        if (veh.error) return { errCode: -1, errMsg: "查询失败: " + veh.error.message };
        if (!veh.data || veh.data.length === 0) {
          return { errCode: 2, errMsg: "库内不包含此车" };
        }
        const mine = await table("votes")
          .select()
          .eq("vehicle_id", vehicleId)
          .eq("openid", OPENID);
        if (mine.error) return { errCode: -1, errMsg: "查询失败: " + mine.error.message };
        const nowIso = new Date().toISOString();
        if (mine.data && mine.data.length) {
          const u = await table("votes")
            .update({ choice, updated_at: nowIso })
            .eq("vehicle_id", vehicleId)
            .eq("openid", OPENID);
          if (u.error) return { errCode: -1, errMsg: "更新投票失败: " + u.error.message };
        } else {
          const i = await table("votes").insert({
            vehicle_id: vehicleId,
            openid: OPENID,
            choice,
            updated_at: nowIso,
          });
          if (i.error) {
            // 并发首投撞唯一键时退化为更新
            const u = await table("votes")
              .update({ choice, updated_at: nowIso })
              .eq("vehicle_id", vehicleId)
              .eq("openid", OPENID);
            if (u.error) return { errCode: -1, errMsg: "记录投票失败: " + u.error.message };
          }
        }
        return await getVehicleInfo(table, vehicleId, OPENID);
      }

      // 修改车牌号，并留存修改记录以便纠错
      case "updatePlate": {
        const vehicleId = String(event.vehicleId || "");
        const plate = normalizePlate(event.plate);
        if (!VEHICLE_ID_RE.test(vehicleId)) {
          return { errCode: 1, errMsg: "车号格式不正确" };
        }
        if (plate === null) {
          return { errCode: 1, errMsg: "车牌号应为 6 位数字" };
        }
        const veh = await table("vehicles").select().eq("vehicle_id", vehicleId);
        if (veh.error) return { errCode: -1, errMsg: "查询失败: " + veh.error.message };
        if (!veh.data || veh.data.length === 0) {
          return { errCode: 2, errMsg: "库内不包含此车" };
        }
        const oldPlate = String(veh.data[0].plate || "");
        if (oldPlate !== plate) {
          const u = await table("vehicles").update({ plate }).eq("vehicle_id", vehicleId);
          if (u.error) return { errCode: -1, errMsg: "保存失败: " + u.error.message };
          const log = await table("plate_logs").insert({
            vehicle_id: vehicleId,
            old_plate: oldPlate,
            new_plate: plate,
            openid: OPENID,
          });
          if (log.error) console.error("plate_logs 写入失败", log.error.message);
        }
        return { errCode: 0, plate };
      }

      // 收录总数：扫码建档（有车号）即算收录，车牌号可有可无
      case "countVehicles": {
        const r = await table("vehicles").select("vehicle_id", {
          count: "exact",
          head: true,
        });
        if (r.error) return { errCode: -1, errMsg: "统计失败: " + r.error.message };
        return { errCode: 0, count: r.count || 0 };
      }

      // 车辆列表：全部车辆及各自速度状态；神速在前、普速次之、慢速最后，同状态按车号升序
      case "listVehicles": {
        const v = await table("vehicles").select().limit(1000);
        if (v.error) return { errCode: -1, errMsg: "查询失败: " + v.error.message };
        // 全局按时间倒序取投票，再按车号分组取前 3 条计算状态（校园规模单次 1000 条够用）
        const r = await table("votes")
          .select()
          .order("updated_at", { ascending: false })
          .limit(1000);
        if (r.error) return { errCode: -1, errMsg: "查询失败: " + r.error.message };
        const votesByVehicle = {};
        (r.data || []).forEach((row) => {
          (votesByVehicle[row.vehicle_id] =
            votesByVehicle[row.vehicle_id] || []).push(row);
        });
        const STATUS_ORDER = { fast: 0, normal: 1, slow: 2 };
        const list = (v.data || []).map((veh) => {
          const votes = (votesByVehicle[veh.vehicle_id] || [])
            .slice(0, 3)
            .map((x) => x.choice);
          return {
            vehicleId: veh.vehicle_id,
            plate: veh.plate || "",
            status: computeStatus(votes),
          };
        });
        list.sort((a, b) => {
          const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          return d !== 0 ? d : a.vehicleId.localeCompare(b.vehicleId);
        });
        return { errCode: 0, list };
      }

      // 查询某辆车最近一次被使用辅助找车的时间
      case "getLastFind": {
        const vehicleId = String(event.vehicleId || "");
        if (!VEHICLE_ID_RE.test(vehicleId)) {
          return { errCode: 1, errMsg: "车号格式不正确" };
        }
        const r = await table("find_logs")
          .select("created_at")
          .eq("vehicle_id", vehicleId)
          .order("created_at", { ascending: false })
          .limit(1);
        if (r.error) return { errCode: -1, errMsg: "查询失败: " + r.error.message };
        return { errCode: 0, lastFindAt: r.data && r.data[0] ? r.data[0].created_at : null };
      }

      // 找车行为审计日志：谁在何时对哪辆车按了「去找车」
      case "logFind": {
        const vehicleId = String(event.vehicleId || "");
        if (!VEHICLE_ID_RE.test(vehicleId)) {
          return { errCode: 1, errMsg: "车号格式不正确" };
        }
        await table("find_logs").insert({
          vehicle_id: vehicleId,
          openid: OPENID,
        });
        return { errCode: 0 };
      }

      default:
        return { errCode: 1, errMsg: "未知操作类型" };
    }
  } catch (e) {
    console.error("bike 云函数异常", type, e);
    return { errCode: -1, errMsg: "服务异常: " + ((e && e.message) || String(e)) };
  }
};
