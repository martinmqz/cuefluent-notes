import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { fail } from './workflow-values.mjs';

const budgets = new AsyncLocalStorage();
export function withWorkflowBudget({ milliseconds = 10000, bytes = 64 * 1024 * 1024, now = () => performance.now() } = {}, operation) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 10000 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64 * 1024 * 1024) fail('INVALID_WORKER_BUDGET');
  if (budgets.getStore()) fail('NESTED_WORKER_BUDGET');
  return budgets.run({ deadline: now() + milliseconds, remainingBytes: bytes, now }, operation);
}
export function checkWorkflowBudget() {
  const budget = budgets.getStore();
  if (budget && budget.now() >= budget.deadline) fail('WORKER_TIME_BUDGET');
}
export function workflowTimeout(maximum = 10000) {
  checkWorkflowBudget();
  const budget = budgets.getStore();
  return budget ? Math.max(1, Math.min(maximum, budget.deadline - budget.now())) : maximum;
}
export function consumeWorkflowBytes(bytes) {
  checkWorkflowBudget();
  const budget = budgets.getStore();
  if (!budget) return;
  if (bytes > budget.remainingBytes) fail('WORKER_READ_BUDGET');
  budget.remainingBytes -= bytes;
}
export function workflowReadLimit(maximum = 64 * 1024 * 1024) {
  checkWorkflowBudget();
  const budget = budgets.getStore();
  if (budget && budget.remainingBytes === 0) fail('WORKER_READ_BUDGET');
  return budget ? Math.min(maximum, budget.remainingBytes) : maximum;
}
