import type { AdminSettings } from "@/types/settings";

export type S3Runtime = S3Location & {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

export type SignInput = {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  service?: string;
  headers?: Record<string, string>;
  bodySha256?: string;
  now?: Date;
};

export type S3Location = {
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
  addressing: S3AddressingStyle;
  domainBucket: boolean;
  publicBaseUrl: string;
};

export type S3Settings = AdminSettings["s3"];

export type S3AddressingSetting = S3Settings["addressing"];

export type S3AddressingStyle = Exclude<S3AddressingSetting, "auto">;
