export const MIN_VALID_RECORDING_BLOB_BYTES = 256;

export function isSuspiciouslySmallRecordingBlob(
  blobSize: number,
  minimumBytes: number = MIN_VALID_RECORDING_BLOB_BYTES,
): boolean {
  if (blobSize <= 0) {
    return false;
  }

  return blobSize < minimumBytes;
}
