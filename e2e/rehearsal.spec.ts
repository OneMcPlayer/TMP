import { expect, test } from '@playwright/test';

import {
  CAR_MODE_SCRIPT,
  completeDeviceSetup,
  PARTNER_LEAD_SCRIPT,
  selectCharacter,
  setupRehearsalApp,
} from './helpers/rehearsal-app';

test.describe('rehearsal browser e2e', () => {
  test('keeps the settings button available on the launch screen', async ({ page }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
    });

    const settingsButton = page.getByTestId('button-toggle-setup');
    await expect(settingsButton).toBeVisible();
    await settingsButton.click();
    await expect(page.getByText('Debug Logs')).toBeVisible();
    await settingsButton.click();
    await expect(page.getByText('Debug Logs')).toBeHidden();
  });

  test('lets you choose a character and advances from partner speech to your cue', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: null,
    });

    await expect(page.getByText('Set Up Before You Start')).toBeVisible();
    await completeDeviceSetup(page);
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

    await completeDeviceSetup(page);
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

  test('still scores a line when the recorder has already gone inactive before stop is requested', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      mediaRecorderAutoStopDelayMs: 50,
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
      transcriptionText: 'My cue line.',
    });

    await completeDeviceSetup(page);
    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('line-1')).toContainText('Recall your line...');

    await page.getByTestId('button-record').click();
    await expect(page.getByTestId('button-stop-recording')).toBeVisible();
    await page.waitForTimeout(100);
    await page.getByTestId('button-stop-recording').click({ force: true });

    await expect(page.getByTestId('line-1')).toContainText('100%');
    await expect(page.getByTestId('line-1')).toContainText('Transcribed');
    await expect(page.getByTestId('line-1')).toContainText('My cue line.');
  });

  test('ignores duplicate start requests while microphone access is still pending', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
      microphoneMode: 'controlled',
    });

    await page.getByTestId('button-prepare-device').click();
    await page.evaluate(() => {
      (
        window as Window & {
          __e2eResolveControlledGetUserMedia?: () => void;
        }
      ).__e2eResolveControlledGetUserMedia?.();
    });
    await expect(page.getByText('Device check complete.')).toBeVisible();
    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('line-1')).toContainText('Recall your line...');

    const recordButton = page.getByTestId('button-record');
    await recordButton.click();
    await recordButton.click();
    await recordButton.click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __e2eGetUserMediaCalls?: number;
              }
            ).__e2eGetUserMediaCalls ?? 0,
        ),
      )
      .toBe(2);

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eResolveControlledGetUserMedia?: () => void;
        }
      ).__e2eResolveControlledGetUserMedia?.();
    });

    await expect(page.getByTestId('button-stop-recording')).toBeVisible();
  });

  test('car mode requests wake lock and responds to media next/previous track controls', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      carMode: true,
      script: CAR_MODE_SCRIPT,
      selectedCharacter: 'BOB',
      transcriptionText: 'First solo cue.',
    });

    await completeDeviceSetup(page);
    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('button-toggle-setup')).toBeHidden();
    await expect(page.getByTestId('button-end-session')).toBeVisible();
    await expect(page.getByTestId('car-mode-stage')).toBeVisible();
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
    await page.waitForTimeout(1200);
    await expect(page.getByTestId('button-record')).toBeVisible();
    await expect(page.getByTestId('button-stop-recording')).toBeHidden();

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.nexttrack?.();
    });

    await expect(page.getByTestId('button-stop-recording')).toBeVisible();
    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.stop?.();
    });
    await expect(page.getByTestId('car-mode-stage')).toContainText('100% matched');

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.nexttrack?.();
    });

    await expect(page.getByTestId('car-mode-stage')).toContainText('Second solo cue.');
    await expect(page.getByTestId('car-mode-stage')).toContainText('Line 2');

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.previoustrack?.();
    });

    await expect(page.getByTestId('car-mode-stage')).toContainText('First solo cue.');
    await expect(page.getByTestId('car-mode-stage')).toContainText('Line 1');
  });

  test('ending a car-mode session returns to the launch screen before mode can be changed', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      carMode: true,
      script: CAR_MODE_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await completeDeviceSetup(page);
    await page.getByTestId('button-start-rehearsal').click();
    await page.getByTestId('button-end-session').click();

    await expect(page.getByText('Set Up Before You Start')).toBeVisible();
    await expect(page.getByTestId('button-mode-car')).toBeVisible();
  });

  test('car mode reuses the prepared microphone stream after device setup', async ({ page }) => {
    await setupRehearsalApp(page, {
      carMode: true,
      script: CAR_MODE_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await completeDeviceSetup(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __e2eGetUserMediaCalls?: number;
                }
              ).__e2eGetUserMediaCalls ?? 0,
          ),
      )
      .toBe(1);

    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('button-record')).toBeVisible();
    await page.getByTestId('button-record').click();
    await expect(page.getByTestId('button-stop-recording')).toBeVisible();

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __e2eGetUserMediaCalls?: number;
                }
              ).__e2eGetUserMediaCalls ?? 0,
          ),
      )
      .toBe(1);
  });

  test('re-enables blocked Safari correction playback and resumes the spoken correction', async ({ page }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
      transcriptionText: 'Something incorrect.',
    });

    await completeDeviceSetup(page);
    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('line-1')).toContainText('Recall your line...');

    await page.getByTestId('button-record').click();
    await expect(page.getByTestId('button-stop-recording')).toBeVisible();
    await page.getByTestId('button-stop-recording').click({ force: true });

    await expect(page.getByRole('button', { name: 'Hear Correct Line' })).toBeVisible();
    await page.evaluate(() => {
      (
        window as Window & {
          __e2eRejectNextAudioPlay?: boolean;
        }
      ).__e2eRejectNextAudioPlay = true;
    });
    await page.getByRole('button', { name: 'Hear Correct Line' }).click();

    await expect(page.getByText('Safari Needs One More Tap')).toBeVisible();
    await expect(page.getByTestId('button-reenable-audio')).toBeVisible();
    await page.getByTestId('button-reenable-audio').click();

    await expect(page.getByText('Safari Needs One More Tap')).toBeHidden();
    await expect(page.getByTestId('line-1')).toContainText('Correction spoken');
  });
});

test.describe('rehearsal mobile layout e2e', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('keeps feedback controls within the viewport on narrow mobile screens', async ({ page }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
      transcriptionText: 'Something incorrect.',
    });

    await completeDeviceSetup(page);
    await page.getByTestId('button-start-rehearsal').click();
    await page.getByTestId('button-record').click();
    await page.getByTestId('button-stop-recording').click({ force: true });

    await expect(page.getByRole('button', { name: 'Retry Line' })).toBeVisible();
    await expect(page.getByTestId('button-next')).toBeVisible();

    const viewportWidths = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    expect(viewportWidths.bodyScrollWidth).toBeLessThanOrEqual(viewportWidths.innerWidth + 1);
    expect(viewportWidths.documentScrollWidth).toBeLessThanOrEqual(viewportWidths.innerWidth + 1);
  });

  test('keeps the active car-mode session on a fixed mobile viewport without page scroll', async ({ page }) => {
    await setupRehearsalApp(page, {
      carMode: true,
      script: CAR_MODE_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await completeDeviceSetup(page);
    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('car-mode-stage')).toBeVisible();

    const viewportHeights = await page.evaluate(() => ({
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));

    expect(viewportHeights.bodyScrollHeight).toBeLessThanOrEqual(viewportHeights.innerHeight + 1);
    expect(viewportHeights.documentScrollHeight).toBeLessThanOrEqual(viewportHeights.innerHeight + 1);
  });
});
