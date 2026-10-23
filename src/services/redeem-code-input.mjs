export function redeemBatchName(input = {}, fallback = '') {
  return String(input.batchName || input.name || fallback).trim().slice(0, 120)
}
