// DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
//
// API client for the value-realized layer. These endpoints compose figures the
// rest of the platform already computes - approved-change exposure managed, cost
// recovered, admin hours given back and a documented dispute-risk proxy - into a
// project and portfolio value-realized view, plus an adoption-vs-non-adoption
// benchmark on the firm's own projects. Money and rates are carried on the wire
// as strings and passed straight to MoneyDisplay, never coerced here.

import { apiGet } from '@/shared/lib/api';
import type { AdoptionBenchmark, HoursSaved, ValueSummary } from './types';

const BASE = '/v1/value';

export function getValueSummary(projectId: string): Promise<ValueSummary> {
  return apiGet<ValueSummary>(`${BASE}/projects/${projectId}/summary`);
}

export function getPortfolioSummary(): Promise<ValueSummary> {
  return apiGet<ValueSummary>(`${BASE}/portfolio/summary`);
}

export function getHoursSaved(projectId: string, by = 'feature'): Promise<HoursSaved> {
  return apiGet<HoursSaved>(`${BASE}/projects/${projectId}/hours-saved?by=${encodeURIComponent(by)}`);
}

export function getAdoptionBenchmark(): Promise<AdoptionBenchmark> {
  return apiGet<AdoptionBenchmark>(`${BASE}/adoption-benchmark`);
}
