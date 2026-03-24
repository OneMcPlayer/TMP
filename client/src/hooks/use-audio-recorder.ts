import { useState, useRef, useCallback } from 'react';
import { calculateAudioLevel, isSilentAudioLevel } from '@/lib/silence-detection';

interface UseAudioRecorderReturn {
  isRecording: boolean;
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
  const silenceRafRef = useRef<number | null>(null);
  const silenceTriggeredRef = useRef(false);
  const detectedSpeechRef = useRef(false);
  const isStartingRef = useRef(false);

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

  const cleanupRecordingResources = useCallback(() => {
    stopSilenceMonitor();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
  }, [stopSilenceMonitor]);

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

    try {
      setError(null);
      chunksRef.current = [];
      detectedSpeechRef.current = false;
      silenceTriggeredRef.current = false;

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: options.carMode ? 1 : undefined,
        },
      });
      streamRef.current = stream;

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

      mediaRecorder.start(100);
      setIsRecording(true);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(message);
      stopSilenceMonitor();
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      throw err;
    } finally {
      isStartingRef.current = false;
    }
  }, [options.carMode, options.onSilenceTimeout, silenceTimeoutMs, stopSilenceMonitor]);

  const stopRecording = useCallback(async (): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const mediaRecorder = mediaRecorderRef.current;
      
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        reject(new Error('No active recording'));
        return;
      }

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
        const captureError = getRecordingCaptureError({
          blobSize: blob.size,
          detectedSpeech: detectedSpeechRef.current,
          silenceTriggered: silenceTriggeredRef.current,
        });
        cleanupRecordingResources();

        if (captureError) {
          reject(new Error(captureError));
          return;
        }

        resolve(blob);
      };

      mediaRecorder.stop();
    });
  }, [cleanupRecordingResources]);

  return {
    isRecording,
    startRecording,
    stopRecording,
    error,
  };
}
