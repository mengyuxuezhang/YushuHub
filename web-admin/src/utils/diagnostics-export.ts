type Diagnostics = Record<string, unknown>;

function text(value: unknown, fallback = "未提供") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

export function diagnosticsFilename(generatedAt?: unknown) {
  const date = new Date(String(generatedAt || Date.now()));
  const stamp = Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
  return `agent-ai-diagnostics-${stamp.replace(/[:.]/g, "-")}.log`;
}

export function formatDiagnosticsReport(diagnostics: Diagnostics) {
  const updateUrls = Array.isArray(diagnostics.updateCheckUrls)
    ? diagnostics.updateCheckUrls
        .map((item: any) => `- ${text(item?.projectId)}: ${text(item?.latestUrl)}`)
        .join("\n")
    : "未提供";
  const recentBuilds = Array.isArray(diagnostics.recentBuilds)
    ? diagnostics.recentBuilds
        .map((item: any) => `- ${text(item?.projectId)} / ${text(item?.id)} / ${text(item?.status)}`)
        .join("\n")
    : "未提供";

  return [
    "Agent AI 管理后台诊断报告",
    `生成时间: ${text(diagnostics.generatedAt)}`,
    `管理端版本: ${text(diagnostics.version)}`,
    `Node.js: ${text(diagnostics.node)}`,
    `进程名称: ${text(diagnostics.pm2Name)}`,
    `监听地址: ${text(diagnostics.listen)}`,
    `后台 API: ${text(diagnostics.apiCheckUrl)}`,
    `客户端注册: ${text(diagnostics.clientRegisterUrl)}`,
    `更新地址模板: ${text(diagnostics.updateCheckExampleUrl)}`,
    "",
    "[项目更新地址]",
    updateUrls || "未提供",
    "",
    "[最近构建]",
    recentBuilds || "未提供",
    "",
    "[应用日志]",
    text(diagnostics.appLogTail, "暂无日志"),
    "",
    "[系统更新日志]",
    text(diagnostics.selfUpdateLogTail, "暂无日志"),
    "",
    "[完整诊断数据]",
    JSON.stringify(diagnostics, null, 2),
    "",
  ].join("\n");
}
