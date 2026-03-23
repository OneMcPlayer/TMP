const SILENCE_LEVEL_THRESHOLD = 0.01;

export function calculateAudioLevel(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let totalSquare = 0;
  for (let index = 0; index < samples.length; index += 1) {
    totalSquare += samples[index] * samples[index];
  }

  return Math.sqrt(totalSquare / samples.length);
}

export function isSilentAudioLevel(level: number): boolean {
  return level < SILENCE_LEVEL_THRESHOLD;
}
