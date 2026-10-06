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

export type AddressingStyle = "path" | "virtual-hosted";

export type S3Location = {
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
  addressing: AddressingStyle;
  domainBucket: boolean;
  publicBaseUrl: string;
};
