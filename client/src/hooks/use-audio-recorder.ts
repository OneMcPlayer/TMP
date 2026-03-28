import { useState, useRef, useCallback, useEffect } from 'react';
import { calculateAudioLevel, isSilentAudioLevel } from '@/lib/silence-detection';

interface UseAudioRecorderReturn {
  isRecording: boolean;
  prepareRecordingSession: () => Promise<void>;
  releasePreparedRecordingSession: () => void;
  startRecording: () => Promise<boolean>;
  stopRecording: () => Promise<Blob>;
  error: string | null;
}

interface UseAudioRecorderOptions {
  carMode?: boolean;
  silenceTimeoutMs?: number;
  onSilenceTimeout?: () => void;
}

export const NO_SPEECH_DETECTED_ERROR = 'No speech detected before auto-stop';
export const NO_AUDIO_CAPTURED_ERROR = 'No audio captured';
const STOP_RECORDING_FALLBACK_TIMEOUT_MS = 250;

interface CompletedRecording {
  blob: Blob;
  captureError: string | null;
}

interface PendingStopRequest {
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof globalThis.setTimeout> | null;
}

export function hasLiveAudioTracks(
  stream: Pick<MediaStream, 'getTracks'> | null | undefined,
): boolean {
  if (!stream) {
    return false;
  }

  return stream.getTracks().some((track) => track.readyState !== 'ended');
}

export function buildRecordingAudioConstraints(carMode: boolean = false): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (carMode) {
    constraints.channelCount = 1;
  }

  return constraints;
}

export async function preparePersistentMicrophoneAccess(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined,
  carMode: boolean = false,
): Promise<MediaStream> {
  if (!mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support microphone access');
  }

  return mediaDevices.getUserMedia({
    audio: buildRecordingAudioConstraints(carMode),
  });
}

export async function prepareMicrophoneAccess(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined,
  carMode: boolean = false,
): Promise<void> {
  const stream = await preparePersistentMicrophoneAccess(mediaDevices, carMode);

  stream.getTracks().forEach((track) => track.stop());
}

export function getPreferredAudioMimeType(
  mediaRecorder: Pick<typeof MediaRecorder, 'isTypeSupported'>,
): string | undefined {
  const supportedMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;
  return supportedMimeTypes.find((mimeType) => mediaRecorder.isTypeSupported(mimeType));
}

export function getRecordingCaptureError({
  blobSize,
  detectedSpeech,
  silenceTriggered,
}: {
  blobSize: number;
  detectedSpeech: boolean;
  silenceTriggered: boolean;
}): string | null {
  if (blobSize > 0) {
    return null;
  }

  if (silenceTriggered && !detectedSpeech) {
    return NO_SPEECH_DETECTED_ERROR;
  }

  return NO_AUDIO_CAPTURED_ERROR;
}

export function useAudioRecorder(
  options: UseAudioRecorderOptions = {},
): UseAudioRecorderReturn {
  const silenceTimeoutMs = options.silenceTimeoutMs ?? 5000;
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const preparedStreamRef = useRef<MediaStream | null>(null);
  const activeStreamShouldPersistRef = useRef(false);
  const silenceRafRef = useRef<number | null>(null);
  const silenceTriggeredRef = useRef(false);
  const detectedSpeechRef = useRef(false);
  const isStartingRef = useRef(false);
  const completedRecordingRef = useRef<CompletedRecording | null>(null);
  const pendingStopRequestRef = useRef<PendingStopRequest | null>(null);
  const stopRequestedRef = useRef(false);

  const stopStreamTracks = useCallback((stream: Pick<MediaStream, 'getTracks'> | null | undefined) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const stopSilenceMonitor = useCallback(() => {
    if (silenceRafRef.current !== null) {
      cancelAnimationFrame(silenceRafRef.current);
      silenceRafRef.current = null;
    }

    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, []);

  const clearPendingStopRequest = useCallback(() => {
    const pendingStopRequest = pendingStopRequestRef.current;
    if (pendingStopRequest && pendingStopRequest.timeoutId !== null) {
      globalThis.clearTimeout(pendingStopRequest.timeoutId);
    }

    pendingStopRequestRef.current = null;
  }, []);

  const consumeCompletedRecording = useCallback((): CompletedRecording | null => {
    const completedRecording = completedRecordingRef.current;
    completedRecordingRef.current = null;
    return completedRecording;
  }, []);

  const resolveStopRequest = useCallback((completedRecording: CompletedRecording): boolean => {
    const pendingStopRequest = pendingStopRequestRef.current;
    if (!pendingStopRequest) {
      return false;
    }

    clearPendingStopRequest();

    if (completedRecording.captureError) {
      pendingStopRequest.reject(new Error(completedRecording.captureError));
      return true;
    }

    pendingStopRequest.resolve(completedRecording.blob);
    return true;
  }, [clearPendingStopRequest]);

  const buildCompletedRecording = useCallback(
    (mediaRecorder: Pick<MediaRecorder, 'mimeType'>): CompletedRecording => {
      const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
      const captureError = getRecordingCaptureError({
        blobSize: blob.size,
        detectedSpeech: detectedSpeechRef.current,
        silenceTriggered: silenceTriggeredRef.current,
      });

      return {
        blob,
        captureError,
      };
    },
    [],
  );

  const releasePreparedRecordingSession = useCallback(() => {
    const preparedStream = preparedStreamRef.current;
    if (preparedStream && streamRef.current === preparedStream && isRecording) {
      return;
    }

    preparedStreamRef.current = null;

    if (streamRef.current === preparedStream && !isRecording) {
      streamRef.current = null;
    }

    stopStreamTracks(preparedStream);
  }, [isRecording, stopStreamTracks]);

  const cleanupRecordingResources = useCallback(() => {
    stopSilenceMonitor();
    const activeStream = streamRef.current;
    const shouldPersistActiveStream =
      activeStreamShouldPersistRef.current &&
      activeStream !== null &&
      activeStream === preparedStreamRef.current &&
      hasLiveAudioTracks(activeStream);

    if (!shouldPersistActiveStream) {
      stopStreamTracks(activeStream);

      if (activeStream !== null && activeStream === preparedStreamRef.current) {
        preparedStreamRef.current = null;
      }
    }

    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    activeStreamShouldPersistRef.current = false;
    stopRequestedRef.current = false;
    setIsRecording(false);
  }, [stopSilenceMonitor, stopStreamTracks]);

  const prepareRecordingSession = useCallback(async (): Promise<void> => {
    if (!options.carMode) {
      await prepareMicrophoneAccess(navigator.mediaDevices, options.carMode);
      return;
    }

    if (hasLiveAudioTracks(preparedStreamRef.current)) {
      return;
    }

    releasePreparedRecordingSession();
    preparedStreamRef.current = await preparePersistentMicrophoneAccess(
      navigator.mediaDevices,
      options.carMode,
    );
  }, [options.carMode, releasePreparedRecordingSession]);

  const startRecording = useCallback(async (): Promise<boolean> => {
    if (isStartingRef.current) {
      return false;
    }

    const currentRecorder = mediaRecorderRef.current;
    if (currentRecorder && currentRecorder.state !== 'inactive') {
      return false;
    }

    isStartingRef.current = true;
    let stream: MediaStream | null = null;
    let shouldPersistActiveStream = false;

    try {
      setError(null);
      chunksRef.current = [];
      completedRecordingRef.current = null;
      clearPendingStopRequest();
      detectedSpeechRef.current = false;
      silenceTriggeredRef.current = false;
      stopRequestedRef.current = false;

      if (options.carMode) {
        if (hasLiveAudioTracks(preparedStreamRef.current)) {
          stream = preparedStreamRef.current;
          shouldPersistActiveStream = true;
        } else {
          stream = await preparePersistentMicrophoneAccess(
            navigator.mediaDevices,
            options.carMode,
          );
          preparedStreamRef.current = stream;
          shouldPersistActiveStream = true;
        }
      } else {
        stream = await preparePersistentMicrophoneAccess(
          navigator.mediaDevices,
          options.carMode,
        );
      }

      if (!stream) {
        throw new Error('Failed to access microphone');
      }

      streamRef.current = stream;
      activeStreamShouldPersistRef.current = shouldPersistActiveStream;

      const mimeType = getPreferredAudioMimeType(MediaRecorder);
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      silenceTriggeredRef.current = false;

      if (options.carMode) {
        const AudioContextCtor =
          window.AudioContext ||
          ((window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext);
        const audioContext = new AudioContextCtor();
        const analyser = audioContext.createAnalyser();
        const sourceNode = audioContext.createMediaStreamSource(stream);

        analyser.fftSize = 2048;
        sourceNode.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        sourceNodeRef.current = sourceNode;

        const pcmData = new Float32Array(analyser.fftSize);
        let lastNonSilentAt = performance.now();

        const monitorSilence = () => {
          const currentAnalyser = analyserRef.current;
          if (!currentAnalyser || silenceTriggeredRef.current) {
            return;
          }

          currentAnalyser.getFloatTimeDomainData(pcmData);
          const audioLevel = calculateAudioLevel(pcmData);

          if (!isSilentAudioLevel(audioLevel)) {
            detectedSpeechRef.current = true;
            lastNonSilentAt = performance.now();
          } else if (performance.now() - lastNonSilentAt >= silenceTimeoutMs) {
            silenceTriggeredRef.current = true;
            options.onSilenceTimeout?.();
            return;
          }

          silenceRafRef.current = requestAnimationFrame(monitorSilence);
        };

        silenceRafRef.current = requestAnimationFrame(monitorSilence);
      }

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const completedRecording = buildCompletedRecording(mediaRecorder);
        const shouldResolveStopRequest =
          stopRequestedRef.current || pendingStopRequestRef.current !== null;

        if (shouldResolveStopRequest) {
          cleanupRecordingResources();
          resolveStopRequest(completedRecording);
          return;
        }

        completedRecordingRef.current = completedRecording;
      };

      mediaRecorder.start(100);
      setIsRecording(true);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(message);
      stopSilenceMonitor();
      if (!shouldPersistActiveStream) {
        stopStreamTracks(stream);
      }
      streamRef.current = null;
      activeStreamShouldPersistRef.current = false;
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      completedRecordingRef.current = null;
      clearPendingStopRequest();
      stopRequestedRef.current = false;
      throw err;
    } finally {
      isStartingRef.current = false;
    }
  }, [
    buildCompletedRecording,
    cleanupRecordingResources,
    clearPendingStopRequest,
    options.carMode,
    options.onSilenceTimeout,
    resolveStopRequest,
    silenceTimeoutMs,
    stopSilenceMonitor,
    stopStreamTracks,
  ]);

  const stopRecording = useCallback(async (): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const completedRecording = consumeCompletedRecording();
      if (completedRecording) {
        cleanupRecordingResources();

        if (completedRecording.captureError) {
          reject(new Error(completedRecording.captureError));
          return;
        }

        resolve(completedRecording.blob);
        return;
      }

      const mediaRecorder = mediaRecorderRef.current;

      if (!mediaRecorder) {
        reject(new Error('No active recording'));
        return;
      }

      const timeoutId = globalThis.setTimeout(() => {
        const pendingStopRequest = pendingStopRequestRef.current;
        if (!pendingStopRequest || pendingStopRequest.resolve !== resolve) {
          return;
        }

        clearPendingStopRequest();
        cleanupRecordingResources();
        reject(new Error('No active recording'));
      }, STOP_RECORDING_FALLBACK_TIMEOUT_MS);

      pendingStopRequestRef.current = {
        resolve,
        reject,
        timeoutId,
      };

      if (mediaRecorder.state === 'inactive') {
        return;
      }

      stopRequestedRef.current = true;
      mediaRecorder.stop();
    });
  }, [cleanupRecordingResources, clearPendingStopRequest, consumeCompletedRecording]);

  useEffect(() => {
    if (!options.carMode) {
      releasePreparedRecordingSession();
    }
  }, [options.carMode, releasePreparedRecordingSession]);

  useEffect(() => {
    return () => {
      clearPendingStopRequest();
      releasePreparedRecordingSession();
    };
  }, [clearPendingStopRequest, releasePreparedRecordingSession]);

  return {
    isRecording,
    prepareRecordingSession,
    releasePreparedRecordingSession,
    startRecording,
    stopRecording,
    error,
  };
}
