import { api } from './client'
import type { AdminUser, SessionPayload } from '@/types/auth'

export interface LoginCaptcha {
  challengeId: string
  imageDataUrl: string
  expiresInSeconds: number
}

export function getSession() {
  return api<SessionPayload>('/api/me')
}

export function getLoginCaptcha() {
  return api<LoginCaptcha>('/api/login/captcha')
}

export function login(username: string, password: string, challengeId: string, captchaAnswer: string) {
  return api<AdminUser>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, challengeId, captchaAnswer }),
  })
}

export function logout() {
  return api<void>('/api/logout', { method: 'POST' })
}
