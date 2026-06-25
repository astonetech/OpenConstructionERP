// DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Resolve a project id from the context store without a real store.
vi.mock('@/stores/useProjectContextStore', () => ({
  useProjectContextStore: (sel: (s: { activeProjectId: string }) => unknown) => sel({ activeProjectId: 'p-1' }),
}));

// Mock the feature api so no network happens.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getValueSummary: vi.fn(),
    getPortfolioSummary: vi.fn(),
    getHoursSaved: vi.fn(),
    getAdoptionBenchmark: vi.fn(),
  };
});

// Mock the shared http client (used for the projects fallback fetch).
vi.mock('@/shared/lib/api', () => ({
  apiGet: vi.fn().mockResolvedValue([]),
  apiPost: vi.fn(),
  getErrorMessage: (e: unknown) => String(e),
}));

// MoneyDisplay reads a preferences store for the number locale; give it one so
// the component renders a real formatted value rather than throwing.
vi.mock('@/stores/usePreferencesStore', () => ({
  usePreferencesStore: (sel: (s: { numberLocale: string }) => unknown) => sel({ numberLocale: 'en-US' }),
}));

import { getValueSummary, getPortfolioSummary, getAdoptionBenchmark } from '../api';
import { ValueDashboardPage } from '../ValueDashboardPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/value']}>
        <ValueDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getValueSummary).mockResolvedValue({
    project_id: 'p-1',
    by_currency: [
      {
        currency: 'EUR',
        overrun_exposure_managed: '1500.00',
        chargeable_total: '600.00',
        recovered_total: '150.00',
        absorbed_total: '0.00',
        recovery_rate: '0.2500',
        schedule_days_managed: '7',
        impact_count: 2,
        recovery_item_count: 1,
      },
    ],
    primary_currency: 'EUR',
    estimated_hours_saved: '1.00',
    dispute_risk_reduction: '0.2500',
    exposure_confidence: 'low',
    recovery_confidence: 'low',
    hours_confidence: 'low',
    risk_confidence: 'low',
    cost_position_percentile: null,
    impact_count: 2,
    recovery_item_count: 1,
    hours_sample: 2,
    activity_count: 3,
  });
  vi.mocked(getPortfolioSummary).mockResolvedValue({
    project_id: null,
    by_currency: [
      {
        currency: 'EUR',
        overrun_exposure_managed: '4000.00',
        chargeable_total: '0.00',
        recovered_total: '0.00',
        absorbed_total: '0.00',
        recovery_rate: null,
        schedule_days_managed: '6',
        impact_count: 2,
        recovery_item_count: 0,
      },
    ],
    primary_currency: 'EUR',
    estimated_hours_saved: '0.00',
    dispute_risk_reduction: null,
    exposure_confidence: 'low',
    recovery_confidence: 'none',
    hours_confidence: 'none',
    risk_confidence: 'none',
    cost_position_percentile: null,
    impact_count: 2,
    recovery_item_count: 0,
    hours_sample: 0,
    activity_count: 0,
  });
  vi.mocked(getAdoptionBenchmark).mockResolvedValue({
    project_scores: [
      { project_id: 'p-1', adoption: 0.8, cohort: 'high' },
      { project_id: 'p-2', adoption: 0.1, cohort: 'low' },
    ],
    comparisons: [
      {
        metric: 'recovery_rate',
        high_mean: 0.7,
        low_mean: 0.3,
        delta: 0.4,
        high_n: 1,
        low_n: 1,
        higher_is_better: true,
        favours_high: true,
        confidence: 'none',
      },
    ],
    confidence: 'none',
    high_count: 1,
    low_count: 1,
  });
});

describe('ValueDashboardPage', () => {
  it('renders the title and the project value headline', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Value Realized/i })).toBeInTheDocument();
    // The headline tiles render once the summary resolves. "Admin hours saved"
    // is unique to the hours tile; the recovery-rate sub-line renders the
    // percent form of the "0.2500" wire rate.
    await waitFor(() => {
      expect(screen.getByText(/Admin hours saved/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Recovery rate 25%/i)).toBeInTheDocument();
    // "Exposure managed" labels both the headline tile and the table column,
    // so it appears more than once - both are genuine renders of the data.
    expect(screen.getAllByText(/Exposure managed/i).length).toBeGreaterThanOrEqual(1);
  });

  it('switches to the adoption benchmark tab and shows the comparison', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Adoption benchmark/i }));
    await waitFor(() => {
      expect(screen.getByText(/Recovery rate/i)).toBeInTheDocument();
    });
    // The adopters cohort count tile shows 1 high-adoption project.
    expect(screen.getByText(/High-adoption projects/i)).toBeInTheDocument();
  });

  it('switches scope to the portfolio summary', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Portfolio/i }));
    await waitFor(() => {
      expect(getPortfolioSummary).toHaveBeenCalled();
    });
  });
});
