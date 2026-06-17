/**
 * Tests for the calibration dialog:
 *   1. deriveScale with known pixel distance + real length returns the
 *      expected pixelsPerUnit ratio.
 *   2. Unit conversion round-trip (toMeters → fromMeters) is stable.
 *   3. Confirm button fires onConfirm with a ScaleConfig that matches
 *      the user's input once multiplied through the unit factor.
 */

// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CalibrationDialog } from '../components/CalibrationDialog';
import { takeoffApi } from '../api';
import {
  deriveScale,
  toMeters,
  fromMeters,
  formatScaleRatio,
  ratioFromScale,
  presetScale,
} from '../../../modules/pdf-takeoff/data/scale-helpers';

describe('deriveScale', () => {
  it('returns the expected px-per-unit for a known pair', () => {
    // 500 pixels == 5 meters  →  100 px/m
    expect(deriveScale(500, 5).pixelsPerUnit).toBe(100);
  });

  it('handles the canonical 1:50 mapping used by the UI presets', () => {
    // 72 dpi / (0.0254 m/in * 50) = the `pixelsPerUnit` the preset buttons use.
    const pxPerM = 72 / (0.0254 * 50);
    const scale = { pixelsPerUnit: pxPerM, unitLabel: 'm' };
    expect(ratioFromScale(scale)).toBe(50);
    expect(formatScaleRatio(scale)).toBe('1:50');
  });

  it('returns an INVALID scale (never a silent 1:1) on bad input', () => {
    // D-TKC-010: the old 1 px = 1 m fallback turned a 28 346 px line
    // into "28 346 m". Bad calibration must be explicitly invalid so
    // downstream conversions yield nothing and the user re-calibrates.
    for (const s of [deriveScale(0, 5), deriveScale(500, 0), deriveScale(-1, 5)]) {
      expect(s.pixelsPerUnit).toBe(0);
      expect(s.invalid).toBe(true);
    }
  });
});

describe('unit round-trip', () => {
  it('converts meters ↔ meters identically', () => {
    expect(fromMeters(toMeters(7, 'm'), 'm')).toBeCloseTo(7, 10);
  });

  it('converts mm round-trip', () => {
    expect(fromMeters(toMeters(1234, 'mm'), 'mm')).toBeCloseTo(1234, 10);
  });

  it('converts ft round-trip', () => {
    expect(fromMeters(toMeters(10, 'ft'), 'ft')).toBeCloseTo(10, 10);
  });

  it('converts in round-trip', () => {
    expect(fromMeters(toMeters(120, 'in'), 'in')).toBeCloseTo(120, 10);
  });

  it('known feet-to-meters conversion', () => {
    // 1 ft == 0.3048 m
    expect(toMeters(1, 'ft')).toBeCloseTo(0.3048, 4);
  });
});

describe('CalibrationDialog', () => {
  it('confirm fires onConfirm with a ScaleConfig derived from input', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CalibrationDialog
        pixelDistance={500}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    // Default unit is m, default real length is 1 — change to 5.
    const input = screen.getByTestId('calibration-length-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('calibration-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const scale = onConfirm.mock.calls[0][0];
    expect(scale.pixelsPerUnit).toBe(100); // 500 px / 5 m
    expect(scale.unitLabel).toBe('m');
  });

  it('feet input is converted to meters before derivation', () => {
    const onConfirm = vi.fn();
    render(
      <CalibrationDialog
        pixelDistance={500}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const unitSelect = screen.getByTestId('calibration-unit-select') as HTMLSelectElement;
    fireEvent.change(unitSelect, { target: { value: 'ft' } });
    const input = screen.getByTestId('calibration-length-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('calibration-confirm'));

    const scale = onConfirm.mock.calls[0][0];
    // 10 ft == 3.048 m   →   500 / 3.048 ≈ 164.04 px/m
    expect(scale.pixelsPerUnit).toBeCloseTo(500 / (10 * 0.3048), 3);
  });

  it('confirm is disabled while the real-length input is non-positive', () => {
    const onConfirm = vi.fn();
    render(
      <CalibrationDialog
        pixelDistance={500}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByTestId('calibration-length-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    const confirm = screen.getByTestId('calibration-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('Escape key closes the dialog', () => {
    const onCancel = vi.fn();
    render(
      <CalibrationDialog
        pixelDistance={500}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('calibration-length-input'), {
      key: 'Escape',
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT call detectScale and shows no banner when no documentId', () => {
    const spy = vi.spyOn(takeoffApi, 'detectScale');
    render(
      <CalibrationDialog pixelDistance={500} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('detected-scale-banner')).toBeNull();
    spy.mockRestore();
  });
});

describe('CalibrationDialog scale auto-detect', () => {
  it('shows the detected scale and applies it through onConfirm', async () => {
    const onConfirm = vi.fn();
    vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue({
      best: {
        ratio: 100,
        label: '1:100',
        confidence: 0.95,
        page: 1,
        evidence: 'SCALE 1:100',
        source: 'ratio',
        detail: {},
      },
      candidates: [
        {
          ratio: 100,
          label: '1:100',
          confidence: 0.95,
          page: 1,
          evidence: 'SCALE 1:100',
          source: 'ratio',
          detail: {},
        },
      ],
      source: 'text_layer',
    });

    render(
      <CalibrationDialog
        pixelDistance={500}
        page={1}
        documentId="doc-1"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Banner appears once detection resolves.
    const useBtn = await screen.findByTestId('detected-scale-use');
    expect(screen.getByTestId('detected-scale-banner')).toBeTruthy();

    fireEvent.click(useBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // The applied scale equals the canonical preset for 1:100.
    const scale = onConfirm.mock.calls[0][0];
    expect(scale.pixelsPerUnit).toBeCloseTo(presetScale(100).pixelsPerUnit, 6);
    expect(scale.unitLabel).toBe('m');
  });

  it('prefers a candidate on the current page over the document-wide best', async () => {
    const onConfirm = vi.fn();
    vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue({
      best: { ratio: 100, label: '1:100', confidence: 0.95, page: 1, evidence: 'SCALE 1:100', source: 'ratio', detail: {} },
      candidates: [
        { ratio: 100, label: '1:100', confidence: 0.95, page: 1, evidence: 'SCALE 1:100', source: 'ratio', detail: {} },
        { ratio: 20, label: '1:20', confidence: 0.95, page: 3, evidence: 'SCALE 1:20', source: 'ratio', detail: {} },
      ],
      source: 'text_layer',
    });

    render(
      <CalibrationDialog
        pixelDistance={500}
        page={3}
        documentId="doc-1"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Page 3's own scale (1:20) is offered, not the page-1 best.
    await screen.findByTestId('detected-scale-use');
    expect(screen.getByTestId('detected-scale-banner').textContent).toContain('1:20');
    fireEvent.click(screen.getByTestId('detected-scale-use'));
    const scale = onConfirm.mock.calls[0][0];
    expect(scale.pixelsPerUnit).toBeCloseTo(presetScale(20).pixelsPerUnit, 6);
  });

  it('shows no banner when the backend detects no scale', async () => {
    vi.spyOn(takeoffApi, 'detectScale').mockResolvedValue({
      best: null,
      candidates: [],
      source: 'text_layer',
    });
    render(
      <CalibrationDialog pixelDistance={500} documentId="doc-1" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // Manual input always renders; the suggestion banner never does.
    await screen.findByTestId('calibration-length-input');
    await waitFor(() => expect(screen.queryByTestId('detected-scale-banner')).toBeNull());
  });

  it('does not surface an error when detection throws', async () => {
    vi.spyOn(takeoffApi, 'detectScale').mockRejectedValue(new Error('network'));
    render(
      <CalibrationDialog pixelDistance={500} documentId="doc-1" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // The manual calibration path keeps working; no banner, no throw.
    await screen.findByTestId('calibration-length-input');
    await waitFor(() => expect(screen.queryByTestId('detected-scale-banner')).toBeNull());
  });
});
