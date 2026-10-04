// pages/list/list.js
const { callBike } = require("../../utils/cloud.js");
const { findRushPeriod } = require("../../utils/rush.js");

const STATUS_META = {
  slow: { label: "慢速", cls: "slow" },
  normal: { label: "普速", cls: "normal" },
  fast: { label: "神速", cls: "fast" },
};

// 青桔「车号开车」页短链（失效时在青桔小程序内重新「复制链接」替换）
const QINGJU_SHORT_LINK = "#小程序://青桔/rZ6WMhfhlbtIFHG";

function pad2(n) {
  return String(n).padStart(2, "0");
}

Page({
  data: {
    loading: true,
    list: [],
    // 找车确认弹窗
    findModalShown: false,
    findVehicleId: "",
    findBtnRevealed: false,
    lastFindText: "",
    // 用车高峰期禁用提示弹窗
    rushModalShown: false,
    rushPeriod: null,
  },

  // 每次进入/返回都刷新，投票后回到列表能看到最新状态
  onShow() {
    this.fetchList();
  },

  fetchList() {
    callBike("listVehicles").then((r) => {
      if (r.errCode !== 0) {
        this.setData({ loading: false });
        wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
        return;
      }
      const list = (r.list || []).map((x) => ({
        ...x,
        statusLabel: STATUS_META[x.status].label,
        statusCls: STATUS_META[x.status].cls,
      }));
      this.setData({ loading: false, list });
    });
  },

  // ===== 辅助找车 =====

  // 点击神速车的「辅助找车」：先判断是否处于用车高峰期，再弹出强制阅读弹窗
  onFindTap(e) {
    const vehicleId = e.currentTarget.dataset.vehicleId;
    if (!vehicleId) return;

    // 用车高峰期禁用（奇数节课上下课时段，节假日除外）
    const rush = findRushPeriod(new Date());
    if (rush) {
      this.setData({
        rushModalShown: true,
        rushPeriod: rush.period,
        findModalShown: false,
      });
      return;
    }

    this.setData({
      findModalShown: true,
      findVehicleId: vehicleId,
      findBtnRevealed: false,
      lastFindText: "查询中…",
    });
    // 若声明内容不足一屏（无法触发 scrolltolower），直接解锁按钮
    setTimeout(() => this.checkModalScrollable(), 300);
    // 查询该车最近一次被使用辅助找车的时间（不阻塞弹窗展示）
    callBike("getLastFind", { vehicleId }).then((r) => {
      if (this.data.findVehicleId !== vehicleId || !this.data.findModalShown) return;
      if (r.errCode !== 0) {
        this.setData({ lastFindText: "" });
        return;
      }
      if (!r.lastFindAt) {
        this.setData({ lastFindText: "该车此前从未被使用辅助找车" });
        return;
      }
      const d = new Date(r.lastFindAt);
      this.setData({
        lastFindText: `该车上次被使用辅助找车：${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
      });
    });
  },

  // 声明内容没超出滚动区时 scrolltolower 永远不会触发，这里兜底解锁
  checkModalScrollable() {
    if (this.data.findBtnRevealed) return;
    const query = wx.createSelectorQuery();
    query.select(".modal-scroll").boundingClientRect();
    query.select(".modal-body").boundingClientRect();
    query.exec((res) => {
      const box = res && res[0];
      const body = res && res[1];
      if (!box || !body) return;
      if (body.height <= box.height + 8) {
        this.setData({ findBtnRevealed: true });
      }
    });
  },

  // 用户滑动到声明底部后解锁「辅助找车」按钮
  onModalReachBottom() {
    if (!this.data.findBtnRevealed) {
      this.setData({ findBtnRevealed: true });
    }
  },

  onModalCancel() {
    this.setData({ findModalShown: false });
  },

  onRushModalClose() {
    this.setData({ rushModalShown: false });
  },

  noop() {},

  // 复制车号并跳转青桔「车号开车」页
  onConfirmFind() {
    // 审计日志：记录本次辅助找车行为（不阻塞跳转）
    callBike("logFind", { vehicleId: this.data.findVehicleId });
    wx.setClipboardData({
      data: this.data.findVehicleId,
      success: () => {
        wx.navigateToMiniProgram({
          shortLink: QINGJU_SHORT_LINK,
          fail: (e) => {
            const msg = (e && e.errMsg) || "";
            if (msg.indexOf("cancel") < 0) {
              wx.showToast({ title: "跳转失败，请稍后重试", icon: "none" });
            }
          },
          complete: () => {
            this.setData({ findModalShown: false });
          },
        });
      },
    });
  },
});
