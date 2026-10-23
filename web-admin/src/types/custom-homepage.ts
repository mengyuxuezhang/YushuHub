export interface CustomHomepageStatus {
  enabled: boolean
  configured: boolean
  updatedAt: string
  sourceName: string
  fileCount: number
  totalBytes: number
  previewUrl: string
  limits: {
    archiveBytes: number
    extractedBytes: number
    files: number
    htmlBytes: number
  }
}
