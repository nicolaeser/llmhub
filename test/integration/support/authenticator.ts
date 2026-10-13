import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

export function softwareAuthenticator(origin: string) {
  const rpId = new URL(origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const coseKey = Buffer.from(
    isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    ),
  );
  const rawId = randomBytes(16);
  const credentialId = rawId.toString("base64url");

  const flags = (userVerified: boolean) => USER_PRESENT | (userVerified ? USER_VERIFIED : 0);

  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    credentialId,
    coseKey,
    assertion(challenge: string, options: { counter: number; userVerified?: boolean }) {
      const authenticatorData = Buffer.concat([
        sha256(rpId),
        Buffer.from([flags(options.userVerified ?? true)]),
        uint32(options.counter),
      ]);
      const clientDataJSON = clientData("webauthn.get", challenge);
      const signer = createSign("SHA256");
      signer.update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: clientDataJSON.toString("base64url"),
          authenticatorData: authenticatorData.toString("base64url"),
          signature: signer.sign(privateKey).toString("base64url"),
        },
        clientExtensionResults: {},
      };
    },
    attestation(challenge: string, options: { userVerified?: boolean } = {}) {
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([flags(options.userVerified ?? true) | ATTESTED_CREDENTIAL]),
        uint32(0),
        Buffer.alloc(16),
        uint16(rawId.length),
        rawId,
        coseKey,
      ]);
      const attestationObject = Buffer.from(
        isoCBOR.encode(
          new Map<string, string | Map<string, never> | Uint8Array>([
            ["fmt", "none"],
            ["attStmt", new Map<string, never>()],
            ["authData", authData],
          ]),
        ),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: clientData("webauthn.create", challenge).toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
        },
        clientExtensionResults: {},
      };
    },
  };
}
