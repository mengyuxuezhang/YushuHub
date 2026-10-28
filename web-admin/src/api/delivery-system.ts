import { api } from "./client";
import type { PageQuery, PageResult } from "@/types/pagination";
import { pageQueryString } from "@/types/pagination";

export interface ReleaseHistoryItem {
  version: string;
  publishedAt?: string;
  releaseNotes?: string;
}

export interface AgentSourceVersionInfo extends ReleaseHistoryItem {
  configured: boolean;
  commit?: string;
  source?: string;
  stale?: boolean;
  error?: string;
  history: ReleaseHistoryItem[];
}
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
export const listProjects = () => api<any[]>("/api/projects");
export const saveProject = (input: Record<string, unknown>) =>
  api<any>("/api/projects", json({ ...input, clientMode: "personal" }));
export const deleteProject = (id: string) =>
  api<any>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
export const uploadProjectAsset = (filename: string, dataUrl: string) =>
  api<{ url: string }>("/api/uploads", json({ filename, dataUrl }));
export const listBuilds = () => api<any[]>("/api/builds?sync=1&view=list");
export const listBuildPage = (query: PageQuery = {}) => {
  const suffix = pageQueryString(query);
  return api<PageResult<any>>(`/api/builds${suffix ? `${suffix}&` : "?"}sync=1&view=list`);
};
export const listWorkers = () => api<any[]>("/api/workers");
export const getAgentSourceVersion = (fullHistory = false) =>
  api<AgentSourceVersionInfo>(`/api/source-version${fullHistory ? '?history=all' : ''}`);
export const createBuild = (projectId: string, version = "") =>
  api<any>("/api/builds", json({ projectId, version }));
export const retryBuild = (id: string) =>
  api<any>(`/api/builds/${encodeURIComponent(id)}/retry`, json({}));
export const finishBuild = (id: string) =>
  api<any>(
    `/api/builds/${encodeURIComponent(id)}/finish`,
    json({ reason: "管理员手动结束构建任务" }),
  );
export const publishBuild = (id: string) =>
  api<any>(`/api/builds/${encodeURIComponent(id)}/publish`, json({}));
export const getSettings = () => api<any>("/api/platform-settings");
export const saveSettings = (input: Record<string, unknown>) =>
  api<any>("/api/platform-settings", json(input));
export const testSmtp = (email: string) =>
  api<any>("/api/platform-settings/smtp-test", json({ email }));
export const getDiagnostics = () => api<any>("/api/diagnostics");
export const getSelfUpdateStatus = (fullHistory = false) => api<any>(`/api/self-update/status${fullHistory ? '?history=all' : ''}`);
export const saveSelfUpdateSource = (manifestUrl: string) =>
  api<any>("/api/self-update/config", json({ manifestUrl }));
export const applySelfUpdate = () => api<any>("/api/self-update/apply", json({}));
export const changePassword = (oldPassword: string, newPassword: string) =>
  api<any>("/api/me/password", json({ oldPassword, newPassword }));
