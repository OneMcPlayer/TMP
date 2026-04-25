import { expect, test } from '@playwright/test';

import {
  CAR_MODE_SCRIPT,
  completeDeviceSetup,
  type MockScript,
  PARTNER_LEAD_SCRIPT,
  selectCharacter,
  setupRehearsalApp,
} from './helpers/rehearsal-app';

const TAP_REHEARSAL_SCRIPT: MockScript = {
  title: 'Tap E2E',
  author: 'Playwright',
  language: 'en',
  lines: [
    { speaker: 'BOB', line: 'Correct first line.' },
    { speaker: 'ALICE', line: 'Partner bridge.' },
    { speaker: 'BOB', line: 'Second user line.' },
  ],
};

const TAP_REHEARSAL_BACKEND_URL = 'https://tap-e2e.local';

async function setupTapRealtimeBrowserMocks(page: Parameters<typeof setupRehearsalApp>[0]) {
  await page.addInitScript((backendUrl) => {
    localStorage.setItem('realtime_call_lab_backend_url', backendUrl);

    class FakeRTCDataChannel extends EventTarget {
      label: string;
      readyState: RTCDataChannelState = 'connecting';

      constructor(label: string) {
        super();
        this.label = label;
      }

      open() {
        if (this.readyState === 'open') {
          return;
        }

        this.readyState = 'open';
        this.dispatchEvent(new Event('open'));
      }

      send(data: string) {
        const parsedEvent = JSON.parse(data) as { type?: string };
        void fetch(`${backendUrl}/__e2e-data-channel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data,
        });

        if (parsedEvent.type === 'input_audio_buffer.clear') {
          window.setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  event_id: 'event_e2e_clear',
                  type: 'input_audio_buffer.cleared',
                }),
              }),
            );
          }, 0);
        }

        if (parsedEvent.type === 'input_audio_buffer.commit') {
          window.setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  event_id: 'event_e2e_commit',
                  item_id: 'item_e2e_user_audio',
                  type: 'input_audio_buffer.committed',
                }),
              }),
            );
          }, 0);
        }
      }

      close() {
        if (this.readyState === 'closed') {
          return;
        }

        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
      }
    }

    class FakeRTCPeerConnection extends EventTarget {
      connectionState: RTCPeerConnectionState = 'new';
      iceConnectionState: RTCIceConnectionState = 'new';
      iceGatheringState: RTCIceGatheringState = 'new';
      signalingState: RTCSignalingState = 'stable';
      localDescription: RTCSessionDescriptionInit | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      privateDataChannel: FakeRTCDataChannel | null = null;
      privateSenders: Array<{ track: { stop: () => void } }> = [];

      addTrack(track: { stop: () => void }) {
        const sender = { track };
        this.privateSenders.push(sender);
        return sender;
      }

      createDataChannel(label: string) {
        this.privateDataChannel = new FakeRTCDataChannel(label);
        return this.privateDataChannel;
      }

      async createOffer() {
        return {
          sdp: 'v=0\r\ns=Tap E2E Offer\r\n',
          type: 'offer' as RTCSdpType,
        };
      }

      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
        this.signalingState = 'have-local-offer';
        this.dispatchEvent(new Event('signalingstatechange'));
        this.iceGatheringState = 'gathering';
        this.dispatchEvent(new Event('icegatheringstatechange'));

        window.setTimeout(() => {
          this.iceGatheringState = 'complete';
          this.dispatchEvent(new Event('icegatheringstatechange'));
        }, 0);
      }

      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        this.remoteDescription = description;
        this.signalingState = 'stable';
        this.dispatchEvent(new Event('signalingstatechange'));
        this.iceConnectionState = 'connected';
        this.dispatchEvent(new Event('iceconnectionstatechange'));
        this.connectionState = 'connected';
        this.dispatchEvent(new Event('connectionstatechange'));
        const trackEvent = new Event('track') as Event & {
          streams: MediaStream[];
          track: { kind: string };
        };
        Object.defineProperty(trackEvent, 'streams', {
          configurable: true,
          value: [new MediaStream()],
        });
        Object.defineProperty(trackEvent, 'track', {
          configurable: true,
          value: { kind: 'audio' },
        });
        this.dispatchEvent(trackEvent);
        this.privateDataChannel?.open();
      }

      getSenders() {
        return this.privateSenders;
      }

      close() {
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.signalingState = 'closed';
        this.privateDataChannel?.close();
      }
    }

    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      writable: true,
      value: FakeRTCPeerConnection,
    });
  }, TAP_REHEARSAL_BACKEND_URL);
}

async function setupTapRealtimeBackendMocks(page: Parameters<typeof setupRehearsalApp>[0]) {
  let nextSpeechSeq = 1;
  let correctionTimestamp = '2026-04-25T10:00:00.000Z';
  let currentLine = {
    character: 'BOB',
    isUserLine: true,
    lineNumber: 1,
  };
  let correction: null | {
    accuracy: number;
    attempts: number;
    expectedText: string;
    lineNumber: number;
    spokenText: string;
    timestamp: string;
  } = null;
  let speech = [
    {
      purpose: 'user-turn-cue',
      seq: nextSpeechSeq++,
      text: 'Your line.',
      timestamp: '2026-04-25T10:00:00.000Z',
    },
  ];
  let committedWrongLine = false;

  await page.route(`${TAP_REHEARSAL_BACKEND_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const corsHeaders = {
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Origin': '*',
    };

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ headers: corsHeaders, status: 204 });
      return;
    }

    if (url.pathname === '/health') {
      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          openAiConfigured: true,
          uptimeSeconds: 10,
        }),
      });
      return;
    }

    if (url.pathname === '/api/realtime-webrtc/live-memorization/calls') {
      nextSpeechSeq = 2;
      correctionTimestamp = '2026-04-25T10:00:00.000Z';
      committedWrongLine = false;
      currentLine = {
        character: 'BOB',
        isUserLine: true,
        lineNumber: 1,
      };
      correction = null;
      speech = [
        {
          purpose: 'user-turn-cue',
          seq: 1,
          text: 'Your line.',
          timestamp: '2026-04-25T10:00:00.000Z',
        },
      ];
      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          answerSdp: 'v=0\r\ns=Tap E2E Answer\r\n',
          callId: 'rtc_e2e',
          mode: 'live-memorization',
          model: 'gpt-realtime',
          sessionId: 'tap-e2e-session',
          voice: 'alloy',
        }),
      });
      return;
    }

    if (url.pathname === '/__e2e-data-channel') {
      const payload = request.postDataJSON() as { type?: string };
      if (payload.type === 'input_audio_buffer.commit' && !committedWrongLine) {
        committedWrongLine = true;
        correctionTimestamp = '2026-04-25T10:00:01.000Z';
        correction = {
          accuracy: 0,
          attempts: 1,
          expectedText: 'Correct first line.',
          lineNumber: 1,
          spokenText: 'Wrong first line.',
          timestamp: correctionTimestamp,
        };
        speech.push({
          purpose: 'correction',
          seq: nextSpeechSeq++,
          text: 'Your line is: Correct first line.',
          timestamp: correctionTimestamp,
        });
      }

      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      });
      return;
    }

    if (url.pathname.endsWith('/live-memorization/audio-attempt')) {
      if (!committedWrongLine) {
        committedWrongLine = true;
        correctionTimestamp = '2026-04-25T10:00:01.000Z';
        correction = {
          accuracy: 0,
          attempts: 1,
          expectedText: 'Correct first line.',
          lineNumber: 1,
          spokenText: 'Wrong first line.',
          timestamp: correctionTimestamp,
        };
        speech.push({
          purpose: 'correction',
          seq: nextSpeechSeq++,
          text: 'Your line is: Correct first line.',
          timestamp: correctionTimestamp,
        });
      }

      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          callId: 'rtc_e2e',
          correction,
          currentLine,
          ok: true,
          sessionId: 'tap-e2e-session',
          speech,
          status: 'connected',
          transcript: 'Wrong first line.',
          turnCommitMode: 'manual',
        }),
      });
      return;
    }

    if (url.pathname.endsWith('/live-memorization/state')) {
      const afterSpeechSeq = Number.parseInt(url.searchParams.get('afterSpeechSeq') ?? '0', 10);
      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          callId: 'rtc_e2e',
          correction,
          currentLine,
          currentLineNumber: currentLine.lineNumber,
          speech: speech.filter((speechEvent) => speechEvent.seq > afterSpeechSeq),
          status: 'connected',
          turnCommitMode: 'manual',
        }),
      });
      return;
    }

    if (url.pathname.endsWith('/live-memorization/control')) {
      const payload = request.postDataJSON() as { command?: string };
      if (payload.command === 'skip') {
        correction = null;
        currentLine = {
          character: 'BOB',
          isUserLine: true,
          lineNumber: 3,
        };
        speech.push({
          purpose: 'partner-cue',
          seq: nextSpeechSeq++,
          text: 'Partner bridge.',
          timestamp: '2026-04-25T10:00:02.000Z',
        });
      }

      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          queuedResponses: 1,
          sessionId: 'tap-e2e-session',
          status: 'connected',
        }),
      });
      return;
    }

    if (url.pathname.includes('/live-memorization/speech/') && url.pathname.endsWith('/audio')) {
      await route.fulfill({
        contentType: 'audio/mpeg',
        headers: corsHeaders,
        body: 'tap-e2e-audio',
      });
      return;
    }

    if (url.pathname.endsWith('/logs')) {
      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          callId: 'rtc_e2e',
          logs: [],
          sessionId: 'tap-e2e-session',
          status: 'connected',
        }),
      });
      return;
    }

    if (url.pathname.endsWith('/client-logs') || url.pathname === '/api/realtime-webrtc/client-logs') {
      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ accepted: 1, ok: true }),
      });
      return;
    }

    if (url.pathname.endsWith('/end')) {
      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      });
      return;
    }

    await route.fulfill({
      contentType: 'application/json',
      headers: corsHeaders,
      status: 404,
      body: JSON.stringify({ error: `Unhandled tap backend mock path: ${url.pathname}` }),
    });
  });
}

test.describe('rehearsal browser e2e', () => {
  test('opens the audio lab wizard, records media control events, and keeps the log for export', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await page.getByTestId('button-open-audio-lab').click();
    await expect(page.getByTestId('audio-lab-page')).toBeVisible();
    await expect(page.getByTestId('audio-lab-step-title')).toContainText('Capture The Baseline Snapshot');
    await page.getByTestId('button-audio-lab-capture-environment').click();
    await page.getByTestId('button-audio-lab-next-step').click();
    await expect(page.getByTestId('audio-lab-step-title')).toContainText('Try Next And Back Before Any Other Audio');
    await page.getByTestId('button-audio-lab-metadata-probe').click();

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.nexttrack?.();
    });

    await expect(page.getByTestId('audio-lab-next-count')).toHaveText('1');
    await expect(page.getByTestId('audio-lab-probe-mode')).toContainText('metadata-only');

    await page.getByTestId('button-audio-lab-step-summary').click();
    await expect(page.getByTestId('audio-lab-step-title')).toContainText('Review The Findings And Export Everything');
    await expect(page.getByTestId('audio-lab-log')).toContainText('action=nexttrack | count=1');
  });

  test('opens the realtime browser lab from the launch screen', async ({ page }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await page.getByTestId('button-open-realtime-lab').click();
    await expect(page.getByTestId('realtime-call-lab-page')).toBeVisible();
    await expect(page.getByText('WebRTC Call Spike')).toBeVisible();
    await expect(page.getByTestId('button-realtime-start')).toBeVisible();
  });

  test('opens the live memorization page from the launch screen', async ({ page }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await page.getByTestId('button-open-live-memorization').click();
    await expect(page.getByTestId('live-memorization-page')).toBeVisible();
    await expect(page.getByText('Realtime Script Coach')).toBeVisible();
    await expect(page.getByTestId('button-live-memorization-start')).toBeVisible();
  });

  test('opens the tap rehearsal page from the launch screen', async ({ page }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await page.getByTestId('button-open-tap-rehearsal').click();
    await expect(page.getByTestId('tap-rehearsal-page')).toBeVisible();
    await expect(page.getByText('Stage Mode Prototype')).toBeVisible();
    await expect(page.getByTestId('button-tap-rehearsal-start')).toBeVisible();
  });

  test('tap rehearsal recovers after a spoken correction and can skip forward', async ({
    page,
  }) => {
    await setupTapRealtimeBrowserMocks(page);
    await setupTapRealtimeBackendMocks(page);
    await setupRehearsalApp(page, {
      script: TAP_REHEARSAL_SCRIPT,
      selectedCharacter: 'BOB',
      startUrl: process.env.PLAYWRIGHT_START_URL ?? '/',
    });

    await page.getByTestId('button-open-tap-rehearsal').click();
    await page.getByTestId('button-tap-rehearsal-start').click();

    const lineDoneButton = page.getByTestId('button-tap-rehearsal-line-done');
    await expect(lineDoneButton).toContainText('Line Done');
    await lineDoneButton.click();

    await expect(page.getByTestId('tap-rehearsal-correction')).toContainText('Correct first line.');
    await expect(lineDoneButton).toContainText('Line Done');
    await expect(lineDoneButton).toBeEnabled();

    await page.getByTestId('button-tap-rehearsal-skip').click();

    await expect(page.getByTestId('tap-rehearsal-correction')).toBeHidden();
    await expect(page.getByText('Line 3')).toBeVisible();
    await expect(lineDoneButton).toContainText('Line Done');
    await expect(lineDoneButton).toBeEnabled();
  });

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

  test('can disable auto-played partner audio and still advance to the next cue', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      autoPlayAudio: false,
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await completeDeviceSetup(page);
    const audioPlayCallsAfterSetup = await page.evaluate(
      () =>
        (
          window as Window & {
            __e2eAudioPlayCalls?: number;
          }
        ).__e2eAudioPlayCalls ?? 0,
    );

    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('line-1')).toContainText('Recall your line...');
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __e2eAudioPlayCalls?: number;
                }
              ).__e2eAudioPlayCalls ?? 0,
          ),
      )
      .toBe(audioPlayCallsAfterSetup);
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

  test('retries after a tiny warm-up recording blob and succeeds on the second take', async ({
    page,
  }) => {
    await setupRehearsalApp(page, {
      mediaRecorderBlobSizes: [5],
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

    await expect(page.getByTestId('line-1')).not.toContainText('100%');
    await expect(page.getByTestId('button-record')).toBeVisible();

    await page.getByTestId('button-record').click();
    await expect(page.getByTestId('button-stop-recording')).toBeVisible();
    await page.getByTestId('button-stop-recording').click({ force: true });

    await expect(page.getByTestId('line-1')).toContainText('100%');
    await expect(page.getByTestId('line-1')).toContainText('My cue line.');
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
    await expect(page.getByText('Device Ready')).toBeHidden();
    await page.getByTestId('button-start-rehearsal').click();
    await expect(page.getByTestId('button-toggle-setup')).toBeHidden();
    await expect(page.getByTestId('button-end-session')).toBeVisible();
    await expect(page.getByTestId('car-mode-stage')).toBeVisible();
    await expect(page.getByTestId('car-mode-stage')).toContainText('Listening');
    await expect(page.getByTestId('car-mode-stage')).not.toContainText('First solo cue.');
    await expect(page.getByText('Use your car controls')).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                navigator as Navigator & {
                  mediaSession?: {
                    playbackState?: string;
                  };
                }
              ).mediaSession?.playbackState ?? null,
          ),
      )
      .toBe('playing');
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
    await expect(page.getByTestId('button-record')).toHaveCount(0);
    await expect(page.getByTestId('button-stop-recording')).toHaveCount(0);

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.nexttrack?.();
    });

    await expect(page.getByTestId('car-mode-stage')).toContainText('Recording');
    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.stop?.();
    });
    await expect(page.getByTestId('car-mode-stage')).toContainText('Ready');

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.nexttrack?.();
    });

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                navigator as Navigator & {
                  mediaSession?: {
                    metadata?: {
                      album?: string;
                    } | null;
                  };
                }
              ).mediaSession?.metadata?.album ?? null,
          ),
      )
      .toBe('Line 2: BOB');
    await expect(page.getByTestId('car-mode-stage')).toContainText('Listening');

    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.previoustrack?.();
    });

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                navigator as Navigator & {
                  mediaSession?: {
                    metadata?: {
                      album?: string;
                    } | null;
                  };
                }
              ).mediaSession?.metadata?.album ?? null,
          ),
      )
      .toBe('Line 1: BOB');
    await expect(page.getByTestId('car-mode-stage')).toContainText('Listening');
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
    await expect(page.getByText('Use your car controls')).toBeVisible();
    await page.evaluate(() => {
      (
        window as Window & {
          __e2eMediaSessionHandlers?: Record<string, (() => void) | null>;
        }
      ).__e2eMediaSessionHandlers?.nexttrack?.();
    });

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

  test('keeps the audio lab wizard on a fixed mobile viewport without page scroll', async ({ page }) => {
    await setupRehearsalApp(page, {
      script: PARTNER_LEAD_SCRIPT,
      selectedCharacter: 'BOB',
    });

    await page.getByTestId('button-open-audio-lab').click();
    await expect(page.getByTestId('audio-lab-page')).toBeVisible();

    const viewportHeights = await page.evaluate(() => ({
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));

    expect(viewportHeights.bodyScrollHeight).toBeLessThanOrEqual(viewportHeights.innerHeight + 1);
    expect(viewportHeights.documentScrollHeight).toBeLessThanOrEqual(viewportHeights.innerHeight + 1);
  });
});
