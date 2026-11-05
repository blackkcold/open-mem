import type { ApiError } from "../api";

export function connectionHint(error: ApiError): string {
  if (error.status === 401) return "Token 已失效或与当前实例不匹配。请更换 Token 后重新连接。";
  if (error.code === "NO_SERVICE" || error.code === "NOT_GRANTED") {
    return "在 OpenChamber 的 设置 → 扩展 中允许 OpenMem 的本地服务，然后重试。";
  }
  if (error.code === "DISABLED") {
    return "OpenMem 扩展当前被暂停。请在 设置 → 扩展 中重新启用。";
  }
  if (error.code === "SERVICE_FAILED") {
    return "扩展服务没有成功启动。重试会重新拉起服务；如果仍失败，请查看 OpenChamber 日志。";
  }
  if (error.code === "OPENMEM_OFFLINE" || error.status === 0) {
    return "确认 OpenCode 正在运行，并且 opencode.json 已加载 OpenMem 插件。";
  }
  return "检查 OpenChamber 的扩展服务状态，然后重试。";
}
