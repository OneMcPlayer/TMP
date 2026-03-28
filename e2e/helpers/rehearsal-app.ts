import { expect, type Page } from '@playwright/test';

export interface MockScriptLine {
  speaker: string;
  line: string;
}

export interface MockScript {
  title: string;
  author?: string;
  language?: string;
  lines: MockScriptLine[];
}

type MicrophoneMode = 'normal' | 'pending' | 'controlled';

export interface RehearsalAppOptions {
  apiKey?: string;
  autoSpeakCorrections?: boolean;
  carMode?: boolean;
  latestVersion?: string;
  mediaRecorderAutoStopDelayMs?: number;
  microphoneMode?: MicrophoneMode;
  rejectAudioPlayCallNumber?: number;
  script?: MockScript;
  selectedCharacter?: string | null;
  transcriptionText?: string;
  wakeLockSupported?: boolean;
}

export const PARTNER_LEAD_SCRIPT: MockScript = {
  title: 'E2E Rehearsal',
  author: 'Playwright',
  language: 'en',
  lines: [
    { speaker: 'ALICE', line: 'Partner opening.' },
    { speaker: 'BOB', line: 'My cue line.' },
    { speaker: 'ALICE', line: 'Partner closing.' },
  ],
};

export const CAR_MODE_SCRIPT: MockScript = {
  title: 'Car Mode E2E',
  author: 'Playwright',
  language: 'en',
  lines: [
    { speaker: 'BOB', line: 'First solo cue.' },
    { speaker: 'BOB', line: 'Second solo cue.' },
    { speaker: 'ALICE', line: 'Wrap up.' },
  ],
};

export async function setupRehearsalApp(
  page: Page,
  options: RehearsalAppOptions = {},
): Promise<void> {
  const {
    apiKey = 'sk-playwright-test-key',
    autoSpeakCorrections = true,
    carMode = false,
    latestVersion = '1.0.12',
    mediaRecorderAutoStopDelayMs = -1,
    microphoneMode = 'normal',
    rejectAudioPlayCallNumber = -1,
    script = PARTNER_LEAD_SCRIPT,
    selectedCharacter = null,
    transcriptionText = 'My cue line.',
    wakeLockSupported = true,
  } = options;

  await page.addInitScript(
    ({
      apiKey: initApiKey,
      autoSpeakCorrections: initAutoSpeakCorrections,
      carMode: initCarMode,
      mediaRecorderAutoStopDelayMs: initMediaRecorderAutoStopDelayMs,
      microphoneMode: initMicrophoneMode,
      rejectAudioPlayCallNumber: initRejectAudioPlayCallNumber,
      selectedCharacter: initSelectedCharacter,
      wakeLockSupported: initWakeLockSupported,
    }) => {
      localStorage.setItem('openai_api_key', initApiKey);
      localStorage.setItem(
        'rehearsal_preferences',
        JSON.stringify({
          selectedCharacter: initSelectedCharacter,
          carMode: initCarMode,
          autoSpeakCorrections: initAutoSpeakCorrections,
        }),
      );

      const mediaSessionHandlers: Record<string, ((details?: unknown) => void) | null> = {};
      Object.defineProperty(window, '__e2eMediaSessionHandlers', {
        configurable: true,
        value: mediaSessionHandlers,
      });
      Object.defineProperty(window, '__e2eWakeLockRequests', {
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(window, '__e2eGetUserMediaCalls', {
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(window, '__e2eAudioSessionTypes', {
        configurable: true,
        writable: true,
        value: [] as string[],
      });
      Object.defineProperty(window, '__e2eAudioPlayCalls', {
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(window, '__e2eRejectNextAudioPlay', {
        configurable: true,
        writable: true,
        value: false,
      });

      const mediaSession = {
        metadata: null,
        playbackState: 'none',
        setActionHandler(action: string, handler: ((details?: unknown) => void) | null) {
          mediaSessionHandlers[action] = handler;
        },
      };
      Object.defineProperty(navigator, 'mediaSession', {
        configurable: true,
        value: mediaSession,
      });

      class FakeAudioSession extends EventTarget {
        state = 'active';
        privateType = 'auto';

        get type() {
          return this.privateType;
        }

        set type(nextType: string) {
          this.privateType = nextType;
          window.__e2eAudioSessionTypes.push(nextType);
        }
      }

      Object.defineProperty(navigator, 'audioSession', {
        configurable: true,
        value: new FakeAudioSession(),
      });

      class FakeMediaMetadata {
        constructor(init: Record<string, unknown>) {
          Object.assign(this, init);
        }
      }

      Object.defineProperty(window, 'MediaMetadata', {
        configurable: true,
        writable: true,
        value: FakeMediaMetadata,
      });

      class FakeWakeLockSentinel extends EventTarget {
        released = false;

        async release(): Promise<void> {
          if (this.released) {
            return;
          }

          this.released = true;
          this.dispatchEvent(new Event('release'));
        }
      }

      if (initWakeLockSupported) {
        Object.defineProperty(navigator, 'wakeLock', {
          configurable: true,
          value: {
            async request() {
              window.__e2eWakeLockRequests += 1;
              return new FakeWakeLockSentinel();
            },
          },
        });
      }

      Object.defineProperty(HTMLMediaElement.prototype, 'play', {
        configurable: true,
        value: function play() {
          window.__e2eAudioPlayCalls += 1;

          if (window.__e2eRejectNextAudioPlay) {
            window.__e2eRejectNextAudioPlay = false;
            return Promise.reject(new DOMException('Playback blocked', 'NotAllowedError'));
          }

          if (window.__e2eAudioPlayCalls === initRejectAudioPlayCallNumber) {
            return Promise.reject(new DOMException('Playback blocked', 'NotAllowedError'));
          }

          setTimeout(() => {
            this.dispatchEvent(new Event('ended'));
          }, 0);
          return Promise.resolve();
        },
      });

      Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
        configurable: true,
        value: function pause() {
          return undefined;
        },
      });

      const fakeTracks = [{ stop() {} }];
      const mediaDevices = navigator.mediaDevices ?? {};
      let resolveControlledGetUserMedia:
        | (() => void)
        | null = null;
      Object.defineProperty(window, '__e2eResolveControlledGetUserMedia', {
        configurable: true,
        value: () => {
          resolveControlledGetUserMedia?.();
          resolveControlledGetUserMedia = null;
        },
      });
      Object.assign(mediaDevices, {
        getUserMedia() {
          window.__e2eGetUserMediaCalls += 1;

          if (initMicrophoneMode === 'pending') {
            return new Promise(() => undefined);
          }

          if (initMicrophoneMode === 'controlled') {
            return new Promise((resolve) => {
              resolveControlledGetUserMedia = () => {
                resolve({
                  getTracks() {
                    return fakeTracks;
                  },
                });
              };
            });
          }

          return Promise.resolve({
            getTracks() {
              return fakeTracks;
            },
          });
        },
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: mediaDevices,
      });

      class FakeMediaRecorder {
        static isTypeSupported() {
          return true;
        }

        stream: { getTracks: () => Array<{ stop: () => void }> };
        mimeType: string;
        state = 'inactive';
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: ((event: Event) => void) | null = null;

        constructor(
          stream: { getTracks: () => Array<{ stop: () => void }> },
          options: { mimeType?: string } = {},
        ) {
          this.stream = stream;
          this.mimeType = options.mimeType ?? 'audio/webm';
        }

        start() {
          this.state = 'recording';

          if (initMediaRecorderAutoStopDelayMs >= 0) {
            setTimeout(() => {
              if (this.state !== 'recording') {
                return;
              }

              this.state = 'inactive';
              const blob = new Blob(['playwright-audio'], { type: this.mimeType });
              this.ondataavailable?.({ data: blob });
              this.onstop?.(new Event('stop'));
            }, initMediaRecorderAutoStopDelayMs);
          }
        }

        stop() {
          this.state = 'inactive';
          const blob = new Blob(['playwright-audio'], { type: this.mimeType });

          setTimeout(() => {
            this.ondataavailable?.({ data: blob });
            this.onstop?.(new Event('stop'));
          }, 0);
        }
      }

      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        writable: true,
        value: FakeMediaRecorder,
      });

      class FakeAudioContext {
        createAnalyser() {
          return {
            fftSize: 2048,
            disconnect() {},
            getFloatTimeDomainData(data: Float32Array) {
              data.fill(0.25);
            },
          };
        }

        createMediaStreamSource() {
          return {
            connect() {},
            disconnect() {},
          };
        }

        close() {
          return Promise.resolve();
        }
      }

      Object.defineProperty(window, 'AudioContext', {
        configurable: true,
        writable: true,
        value: FakeAudioContext,
      });
      Object.defineProperty(window, 'webkitAudioContext', {
        configurable: true,
        writable: true,
        value: FakeAudioContext,
      });
    },
    {
      apiKey,
      autoSpeakCorrections,
      carMode,
      mediaRecorderAutoStopDelayMs,
      microphoneMode,
      rejectAudioPlayCallNumber,
      selectedCharacter,
      wakeLockSupported,
    },
  );

  await page.route('**/script.json', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(script),
    });
  });

  await page.route('**/version.json*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: latestVersion,
        releasedAt: '2026-03-24T00:00:00.000Z',
      }),
    });
  });

  await page.route('https://api.openai.com/v1/audio/speech', async (route) => {
    await route.fulfill({
      contentType: 'audio/mpeg',
      body: 'playwright-fake-audio',
    });
  });

  await page.route('https://api.openai.com/v1/audio/transcriptions', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ text: transcriptionText }),
    });
  });

  await page.goto('/');
}

export async function completeDeviceSetup(page: Page): Promise<void> {
  const prepareButton = page.getByTestId('button-prepare-device');
  await expect(prepareButton).toBeVisible();
  await prepareButton.click();
  await expect(page.getByText('Device check complete.')).toBeVisible();
}

export async function selectCharacter(page: Page, character: string): Promise<void> {
  await page.getByTestId('select-character').click();
  await page.getByRole('option', { name: character }).click();
}
