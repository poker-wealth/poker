import { randomBytes } from 'node:crypto';

/**
 * Cloud randomness source (spec §6.1 — the third leg of the triple-mix).
 *
 * Production: AWS KMS `GenerateRandom` (FIPS 140-2 hardware RNG).
 * Local dev / tests: crypto.randomBytes (still a CSPRNG, just not KMS-backed).
 *
 * Injectable so production wires the AWS SDK and tests stay offline. The
 * default implementation is the local CSPRNG.
 */

export interface CloudRandomSource {
  generate(byteLength: number): Promise<Uint8Array>;
  /** Human-readable id recorded on the receipt (e.g. 'aws-kms' or 'local-csprng'). */
  readonly id: string;
}

export const localCsprng: CloudRandomSource = {
  id: 'local-csprng',
  async generate(byteLength: number): Promise<Uint8Array> {
    return new Uint8Array(randomBytes(byteLength));
  },
};

/**
 * Build an AWS-KMS-backed source. Deferred wiring — the actual @aws-sdk/client-kms
 * call lands when KMS_KEY_ID is configured in production. For now this throws
 * if invoked without a real implementation, so we never silently fall back to
 * local CSPRNG in production.
 */
export function awsKmsSource(_keyId: string): CloudRandomSource {
  return {
    id: 'aws-kms',
    async generate(): Promise<Uint8Array> {
      throw new Error(
        'awsKmsSource: AWS KMS GenerateRandom not yet wired — set up @aws-sdk/client-kms in production',
      );
    },
  };
}
