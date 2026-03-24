import { expect, test } from '@playwright/test';

import {
  CAR_MODE_SCRIPT,
  PARTNER_LEAD_SCRIPT,
  selectCharacter,
  setupRehearsalApp,
} from './helpers/rehearsal-app';

test.describe('rehearsal browser e2e', () => {
  test('lets you choose a character and advances from partner speech to your cue', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: null,
    });

    await expect(page.getByText('E2E Rehearsal')).toBeVisible();
    await selectCharacter(page, 'BOB');
    await page.getByTestId('button-start-rehearsal').click();

    await expect(page.getByTestId('line-0')).toContainText('Partner opening.');
    await expect(page.getByTestId('line-1')).toContainText('Recall your line...');
  });

  test('records and scores a user line with mocked browser media and OpenAI responses', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
      transcriptionText: 'My cue line.',
    });

    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('line-1')).toContainText('Recall your line...');

    await page.getByTestId('button-record').click();
    await expect(page.getByTestId('button-stop-recording')).toBeVisible();
    await page.getByTestId('button-stop-recording').click({ force: true });

    await expect(page.getByTestId('line-1')).toContainText('100%');
    await expect(page.getByTestId('line-1')).toContainText('Transcribed');
    await expect(page.getByTestId('line-1')).toContainText('My cue line.');
    await expect(page.getByTestId('button-next')).toBeVisible();
  });

  test('car mode requests wake lock and responds to media next/previous track controls', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      carMode: true,
      microphoneMode: 'pending',
      script: CAR_MODE_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await page.getByTestId('button-start-rehearsal').click();

    await expect(page.getByText('Screen awake')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (
              window as Window & {
                __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
              }
            ).__e2eMediaSessionHandlers?.nexttrack,
          ),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __e2eWakeLockRequests?: number;
              }
            ).__e2eWakeLockRequests ?? 0,
        ),
      )
      .toBeGreaterThan(0);

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.nexttrack?.();
    });

    await expect(page.getByTestId('line-1')).toContainText('Recall your line...');
    await expect(page.getByTestId('line-1')).toHaveClass(/ring-2/);

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.previoustrack?.();
    });

    await expect(page.getByTestId('line-0')).toHaveClass(/ring-2/);
    await expect(page.getByTestId('line-0')).toContainText('Recall your line...');
  });
});
