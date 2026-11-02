import { HttpError } from './auth';
import { isIsoDate } from '../shared/dates';

export function str(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required.`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return s;
}

export function optStr(v: unknown, field: string, max = 5000): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return s || null;
}

export function int(v: unknown, field: string, min = -1e9, max = 1e9): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

export function optInt(v: unknown, field: string, min?: number, max?: number): number | null {
  if (v === undefined || v === null || v === '') return null;
  return int(v, field, min, max);
}

export function oneOf<T extends string>(v: unknown, field: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !options.includes(v as T)) {
    throw new HttpError(400, `${field} must be one of: ${options.join(', ')}.`);
  }
  return v as T;
}

export function date(v: unknown, field: string): string {
  if (!isIsoDate(v)) throw new HttpError(400, `${field} must be a date (YYYY-MM-DD).`);
  return v;
}

export function optDate(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return date(v, field);
}

export function idParam(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found.');
  return n;
}
