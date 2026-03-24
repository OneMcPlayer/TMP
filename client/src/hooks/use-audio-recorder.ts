import { useState, useRef, useCallback } from 'react';
import { calculateAudioLevel, isSilentAudioLevel } from '@/lib/silence-detection';

interface UseAudioRecorderReturn {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob>;
  error: string | null;
}

interface UseAudioRecorderOptions {
  carMode?: boolean;
  silenceTimeoutMs?: number;
  onSilenceTimeout?: () => void;
}

export function getPreferredAudioMimeType(
  mediaRecorder: Pick<typeof MediaRecorder, 'isTypeSupported'>,
): string | undefined {
  const supportedMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;
  return supportedMimeTypes.find((mimeType) => mediaRecorder.isTypeSupported(mimeType));
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
  const silenceRafRef = useRef<number | null>(null);
  const silenceTriggeredRef = useRef(false);

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

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      chunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: options.carMode ? 1 : undefined,
        } 
      });

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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(message);
      throw err;
    }
  }, [options.carMode, options.onSilenceTimeout, silenceTimeoutMs]);

  const stopRecording = useCallback(async (): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const mediaRecorder = mediaRecorderRef.current;
      
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        reject(new Error('No active recording'));
        return;
      }

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
        stopSilenceMonitor();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());

        setIsRecording(false);
        mediaRecorderRef.current = null;
        chunksRef.current = [];

        resolve(blob);
      };

      mediaRecorder.stop();
    });
  }, [stopSilenceMonitor]);

  return {
    isRecording,
    startRecording,
    stopRecording,
    error,
  };
}
